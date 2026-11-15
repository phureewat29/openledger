import { range } from "es-toolkit";
import type { Document, StructuredText } from "mupdf";
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

function hasImageBlock(stext: StructuredText): boolean {
  let found = false;
  stext.walk({
    onImageBlock: () => {
      found = true;
    },
  });
  return found;
}

function probeOne(doc: Document, index: number): ProbedPage {
  return destroyAfter(doc.loadPage(index), (page) =>
    destroyAfter(page.toStructuredText(STEXT_FLAGS), (stext) => {
      const text = stext.asText().replace(/\n{3,}/g, "\n\n").trim();
      return { page: index + 1, chars: text.length, hasImage: hasImageBlock(stext), text };
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
