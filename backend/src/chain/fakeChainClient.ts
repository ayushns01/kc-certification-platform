/**
 * In-memory IChainClient for tests. Sequential tokenIds (starting at 1, like
 * the real contract), fake-but-well-formed txHashes, a `mintedFor` guard
 * mirroring the contract's double-mint protection, and failure injection so
 * tests can exercise the chain-failure / retry / reconciliation paths
 * without a real network.
 */
import { randomBytes } from "crypto";
import type {
  IChainClient,
  MintedEvent,
  MintParams,
  MintResult,
  OnChainCertificate,
} from "./types";
import { ChainUnavailableError } from "../domain/errors";

function fakeTxHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export class FakeChainClient implements IChainClient {
  private nextTokenId = 1;
  private mintedByRecord = new Map<string, number>();
  private certsByToken = new Map<number, OnChainCertificate>();
  private events: MintedEvent[] = [];

  private failNextMint = false;
  private failAlwaysMint = false;
  private chainDown = false;

  /**
   * Test hook: simulate an unreachable chain (RPC down / bad address).
   * Mirrors EthersChainClient, which throws ChainUnavailableError in this
   * situation rather than answering — so tests can prove verification
   * returns 503, never a verdict, when the chain can't be queried.
   */
  setChainDown(down: boolean): void {
    this.chainDown = down;
  }

  /** Test hook: make the very next mintCertificate() call throw, then reset. */
  setFailNextMint(fail = true): void {
    this.failNextMint = fail;
  }

  /** Test hook: make every mintCertificate() call throw until turned off. */
  setFailAlwaysMint(fail: boolean): void {
    this.failAlwaysMint = fail;
  }

  async mintCertificate(params: MintParams): Promise<MintResult> {
    if (this.failAlwaysMint || this.failNextMint) {
      this.failNextMint = false;
      throw new Error("Simulated chain failure: mintCertificate reverted");
    }

    const existing = this.mintedByRecord.get(params.recordId);
    if (existing) {
      throw new Error(`AlreadyMinted: recordId ${params.recordId} already minted as token ${existing}`);
    }

    const tokenId = this.nextTokenId++;
    const txHash = fakeTxHash();

    this.mintedByRecord.set(params.recordId, tokenId);
    this.certsByToken.set(tokenId, {
      exists: true,
      owner: params.to,
      certType: params.certType,
      metadataHash: params.metadataHash,
      revoked: false,
    });
    this.events.push({
      tokenId,
      recordId: params.recordId,
      certType: params.certType,
      metadataHash: params.metadataHash,
      txHash,
    });

    return { tokenId, txHash, blockNumber: this.events.length };
  }

  async revoke(tokenId: number, reason: string): Promise<{ txHash: string }> {
    const cert = this.certsByToken.get(tokenId);
    if (!cert || !cert.exists) {
      throw new Error(`CertificateDoesNotExist: ${tokenId}`);
    }
    if (cert.revoked) {
      throw new Error(`AlreadyRevoked: ${tokenId}`);
    }
    cert.revoked = true;
    void reason;
    return { txHash: fakeTxHash() };
  }

  async mintedFor(recordId: string): Promise<number> {
    return this.mintedByRecord.get(recordId) ?? 0;
  }

  async getCertificate(tokenId: number): Promise<OnChainCertificate> {
    if (this.chainDown) {
      throw new ChainUnavailableError("Simulated chain outage: RPC unreachable");
    }
    return this.certsByToken.get(tokenId) ?? { exists: false };
  }

  async getMintedEvents(): Promise<MintedEvent[]> {
    return [...this.events];
  }
}
