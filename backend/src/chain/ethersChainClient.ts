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
import { ChainUnavailableError } from "../domain/errors";

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
  // OZ v5 ERC721's standard "token doesn't exist" custom error. Declaring it
  // here lets ethers decode ownerOf() reverts for nonexistent tokens so we
  // can tell "no such token" apart from "couldn't reach the chain at all" —
  // see getCertificate()/isNonexistentTokenError() below.
  "error ERC721NonexistentToken(uint256 tokenId)",
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

  /**
   * ethers v6 decodes a revert against the declared ABI errors: a
   * CALL_EXCEPTION whose decoded name is ERC721NonexistentToken means the
   * chain answered and the token genuinely isn't there. Anything else (RPC
   * down, wrong CONTRACT_ADDRESS, undecodable revert) is "couldn't tell" —
   * which must NEVER be collapsed into "doesn't exist", or verification
   * would report a verdict it has no evidence for.
   */
  private isNonexistentTokenError(err: unknown): boolean {
    const e = err as { code?: string; revert?: { name?: string } | null };
    return e?.code === "CALL_EXCEPTION" && e?.revert?.name === "ERC721NonexistentToken";
  }

  async getCertificate(tokenId: number): Promise<OnChainCertificate> {
    let owner: string;
    try {
      owner = await this.contract.ownerOf(tokenId);
    } catch (err) {
      if (this.isNonexistentTokenError(err)) {
        return { exists: false };
      }
      throw new ChainUnavailableError(
        `Could not read token ${tokenId} on-chain: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
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
    } catch (err) {
      throw new ChainUnavailableError(
        `Token ${tokenId} exists but its certificate state could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
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
