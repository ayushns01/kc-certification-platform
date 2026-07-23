# Architecture

## System Overview

```
┌────────────┐     ┌──────────────────────────────┐     ┌─────────────────────┐
│  Admin /    │────▶│  Express API                 │────▶│  Polygon (Amoy /    │
│  Participant│     │  routes → services → repos   │     │  local Hardhat)     │
└────────────┘     │            │                  │     │  KalachainCert SBT  │
                   │            ▼                  │     └─────────────────────┘
                   │  JSON stores (participants,   │
                   │  workshops, evaluations,      │     ┌─────────────────────┐
                   │  certificates, email log)     │────▶│  Nodemailer         │
                   └──────────────────────────────┘     │  (mock transport)   │
                                                        └─────────────────────┘
```

Thin routes, all business logic in services, persistence behind repository
interfaces, chain access behind a single `ChainClient`. Every external effect
(chain, email) is isolated so it can be mocked in tests.

## Google Sheets as the Admin Interface (JD-aligned)

The target role's core deliverable is "a script linking a Google Sheet row
update to the blockchain minting process" — so the Sheet is treated as the
**admin UI**, not just a data store:

```
Google Sheet (admin UI)          Sync Worker                    Chain
┌───────────────────────┐ poll  ┌──────────────────────┐ mint  ┌─────────┐
│ Name │ Email │ Action │──────▶│ read Action commands  │──────▶│ SBT     │
│      write-back cols  │◀──────│ → service call →      │       └─────────┘
│ Status │ TxHash │ ... │       │ write back state/tx   │
│ EmailStatus │ Error   │       └──────────────────────┘
└───────────────────────┘
```

- **Command/state separation.** The admin edits exactly three cells:
  `Action` (`VERIFY_PAYMENT` | `APPROVE`), `PaymentRef`, and
  `EmailStatus=SEND`. `Status` is **write-back only** — it mirrors the
  domain state owned by the service layer. This is what keeps the promise
  "the sheet never bypasses transition validation": if the sheet's Status
  cell itself were the trigger, flipping it to `APPROVED` would *pre-set*
  the state the service is about to validate against, and every transition
  would self-collide. Commands and state must be separate columns.
- **`SheetSyncWorker`** polls (~15s; Sheets offers no native push without
  Apps Script — polling is the honest, locally demo-able choice), reads
  pending `Action` values, and calls the same service-layer state machine
  the REST API uses (via an injected `WorkflowActions` adapter, wired at
  bootstrap). The adapter resolves retries: `APPROVE` on a row that is
  already `APPROVED` with a failed mint maps to retry-mint, not a 409.
- **Write-back columns** (`Status`, `MintStatus`, `TxHash`, `TokenId`,
  `CertID`, `VerificationLink`, `EmailStatus`, `Error`) make the sheet
  self-documenting for admins.
- **Idempotency matters doubly here**: a poll cycle can overlap a slow tx.
  The worker synchronously clears `Action` and sets `MintStatus=MINTING`
  before any await, so an overlapping poll sees no pending command; the
  on-chain `mintedFor` guard backstops any race. A row stranded on
  `MINTING` with no `TxHash` (crash mid-mint) is detected on a later poll
  and marked `FAILED` + `Error="interrupted"` so the admin can re-trigger;
  startup reconciliation heals it instead if the mint actually landed
  on-chain.
- **Repository interface, two implementations**: `GoogleSheetsRepo`
  (service-account auth via `google-spreadsheet`) and `MockJsonRepo`
  (default — zero-setup for reviewers). Selected by `DATA_BACKEND` env var.
- **Email**: the JD wants auto-email, the assessment mandates manual
  post-workshop dispatch. One mechanism serves both: mint sets
  `EmailStatus=PENDING`; flipping the column to `SEND` (manually, or
  automatically when `EMAIL_MODE=auto`) triggers dispatch.

## State Machines

The core of the assignment is workflow correctness. Both phases are explicit
state machines; **every transition is validated server-side** and illegal
transitions return `409`.

### Phase 1 — Participant lifecycle

```
REGISTERED ──recordPayment──▶ PAYMENT_VERIFIED ──approve──▶ APPROVED
                                                              │ (automatic)
                                                              ▼
                                                        CERT_MINTED
                                                              │ (manual trigger)
                                                              ▼
                                                         EMAIL_SENT
```

- **Auto-mint:** `approve()` service method transitions to `APPROVED`, then
  immediately invokes `mintingService.mintParticipation()`. The two are one
  logical operation from the admin's perspective (single API call), but the
  state is persisted between them so a chain failure leaves an honest
  `APPROVED + mintStatus=FAILED` record that can be retried — never a fake
  "minted" state.
- **Email decoupling:** minting sets `emailStatus: PENDING`. A separate
  `POST /api/admin/emails/dispatch` sends pending emails. Idempotency: dispatch
  skips anything not in `PENDING`.

### Phase 2 — Evaluation lifecycle

```
REGISTERED(P2) ──submit──▶ SUBMITTED ──evaluate──▶ EVALUATED ──finalize──▶ CERT_MINTED
```

`evaluate` stores marks/parameters/comments as a draft; `finalize` locks the
evaluation and triggers the graded mint. Split into two steps so an evaluator
can revise before anything hits the chain (chain writes are irreversible).

## Smart Contract Design

**One contract, two certificate types** (`KalachainCertificate.sol`):

