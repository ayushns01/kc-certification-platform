import { describe, expect, it, vi } from "vitest";
import { SheetSyncWorker } from "./sheetSyncWorker";
import {
  EMAIL_STATUS,
  MINT_STATUS_VALUES,
  PARTICIPANT_STATUS,
  REGISTRATION_ACTIONS,
  REGISTRATION_COLUMNS,
  type MintOutcome,
  type RegistrationsSheetAccessor,
  type SheetRowHandle,
  type WorkflowActions,
} from "./types";

/**
 * Persisted cell store shared by all handles for a row — mimics the real
 * sheet: `set()` mutates only the handle's local pending state; `save()`
 * persists to the shared store; a FRESH handle reads only persisted values.
 * This lets tests prove the consume-then-act guard holds through
 * PERSISTENCE (the awaited save), not through row-object identity.
 */
class FakeSheet {
  private store: Array<Record<string, string>> = [];

  addRow(cells: Record<string, string>): void {
    this.store.push({ ...cells });
  }

  cell(rowIndex: number, column: string): string | undefined {
    return this.store[rowIndex]?.[column];
  }

  setCell(rowIndex: number, column: string, value: string): void {
    this.store[rowIndex]![column] = value;
  }

  /** Fresh handles each call — like a real getRows() fetch after refresh(). */
  freshHandles(): SheetRowHandle[] {
    return this.store.map((_, i) => this.handleFor(i));
  }

  handleFor(rowIndex: number): SheetRowHandle {
    const pending: Record<string, string> = {};
    const sheet = this;
    return {
      rowNumber: rowIndex + 2, // header row + 1-indexing, like google-spreadsheet
      get(column: string) {
        const value = column in pending ? pending[column] : sheet.store[rowIndex]?.[column];
        return value === undefined || value === "" ? undefined : value;
      },
      set(column: string, value: string | number) {
        pending[column] = String(value);
      },
      async save() {
        Object.assign(sheet.store[rowIndex]!, pending);
      },
    };
  }
}

function freshAccessor(sheet: FakeSheet): RegistrationsSheetAccessor {
  return { fetchRegistrationRows: async () => sheet.freshHandles() };
}

/** Returns the SAME handle objects every call — the shared-reference model
 * used by the overlapping-poll simulation. */
function sharedAccessor(sheet: FakeSheet): RegistrationsSheetAccessor {
  const handles = sheet.freshHandles();
  return { fetchRegistrationRows: async () => handles };
}

function successOutcome(overrides: Partial<MintOutcome> = {}): MintOutcome {
  return {
    mintStatus: "MINTED",
    certId: "cert_abc123",
    txHash: "0xdeadbeef",
    tokenId: 7,
    verificationUrl: "/verify/cert_abc123",
    ...overrides,
  };
}

