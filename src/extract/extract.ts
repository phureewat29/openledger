import { map, ok, type Result } from "../lib/result.js";
import {
  isServerFailure,
  ocrPages,
  resolveServedModel,
  type OCRPageOutcome,
  type OCRSettings,
  type ServerFailure,
} from "./ocr.js";
import {
  DEFAULT_RENDER,
  probePDFPages,
  renderPDFPages,
  type PageImage,
  type ProbedPage,
  type RenderSpec,
} from "./pdf.js";
import { readerFor, verdictOf, type Reader } from "./route.js";
import type { SourceKind } from "./source.js";
import type { PrepareImagesResult, PrepareTextResult, TextLayer } from "../contract/ingest.js";

export interface TextPage {
  page: number;
  text: string;
}

export type Extraction =
  | {
      kind: "text";
      source: PrepareTextResult["source"];
      textLayer: TextLayer;
      model?: string;
      pages: TextPage[];
      failedPages: number[];
    }
  | {
      kind: "images";
      source: PrepareImagesResult["source"];
      textLayer: TextLayer;
      dpi?: number;
      pages: PageImage[];
    };

type ExtractOutcome =
  | { ok: true; value: Extraction }
  | { ok: false; reason: "pdf_unreadable" | "ocr_unreachable" | "ocr_rejected"; message: string };

export interface ExtractInput {
  kind: SourceKind;
  mime: string;
  /** Decrypted already, for a password-protected PDF. */
  bytes: Buffer;
  path: string;
}

interface ExtractOverrides {
  /** Ignore the text layer. */
  rescan?: boolean;
  /** Ignore the endpoint, and read the images yourself. */
  noOCR?: boolean;
}

interface ExtractOptions {
  ocr: OCRSettings | null;
  overrides?: ExtractOverrides;
}

const SERVER_FAILURE: Record<ServerFailure, "ocr_unreachable" | "ocr_rejected"> = {
  unreachable: "ocr_unreachable",
  rejected: "ocr_rejected",
};

// Images have no text layer; mupdf would resample a bare image as a fake 96-dpi PDF.
async function probe(input: ExtractInput): Promise<Result<ProbedPage[]>> {
  if (input.kind === "image") return ok([]);
  return probePDFPages(input.bytes);
}

interface PageImages {
  source: PrepareImagesResult["source"];
  dpi?: number;
  pages: PageImage[];
}

async function pageImages(input: ExtractInput, spec: RenderSpec): Promise<Result<PageImages>> {
  if (input.kind === "image") {
    return ok({ source: "original", pages: [{ page: 1, mime: input.mime, bytes: input.bytes }] });
  }
  return map(
    await renderPDFPages(input.bytes, spec),
    (pages): PageImages => ({ source: "raster", dpi: spec.dpi, pages }),
  );
}

function placeholder(page: number): string {
  return `[page ${page}: OCR failed]`;
}

/** A failed page is a hole in the document; the caller reports `failedPages` and exits PARTIAL. */
function ocrExtraction(
  outcomes: OCRPageOutcome[],
  settings: OCRSettings,
  textLayer: TextLayer,
): ExtractOutcome {
  const serverFailure = outcomes.find(
    (outcome): outcome is Extract<OCRPageOutcome, { ok: false }> & { reason: ServerFailure } =>
      !outcome.ok && isServerFailure(outcome.reason),
  );
  if (serverFailure) {
    return {
      ok: false,
      reason: SERVER_FAILURE[serverFailure.reason],
      message: `page ${serverFailure.page}: ${serverFailure.message}`,
    };
  }
  return {
    ok: true,
    value: {
      kind: "text",
      source: "ocr",
      textLayer,
      model: settings.model,
      pages: outcomes.map((outcome) => ({
        page: outcome.page,
        text: outcome.ok ? outcome.text : placeholder(outcome.page),
      })),
      failedPages: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.page),
    },
  };
}

interface ReaderContext {
  input: ExtractInput;
  textLayer: TextLayer;
  pages: readonly ProbedPage[];
  ocr: OCRSettings | null;
}

async function agentRead({ input, textLayer }: ReaderContext): Promise<ExtractOutcome> {
  const images = await pageImages(input, DEFAULT_RENDER);
  if (!images.ok) return { ok: false, reason: "pdf_unreadable", message: images.error };
  return { ok: true, value: { kind: "images", textLayer, ...images.value } };
}

const READERS: Record<Reader, (context: ReaderContext) => Promise<ExtractOutcome>> = {
  "text-layer": async ({ textLayer, pages }) => ({
    ok: true,
    value: {
      kind: "text",
      source: "text-layer",
      textLayer,
      pages: pages.map(({ page, text }) => ({ page, text })),
      failedPages: [],
    },
  }),
  agent: agentRead,
  ocr: async (context) => {
    if (!context.ocr) throw new Error(`reader "ocr" selected with no OCR settings configured`);
    // Resolved before rendering: the served id picks the card, and the card carries the render spec.
    const resolved = await resolveServedModel(context.ocr);
    const images = await pageImages(context.input, resolved.render);
    if (!images.ok) return { ok: false, reason: "pdf_unreadable", message: images.error };
    return ocrExtraction(await ocrPages(images.value.pages, resolved), resolved, context.textLayer);
  },
};

export async function extractFile(
  input: ExtractInput,
  options: ExtractOptions,
): Promise<ExtractOutcome> {
  const probed = await probe(input);
  if (!probed.ok) return { ok: false, reason: "pdf_unreadable", message: probed.error };

  const overrides = options.overrides ?? {};
  const ocr = overrides.noOCR ? null : options.ocr;
  const textLayer = overrides.rescan ? "none" : verdictOf(probed.value);
  const reader = readerFor(textLayer, ocr ? "ready" : "unset");
  return READERS[reader]({ input, textLayer, pages: probed.value, ocr });
}
