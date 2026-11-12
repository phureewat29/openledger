import type { Command } from "commander";
import type { ChalkInstance } from "chalk";
import { uniq } from "es-toolkit";
import { getNetWorth } from "../../accounts/balances.js";
import type { LoadedConfig } from "../../config/config.js";
import { countAccounts } from "../../accounts/queries.js";
import { countFiles } from "../../files/queries.js";
import { countMerchants } from "../../merchants/queries.js";
import { countNotes } from "../../notes/queries.js";
import { countQuestions } from "../../questions/queries.js";
import { countTransactions } from "../../transactions/queries.js";
import { countNewFiles } from "../../files/files.js";
import { prepareRedaction } from "../../privacy/redactor.js";
import { homeRelative } from "../../lib/path.js";
import { formatAmount, toDecimalTotals } from "../../lib/money.js";
import { banner, visibleLength, formatInt, flattenRows, formatKeyValues } from "../format.js";
import { runAction, type Invocation } from "../output.js";
import { redactionEnabled } from "../input.js";
import { inspectConfig, ledgerProblem, probeLedger, type LedgerProbe } from "../../config/cli.js";
import { getVersion } from "../../lib/version.js";
import { CONTRACT_VERSION } from "../../contract/version.js";
import type { StatusReport } from "../../contract/status.js";

// Exported for tests: lets the default-profile-problem path be pinned directly, without a
// subprocess or a real ~/.oled to leave a broken file in.
export function buildReport(loaded: LoadedConfig, ledger: LedgerProbe): StatusReport {
  const cfg = loaded.config;
  const base: StatusReport = {
    type: "status",
    contract_version: CONTRACT_VERSION,
    version: getVersion(),
    // `configured` means a converge has run (`oled config --init`); a db file alone doesn't imply that.
    configured: cfg.exists,
    // Home-relative so no output carries the OS account name; `--config` expands
    // `~` back, so what status prints is still usable as input.
    config_path: homeRelative(cfg.configPath, cfg.home),
    config_problem: loaded.problem,
    data_dir: homeRelative(cfg.dataDir, cfg.home),
    locale: cfg.displayLocale,
    currency: cfg.displayCurrency,
    user_name: cfg.userName,
    db: {
      path: homeRelative(cfg.dbPath, cfg.home),
      reachable: false,
      error: null,
    },
    counts: null,
    files: { new: 0, ingested: 0, pending: 0, failed: 0 },
    questions: null,
    net_worth: null,
  };

  // Opening the db is the only reachability check; a failing count query must not read as not-ready.
  if (ledger.state !== "open") {
    // Nothing is registered without a ledger, so every readable file is new.
    const fresh = ledger.state === "missing" ? countNewFiles(null, cfg.dataDir) : 0;
    return { ...base, db: { ...base.db, error: ledgerProblem(ledger) }, files: { ...base.files, new: fresh } };
  }

  const { db } = ledger;
  const open = countQuestions(db);
  const total = countQuestions(db, { includeDeferred: true });
  const worth = getNetWorth(db);
  return {
    ...base,
    db: { ...base.db, reachable: true },
    counts: {
      accounts: countAccounts(db),
      transactions: countTransactions(db),
      merchants: countMerchants(db),
      notes: countNotes(db),
    },
    files: { new: countNewFiles(db, cfg.dataDir), ...countFiles(db) },
    questions: { open, deferred: Math.max(0, total - open) },
    net_worth: {
      assets: toDecimalTotals(worth.assets),
      liabilities: toDecimalTotals(worth.liabilities),
      net_worth: toDecimalTotals(worth.net_worth),
    },
  };
}

// Paths are home-relativized facts, not free text; only error prose and user_name can still carry PII.
const STATUS_REDACT_FIELDS = ["error", "user_name", "config_problem"] as const;

interface ShowStatusOpts {
  redact?: boolean;
}

// Redaction defaults on, so bare `oled` (no --no-redact flag) masks the same fields `status` does.
export async function showStatus(ctx: Invocation, opts: ShowStatusOpts): Promise<void> {
  const loaded = inspectConfig(ctx.configPath, ctx.roots);
  const ledger = await probeLedger(loaded.config.dbPath, loaded.config.home);
  const redact = prepareRedaction(redactionEnabled(opts), loaded.config);
  const report = redact(buildReport(loaded, ledger), STATUS_REDACT_FIELDS);
  const { out } = ctx;
  out.render({
    json: () => out.emit(report),
    tty: () => out.write(renderTTY(report, out.paint, ledger.state === "missing")),
    plain: () => out.write(renderPlain(report)),
  });
}

type Line = [string, string | number | boolean];

