/**
 * Public certificate verification (P1-6, P2-5). Looks up the stored
 * certificate record, reads the on-chain copy (revoked flag + metadataHash),
 * recomputes the canonical hash of the stored metadata, and compares:
 *
 *   NOT_FOUND — no certificate record for this certId
 *   REVOKED   — issuer revoked the token (checked before tamper comparison)
 *   VALID     — recomputed hash matches the on-chain anchor
 *   TAMPERED  — recomputed hash does NOT match (stored metadata was altered)
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
  explorerUrl?: string;
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

    const recomputedHash = canonicalHash(cert.metadata);
    let onChainHash = cert.metadataHash;
    let revoked = cert.revoked;

    if (cert.tokenId !== undefined) {
      const onChain = await this.chainClient.getCertificate(cert.tokenId);
      if (onChain.exists) {
        onChainHash = onChain.metadataHash ?? cert.metadataHash;
        revoked = onChain.revoked ?? cert.revoked;
      }
    }

    const explorerUrl = this.buildExplorerUrl(cert.txHash);

    if (revoked) {
      return {
        verdict: "REVOKED",
        certType: cert.certType,
        tokenId: cert.tokenId,
        txHash: cert.txHash,
        explorerUrl,
        onChainHash,
        recomputedHash,
        metadata: cert.metadata,
      };
    }

    const verdict: Verdict = onChainHash === recomputedHash ? "VALID" : "TAMPERED";
    return {
      verdict,
      certType: cert.certType,
      tokenId: cert.tokenId,
      txHash: cert.txHash,
      explorerUrl,
      onChainHash,
      recomputedHash,
      metadata: cert.metadata,
    };
  }

  private buildExplorerUrl(txHash?: string): string | undefined {
    if (!txHash) return undefined;
    if (this.config.network === "amoy") return `https://amoy.polygonscan.com/tx/${txHash}`;
    return `local network (no public explorer) — tx ${txHash}`;
  }
}
