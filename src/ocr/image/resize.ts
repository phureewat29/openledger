/** Reproduces cv2.resize INTER_LINEAR as line_engine.py (Apache-2.0) calls it; see THIRD_PARTY_NOTICES.md. */

import type { Raster } from "../raster.js";
import { isKleidiCVResize, resizeKleidiCV } from "./resize-kleidicv.js";
import { resizeLinearOpenCV } from "./resize-opencv.js";

type ResizePath = "copy" | "kleidicv" | "opencv";

const RESIZE: Record<ResizePath, (src: Raster, width: number, height: number) => Raster> = {
  copy: (src) => ({ ...src, data: src.data.slice() }),
  kleidicv: resizeKleidiCV,
  opencv: resizeLinearOpenCV,
};

/**
 * cv::resize copies at the same size, then asks the KleidiCV HAL; carotene declines three channels, so OpenCV's own
 * code takes the rest. Its swap of an exact halving to INTER_AREA needs no path: the linear weights give the same bytes.
 */
function resizePath(src: Raster, width: number, height: number): ResizePath {
  if (width === src.width && height === src.height) return "copy";
  if (isKleidiCVResize(src.width, src.height, width, height)) return "kleidicv";
  return "opencv";
}

/** cv2.resize(src, (width, height)) on uint8 BGR, byte for byte as the KleidiCV-enabled arm64 build computes it. */
export function resizeLinear(src: Raster, width: number, height: number): Raster {
  if (src.channels !== 3) throw new Error(`resizeLinear takes 3 channels, got ${src.channels}`);
  if (!(width >= 1 && height >= 1)) throw new Error(`resizeLinear needs a positive size, got ${width}x${height}`);
  return RESIZE[resizePath(src, width, height)](src, width, height);
}
