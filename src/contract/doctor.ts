import * as z from "zod";
import type { CommandContract } from "./kind.js";

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  checks: z.array(DoctorCheck),
  ok: z.boolean(),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const DOCTOR_CONTRACTS = {
  doctor: { lines: [DoctorReport] },
} as const satisfies Record<string, CommandContract>;
