import type { Command } from "commander";
import * as z from "zod";
import { getPeriodTotals, subtractTotals } from "../../accounts/balances.js";
import { openLedger } from "../../config/cli.js";
import { runAction, type Invocation } from "../output.js";
import { fail } from "../errors.js";
import { toDecimalTotals } from "../../lib/money.js";
import { isoDate, parseInput } from "../../lib/validate.js";
import type { ReportResult } from "../../contract/report.js";

interface ShowReportOpts {
  from?: string;
  to?: string;
}

const SHOW_REPORT_SPEC = z.object({ from: isoDate(), to: isoDate() });

async function showReport(ctx: Invocation, opts: ShowReportOpts): Promise<void> {
  if (!opts.from || !opts.to) {
    fail("USAGE", "--from and --to are required", {
      hint: "e.g. `oled report --from 2026-01-01 --to 2026-03-31 --json`; for net worth use `oled status --json`",
    });
  }
  const { from, to } = parseInput(SHOW_REPORT_SPEC, opts);

  const { db } = await openLedger(ctx);
  const totals = getPeriodTotals(db, from, to);
  // Net is taken in minor units per currency before anything becomes decimal; a THB
  // income and a USD expense share no common net.
  const result: ReportResult = {
    from,
    to,
    income: toDecimalTotals(totals.income),
    expenses: toDecimalTotals(totals.expenses),
    net: toDecimalTotals(subtractTotals(totals.income, totals.expenses)),
  };
  ctx.out.emitRecord(result, { boldKeys: true });
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
