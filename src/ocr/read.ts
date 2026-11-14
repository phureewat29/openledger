import { once } from "es-toolkit";
import { map, ok, type Result } from "../lib/result.js";
import { readPageText } from "./engine.js";
import type { Raster } from "./raster.js";
import { loadModels } from "./session.js";

export interface OCREngine {
  read(page: Raster): Promise<string>;
}

const engine = once(async (): Promise<Result<OCREngine>> =>
  map(await loadModels(), (models) => ({ read: async (page: Raster) => (await readPageText(page, models)).text })),
);

/** Loads the bundled models once; a failure means a broken install, not a bad page. */
export function loadEngine(): Promise<Result<OCREngine>> {
  return engine();
}

/** The page's text, lines in reading order joined by newlines. Only a load failure is a Result: any page throws only on a bug. */
export async function readPage(page: Raster): Promise<Result<string>> {
  const loaded = await loadEngine();
  if (!loaded.ok) return loaded;
  return ok(await loaded.value.read(page));
}
