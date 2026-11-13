import type { CommandContract } from "./kind.js";
import { STATUS_CONTRACTS } from "./status.js";
import { DOCTOR_CONTRACTS } from "./doctor.js";
import { SETUP_CONTRACTS } from "./setup.js";
import { CONFIG_CONTRACTS } from "./config.js";
import { INGEST_CONTRACTS } from "./ingest.js";
import { FILES_CONTRACTS } from "./files.js";
import { TRANSACTIONS_CONTRACTS } from "./transactions.js";
import { ACCOUNTS_CONTRACTS } from "./accounts.js";
import { MERCHANTS_CONTRACTS } from "./merchants.js";
import { QUESTIONS_CONTRACTS } from "./questions.js";
import { REPORT_CONTRACTS } from "./report.js";
import { NOTES_CONTRACTS } from "./notes.js";
import { DATASETS_CONTRACTS } from "./datasets.js";
import { OPEN_CONTRACTS } from "./open.js";

/** One entry per leaf command path, keyed as `oled <path>` without the prefix; coverage.test.ts fails on any mismatch with the commander tree. */
export const COMMAND_CONTRACTS = {
  ...STATUS_CONTRACTS,
  ...DOCTOR_CONTRACTS,
  ...SETUP_CONTRACTS,
  ...CONFIG_CONTRACTS,
  ...INGEST_CONTRACTS,
  ...FILES_CONTRACTS,
  ...TRANSACTIONS_CONTRACTS,
  ...ACCOUNTS_CONTRACTS,
  ...MERCHANTS_CONTRACTS,
  ...QUESTIONS_CONTRACTS,
  ...REPORT_CONTRACTS,
  ...NOTES_CONTRACTS,
  ...DATASETS_CONTRACTS,
  ...OPEN_CONTRACTS,
} as const satisfies Record<string, CommandContract>;
