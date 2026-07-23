import { Router } from "express";
import type { VerificationService } from "../services/verificationService";
import { renderVerifyHtml } from "../lib/verifyHtml";

export function verifyRouter(verificationService: VerificationService): Router {
  const router = Router();

  router.get("/verify/:certId", async (req, res, next) => {
    try {
      const result = await verificationService.verify(req.params.certId);
      if (req.accepts(["html", "json"]) === "json") {
        res.json(result);
        return;
      }
      res.type("html").send(renderVerifyHtml(result, req.params.certId));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
