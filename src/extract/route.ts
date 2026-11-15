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

/** `imageCover` is the share of the page under image blocks, 0 to 1; it needs mupdf's `preserve-images`. */
export interface PageFacts {
  chars: number;
  imageCover: number;
}

/** A text layer this long is trusted whatever lies under it. */
const PAGE_TEXT_CHARS = 400;

/** An image over half the page is the page: a thin text layer on it is a scanner's, not the document's. */
const SCAN_COVER = 0.5;

/**
 * OCR re-reads what a short digital layer already holds exactly, and reads it worse, so a short layer
 * beside a logo or on a bare page is text. A page is a scan when an image carries it, or holds nothing else.
 */
export function classifyPage({ chars, imageCover }: PageFacts): PageContent {
  if (chars >= PAGE_TEXT_CHARS) return "text";
  if (imageCover >= SCAN_COVER) return "scan";
  if (chars > 0) return "text";
  return imageCover > 0 ? "scan" : "blank";
}

/** A blank trailer page doesn't spoil "complete"; one scanned page among text pages makes it "partial". */
export function verdictOf(pages: readonly PageFacts[]): TextLayer {
  const contents = pages.map(classifyPage);
  if (!contents.includes("text")) return "none";
  return contents.includes("scan") ? "partial" : "complete";
}
