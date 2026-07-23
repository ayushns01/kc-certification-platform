import { Router } from "express";
import type { SubmissionService } from "../services/submissionService";

export function submissionsRouter(submissionService: SubmissionService): Router {
  const router = Router();

  router.post("/api/submissions", async (req, res, next) => {
    try {
      const submission = await submissionService.createSubmission(req.body);
      res.status(201).json({ id: submission.id, state: submission.state });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
