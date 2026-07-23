/**
 * The service-backed WorkflowActions implementation — the bridge between
 * SheetSyncWorker (which only knows sheet commands) and the service-layer
 * state machine (which owns all transitions). Wired at bootstrap by
 * workers/main.ts; the worker itself never imports services directly.
 *
 * The one piece of mapping logic that lives here by design (see
 * workers/types.ts): `Action=APPROVE` is a single, uniform verb for the
 * admin, but the domain distinguishes a first approval
 * (PAYMENT_VERIFIED -> approve + auto-mint) from a retry after a failed
 * mint (APPROVED + mintStatus FAILED -> retry-mint, which heals from chain
 * state and can never double-mint). This adapter resolves which one the
 * row actually needs, so re-entering APPROVE after a failure "just works"
 * instead of 409ing.
 */
import type { ApprovalService } from "../services/approvalService";
import type { EmailService } from "../services/emailService";
import type { PaymentService } from "../services/paymentService";
import type { IDataRepository } from "../repositories/types";
import { NotFoundError } from "../domain/errors";
import type { MintOutcome as CoreMintOutcome } from "../services/mintingCore";
import type { MintOutcome, WorkflowActions } from "./types";

export interface WorkflowActionsDeps {
  repo: IDataRepository;
  paymentService: PaymentService;
  approvalService: ApprovalService;
  emailService: EmailService;
}

export function buildWorkflowActions(deps: WorkflowActionsDeps): WorkflowActions {
  return {
    async recordPayment(registrationId, paymentRef, verifiedBy) {
      await deps.paymentService.recordPayment(registrationId, { paymentRef, verifiedBy });
    },

    async approveAndMint(registrationId) {
      const reg = await deps.repo.getRegistration(registrationId);
      if (!reg) throw new NotFoundError(`Unknown registration: ${registrationId}`);

      let outcome: CoreMintOutcome;
      if (reg.state === "PAYMENT_VERIFIED") {
        outcome = await deps.approvalService.approve(registrationId);
      } else if (reg.state === "APPROVED") {
        // Failed/interrupted earlier mint — retryMint reuses the certId and
        // checks the on-chain mintedFor guard before minting again.
        outcome = await deps.approvalService.retryMint(registrationId);
      } else {
        // Anything else is a genuine illegal command (e.g. APPROVE on a
        // REGISTERED row) — throw so the worker records it in the Error
        // cell; the service-layer guard stays the single source of truth.
        throw new Error(
          `Cannot approve registration ${registrationId}: state is ${reg.state}, expected PAYMENT_VERIFIED (or APPROVED to retry a failed mint)`,
        );
      }
      return toWorkerOutcome(outcome);
    },

    async dispatchEmail(registrationId) {
      const summary = await deps.emailService.dispatch(registrationId);
      if (summary.failed > 0) {
        throw new Error("email send failed — status remains PENDING; re-enter SEND to retry");
      }
      if (summary.sent === 0) {
        // Skipped (not PENDING) — surface it rather than silently marking SENT.
        throw new Error("email was not in a dispatchable (PENDING) state; nothing sent");
      }
    },
  };
}

function toWorkerOutcome(outcome: CoreMintOutcome): MintOutcome {
  return {
    mintStatus: outcome.mintStatus,
    error: outcome.mintError,
    certId: outcome.certificate?.certId,
    txHash: outcome.certificate?.txHash,
    tokenId: outcome.certificate?.tokenId,
    verificationUrl: outcome.certificate?.verificationUrl,
  };
}
