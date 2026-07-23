// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title KalachainCertificate — soulbound ERC-721 certificate for the
/// Kalachain certification platform.
/// @notice Each token represents either a Phase-1 participation certificate
/// (certType = 0) or a Phase-2 evaluation certificate (certType = 1) issued
/// to a participant. Certificates are non-transferable by design: a
/// certificate is a durable, personal attestation of an achievement, not a
/// tradable asset, so allowing transfer or approval would let it be
/// resold or reassigned to someone who did not earn it. Revocation never
/// burns the token — burning would erase the audit trail of "this person
/// was certified, then later had it revoked", which is itself a fact the
/// platform (and any future auditor/regulator) needs to be able to see.
/// Instead a token is marked revoked and stays permanently visible on-chain.
/// @dev Deployed once per environment; the backend (Ethers.js) is the sole
/// off-chain caller and is developed against the exact external interface
/// documented in backend/src/chain/types.ts.
contract KalachainCertificate is ERC721URIStorage, AccessControl {
    /// @notice Role permitted to mint new certificates.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role permitted to revoke previously minted certificates.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice Highest valid certType value (0 = PARTICIPATION, 1 = EVALUATION).
    uint8 public constant MAX_CERT_TYPE = 1;

    /// @notice Next tokenId to be assigned. Starts at 1 so that 0 can mean
    /// "no token" in `mintedFor`.
    uint256 private _nextTokenId = 1;

    /// @notice recordId (keccak256 of the off-chain certificate id) => tokenId.
    /// Used as an idempotency guard so the backend can safely retry a mint
    /// after an ambiguous failure (e.g. timeout) without risking a duplicate
    /// certificate for the same underlying record. 0 means "not yet minted".
    mapping(bytes32 => uint256) public mintedFor;

    /// @notice tokenId => keccak256 hash of the off-chain metadata JSON,
    /// committed on-chain so the metadata served by the backend can be
    /// verified against an immutable fingerprint.
    mapping(uint256 => bytes32) public metadataHashOf;

    /// @notice tokenId => certType (0 = PARTICIPATION, 1 = EVALUATION).
    mapping(uint256 => uint8) public certTypeOf;

    /// @notice tokenId => revoked flag. A revoked certificate is still owned
    /// and still visible (see contract-level NatSpec for rationale) but
    /// should be treated as invalid by any verifier.
    mapping(uint256 => bool) public isRevoked;

    /// @notice Emitted when a new certificate is minted.
    /// @param tokenId The newly minted token id.
    /// @param recordId keccak256 of the off-chain record id this token represents.
    /// @param certType 0 = PARTICIPATION, 1 = EVALUATION.
    /// @param metadataHash keccak256 of the off-chain metadata JSON at mint time.
    event CertificateMinted(uint256 indexed tokenId, bytes32 indexed recordId, uint8 certType, bytes32 metadataHash);

    /// @notice Emitted when an existing certificate is revoked.
    /// @param tokenId The token id being revoked.
    /// @param reason Free-text reason recorded for audit purposes.
    event CertificateRevoked(uint256 indexed tokenId, string reason);

    /// @notice A recordId has already been minted; thrown to keep minting
    /// idempotent under backend retries.
    error AlreadyMinted(bytes32 recordId);

    /// @notice Thrown by any transfer/approval entry point — certificates
    /// are soulbound and cannot change hands.
    error NonTransferable();

    /// @notice Thrown when `tokenId` does not correspond to a minted token.
    error CertificateDoesNotExist(uint256 tokenId);

    /// @notice Thrown when attempting to revoke a token that is already revoked.
    error AlreadyRevoked(uint256 tokenId);

    /// @notice Thrown when a mint argument fails basic validation.
    error InvalidMintParams();

    /// @notice Deploys the certificate collection and grants the deployer
    /// full admin control plus both operational roles, so the platform can
    /// mint and revoke immediately after deployment without a second setup
    /// transaction.
    constructor() ERC721("Kalachain Certificate", "KLC-CERT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(ISSUER_ROLE, msg.sender);
    }

    /// @notice Mints a new soulbound certificate to `to`.
    /// @dev Guarded against double-minting per `recordId` so that a backend
    /// retry after a timeout/ambiguous failure cannot create a duplicate
    /// certificate for the same underlying off-chain record.
    /// @param to Recipient address; must be non-zero.
    /// @param certType 0 = PARTICIPATION, 1 = EVALUATION.
    /// @param uri Token metadata URI (served by the backend's /api/metadata/:tokenId).
    /// @param metadataHash keccak256 of the off-chain metadata JSON; must be non-zero.
    /// @param recordId keccak256 of the off-chain certificate record id; used as the
    /// double-mint guard key.
    /// @return tokenId The newly minted token id (starts at 1, increments by 1).
    function mintCertificate(address to, uint8 certType, string calldata uri, bytes32 metadataHash, bytes32 recordId)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        if (to == address(0)) revert InvalidMintParams();
        if (certType > MAX_CERT_TYPE) revert InvalidMintParams();
        if (metadataHash == bytes32(0)) revert InvalidMintParams();
        if (mintedFor[recordId] != 0) revert AlreadyMinted(recordId);

        tokenId = _nextTokenId++;

        mintedFor[recordId] = tokenId;
        metadataHashOf[tokenId] = metadataHash;
        certTypeOf[tokenId] = certType;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        emit CertificateMinted(tokenId, recordId, certType, metadataHash);
    }

    /// @notice Revokes a certificate without burning it, preserving the
    /// on-chain audit trail (see contract-level NatSpec for rationale).
    /// @param tokenId The token to revoke.
    /// @param reason Free-text reason recorded on-chain for auditability.
    function revoke(uint256 tokenId, string calldata reason) external onlyRole(ISSUER_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert CertificateDoesNotExist(tokenId);
        if (isRevoked[tokenId]) revert AlreadyRevoked(tokenId);

        isRevoked[tokenId] = true;

        emit CertificateRevoked(tokenId, reason);
    }

    /// @notice Disabled — certificates are soulbound and cannot be approved
    /// for transfer by anyone, including the owner.
    function approve(address, uint256) public pure override(ERC721, IERC721) {
        revert NonTransferable();
    }

    /// @notice Disabled — certificates are soulbound and cannot be
    /// approved-for-all by anyone, including the owner.
    function setApprovalForAll(address, bool) public pure override(ERC721, IERC721) {
        revert NonTransferable();
    }

    /// @dev Core OpenZeppelin v5 transfer hook. Mint (from == address(0)) is
    /// the only state transition allowed; any transfer between two non-zero
    /// addresses reverts, enforcing the soulbound property at the lowest
    /// level so it cannot be bypassed via transferFrom/safeTransferFrom or
    /// any future override. Burns are also disabled since no code path
    /// calls `_update` with `to == address(0)` on an existing token.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    /// @dev Required override — resolves the diamond inheritance between
    /// ERC721URIStorage and AccessControl.
    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
