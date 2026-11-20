# OCR goldens

Golden fixtures for the TypeScript port of the OpenThai2.1-OCR-Text v2.1.4 runtime: iapp/OpenThai2.1-OCR-Text-20261118, tag v2.1.4, commit fac2b5ce.
det.onnx, rec.onnx and rec_dict.txt are the same files as in 2.0. rec2.onnx is new.

## How they were made

Each golden comes from the vendor `LineOCR(model_dir, threads=1)` on ONNX Runtime CPU. OpenVINO is not installed, so the runtime falls back to ONNX Runtime.
The runtime merges its DEFAULTS, det.yml and the model's own config.json. These values matter for the goldens:

- det: thresh 0.2, box_thresh 0.4 and unclip 1.4 (from det.yml), limit 1280, split_gap 1.2. short_pad 0 and rescan_below 0, so both are off.
- rec: drop_below 0.8, min_chars 2, min_chars_digits 1, min_chars_digits_height 0.62, min_chars_latin true, junk_below 0.9, junk_invalid 0.05, color flatten.
- marks: enabled, max_gap 0.35, max_ext 0.9, max_height 0.9, margin 0, page_share 0.25, page_min 3, keep_base true.
- cols (the list guard): list_rep 0.6, list_facing 0, list_max_w 10, list_enum 0.
- rec2: file rec2.onnx, min_mixed 1.
- join: decimal_comma true, thai_no_space false, paragraphs false.
- runtime: ort_low_memory true. It turns off ONNX Runtime's memory arena and memory patterns; the output is the same with it off.

Every golden's `env.cfg` holds the full merged config.

## Pages

There are 19 synthetic pages, `<name>.png`, each with a golden `<name>.json`. All data is invented. The fonts are Sarabun, Noto Sans Thai, Noto Sans and Kanit, all under the OFL.
The six pages added for 2.1 are 8-bit grey PNGs; their `image` carries `"png": "grey"`. Decode them to BGR with three equal channels, as cv2.imread does. `image.shape` is always the decoded BGR shape.

- `letterpress-marks`: every line's upper marks float 10 px above it. The detector boxes them apart and they attach back to their lines. 11 of 12 lines are lifted, so the page counts as floating, and the twelfth line grows by the median reach.
- `receipt-cells`: one-character cells: quantities 2 5 3 1 8 and units g m g are kept by the height-gated exception. A printed 8 at about 0.47 of the line height is still dropped. Four amounts get a decimal point (280,00, 1,280,00, 86,50, 88,226,21); 1,234, 12,345.67, 1234,56 and 4,5 are left alone. The last line's marks float on a page that does not float them, so its re-read changes a letter and keep_base rejects it.
- `prose-banded`: two prose columns under a full-width title, split by a full-width heading and closed by a full-width footer. All rows sit at body spacing, so there is no gutter and no horizontal gap for the plain XY-cut, and `_banded_columns` reads the page.
- `committee-list`: a numbered name | position list across a gutter. Both sides pass the prose test, but their lines start alike, so `_list_pair` vetoes the cut and the list is read row by row.
- `loopless-kanit`: Kanit, a loopless face. rec reads Thai letters as Latin look-alikes and rec2's reading is kept. "Wi-Fiฟรี" really has Latin inside a Thai token, so rec2 reads it the same way and is rejected.
- `columns-tilted-lines`: two justified columns whose lines run 2.2 degrees off level while the column edges stay upright, below the 2.5 degree deskew. Turned by the page skew, the column ends cover the gutter and the page is one block. The unrotated frame keeps the gutter, finds two blocks, and is used.

## Golden format

A golden holds `image`, `env`, `text`, `rotation`, `text_angle`, `lines` (with word boxes), `dropped` and `coverage`.
Floats are rounded to 4 places (matrices to 6). crc32 fields are exact.

`coverage` records which code paths ran. The 2.0 keys keep their meaning, with three refinements:

- `columns_cut`: true when some gutter passed every column test, including the list guard (a false `list_pair`).
- `blocks`: the number of blocks each reading_order call used. On a skewed page these are the blocks of the frame that was kept.
- `prose_tests`, `numbered_across`: every call in call order, in both frames.

New keys:

- `marks`: `{candidates, attached, lines, floating, grown, accepted, rejected_filter, rejected_keep_base, absorbed}`, or null if `_attach_marks` did not run.
  - candidates: boxes the line filter would drop (fragments included).
  - attached: candidates given to a line. A candidate inside its line's box is attached but adds no reach.
  - lines: lines with attached candidates.
  - floating: the page-level rule fired.
  - grown: lines re-read with a grown box.
  - accepted: re-reads kept. rejected_filter: re-reads the line filter drops. rejected_keep_base: re-reads that change a digit (floating page) or a letter (other pages).
  - absorbed: candidates removed from the page, as fragments are.
