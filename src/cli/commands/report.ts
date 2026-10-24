import type { Command } from "commander";
import { getPeriodTotals, subtractTotals } from "../../accounts/balances.js";
import { formatKeyValues } from "../format.js";
import { openLedger } from "../../config/cli.js";
import { runAction, type Invocation } from "../output.js";
import { fail } from "../errors.js";
import { toDecimalTotals } from "../../lib/money.js";
import { ISO_DATE_RE } from "../../lib/date.js";
import type { ReportResult } from "../../contract/report.js";

interface ShowReportOpts {
  from?: string;
  to?: string;
}

async function showReport(ctx: Invocation, opts: ShowReportOpts): Promise<void> {
  if (!opts.from || !opts.to) {
    fail("USAGE", "--from and --to are required", {
      hint: "e.g. `oled report --from 2026-01-01 --to 2026-03-31 --json`; for net worth use `oled status --json`",
    });
  }
  if (!ISO_DATE_RE.test(opts.from)) {
    fail("USAGE", `--from must be an ISO date (YYYY-MM-DD), got "${opts.from}"`);
  }
  if (!ISO_DATE_RE.test(opts.to)) {
    fail("USAGE", `--to must be an ISO date (YYYY-MM-DD), got "${opts.to}"`);
  }

  const { db } = await openLedger(ctx.configPath);
  const totals = getPeriodTotals(db, opts.from, opts.to);
  // Net is taken in minor units per currency before anything becomes decimal; a THB
  // income and a USD expense share no common net.
  const result: ReportResult = {
    from: opts.from,
    to: opts.to,
    income: toDecimalTotals(totals.income),
    expenses: toDecimalTotals(totals.expenses),
    net: toDecimalTotals(subtractTotals(totals.income, totals.expenses)),
  };
  const { mode } = ctx.out;
  if (mode.json) {
    ctx.out.emit(result);
    return;
  }
  const rows: [string, string | number][] = [
    ["from", result.from],
    ["to", result.to],
  ];
  for (const [label, amounts] of [
    ["income", result.income],
    ["expenses", result.expenses],
    ["net", result.net],
  ] as const) {
    for (const [currency, amount] of Object.entries(amounts)) {
      rows.push([`${label}.${currency}`, amount]);
    }
  }
  ctx.out.write(formatKeyValues(rows, { tty: mode.tty, bold: mode.color }));
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Income, expenses, and net worth")
    .option("--from <date>", "start date")
    .option("--to <date>", "end date")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: sums income, expenses, and net worth over a date range. For net worth use oled status.",
        "Both dates are required and ISO (YYYY-MM-DD).",
        "Example: oled report --from 2025-01-01 --to 2025-03-31 --json",
      ].join("\n"),
    )
    .action(runAction(showReport));
}