function renderPlain(r: StatusReport): string {
  const lines: Line[] = [
    ["configured", r.configured],
    ["config_path", r.config_path],
    ...(r.config_problem ? [["config_problem", r.config_problem] satisfies Line] : []),
    ["data_dir", r.data_dir],
    ["locale", r.locale],
    ["currency", r.currency],
    ["user_name", r.user_name],
    ["db_path", r.db.path],
    ["db_reachable", r.db.reachable],
    ...(r.db.error ? [["db_error", r.db.error] satisfies Line] : []),
    ...(r.counts
      ? [
          ["accounts", r.counts.accounts],
          ["transactions", r.counts.transactions],
          ["merchants", r.counts.merchants],
          ["notes", r.counts.notes],
        ] satisfies Line[]
      : []),
    ["files_new", r.files.new],
    ["files_ingested", r.files.ingested],
    ["files_pending", r.files.pending],
    ["files_failed", r.files.failed],
    ...(r.questions
      ? [
          ["questions_open", r.questions.open],
          ["questions_deferred", r.questions.deferred],
        ] satisfies Line[]
      : []),
    // One key per currency, never a scalar: different currencies must not be added together.
    ...(r.net_worth ? flattenRows(r.net_worth) : []),
  ];
  return formatKeyValues(lines, { tty: false });
}

const LABEL_WIDTH = 18;

type Row = [string, string];

// Exported for tests: this renderer only runs on a real TTY, so no subprocess suite executes it.
export function renderTTY(r: StatusReport, paint: ChalkInstance, ledgerMissing = false): string {
  const section = (title: string, rows: Row[]): string => {
    const valueWidth = Math.max(0, ...rows.map(([, v]) => visibleLength(v)));
    const body = rows.map(([label, value]) => {
      const pad = " ".repeat(Math.max(0, valueWidth - visibleLength(value)));
      return `  ${label.padEnd(LABEL_WIDTH)}${pad}${value}\n`;
    });
    return paint.bold.yellow(title) + "\n" + body.join("") + "\n";
  };

  const system: Row[] = [
    ["Configured", r.configured ? "yes" : paint.dim("no")],
    ...(r.config_problem ? [["Config", paint.dim(`unusable: ${r.config_problem}`)] satisfies Row] : []),
    ["User", paint.dim(r.user_name)],
    ["Locale", paint.dim(r.locale)],
    ["Currency", paint.dim(r.currency)],
    ["Data dir", paint.dim(r.data_dir)],
    ["Database", r.db.reachable ? "ready" : paint.dim(r.db.error ? `not ready: ${r.db.error}` : "not ready")],
  ];
  const nextStep = ledgerMissing ? "run `oled config --init` to create one" : "run `oled doctor` for details";

  const fileExtras = (["new", "pending", "failed"] as const)
    .filter((state) => r.files[state] > 0)
    .map((state) => `${r.files[state]} ${state}`);
  const pipeline: Row[] = [
    ["Files", `${formatInt(r.files.ingested)}${fileExtras.length ? "  " + paint.dim(`(${fileExtras.join(", ")})`) : ""}`],
    ...(r.questions
      ? [
          [
            "Questions",
            `${formatInt(r.questions.open)} open${r.questions.deferred ? "  " + paint.dim(`(${r.questions.deferred} deferred)`) : ""}`,
          ] satisfies Row,
        ]
      : []),
  ];
  const financial = r.net_worth ? financialRows(r.net_worth, paint.dim, r.locale) : [];

  return [
    "\n" + banner(paint) + "\n\n",
    section("System", system),
    r.db.reachable ? "" : paint.dim(`  ${nextStep}`) + "\n\n",
    r.counts
      ? section("Ledger", [
          ["Accounts", formatInt(r.counts.accounts)],
          ["Transactions", formatInt(r.counts.transactions)],
          ["Merchants", formatInt(r.counts.merchants)],
          ["Notes", formatInt(r.counts.notes)],
        ])
      : "",
    section("Pipeline", pipeline),
    financial.length ? section("Financial", financial) : "",
  ].join("");
}

// Ledgers in ISO order; each amount formats in its own currency, not the display currency.
function financialRows(
  worth: NonNullable<StatusReport["net_worth"]>,
  dim: (s: string) => string,
  locale: string,
): Row[] {
  const currencies = uniq([
    ...Object.keys(worth.net_worth),
    ...Object.keys(worth.assets),
    ...Object.keys(worth.liabilities),
  ]).sort();

  return currencies.flatMap((currency): Row[] => {
    const amount = (totals: Record<string, number>): string =>
      formatAmount(totals[currency] ?? 0, currency, locale);
    return [
      [`${currency} net worth`, amount(worth.net_worth)],
      [`${currency} assets`, dim(amount(worth.assets))],
      [`${currency} liabilities`, dim(amount(worth.liabilities))],
    ];
  });
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Status: config, database, ledger counts, net worth")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showStatus));
}
