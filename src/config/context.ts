import { readFileSync, writeFileSync, existsSync } from "fs";
import { map, ok, tryExecute, type Result } from "../lib/result.js";
import { decodeUserText } from "../lib/text.js";
import { chmod600 } from "../lib/perms.js";

/** A missing file is empty context; an unreadable one is an error, so redaction never runs without its terms. */
export function readContext(contextPath: string): Result<string> {
  if (!existsSync(contextPath)) return ok("");
  const read = tryExecute(() => decodeUserText(readFileSync(contextPath)));
  // A Windows editor's CRLF would break the redactor's `\n`-anchored sections and silently skip PII.
  return map(read, (text) => text.replace(/\r\n/g, "\n"));
}

/** The config dir must already exist; `saveConfig` creates it. */
export function createContextTemplate(contextPath: string, userName: string): void {
  if (existsSync(contextPath)) return;
  // Family is for OTHER people; seeding it with the user's own name would let the
  // redactor promote it into a [PARTNER] term and rewrite unrelated text.
  writeFileSync(
    contextPath,
    `# OpenLedger context for ${userName}\n\n## Family\n(add family members as "- Name (relation)" lines)\n\n## Income\n- (Optional: add your primary income source so OpenLedger can mark it as PII when sending data to the model.)\n\n## Notes\n- (Free-form notes about your accounts, bank preferences, or anything OpenLedger should keep in mind when ingesting.)\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
  chmod600(contextPath);
}
