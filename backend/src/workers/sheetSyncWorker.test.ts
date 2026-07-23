import { describe, expect, it, vi } from "vitest";
import { SheetSyncWorker } from "./sheetSyncWorker";
import {
  EMAIL_STATUS,
  PARTICIPANT_STATUS,
  REGISTRATION_COLUMNS,
  type MintOutcome,
  type RegistrationsSheetAccessor,
  type SheetRowHandle,
  type WorkflowActions,
} from "./types";

/** In-memory fake row: mutable, shared by reference across fetches — the
 * same shape a live Google Sheet row has (mutating it is immediately
 * visible to anyone else holding the same reference), which is exactly
 * what the overlapping-poll test below exercises. */
class FakeSheetRow implements SheetRowHandle {
  private cells: Record<string, string | number>;

  constructor(
    public readonly rowNumber: number,
    initial: Record<string, string | number>,
  ) {
    this.cells = { ...initial };
  }

  get(column: string): string | undefined {
    const value = this.cells[column];
    return value === undefined || value === "" ? undefined : String(value);
  }

  set(column: string, value: string | number): void {
    this.cells[column] = value;
  }

  async save(): Promise<void> {
    // Real persistence is async; a microtask tick is enough to exercise
    // ordering without slowing the test suite down.
  }

  /** Test-only helper to inspect raw cell state. */
  cell(column: string): string | number | undefined {
    return this.cells[column];
  }
}

class FakeAccessor implements RegistrationsSheetAccessor {
  constructor(private readonly rows: FakeSheetRow[]) {}

  async fetchRegistrationRows(): Promise<SheetRowHandle[]> {
    return this.rows;
  }
}

