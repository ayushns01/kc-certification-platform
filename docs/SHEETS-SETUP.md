# Google Sheets Setup

The Google Sheet is the **admin UI** for this platform (see
[ARCHITECTURE.md](ARCHITECTURE.md), "Google Sheets as the Admin Interface"):
an admin edits a few cells, `SheetSyncWorker` polls and detects the edit, and
drives the same service-layer state machine the REST API uses. This is the
JD-aligned production path (`DATA_BACKEND=sheets`); the mock JSON backend
(`DATA_BACKEND=json`, default) needs none of this and is what a reviewer gets
out of the box.

Everything below is one-time setup. Budget ~10 minutes.

## 1. Create a GCP service account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or reuse one) — call it e.g. `kalachain-certs`.
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **APIs & Services → Credentials** → **Create Credentials → Service
   account**. Name it e.g. `kalachain-sheets-sync`. No project role is
   needed — sheet access is granted by sharing the sheet directly (step 3
   below), not via IAM.
4. Open the new service account → **Keys** tab → **Add Key → Create new key
   → JSON**. This downloads a key file — treat it like a password.

## 2. Download the key file (never commit it)

Save the downloaded JSON somewhere under the repo root, e.g.:

```
./google-service-account.json
```

`.gitignore` already excludes `*service-account*.json`, so this is safe from
accidental commits as long as the filename contains `service-account`. Double
check with:

```
git check-ignore -v google-service-account.json
```

## 3. Create the sheet and share it with the service account

