import { mapValues } from "es-toolkit";
import { PREPARE_FAILURES } from "./cli.js";
import { describeReasonTable } from "../../fixtures/reason-table.js";

describeReasonTable(
  "PREPARE_FAILURES",
  mapValues(PREPARE_FAILURES, (failure) => failure.code),
  {
    not_found: 5,
    unsupported_extension: 2,
    kind_mismatch: 2,
    too_large: 6,
    unreadable: 5,
    pdf_unreadable: 6,
    image_unreadable: 6,
    password_required: 4,
    wrong_password: 4,
    ocr_unavailable: 3,
  },
);
