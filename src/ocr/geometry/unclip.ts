/** Reproduces _unclip (pyclipper's round-joined offset of a box) as line_engine.py (Apache-2.0) calls it; see THIRD_PARTY_NOTICES.md. */

import { fma32, fma64 } from "./fma.js";
import type { Quad } from "./quad.js";

const f32 = Math.fround;

/** Clipper's default ArcTolerance, as pyclipper passes it. */
const ARC_TOLERANCE = 0.25;

/** cv2.contourArea on the float32 box: a double shoelace sum of exact float products. */
function contourArea(box: Quad): number {
  let area = 0;
  for (let i = 0, j = 3; i < 4; j = i++) area += box[2 * j] * box[2 * i + 1] - box[2 * j + 1] * box[2 * i];
  return Math.abs(area * 0.5);
}

/** cv2.arcLength(closed) on the float32 box: float32 sides, fused as cv2's arm64 build fuses dx*dx + dy*dy. */
function arcLength(box: Quad): number {
  let length = 0;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const dx = f32(box[2 * i] - box[2 * j]);
    const dy = f32(box[2 * i + 1] - box[2 * j + 1]);
    length += f32(Math.sqrt(fma32(dx, dx, f32(dy * dy))));
  }
  return length;
}

/** A C cast to a 64-bit integer: toward zero, and never -0. */
const toInt = (v: number): number => Math.trunc(v) + 0;

/** Clipper's Round: halves away from zero. */
const round = (v: number): number => toInt(v < 0 ? v - 0.5 : v + 0.5);

type Ring = number[];

/** ClipperOffset.AddPath: drops repeated closing and consecutive points; fewer than three left means no path. */
function offsetSource(path: Ring): Ring | undefined {
  let high = path.length / 2 - 1;
  while (high > 0 && path[0] === path[2 * high] && path[1] === path[2 * high + 1]) high--;
  const out = [path[0], path[1]];
  for (let i = 1; i <= high; i++) {
    const n = out.length;
    if (out[n - 2] !== path[2 * i] || out[n - 1] !== path[2 * i + 1]) out.push(path[2 * i], path[2 * i + 1]);
  }
  return out.length >= 6 ? out : undefined;
}

/** Clipper's signed Area: positive for the orientation its outer polygons carry. */
function area(ring: Ring): number {
  const n = ring.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (ring[2 * j] + ring[2 * i]) * (ring[2 * j + 1] - ring[2 * i + 1]);
  return -a * 0.5;
}

function reversed(ring: Ring): Ring {
  const out: Ring = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1]);
  return out;
}

/** ClipperOffset.DoOffset on one closed polygon with round joins, each product fused as pyclipper's build fuses it. */
function offsetRing(src: Ring, delta: number): Ring {
  const n = src.length / 2;
  const tolerance = ARC_TOLERANCE > delta * ARC_TOLERANCE ? delta * ARC_TOLERANCE : ARC_TOLERANCE;
  let steps = Math.PI / Math.acos(1 - tolerance / delta);
  if (steps > delta * Math.PI) steps = delta * Math.PI;
  const sin = Math.sin((2 * Math.PI) / steps);
  const cos = Math.cos((2 * Math.PI) / steps);
  const stepsPerRad = steps / (2 * Math.PI);
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const k = j + 1 < n ? j + 1 : 0;
    const dx = src[2 * k] - src[2 * j];
    const dy = src[2 * k + 1] - src[2 * j + 1];
    if (dx === 0 && dy === 0) continue;
    const f = 1 / Math.sqrt(dx * dx + dy * dy);
    nx[j] = dy * f;
    ny[j] = -(dx * f);
  }
  const out: Ring = [];
  const push = (j: number, x: number, y: number): void => {
    out.push(round(fma64(x, delta, src[2 * j])), round(fma64(y, delta, src[2 * j + 1])));
  };
  for (let j = 0, k = n - 1; j < n; j++) {
    let sinA = fma64(nx[k], ny[j], -(nx[j] * ny[k]));
    if (Math.abs(sinA * delta) < 1) {
      if (fma64(nx[k], nx[j], ny[j] * ny[k]) > 0) {
        push(j, nx[k], ny[k]);
        continue;
      }
    } else if (sinA > 1) sinA = 1;
    else if (sinA < -1) sinA = -1;
    if (sinA * delta < 0) {
      push(j, nx[k], ny[k]);
      out.push(src[2 * j], src[2 * j + 1]);
      push(j, nx[j], ny[j]);
    } else {
      const a = Math.atan2(sinA, fma64(nx[k], nx[j], ny[k] * ny[j]));
      const count = Math.max(round(stepsPerRad * Math.abs(a)), 1);
      let x = nx[k];
      let y = ny[k];
      for (let i = 0; i < count; i++) {
        push(j, x, y);
        const x2 = x;
        x = fma64(x, cos, -(sin * y));
        y = fma64(x2, sin, y * cos);
      }
      push(j, nx[j], ny[j]);
    }
    k = j;
  }
  return out;
}

