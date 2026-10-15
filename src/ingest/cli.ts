import type { Command } from "commander";
import type Database from "libsql";
import {
  EXIT,
  type Column,
  type ExitCode,
  currentMode,
  emit,
  emitList,
  emitObject,
  emitSummary,
  fail,
  runAction,
} from "../cli/output.js";
import { openDb } from "../cli/db.js";
import { requireConfig } from "../config/cli.js";
import { commitIngest } from "./commit-cli.js";
import { markFileFailed, markFileIngested } from "../files/queries.js";
import { getAccountBalanceMinor } from "../accounts/balances.js";
import { DIRECTION_RULES } from "./commit.js";
import { formatFixed } from "../cli/currency.js";
import { currencyOf } from "../lib/ids.js";
import { fromMinorUnits, toMinorUnits } from "../lib/money.js";
import { parseInput, num, str } from "../lib/validate.js";
import * as z from "zod";
// source.ts avoids mupdf/libsql, so this import is safe on the startup path.
import { MAX_SOURCE_BYTES, SUPPORTED_EXTS } from "../extract/source.js";
import { cleanCache } from "../files/files.js";
import { requireFile } from "../cli/files.js";
// prepare.ts keeps mupdf/libsql lazy internally (getMupdf() in extract/pdf.ts), so this import is safe on the startup path.
import {
  discoverFiles,
  prepareFile,
  type IngestEntry,
  type PrepareFailure,
  type PrepareSuccess,
} from "./prepare.js";
import type {
  IngestDoneResult,
  IngestFailResult,
  IngestFile,
  IngestListSummary,
  PrepareResult,
  Reconciliation,
} from "../contract/ingest.js";

const INGEST_COLUMNS: Column<IngestEntry>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "Enc", value: (r) => (r.encrypted ? "yes" : "no") },
  { header: "File ID", value: (r) => r.fileId ?? "-" },
  { header: "Path", value: (r) => r.relPath },
  { header: "Note", value: (r) => r.note ?? "" },
];

interface ListIngestOpts {
  regex?: string;
}

function toIngestFile(entry: IngestEntry): IngestFile {
  return {
    type: "file",
    path: entry.path,
    rel_path: entry.relPath,
    hash: entry.hash,
    file_id: entry.fileId,
    status: entry.status,
    encrypted: entry.encrypted,
    note: entry.note ?? null,
  };
}

async function listIngest(opts: ListIngestOpts, command: Command): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);

  let regex: RegExp | undefined;
  if (opts.regex) {
    try {
      regex = new RegExp(opts.regex);
    } catch (err) {
      fail("USAGE", `invalid --regex: ${(err as Error).message}`);
    }
  }

  const entries = await discoverFiles(db, config.dataDir, { regex });
  const counts: Record<IngestEntry["status"], number> = {
    new: 0,
    pending: 0,
    ingested: 0,
    failed: 0,
    unreadable: 0,
  };
  for (const e of entries) counts[e.status]++;
  const total = entries.length;

  const mode = currentMode();
  if (mode.json) {
    for (const e of entries) emit(toIngestFile(e));
    const summary: Omit<IngestListSummary, "type"> = { ...counts, total };
    emitSummary(summary);
    return;
  }

  emitList(entries, INGEST_COLUMNS);
  if (mode.tty) {
    process.stdout.write(
      `\n${counts.new} new, ${counts.pending} pending, ${counts.ingested} ingested, ${counts.failed} failed, ${counts.unreadable} unreadable (${total} total)\n`,
    );
  }
}

interface PrepareIngestOpts {
  password?: string;
  force?: boolean;
  rescan?: boolean;
  /** commander's `--no-ocr` negation: false only when the flag was passed. */
  ocr?: boolean;
}

const PASSWORD_HINT = "re-run with --password <password>";

const ACCEPTED_EXTS = SUPPORTED_EXTS.join(" ");
const SIZE_LIMIT = `${MAX_SOURCE_BYTES / (1024 * 1024)} MB`;

