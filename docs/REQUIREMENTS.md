# Requirements

Decomposition of the assignment into testable requirements. IDs are referenced from the [plan](PLAN.md) and tests.

## Phase 1 — Participation Certificate

| ID | Requirement | Notes |
|---|---|---|
| P1-1 | Participant can register for a workshop | Name, email, workshop ID; server-side validation; duplicate-registration guard (same email + workshop) |
| P1-2 | Admin can record **manual payment verification** | Payment reference + verifying admin captured; participant moves to `PAYMENT_VERIFIED` |
| P1-3 | Admin can **approve** a payment-verified participant | Approval only valid from `PAYMENT_VERIFIED` — enforced state machine |
| P1-4 | **Auto-mint on approval** (hard requirement) | Marking `APPROVED` triggers certificate minting automatically, no separate mint call by the admin |
| P1-5 | Certificate metadata generated at mint time | Participant name, workshop/event name, date, cert type, tx hash; keccak256 hash of canonical metadata anchored on-chain |
| P1-6 | Public **verification link** per certificate | `/verify/:certId` — resolves token on-chain, recomputes metadata hash, shows VALID / TAMPERED / NOT FOUND |
| P1-7 | **Email stays `PENDING` after mint** (hard requirement) | Mint must NOT send email. Email is a separate, manually triggered step post-workshop |
| P1-8 | Admin can manually trigger email delivery | Single participant + bulk "send all pending for workshop X"; idempotent (no double-send) |

## Phase 2 — Evaluation Certificate

| ID | Requirement | Notes |
|---|---|---|
| P2-1 | Performance **submission** with mock data | Audio/video recording URL (sample), linked to a Phase-2 registration |
| P2-2 | Evaluator records an **evaluation** | Marks, grade, per-parameter scores, written comments, audio feedback URL |
| P2-3 | Grade derivation is deterministic | Grade computed from marks by a single pure function (no free-typed grades) |
| P2-4 | Graded certificate minted after evaluation is finalized | Same auto-mint pattern: finalizing evaluation triggers mint |
| P2-5 | Evaluation certificate **verification link** | Same `/verify/:certId` surface; renders grade + evaluation details |

### P2 metadata must include (assignment-mandated fields)

- Participant Name
- Event Name
- Evaluator Name
- Marks & Grade
- Evaluation Parameters (name → score map)
- Comments
- Audio Feedback URL (sample URL)
- Transaction Hash

## Cross-Cutting

| ID | Requirement | Notes |
|---|---|---|
| X-1 | Certificates are **soulbound** (ERC-721/SBT) | Transfers and approvals revert; mint/burn only by authorized role |
| X-2 | Runs on **Polygon** (Amoy testnet) + local Hardhat | Config-driven network selection |
| X-3 | Mint failures don't corrupt state | Participant stays `APPROVED` with `mintStatus: FAILED`; retryable; no phantom "minted" records |
| X-4 | Metadata is tamper-evident | On-chain hash anchor; verification recomputes and compares |
| X-5 | Secrets never committed | `.env` + `.env.example`; deployer key only via env |
| X-6 | Tests | Contract: soulbound behavior, access control, mint, hash anchor, revocation. API: full state-machine happy path + illegal transitions |
| X-7 | Certificates are revocable by the issuer | `revoke(tokenId, reason)` + event; verification page shows `REVOKED`; audit trail preserved (no burn) |
| X-8 | Crash-safe mint bookkeeping | Startup reconciliation heals lost write-backs from on-chain `CertificateMinted` events |

## Explicitly Out of Scope (documented, not built)

- Real payment gateway (assignment says **manual** verification)
- Real LMS integration (mock submission URLs)
- Production auth/SSO — a simple admin API key guards admin routes; noted as a stand-in
- Mainnet deployment
