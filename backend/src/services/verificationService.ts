/**
 * Public certificate verification (P1-6, P2-5). Looks up the stored
 * certificate record, reads the on-chain copy (revoked flag + metadataHash),
 * recomputes the canonical hash of the stored metadata, and compares:
 *
 *   NOT_FOUND — no certificate record for this certId, no tokenId on the
 *               record, or the token does not exist on-chain
 *   REVOKED   — issuer revoked the token (checked before tamper comparison)
 *   VALID     — recomputed hash matches the on-chain anchor
 *   TAMPERED  — recomputed hash does NOT match (stored metadata was altered)
 *
 * The comparison hash always comes from the CHAIN, never from the stored
 * record — comparing the stored hash with itself would let a dead RPC or a
 * misconfigured CONTRACT_ADDRESS masquerade as VALID. If the chain cannot
 * be queried, ChainUnavailableError propagates (→ 503): "can't tell" is an
 * honest error, not a verdict.
 */
import type { AppConfig } from "../config";
import type { IChainClient } from "../chain/types";
import type { CertType } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import { canonicalHash } from "../lib/canonicalHash";

export type Verdict = "VALID" | "TAMPERED" | "REVOKED" | "NOT_FOUND";

export interface VerificationResult {
  verdict: Verdict;
  certType?: CertType;
  tokenId?: number;
  txHash?: string;
  /** Real explorer link (amoy only); undefined on local networks. */
  explorerUrl?: string;
  /** Human-readable note when no public explorer exists for the network. */
  explorerNote?: string;
  onChainHash?: string;
  recomputedHash?: string;
  metadata?: Record<string, unknown>;
}

export class VerificationService {
  constructor(
    private readonly repo: IDataRepository,
    private readonly chainClient: IChainClient,
    private readonly config: AppConfig,
  ) {}

  async verify(certId: string): Promise<VerificationResult> {
    const cert = await this.repo.getCertificate(certId);
    if (!cert) return { verdict: "NOT_FOUND" };

    // A record without a tokenId has no on-chain anchor to verify against.
    if (cert.tokenId === undefined) {
      return { verdict: "NOT_FOUND", certType: cert.certType };
    }

    // May throw ChainUnavailableError → 503 via errorHandler. Deliberately
    // NOT caught here: an unreachable chain must never produce a verdict.
    const onChain = await this.chainClient.getCertificate(cert.tokenId);
    if (!onChain.exists) {
      return { verdict: "NOT_FOUND", certType: cert.certType, tokenId: cert.tokenId };
    }

    const recomputedHash = canonicalHash(cert.metadata);
    const onChainHash = onChain.metadataHash;
    const revoked = onChain.revoked ?? false;

    const base = {
      certType: cert.certType,
      tokenId: cert.tokenId,
      txHash: cert.txHash,
      ...this.buildExplorerFields(cert.txHash),
      onChainHash,
      recomputedHash,
      metadata: cert.metadata,
    };

    if (revoked) {
      return { verdict: "REVOKED", ...base };
    }
    return { verdict: onChainHash === recomputedHash ? "VALID" : "TAMPERED", ...base };
  }

  private buildExplorerFields(txHash?: string): Pick<VerificationResult, "explorerUrl" | "explorerNote"> {
    if (!txHash) return {};
    if (this.config.network === "amoy") {
      return { explorerUrl: `https://amoy.polygonscan.com/tx/${txHash}` };
    }
    return { explorerNote: `local network (no public explorer) — tx ${txHash}` };
  }
}
