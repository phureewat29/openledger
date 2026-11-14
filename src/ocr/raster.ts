/** 8-bit pixels, row-major with no row padding. Three channels are BGR, the order the OCR models were trained on. */
export interface Raster {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array;
}
