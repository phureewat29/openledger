import { ok, type Result } from "../lib/result.js";
import type { TextLayer } from "../contract/ingest.js";
import type { Raster } from "../ocr/raster.js";
import { probePDFPages, type ProbedPage } from "./pdf.js";
import { decodeImage, renderPDFPage } from "./render.js";
import { READER, verdictOf, type Reader } from "./route.js";
import type { SourceKind } from "./source.js";

/** Reads one page's raster: the OCR engine at the composition root, a fake in tests. */
export type PageReader = (page: Raster) => Promise<Result<string>>;

export interface TextPage {
  page: number;
  text: string;
}

export interface Extraction {
  source: Reader;
  textLayer: TextLayer;
  pages: TextPage[];
}

type ExtractFailure = "pdf_unreadable" | "image_unreadable" | "ocr_unavailable";

type Failure = { ok: false; reason: ExtractFailure; message: string };
type PagesOutcome = { ok: true; value: TextPage[] } | Failure;
type ExtractOutcome = { ok: true; value: Extraction } | Failure;

export interface ExtractInput {
  kind: SourceKind;
  /** Decrypted already, for a password-protected PDF. */
  bytes: Buffer;
}

interface ExtractOptions {
  read: PageReader;
  /** Ignore the text layer, for a garbled or junk one. */
  rescan?: boolean;
}

/** How each source kind is probed for a text layer and drawn for OCR. */
interface Kind {
  probe: (bytes: Buffer) => Promise<Result<ProbedPage[]>>;
  render: (bytes: Buffer, page: number) => Promise<Result<Raster>>;
  /** What bytes mupdf cannot open or draw fail as. */
  unreadable: Exclude<ExtractFailure, "ocr_unavailable">;
}

/** An image is one scanned page with no text layer; mupdf would probe it as a resampled fake 96-dpi PDF. */
const IMAGE_PAGE: ProbedPage = { page: 1, chars: 0, imageCover: 1, text: "" };

const KINDS: Record<SourceKind, Kind> = {
  pdf: { probe: probePDFPages, render: renderPDFPage, unreadable: "pdf_unreadable" },
  image: { probe: async () => ok([IMAGE_PAGE]), render: decodeImage, unreadable: "image_unreadable" },
};

function failure(reason: ExtractFailure, message: string): Failure {
  return { ok: false, reason, message };
}

interface ReaderContext {
  input: ExtractInput;
  pages: readonly ProbedPage[];
  read: PageReader;
}

/** Render, read, release, one page at a time, so a long statement never holds every raster at once. */
async function readByOCR({ input, pages, read }: ReaderContext): Promise<PagesOutcome> {
  const { render, unreadable } = KINDS[input.kind];
  const texts: TextPage[] = [];
  for (const { page } of pages) {
    const raster = await render(input.bytes, page);
    if (!raster.ok) return failure(unreadable, raster.error);
    const text = await read(raster.value);
    if (!text.ok) return failure("ocr_unavailable", text.error);
    texts.push({ page, text: text.value });
  }
  return { ok: true, value: texts };
}

const READERS: Record<Reader, (context: ReaderContext) => Promise<PagesOutcome>> = {
  "text-layer": async ({ pages }) => ({ ok: true, value: pages.map(({ page, text }) => ({ page, text })) }),
  ocr: readByOCR,
};

export async function extractFile(input: ExtractInput, options: ExtractOptions): Promise<ExtractOutcome> {
  const kind = KINDS[input.kind];
  const probed = await kind.probe(input.bytes);
  if (!probed.ok) return failure(kind.unreadable, probed.error);

  const textLayer = options.rescan ? "none" : verdictOf(probed.value);
  const source = READER[textLayer];
  const pages = await READERS[source]({ input, pages: probed.value, read: options.read });
  if (!pages.ok) return pages;
  return { ok: true, value: { source, textLayer, pages: pages.value } };
}
