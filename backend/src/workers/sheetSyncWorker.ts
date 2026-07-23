/**
 * SheetSyncWorker — polls the Registrations tab and drives the Phase-1
 * state machine from admin COMMANDS (see docs/ARCHITECTURE.md, "Google
 * Sheets as the Admin Interface").
 *
 * Command/state separation: the admin's command channel is the `Action`
 * column (VERIFY_PAYMENT | APPROVE) plus `EmailStatus=SEND`. `Status` is
 * write-back only — it mirrors the domain state owned by the service layer
 * and is NEVER a trigger. (An earlier iteration triggered on `Status`
 * itself; under DATA_BACKEND=sheets that pre-sets the exact state the
 * service is about to validate against, so every transition 409s against
 * itself. See workers/types.ts and ARCHITECTURE.md for the full rationale.)
 *
 * Consume-then-act idempotency (uniform across all three commands):
 *  1. SYNCHRONOUSLY (before any `await`) consume the command cell —
 *     `Action` is cleared (for APPROVE, `MintStatus=MINTING` is also set as
 *     the in-progress marker); `EmailStatus=SEND` is written back to
 *     `PENDING`, which is simultaneously the consumed command AND the true
 *     domain state the service's dispatch guard expects.
 *  2. `await save()` — the consumption is PERSISTED before the action
 *     fires. A later poll (or a poll racing a slow tx) fetches fresh row
 *     objects, sees no pending command, and cannot double-fire. This is the
 *     persistence point the overlap guard depends on — not in-memory row
 *     mutation. The true backstop remains the on-chain `mintedFor` guard.
 *  3. Call the action; write results (or the Error cell) back.
 *
 * Crash semantics: dying between step 2 and 3 loses the command (admin
 * re-enters it) — deliberately chosen over the replay risk of the reverse
 * order. A row stranded mid-mint (MintStatus=MINTING, no TxHash, no pending
 * Action) is detected on a later poll and marked FAILED + "interrupted" so
 * the admin can re-trigger; startup reconciliation heals it instead if the
 * mint actually landed on-chain.
 *
 * Retry contract: a failed mint writes Status back to APPROVED (the true
 * domain state) + MintStatus=FAILED. The admin re-enters Action=APPROVE;
 * the WorkflowActions adapter (wired by the controller) maps "APPROVE on an
 * already-APPROVED, failed-mint row" to a mint retry rather than a 409.
 *
 * Per-row errors are caught, written to the row's Error cell, logged, and
 * never propagate out of a poll cycle — one bad row must not kill the loop.
 * Uses a `setTimeout` chain rather than `setInterval`: a poll only schedules
 * the next one after it fully finishes, so a slow cycle never overlaps
 * itself.
 */

import {
  EMAIL_STATUS,
  MINT_STATUS_VALUES,
  PARTICIPANT_STATUS,
  REGISTRATION_ACTIONS,
  REGISTRATION_COLUMNS,
  readRegistrationRow,
  type RegistrationRowView,
  type RegistrationsSheetAccessor,
  type SheetRowHandle,
  type WorkflowActions,
} from "./types";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

export interface SheetSyncWorkerOptions {
  accessor: RegistrationsSheetAccessor;
  actions: WorkflowActions;
  pollIntervalMs: number;
  logger?: Logger;
}