- ERC-721 via OpenZeppelin, with `_update` overridden to revert on any
  transfer where `from != address(0)` → **soulbound**. `approve` /
  `setApprovalForAll` also revert.
- `CertType { PARTICIPATION, EVALUATION }` stored per token.
- `mintCertificate(address to, uint8 certType, string uri, bytes32 metadataHash, bytes32 recordId)`
  restricted to `MINTER_ROLE` (AccessControl). Backend signer holds the role.
  `recordId` (keccak256 of the certificate's public ID) feeds the on-chain
  `mintedFor` double-mint guard.
- **`metadataHash`** = keccak256 of the canonicalized (sorted-key, no-whitespace)
  metadata JSON, stored on-chain. This is the tamper-evidence anchor: the
  off-chain JSON can be re-hashed and compared at verification time.
- `tokenURI` points at the backend metadata endpoint
  (`/api/metadata/:tokenId`). In production this would be IPFS; the hash
  anchor is what actually guarantees integrity either way — documented
  trade-off.
- **Revocation:** `revoke(tokenId, reason)` restricted to `ISSUER_ROLE`,
  emitting `CertificateRevoked`. Tokens are marked revoked (not burned — the
  audit trail survives) and verification returns `REVOKED`. Credentials
  issued in error or withdrawn for cause are a real lifecycle event; a
  certificate you can never undo is a flaw, not a feature.
- **Deliberately non-upgradeable.** No proxy. A certificate registry's
  immutability *is* its trust guarantee — an upgradeable issuer could
  silently rewrite history. Migration path if the contract must change:
  deploy v2, reissue, publish a deprecation notice on the verify page.
- Recipient wallets: participants don't have wallets in this prototype, so
  certificates mint to a **custodial platform address per participant record**
  (deterministic derivation), documented as a stand-in for real wallet
  onboarding. The certificate's authenticity comes from the contract + hash,
  not the holder address.

### Why one contract, not two

Both cert types share identity, soulbound mechanics, and verification. A
`certType` field + type-specific metadata is simpler to deploy, verify, and
index than two contracts with 95% shared code. Divergent future behavior can
be split later; premature separation costs more than it buys here.

## Metadata

Served from `/api/metadata/:tokenId` in ERC-721 JSON shape with an
`attributes` array, plus a `kalachain` block with the full domain payload:

- **Participation:** participant name, event name, event date, cert type, tx hash.
- **Evaluation:** participant name, event name, evaluator name, marks, grade,
  evaluation parameters, comments, audio feedback URL, tx hash.

Note on tx hash: the transaction hash can't be inside the hashed payload that
the same transaction anchors (circular). The canonical hash covers the domain
fields; the tx hash is attached to the stored record after the receipt and
displayed on the verification page from chain data.

## Verification Flow

`GET /verify/:certId` (public, human-readable page + JSON endpoint):

1. Look up certificate record → token ID.
2. Read token on-chain: exists? owner? stored `metadataHash`?
3. Recompute keccak256 over the stored metadata.
4. Verdict: **VALID** (hashes match) / **TAMPERED** (mismatch) /
   **NOT FOUND** (no token). Response includes tx hash + Polygonscan link.

## Chain Client

Single `ChainClient` wrapper around Ethers.js v6:

- One signer, **sequential tx submission** (simple in-process queue) to avoid
  nonce races when approvals arrive concurrently.
- Waits for 1 confirmation, persists `{txHash, tokenId, blockNumber}` from the
  receipt (token ID parsed from the `Transfer` event).
- Failures are caught and recorded as `mintStatus: FAILED` with the error;
  a retry endpoint re-attempts idempotently (guard: never mint twice for the
  same record — checked both in DB and by a `mintedFor(recordId)` mapping
  on-chain).
- **Reconciliation on startup:** the crash window (tx confirmed → process
  dies → write-back lost) leaves DB and chain disagreeing. On boot, a
  reconciliation pass reads `CertificateMinted` events from the contract and
  heals any record marked `FAILED`/`MINTING` that actually succeeded
  on-chain. Chain is the source of truth for mint facts; DB for workflow
  state.

## Error Handling & Edge Cases (senior checklist)

- Illegal state transitions → `409` with the current state in the body.
- Duplicate registration (email+workshop) → `409`.
- Chain down / out of gas → `APPROVED` + `mintStatus: FAILED`, retryable; API
  responds `202` describing partial success rather than lying with `200`.
- Double-mint protection: on-chain `mintedFor` mapping keyed by record ID hash.
- Email dispatch is idempotent; a send failure leaves `PENDING` (safe retry)
  and is logged.
- All input validated at the route boundary (zod-style schema validation).

## Configuration

`.env` (never committed; `.env.example` provided):

```
NETWORK=local | amoy | polygon   # polygon documented but not used pre-hire
AMOY_RPC_URL=
DEPLOYER_PRIVATE_KEY=
CONTRACT_ADDRESS=
DATA_BACKEND=json | sheets
GOOGLE_SHEET_ID=                     # sheets backend only
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=     # path to service-account key JSON
SHEET_POLL_INTERVAL_MS=15000
EMAIL_MODE=manual | auto         # assessment: manual; JD production: auto
ADMIN_API_KEY=                   # guards admin routes (stand-in for real auth)
BASE_URL=                        # used to build metadata + verification links
```

**Mainnet note:** the code is network-agnostic and mainnet-ready (gas
estimation, config-driven RPC/chain ID). The assessment deploys to **Amoy
testnet** — real-gas mainnet deployment is a post-hire, employer-funded step.
