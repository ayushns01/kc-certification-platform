/**
 * GoogleSheetsRepo — `IDataRepository` implementation backed by a Google
 * Sheet (see docs/ARCHITECTURE.md, "Google Sheets as the Admin Interface").
 *
 * Auth: a service-account JWT (google-auth-library) against the
 * `google-spreadsheet` v4 client. Both the sheet ID and the key file path
 * are constructor params, not globals — nothing here reaches into
 * `process.env` directly, so the same class works for the real backend and
 * for fully offline unit tests.
 *
 * Tabs, one per aggregate: Workshops, Registrations, Submissions,
 * Certificates. Header row = the column-name constants in
 * `backend/src/workers/types.ts` (the single source of truth shared with
 * `SheetSyncWorker`, so the two can never drift apart on column names).
 * Complex/nested domain fields (evaluation parameters, certificate
 * metadata) are JSON-encoded into a single cell — Sheets has no native
 * structured-cell type.
 *
 * `ensureSheetStructure()` creates any missing tab (with its header row) on
 * first connect, so pointing this at a brand-new blank spreadsheet "just
 * works" for a reviewer following docs/SHEETS-SETUP.md.
 *
 * Caching: a small in-memory row-index cache per tab, populated lazily and
 * invalidated by `refresh()`. This is NOT a multi-writer cache — per
 * docs/ARCHITECTURE.md the sheet has single-writer semantics in this
 * prototype (the backend process is the only writer; the admin only edits
 * the trigger cells `Status`/`PaymentRef`/`EmailStatus`, never the
 * write-back columns). `SheetSyncWorker`'s poll loop is what surfaces admin
 * edits — its cadence (`SHEET_POLL_INTERVAL_MS`) is effectively this
 * cache's refresh cadence for Registrations; callers that need to observe a
 * fresh admin edit sooner should call `refresh()` explicitly.
 *
 * Testability: the sheets client is constructed via an injectable
 * `SheetsClientFactory` passed into the constructor. Unit tests supply a
 * fake factory returning an in-memory fake spreadsheet, so this module
 * never requires network access to test.
 */

import { JWT } from "google-auth-library";
import { GoogleSpreadsheet } from "google-spreadsheet";
import type {
  CertificateRecord,
  CertType,
  EmailStatus as DomainEmailStatus,
  MintStatus,
  ParticipantState,
  Phase,
  Registration,
  Submission,
  SubmissionState,
  Workshop,
} from "../domain/types";
import type { IDataRepository } from "./types";
import {
  CERTIFICATE_COLUMNS,
  REGISTRATION_COLUMNS,
  SHEET_SCHEMA,
  SUBMISSION_COLUMNS,
  TAB_NAMES,
  WORKSHOP_COLUMNS,
  type RegistrationsSheetAccessor,
  type SheetRowHandle,
} from "../workers/types";

// ---------------------------------------------------------------------------
// Minimal structural surface of google-spreadsheet we depend on. Kept
// narrow and separate from the real package's (much larger) types so a
// test fake only has to implement what we actually use.
// ---------------------------------------------------------------------------

export interface RowLike<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowNumber: number;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  save(): Promise<void>;
  toObject(): Partial<T>;
}

export interface SheetLike {
  readonly title: string;
  readonly headerValues: string[];
  getRows<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<RowLike<T>[]>;
  addRow(data: Record<string, unknown>): Promise<RowLike>;
}

export interface SpreadsheetDocLike {
  loadInfo(): Promise<void>;
  readonly sheetsByTitle: Record<string, SheetLike>;
  addSheet(props: { title: string; headerValues: string[] }): Promise<SheetLike>;
}

export type SheetsClientFactory = () => Promise<SpreadsheetDocLike> | SpreadsheetDocLike;

