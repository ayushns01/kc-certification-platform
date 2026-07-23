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
2. [Architecture](docs/ARCHITECTURE.md) — system design, state machines, contract design, key decisions
3. [Implementation Plan](docs/PLAN.md) — milestones with acceptance criteria
4. [API Spec](docs/API.md) — endpoints, payloads, status codes

## Quick Start (once implemented)

```bash
npm install
npx hardhat test                 # contract tests
npx hardhat node                 # local chain
npm run deploy:local             # deploy contract locally
npm run dev                      # start backend
```

Deploy to Amoy: set `AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY` in `.env`, then `npm run deploy:amoy`.

## Future Work (deliberately out of scope)

- **W3C Verifiable Credentials companion** — for wallet-portable credentials
  interoperable with other institutions, each SBT could be paired with a
  signed VC (e.g., via Veramo), the on-chain token serving as the
  revocation/anchor layer. The current keccak256 metadata anchor already
  provides tamper-evidence within the assessment's mandated ERC-721 stack.
- IPFS metadata pinning, real payment gateway, participant wallet
  onboarding, job queues — documented trade-offs in
  [ARCHITECTURE.md](docs/ARCHITECTURE.md).
