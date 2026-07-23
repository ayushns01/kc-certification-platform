/**
 * Guards admin routes with a shared `x-api-key` header. A documented
 * stand-in for real auth/SSO (out of scope for this assessment — see
 * docs/REQUIREMENTS.md).
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../config";

export function adminAuth(config: AppConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("x-api-key");
    if (!key || key !== config.adminApiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
