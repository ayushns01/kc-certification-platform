import { Router } from "express";
import type { IDataRepository } from "../repositories/types";
import { NotFoundError } from "../domain/errors";
import { buildErc721Metadata } from "../services/metadataService";

/**
 * ERC-721 metadata endpoint (tokenURI target). The on-chain tokenURI is set
 * at mint time, but the numeric tokenId isn't known until the mint call
 * returns — so the URI committed on-chain actually encodes the certId, not
 * the tokenId (see services/mintingCore.ts). This route accepts either: a
 * numeric tokenId (the natural post-mint lookup) or a certId (what the
 * on-chain tokenURI actually points at), and serves the identical document
 * either way.
 */
export function metadataRouter(repo: IDataRepository): Router {
  const router = Router();

  router.get("/api/metadata/:tokenId", async (req, res, next) => {
    try {
      const { tokenId } = req.params;
      let cert = /^\d+$/.test(tokenId) ? await repo.getCertificateByTokenId(Number(tokenId)) : undefined;
      if (!cert) {
        cert = await repo.getCertificate(tokenId);
      }
      if (!cert) {
        throw new NotFoundError(`No certificate found for ${tokenId}`);
      }
      res.json(buildErc721Metadata(cert));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
