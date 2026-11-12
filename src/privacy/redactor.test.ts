import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor, prepareRedaction, type RedactionSource } from "./redactor.js";
import { ContextUnreadableError } from "../db/errors.js";

const CONTEXT = `## Family
- Partner: Corgi
- User

## Income
- 80,000 THB/month from Zentry Thailand Co.
`;

const redact = createRedactor("Alpaca Beagle", CONTEXT);

const HERE = fileURLToPath(new URL(".", import.meta.url));

// No context.md at this path: allowlisting is exercised with the user's name and numeric PII alone.
const SOURCE: RedactionSource = { userName: "Alpaca Beagle", contextPath: join(HERE, "no-context.md") };

describe("createRedactor (masking patterns)", () => {
  it("redacts user full name", () => {
    expect(redact("Alpaca Beagle sent 1,000 baht")).toBe("[USER] sent 1,000 baht");
  });

  it("redacts user first and last names", () => {
    expect(redact("Hi Alpaca, Mr. Beagle")).toBe("Hi [USER_FIRST], Mr. [USER_LAST]");
  });

  it("matches terms literally, never as regex patterns", () => {
    // "Zentry Thailand Co." ends in a regex special; unescaped, the dot would also match "CoX".
    expect(redact("Zentry Thailand CoX invoice")).toBe("Zentry Thailand CoX invoice");
  });

  it("redacts employer", () => {
    expect(redact("Salary from Zentry Thailand Co.")).toBe(
      "Salary from [EMPLOYER]",
    );
  });

  it("redacts Thai national ID with dashes", () => {
    expect(redact("ID: 1-2345-67890-12-3")).toBe("ID: [NATID]");
  });

  it("redacts Thai national ID without dashes", () => {
    expect(redact("ID 1234567890123 issued")).toBe("ID [NATID] issued");
  });

  it("redacts Thai mobile numbers", () => {
    expect(redact("Call 0812345678 for assistance")).toBe(
      "Call [PHONE] for assistance",
    );
  });

  it("redacts 16-digit credit card numbers", () => {
    expect(redact("Card 4111 1111 1111 1111")).toBe("Card [CARD]");
  });

  it("leaves clean text alone", () => {
    expect(redact("The weather is hot in Bangkok today")).toBe(
      "The weather is hot in Bangkok today",
    );
  });

  it("never rewrites a path: the default name is not a term, and terms respect boundaries", () => {
    // The context's Family section carries "- User", which must not become a term.
    expect(redact("/Users/phureewat/.oled/db.sqlite")).toBe("/Users/phureewat/.oled/db.sqlite");
  });

  it("redacts a partner name from context, whole words only: Corgi inside Corgis stays put", () => {
    expect(redact("Payment to Corgi")).toBe("Payment to [PARTNER]");
    expect(redact("Corgis are a breed")).toBe("Corgis are a breed");
  });
});

describe("prepareRedaction (field allowlisting)", () => {
  it("is an identity no-op when disabled", () => {
    const data = { memo: "call 0812345678", account_id: "asset:kbank" };
    expect(prepareRedaction(false, SOURCE)(data, ["memo"])).toBe(data);
  });

  it("redacts allowlisted string fields but leaves other fields verbatim", () => {
    const row = {
      account_id: "asset:0812345678", // would match [PHONE] but is NOT allowlisted
      memo: "refund to 0812345678",
      currency: "THB",
    };
    const out = prepareRedaction(true, SOURCE)(row, ["memo"]);
    expect(out.memo).toBe("refund to [PHONE]");
    // ids/enums must survive untouched even when they contain digits.
    expect(out.account_id).toBe("asset:0812345678");
    expect(out.currency).toBe("THB");
  });

  it("deep-walks nested objects and arrays", () => {
    const detail = {
      id: "e:1",
      description: "salary 1-2345-67890-12-3",
      entries: [
        { id: "e:2", account_id: "asset:kbank", memo: "card 4111 1111 1111 1111" },
        { id: "e:3", account_id: "expense:food", memo: null },
      ],
    };
    const out = prepareRedaction(true, SOURCE)(detail, ["description", "memo"]);
    expect(out.description).toBe("salary [NATID]");
    expect(out.entries[0].memo).toBe("card [CARD]");
    expect(out.entries[0].account_id).toBe("asset:kbank");
    expect(out.entries[1].memo).toBeNull();
    expect(out.id).toBe("e:1");
  });

  it("does not mutate the input", () => {
    const row = { memo: "0812345678" };
    const out = prepareRedaction(true, SOURCE)(row, ["memo"]);
    expect(row.memo).toBe("0812345678");
    expect(out.memo).toBe("[PHONE]");
  });

  it("redacts the user's name with no context.md at all", () => {
    expect(prepareRedaction(true, SOURCE)({ text: "Alpaca Beagle" }, ["text"]).text).toBe("[USER]");
  });
});

describe("prepareRedaction (fail closed)", () => {
  // A directory at the path is the portable stand-in for EACCES: it fails even as root.
  const unreadable: RedactionSource = { userName: "Alpaca Beagle", contextPath: HERE };

  it("refuses to run when context.md exists but cannot be read, with a type the exit contract maps", () => {
    const run = () => prepareRedaction(true, unreadable)({ text: "Corgi" }, ["text"]);
    expect(run).toThrow(ContextUnreadableError);
    expect(run).toThrow(/cannot read .*so redaction cannot run$/);
  });

  it("never reads context.md when redaction is off", () => {
    const data = { text: "Corgi" };
    expect(prepareRedaction(false, unreadable)(data, ["text"])).toBe(data);
  });
});
