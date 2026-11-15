import type { PrepareResult, TextLayer } from "../contract/ingest.js";

export type Reader = PrepareResult["source"];

/**
 * File kind isn't an axis: an image probes as one scanned page and routes like a scan.
 * A partial layer is read whole by OCR, so every page of a document cites one source.
 */
export const READER: Record<TextLayer, Reader> = {
  complete: "text-layer",
  partial: "ocr",
  none: "ocr",
};

type PageContent = "text" | "scan" | "blank";

/** `hasImage` needs mupdf's `preserve-images`. */
export interface PageFacts {
  chars: number;
  hasImage: boolean;
}

/** Biased toward waste over loss: a junk text layer under this bar still counts as a scan. */
const PAGE_TEXT_CHARS = 400;

export function classifyPage(page: PageFacts): PageContent {
  if (page.chars >= PAGE_TEXT_CHARS) return "text";
  return page.hasImage ? "scan" : "blank";
}

/** A blank trailer page doesn't spoil "complete"; one scanned page among text pages makes it "partial". */
export function verdictOf(pages: readonly PageFacts[]): TextLayer {
  const contents = pages.map(classifyPage);
  if (!contents.includes("text")) return "none";
  return contents.includes("scan") ? "partial" : "complete";
}
