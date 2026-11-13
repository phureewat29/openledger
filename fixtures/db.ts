import Database from "libsql";
import { migrate } from "../src/db/schema.js";
import { createAccount, ensureLedgerRoot, isLedgerRootId } from "../src/accounts/accounts.js";
import { humanizeSegment } from "../src/accounts/resolve.js";
import { isAccountType, type CreateAccountInput } from "../src/accounts/queries.js";
import { currencyOf, typeFromId } from "../src/lib/ids.js";

/** Foreign keys are ON: sqlite defaults them off, and the schema's cascades are what many of these tests assert. */
export function freshDB(seed?: (db: Database.Database) => void): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed?.(db);
  return db;
}

type SeedAccountInput = Partial<CreateAccountInput> & { id: string };

/**
 * Derives type, parent, and name from the id. Pass anything a test asserts
 * on directly. A refusal throws.
 */
export function seedAccount(db: Database.Database, account: SeedAccountInput): string {
  const segments = account.id.split(":");
  const derived = typeFromId(account.id);
  const type = account.type ?? (isAccountType(derived) ? derived : null);
  if (!type) throw new Error(`seedAccount("${account.id}"): no account type in the id`);

  // A root's derived parent would be the bare currency, which is not an account.
  if (account.parent_id === undefined && isLedgerRootId(account.id)) {
    ensureLedgerRoot(db, currencyOf(account.id), type);
    return account.id;
  }

  const result = createAccount(db, {
    ...account,
    type,
    name: account.name ?? humanizeSegment(segments[segments.length - 1]),
    parent_id: account.parent_id ?? segments.slice(0, -1).join(":"),
  });
  if (!result.ok) throw new Error(`seedAccount("${account.id}"): ${result.message}`);
  return account.id;
}

/**
 * A database whose `run` of a statement starting with `sqlPrefix` fails like a
 * full disk or revoked handle would, when `shouldFail` accepts its parameters.
 * Every other statement runs untouched.
 */
function failingRun(
  db: Database.Database,
  sqlPrefix: string,
  shouldFail: (params: unknown[]) => boolean,
): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith(sqlPrefix)) return statement;
        return {
          run: (...params: unknown[]) => {
            if (shouldFail(params)) throw new Error("disk I/O error");
            return statement.run(...params);
          },
        };
      };
    },
  }) as Database.Database;
}

/** The account INSERT fails for ids under `idPrefix`, simulating a write failure mid-walk. */
export function failingAccountInsert(
  db: Database.Database,
  idPrefix: string,
): Database.Database {
  return failingRun(
    db,
    "INSERT INTO accounts",
    (params) => typeof params[0] === "string" && params[0].startsWith(idPrefix),
  );
}

/** Every `run` of a statement whose SQL starts with `sqlPrefix` fails. */
export function failingStatement(db: Database.Database, sqlPrefix: string): Database.Database {
  return failingRun(db, sqlPrefix, () => true);
}

/** `hook` runs just before the `nth` top-level `BEGIN IMMEDIATE` `db` issues, as another process's write could. */
export function onBegin(
  db: Database.Database,
  nth: number,
  hook: () => void,
): Database.Database {
  let opened = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (sql: string) => {
          if (sql === "BEGIN IMMEDIATE" && ++opened === nth) hook();
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database.Database;
}

interface ContendedLedger {
  /** Waits only CONTENDED_BUSY_TIMEOUT_MS for a lock before SQLITE_BUSY. */
  db: Database.Database;
  release(): void;
}

const CONTENDED_BUSY_TIMEOUT_MS = 50;

/**
 * A file-backed ledger where a second connection takes the write lock just before
 * the `nth` top-level transaction opens, the way another `oled` process would
 * between two batch items. Nested transactions join and are not counted.
 */
export function ledgerLockedAtTransaction(
  dbPath: string,
  nth: number,
  seed?: (db: Database.Database) => void,
): ContendedLedger {
  const raw = new Database(dbPath, { timeout: CONTENDED_BUSY_TIMEOUT_MS });
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  migrate(raw);
  seed?.(raw);

  const holder = new Database(dbPath);
  const db = onBegin(raw, nth, () => holder.exec("BEGIN IMMEDIATE"));

  return {
    db,
    release: () => {
      if (holder.inTransaction) holder.exec("ROLLBACK");
      holder.close();
      raw.close();
    },
  };
}
