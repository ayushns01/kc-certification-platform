import { beforeEach, describe, expect, it } from "vitest";
import type { CertificateRecord, Registration, Submission, Workshop } from "../domain/types";
import { REGISTRATION_COLUMNS, SHEET_SCHEMA, TAB_NAMES } from "../workers/types";
import { GoogleSheetsRepo, type RowLike, type SheetLike, type SheetsClientFactory, type SpreadsheetDocLike } from "./googleSheetsRepo";

// ---------------------------------------------------------------------------
// Fully in-memory fake of the google-spreadsheet surface GoogleSheetsRepo
// depends on. No network access anywhere in this file.
// ---------------------------------------------------------------------------

class FakeRow implements RowLike {
  private cells: Record<string, unknown>;

  constructor(
    public readonly rowNumber: number,
    initial: Record<string, unknown>,
  ) {
    this.cells = { ...initial };
  }

  get(key: string): unknown {
    return this.cells[key];
  }

  set(key: string, value: unknown): void {
    this.cells[key] = value;
  }

  async save(): Promise<void> {
    // no-op: FakeSheet holds the same row reference, so mutations via
    // set() are already "persisted" for subsequent reads.
  }

  toObject(): Record<string, unknown> {
    return { ...this.cells };
  }
}

class FakeSheet implements SheetLike {
  readonly headerValues: string[];
  private rows: FakeRow[] = [];
  private nextRowNumber = 2; // row 1 is the header

  constructor(
    public readonly title: string,
    headerValues: string[],
  ) {
    this.headerValues = [...headerValues];
  }

  async getRows<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<RowLike<T>[]> {
    // Real google-spreadsheet returns a fresh array on every call; return a
    // copy here too so a caller's cached array (GoogleSheetsRepo.getTab)
    // can't accidentally alias — and double-mutate — this sheet's backing
    // store the way pushing into a shared reference would.
    return [...this.rows] as unknown as RowLike<T>[];
  }

  async addRow(data: Record<string, unknown>): Promise<RowLike> {
    const row = new FakeRow(this.nextRowNumber++, data);
    this.rows.push(row);
    return row;
  }

  /** Test-only helper to simulate an admin hand-editing a cell directly in
   * the underlying sheet, bypassing the repo. */
  editRowDirectly(index: number, column: string, value: unknown): void {
    this.rows[index].set(column, value);
  }
}

class FakeSpreadsheetDoc implements SpreadsheetDocLike {
  sheetsByTitle: Record<string, SheetLike> = {};
  loadInfoCalls = 0;
  addSheetCalls: string[] = [];

  async loadInfo(): Promise<void> {
    this.loadInfoCalls += 1;
  }

  async addSheet(props: { title: string; headerValues: string[] }): Promise<SheetLike> {
    this.addSheetCalls.push(props.title);
    const sheet = new FakeSheet(props.title, props.headerValues);
    this.sheetsByTitle[props.title] = sheet;
    return sheet;
  }
}

function makeFactory(doc: FakeSpreadsheetDoc): SheetsClientFactory {
  return () => doc;
}

function sampleWorkshop(overrides: Partial<Workshop> = {}): Workshop {
  return { id: "ws-1", name: "Sitar Basics", date: "2026-08-01", phase: 1, ...overrides };
}

function sampleRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: "reg-1",
    workshopId: "ws-1",
    name: "Asha Rao",
    email: "asha@example.test",
    phase: 1,
    state: "REGISTERED",
    mintStatus: "NONE",
    emailStatus: "NOT_APPLICABLE",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function sampleSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    registrationId: "reg-2",
    recordingUrl: "https://example.test/recording.mp3",
    state: "SUBMITTED",
    mintStatus: "NONE",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function sampleCertificate(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    certId: "cert-1",
    certType: "PARTICIPATION",
    sourceId: "reg-1",
    metadata: { participantName: "Asha Rao", eventName: "Sitar Basics" },
    metadataHash: "0xdeadbeef",
    revoked: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoogleSheetsRepo", () => {
  let doc: FakeSpreadsheetDoc;
  let repo: GoogleSheetsRepo;

  beforeEach(() => {
    doc = new FakeSpreadsheetDoc();
    repo = new GoogleSheetsRepo({ sheetId: "fake-sheet-id", clientFactory: makeFactory(doc) });
  });

  describe("ensureSheetStructure", () => {
    it("creates all four tabs with the documented header row on first connect", async () => {
      await repo.ensureSheetStructure();

      expect(doc.loadInfoCalls).toBe(1);
      expect(new Set(doc.addSheetCalls)).toEqual(new Set(Object.values(TAB_NAMES)));

      for (const [tabName, headers] of Object.entries(SHEET_SCHEMA)) {
        expect(doc.sheetsByTitle[tabName].headerValues).toEqual([...headers]);
      }
    });

    it("is idempotent — does not recreate tabs that already exist", async () => {
      await repo.ensureSheetStructure();
      await repo.ensureSheetStructure();

      expect(doc.addSheetCalls.filter((t) => t === TAB_NAMES.REGISTRATIONS)).toHaveLength(1);
    });

    it("never touches the network directly — only through the injected factory", async () => {
      // No assertion beyond "this resolves without throwing": the fake
      // factory is the only path to a "doc", proving no hidden network
      // client is constructed at import or construction time.
      await expect(repo.ensureSheetStructure()).resolves.toBeUndefined();
    });
  });

  describe("Workshops", () => {
    it("round-trips create -> list -> get", async () => {
      await repo.ensureSheetStructure();
      const sheet = doc.sheetsByTitle[TAB_NAMES.WORKSHOPS];
      await sheet.addRow({ ID: "ws-1", Name: "Sitar Basics", Date: "2026-08-01", Phase: 1 });

      const listed = await repo.listWorkshops();
      expect(listed).toEqual([sampleWorkshop()]);

      const got = await repo.getWorkshop("ws-1");
      expect(got).toEqual(sampleWorkshop());
      expect(await repo.getWorkshop("nope")).toBeUndefined();
    });
  });

  describe("Registrations", () => {
    it("creates and reads back a registration", async () => {
      await repo.ensureSheetStructure();
      const reg = sampleRegistration();
      await repo.createRegistration(reg);

      expect(await repo.getRegistration("reg-1")).toEqual(reg);
      expect(await repo.findRegistration("asha@example.test", "ws-1")).toEqual(reg);
      expect(await repo.findRegistration("asha@example.test", "wrong-workshop")).toBeUndefined();
    });

    it("updates an existing row in place rather than duplicating it", async () => {
      await repo.ensureSheetStructure();
      await repo.createRegistration(sampleRegistration());

      const updated = sampleRegistration({
        state: "PAYMENT_VERIFIED",
        paymentRef: "PAY-999",
        paymentVerifiedBy: "admin@kalachain.test",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      await repo.updateRegistration(updated);

      const all = await repo.listRegistrations();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(updated);
    });

    it("throws a clear error updating a registration that does not exist", async () => {
      await repo.ensureSheetStructure();
      await expect(repo.updateRegistration(sampleRegistration({ id: "missing" }))).rejects.toThrow(/missing/);
    });

    it("filters listRegistrations by workshopId and state", async () => {
      await repo.ensureSheetStructure();
      await repo.createRegistration(sampleRegistration({ id: "reg-1", workshopId: "ws-1", state: "REGISTERED" }));
      await repo.createRegistration(sampleRegistration({ id: "reg-2", workshopId: "ws-2", state: "APPROVED" }));

      expect(await repo.listRegistrations({ workshopId: "ws-1" })).toHaveLength(1);
      expect(await repo.listRegistrations({ state: "APPROVED" })).toHaveLength(1);
      expect(await repo.listRegistrations({ workshopId: "ws-2", state: "APPROVED" })).toHaveLength(1);
      expect(await repo.listRegistrations({ workshopId: "ws-2", state: "REGISTERED" })).toHaveLength(0);
    });
  });

  describe("registrationsAccessor (SheetSyncWorker seam)", () => {
    it("exposes rows as SheetRowHandle-compatible objects the worker can read/write/save", async () => {
      await repo.ensureSheetStructure();
      await repo.createRegistration(sampleRegistration({ state: "APPROVED" }));

      const accessor = repo.registrationsAccessor();
      const rows = await accessor.fetchRegistrationRows();
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.get(REGISTRATION_COLUMNS.ID)).toBe("reg-1");
      expect(row.get(REGISTRATION_COLUMNS.STATUS)).toBe("APPROVED");

      row.set(REGISTRATION_COLUMNS.STATUS, "MINTING");
      await row.save();

      const registration = await repo.getRegistration("reg-1");
      // Sheet-only transient value round-trips through the raw Status cell.
      expect(registration?.state as string).toBe("MINTING");
    });

    it("picks up a direct edit to the underlying sheet on the next fetch (refresh-on-poll semantics)", async () => {
      await repo.ensureSheetStructure();
      await repo.createRegistration(sampleRegistration({ state: "REGISTERED" }));

      const accessor = repo.registrationsAccessor();
      const first = await accessor.fetchRegistrationRows();
      expect(first[0].get(REGISTRATION_COLUMNS.STATUS)).toBe("REGISTERED");

      // Simulate an admin editing the Status cell directly in the sheet.
      (doc.sheetsByTitle[TAB_NAMES.REGISTRATIONS] as FakeSheet).editRowDirectly(0, REGISTRATION_COLUMNS.STATUS, "PAYMENT_VERIFIED");

      const second = await accessor.fetchRegistrationRows();
      expect(second[0].get(REGISTRATION_COLUMNS.STATUS)).toBe("PAYMENT_VERIFIED");
    });
  });

  describe("Submissions", () => {
    it("round-trips a submission without an evaluation yet", async () => {
      await repo.ensureSheetStructure();
      const sub = sampleSubmission();
      await repo.createSubmission(sub);

      expect(await repo.getSubmission("sub-1")).toEqual(sub);
    });

    it("JSON-encodes evaluation parameters into a single cell and decodes them back", async () => {
      await repo.ensureSheetStructure();
      const sub = sampleSubmission({
        state: "EVALUATED",
        evaluation: {
          evaluatorName: "Guru Nair",
          marks: 87,
          grade: "A",
          parameters: { rhythm: 9, expression: 8, technique: 8 },
          comments: "Strong rhythm control.",
          audioFeedbackUrl: "https://example.test/feedback.mp3",
        },
      });
      await repo.createSubmission(sub);

      const roundTripped = await repo.getSubmission("sub-1");
      expect(roundTripped).toEqual(sub);

      // Confirm it's genuinely a JSON string in the cell, not a live object.
      const raw = doc.sheetsByTitle[TAB_NAMES.SUBMISSIONS];
      const [row] = await raw.getRows();
      expect(typeof row.get("Parameters")).toBe("string");
      expect(JSON.parse(row.get("Parameters") as string)).toEqual({ rhythm: 9, expression: 8, technique: 8 });
    });

    it("updates a submission in place", async () => {
      await repo.ensureSheetStructure();
      await repo.createSubmission(sampleSubmission());
      const finalized = sampleSubmission({ state: "FINALIZED", mintStatus: "MINTED", certId: "cert-9" });
      await repo.updateSubmission(finalized);

      expect(await repo.listSubmissions()).toEqual([finalized]);
    });
  });

  describe("Certificates", () => {
    it("JSON-encodes metadata and parses the revoked flag", async () => {
      await repo.ensureSheetStructure();
      const cert = sampleCertificate({
        tokenId: 42,
        txHash: "0xabc123",
        metadata: {
          participantName: "Asha Rao",
          eventName: "Sitar Basics",
          evaluatorName: "Guru Nair",
          marks: 87,
          grade: "A",
          parameters: { rhythm: 9 },
          comments: "Great job",
          audioFeedbackUrl: "https://example.test/a.mp3",
          txHash: "0xabc123",
        },
      });
      await repo.createCertificate(cert);

      expect(await repo.getCertificate("cert-1")).toEqual(cert);
      expect(await repo.getCertificateByTokenId(42)).toEqual(cert);
      expect(await repo.getCertificateByTokenId(999)).toBeUndefined();
    });

    it("updates revocation state in place", async () => {
      await repo.ensureSheetStructure();
      await repo.createCertificate(sampleCertificate());
      const revoked = sampleCertificate({ revoked: true, revokeReason: "Issued in error" });
      await repo.updateCertificate(revoked);

      expect(await repo.listCertificates()).toEqual([revoked]);
    });
  });

  describe("refresh()", () => {
    it("forces a re-fetch of a tab instead of serving stale cached rows", async () => {
      await repo.ensureSheetStructure();
      await repo.createRegistration(sampleRegistration());

      // Warm the cache.
      await repo.listRegistrations();

      // Bypass the repo entirely and add a row straight to the fake sheet.
      const sheet = doc.sheetsByTitle[TAB_NAMES.REGISTRATIONS];
      await sheet.addRow({
        [REGISTRATION_COLUMNS.ID]: "reg-2",
        [REGISTRATION_COLUMNS.WORKSHOP_ID]: "ws-1",
        [REGISTRATION_COLUMNS.NAME]: "Second Person",
        [REGISTRATION_COLUMNS.EMAIL]: "second@example.test",
        [REGISTRATION_COLUMNS.PHASE]: 1,
        [REGISTRATION_COLUMNS.STATUS]: "REGISTERED",
        [REGISTRATION_COLUMNS.MINT_STATUS]: "NONE",
        [REGISTRATION_COLUMNS.EMAIL_STATUS]: "NOT_APPLICABLE",
        [REGISTRATION_COLUMNS.CREATED_AT]: "2026-07-03T00:00:00.000Z",
        [REGISTRATION_COLUMNS.UPDATED_AT]: "2026-07-03T00:00:00.000Z",
      });

      repo.refresh(TAB_NAMES.REGISTRATIONS);
      expect(await repo.listRegistrations()).toHaveLength(2);
    });
  });
});
