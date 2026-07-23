import { Router, type Response } from "express";
import type { AppConfig } from "../config";
import type { IDataRepository } from "../repositories/types";
import type { PaymentService } from "../services/paymentService";
import type { ApprovalService } from "../services/approvalService";
import type { SubmissionService } from "../services/submissionService";
import type { EmailService } from "../services/emailService";
import type { MintOutcome } from "../services/mintingCore";
import { adminAuth } from "../middleware/adminAuth";
import { NotFoundError } from "../domain/errors";

interface AdminDeps {
  repo: IDataRepository;
  config: AppConfig;
  paymentService: PaymentService;
  approvalService: ApprovalService;
  submissionService: SubmissionService;
  emailService: EmailService;
}

function sendMintOutcome(res: Response, state: string, outcome: MintOutcome): void {
  if (outcome.status === 200) {
    res.status(200).json({ state, certificate: outcome.certificate });
    return;
  }
  res.status(202).json({ state, mintStatus: outcome.mintStatus, retryUrl: outcome.retryUrl });
}

export function adminRouter(deps: AdminDeps): Router {
  const router = Router();
  router.use(adminAuth(deps.config));

  router.post("/registrations/:id/payment", async (req, res, next) => {
    try {
      const reg = await deps.paymentService.recordPayment(req.params.id, req.body);
      res.status(200).json({ state: reg.state });
    } catch (err) {
      next(err);
    }
  });

  router.post("/registrations/:id/approve", async (req, res, next) => {
    try {
      const outcome = await deps.approvalService.approve(req.params.id);
      const reg = await deps.repo.getRegistration(req.params.id);
      if (!reg) throw new NotFoundError(`Unknown registration: ${req.params.id}`);
      sendMintOutcome(res, reg.state, outcome);
    } catch (err) {
      next(err);
    }
  });

  router.post("/registrations/:id/retry-mint", async (req, res, next) => {
    try {
      const outcome = await deps.approvalService.retryMint(req.params.id);
      const reg = await deps.repo.getRegistration(req.params.id);
      if (!reg) throw new NotFoundError(`Unknown registration: ${req.params.id}`);
      sendMintOutcome(res, reg.state, outcome);
    } catch (err) {
      next(err);
    }
  });

  router.post("/emails/dispatch", async (req, res, next) => {
    try {
      const { registrationId, workshopId } = req.body ?? {};
      if (registrationId) {
        const summary = await deps.emailService.dispatch(registrationId);
        res.status(200).json(summary);
        return;
      }
      if (workshopId) {
        const summary = await deps.emailService.dispatchAll(workshopId);
        res.status(200).json(summary);
        return;
      }
      res.status(400).json({ error: "ValidationError", details: "registrationId or workshopId is required" });
    } catch (err) {
      next(err);
    }
  });

  router.put("/submissions/:id/evaluation", async (req, res, next) => {
    try {
      const sub = await deps.submissionService.upsertEvaluation(req.params.id, req.body);
      res.status(200).json({ state: sub.state, evaluation: sub.evaluation });
    } catch (err) {
      next(err);
    }
  });

  router.post("/submissions/:id/finalize", async (req, res, next) => {
    try {
      const outcome = await deps.submissionService.finalize(req.params.id);
      const sub = await deps.repo.getSubmission(req.params.id);
      if (!sub) throw new NotFoundError(`Unknown submission: ${req.params.id}`);
      sendMintOutcome(res, sub.state, outcome);
    } catch (err) {
      next(err);
    }
  });

  router.post("/submissions/:id/retry-mint", async (req, res, next) => {
    try {
      const outcome = await deps.submissionService.retryFinalizeMint(req.params.id);
      const sub = await deps.repo.getSubmission(req.params.id);
      if (!sub) throw new NotFoundError(`Unknown submission: ${req.params.id}`);
      sendMintOutcome(res, sub.state, outcome);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
