import { Router } from "express";
import type { IDataRepository } from "../repositories/types";

export function workshopsRouter(repo: IDataRepository): Router {
  const router = Router();

  router.get("/api/workshops", async (_req, res, next) => {
    try {
      const workshops = await repo.listWorkshops();
      res.json(workshops);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
