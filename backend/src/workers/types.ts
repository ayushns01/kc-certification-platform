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
 * **Command/state separation (critical).** The admin edits exactly three
 * cells — `Action` (`VERIFY_PAYMENT` | `APPROVE`), `PaymentRef`, and
 * `EmailStatus=SEND`. `Status` is **write-back only**; it mirrors the
 * domain state the service layer owns. If the sheet's `Status` cell were
 * itself the trigger (as an earlier iteration of this worker did), flipping
 * it to `APPROVED` would pre-set the very state the service is about to
 * validate against, and every sheet-driven transition would self-collide
 * with a 409. Commands (`Action`) and state (`Status`) must live in
 * different columns — see docs/ARCHITECTURE.md for the full rationale.
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
  certId?: string;
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
   * throwing, so the record stays APPROVED (with a failed mint) and
   * retryable (constraint: no fake success).
   *
   * Retry contract: the worker fires this identically every time it reads
   * `Action=APPROVE` — whether the row is fresh (PAYMENT_VERIFIED) or
   * previously failed (already APPROVED with mintStatus=FAILED). The
   * adapter that implements this — wired by the controller, not by this
   * worker — is responsible for mapping "APPROVE on an already-APPROVED,
   * failed-mint row" to a mint retry rather than a 409. That mapping keeps
   * this a single, uniform verb from the worker's perspective.
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
  /** Persists pending `set()` calls for this row. This is the persistence
   * point the overlap guard depends on: it must be awaited before any
   * subsequent action call, so a fresh read from ANY source (a genuinely
   * different row object, a different process) observes the cleared
   * command / MINTING marker — not just an in-memory mutation visible only
   * through this specific object reference. */
  save(): Promise<void>;
}

/** Supplies the current Registrations rows for a poll cycle. Each call may
 * return brand-new row objects (as a real `getRows()` fetch does) — the
 * worker must never rely on row-object identity being stable across calls,
 * only on the underlying sheet's persisted cell values. */
export interface RegistrationsSheetAccessor {
  fetchRegistrationRows(): Promise<SheetRowHandle[]>;
}

// ---------------------------------------------------------------------------
// SheetRow model — typed view over a raw Registrations row
// ---------------------------------------------------------------------------

/** Registrations `Action` column values — the admin's command channel.
 * `NONE` (empty string) means "no pending command". This is the ONLY thing
 * that triggers `recordPayment`/`approveAndMint`; `Status` never does (see
 * file doc comment). */
export const REGISTRATION_ACTIONS = {
  NONE: "",
  VERIFY_PAYMENT: "VERIFY_PAYMENT",
  APPROVE: "APPROVE",
} as const;

/** Registrations `Status` column values — write-back only, mirrors the
 * domain `ParticipantState` (see backend/src/domain/types.ts). The admin
 * reads this column; only the service layer (and, defensively, this worker
 * after a completed action) writes it. Never treat a `Status` value as a
 * trigger — see file doc comment. */
export const PARTICIPANT_STATUS = {
  REGISTERED: "REGISTERED",
  PAYMENT_VERIFIED: "PAYMENT_VERIFIED",
  APPROVED: "APPROVED",
  CERT_MINTED: "CERT_MINTED",
  EMAIL_SENT: "EMAIL_SENT",
} as const;

/** Registrations `MintStatus` column values — mirrors domain `MintStatus`.
 * `MINTING` is a legitimate domain value (not a sheet-only hack): the
 * worker sets it as its overlap guard the instant it starts a mint attempt,
 * and later treats a row stuck on it with no `TxHash` and no pending
 * `Action` as a stranded/interrupted mint (see `SheetSyncWorker`). */
export const MINT_STATUS_VALUES = {
  NONE: "NONE",
  MINTING: "MINTING",
  MINTED: "MINTED",
  FAILED: "FAILED",
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
  /** Pending admin command — one of `REGISTRATION_ACTIONS`, or `""`. */
  action: string;
  /** Write-back domain state — informational only; never used as a trigger. */
  status: string;
  paymentRef?: string;
  paymentVerifiedBy?: string;
  emailStatus?: string;
}

export function readRegistrationRow(row: SheetRowHandle): RegistrationRowView {
  return {
    rowNumber: row.rowNumber,
    id: row.get(REGISTRATION_COLUMNS.ID) ?? "",
    action: row.get(REGISTRATION_COLUMNS.ACTION) ?? "",
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
  // --- admin command channel: the ONLY trigger for payment/approve ---
  ACTION: "Action",
  // --- write-back: mirrors domain state; admin reads, never edits ---
  STATUS: "Status",
  // --- admin-editable inputs ---
  PAYMENT_REF: "PaymentRef",
  PAYMENT_VERIFIED_BY: "PaymentVerifiedBy",
  // --- trigger + write-back: SEND is the command, PENDING/SENT are state ---
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
