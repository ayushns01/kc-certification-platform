/**
 * Deterministic custodial address derivation.
 *
 * Participants in this prototype don't hold their own wallets, so
 * certificates mint to a per-participant custodial address deterministically
 * derived from their email. This is a documented stand-in for real wallet
 * onboarding (see docs/ARCHITECTURE.md) — the certificate's authenticity
 * comes from the contract + on-chain metadata hash, not the holder address.
 * Deterministic derivation (vs. a randomly generated + stored address) means
 * the same participant always resolves to the same address with no extra
 * bookkeeping, and is trivially reproducible for auditing.
 */
import { getAddress, keccak256, toUtf8Bytes } from "ethers";

export function deriveCustodialAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = keccak256(toUtf8Bytes(normalized));
  // Take the low 20 bytes (40 hex chars) of the hash as the address, then
  // checksum it via ethers so it's a valid, well-formed EVM address.
  return getAddress(`0x${hash.slice(-40)}`);
}