export class SheetSyncWorker {
  private readonly accessor: RegistrationsSheetAccessor;
  private readonly actions: WorkflowActions;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: SheetSyncWorkerOptions) {
    this.accessor = options.accessor;
    this.actions = options.actions;
    this.pollIntervalMs = options.pollIntervalMs;
    this.logger = options.logger ?? noopLogger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.pollOnce()
        .catch((err) => {
          this.logger.error("sheetSyncWorker: poll cycle failed", { error: describeError(err) });
        })
        .finally(() => this.scheduleNext(this.pollIntervalMs));
    }, delayMs);
  }

  /**
   * Runs exactly one poll cycle: fetch rows, process each independently.
   * Public so tests can await a deterministic cycle instead of racing the
   * internal setTimeout chain.
   */
  async pollOnce(): Promise<void> {
    const rows = await this.accessor.fetchRegistrationRows();
    for (const row of rows) {
      try {
        await this.processRow(row);
      } catch (err) {
        this.logger.error("sheetSyncWorker: row processing failed", {
          row: row.rowNumber,
          error: describeError(err),
        });
        await this.safeWriteError(row, err);
      }
    }
  }

  private async processRow(row: SheetRowHandle): Promise<void> {
    const view = readRegistrationRow(row);
    if (!view.id) return; // blank/template row — nothing to do

    // Stranded-mint recovery: MINTING persisted, but the mint outcome never
    // came back (crash between the marker save and the write-back) and no
    // command is pending. Mark it honestly FAILED so the admin can
    // re-trigger. If the mint actually landed on-chain, startup
    // reconciliation heals the domain record instead — this cell write never
    // fakes or destroys a mint fact.
    const mintStatus = row.get(REGISTRATION_COLUMNS.MINT_STATUS) ?? "";
    const txHash = row.get(REGISTRATION_COLUMNS.TX_HASH) ?? "";
    if (mintStatus === MINT_STATUS_VALUES.MINTING && !txHash && !view.action) {
      row.set(REGISTRATION_COLUMNS.MINT_STATUS, MINT_STATUS_VALUES.FAILED);
      row.set(
        REGISTRATION_COLUMNS.ERROR,
        "interrupted — mint was in progress when the worker stopped; re-enter Action=APPROVE to retry",
      );
      await row.save();
      return;
    }

    switch (view.action) {
      case REGISTRATION_ACTIONS.APPROVE:
        await this.handleApprove(row, view);
        return;
      case REGISTRATION_ACTIONS.VERIFY_PAYMENT:
        await this.handleRecordPayment(row, view);
        break;
      case REGISTRATION_ACTIONS.NONE:
        break;
      default: {
        // Unknown command — surface it, consume it, never loop on it.
        row.set(REGISTRATION_COLUMNS.ACTION, REGISTRATION_ACTIONS.NONE);
        row.set(REGISTRATION_COLUMNS.ERROR, `unknown Action "${view.action}" — expected VERIFY_PAYMENT or APPROVE`);
        await row.save();
        return;
      }
    }

    if (view.emailStatus === EMAIL_STATUS.SEND) {
      await this.handleDispatchEmail(row, view);
    }
  }

  // -------------------------------------------------------------------
  // Action=APPROVE -> approve + auto-mint
  // -------------------------------------------------------------------
  private async handleApprove(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    // Consume the command BEFORE any await: clear Action, mark MINTING.
    // Persisted via save() so any fresh fetch sees no pending command.
    row.set(REGISTRATION_COLUMNS.ACTION, REGISTRATION_ACTIONS.NONE);
    row.set(REGISTRATION_COLUMNS.MINT_STATUS, MINT_STATUS_VALUES.MINTING);
    await row.save();

    let outcome;
    try {
      outcome = await this.actions.approveAndMint(view.id);
    } catch (err) {
      this.logger.error("sheetSyncWorker: approveAndMint threw", {
        registrationId: view.id,
        error: describeError(err),
      });
      await this.writeMintFailure(row, describeError(err));
      return;
    }

    if (outcome.error || outcome.mintStatus === "FAILED") {
      await this.writeMintFailure(row, outcome.error ?? "mint failed");
      return;
    }

    row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.CERT_MINTED);
    row.set(REGISTRATION_COLUMNS.MINT_STATUS, MINT_STATUS_VALUES.MINTED);
    row.set(REGISTRATION_COLUMNS.CERT_ID, outcome.certId ?? "");
    row.set(REGISTRATION_COLUMNS.TX_HASH, outcome.txHash ?? "");
    row.set(REGISTRATION_COLUMNS.TOKEN_ID, outcome.tokenId ?? "");
    row.set(REGISTRATION_COLUMNS.VERIFICATION_LINK, outcome.verificationUrl ?? "");
    // CONSTRAINTS.md constraint #2: mint never sends email — dispatch is a
    // separate, explicitly triggered admin action (EmailStatus=SEND).
    row.set(REGISTRATION_COLUMNS.EMAIL_STATUS, EMAIL_STATUS.PENDING);
    row.set(REGISTRATION_COLUMNS.ERROR, "");
    await row.save();
  }

  private async writeMintFailure(row: SheetRowHandle, error: string): Promise<void> {
    // Status write-back reflects the true domain state after a failed mint:
    // the registration IS approved, only the mint failed (no fake success,
    // no fake rollback either).
    row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.APPROVED);
    row.set(REGISTRATION_COLUMNS.MINT_STATUS, MINT_STATUS_VALUES.FAILED);
    row.set(REGISTRATION_COLUMNS.ERROR, error);
    await row.save();
  }

  // -------------------------------------------------------------------
  // Action=VERIFY_PAYMENT -> recordPayment
  // -------------------------------------------------------------------
  private async handleRecordPayment(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    // Consume the command first (persisted) — same crash trade-off as
    // APPROVE: a crash right after this save loses the command (admin
    // re-enters it), which is strictly safer than replaying it.
    row.set(REGISTRATION_COLUMNS.ACTION, REGISTRATION_ACTIONS.NONE);
    await row.save();

    if (!view.paymentRef) {
      row.set(REGISTRATION_COLUMNS.ERROR, "Action=VERIFY_PAYMENT requires a PaymentRef — fill it and re-enter the Action");
      await row.save();
      return;
    }

    try {
      await this.actions.recordPayment(view.id, view.paymentRef, view.paymentVerifiedBy ?? "sheet-admin");
      row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.PAYMENT_VERIFIED);
      row.set(REGISTRATION_COLUMNS.ERROR, "");
      await row.save();
    } catch (err) {
      this.logger.error("sheetSyncWorker: recordPayment failed", {
        registrationId: view.id,
        error: describeError(err),
      });
      row.set(REGISTRATION_COLUMNS.ERROR, describeError(err));
      await row.save();
    }
  }

  // -------------------------------------------------------------------
  // EmailStatus=SEND -> dispatchEmail
  // -------------------------------------------------------------------
  private async handleDispatchEmail(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    // Consume SEND by writing the cell back to PENDING — which is both the
    // consumed command (no later poll re-fires) and the true domain state
    // the service's dispatch guard requires (emailStatus === "PENDING").
    // Under DATA_BACKEND=sheets this cell IS the domain field, so leaving it
    // on "SEND" during the call would make the service's own idempotency
    // check skip the dispatch.
    row.set(REGISTRATION_COLUMNS.EMAIL_STATUS, EMAIL_STATUS.PENDING);
    await row.save();

    try {
      await this.actions.dispatchEmail(view.id);
      row.set(REGISTRATION_COLUMNS.EMAIL_STATUS, EMAIL_STATUS.SENT);
      row.set(REGISTRATION_COLUMNS.ERROR, "");
      await row.save();
    } catch (err) {
      this.logger.error("sheetSyncWorker: dispatchEmail failed", {
        registrationId: view.id,
        error: describeError(err),
      });
      // EmailStatus stays PENDING — the admin re-enters SEND to retry.
      row.set(REGISTRATION_COLUMNS.ERROR, describeError(err));
      await row.save();
    }
  }

  private async safeWriteError(row: SheetRowHandle, err: unknown): Promise<void> {
    try {
      row.set(REGISTRATION_COLUMNS.ERROR, describeError(err));
      await row.save();
    } catch {
      // Writing the error cell itself failed (e.g. sheet unreachable) —
      // already logged above; nothing more we can do without risking the
      // loop, so swallow.
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