const PREPARE_FAILURES: Record<PrepareFailure, { code: ExitCode; hint: string }> = {
  not_found: { code: "NOT_FOUND", hint: "run `oled ingest list --json` to see what is discoverable" },
  unsupported_extension: {
    code: "USAGE",
    hint: `supported: ${ACCEPTED_EXTS}, export other formats first`,
  },
  kind_mismatch: { code: "USAGE", hint: "the bytes disagree with the extension; re-export or rename" },
  too_large: {
    code: "INVALID",
    hint: `the limit is ${SIZE_LIMIT}, split the file or export it smaller`,
  },
  unreadable: { code: "NOT_FOUND", hint: "check the path and its permissions" },
  pdf_unreadable: { code: "INVALID", hint: "the PDF may be corrupt; re-download or re-export it" },
  password_required: { code: "INPUT_REQUIRED", hint: PASSWORD_HINT },
  wrong_password: { code: "INPUT_REQUIRED", hint: PASSWORD_HINT },
  ocr_unreachable: { code: "NOT_READY", hint: "start the OCR endpoint, or re-run with --no-ocr" },
  ocr_rejected: {
    code: "NOT_READY",
    hint: "check the model against `oled doctor --json`, or re-run with --no-ocr",
  },
};

/** What each route emits: a document to read, or one path per page image. */
const PREPARE_LINE: {
  [K in PrepareSuccess["kind"]]: (
    result: Extract<PrepareSuccess, { kind: K }>,
  ) => Extract<PrepareResult, { kind: K }>;
} = {
  text: (result) => ({
    file_id: result.fileId,
    kind: "text",
    source: result.source,
    text_layer: result.textLayer,
    page_count: result.pageCount,
    ...(result.model ? { ocr_model: result.model } : {}),
    document: result.document,
    pages: result.pages,
    // Only the OCR route reads page by page, so only it can lose one.
    ...(result.source === "ocr" ? { failed_pages: result.failedPages } : {}),
  }),
  images: (result) => ({
    file_id: result.fileId,
    kind: "images",
    source: result.source,
    text_layer: result.textLayer,
    page_count: result.pageCount,
    ...(result.dpi ? { dpi: result.dpi } : {}),
    pages: result.pages,
  }),
};

async function prepareIngest(
  pathOrId: string,
  opts: PrepareIngestOpts,
  command: Command,
): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);

  const result = await prepareFile(db, config, pathOrId, {
    password: opts.password,
    force: !!opts.force,
    rescan: !!opts.rescan,
    noOcr: opts.ocr === false,
  });
  if (!result.ok) {
    const { code, hint } = PREPARE_FAILURES[result.reason];
    fail(code, result.message, { hint });
  }

  emitObject(PREPARE_LINE[result.kind](result as never));

  // A page the endpoint could not read is a hole in the document, not a failed run.
  if (result.kind === "text" && result.failedPages.length > 0) process.exitCode = EXIT.PARTIAL;
}

const DONE_FLAGS_SPEC = z.object({
  agent: str().optional(),
  account: str().optional(),
  closing_balance: num().optional(),
});

type DoneFlags = z.infer<typeof DONE_FLAGS_SPEC>;

interface ReconcileTarget {
  account: string;
  closing: number;
}

/** Flag arity only, so a half-given pair is refused before any ledger opens. */
function reconcileTarget(flags: DoneFlags): ReconcileTarget | null {
  const { account, closing_balance: closing } = flags;
  if (account === undefined && closing === undefined) return null;
  if (account === undefined || closing === undefined) {
    fail("USAGE", "reconciling needs --account and --closing-balance together");
  }
  return { account, closing };
}

/**
 * The statement's closing balance against the ledger's own, in minor units:
 * comparing decimals would fail on a rounding artifact rather than a real gap.
 */
function reconcileStatement(db: Database.Database, target: ReconcileTarget): Reconciliation {
  const { account, closing } = target;
  const balanceMinor = getAccountBalanceMinor(db, account);
  if (balanceMinor === null) {
    fail("NOT_FOUND", `no account ${account}`, {
      hint: "run `oled accounts tree --json` for the ids this ledger has",
    });
  }

  const currency = currencyOf(account);
  const closingMinor = toMinorUnits(closing, currency);
  const show = (minor: number): string => formatFixed(fromMinorUnits(minor, currency), currency);

  if (balanceMinor !== closingMinor) {
    fail(
      "INVALID",
      `${account} holds ${show(balanceMinor)}, but the statement closes at ${show(closingMinor)} (off by ${show(closingMinor - balanceMinor)})`,
      {
        hint: `a balance lives on the account the rows post to, never on a parent; compare \`oled transactions list --account ${account} --json\` against the statement: a row may be misread, missing, or invented; a first statement also needs its opening balance posted against ${currency.toLowerCase()}:equity:opening`,
      },
    );
  }

  return {
    account,
    closing: fromMinorUnits(closingMinor, currency),
    balance: fromMinorUnits(balanceMinor, currency),
  };
}

