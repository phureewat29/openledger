import { describe, it, expectTypeOf } from "vitest";
import * as z from "zod";
import { str, int, json } from "../lib/validate.js";
import type { UpdateAccountMetadataPatch } from "./queries.js";

describe("z.infer: real call-site type", () => {
  it("a representative patch spec infers a type assignable to UpdateAccountMetadataPatch", () => {
    const patchSpec = z.object({
      due_day: int().optional().nullable(),
      statement_day: int().optional().nullable(),
      account_number_masked: str().optional().nullable(),
      bank_name: str().optional().nullable(),
      metadata: json(z.record(z.string(), z.unknown()), "a JSON object").optional(),
    });
    expectTypeOf<z.infer<typeof patchSpec>>().toMatchTypeOf<UpdateAccountMetadataPatch>();
  });
});
