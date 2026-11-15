<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="OpenLedger" width="108">
  </picture>
</p>

<h1 align="center">OpenLedger</h1>

<p align="center">
  <strong>A deterministic ledger for your AI</strong>
</p>

<p align="center">
    OpenLedger is the harness that keeps your AI from hallucinating your money. It turns scattered bank and credit-card statements into a source of truth you can build any financial AI agent on.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aquartier/openledger"><img src="https://img.shields.io/npm/v/@aquartier/openledger.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@aquartier/openledger"><img src="https://img.shields.io/npm/dt/@aquartier/openledger.svg" alt="npm total downloads" /></a>
</p>

<br />

You've tried many personal finance apps from the App Store. None of them fits what you need, because each is someone else's idea of your money and lifestyle. So you asked AI to build the one that would, and it failed you too. It hallucinated the numbers, mangled your data, and never quite understood what you wanted.

AI fails when it has nowhere reliable to keep the numbers. OpenLedger gives it that place, a deterministic harness that holds every number in your own records.

OpenLedger is a secure bookkeeping harness for your AI. The source is what you already receive: monthly statements from your banks and credit cards. Your AI reads each statement and records what it finds as double-entry bookkeeping, so every posting balances, or it doesn't post.

Everything stays on your machine, and what the harness returns to your AI has PII redacted by default before it reaches your AI provider. No bank logins, no bank API keys, no cloud aggregator needed, just the bank documents you already have as the source of truth. It is your own private Plaid: scattered statements go in, a reliable ledger comes out, a data feed you own end to end.

The harness carries the bookkeeping, so the model doesn't have to be huge: flash-tier models for everyday-use, can run a full loop through cleanly.

On top of this harness, you can build the financial AI agent you never found: a budget tracker that fits your lifestyle, a subscription auditor, a retirement planner, a personal money coach. Your financial AI agent is now yours to build.

## Use OpenLedger with your Coding Agents

