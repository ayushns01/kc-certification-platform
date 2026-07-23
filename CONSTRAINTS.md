# Kalachain Certification Platform — Working Notes

Intern skill-assessment project: blockchain-enabled certification platform
(Solidity SBT on Polygon Amoy + Node.js/Express backend). Full context in
`docs/` — read [REQUIREMENTS.md](docs/REQUIREMENTS.md) and
[ARCHITECTURE.md](docs/ARCHITECTURE.md) before making changes.

## Hard assignment constraints (never violate)

1. **Auto-mint on approval** — marking a Phase-1 participant `APPROVED` must
   mint the certificate automatically in the same operation.
2. **Email stays PENDING after mint** — mint must never send email; delivery
   is a separate, manually triggered admin action.
3. Phase-2 metadata must include ALL of: participant name, event name,
   evaluator name, marks & grade, evaluation parameters, comments, audio
   feedback URL, transaction hash.
4. Stack is fixed: Solidity ERC-721/SBT, Polygon, Node.js, Ethers.js.
   Data layer: Google Sheets (primary, JD-aligned) + Mock JSON (default for
   reviewers) behind one repository interface, selected by `DATA_BACKEND`.
5. Deploy only to **Amoy testnet** pre-hire. Never mainnet, never spend the
   candidate's own funds on gas for an assessment.

## Conventions

- State transitions only via service methods; illegal transitions → `409`.
- No fake success: chain failure → `mintStatus: FAILED`, retryable, `202`.
- Every irreversible action (mint, email send) is idempotent-guarded.
- Secrets only via `.env`; never commit keys.
- Follow the milestone order in [docs/PLAN.md](docs/PLAN.md); keep tests green
  at each milestone boundary.
