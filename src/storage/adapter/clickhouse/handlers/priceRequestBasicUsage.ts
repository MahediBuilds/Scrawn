import { DateTime } from "luxon";
import type { UserId } from "../../../../config/identifiers";
import type { AuthContext } from "../../../../context/auth";
import { runClickHousePriceQuery } from "../utils";

// FINAL collapses rows sharing an idempotency key that ReplacingMergeTree
// has not merged yet, so retried events are only billed once. The window is
// keyed on ingested_timestamp so late/backdated events are not skipped.
const BASE_QUERY =
  "SELECT sum(debit_amount) as total FROM basic_usage_events FINAL WHERE project_id = {projectId:String} AND user_id = {userId:String} AND mode = {mode:String} AND ingested_timestamp < {before:DateTime64(3, 'UTC')}";
const WINDOW_QUERY =
  "SELECT sum(debit_amount) as total FROM basic_usage_events FINAL WHERE project_id = {projectId:String} AND user_id = {userId:String} AND mode = {mode:String} AND ingested_timestamp >= {lastBilled:DateTime64(3, 'UTC')} AND ingested_timestamp < {before:DateTime64(3, 'UTC')}";

export async function handlePriceRequestBasicUsage(
  userId: UserId,
  beforeTimestamp: DateTime,
  auth: AuthContext
): Promise<number> {
  return runClickHousePriceQuery(
    userId,
    beforeTimestamp,
    BASE_QUERY,
    WINDOW_QUERY,
    "BASIC_USAGE",
    auth
  );
}
