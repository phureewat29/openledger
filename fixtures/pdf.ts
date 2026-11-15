/**
 * Hand-assembled, latin1-encoded so xref offsets are byte counts, not
 * character counts. Nothing here imports src/, except mupdf (only as the
 * writer `encryptedPDF` needs).
 */

export type PageKind = "text" | "short" | "logo" | "blank" | "image";

function buildPDF(objects: string[]): Buffer {
  const header = "%PDF-1.4\n";
  const bodies = objects.map((body, index) => `${index + 1} 0 obj${body}endobj\n`);

  const offsets: number[] = [];
  let cursor = Buffer.byteLength(header, "latin1");
  for (const body of bodies) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(body, "latin1");
  }

  const size = objects.length + 1;
  const xref =
    `xref\n0 ${size}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const trailer = `trailer<</Size ${size}/Root 1 0 R>>\nstartxref\n${cursor}\n%%EOF\n`;

  return Buffer.from(header + bodies.join("") + xref + trailer, "latin1");
}

function streamObject(content: string): string {
  return `<</Length ${Buffer.byteLength(content, "latin1")}>>stream\n${content}\nendstream`;
}

// 20 lines clears the 400-char text-layer bar the way a real statement page does; 3 lines is a short digital slip.
const TEXT_LINES = 20;
const SHORT_LINES = 3;

function textContent(page: number, lines = TEXT_LINES): string {
  let content = "BT /F1 11 Tf 36 756 Td 14 TL\n";
  for (let line = 0; line < lines; line++) {
    content += `(page${page} line ${String(line).padStart(2, "0")} 1234.56 THB DEBIT ACME) Tj T*\n`;
  }
  return `${content}ET\n`;
}

/**
 * An inline image (BI/ID/EI) with an ASCIIHex payload: a 2x2 bitmap stretched over the page,
 * like a scanned page looks to the probe. Its quadrants are red, green / blue, white.
 */
function imageContent(width: number, height: number): string {
  return (
    `q ${width} 0 0 ${height} 0 0 cm\n` +
    "BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID\n" +
    "ff0000 00ff00 0000ff ffffff>\nEI Q\n"
  );
}

/** A bank logo: the same 2x2 bitmap drawn 60x30 pt in the top-right corner, far under half the page. */
function logoContent(width: number, height: number): string {
  return `q 60 0 0 30 ${width - 96} ${height - 66} cm\n` + "BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID\n" + "ff0000 00ff00 0000ff ffffff>\nEI Q\n";
}

/** In points; the render tests read the size back out of the rasters they produce. */
interface PageSize {
  width: number;
  height: number;
}

export const LETTER: PageSize = { width: 612, height: 792 };

const CONTENT: Record<PageKind, (page: number, size: PageSize) => string> = {
  text: (page) => textContent(page),
  short: (page) => textContent(page, SHORT_LINES),
  logo: (page, size) => logoContent(size.width, size.height) + textContent(page, SHORT_LINES),
  blank: () => "\n",
  image: (_, size) => imageContent(size.width, size.height),
};

/** One PDF per page-kind list: object 1 is the catalog, 2 the page tree, then page+content pairs, then the font. */
export function pdfOf(kinds: PageKind[], size: PageSize = LETTER): Buffer {
  const firstPage = 3;
  const fontNumber = firstPage + kinds.length * 2;
  const kids = kinds.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${kinds.length}>>`,
  ];
  for (const [index, kind] of kinds.entries()) {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${size.width} ${size.height}]` +
        `/Resources<</Font<</F1 ${fontNumber} 0 R>>>>/Contents ${firstPage + index * 2 + 1} 0 R>>`,
    );
    objects.push(streamObject(CONTENT[kind](index + 1, size)));
  }
  objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  return buildPDF(objects);
}

export function textPDF(): Buffer {
  return pdfOf(["text"]);
}

export function scanPDF(): Buffer {
  return pdfOf(["image"]);
}

export function mixedPDF(): Buffer {
  return pdfOf(["text", "blank", "image"]);
}

/** Bytes mupdf refuses outright, for the pdf_unreadable arm. */
export function corruptPDF(): Buffer {
  return Buffer.from("%PDF-1.4\nnot really a pdf\n", "latin1");
}

export async function encryptedPDF(
  password: string,
  kinds: PageKind[] = ["text"],
): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdfOf(kinds), "application/pdf");
  try {
    // Encryption is a PDF-writer feature, so the fixture has to be a PDFDocument.
    if (!(doc instanceof mupdf.PDFDocument)) throw new Error("fixture is not a PDF document");
    const out = doc.saveToBuffer(
      `encrypt=aes-256,user-password=${password},owner-password=${password}`,
    );
    return Buffer.from(out.asUint8Array());
  } finally {
    doc.destroy();
  }
}
