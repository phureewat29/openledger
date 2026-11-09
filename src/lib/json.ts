import { tryExecute, unwrapOr } from "./result.js";

/** For reads where a missing or corrupt blob should degrade to "nothing". Callers needing to tell absent from corrupt apart should parse explicitly instead. */
export function parseJSONOrNull(raw: string | null | undefined): unknown | null {
  if (raw == null) return null;
  return unwrapOr(tryExecute((): unknown => JSON.parse(raw)), null);
}
