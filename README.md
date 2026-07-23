# Kalachain — Blockchain-Enabled Certification Platform

A two-phase certification ecosystem for performing arts workshops. Issues **tamper-proof, instantly verifiable, non-transferable (soulbound) certificates** on Polygon.

- **Phase 1 — Participation Certificates:** registration → payment verification → approval → auto-mint → manual email dispatch.
- **Phase 2 — Evaluation Certificates:** performance submission → expert evaluation (marks, grade, parameters, comments, audio feedback) → graded certificate mint.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Smart contract | Solidity 0.8.x, ERC-721 **Soulbound** (OpenZeppelin) | Certificates must be non-transferable credentials, not tradable assets |
| Chain | Polygon **Amoy** testnet | Assignment requirement; Mumbai is deprecated |
| Contract tooling | Hardhat + Ethers.js v6 | Deterministic deploys, local mainnet-fork testing |
| Backend | Node.js + Express | Assignment requirement; thin API over a service layer |
| Data store | **Google Sheets (primary) + Mock JSON (fallback)** behind one repository interface | The production workflow is sheet-driven (admin marks a row Approved → auto-mint → tx hash written back); Mock JSON lets a reviewer run everything with zero Google setup |
| Sheet sync | Polling sync worker (Node.js) | Detects row status changes, drives the mint pipeline, writes back tx hash / token ID / verification link |
| Email | Nodemailer (Ethereal mock transport) | Real SMTP-shaped flow without external dependency |
| Metadata | Backend-served JSON + **on-chain keccak256 hash anchor** | Tamper-evidence: chain proves the metadata hasn't changed |

## Repository Layout

```
contracts/          Solidity (KalachainCertificate.sol — soulbound ERC-721)
scripts/            Hardhat deploy + utility scripts
test/               Contract tests (Hardhat) + API tests
backend/
  src/
    routes/         Express routes (thin)
    services/       Business logic (registration, approval, minting, evaluation, email)
    chain/          Ethers.js contract client, tx queue, receipt handling
    repositories/   Persistence behind one interface: GoogleSheetsRepo + MockJsonRepo
    workers/        Sheet sync worker (poll → detect transitions → mint → write-back)
    data/           Mock JSON stores
docs/               Requirements, architecture, plan, API spec
```

## Documentation

1. [Requirements](docs/REQUIREMENTS.md) — the assignment decomposed into testable requirements
2. [Walkthrough](docs/WALKTHROUGH.md) — step-by-step curl commands for Phase 1 + Phase 2 flows
3. [Google Sheets setup](docs/SHEETS-SETUP.md) — service account, template columns, admin workflow
4. [Architecture](docs/ARCHITECTURE.md) — system design, state machines, contract design, key decisions
5. [Implementation Plan](docs/PLAN.md) — milestones with acceptance criteria
6. [API Spec](docs/API.md) — endpoints, payloads, status codes

## Quick Start (10 minutes, zero external accounts)

```bash
npm install
npx hardhat test        # 14 contract tests
npm test                # 66 API/worker tests (mock chain + mock store)
```

Full live demo against a local chain (three terminals):

```bash
npx hardhat node                                  # T1: local chain
npm run deploy:local                              # T2: prints CONTRACT_ADDRESS
NETWORK=local AMOY_RPC_URL=http://127.0.0.1:8545 \
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
CONTRACT_ADDRESS=<from deploy> DATA_BACKEND=json \
ADMIN_API_KEY=demo-key npm run dev                # T3: API server
```

Then walk [demo.http](demo.http) top to bottom: register → verify payment →
**approve auto-mints on-chain** → `/verify` shows **VALID** via the on-chain
hash → email stays **PENDING** until manually dispatched → Phase-2
evaluation mints a graded certificate with every mandated metadata field.
(That private key is Hardhat's well-known dev account #0 — local use only.)

**Sheets mode** (the JD-aligned admin flow — flip a cell, get a mint):
follow [docs/SHEETS-SETUP.md](docs/SHEETS-SETUP.md), set
`DATA_BACKEND=sheets`, run `npm run dev` + `npm run worker`.

Deploy to Amoy: set `AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (a throwaway,
faucet-funded key) in `.env`, then `npm run deploy:amoy` — the script
auto-verifies on Polygonscan when `POLYGONSCAN_API_KEY` is set.

## Live Amoy Testnet Deployment

Deployed and exercised on Polygon Amoy (chainId 80002):

| | |
|---|---|
| **Contract** | [`0xB05278D719c03D48be45A2Fe16b800EE3C5efB03`](https://amoy.polygonscan.com/address/0xB05278D719c03D48be45A2Fe16b800EE3C5efB03) |
| **Deploy tx** | [`0x09694f…bdae2`](https://amoy.polygonscan.com/tx/0x09694f284c3d90ec870cfe5fd60fc4e471b5714a0f0cc74fd478d4539f1bdae2) |
| **Token 1 — Participation cert** (auto-minted on approval) | [`0x5904cf…8989f`](https://amoy.polygonscan.com/tx/0x5904cfcae279cef01a1cec763c688883e1fdd5cfda3f4477baed2fa17438989f) |
| **Token 2 — Graded evaluation cert** (marks 87 → grade A) | [`0x621ff4…16973`](https://amoy.polygonscan.com/tx/0x621ff446652bc6348e886f1eaf7b93686e8dd0670858c1829b45ddce85816973) |

Both tokens verify **VALID** through `/verify/:certId` (run the backend
locally against Amoy per `.env.example` — the on-chain hash anchors are
public; the verification page recomputes and compares them live).
Deployment record: [deployments/amoy.json](deployments/amoy.json).

> Gas note: Amoy RPC fee suggestions spike to 200+ gwei tips while
> validators accept ~30 gwei — `AMOY_GAS_PRICE_GWEI=30` caps writes so a
> single faucet grant covers deploy + mints (see `.env.example`).

## Design Decisions

**Sheets as command bus, not state store.** The `Action` column is write-once by the admin and consumed (cleared) by the worker before any side-effect fires. `Status` is write-back only — the worker never reads it to make decisions. This separates intent from observed state, making the sync loop idempotent and crash-safe: a restart re-reads only unconsumed commands.

**Chain is source of truth, not the database.** On startup, the backend replays all `CertificateMinted` events from the contract and heals any write-backs lost to a crash. A certificate that exists on-chain will always be reconciled into the local store — the database is a projection, not the record of truth.

**Double-mint guard lives on-chain.** `mintedFor(bytes32 recordId)` in the contract maps `keccak256(certId)` → tokenId and reverts on collision. This means even if the backend crashes mid-write and retries, the EVM prevents a second token from being issued — the guard cannot be bypassed by a race condition or a bug in the service layer.

**Sequential tx queue over parallelism.** A single promise queue serialises all write transactions through the one deployer key. Concurrent approvals are safe because each tx waits for the previous receipt before submitting — no nonce speculation, no dropped transactions under load.

**State machine enforced at the service boundary.** Every workflow transition is validated before execution; illegal transitions (approve before payment, double-evaluate) return `409` with the current state in the body. There are no silent no-ops.

## Future Work (deliberately out of scope)

- **W3C Verifiable Credentials companion** — for wallet-portable credentials
  interoperable with other institutions, each SBT could be paired with a
  signed VC (e.g., via Veramo), the on-chain token serving as the
  revocation/anchor layer. The current keccak256 metadata anchor already
  provides tamper-evidence within the assessment's mandated ERC-721 stack.
- IPFS metadata pinning, real payment gateway, participant wallet
  onboarding, job queues — documented trade-offs in
  [ARCHITECTURE.md](docs/ARCHITECTURE.md).