async function completeIngest(
  id: string,
  opts: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const flags = parseInput(DONE_FLAGS_SPEC, opts);
  const target = reconcileTarget(flags);
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  requireFile(
    db,
    id,
    "run `oled ingest list --json` for the file ids; done takes the sf-id prepare returned, not the path",
  );

  // Before the status flips, so a file that was pending stays pending.
  const reconciliation = target ? reconcileStatement(db, target) : null;

  markFileIngested(db, id, { source: flags.agent ?? "external" });
  const { removed } = cleanCache(config.cacheDir, id);
  const result: IngestDoneResult = {
    file_id: id,
    status: "ingested",
    cache_removed: removed,
    ...(reconciliation ? { reconciliation } : {}),
  };
  emitObject(result);
}

interface FailIngestOpts {
  agent?: string;
  error?: string;
}

async function failIngest(id: string, opts: FailIngestOpts, command: Command): Promise<void> {
  if (!opts.error) fail("USAGE", "`ingest fail` requires --error <text>");

  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  requireFile(
    db,
    id,
    "run `oled ingest list --json` for the file ids; fail takes the sf-id prepare returned, not the path",
  );
  markFileFailed(db, id, { source: opts.agent ?? "external", error: opts.error });

  const { removed } = cleanCache(config.cacheDir, id);
  const result: IngestFailResult = { file_id: id, status: "failed", cache_removed: removed };
  emitObject(result);
}

