/** The OCR slice's only I/O: the bundled model files and the ONNX runtime. */

import { once } from "es-toolkit";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InferenceSession } from "onnxruntime-web";
import { tryExecute, type Result } from "../lib/result.js";
import type { Models, Tensor } from "./models.js";

/** Two levels below the package root under both tsx (src/ocr/) and the dist build. */
const MODEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../models/ocr");

/** Outputs are bit-identical at any thread count; three was the measured knee (1.09 s/page vs 2.47 at one, +15 % CPU); eight ran slower than two. */
const THREADS = Math.min(3, availableParallelism());

type ONNXRuntime = typeof import("onnxruntime-web");

/** Lazy: the WASM runtime isn't loaded until OCR runs; ESM caches the import. */
const loadRuntime = (): Promise<ONNXRuntime> => import("onnxruntime-web");

const SESSION_OPTIONS: InferenceSession.SessionOptions = {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
  logSeverityLevel: 3,
  /** Spinning idle threads cost both CPU time and speed at every thread count measured. */
  extra: { session: { intra_op: { allow_spinning: "0" } } },
};

async function openModels(): Promise<Models> {
  const ort = await loadRuntime();
  ort.env.wasm.numThreads = THREADS;
  ort.env.logLevel = "error";
  const [detector, recognizer, dictionary] = await Promise.all([
    readFile(resolve(MODEL_DIR, "det.onnx")).then((bytes) => ort.InferenceSession.create(bytes, SESSION_OPTIONS)),
    readFile(resolve(MODEL_DIR, "rec.onnx")).then((bytes) => ort.InferenceSession.create(bytes, SESSION_OPTIONS)),
    readFile(resolve(MODEL_DIR, "rec_dict.txt"), "utf8"),
  ]);
  const run =
    (session: InferenceSession) =>
    async (input: Tensor): Promise<Tensor> => {
      const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input.data, input.dims) };
      const output = (await session.run(feeds))[session.outputNames[0]];
      return { data: output.data as Float32Array, dims: output.dims };
    };
  return {
    detect: run(detector),
    recognize: run(recognizer),
    charset: ["", ...dictionary.split("\n").filter(Boolean), " "],
  };
}

/** Opened once per process; a failure means a broken install, and it stays cached. */
export const loadModels = once((): Promise<Result<Models>> => tryExecute(openModels));
