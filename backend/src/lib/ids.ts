/**
 * ID generation for the platform's public-facing record identifiers, plus
 * the on-chain `recordId` derivation used as the double-mint guard key.
 */
import { randomBytes } from "crypto";
import { keccak256, toUtf8Bytes } from "ethers";

function randomToken(bytes = 12): string {
  return randomBytes(bytes).toString("hex");
}

export function generateRegistrationId(): string {
  return `reg_${randomToken()}`;
}

export function generateSubmissionId(): string {
  return `sub_${randomToken()}`;
}

export function generateCertId(): string {
  return `cert_${randomToken()}`;
}

/** keccak256(certId) — used as the contract's `recordId` double-mint guard key. */
export function recordIdFor(certId: string): string {
  return keccak256(toUtf8Bytes(certId));
}
