/**
 * Real IChainClient implementation using ethers.js v6 against a Hardhat
 * node or Polygon Amoy. Deliberately does NOT import Hardhat build
 * artifacts — the backend and contract are developed as decoupled builds
 * against the hand-written ABI below, matching the AGREED CONTRACT SURFACE
 * documented in ./types.ts.
 */
import { Contract, JsonRpcProvider, Wallet, type Log } from "ethers";
import type {
  IChainClient,
  MintedEvent,
  MintParams,
  MintResult,
  OnChainCertificate,
} from "./types";

const ABI = [
  "function mintCertificate(address to, uint8 certType, string uri, bytes32 metadataHash, bytes32 recordId) external returns (uint256)",
  "function revoke(uint256 tokenId, string reason) external",
  "function mintedFor(bytes32 recordId) external view returns (uint256)",
  "function isRevoked(uint256 tokenId) external view returns (bool)",
  "function metadataHashOf(uint256 tokenId) external view returns (bytes32)",
  "function certTypeOf(uint256 tokenId) external view returns (uint8)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "event CertificateMinted(uint256 indexed tokenId, bytes32 indexed recordId, uint8 certType, bytes32 metadataHash)",
  "event CertificateRevoked(uint256 indexed tokenId, string reason)",
];

export class EthersChainClient implements IChainClient {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly contract: Contract;

  /** In-process promise queue: serializes tx submission so nonces never race. */
  private queue: Promise<void> = Promise.resolve();

  constructor(rpcUrl: string, privateKey: string, contractAddress: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(privateKey, this.provider);
    this.contract = new Contract(contractAddress, ABI, this.wallet);
  }

  /** Runs `fn` only after every previously-queued call has settled (success or failure). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async mintCertificate(params: MintParams): Promise<MintResult> {
    return this.enqueue(async () => {
      const tx = await this.contract.mintCertificate(
        params.to,
        params.certType,
        params.uri,
        params.metadataHash,
        params.recordId,
      );
      const receipt = await tx.wait(1);
      if (!receipt) {
        throw new Error("mintCertificate transaction did not confirm");
      }

      let tokenId: number | undefined;
      for (const log of receipt.logs as Log[]) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed && parsed.name === "CertificateMinted") {
            tokenId = Number(parsed.args.tokenId);
            break;
          }
        } catch {
          // Not a log this ABI recognizes (e.g. an unrelated event) — skip.
        }
      }
      if (tokenId === undefined) {
        throw new Error("CertificateMinted event not found in mint transaction receipt");
      }

      return { tokenId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
    });
  }

  async revoke(tokenId: number, reason: string): Promise<{ txHash: string }> {
    return this.enqueue(async () => {
      const tx = await this.contract.revoke(tokenId, reason);
      const receipt = await tx.wait(1);
      if (!receipt) {
        throw new Error("revoke transaction did not confirm");
      }
      return { txHash: receipt.hash };
    });
  }

  async mintedFor(recordId: string): Promise<number> {
    const result: bigint = await this.contract.mintedFor(recordId);
    return Number(result);
  }

  async getCertificate(tokenId: number): Promise<OnChainCertificate> {
    try {
      const owner: string = await this.contract.ownerOf(tokenId);
      const [metadataHash, certType, revoked] = await Promise.all([
        this.contract.metadataHashOf(tokenId) as Promise<string>,
        this.contract.certTypeOf(tokenId) as Promise<bigint | number>,
        this.contract.isRevoked(tokenId) as Promise<boolean>,
      ]);
      return {
        exists: true,
        owner,
        certType: Number(certType) as 0 | 1,
        metadataHash,
        revoked,
      };
    } catch {
      return { exists: false };
    }
  }

  async getMintedEvents(): Promise<MintedEvent[]> {
    const filter = this.contract.filters.CertificateMinted();
    const logs = await this.contract.queryFilter(filter, 0, "latest");
    return logs.map((log) => {
      const parsed = this.contract.interface.parseLog(log);
      if (!parsed) {
        throw new Error("Failed to parse CertificateMinted event log");
      }
      return {
        tokenId: Number(parsed.args.tokenId),
        recordId: parsed.args.recordId as string,
        certType: Number(parsed.args.certType) as 0 | 1,
        metadataHash: parsed.args.metadataHash as string,
        txHash: log.transactionHash,
      };
    });
  }
}
