import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { keccak256, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers";
import type { KalachainCertificate } from "../../typechain-types";

const PARTICIPATION = 0;
const EVALUATION = 1;

function recordId(seed: string): string {
  return keccak256(toUtf8Bytes(seed));
}

function metadataHash(seed: string): string {
  return keccak256(toUtf8Bytes(`metadata:${seed}`));
}

describe("KalachainCertificate", () => {
  async function deployFixture() {
    const [deployer, minter, issuer, recipient, other, stranger] = await ethers.getSigners();

    const factory = await ethers.getContractFactory("KalachainCertificate");
    const contract = (await factory.deploy()) as unknown as KalachainCertificate;
    await contract.waitForDeployment();

    // Grant separate accounts their roles so role-gating tests are meaningful
    // beyond just "deployer can do everything".
    const MINTER_ROLE = await contract.MINTER_ROLE();
    const ISSUER_ROLE = await contract.ISSUER_ROLE();
    await contract.connect(deployer).grantRole(MINTER_ROLE, minter.address);
    await contract.connect(deployer).grantRole(ISSUER_ROLE, issuer.address);

    return { contract, deployer, minter, issuer, recipient, other, stranger, MINTER_ROLE, ISSUER_ROLE };
  }

  describe("mint happy path", () => {
    it("mints sequential token ids starting at 1 and records all fields", async () => {
      const { contract, minter, recipient, other } = await loadFixture(deployFixture);

      const rec1 = recordId("cert-1");
      const hash1 = metadataHash("cert-1");
      const uri1 = "https://api.kalachain.example/api/metadata/1";

      // "0 = not minted" is the agreed semantic for mintedFor — assert it
      // holds before any mint has happened for this recordId.
      expect(await contract.mintedFor(rec1)).to.equal(0);

      const tx1 = await contract.connect(minter).mintCertificate(recipient.address, PARTICIPATION, uri1, hash1, rec1);
      await tx1.wait();

      expect(await contract.ownerOf(1)).to.equal(recipient.address);
      expect(await contract.tokenURI(1)).to.equal(uri1);
      expect(await contract.metadataHashOf(1)).to.equal(hash1);
      expect(await contract.certTypeOf(1)).to.equal(PARTICIPATION);
      expect(await contract.mintedFor(rec1)).to.equal(1);

      await expect(tx1)
        .to.emit(contract, "CertificateMinted")
        .withArgs(1, rec1, PARTICIPATION, hash1);

      // Second mint (different recordId) gets tokenId 2.
      const rec2 = recordId("cert-2");
      const hash2 = metadataHash("cert-2");
      const uri2 = "https://api.kalachain.example/api/metadata/2";

      const tx2 = await contract.connect(minter).mintCertificate(other.address, EVALUATION, uri2, hash2, rec2);
      await expect(tx2)
        .to.emit(contract, "CertificateMinted")
        .withArgs(2, rec2, EVALUATION, hash2);

      expect(await contract.ownerOf(2)).to.equal(other.address);
      expect(await contract.tokenURI(2)).to.equal(uri2);
      expect(await contract.metadataHashOf(2)).to.equal(hash2);
      expect(await contract.certTypeOf(2)).to.equal(EVALUATION);
      expect(await contract.mintedFor(rec2)).to.equal(2);
    });
  });

  describe("double-mint guard", () => {
    it("reverts AlreadyMinted when reusing a recordId", async () => {
      const { contract, minter, recipient, other } = await loadFixture(deployFixture);
      const rec = recordId("dup");

      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri-1", metadataHash("dup"), rec);

      await expect(
        contract.connect(minter).mintCertificate(other.address, EVALUATION, "uri-2", metadataHash("dup-2"), rec),
      )
        .to.be.revertedWithCustomError(contract, "AlreadyMinted")
        .withArgs(rec);
    });
  });

  describe("soulbound behaviour", () => {
    it("reverts on transferFrom and safeTransferFrom", async () => {
      const { contract, minter, recipient, other } = await loadFixture(deployFixture);
      const rec = recordId("soulbound-transfer");
      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("soulbound-transfer"), rec);

      await expect(
        contract.connect(recipient).transferFrom(recipient.address, other.address, 1),
      ).to.be.revertedWithCustomError(contract, "NonTransferable");

      await expect(
        contract
          .connect(recipient)
          ["safeTransferFrom(address,address,uint256)"](recipient.address, other.address, 1),
      ).to.be.revertedWithCustomError(contract, "NonTransferable");
    });

    it("reverts on approve and setApprovalForAll", async () => {
      const { contract, minter, recipient, other } = await loadFixture(deployFixture);
      const rec = recordId("soulbound-approve");
      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("soulbound-approve"), rec);

      await expect(contract.connect(recipient).approve(other.address, 1)).to.be.revertedWithCustomError(
        contract,
        "NonTransferable",
      );

      await expect(
        contract.connect(recipient).setApprovalForAll(other.address, true),
      ).to.be.revertedWithCustomError(contract, "NonTransferable");
    });
  });

  describe("access control", () => {
    it("reverts mint from a non-MINTER account", async () => {
      const { contract, stranger, recipient, MINTER_ROLE } = await loadFixture(deployFixture);
      await expect(
        contract
          .connect(stranger)
          .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("no-role"), recordId("no-role")),
      )
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, MINTER_ROLE);
    });

    it("reverts revoke from a non-ISSUER account", async () => {
      const { contract, minter, stranger, recipient, ISSUER_ROLE } = await loadFixture(deployFixture);
      const rec = recordId("revoke-role");
      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("revoke-role"), rec);

      await expect(contract.connect(stranger).revoke(1, "not allowed"))
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, ISSUER_ROLE);
    });
  });

  describe("revoke", () => {
    it("flips isRevoked and emits CertificateRevoked", async () => {
      const { contract, minter, issuer, recipient } = await loadFixture(deployFixture);
      const rec = recordId("revoke-happy");
      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("revoke-happy"), rec);

      expect(await contract.isRevoked(1)).to.equal(false);

      await expect(contract.connect(issuer).revoke(1, "fraudulent submission"))
        .to.emit(contract, "CertificateRevoked")
        .withArgs(1, "fraudulent submission");

      expect(await contract.isRevoked(1)).to.equal(true);
    });

    it("reverts on re-revoking an already-revoked token", async () => {
      const { contract, minter, issuer, recipient } = await loadFixture(deployFixture);
      const rec = recordId("re-revoke");
      await contract
        .connect(minter)
        .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("re-revoke"), rec);

      await contract.connect(issuer).revoke(1, "first reason");

      await expect(contract.connect(issuer).revoke(1, "second reason"))
        .to.be.revertedWithCustomError(contract, "AlreadyRevoked")
        .withArgs(1);
    });

    it("reverts revoking a token that was never minted", async () => {
      const { contract, issuer } = await loadFixture(deployFixture);
      await expect(contract.connect(issuer).revoke(999, "no such token"))
        .to.be.revertedWithCustomError(contract, "CertificateDoesNotExist")
        .withArgs(999);
    });

    it("does not burn on revoke — ownership and metadata survive intact (audit trail)", async () => {
      const { contract, minter, issuer, recipient } = await loadFixture(deployFixture);
      const rec = recordId("no-burn");
      const hash = metadataHash("no-burn");
      const uri = "https://api.kalachain.example/api/metadata/no-burn";

      await contract.connect(minter).mintCertificate(recipient.address, EVALUATION, uri, hash, rec);
      await contract.connect(issuer).revoke(1, "certificate revoked for cause");

      // The token still exists, is still owned by the original recipient,
      // and its metadata is untouched — revocation is a status flag, not a
      // burn, so the on-chain record of "this was issued" remains visible.
      expect(await contract.ownerOf(1)).to.equal(recipient.address);
      expect(await contract.tokenURI(1)).to.equal(uri);
      expect(await contract.metadataHashOf(1)).to.equal(hash);
      expect(await contract.certTypeOf(1)).to.equal(EVALUATION);
      expect(await contract.isRevoked(1)).to.equal(true);
    });
  });

  describe("input validation", () => {
    it("reverts minting to the zero address", async () => {
      const { contract, minter } = await loadFixture(deployFixture);
      await expect(
        contract
          .connect(minter)
          .mintCertificate(ZeroAddress, PARTICIPATION, "uri", metadataHash("zero-addr"), recordId("zero-addr")),
      ).to.be.revertedWithCustomError(contract, "InvalidMintParams");
    });

    it("reverts minting with certType > 1", async () => {
      const { contract, minter, recipient } = await loadFixture(deployFixture);
      await expect(
        contract
          .connect(minter)
          .mintCertificate(recipient.address, 2, "uri", metadataHash("bad-type"), recordId("bad-type")),
      ).to.be.revertedWithCustomError(contract, "InvalidMintParams");
    });

    it("reverts minting with a zero metadataHash", async () => {
      const { contract, minter, recipient } = await loadFixture(deployFixture);
      await expect(
        contract
          .connect(minter)
          .mintCertificate(recipient.address, PARTICIPATION, "uri", ZeroHash, recordId("zero-hash")),
      ).to.be.revertedWithCustomError(contract, "InvalidMintParams");
    });

    it("reverts minting with a zero recordId", async () => {
      const { contract, minter, recipient } = await loadFixture(deployFixture);
      await expect(
        contract
          .connect(minter)
          .mintCertificate(recipient.address, PARTICIPATION, "uri", metadataHash("zero-record"), ZeroHash),
      ).to.be.revertedWithCustomError(contract, "InvalidMintParams");
    });
  });
});
