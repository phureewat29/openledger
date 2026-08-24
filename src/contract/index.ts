/**
 * Consumer entry point for `@aquartier/openledger/contract`: zod schemas are
 * the source of truth, `z.infer` gives the matching types, and
 * `COMMAND_CONTRACTS` maps every CLI leaf command to its wire shape.
 *
 * Every schema describes post-redaction output. `--no-redact` changes values,
 * never structure, so no schema may ever grow a redaction-conditional field.
 */
export * from "./version.js";
export * from "./exit.js";
export * from "./error.js";
export * from "./primitives.js";
export * from "./kind.js";
export * from "./commands.js";
export * from "./status.js";
export * from "./doctor.js";
export * from "./setup.js";
export * from "./config.js";
export * from "./ingest.js";
export * from "./files.js";
export * from "./transactions.js";
export * from "./accounts.js";
export * from "./merchants.js";
export * from "./questions.js";
export * from "./report.js";
export * from "./notes.js";
export * from "./datasets.js";
export * from "./open.js";
