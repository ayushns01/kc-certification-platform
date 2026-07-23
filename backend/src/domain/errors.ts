/**
 * Domain-level error types. Routes never construct HTTP error bodies
 * directly — services throw one of these and middleware/errorHandler.ts
 * maps them onto the response consistently.
 */

/** Thrown when a state-machine transition is attempted from an invalid state. Maps to 409. */
export class IllegalTransitionError extends Error {
  readonly currentState: string;

  constructor(currentState: string, message?: string) {
    super(message ?? `Illegal transition: current state is ${currentState}`);
    this.name = "IllegalTransitionError";
    this.currentState = currentState;
  }
}

/** Thrown for conflicts that aren't a state-machine transition (e.g. duplicate registration). Maps to 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Thrown when a referenced record does not exist. Maps to 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Thrown for request-shape problems not caught by zod (e.g. cross-field business rules). Maps to 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when the chain cannot be reached/queried at all (RPC down, bad
 * CONTRACT_ADDRESS, etc.) — distinct from a token genuinely not existing
 * on-chain. Verification must never treat "can't tell" as "valid"; this
 * maps to 503 so a network blip can never be misread as a tamper-check
 * pass. See services/verificationService.ts.
 */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnavailableError";
  }
}
