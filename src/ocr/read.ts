import { ok, type Result } from "../lib/result.js";
import { readPageText } from "./engine.js";
import type { Models } from "./models.js";
import type { Raster } from "./raster.js";
import { loadModels } from "./session.js";

/** Loads the bundled models once; a failure means a broken install, not a bad page. */
export const loadEngine = (): Promise<Result<Models>> => loadModels();

/** The page's text, lines in reading order joined by newlines. Only a load failure is a Result: any page throws only on a bug. */
export async function readPage(page: Raster): Promise<Result<string>> {
  const loaded = await loadModels();
  if (!loaded.ok) return loaded;
  return ok((await readPageText(page, loaded.value)).text);
}
