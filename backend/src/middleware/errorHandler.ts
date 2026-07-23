/**
 * Central error -> HTTP mapping so every route gets a consistent JSON error
 * shape. Routes throw/next() domain errors instead of writing responses
 * directly.
 */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  ChainUnavailableError,
  ConflictError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from "../domain/errors";
import { logger } from "../lib/logger";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "ValidationError", details: err.issues });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof IllegalTransitionError) {
    res.status(409).json({ error: err.message, currentState: err.currentState });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ChainUnavailableError) {
    res.status(503).json({ error: "chain unavailable", details: err.message });
    return;
  }

  logger.error("unhandled_error", { err });
  res.status(500).json({ error: "InternalServerError" });
}
