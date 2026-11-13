Golden fixtures for the TypeScript port of the OpenThai2.0-OCR-Text runtime (iapp/OpenThai2.0-OCR-Text, HF commit 40e8e9ff).
Thirteen synthetic pages (`<name>.png`, invented data, OFL fonts Sarabun and Noto Sans Thai/Noto Sans) each with a golden `<name>.json` from the vendor `LineOCR(model_dir, threads=1)` on ONNX Runtime CPU, with the model's own config.json (drop_below 0.8, min_chars 2).
A golden holds `text`, `lines` (with word boxes), `dropped`, `rotation`, `text_angle`, `coverage` (which code paths ran).
Floats are rounded to 4 places (matrices to 6); crc32 fields are exact.
`primitives.json`: seeded small cases for the OpenCV, numpy, pyclipper and Python behaviour the runtime relies on, plus pure runtime functions on tiny inputs.
`thai-norm.json`: {input, canonical, fixed} cases, fixed = fix_scripts(canonical(input)), ASCII-escaped.
Regenerate (helpers `ocr_goldens_*.py` sit beside the script; fonts are in ~/Workspaces/openledger-parser-eval/fonts):
  cd ~/Workspaces/openledger-parser-eval && .venv-ocr/bin/python -I runners/make_ocr_goldens.py ~/Workspaces/openledger/fixtures/ocr
Add `--stages` to also write each golden's `stages` (records taken inside LineOCR: detect candidates, crop_line, recognize_detail with CTC chars, split_one, reading_order and blocks, in call order), about 1.7 MB, for debugging; no test reads them.