export interface GoogleSheetsRepoOptions {
  sheetId: string;
  /** Path to the service-account key JSON. Ignored if `clientFactory` is
   * supplied (e.g. in tests). */
  keyFile?: string;
  /** Injectable client factory — production code omits this and gets the
   * real `google-spreadsheet` + JWT client; tests supply a fake. */
  clientFactory?: SheetsClientFactory;
}

const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function defaultClientFactory(sheetId: string, keyFile: string | undefined): SheetsClientFactory {
  return async () => {
    if (!keyFile) {
      throw new Error(
        "GoogleSheetsRepo: no keyFile provided and no clientFactory supplied. " +
          "Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (see docs/SHEETS-SETUP.md).",
      );
    }
    const auth = new JWT({ keyFile, scopes: SHEETS_SCOPES });
    const doc = new GoogleSpreadsheet(sheetId, auth);
    return doc as unknown as SpreadsheetDocLike;
  };
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping helpers (pure functions — easy to unit test)
// ---------------------------------------------------------------------------

function cell(row: RowLike, column: string): string {
  const value = row.get(column);
  return value === undefined || value === null ? "" : String(value);
}

function optionalCell(row: RowLike, column: string): string | undefined {
  const value = cell(row, column);
  return value === "" ? undefined : value;
}

function numberCell(row: RowLike, column: string): number | undefined {
  const raw = optionalCell(row, column);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

function parseWorkshopRow(row: RowLike): Workshop {
  return {
    id: cell(row, WORKSHOP_COLUMNS.ID),
    name: cell(row, WORKSHOP_COLUMNS.NAME),
    date: cell(row, WORKSHOP_COLUMNS.DATE),
    phase: Number(cell(row, WORKSHOP_COLUMNS.PHASE) || "1") as Phase,
  };
}

function serializeWorkshop(w: Workshop): Record<string, unknown> {
  return {
    [WORKSHOP_COLUMNS.ID]: w.id,
    [WORKSHOP_COLUMNS.NAME]: w.name,
    [WORKSHOP_COLUMNS.DATE]: w.date,
    [WORKSHOP_COLUMNS.PHASE]: w.phase,
  };
}

function parseRegistrationRow(row: RowLike): Registration {
  return {
    id: cell(row, REGISTRATION_COLUMNS.ID),
    workshopId: cell(row, REGISTRATION_COLUMNS.WORKSHOP_ID),
    name: cell(row, REGISTRATION_COLUMNS.NAME),
    email: cell(row, REGISTRATION_COLUMNS.EMAIL),
    phase: Number(cell(row, REGISTRATION_COLUMNS.PHASE) || "1") as Phase,
    state: cell(row, REGISTRATION_COLUMNS.STATUS) as ParticipantState,
    paymentRef: optionalCell(row, REGISTRATION_COLUMNS.PAYMENT_REF),
    paymentVerifiedBy: optionalCell(row, REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY),
    mintStatus: (optionalCell(row, REGISTRATION_COLUMNS.MINT_STATUS) ?? "NONE") as MintStatus,
    mintError: optionalCell(row, REGISTRATION_COLUMNS.MINT_ERROR),
    emailStatus: (optionalCell(row, REGISTRATION_COLUMNS.EMAIL_STATUS) ?? "NOT_APPLICABLE") as DomainEmailStatus,
    certId: optionalCell(row, REGISTRATION_COLUMNS.CERT_ID),
    createdAt: cell(row, REGISTRATION_COLUMNS.CREATED_AT),
    updatedAt: cell(row, REGISTRATION_COLUMNS.UPDATED_AT),
  };
}

function serializeRegistration(reg: Registration): Record<string, unknown> {
  return {
    [REGISTRATION_COLUMNS.ID]: reg.id,
    [REGISTRATION_COLUMNS.WORKSHOP_ID]: reg.workshopId,
    [REGISTRATION_COLUMNS.NAME]: reg.name,
    [REGISTRATION_COLUMNS.EMAIL]: reg.email,
    [REGISTRATION_COLUMNS.PHASE]: reg.phase,
    [REGISTRATION_COLUMNS.STATUS]: reg.state,
    [REGISTRATION_COLUMNS.PAYMENT_REF]: reg.paymentRef ?? "",
    [REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY]: reg.paymentVerifiedBy ?? "",
    [REGISTRATION_COLUMNS.MINT_STATUS]: reg.mintStatus,
    [REGISTRATION_COLUMNS.MINT_ERROR]: reg.mintError ?? "",
    [REGISTRATION_COLUMNS.EMAIL_STATUS]: reg.emailStatus,
    [REGISTRATION_COLUMNS.CERT_ID]: reg.certId ?? "",
    [REGISTRATION_COLUMNS.CREATED_AT]: reg.createdAt,
    [REGISTRATION_COLUMNS.UPDATED_AT]: reg.updatedAt,
  };
}

function parseSubmissionRow(row: RowLike): Submission {
  const evaluatorName = optionalCell(row, SUBMISSION_COLUMNS.EVALUATOR_NAME);
  const marks = numberCell(row, SUBMISSION_COLUMNS.MARKS);
  const evaluation =
    evaluatorName !== undefined && marks !== undefined
      ? {
          evaluatorName,
          marks,
          grade: cell(row, SUBMISSION_COLUMNS.GRADE),
          parameters: parseJsonCell<Record<string, number>>(row, SUBMISSION_COLUMNS.PARAMETERS, {}),
          comments: cell(row, SUBMISSION_COLUMNS.COMMENTS),
          audioFeedbackUrl: cell(row, SUBMISSION_COLUMNS.AUDIO_FEEDBACK_URL),
        }
      : undefined;

  return {
    id: cell(row, SUBMISSION_COLUMNS.ID),
    registrationId: cell(row, SUBMISSION_COLUMNS.REGISTRATION_ID),
    recordingUrl: cell(row, SUBMISSION_COLUMNS.RECORDING_URL),
    state: cell(row, SUBMISSION_COLUMNS.STATE) as SubmissionState,
    evaluation,
    mintStatus: (optionalCell(row, SUBMISSION_COLUMNS.MINT_STATUS) ?? "NONE") as MintStatus,
    mintError: optionalCell(row, SUBMISSION_COLUMNS.MINT_ERROR),
    certId: optionalCell(row, SUBMISSION_COLUMNS.CERT_ID),
    createdAt: cell(row, SUBMISSION_COLUMNS.CREATED_AT),
    updatedAt: cell(row, SUBMISSION_COLUMNS.UPDATED_AT),
  };
}

function serializeSubmission(sub: Submission): Record<string, unknown> {
  return {
    [SUBMISSION_COLUMNS.ID]: sub.id,
    [SUBMISSION_COLUMNS.REGISTRATION_ID]: sub.registrationId,
    [SUBMISSION_COLUMNS.RECORDING_URL]: sub.recordingUrl,
    [SUBMISSION_COLUMNS.STATE]: sub.state,
    [SUBMISSION_COLUMNS.EVALUATOR_NAME]: sub.evaluation?.evaluatorName ?? "",
    [SUBMISSION_COLUMNS.MARKS]: sub.evaluation?.marks ?? "",
    [SUBMISSION_COLUMNS.GRADE]: sub.evaluation?.grade ?? "",
    [SUBMISSION_COLUMNS.PARAMETERS]: sub.evaluation ? JSON.stringify(sub.evaluation.parameters) : "",
    [SUBMISSION_COLUMNS.COMMENTS]: sub.evaluation?.comments ?? "",
    [SUBMISSION_COLUMNS.AUDIO_FEEDBACK_URL]: sub.evaluation?.audioFeedbackUrl ?? "",
    [SUBMISSION_COLUMNS.MINT_STATUS]: sub.mintStatus,
    [SUBMISSION_COLUMNS.MINT_ERROR]: sub.mintError ?? "",
    [SUBMISSION_COLUMNS.CERT_ID]: sub.certId ?? "",
    [SUBMISSION_COLUMNS.CREATED_AT]: sub.createdAt,
    [SUBMISSION_COLUMNS.UPDATED_AT]: sub.updatedAt,
  };
}

function parseCertificateRow(row: RowLike): CertificateRecord {
  return {
    certId: cell(row, CERTIFICATE_COLUMNS.CERT_ID),
    certType: cell(row, CERTIFICATE_COLUMNS.CERT_TYPE) as CertType,
    sourceId: cell(row, CERTIFICATE_COLUMNS.SOURCE_ID),
    tokenId: numberCell(row, CERTIFICATE_COLUMNS.TOKEN_ID),
    txHash: optionalCell(row, CERTIFICATE_COLUMNS.TX_HASH),
    metadata: parseJsonCell<Record<string, unknown>>(row, CERTIFICATE_COLUMNS.METADATA, {}),
    metadataHash: cell(row, CERTIFICATE_COLUMNS.METADATA_HASH),
    revoked: cell(row, CERTIFICATE_COLUMNS.REVOKED).toLowerCase() === "true",
    revokeReason: optionalCell(row, CERTIFICATE_COLUMNS.REVOKE_REASON),
    createdAt: cell(row, CERTIFICATE_COLUMNS.CREATED_AT),
  };
}

function serializeCertificate(c: CertificateRecord): Record<string, unknown> {
  return {
    [CERTIFICATE_COLUMNS.CERT_ID]: c.certId,
    [CERTIFICATE_COLUMNS.CERT_TYPE]: c.certType,
    [CERTIFICATE_COLUMNS.SOURCE_ID]: c.sourceId,
    [CERTIFICATE_COLUMNS.TOKEN_ID]: c.tokenId ?? "",
    [CERTIFICATE_COLUMNS.TX_HASH]: c.txHash ?? "",
    [CERTIFICATE_COLUMNS.METADATA]: JSON.stringify(c.metadata),
    [CERTIFICATE_COLUMNS.METADATA_HASH]: c.metadataHash,
    [CERTIFICATE_COLUMNS.REVOKED]: c.revoked ? "true" : "false",
    [CERTIFICATE_COLUMNS.REVOKE_REASON]: c.revokeReason ?? "",
    [CERTIFICATE_COLUMNS.CREATED_AT]: c.createdAt,
  };
}

function parseJsonCell<T>(row: RowLike, column: string, fallback: T): T {
  const raw = optionalCell(row, column);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Adapts a real/fake `RowLike` to the narrower `SheetRowHandle` the worker
 * depends on, keeping `backend/src/workers/*` free of any dependency on
 * this file's (or google-spreadsheet's) row types. */
function toSheetRowHandle(row: RowLike): SheetRowHandle {
  return {
    rowNumber: row.rowNumber,
    get: (column: string) => {
      const value = row.get(column);
      return value === undefined || value === null || value === "" ? undefined : String(value);
    },
    set: (column: string, value: string | number) => row.set(column, value),
    save: () => row.save(),
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

interface TabCache {
  sheet: SheetLike;
  rows: RowLike[];
}

export class GoogleSheetsRepo implements IDataRepository {
  private doc: SpreadsheetDocLike | undefined;
  private connecting: Promise<SpreadsheetDocLike> | undefined;
  private readonly tabCache = new Map<string, TabCache>();

  constructor(private readonly options: GoogleSheetsRepoOptions) {}

  // -- connection -----------------------------------------------------

  private async getDoc(): Promise<SpreadsheetDocLike> {
    if (this.doc) return this.doc;
    if (!this.connecting) {
      this.connecting = this.connect();
    }
    this.doc = await this.connecting;
    return this.doc;
  }

  private async connect(): Promise<SpreadsheetDocLike> {
    const factory = this.options.clientFactory ?? defaultClientFactory(this.options.sheetId, this.options.keyFile);
    const doc = await factory();
    await doc.loadInfo();
    await this.applySchema(doc);
    return doc;
  }

  /** Creates any missing tab (with its header row) so a blank spreadsheet
   * is ready to use on first connect. Public + idempotent: safe to call
   * again any time (e.g. after manually adding a tab mid-session). */
  async ensureSheetStructure(): Promise<void> {
    const doc = await this.getDoc();
    await this.applySchema(doc);
  }

  private async applySchema(doc: SpreadsheetDocLike): Promise<void> {
    for (const [tabName, headers] of Object.entries(SHEET_SCHEMA)) {
      if (!doc.sheetsByTitle[tabName]) {
        await doc.addSheet({ title: tabName, headerValues: [...headers] });
      }
    }
  }

  /** Drops the in-memory row cache. Pass a tab name to invalidate just that
   * tab, or omit to invalidate everything. The next read re-fetches from
   * the sheet. See class doc comment re: single-writer + poll-driven
   * refresh cadence. */
  refresh(tabName?: string): void {
    if (tabName) {
      this.tabCache.delete(tabName);
    } else {
      this.tabCache.clear();
    }
  }

  private async getTab(tabName: string): Promise<TabCache> {
    const cached = this.tabCache.get(tabName);
    if (cached) return cached;

    const doc = await this.getDoc();
    const sheet = doc.sheetsByTitle[tabName];
    if (!sheet) {
      throw new Error(`GoogleSheetsRepo: tab "${tabName}" not found (ensureSheetStructure() should have created it)`);
    }
    const rows = await sheet.getRows();
    const entry: TabCache = { sheet, rows };
    this.tabCache.set(tabName, entry);
    return entry;
  }

  // -- Workshops --------------------------------------------------------

  async listWorkshops(): Promise<Workshop[]> {
    const { rows } = await this.getTab(TAB_NAMES.WORKSHOPS);
    return rows.map(parseWorkshopRow);
  }

  async getWorkshop(id: string): Promise<Workshop | undefined> {
    const workshops = await this.listWorkshops();
    return workshops.find((w) => w.id === id);
  }

  // -- Registrations ------------------------------------------------------

  async createRegistration(reg: Registration): Promise<void> {
    const tab = await this.getTab(TAB_NAMES.REGISTRATIONS);
    const row = await tab.sheet.addRow(serializeRegistration(reg));
    tab.rows.push(row);
  }

  async getRegistration(id: string): Promise<Registration | undefined> {
    const { rows } = await this.getTab(TAB_NAMES.REGISTRATIONS);
    const row = rows.find((r) => cell(r, REGISTRATION_COLUMNS.ID) === id);
    return row ? parseRegistrationRow(row) : undefined;
  }

  async findRegistration(email: string, workshopId: string): Promise<Registration | undefined> {
    const { rows } = await this.getTab(TAB_NAMES.REGISTRATIONS);
    const row = rows.find(
      (r) => cell(r, REGISTRATION_COLUMNS.EMAIL) === email && cell(r, REGISTRATION_COLUMNS.WORKSHOP_ID) === workshopId,
    );
    return row ? parseRegistrationRow(row) : undefined;
  }

  async updateRegistration(reg: Registration): Promise<void> {
    const { rows } = await this.getTab(TAB_NAMES.REGISTRATIONS);
    const row = rows.find((r) => cell(r, REGISTRATION_COLUMNS.ID) === reg.id);
    if (!row) {
      throw new Error(`GoogleSheetsRepo: cannot update registration "${reg.id}" — no matching row`);
    }
    const data = serializeRegistration(reg);
    for (const [column, value] of Object.entries(data)) {
      row.set(column, value);
    }
    await row.save();
  }

  async listRegistrations(filter?: { workshopId?: string; state?: string }): Promise<Registration[]> {
    const { rows } = await this.getTab(TAB_NAMES.REGISTRATIONS);
    return rows
      .map(parseRegistrationRow)
      .filter((r) => (filter?.workshopId ? r.workshopId === filter.workshopId : true))
      .filter((r) => (filter?.state ? r.state === filter.state : true));
  }

  /** Adapts the Registrations tab to the narrow accessor `SheetSyncWorker`
   * depends on (see backend/src/workers/types.ts). The worker is wired up
   * by a controller elsewhere; this method is the seam it hangs off. */
  registrationsAccessor(): RegistrationsSheetAccessor {
    return {
      fetchRegistrationRows: async () => {
        this.refresh(TAB_NAMES.REGISTRATIONS);
        const { rows } = await this.getTab(TAB_NAMES.REGISTRATIONS);
        return rows.map(toSheetRowHandle);
      },
    };
  }

  // -- Submissions --------------------------------------------------------

  async createSubmission(sub: Submission): Promise<void> {
    const tab = await this.getTab(TAB_NAMES.SUBMISSIONS);
    const row = await tab.sheet.addRow(serializeSubmission(sub));
    tab.rows.push(row);
  }

  async getSubmission(id: string): Promise<Submission | undefined> {
    const { rows } = await this.getTab(TAB_NAMES.SUBMISSIONS);
    const row = rows.find((r) => cell(r, SUBMISSION_COLUMNS.ID) === id);
    return row ? parseSubmissionRow(row) : undefined;
  }

  async updateSubmission(sub: Submission): Promise<void> {
    const { rows } = await this.getTab(TAB_NAMES.SUBMISSIONS);
    const row = rows.find((r) => cell(r, SUBMISSION_COLUMNS.ID) === sub.id);
    if (!row) {
      throw new Error(`GoogleSheetsRepo: cannot update submission "${sub.id}" — no matching row`);
    }
    const data = serializeSubmission(sub);
    for (const [column, value] of Object.entries(data)) {
      row.set(column, value);
    }
    await row.save();
  }

  async listSubmissions(): Promise<Submission[]> {
    const { rows } = await this.getTab(TAB_NAMES.SUBMISSIONS);
    return rows.map(parseSubmissionRow);
  }

  // -- Certificates --------------------------------------------------------

  async createCertificate(certificate: CertificateRecord): Promise<void> {
    const tab = await this.getTab(TAB_NAMES.CERTIFICATES);
    const row = await tab.sheet.addRow(serializeCertificate(certificate));
    tab.rows.push(row);
  }

  async getCertificate(certId: string): Promise<CertificateRecord | undefined> {
    const { rows } = await this.getTab(TAB_NAMES.CERTIFICATES);
    const row = rows.find((r) => cell(r, CERTIFICATE_COLUMNS.CERT_ID) === certId);
    return row ? parseCertificateRow(row) : undefined;
  }

  async getCertificateByTokenId(tokenId: number): Promise<CertificateRecord | undefined> {
    const { rows } = await this.getTab(TAB_NAMES.CERTIFICATES);
    const row = rows.find((r) => numberCell(r, CERTIFICATE_COLUMNS.TOKEN_ID) === tokenId);
    return row ? parseCertificateRow(row) : undefined;
  }

  async updateCertificate(certificate: CertificateRecord): Promise<void> {
    const { rows } = await this.getTab(TAB_NAMES.CERTIFICATES);
    const row = rows.find((r) => cell(r, CERTIFICATE_COLUMNS.CERT_ID) === certificate.certId);
    if (!row) {
      throw new Error(`GoogleSheetsRepo: cannot update certificate "${certificate.certId}" — no matching row`);
    }
    const data = serializeCertificate(certificate);
    for (const [column, value] of Object.entries(data)) {
      row.set(column, value);
    }
    await row.save();
  }

  async listCertificates(): Promise<CertificateRecord[]> {
    const { rows } = await this.getTab(TAB_NAMES.CERTIFICATES);
    return rows.map(parseCertificateRow);
  }
}