This repo supports [Agent Plugins](https://agent-plugins.org) package, so compliant clients can install it straight from the git URL.

1. Install the CLI. It needs [Node.js](https://nodejs.org) (LTS). Paste into your terminal:

   ```bash
   npm install -g @aquartier/openledger
   ```

   It runs on macOS, Linux and Windows (x64); on Windows on ARM, use the x64 build of Node.js. OCR is built in and runs locally on the CPU: it reads printed Thai and English from scans and photos (PDF, PNG, JPEG). It does not read handwriting.

2. Add the skill:

   ```bash
   npx skills add phureewat29/openledger
   ```

   Or run `oled setup`, which writes the skill to `.agents/skills/`, the shared directory most agents read. Pass `--dir <path>` to name your agent's own skills directory instead, such as `--dir .claude/skills` for Claude Code.

### Use Cases

1. Start with the statements you have waiting: *"Ingest my credit cards and bank statements."* It discovers new files, prepares and reads each one, commits the transactions it finds, and raises a question for anything it can't resolve on its own.
2. Clear whatever it flagged: *"Show me anything you weren't sure about, and let's resolve it."* It walks you through the questions the ingestion raised, such as an unrecognized merchant or an ambiguous account match.
3. With the ledger current, ask for the payoff: *"What's my net worth, and where did most of my spending go last month?"* Your AI reads the answer straight from the ledger.

## The Agent Workflow

Every row becomes a *transaction*: it debits one account and credits another by the same positive amount.

This is the loop the skill and `oled ingest --help` steer an agent through:

1. **Discover**: `oled ingest list --json` to find new/pending files.
2. **Prepare**: `oled ingest prepare <path>` registers the file and extracts its text into one `document` file. A locked PDF exits 4 until the agent re-runs with `--password <password>`. A PDF with its own text layer is read directly; the built-in OCR reads scans and photos.
3. **Read**: the agent reads the document and picks out every transaction row.
4. **Commit**: the agent pipes the transactions it extracted (one debit account, one credit account, one positive amount per row; splits go as a compound `linked` group) into `oled ingest commit`. The harness posts them into the ledger and raises a question for anything it can't resolve confidently (unknown merchant, a lookalike account, uncategorized fallback, cross-currency row).
5. **Resolve**: the agent (or you) works through `oled questions` for whatever got raised.
6. **Close**: `oled ingest done <id>` closes the file out, and until it runs the file stays pending. When the statement prints a closing balance, pass it: `oled ingest done <id> --account <card-or-bank> --closing-balance <n>` refuses to close unless that account's balance in the ledger equals the statement's figure, so a misread amount surfaces instead of settling in. A first statement needs its opening balance posted as a row against `<currency>:equity:opening` for the two to agree.

## Commands

Run `oled --help` (or `oled <noun> --help`) for the full flag reference. Grouped overview:

```
oled                # Status: config, database, ledger counts, net worth (default)
oled doctor         # Diagnose the harness environment
oled setup          # Install the skill for an agent CLI (--dir <path>)
oled config         # OpenLedger configuration

oled ingest         # Ingest pipeline: list / prepare / commit / done / fail
oled files          # Browse ingested files (list / show / drop)

oled transactions   # Transactions: list / show / add / update / delete / recategorize / dedupe / merge
oled accounts       # Manage the chart of accounts
oled merchants      # Manage merchants and their default accounts
oled questions      # List, answer, and defer open questions

oled report         # Income, expenses, and networth
oled notes          # Manage freeform notes
oled datasets       # Reference datasets: institutions for the US, Japan, Thailand, China

oled open           # Open the data folder in file explorer
```

## The Typed Contract

Every command speaks NDJSON under `--json`: one JSON object per line, lists ending in a `{"type":"summary"}` row, and failures as a single `{"error":{...}}` line on stderr whose `code` matches the exit code. That wire format ships as code. `@aquartier/openledger/contract` exports a zod schema and a TypeScript type for every line each command can print, plus the `EXIT` table, the `ErrorEnvelope` schema, and `CONTRACT_VERSION`:

```ts
import { StatusReport, CONTRACT_VERSION } from "@aquartier/openledger/contract";

const status = StatusReport.parse(JSON.parse(line)); // line from `oled status --json`
if (status.contract_version !== CONTRACT_VERSION) {
  // Built against a different wire format: read the release notes before trusting shapes.
}
```

`oled status --json` stamps `contract_version` (currently 2), and it bumps whenever any command's JSON shape changes, additive or not. Exit codes are data too: `EXIT.BUSY` (8) means another process held the ledger, and the same command is safe to re-run unless the error carries `details.resume_from_index`. `ingest commit` sets it once rows have posted: re-run only the rows from that index, or rows without a stable id post twice.

## Security & Privacy

- All financial data stays on your machine; default `~/.oled/db.sqlite`. Both it and the config file are written with `0600` permissions.
- Statement passwords are never stored. The caller keeps them and passes one per run with `--password`, a command-line argument, so it shows up in shell history and process listings.
- A decrypted statement stays in memory. Only the extracted text, which an agent has to read, is written to `cache/`.
- Read commands mask PII in free-text fields by default; `--no-redact` returns verbatim text.
- No telemetry, no analytics. OpenLedger makes no network calls of its own.

## Configuration

OpenLedger reads one JSON config file per run and nothing else: no environment variables, no hidden state. The default file is `~/.oled/config.json`; `oled config [path]` reads and writes a named file directly, and every other command accepts `--config <path>` to run against it, so two config files are two independent ledgers. Commands that touch the ledger refuse to run until the file exists; `oled config --init` creates it, along with the database and data directory:

```
~/.oled/
  config.json    # all settings (0600 permissions)
  context.md     # persistent freeform context an agent can read (lives beside the config file)
  db.sqlite      # SQLite database (0600 permissions)
  data/          # drop your statements here, as PDF, PNG or JPEG files (subfolders allowed)
  cache/         # extracted text handed to an agent
```

### Config Properties

Each property is set with an `oled config` flag and read back with bare `oled config`. Values resolve file, then default. The database, data and cache directories default to the config file's directory. Path flags are stored as absolute paths: a relative one resolves against the directory you run the command from, and a hand-edited relative path resolves against the config file's directory. Read commands refuse to run when `context.md` exists but cannot be read, so redaction never silently weakens; pass `--no-redact` to bypass.

| Property | Flag | Meaning | Default |
| --- | --- | --- | --- |
| `country` | `--country` | Country whose reference data applies; also seeds locale and currency | `TH` |
| `displayLocale` | `--locale` | Locale used to format money | from country |
| `displayCurrency` | `--currency` | Display currency; also seeds that ledger's structural accounts | from country |
| `dbPath` | `--db` | Database file path | `<config dir>/db.sqlite` |
| `dataDir` | `--data-dir` | Statement drop folder | `<config dir>/data` |
| `cacheDir` | `--cache-dir` | Extracted text cache | `<config dir>/cache` |
| `userName` | `--user-name` | Your name; redaction masks it | `User` |

[`.env.example`](./.env.example) documents build-and-test variables only; the CLI reads no environment configuration.

## Contributing

```bash
git clone https://github.com/phureewat29/openledger
cd openledger
npm install
npm run build
npm link # makes 'oled' available globally
```

## License

OpenLedger is licensed under the [MIT License](./LICENSE).

The built-in OCR runs [OpenThai2.0-OCR-Text](https://huggingface.co/iapp/OpenThai2.0-OCR-Text) by iApp, licensed under Apache-2.0. Its notices, and those of the OpenCV, KleidiCV and Clipper code the OCR reproduces, are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