- `rec2`: `{tried, accepted}`: lines read again with rec2, and how many rec2 readings replaced the first reading. This counts every `_read_boxes` call, including the upside-down pass and the marks re-reads.
- `list_pair`: results of every `_list_pair` call, in order. `list_pair_vetoes`: true results in the frame whose blocks were used.
- `banded_columns`: `_banded_columns` calls that returned bands, in the frame whose blocks were used.
- `alt_frame`: `{tried, chosen}`: reading_order calls that also cut the unrotated frame (the angle is not 0), and how many used it.
- `short_kept`: `{digits, latin}`: lines in the final filter shorter than min_chars that the height-gated exception kept.
  `short_dropped_by_height`: `{digits, latin}`: such lines dropped as too_short because their box is under 0.62 of the line height.
- `decimal_comma`: number of decimal-comma substitutions in the final filter.

## primitives.json

Seeded small cases for the OpenCV, numpy, pyclipper and Python behaviour the runtime relies on, plus pure runtime functions on tiny inputs. Arrays are `{shape, dtype, data}`, row-major.
The 2.0 entries are unchanged in shape. The `reading_order` cases call the function without rules, so its list guard is off.
2.1 added these `functions` entries. An ext is `[x0, x1, y0, y1]`; a quad is four `[x, y]` corners in `_mini_box` order. Rules are `{list_rep, list_facing, list_max_w, list_enum}`; the shipped rules are 0.6, 0, 10, 0, and null means the guard is off.

- `start_rep`: `{lines: string[], out: number}`.
- `prose`: `{name, col: int[], ext: ext[], hmed, texts: string[] | null, out: bool}`.
- `list_pair`: `{name, lcol: int[], rcol: int[], ext: ext[], hmed, texts: string[] | null, rules | null, out: bool}`.
- `banded_columns`: `{name, idx: int[], ext: ext[], hmed, texts, depth, rules, out: int[][] | null}`.
- `reading_order_rules`: `{name, boxes: quad[], angle: number | null, columns: true, texts, rules | null, alt_frame, out: int[][]}`. alt_frame is `{rotated, unrotated, chosen: "rotated" | "unrotated"}` with the block counts of both frames, or null when the unrotated frame was not tried.
- `mixed`: `{text, out: int}`.
- `digits`: `{text, out: string}`. It uses Python's str.isdigit, which is true for superscripts and circled digits but not for ⑩.
- `base`: `{text, out: string}`.
- `decimal_comma`: `{pattern, repl, cases: [{text, out, n}]}`. n counts substitutions. pattern is a Python regex; there `\d` is any Unicode Nd digit, Thai digits included.
- `drop_reason`: `{text, conf, hratio: number | null, rec, out: "empty" | "low_confidence" | "too_short" | "invalid_thai" | null}`. rec is the rec config used; the shipped one unless the case changes a key.
- `attach_marks`: `{name, img_hw, boxes: quad[], rec: [text, conf][], frag: int[], marks_cfg, reread, reread_boxes: quad[], absorbed: int[], boxes_after: quad[], rec_after: [text, conf][]}`.
  The real `_attach_marks` runs at the shipped config with a stand-in recognizer: `reread` maps a line index to the `[text, conf]` its re-read returns, and a line not listed reads as `["", 0]`.
  frag is `_fragments(boxes, rec)`, which read() passes in. reread_boxes are the grown boxes handed to the recognizer, in call order. boxes_after and rec_after are the page after the call.

## thai-norm.json

`{input, canonical, fixed}` cases with fixed = fix_scripts(canonical(input)), ASCII-escaped.

## Regenerate

The helpers `ocr_goldens_*.py` sit beside the script; the fonts are in ~/Workspaces/openledger-parser-eval/fonts.

    cd ~/Workspaces/openledger-parser-eval && .venv-ocr/bin/python -I runners/make_ocr_goldens.py ~/Workspaces/openledger/fixtures/ocr

Add `--stages` to also write each golden's `stages`, for debugging; no test reads them. They are the records taken inside LineOCR in call order: detect candidates, crop_line, recognize_detail with CTC chars, split_one, rec2, marks, list_pair, banded_columns, reading_order and blocks.
`--model v2.0` runs the 2.0 snapshot instead. Its 13 original goldens, primitives.json and thai-norm.json come out byte-identical to the 2.0 set.