function makeRegistrationRow(overrides: Partial<Record<string, string>> = {}): FakeSheetRow {
  return new FakeSheetRow(2, {
    [REGISTRATION_COLUMNS.ID]: "reg-1",
    [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED,
    [REGISTRATION_COLUMNS.PAYMENT_REF]: "",
    [REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY]: "",
    [REGISTRATION_COLUMNS.EMAIL_STATUS]: EMAIL_STATUS.NOT_APPLICABLE,
    [REGISTRATION_COLUMNS.ERROR]: "",
    ...overrides,
  });
}

function fakeActions(overrides: Partial<WorkflowActions> = {}): WorkflowActions {
  return {
    recordPayment: vi.fn(async () => undefined),
    approveAndMint: vi.fn(async (): Promise<MintOutcome> => ({
      mintStatus: "MINTED",
      txHash: "0xabc",
      tokenId: 1,
      verificationUrl: "https://example.test/verify/reg-1",
    })),
    dispatchEmail: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("SheetSyncWorker", () => {
  it("mints exactly once for an APPROVED row, even across overlapping polls", async () => {
    const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.APPROVED });
    const accessor = new FakeAccessor([row]);

    let resolveMint!: (outcome: MintOutcome) => void;
    const approveAndMint = vi.fn(
      () =>
        new Promise<MintOutcome>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const actions = fakeActions({ approveAndMint });

    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    // Kick off two overlapping poll cycles before either finishes.
    const poll1 = worker.pollOnce();
    const poll2 = worker.pollOnce();

    // Give the microtask queue a chance to run the synchronous
    // "mark MINTING" step in both cycles before the mint resolves.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(row.cell(REGISTRATION_COLUMNS.STATUS)).toBe("MINTING");
    expect(approveAndMint).toHaveBeenCalledTimes(1);

    resolveMint({
      mintStatus: "MINTED",
      txHash: "0xabc",
      tokenId: 1,
      verificationUrl: "https://example.test/verify/reg-1",
    });

    await Promise.all([poll1, poll2]);

    expect(approveAndMint).toHaveBeenCalledTimes(1);
    expect(approveAndMint).toHaveBeenCalledWith("reg-1");
    expect(row.cell(REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.CERT_MINTED);
    expect(row.cell(REGISTRATION_COLUMNS.MINT_STATUS)).toBe("MINTED");
    expect(row.cell(REGISTRATION_COLUMNS.TX_HASH)).toBe("0xabc");
    expect(row.cell(REGISTRATION_COLUMNS.TOKEN_ID)).toBe(1);
    expect(row.cell(REGISTRATION_COLUMNS.EMAIL_STATUS)).toBe(EMAIL_STATUS.PENDING);
  });

  it("writes Error and leaves the row retryable (APPROVED) on mint failure", async () => {
    const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.APPROVED });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions({
      approveAndMint: vi.fn(async (): Promise<MintOutcome> => ({
        mintStatus: "FAILED",
        error: "chain unreachable",
      })),
    });
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await worker.pollOnce();

    expect(row.cell(REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.APPROVED);
    expect(row.cell(REGISTRATION_COLUMNS.MINT_STATUS)).toBe("FAILED");
    expect(row.cell(REGISTRATION_COLUMNS.ERROR)).toBe("chain unreachable");

    // Retryable: a subsequent poll (admin hasn't changed anything) attempts
    // again rather than being permanently stuck.
    await worker.pollOnce();
    expect(actions.approveAndMint).toHaveBeenCalledTimes(2);
  });

  it("does not crash the loop when approveAndMint throws unexpectedly", async () => {
    const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.APPROVED });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions({
      approveAndMint: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await expect(worker.pollOnce()).resolves.toBeUndefined();
    expect(row.cell(REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.APPROVED);
    expect(row.cell(REGISTRATION_COLUMNS.ERROR)).toBe("boom");
  });

  it("dispatches email exactly once when EmailStatus is set to SEND", async () => {
    const row = makeRegistrationRow({
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.CERT_MINTED,
      [REGISTRATION_COLUMNS.EMAIL_STATUS]: EMAIL_STATUS.SEND,
    });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions();
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await worker.pollOnce();
    expect(actions.dispatchEmail).toHaveBeenCalledTimes(1);
    expect(actions.dispatchEmail).toHaveBeenCalledWith("reg-1");
    expect(row.cell(REGISTRATION_COLUMNS.EMAIL_STATUS)).toBe(EMAIL_STATUS.SENT);

    // Second poll: cell now reads SENT, not SEND — must not re-fire.
    await worker.pollOnce();
    expect(actions.dispatchEmail).toHaveBeenCalledTimes(1);
  });

  it("records payment once and does not repeat it on subsequent polls", async () => {
    const row = makeRegistrationRow({
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.PAYMENT_VERIFIED,
      [REGISTRATION_COLUMNS.PAYMENT_REF]: "PAY-123",
      [REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY]: "admin@kalachain.test",
    });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions();
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await worker.pollOnce();
    await worker.pollOnce();

    expect(actions.recordPayment).toHaveBeenCalledTimes(1);
    expect(actions.recordPayment).toHaveBeenCalledWith("reg-1", "PAY-123", "admin@kalachain.test");
  });

  it("ignores rows in states with no defined trigger", async () => {
    const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions();
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await worker.pollOnce();

    expect(actions.recordPayment).not.toHaveBeenCalled();
    expect(actions.approveAndMint).not.toHaveBeenCalled();
    expect(actions.dispatchEmail).not.toHaveBeenCalled();
  });

  it("ignores blank/template rows with no ID", async () => {
    const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.ID]: "", [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.APPROVED });
    const accessor = new FakeAccessor([row]);
    const actions = fakeActions();
    const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 15_000 });

    await worker.pollOnce();

    expect(actions.approveAndMint).not.toHaveBeenCalled();
  });

  it("start()/stop() drive the poll loop via a setTimeout chain without overlap", async () => {
    vi.useFakeTimers();
    try {
      const row = makeRegistrationRow({ [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED });
      const accessor = new FakeAccessor([row]);
      const actions = fakeActions();
      const worker = new SheetSyncWorker({ accessor, actions, pollIntervalMs: 1000 });

      worker.start();
      await vi.advanceTimersByTimeAsync(0); // first poll fires immediately
      await vi.advanceTimersByTimeAsync(1000); // second poll after one interval
      await vi.advanceTimersByTimeAsync(1000); // third poll

      worker.stop();
      const timeoutsBeforeIdle = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(timeoutsBeforeIdle); // no new polls scheduled after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
