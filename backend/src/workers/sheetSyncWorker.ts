/**
 * SheetSyncWorker — polls the Registrations tab and drives the Phase-1
 * state machine from admin edits (see docs/ARCHITECTURE.md, "Google Sheets
 * as the Admin Interface").
 *
 * Detected transitions:
 *   Status -> "PAYMENT_VERIFIED" (+ PaymentRef)  => actions.recordPayment
 *   Status -> "APPROVED"                         => actions.approveAndMint
 *   EmailStatus -> "SEND"                        => actions.dispatchEmail
 *
 * Idempotency (layered, matching docs/ARCHITECTURE.md):
 *  - APPROVED -> mint: the row's Status cell is flipped to the sheet-only
 *    "MINTING" marker SYNCHRONOUSLY, before any `await`, the moment the
 *    trigger is detected — and persisted (awaited `save()`) before the mint
 *    call is even made. Because the row object is live/shared, a second,
 *    overlapping `pollOnce()` (a slow tx spilling into the next poll tick,
 *    or two ticks racing) reads the SAME row and sees "MINTING", not
 *    "APPROVED", and skips it. This is a best-effort, in-process guard, not
 *    a distributed lock — the true backstop is the on-chain `mintedFor`
 *    guard the chain client checks before minting (see ARCHITECTURE.md).
 *    On failure the row is written back to APPROVED (retryable) with an
 *    Error cell — CONSTRAINTS.md: "No fake success ... retryable".
 *  - EmailStatus SEND -> SENT: the same pattern — once dispatched the cell
 *    no longer reads "SEND", so a later poll can't refire it.
 *  - PAYMENT_VERIFIED -> recordPayment: unlike the two cases above, the
 *    Status cell does NOT change again after a successful call (it
 *    correctly stays "PAYMENT_VERIFIED" — that's the real, persisted
 *    domain state, not a transient marker), so sheet state alone can't
 *    distinguish "not yet recorded" from "already recorded". We track
 *    already-processed registration IDs in an in-memory `Set` for the
 *    lifetime of the process to avoid redundant calls every poll. This is
 *    a process-lifetime cache only: a restart mid-flight can replay one
 *    recordPayment call for a row that was already processed just before
 *    the restart. That's a deliberately accepted, narrow gap — the
 *    service-layer transition guard (CONSTRAINTS.md: "State transitions only via
 *    service methods; illegal transitions -> 409") is the real backstop and
 *    turns the replay into a caught, harmless, one-time Error cell rather
 *    than a duplicate side effect.
 *
 * Per-row errors are caught, written to the row's Error cell, logged, and
 * never propagate out of a poll cycle — one bad row must not kill the loop.
 *
 * Uses a `setTimeout` chain rather than `setInterval`: a poll only schedules
 * the next one after it fully finishes, so a slow cycle can never overlap
 * with itself.
 */

import {
  EMAIL_STATUS,
  PARTICIPANT_STATUS,
  REGISTRATION_COLUMNS,
  SHEET_ONLY_STATUS,
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

  /** Process-lifetime memory of registration IDs whose PAYMENT_VERIFIED
   * transition has already been recorded — see class doc comment. */
  private readonly paymentRecorded = new Set<string>();

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

    if (view.status === PARTICIPANT_STATUS.APPROVED) {
      await this.handleApprove(row, view);
      return;
    }

    if (view.status === PARTICIPANT_STATUS.PAYMENT_VERIFIED) {
      await this.handleRecordPayment(row, view);
    }

    if (view.emailStatus === EMAIL_STATUS.SEND) {
      await this.handleDispatchEmail(row, view);
    }
  }

  // -------------------------------------------------------------------
  // APPROVED -> mint
  // -------------------------------------------------------------------
  private async handleApprove(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    // Mark in-progress BEFORE any await — closes the window for an
    // overlapping poll to re-detect APPROVED and double-fire the mint.
    row.set(REGISTRATION_COLUMNS.STATUS, SHEET_ONLY_STATUS.MINTING);
    await row.save();

    let outcome;
    try {
      outcome = await this.actions.approveAndMint(view.id);
    } catch (err) {
      this.logger.error("sheetSyncWorker: approveAndMint threw", { registrationId: view.id, error: describeError(err) });
      row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.APPROVED);
      row.set(REGISTRATION_COLUMNS.MINT_STATUS, "FAILED");
      row.set(REGISTRATION_COLUMNS.ERROR, describeError(err));
      await row.save();
      return;
    }

    if (outcome.error || outcome.mintStatus === "FAILED") {
      row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.APPROVED);
      row.set(REGISTRATION_COLUMNS.MINT_STATUS, "FAILED");
      row.set(REGISTRATION_COLUMNS.ERROR, outcome.error ?? "mint failed");
      await row.save();
      return;
    }

    row.set(REGISTRATION_COLUMNS.STATUS, PARTICIPANT_STATUS.CERT_MINTED);
    row.set(REGISTRATION_COLUMNS.MINT_STATUS, "MINTED");
    row.set(REGISTRATION_COLUMNS.TX_HASH, outcome.txHash ?? "");
    row.set(REGISTRATION_COLUMNS.TOKEN_ID, outcome.tokenId ?? "");
    row.set(REGISTRATION_COLUMNS.VERIFICATION_LINK, outcome.verificationUrl ?? "");
    // CONSTRAINTS.md constraint #2: mint never sends email — dispatch is a
    // separate, manually triggered admin action.
    row.set(REGISTRATION_COLUMNS.EMAIL_STATUS, EMAIL_STATUS.PENDING);
    row.set(REGISTRATION_COLUMNS.ERROR, "");
    await row.save();
  }

  // -------------------------------------------------------------------
  // PAYMENT_VERIFIED -> recordPayment
  // -------------------------------------------------------------------
  private async handleRecordPayment(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    if (this.paymentRecorded.has(view.id)) return; // see class doc comment

    if (!view.paymentRef) {
      row.set(REGISTRATION_COLUMNS.ERROR, "Status set to PAYMENT_VERIFIED without a PaymentRef");
      await row.save();
      return;
    }

    try {
      await this.actions.recordPayment(view.id, view.paymentRef, view.paymentVerifiedBy ?? "sheet-admin");
      this.paymentRecorded.add(view.id);
      row.set(REGISTRATION_COLUMNS.ERROR, "");
      await row.save();
    } catch (err) {
      this.logger.error("sheetSyncWorker: recordPayment failed", { registrationId: view.id, error: describeError(err) });
      row.set(REGISTRATION_COLUMNS.ERROR, describeError(err));
      await row.save();
    }
  }

  // -------------------------------------------------------------------
  // EmailStatus SEND -> dispatchEmail
  // -------------------------------------------------------------------
  private async handleDispatchEmail(row: SheetRowHandle, view: RegistrationRowView): Promise<void> {
    try {
      await this.actions.dispatchEmail(view.id);
      row.set(REGISTRATION_COLUMNS.EMAIL_STATUS, EMAIL_STATUS.SENT);
      row.set(REGISTRATION_COLUMNS.ERROR, "");
      await row.save();
    } catch (err) {
      this.logger.error("sheetSyncWorker: dispatchEmail failed", { registrationId: view.id, error: describeError(err) });
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