function fakeActions(overrides: Partial<WorkflowActions> = {}): WorkflowActions {
  return {
    recordPayment: vi.fn().mockResolvedValue(undefined),
    approveAndMint: vi.fn().mockResolvedValue(successOutcome()),
    dispatchEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function approveCommandRow(id = "reg_1"): Record<string, string> {
  return {
    [REGISTRATION_COLUMNS.ID]: id,
    [REGISTRATION_COLUMNS.ACTION]: REGISTRATION_ACTIONS.APPROVE,
    [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.PAYMENT_VERIFIED,
    [REGISTRATION_COLUMNS.MINT_STATUS]: MINT_STATUS_VALUES.NONE,
  };
}

function buildWorker(sheet: FakeSheet, actions: WorkflowActions, opts: { shared?: boolean } = {}) {
  return new SheetSyncWorker({
    accessor: opts.shared ? sharedAccessor(sheet) : freshAccessor(sheet),
    actions,
    pollIntervalMs: 5,
  });
}

describe("SheetSyncWorker", () => {
  it("Action=APPROVE mints once and writes back all mint columns including CertID", async () => {
    const sheet = new FakeSheet();
    sheet.addRow(approveCommandRow());
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(actions.approveAndMint).toHaveBeenCalledTimes(1);
    expect(actions.approveAndMint).toHaveBeenCalledWith("reg_1");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ACTION)).toBe(REGISTRATION_ACTIONS.NONE);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.CERT_MINTED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.MINTED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.CERT_ID)).toBe("cert_abc123");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.TX_HASH)).toBe("0xdeadbeef");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.TOKEN_ID)).toBe("7");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.VERIFICATION_LINK)).toBe("/verify/cert_abc123");
    // Mint never sends email — PENDING until the admin enters SEND.
    expect(sheet.cell(0, REGISTRATION_COLUMNS.EMAIL_STATUS)).toBe(EMAIL_STATUS.PENDING);
  });

  it("mints exactly once across overlapping polls (shared row objects)", async () => {
    const sheet = new FakeSheet();
    sheet.addRow(approveCommandRow());
    let resolveMint!: (o: MintOutcome) => void;
    const slowMint = new Promise<MintOutcome>((r) => {
      resolveMint = r;
    });
    const actions = fakeActions({ approveAndMint: vi.fn().mockReturnValue(slowMint) });
    const worker = buildWorker(sheet, actions, { shared: true });

    const poll1 = worker.pollOnce(); // starts the slow mint
    const poll2 = worker.pollOnce(); // overlapping cycle — must see consumed Action
    resolveMint(successOutcome());
    await Promise.all([poll1, poll2]);

    expect(actions.approveAndMint).toHaveBeenCalledTimes(1);
  });

  it("mints exactly once across sequential polls with FRESH row objects — the guard holds via persistence, not object identity", async () => {
    const sheet = new FakeSheet();
    sheet.addRow(approveCommandRow());
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions); // fresh handles per poll

    await worker.pollOnce();
    await worker.pollOnce(); // fresh fetch — must see the PERSISTED cleared Action
    await worker.pollOnce();

    expect(actions.approveAndMint).toHaveBeenCalledTimes(1);
  });

  it("on mint failure writes Status=APPROVED (true domain state), MintStatus=FAILED and Error; re-entering the Action retries", async () => {
    const sheet = new FakeSheet();
    sheet.addRow(approveCommandRow());
    const actions = fakeActions({
      approveAndMint: vi
        .fn()
        .mockResolvedValueOnce({ mintStatus: "FAILED", error: "chain reverted" })
        .mockResolvedValue(successOutcome()),
    });
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();
    expect(sheet.cell(0, REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.APPROVED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.FAILED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toBe("chain reverted");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ACTION)).toBe(REGISTRATION_ACTIONS.NONE);

    // A poll without a re-entered command must NOT auto-retry.
    await worker.pollOnce();
    expect(actions.approveAndMint).toHaveBeenCalledTimes(1);

    // Admin re-enters the command -> retry fires (the WorkflowActions
    // adapter maps APPROVE-on-already-APPROVED to retry-mint).
    sheet.setCell(0, REGISTRATION_COLUMNS.ACTION, REGISTRATION_ACTIONS.APPROVE);
    await worker.pollOnce();
    expect(actions.approveAndMint).toHaveBeenCalledTimes(2);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.MINTED);
  });

  it("does not crash the loop when approveAndMint throws unexpectedly; later rows still process", async () => {
    const sheet = new FakeSheet();
    sheet.addRow(approveCommandRow("reg_bad"));
    sheet.addRow(approveCommandRow("reg_good"));
    const actions = fakeActions({
      approveAndMint: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(successOutcome({ certId: "cert_good" })),
    });
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.FAILED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toBe("boom");
    // Second row still processed in the same cycle.
    expect(sheet.cell(1, REGISTRATION_COLUMNS.CERT_ID)).toBe("cert_good");
  });

  it("Action=VERIFY_PAYMENT fires recordPayment with ref + verifier, writes Status back, never re-fires", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_2",
      [REGISTRATION_COLUMNS.ACTION]: REGISTRATION_ACTIONS.VERIFY_PAYMENT,
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED,
      [REGISTRATION_COLUMNS.PAYMENT_REF]: "UPI-42",
      [REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY]: "admin@kalachain.org",
    });
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();
    await worker.pollOnce(); // consumed command — must not re-fire

    expect(actions.recordPayment).toHaveBeenCalledTimes(1);
    expect(actions.recordPayment).toHaveBeenCalledWith("reg_2", "UPI-42", "admin@kalachain.org");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.STATUS)).toBe(PARTICIPANT_STATUS.PAYMENT_VERIFIED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ACTION)).toBe(REGISTRATION_ACTIONS.NONE);
  });

  it("VERIFY_PAYMENT without a PaymentRef writes an Error and does not fire the action", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_3",
      [REGISTRATION_COLUMNS.ACTION]: REGISTRATION_ACTIONS.VERIFY_PAYMENT,
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED,
    });
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(actions.recordPayment).not.toHaveBeenCalled();
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toContain("PaymentRef");
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ACTION)).toBe(REGISTRATION_ACTIONS.NONE);
  });

  it("EmailStatus=SEND is consumed to PENDING before dispatch runs, then flipped to SENT, exactly once", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_4",
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.CERT_MINTED,
      [REGISTRATION_COLUMNS.EMAIL_STATUS]: EMAIL_STATUS.SEND,
    });
    // Capture the PERSISTED EmailStatus at the moment dispatch runs: it must
    // already read PENDING — the domain state the service's dispatch guard
    // expects (under DATA_BACKEND=sheets this cell IS the domain field).
    let cellWhenDispatchRan: string | undefined;
    const actions = fakeActions({
      dispatchEmail: vi.fn().mockImplementation(async () => {
        cellWhenDispatchRan = sheet.cell(0, REGISTRATION_COLUMNS.EMAIL_STATUS);
      }),
    });
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();
    await worker.pollOnce(); // no SEND anymore — must not re-dispatch

    expect(actions.dispatchEmail).toHaveBeenCalledTimes(1);
    expect(actions.dispatchEmail).toHaveBeenCalledWith("reg_4");
    expect(cellWhenDispatchRan).toBe(EMAIL_STATUS.PENDING);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.EMAIL_STATUS)).toBe(EMAIL_STATUS.SENT);
  });

  it("email dispatch failure leaves EmailStatus=PENDING (admin re-enters SEND) with the Error recorded", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_5",
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.CERT_MINTED,
      [REGISTRATION_COLUMNS.EMAIL_STATUS]: EMAIL_STATUS.SEND,
    });
    const actions = fakeActions({ dispatchEmail: vi.fn().mockRejectedValue(new Error("smtp down")) });
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(sheet.cell(0, REGISTRATION_COLUMNS.EMAIL_STATUS)).toBe(EMAIL_STATUS.PENDING);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toBe("smtp down");
  });

  it("recovers a stranded MINTING row (no TxHash, no Action) to FAILED with a retry hint", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_6",
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.PAYMENT_VERIFIED,
      [REGISTRATION_COLUMNS.MINT_STATUS]: MINT_STATUS_VALUES.MINTING,
    });
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.FAILED);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toContain("re-enter Action=APPROVE");
    expect(actions.approveAndMint).not.toHaveBeenCalled();
  });

  it("does NOT touch a MINTING row that already has a TxHash (mint landed; write-back merely incomplete)", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_7",
      [REGISTRATION_COLUMNS.MINT_STATUS]: MINT_STATUS_VALUES.MINTING,
      [REGISTRATION_COLUMNS.TX_HASH]: "0xabc",
    });
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();

    expect(sheet.cell(0, REGISTRATION_COLUMNS.MINT_STATUS)).toBe(MINT_STATUS_VALUES.MINTING);
    expect(sheet.cell(0, REGISTRATION_COLUMNS.ERROR)).toBeUndefined();
  });

  it("ignores blank rows and rows without commands; consumes unknown Action values with an Error", async () => {
    const sheet = new FakeSheet();
    sheet.addRow({}); // blank
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_8",
      [REGISTRATION_COLUMNS.STATUS]: PARTICIPANT_STATUS.REGISTERED,
    }); // no command
    sheet.addRow({
      [REGISTRATION_COLUMNS.ID]: "reg_9",
      [REGISTRATION_COLUMNS.ACTION]: "MAKE_IT_SO",
    }); // unknown command
    const actions = fakeActions();
    const worker = buildWorker(sheet, actions);

    await worker.pollOnce();
    await worker.pollOnce();

    expect(actions.recordPayment).not.toHaveBeenCalled();
    expect(actions.approveAndMint).not.toHaveBeenCalled();
    expect(actions.dispatchEmail).not.toHaveBeenCalled();
    expect(sheet.cell(2, REGISTRATION_COLUMNS.ERROR)).toContain("unknown Action");
    expect(sheet.cell(2, REGISTRATION_COLUMNS.ACTION)).toBe(REGISTRATION_ACTIONS.NONE);
  });

  it("start()/stop(): the timer chain polls repeatedly and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn().mockResolvedValue([]);
      const worker = new SheetSyncWorker({
        accessor: { fetchRegistrationRows: fetchSpy },
        actions: fakeActions(),
        pollIntervalMs: 1000,
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(0); // immediate first poll
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      worker.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // no polls after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
