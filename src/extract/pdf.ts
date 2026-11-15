import { clamp, range, sumBy } from "es-toolkit";
import type { Document, Rect, StructuredText } from "mupdf";
import { tryExecute, type Result } from "../lib/result.js";
import type { PageFacts } from "./route.js";

type Mupdf = typeof import("mupdf");

/** Lazy: the WASM module isn't loaded until first call; ESM caches the import. */
export const loadMupdf = (): Promise<Mupdf> => import("mupdf");

export const PDF_MIME = "application/pdf";

/** Frees the object's WASM memory as soon as `use` returns or throws, rather than whenever GC finalizes it. */
export function destroyAfter<T extends { destroy(): void }, R>(value: T, use: (value: T) => R): R {
  try {
    return use(value);
  } finally {
    value.destroy();
  }
}

/** mupdf's authenticatePassword returns 0 on a wrong password, non-zero on success. */
const MUPDF_AUTH_FAILED = 0;

export type UnlockFailureReason = "unsupported_document" | "wrong_password";

type UnlockResult = { ok: true; decrypted: Buffer } | { ok: false; reason: UnlockFailureReason };

export async function isEncryptedPDF(bytes: Buffer): Promise<boolean> {
  const mupdf = await loadMupdf();
  return destroyAfter(mupdf.Document.openDocument(bytes, PDF_MIME), (doc) => doc.needsPassword());
}

export async function unlockPDF(bytes: Buffer, password: string): Promise<UnlockResult> {
  const mupdf = await loadMupdf();
  return destroyAfter(mupdf.Document.openDocument(bytes, PDF_MIME), (doc): UnlockResult => {
    if (!(doc instanceof mupdf.PDFDocument)) return { ok: false, reason: "unsupported_document" };
    if (!doc.needsPassword()) return { ok: true, decrypted: bytes };
    if (doc.authenticatePassword(password) === MUPDF_AUTH_FAILED) return { ok: false, reason: "wrong_password" };
    return { ok: true, decrypted: Buffer.from(doc.saveToBuffer("encrypt=none").asUint8Array()) };
  });
}

/** `text` is the extraction itself, not a sample. */
export interface ProbedPage extends PageFacts {
  page: number;
  text: string;
}

/** preserve-images makes image blocks visible to the walker; without it a scan looks blank. */
const STEXT_FLAGS = "preserve-whitespace,preserve-images";

const area = ([x0, y0, x1, y1]: Rect): number => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

const clipTo = ([x0, y0, x1, y1]: Rect, [bx0, by0, bx1, by1]: Rect): Rect => [
  Math.max(x0, bx0),
  Math.max(y0, by0),
  Math.min(x1, bx1),
  Math.min(y1, by1),
];

/** Overlapping images count twice, which only errs toward calling a page a scan. */
function imageCover(stext: StructuredText, bounds: Rect): number {
  const images: Rect[] = [];
  stext.walk({ onImageBlock: (bbox) => void images.push(clipTo(bbox, bounds)) });
  const pageArea = area(bounds);
  return pageArea > 0 ? clamp(sumBy(images, area) / pageArea, 0, 1) : 0;
}

function probeOne(doc: Document, index: number): ProbedPage {
  return destroyAfter(doc.loadPage(index), (page) =>
    destroyAfter(page.toStructuredText(STEXT_FLAGS), (stext) => {
      const text = stext.asText().replace(/\n{3,}/g, "\n\n").trim();
      return { page: index + 1, chars: text.length, imageCover: imageCover(stext, page.getBounds()), text };
    }),
  );
}

/** Measures and extracts the text layer in one pass, so no page opens twice. */
export async function probePDFPages(bytes: Buffer): Promise<Result<ProbedPage[]>> {
  const mupdf = await loadMupdf();
  return tryExecute(() =>
    destroyAfter(mupdf.Document.openDocument(bytes, PDF_MIME), (doc) =>
      range(doc.countPages()).map((index) => probeOne(doc, index)),
    ),
  );
}
