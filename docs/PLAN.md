# Implementation Plan

Milestone-based; each milestone ends green (tests pass, demoable). Requirement
IDs refer to [REQUIREMENTS.md](REQUIREMENTS.md).

## M0 — Scaffolding
- [ ] `npm init`, **TypeScript**, Hardhat + Express + test tooling, ESLint/Prettier
- [ ] Repo layout per README, `.env.example`, `.gitignore` (env, artifacts, node_modules)
- [ ] **CI: GitHub Actions** running contract + API tests on every push
- [ ] `git init` + first commit

**Done when:** `npx hardhat test` and `npm run dev` both run (empty but green),
CI green on first push.

> **Why TypeScript:** the whole system is a state machine —
> `type State = 'REGISTERED' | 'PAYMENT_VERIFIED' | ...` makes illegal states
> unrepresentable at compile time. (JD lists JavaScript; TS compiles to it.)

## M1 — Smart Contract (X-1, X-2, X-4)
- [ ] `KalachainCertificate.sol`: soulbound ERC-721, `CertType`, `MINTER_ROLE`,
      `metadataHash` storage, `mintedFor` double-mint guard
- [ ] **`revoke(tokenId, reason)`** (issuer-only) + `CertificateRevoked` event;
      revoked state readable for verification
- [ ] Contract tests: mint happy path, transfer/approve revert, role
      enforcement, hash retrieval, double-mint revert, revoke + re-revoke revert
- [ ] Deploy scripts: local + Amoy; address written to config
- [ ] **Polygonscan source verification** wired into the Amoy deploy script

**Done when:** full contract test suite green on local Hardhat network.

## M2 — Phase 1 Backend Workflow (P1-1 … P1-5)
- [ ] Repositories (JSON file store) + seed workshops
- [ ] Registration endpoint with validation + duplicate guard
- [ ] Payment verification endpoint (admin)
- [ ] Approval endpoint → **auto-mint** via ChainClient; failure → `FAILED` + retry endpoint
- [ ] **Startup reconciliation**: read `CertificateMinted` events, heal records
      whose write-back was lost to a crash (chain = source of truth for mints)
- [ ] Metadata generation + canonical hashing + `/api/metadata/:tokenId`

**Done when:** API test walks REGISTERED → CERT_MINTED against local chain;
illegal transitions return 409.

## M3 — Verification + Email (P1-6, P1-7, P1-8)
- [ ] `/verify/:certId` JSON + minimal HTML page (VALID / TAMPERED / NOT FOUND)
- [ ] Tamper test: mutate stored metadata → verification flips to TAMPERED
- [ ] Email service (Nodemailer mock transport), `PENDING` after mint,
      manual dispatch endpoint (single + bulk), idempotent
- [ ] Email log persisted

**Done when:** demo shows mint → email still PENDING → manual dispatch → SENT,
and the tamper test passes.

## M4 — Phase 2 Evaluation Flow (P2-1 … P2-5)
- [ ] Phase-2 registration + performance submission (mock URLs)
- [ ] Evaluation draft endpoint (marks, parameters, comments, audio feedback URL)
- [ ] Deterministic grade function (marks → grade) + unit tests
- [ ] Finalize endpoint → graded cert mint with full mandated metadata
- [ ] Verification page renders evaluation details

**Done when:** API test walks submission → evaluation → finalize → verify with
all mandated metadata fields present.

## M4.5 — Google Sheets Integration (JD showcase)
- [ ] `GoogleSheetsRepo` implementing the same repository interface as `MockJsonRepo`
- [ ] `SheetSyncWorker`: poll → detect `Status` transitions → drive existing services
- [ ] Write-back: `TxHash`, `TokenId`, `VerificationLink`, `EmailStatus`, `Error`
- [ ] `MINTING` in-progress marker + overlap-safe idempotency test
- [ ] Template sheet + service-account setup guide in README

**Done when:** flipping a row to "Approved" in a real Google Sheet mints a
cert and the tx hash appears back in the row within one poll cycle.

## M5 — Polish & Delivery
- [ ] Amoy testnet deployment + one real minted cert of each type (tx links in README)
- [ ] README finalized: setup, demo script, screenshots/curl walkthrough
- [ ] Postman collection or `demo.http` file covering the full flow
- [ ] Final review pass: error messages, logging, dead code, secrets audit

**Done when:** a reviewer can clone, run, and verify both certificate types in
under 10 minutes following the README.

## Deliberate Senior-Level Signals

- Enforced state machines with honest failure states (no fake success)
- Soulbound + on-chain metadata hash anchoring (tamper-evidence, not just storage)
- **Certificate revocation lifecycle** (issued-in-error is a real event)
- Idempotency on every irreversible action (mint, email) + **crash-recovery
  reconciliation** from chain events
- Nonce-safe sequential tx queue
- Repository pattern → JSON store swappable for a real DB
- TypeScript state machine (illegal states unrepresentable), CI on every push,
  verified contract source on Polygonscan
- Tests at both layers; documented trade-offs for every mock/stand-in

## Deliberately NOT Built (restraint is a signal too)

Documented as future work instead of implemented: Redis/BullMQ job queues,
microservices, Docker/K8s, upgradeable proxies, subgraph indexing, real
payment gateways, wallet onboarding for participants. A 1-month prototype
earns trust by being complete and correct, not by cosplaying planet scale.
