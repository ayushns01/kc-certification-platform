/**
 * Shared contracts for the Google-Sheets-driven admin workflow.
 *
 * The sheet is the admin UI (see docs/ARCHITECTURE.md, "Google Sheets as the
 * Admin Interface"). `SheetSyncWorker` polls it, detects admin-driven edits,
 * and drives the SAME service-layer state machine the REST API uses via
 * `WorkflowActions`. The worker is built and tested against these
 * interfaces only — it never imports the service layer directly, so it can
 * be developed in parallel with (and stay decoupled from) the services. A
 * controller assembled elsewhere wires a real, service-backed
 * `WorkflowActions` implementation together with `GoogleSheetsRepo` and this
 * worker at bootstrap time.
 *
 * This file is also the single source of truth for Google Sheets column
 * names: both `GoogleSheetsRepo` (reads/writes full domain records) and
 * `SheetSyncWorker` (reads/writes the narrower admin-workflow columns) import
 * the same constants so the header row never drifts between the two.
 */

// ---------------------------------------------------------------------------
// Workflow actions — the worker's only dependency on "the rest of the app"
// ---------------------------------------------------------------------------

export interface MintOutcome {
  txHash?: string;
  tokenId?: number;
  verificationUrl?: string;
  /** Mirrors domain MintStatus ("MINTED" | "FAILED" | ...). Never throws for
   * an ordinary chain failure — CONSTRAINTS.md: "No fake success: chain failure →
   * mintStatus: FAILED, retryable". Reserve thrown exceptions for genuinely
   * unexpected errors (bad wiring, programmer error). */
  mintStatus: string;
  error?: string;
}

/**
 * Actions the sheet sync worker drives. Implemented by the service layer and
 * injected at bootstrap — the worker never constructs or imports a concrete
 * implementation itself.
 */
export interface WorkflowActions {
  /** REGISTERED -> PAYMENT_VERIFIED. Illegal transitions should reject
   * (mirroring the REST API's 409); the worker catches and surfaces the
   * error on the row without crashing the poll loop. */
  recordPayment(registrationId: string, paymentRef: string, verifiedBy: string): Promise<void>;

  /**
   * PAYMENT_VERIFIED -> APPROVED, then auto-mint in the same logical
   * operation (CONSTRAINTS.md constraint #1: auto-mint on approval). Resolves
   * with `mintStatus: "FAILED"` + `error` on a chain failure rather than
   * throwing, so the row stays APPROVED and retryable (constraint: no fake
   * success).
   */
  approveAndMint(registrationId: string): Promise<MintOutcome>;

