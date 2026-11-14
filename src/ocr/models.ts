/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

/** A float32 tensor and its dimensions, row-major. */
export interface Tensor {
  data: Float32Array;
  dims: readonly number[];
}

/** The two networks as the pipeline sees them; the session module binds them to the runtime. */
export interface Models {
  /** 1x3xHxW normalised page in, 1x1xHxW text probability out. */
  detect(input: Tensor): Promise<Tensor>;
  /** Nx3x48xW normalised lines in, NxTxC class probabilities out. */
  recognize(input: Tensor): Promise<Tensor>;
  /** CTC classes: blank, the dictionary, then the space the trainer appends. */
  charset: readonly string[];
}
