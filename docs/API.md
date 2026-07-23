# API Specification

Base URL: `http://localhost:3000`. Admin routes require `x-api-key` header.
Errors: `400` validation, `401` bad key, `404` unknown resource, `409` illegal
state transition (body includes `currentState`), `202` accepted-with-pending-
chain-work, `500` unexpected.

## Phase 1

### `POST /api/registrations`
Register a participant (P1-1).
```json
{ "name": "Asha Rao", "email": "asha@example.com", "workshopId": "ws-001" }
```
`201` → `{ "id": "reg_...", "state": "REGISTERED" }` · `409` duplicate email+workshop

### `POST /api/admin/registrations/:id/payment` 🔒
Record manual payment verification (P1-2).
```json
{ "paymentRef": "UPI-8842", "verifiedBy": "admin@kalachain.org" }
```
`200` → `{ "state": "PAYMENT_VERIFIED" }` · `409` if not `REGISTERED`

### `POST /api/admin/registrations/:id/approve` 🔒
Approve → **auto-mints** participation certificate (P1-3, P1-4).

`200` → 
```json
{
  "state": "CERT_MINTED",
  "certificate": {
    "certId": "cert_...", "tokenId": 1,
    "txHash": "0x...", "verificationUrl": "/verify/cert_...",
    "emailStatus": "PENDING"
  }
}
```
`202` → `{ "state": "APPROVED", "mintStatus": "FAILED", "retryUrl": "..." }` when the chain call fails
`409` if not `PAYMENT_VERIFIED`

### `POST /api/admin/registrations/:id/retry-mint` 🔒
Retry a failed mint. Idempotent — `409` if already minted.

### `POST /api/admin/emails/dispatch` 🔒
Manual email trigger (P1-8). Body: `{ "registrationId": "..." }` **or**
`{ "workshopId": "ws-001" }` (bulk, all `PENDING`).

`200` → `{ "sent": 12, "skipped": 3 }` — idempotent, skips non-`PENDING`.

## Phase 2

### `POST /api/registrations` (with `"phase": 2`)
Phase-2 registration (P2-1 precondition).

### `POST /api/submissions`
Performance submission, mock data (P2-1).
```json
{ "registrationId": "reg_...", "recordingUrl": "https://lms.example.com/rec/771.mp4" }
```

### `PUT /api/admin/submissions/:id/evaluation` 🔒
Create/update evaluation **draft** (P2-2). Repeatable until finalized.
```json
{
  "evaluatorName": "Guru Meenakshi",
  "marks": 87,
  "parameters": { "rhythm": 9, "expression": 8, "technique": 9, "repertoire": 8 },
  "comments": "Strong laya control; abhinaya can deepen.",
  "audioFeedbackUrl": "https://cdn.example.com/feedback/771.mp3"
}
```
Grade is **derived server-side** from marks (P2-3), never client-supplied.

### `POST /api/admin/submissions/:id/finalize` 🔒
Lock evaluation + mint graded certificate (P2-4). Same `200/202/409` contract
as approve. `409` if already finalized.

### `POST /api/admin/submissions/:id/retry-mint` 🔒
Retry a failed Phase-2 mint (mirrors the Phase-1 retry contract, including
the chain-heal path). Idempotent — `409` if already minted.

## Shared

### `GET /api/metadata/:tokenIdOrCertId`
ERC-721 metadata JSON (`tokenURI` target). Includes `attributes` +
full `kalachain` domain block (all mandated fields for evaluation certs).
Accepts a numeric token ID **or** a `cert_…` ID — the on-chain `tokenURI`
must be committed before the token ID exists, so the chain points at the
certId form; both resolve to the identical document.

### `GET /verify/:certId`
Public verification (P1-6, P2-5). HTML page; `Accept: application/json` for:
```json
{
  "verdict": "VALID | TAMPERED | REVOKED | NOT_FOUND",
  "certType": "PARTICIPATION | EVALUATION",
  "tokenId": 1,
  "txHash": "0x...",
  "explorerUrl": "https://amoy.polygonscan.com/tx/0x...",
  "onChainHash": "0x...",
  "recomputedHash": "0x...",
  "metadata": { }
}
```

### `GET /api/workshops`
List seeded workshops.