  /** Sends the pending certificate email. Email stays PENDING until this is
   * called explicitly (CONSTRAINTS.md constraint #2: mint never sends email). */
  dispatchEmail(registrationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sheet row access — the worker's only dependency on "the Google Sheet"
// ---------------------------------------------------------------------------

/**
 * Minimal read/write surface over a single spreadsheet row. Deliberately
 * narrower than google-spreadsheet's `GoogleSpreadsheetRow` so the worker has
 * zero compile-time dependency on the `google-spreadsheet` package —
 * `GoogleSheetsRepo` (or a test fake) adapts real rows to this shape.
 */
export interface SheetRowHandle {
  /** 1-indexed row number in the sheet; for logging/diagnostics only. */
  readonly rowNumber: number;
  get(column: string): string | undefined;
  set(column: string, value: string | number): void;
  /** Persists pending `set()` calls for this row. */
  save(): Promise<void>;
}

/** Supplies the current Registrations rows for a poll cycle. */
export interface RegistrationsSheetAccessor {
  fetchRegistrationRows(): Promise<SheetRowHandle[]>;
}

// ---------------------------------------------------------------------------
// SheetRow model — typed view over a raw Registrations row
// ---------------------------------------------------------------------------

/** Sheet-only transient marker, distinct from the domain `ParticipantState`.
 * Never persisted as a "real" workflow state — it only ever appears in the
 * Status cell for the duration of an in-flight mint, so a concurrent poll
 * (or a worker restart mid-mint) can recognize "already being handled" and
 * skip re-triggering. */
export const SHEET_ONLY_STATUS = {
  MINTING: "MINTING",
} as const;

/** Registrations `Status` column values the worker treats as triggers. These
 * intentionally reuse the domain `ParticipantState` string values (see
 * backend/src/domain/types.ts) — the sheet's Status column IS the
 * participant state as far as the admin is concerned. */
export const PARTICIPANT_STATUS = {
  REGISTERED: "REGISTERED",
  PAYMENT_VERIFIED: "PAYMENT_VERIFIED",
  APPROVED: "APPROVED",
  CERT_MINTED: "CERT_MINTED",
  EMAIL_SENT: "EMAIL_SENT",
} as const;

/** `EmailStatus` column values. `SEND` is a sheet-only imperative ("do it
 * now"), the rest mirror domain `EmailStatus`. */
export const EMAIL_STATUS = {
  NOT_APPLICABLE: "NOT_APPLICABLE",
  PENDING: "PENDING",
  SEND: "SEND",
  SENT: "SENT",
} as const;

/** Typed, camelCase view over a raw Registrations row — the "SheetRow
 * model". Both `GoogleSheetsRepo` (full CRUD) and `SheetSyncWorker` (a
 * narrow read of just the workflow-relevant cells) build one of these from a
 * `SheetRowHandle` instead of scattering raw `row.get("Status")`-style string
 * literals through the codebase. */
export interface RegistrationRowView {
  rowNumber: number;
  id: string;
  status: string;
  paymentRef?: string;
  paymentVerifiedBy?: string;
  emailStatus?: string;
}

export function readRegistrationRow(row: SheetRowHandle): RegistrationRowView {
  return {
    rowNumber: row.rowNumber,
    id: row.get(REGISTRATION_COLUMNS.ID) ?? "",
    status: row.get(REGISTRATION_COLUMNS.STATUS) ?? "",
    paymentRef: row.get(REGISTRATION_COLUMNS.PAYMENT_REF) || undefined,
    paymentVerifiedBy: row.get(REGISTRATION_COLUMNS.PAYMENT_VERIFIED_BY) || undefined,
    emailStatus: row.get(REGISTRATION_COLUMNS.EMAIL_STATUS) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Column-name constants — single source of truth for sheet header rows
// ---------------------------------------------------------------------------

export const TAB_NAMES = {
  WORKSHOPS: "Workshops",
  REGISTRATIONS: "Registrations",
  SUBMISSIONS: "Submissions",
  CERTIFICATES: "Certificates",
} as const;

export type TabName = (typeof TAB_NAMES)[keyof typeof TAB_NAMES];

export const WORKSHOP_COLUMNS = {
  ID: "ID",
  NAME: "Name",
  DATE: "Date",
  PHASE: "Phase",
} as const;

export const REGISTRATION_COLUMNS = {
  ID: "ID",
  WORKSHOP_ID: "WorkshopID",
  NAME: "Name",
  EMAIL: "Email",
  PHASE: "Phase",
  // --- admin-editable trigger cells ---
  STATUS: "Status",
  PAYMENT_REF: "PaymentRef",
  PAYMENT_VERIFIED_BY: "PaymentVerifiedBy",
  EMAIL_STATUS: "EmailStatus",
  // --- write-back cells (worker/service owned) ---
  MINT_STATUS: "MintStatus",
  MINT_ERROR: "MintError",
  CERT_ID: "CertID",
  TX_HASH: "TxHash",
  TOKEN_ID: "TokenID",
  VERIFICATION_LINK: "VerificationLink",
  ERROR: "Error",
  CREATED_AT: "CreatedAt",
  UPDATED_AT: "UpdatedAt",
} as const;

export const SUBMISSION_COLUMNS = {
  ID: "ID",
  REGISTRATION_ID: "RegistrationID",
  RECORDING_URL: "RecordingUrl",
  STATE: "State",
  // --- evaluation fields (Phase 2 metadata, CONSTRAINTS.md constraint #3) ---
  EVALUATOR_NAME: "EvaluatorName",
  MARKS: "Marks",
  GRADE: "Grade",
  PARAMETERS: "Parameters", // JSON-encoded Record<string, number>
  COMMENTS: "Comments",
  AUDIO_FEEDBACK_URL: "AudioFeedbackUrl",
  // --- write-back cells ---
  MINT_STATUS: "MintStatus",
  MINT_ERROR: "MintError",
  CERT_ID: "CertID",
  TX_HASH: "TxHash",
  TOKEN_ID: "TokenID",
  VERIFICATION_LINK: "VerificationLink",
  ERROR: "Error",
  CREATED_AT: "CreatedAt",
  UPDATED_AT: "UpdatedAt",
} as const;

export const CERTIFICATE_COLUMNS = {
  CERT_ID: "CertID",
  CERT_TYPE: "CertType",
  SOURCE_ID: "SourceID",
  TOKEN_ID: "TokenID",
  TX_HASH: "TxHash",
  METADATA: "Metadata", // JSON-encoded canonical metadata object
  METADATA_HASH: "MetadataHash",
  REVOKED: "Revoked",
  REVOKE_REASON: "RevokeReason",
  CREATED_AT: "CreatedAt",
} as const;

/** Full tab -> header-row schema, used by `ensureSheetStructure()` to create
 * missing tabs on first connect. Order matters (defines column order). */
export const SHEET_SCHEMA: Record<string, readonly string[]> = {
  [TAB_NAMES.WORKSHOPS]: Object.values(WORKSHOP_COLUMNS),
  [TAB_NAMES.REGISTRATIONS]: Object.values(REGISTRATION_COLUMNS),
  [TAB_NAMES.SUBMISSIONS]: Object.values(SUBMISSION_COLUMNS),
  [TAB_NAMES.CERTIFICATES]: Object.values(CERTIFICATE_COLUMNS),
};