const slopesEqual = (ring: Ring, a: number, b: number, c: number): boolean =>
  (ring[2 * a + 1] - ring[2 * b + 1]) * (ring[2 * b] - ring[2 * c]) ===
  (ring[2 * a] - ring[2 * b]) * (ring[2 * b + 1] - ring[2 * c + 1]);

/** Clipper.AddPath on a closed subject: strips repeated vertices and merges collinear edges, spikes included. */
function clipperSubject(ring: Ring): Ring | undefined {
  let high = ring.length / 2 - 1;
  const same = (a: number, b: number): boolean => ring[2 * a] === ring[2 * b] && ring[2 * a + 1] === ring[2 * b + 1];
  while (high > 0 && same(high, 0)) high--;
  while (high > 0 && same(high, high - 1)) high--;
  if (high < 2) return undefined;
  const next = Int32Array.from({ length: high + 1 }, (_, i) => (i === high ? 0 : i + 1));
  const prev = Int32Array.from({ length: high + 1 }, (_, i) => (i === 0 ? high : i - 1));
  const remove = (e: number): number => {
    next[prev[e]] = next[e];
    prev[next[e]] = prev[e];
    return next[e];
  };
  let start = 0;
  let e = 0;
  let loopStop = 0;
  for (;;) {
    if (same(e, next[e])) {
      if (e === next[e]) break;
      if (e === start) start = next[e];
      e = remove(e);
      loopStop = e;
      continue;
    }
    if (prev[e] === next[e]) break;
    if (slopesEqual(ring, prev[e], e, next[e])) {
      if (e === start) start = next[e];
      e = prev[remove(e)];
      loopStop = e;
      continue;
    }
    e = next[e];
    if (e === loopStop) break;
  }
  if (prev[e] === next[e]) return undefined;
  const out: Ring = [];
  let flat = true;
  let i = start;
  do {
    out.push(ring[2 * i], ring[2 * i + 1]);
    flat &&= ring[2 * i + 1] === ring[2 * start + 1];
    i = next[i];
  } while (i !== start);
  return flat ? undefined : out;
}

/**
 * Clipper's union with pftPositive on one simple ring: empty unless it winds positively, otherwise the ring itself
 * as its sweep emits it, ending at the topmost vertex (the rightmost of a tie).
 */
function union(ring: Ring): Ring | undefined {
  if (!(area(ring) > 0)) return undefined;
  const n = ring.length / 2;
  let top = 0;
  for (let i = 1; i < n; i++) {
    const y = ring[2 * i + 1];
    const topY = ring[2 * top + 1];
    if (y < topY || (y === topY && ring[2 * i] > ring[2 * top])) top = i;
  }
  const start = (top + 1) % n;
  return [...ring.slice(2 * start), ...ring.slice(0, 2 * start)];
}

/**
 * _unclip(box, ratio): the box offset outward by area * ratio / perimeter with round joins, point for point as
 * pyclipper returns it (corners truncated to integers on the way in, arc points rounded on the way out), as float32
 * x,y pairs; undefined where _unclip returns None.
 *
 * Exact for the boxes line_engine.py unclips: minAreaRect boxes whose short side is at least 3, so the truncated
 * quad stays convex and the union only orders the ring. Smaller or arbitrary quads can offset into tiny or
 * self-crossing rings that pyclipper's sweep trims or drops, and a zero-area box can come back from pyclipper as its
 * own truncated polygon; neither is reproduced here.
 */
export function unclip(box: Quad, ratio: number): Float32Array | undefined {
  const length = arcLength(box);
  if (length === 0) return undefined;
  const delta = (contourArea(box) * ratio) / length;
  const source = offsetSource(Array.from(box, toInt));
  if (!source || !(delta > 0)) return undefined;
  const subject = clipperSubject(offsetRing(area(source) >= 0 ? source : reversed(source), delta));
  const grown = subject && union(subject);
  return grown && Float32Array.from(grown);
}
