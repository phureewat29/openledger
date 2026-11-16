export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const NORMAL: Orientation = 1;
const SOI = 0xffd8;
const APP1 = 0xe1;
const SOS = 0xda;
const EXIF_HEADER = "Exif\0\0";
const ORIENTATION_TAG = 0x0112;
const ENTRY_BYTES = 12;
const ENTRY_VALUE_AT = 8;
const FIRST_ORIENTATION = 1;
const LAST_ORIENTATION = 8;

/** Markers that carry no length: TEM, RSTn and SOI. */
const isStandalone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

const u16 = (bytes: Uint8Array, at: number, little: boolean): number | undefined =>
  at >= 0 && at + 2 <= bytes.length ? (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]) : undefined;

const u32 = (bytes: Uint8Array, at: number, little: boolean): number | undefined => {
  const a = u16(bytes, at, little);
  const b = u16(bytes, at + 2, little);
  if (a === undefined || b === undefined) return undefined;
  return little ? (b * 0x10000 + a) : (a * 0x10000 + b);
};

/** `tiff` begins at the byte-order mark; the orientation is the SHORT in IFD0 under tag 0x0112. */
function orientationInTIFF(tiff: Uint8Array): number | undefined {
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  if (u16(tiff, 2, little) !== 42) return undefined;
  const ifd = u32(tiff, 4, little);
  const count = ifd === undefined ? undefined : u16(tiff, ifd, little);
  if (ifd === undefined || count === undefined) return undefined;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * ENTRY_BYTES;
    if (u16(tiff, entry, little) === ORIENTATION_TAG) return u16(tiff, entry + ENTRY_VALUE_AT, little);
  }
  return undefined;
}

function exifSegment(bytes: Uint8Array): Uint8Array | undefined {
  if (u16(bytes, 0, false) !== SOI) return undefined;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (isStandalone(marker)) {
      at += 2;
      continue;
    }
    if (marker === SOS) return undefined;
    const length = u16(bytes, at + 2, false) ?? 0;
    if (length < 2) return undefined;
    const body = bytes.subarray(at + 4, at + 2 + length);
    if (marker === APP1 && Buffer.from(body.subarray(0, EXIF_HEADER.length)).toString("latin1") === EXIF_HEADER) {
      return body.subarray(EXIF_HEADER.length);
    }
    at += 2 + length;
  }
  return undefined;
}

/** EXIF orientation of a JPEG, 1 (upright) when the tag is absent or the bytes are malformed. */
export function exifOrientation(jpeg: Uint8Array): Orientation {
  const tiff = exifSegment(jpeg);
  const value = tiff && orientationInTIFF(tiff);
  if (value === undefined || value < FIRST_ORIENTATION || value > LAST_ORIENTATION) return NORMAL;
  return value as Orientation;
}