1. Create a new, blank Google Sheet (any name — e.g. "Kalachain
   Certification").
2. Copy its **Sheet ID** from the URL:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`
3. Open the key file downloaded in step 1 and copy the `client_email` field
   (looks like `kalachain-sheets-sync@<project>.iam.gserviceaccount.com`).
4. In the Sheet, click **Share** and add that email address with **Editor**
   access. Uncheck "Notify people" — it's a service account, not a person.

You do **not** need to create any tabs or header rows yourself —
`GoogleSheetsRepo.ensureSheetStructure()` creates the four tabs below (with
their header rows) automatically the first time the backend connects to a
blank sheet.

## 4. Configure environment variables

In `.env` (copy from `.env.example` if you haven't already):

```
DATA_BACKEND=sheets
GOOGLE_SHEET_ID=<the Sheet ID from step 3>
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./google-service-account.json
SHEET_POLL_INTERVAL_MS=15000
```

`SHEET_POLL_INTERVAL_MS` controls how often `SheetSyncWorker` polls the
Registrations tab. 15 seconds is a reasonable demo default — Sheets offers no
native push notification without Apps Script, so polling is the honest,
locally-demoable choice (see ARCHITECTURE.md).

Run the backend as usual (`npm run dev`) and, separately, the sync worker
(`npm run worker`) — they're two processes so the worker can be
restarted/redeployed independently of the API.

## 5. Column reference

Header names are defined once, in code, as the single source of truth:
`backend/src/workers/types.ts` (`WORKSHOP_COLUMNS`, `REGISTRATION_COLUMNS`,
`SUBMISSION_COLUMNS`, `CERTIFICATE_COLUMNS`). The tables below mirror those
constants — if you ever hand-edit a header, match this exactly (or better,
just let `ensureSheetStructure()` create it for you and don't rename columns).

Legend: **in** = admin-editable input, **out** = write-back (worker/service
owned — don't hand-edit these), **auto** = set once at creation and not
normally touched again.

### Workshops

| Column | Kind | Notes |
|---|---|---|
| ID | auto | Stable workshop identifier |
| Name | auto | |
| Date | auto | ISO date |
| Phase | auto | `1` or `2` |

### Registrations (the primary admin-driven tab)

| Column | Kind | Notes |
|---|---|---|
| ID | auto | Stable registration identifier |
| WorkshopID | auto | |
| Name | auto | Participant name |
| Email | auto | |
| Phase | auto | `1` or `2` |
| **Status** | **in** | See workflow below. Values: `REGISTERED`, `PAYMENT_VERIFIED`, `APPROVED`, `CERT_MINTED`, `EMAIL_SENT` (plus the transient `MINTING` the worker itself writes — never set this by hand) |
| **PaymentRef** | **in** | Fill in before flipping Status to `PAYMENT_VERIFIED` |
| **PaymentVerifiedBy** | **in** | Optional — who verified the payment; defaults to `sheet-admin` if left blank |
| **EmailStatus** | **in / out** | Worker sets `PENDING` after a successful mint; admin flips it to `SEND` to trigger dispatch; worker sets `SENT` when done |
| MintStatus | out | `NONE` / `MINTING` / `MINTED` / `FAILED` |
| MintError | out | Reserved for service-level detail (currently mirrored into `Error`) |
| CertID | out | Set once minted |
| TxHash | out | Transaction hash from the mint receipt |
| TokenID | out | On-chain token ID |
| VerificationLink | out | `/verify/:certId` URL |
| **Error** | out | Human-readable error from the last failed action on this row. Cleared on the next successful action |
| CreatedAt / UpdatedAt | auto | |

### Submissions (Phase 2)

| Column | Kind | Notes |
|---|---|---|
| ID | auto | |
| RegistrationID | auto | Links back to the Phase-2 registration |
| RecordingUrl | auto | |
| State | auto | `SUBMITTED` / `EVALUATED` / `FINALIZED` — driven by the API, not this sheet, in the current build |
| EvaluatorName | auto | Set by the evaluation endpoint |
| Marks | auto | 0–100 |
| Grade | auto | Derived server-side — never edit directly |
| Parameters | auto | JSON-encoded evaluation parameters, e.g. `{"rhythm":9,"expression":8}` |
| Comments | auto | |
| AudioFeedbackUrl | auto | |
| MintStatus / MintError / CertID / TxHash / TokenID / VerificationLink / Error | out | Same semantics as Registrations |
| CreatedAt / UpdatedAt | auto | |

### Certificates

| Column | Kind | Notes |
|---|---|---|
| CertID | auto | Public ID used in `/verify/:certId` |
| CertType | auto | `PARTICIPATION` or `EVALUATION` |
| SourceID | auto | RegistrationID (P1) or SubmissionID (P2) |
| TokenID | auto | |
| TxHash | auto | |
| Metadata | auto | JSON-encoded canonical metadata (the payload the on-chain hash covers) |
| MetadataHash | auto | `0x`-prefixed keccak256 |
| Revoked | auto | `true` / `false` |
| RevokeReason | auto | Set by the revoke action |
| CreatedAt | auto | |

## 6. The admin workflow — which cells to touch

This is the whole demo, cell by cell:

1. **Record payment**: on a `REGISTERED` row, fill in `PaymentRef` (and
   optionally `PaymentVerifiedBy`), then set `Status` to `PAYMENT_VERIFIED`.
2. **Approve** (auto-mints — CONSTRAINTS.md constraint: mint happens in the same
   logical operation as approval): set `Status` to `APPROVED`. Within one
   poll interval the worker flips it to the transient `MINTING` marker, mints
   the certificate, then writes back `TxHash`, `TokenID`,
   `VerificationLink`, sets `Status` to `CERT_MINTED`, and sets `EmailStatus`
   to `PENDING`. If the mint fails, `Status` reverts to `APPROVED` and
   `Error`/`MintStatus` explain why — safe to leave as-is (it will retry
   next poll) or investigate.
3. **Send the certificate email** (manual, on purpose — CONSTRAINTS.md constraint:
   mint never sends email): set `EmailStatus` to `SEND`. Next poll, the
   worker dispatches it and sets `EmailStatus` to `SENT`.
4. **Never hand-edit** `TxHash`, `TokenID`, `VerificationLink`, `CertID`,
   `MintStatus`, or `Error` — these are write-back only and will be
   overwritten by the next action anyway.
5. **Errors are visible, not swallowed**: a bad row (missing `PaymentRef`, a
   service rejecting an illegal transition, a chain RPC hiccup) writes a
   message to `Error` and leaves the row in a retryable state; it never
   crashes the worker or silently drops the row.

## 7. How the demo looks (5 steps)

1. Open the shared Sheet next to a terminal tailing the worker's logs
   (`npm run worker`).
2. Add a row to Registrations (or use the REST API to register a
   participant) with `Status=REGISTERED`.
3. Fill `PaymentRef=DEMO-001`, set `Status=PAYMENT_VERIFIED` — watch the log
   line confirming the payment was recorded.
4. Set `Status=APPROVED` — within `SHEET_POLL_INTERVAL_MS`, watch `Status`
   flash to `MINTING`, then land on `CERT_MINTED` with `TxHash` and
   `VerificationLink` populated. Open the Polygonscan link from `TxHash` to
   show the on-chain transaction.
5. Set `EmailStatus=SEND` — watch it flip to `SENT`, then open
   `VerificationLink` to show the public verification page reporting
   **VALID**.

## Troubleshooting

- **"tab not found" / repo throws on first read**: the backend hasn't
  connected yet, or the four tabs weren't created. Call
  `ensureSheetStructure()` (the backend does this automatically on first
  connect) or check the sheet was shared with the exact `client_email` from
  the key file.
- **Nothing happens after editing Status**: check the worker process is
  actually running (`npm run worker`) and `SHEET_POLL_INTERVAL_MS` hasn't
  been set absurdly high; check its logs for a per-row `Error`.
- **A row seems "stuck" on MINTING**: an unexpected (non-chain) error during
  the mint call. Check the worker logs and the row's `Error` cell — the
  worker resets `Status` back to `APPROVED` on any failure, chain-related or
  not, so it should never stay on `MINTING` past one poll cycle.
