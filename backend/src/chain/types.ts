/**
 * Chain access interface. Implementations:
 *  - EthersChainClient (real; Ethers.js v6 against local Hardhat / Amoy)
 *  - FakeChainClient   (in-memory; used by API tests)
 *
 * ==== AGREED CONTRACT SURFACE (KalachainCertificate.sol) ====
 * The Solidity contract MUST expose exactly this external interface —
 * backend and contract are developed in parallel against this spec:
 *
 *   enum CertType { PARTICIPATION, EVALUATION }            // 0, 1
 *
 *   function mintCertificate(
 *     address to,
 *     uint8 certType,
 *     string calldata uri,
 *     bytes32 metadataHash,
 *     bytes32 recordId            // keccak256(certId) — double-mint guard
 *   ) external returns (uint256 tokenId);                  // MINTER_ROLE
 *
 *   function revoke(uint256 tokenId, string calldata reason) external; // ISSUER_ROLE
 *
 *   function mintedFor(bytes32 recordId) external view returns (uint256); // 0 = not minted
 *   function isRevoked(uint256 tokenId) external view returns (bool);
 *   function metadataHashOf(uint256 tokenId) external view returns (bytes32);
 *   function certTypeOf(uint256 tokenId) external view returns (uint8);
 *
 *   event CertificateMinted(uint256 indexed tokenId, bytes32 indexed recordId,
 *                           uint8 certType, bytes32 metadataHash);
 *   event CertificateRevoked(uint256 indexed tokenId, string reason);
 *
 * Soulbound: transfer/approve/setApprovalForAll revert; only mint (from=0)
 * is allowed in _update. Token IDs start at 1.
 * ============================================================
 */

export interface MintParams {
  to: string; // recipient address (custodial platform address in prototype)
  certType: 0 | 1; // 0 = PARTICIPATION, 1 = EVALUATION
  uri: string; // tokenURI → /api/metadata/:tokenId
  metadataHash: string; // 0x-prefixed keccak256
  recordId: string; // 0x-prefixed keccak256(certId)
}

export interface MintResult {
  tokenId: number;
  txHash: string;
  blockNumber: number;
}

export interface OnChainCertificate {
  exists: boolean;
  owner?: string;
  certType?: 0 | 1;
  metadataHash?: string;
  revoked?: boolean;
}

export interface MintedEvent {
  tokenId: number;
  recordId: string;
  certType: 0 | 1;
  metadataHash: string;
  txHash: string;
}

export interface IChainClient {
  /** Submits + waits for 1 confirmation. Throws on revert/network failure. */
  mintCertificate(params: MintParams): Promise<MintResult>;
  revoke(tokenId: number, reason: string): Promise<{ txHash: string }>;
  /** Returns tokenId minted for this recordId, or 0 if none. */
  mintedFor(recordId: string): Promise<number>;
  getCertificate(tokenId: number): Promise<OnChainCertificate>;
  /** All CertificateMinted events — used by startup reconciliation. */
  getMintedEvents(): Promise<MintedEvent[]>;
}
