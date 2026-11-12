import { MERGE_MERCHANTS_EXIT } from "./cli.js";
import { EXIT } from "../contract/exit.js";
import { describeReasonTable } from "../../fixtures/reason-table.js";

describeReasonTable("MERGE_MERCHANTS_EXIT", MERGE_MERCHANTS_EXIT, {
  same_merchant: EXIT.INVALID,
  not_found: EXIT.NOT_FOUND,
});
