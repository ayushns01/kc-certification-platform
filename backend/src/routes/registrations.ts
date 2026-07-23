import { Router } from "express";
import type { RegistrationService } from "../services/registrationService";

export function registrationsRouter(registrationService: RegistrationService): Router {
  const router = Router();

  router.post("/api/registrations", async (req, res, next) => {
    try {
      const registration = await registrationService.register(req.body);
      res.status(201).json({ id: registration.id, state: registration.state });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
