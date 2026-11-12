/** Decodes user-authored text (config.json, context.md, stdin/--input rows).
 *  PowerShell 5.1's `>` redirect writes UTF-16LE and Windows editors prepend
 *  BOMs, so the BOM picks the decode and the decoded U+FEFF is stripped. */
export function decodeUserText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBOM(bytes.subarray(2).toString("utf16le"));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Copied first: swap16 mutates, and the subarray aliases the caller's buffer.
    return stripBOM(Buffer.from(bytes.subarray(2)).swap16().toString("utf16le"));
  }
  return stripBOM(bytes.toString("utf8"));
}

function stripBOM(text: string): string {
  return text.replace(/^\uFEFF/, "");
}
