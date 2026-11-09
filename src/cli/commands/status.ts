import type { Command } from "commander";
import chalk from "chalk";
import { homedir } from "os";
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
import { applyRedaction } from "../../privacy/redactor.js";
import { homeRelative } from "../../lib/path.js";
import { formatAmount, toDecimalTotals } from "../../lib/money.js";
import { banner, visibleLength, ANSI_RE, formatInt, flattenRows } from "../format.js";
import { runAction, type Invocation } from "../output.js";
import { redactionEnabled } from "../input.js";
import { inspectConfig, probeLedger, type LedgerProbe } from "../../config/cli.js";
import { getVersion } from "../../lib/version.js";
import { CONTRACT_VERSION } from "../../contract/version.js";
import type { StatusReport } from "../../contract/status.js";

/** `status` never creates the ledger, so a missing db file is reported, not opened. */
const NO_LEDGER = "no ledger yet";

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
    config_path: homeRelative(cfg.configPath),
    config_problem: loaded.problem,
    data_dir: homeRelative(cfg.dataDir),
    locale: cfg.displayLocale,
    currency: cfg.displayCurrency,
    user_name: cfg.userName,
    db: {
      path: homeRelative(cfg.dbPath),
      reachable: false,
      error: null,
    },
    counts: null,
    files: { new: 0, ingested: 0, pending: 0, failed: 0 },
    questions: null,
    net_worth: null,
  };

  if (ledger.state === "missing") {
    // Nothing is registered without a ledger, so every readable file is new.
    return {
      ...base,
      db: { ...base.db, error: NO_LEDGER },
      files: { ...base.files, new: countNewFiles(null, cfg.dataDir) },
    };
  }
  // Opening the db is the only reachability check; a failing count query must not read as not-ready.
  if (ledger.state === "unreachable") return { ...base, db: { ...base.db, error: ledger.error } };

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
  const loaded = inspectConfig(ctx.configPath, homedir());
  const ledger = await probeLedger(loaded.config.dbPath);
  const report = applyRedaction(
    buildReport(loaded, ledger),
    redactionEnabled(opts),
    STATUS_REDACT_FIELDS,
    loaded.config,
  );
  const { out } = ctx;
  out.render({
    json: () => out.emit(report),
    tty: () => out.write(renderTTY(report, out.mode.color, ledger.state === "missing")),
    plain: () => out.write(renderPlain(report)),
  });
}

function renderPlain(r: StatusReport): string {
  const lines: [string, string | number | boolean][] = [
    ["configured", r.configured],
    ["config_path", r.config_path],
  ];
  if (r.config_problem) lines.push(["config_problem", r.config_problem]);
  lines.push(
    ["data_dir", r.data_dir],
    ["locale", r.locale],
    ["currency", r.currency],
    ["user_name", r.user_name],
    ["db_path", r.db.path],
    ["db_reachable", r.db.reachable],
  );
  if (r.db.error) lines.push(["db_error", r.db.error]);
  if (r.counts) {
    lines.push(
      ["accounts", r.counts.accounts],
      ["transactions", r.counts.transactions],
      ["merchants", r.counts.merchants],
      ["notes", r.counts.notes],
    );
  }
  lines.push(
    ["files_new", r.files.new],
    ["files_ingested", r.files.ingested],
    ["files_pending", r.files.pending],
    ["files_failed", r.files.failed],
  );
  if (r.questions) {
    lines.push(
      ["questions_open", r.questions.open],
      ["questions_deferred", r.questions.deferred],
    );
  }
  // One key per currency, never a scalar: different currencies must not be added together.
  if (r.net_worth) lines.push(...flattenRows(r.net_worth));
  return lines.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n";
}

const LABEL_WIDTH = 18;

// Exported for tests: this renderer only runs on a real TTY, so no subprocess suite executes it.
export function renderTTY(r: StatusReport, color: boolean, ledgerMissing = false): string {
  const dim = (s: string) => (color ? chalk.dim(s) : s);
  const bold = (s: string) => (color ? chalk.bold.yellow(s) : s);

  const section = (title: string, rows: [string, string][]): string => {
    const valueWidth = Math.max(0, ...rows.map(([, v]) => visibleLength(v)));
    const body = rows.map(([label, value]) => {
      const pad = " ".repeat(Math.max(0, valueWidth - visibleLength(value)));
      return `  ${label.padEnd(LABEL_WIDTH)}${pad}${value}\n`;
    });
    return bold(title) + "\n" + body.join("") + "\n";
  };

  const parts = ["\n" + (color ? banner() : stripBanner()) + "\n\n"];

  const system: [string, string][] = [["Configured", r.configured ? "yes" : dim("no")]];
  if (r.config_problem) system.push(["Config", dim(`unusable: ${r.config_problem}`)]);
  system.push(
    ["User", dim(r.user_name)],
    ["Locale", dim(r.locale)],
    ["Currency", dim(r.currency)],
    ["Data dir", dim(r.data_dir)],
    [
      "Database",
      r.db.reachable ? "ready" : dim(r.db.error ? `not ready: ${r.db.error}` : "not ready"),
    ],
  );
  parts.push(section("System", system));

  // Bare status always exits 0; a named --config that fails to resolve exits NOT_READY
  // before a report is ever built. An unreachable db still needs its own pointer here.
  if (!r.db.reachable) {
    const next = ledgerMissing
      ? "run `oled config --init` to create one"
      : "run `oled doctor` for details";
    parts.push(dim(`  ${next}`) + "\n\n");
  }

  if (r.counts) {
    parts.push(
      section("Ledger", [
        ["Accounts", formatInt(r.counts.accounts)],
        ["Transactions", formatInt(r.counts.transactions)],
        ["Merchants", formatInt(r.counts.merchants)],
        ["Notes", formatInt(r.counts.notes)],
      ]),
    );
  }

  const fileExtras = (["new", "pending", "failed"] as const)
    .filter((state) => r.files[state] > 0)
    .map((state) => `${r.files[state]} ${state}`);

  const pipeline: [string, string][] = [
    [
      "Files",
      `${formatInt(r.files.ingested)}${fileExtras.length ? "  " + dim(`(${fileExtras.join(", ")})`) : ""}`,
    ],
  ];
  if (r.questions) {
    pipeline.push([
      "Questions",
      `${formatInt(r.questions.open)} open${r.questions.deferred ? "  " + dim(`(${r.questions.deferred} deferred)`) : ""}`,
    ]);
  }
  parts.push(section("Pipeline", pipeline));

  const financial = r.net_worth ? financialRows(r.net_worth, dim, r.locale) : [];
  if (financial.length) parts.push(section("Financial", financial));
  return parts.join("");
}

// Ledgers in ISO order; each amount formats in its own currency, not the display currency.
function financialRows(
  worth: NonNullable<StatusReport["net_worth"]>,
  dim: (s: string) => string,
  locale: string,
): [string, string][] {
  const currencies = uniq([
    ...Object.keys(worth.net_worth),
    ...Object.keys(worth.assets),
    ...Object.keys(worth.liabilities),
  ]).sort();

  return currencies.flatMap((currency): [string, string][] => {
    const amount = (totals: Record<string, number>): string =>
      formatAmount(totals[currency] ?? 0, currency, locale);
    return [
      [`${currency} net worth`, amount(worth.net_worth)],
      [`${currency} assets`, dim(amount(worth.assets))],
      [`${currency} liabilities`, dim(amount(worth.liabilities))],
    ];
  });
}

function stripBanner(): string {
  return banner().replace(ANSI_RE, "");
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Status: config, database, ledger counts, net worth")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showStatus));
}