export function registerIngest(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Ingest pipeline: list / prepare / commit / done / fail")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  The statement pipeline: list what waits, prepare a file for reading, commit its rows,",
        "  answer the questions raised, then mark it done or failed.",
        `  Accepts ${ACCEPTED_EXTS}, up to ${SIZE_LIMIT}. A locked PDF exits 4: re-run with --password <password>.`,
        "",
        "Flow:",
        "  oled ingest list --json",
        "  oled ingest prepare <path> --json    then read the document it returns",
        "  oled ingest commit --file <sf-id> --input <batch> --json",
        "  oled questions list --json           then answer what the commit raised",
        "  oled ingest done <sf-id> --account <id> --closing-balance <n> --json",
        "",
        "Example:",
        "  oled ingest prepare statement.pdf --json",
      ].join("\n"),
    );

  ingest
    .command("list")
    .description("List items in the ingest pipeline")
    .option("--regex <pattern>", "filter items by regex")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  Walks the data dir and reports every statement's status; new files appear here first.",
        "  `oled files list` shows only what is already registered.",
        "",
        "Example:",
        "  oled ingest list --json",
      ].join("\n"),
    )
    .action(runAction(listIngest));

  ingest
    .command("prepare <pathOrId>")
    .description("Extract a statement file into text (or page images) to read")
    .option("--password <password>", "password for a locked PDF")
    .option("--force", "re-register the file, dropping the prior ingest's rows and artifacts")
    .option("--rescan", "ignore the text layer and read the page images instead")
    .option("--no-ocr", "ignore the OCR endpoint and return the page images to you")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  Reads the file once and returns text whenever it can.",
        "  A PDF with its own text layer is extracted directly. Otherwise the pages become images",
        "  (a scan rasterized, a photo as it lies) and the OCR endpoint reads them when configured",
        "  (`oled config --ocr-base-url <url>`); with none configured they come back to you.",
        '  source names the reader: "text-layer" or "ocr" for kind "text", "raster" or "original" for kind "images".',
        "",
        "Output:",
        '  kind "text": one `document` path to read; pages separated by --- page N --- markers.',
        "  Cite each row's page as source_page on commit. Pages count from 1 everywhere.",
        '  kind "images": one path per page under pages[], in order; read them yourself.',
        "",
        "Escape Hatches:",
        "  --rescan ignores a garbled text layer and reads the page images instead.",
        "  --no-ocr ignores the OCR endpoint and returns the page images. Both together always return images.",
        "",
        "Exits:",
        "  2 unsupported file type · 3 OCR endpoint misconfigured or unreachable",
        "  4 locked PDF (re-run with --password) · 5 nothing at that path or id · 6 too large or corrupt",
        "  7 OCR failed on some pages: each carries a [page N: OCR failed] line in the document and",
        "    is listed in failed_pages; re-run with --no-ocr to read those pages yourself.",
        "",
        "Example:",
        "  oled ingest prepare statement.pdf --json",
      ].join("\n"),
    )
    .action(runAction(prepareIngest));

  ingest
    .command("commit")
    .description("Commit extracted transactions (NDJSON/JSON array via --input file or stdin) into the ledger")
    .option("--file <id>", "default source file id for committed rows")
    .option("--input <path>", "read the batch from an NDJSON/JSON file instead of stdin")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  Posts one batch of statement rows: each item resolves account hints, links merchants,",
        "  and raises questions instead of failing.",
        "",
        "Item:",
        '  {"date":"YYYY-MM-DD","description":"...","debit_account":"thb:expense:food","credit_account":"thb:asset:bank:kbank","amount":135.00,"source_page":2,"row_index":0,"raw_descriptor":"<verbatim bank text>","merchant":{"canonical_name":"..."}}',
        "",
        "Rules:",
        "  amount > 0; direction comes from the two accounts, never a sign.",
        "  Account ids are currency-prefixed (<currency>:<type>:<path>); both sides share the prefix.",
        "  Ids are taken literally: an exact match posts there, a well-formed path inside an existing",
        "  ledger is created, a lookalike only raises a question.",
        "  Commit never opens a ledger: an id whose prefix names no existing ledger is refused, naming",
        "  the accounts create command that opens it; only ids with no usable prefix fall back to the",
        "  other side's <currency>:expense:uncategorized with a question.",
        "  Set row_index + source_page and pass --file <sf-id>: a re-run is an idempotent duplicate:true",
        "  no-op, and a failed row keeps one question across retries (raised_questions: 0 on the retry)",
        "  which closes itself once the fixed row posts.",
        "",
        "Directions:",
        "  " + DIRECTION_RULES,
        "",
        "Compound Rows (payslip, FX):",
        "  Replace debit/credit/amount with linked:[{debit_account,credit_account,amount},...] sharing",
        "  one account; legs commit atomically under one group_id. A cross-currency row becomes two",
        "  linked legs through <currency>:equity:conversion, one per ledger, sharing the group.",
        "",
        "Output:",
        "  One result per item, then a summary with batch_id/posted/duplicates/failed.",
        "  With --file the summary adds file_status, file_transaction_count and file_open_question_count,",
        "  cumulative for that file after this batch, plus a done hint while it stays pending.",
        "  file_transaction_count counts ledger transactions, not items: a compound row posts once but",
        "  adds one per leg, and a row carrying its own source_file_id counts toward that file instead;",
        "  the same two numbers `oled files show <sf-id>` reports as transaction_count and open_question_count.",
        "  Exit 7 = some rows failed; duplicate:true is a success.",
        "",
        "Example:",
        "  oled ingest commit --file sf-abc --input rows.ndjson --json",
      ].join("\n"),
    )
    .action(runAction(commitIngest));

  ingest
    .command("done <id>")
    .description("Mark an ingest item as done, reconciling the statement's own math when given")
    .option("--agent <name>", "name of the completing agent")
    .option("--account <id>", "the statement's own account (the card liability or bank asset)")
    .option("--closing-balance <amount>", "statement closing balance; done refuses when the ledger disagrees")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  Closes the file. With --account and --closing-balance it first verifies the ledger:",
        "  that account's balance must equal the statement's closing figure; on a mismatch the",
        "  file stays pending.",
        "  A mismatch means a misread, missing, or invented row, or a first statement whose opening",
        "  balance was never posted. The check reads one account; a row booked to the wrong",
        "  counter-account still ties, which the questions queue covers.",
        "",
        "Example:",
        "  oled ingest done sf-abc --account thb:liability:card --closing-balance 1234.56 --json",
      ].join("\n"),
    )
    .action(runAction(completeIngest));

  ingest
    .command("fail <id>")
    .description("Mark an ingest item as failed")
    .option("--agent <name>", "name of the failing agent")
    .option("--error <text>", "failure reason")
    .addHelpText(
      "after",
      [
        "",
        "Behavior:",
        "  Marks the file failed, recording --error, and removes its cache artifacts.",
        "",
        "Example:",
        '  oled ingest fail sf-abc --error "unreadable scan" --json',
      ].join("\n"),
    )
    .action(runAction(failIngest));
}
