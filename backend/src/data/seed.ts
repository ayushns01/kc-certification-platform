/**
 * First-run seed data for MockJsonRepo. One Phase-1 (participation) workshop
 * and one Phase-2 (evaluation) workshop, so both certificate flows are
 * demoable out of the box with zero setup.
 */
import type { Workshop } from "../domain/types";

export const seedWorkshops: Workshop[] = [
  {
    id: "ws-101",
    name: "Bharatanatyam Foundations Workshop",
    date: "2026-08-15T00:00:00.000Z",
    phase: 1,
  },
  {
    id: "ws-201",
    name: "Carnatic Vocal Evaluation Intensive",
    date: "2026-09-05T00:00:00.000Z",
    phase: 2,
  },
];
