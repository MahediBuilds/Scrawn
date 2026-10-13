import type { DateTime } from "luxon";
import { DateTime as LuxonDateTime } from "luxon";
import { getLastBilledTimestamp } from "../../db/postgres/helpers/sessions";
import { StorageError } from "../../../errors/storage";
import { getClickHouseDB } from "../../db/clickhouse";
import type { UserId } from "../../../config/identifiers";
import type { AuthContext } from "../../../context/auth";

export function toClickHouseDateTime(dt: DateTime): string {
  return dt.toUTC().toFormat("yyyy-MM-dd HH:mm:ss.SSS");
}

/**
 * ClickHouse has no unique constraints and ReplacingMergeTree keeps the
 * *latest* duplicate, so a retry ingested after a checkout would otherwise be
 * billed again. Reject known idempotency keys up front, mirroring the
 * Postgres unique constraint.
 */
export async function assertIdempotencyKeysUnused(
  table: "basic_usage_events" | "ai_token_usage_events",
  projectId: string,
  idempotencyKeys: string[]
): Promise<void> {
  if (idempotencyKeys.length === 0) return;

  const client = getClickHouseDB();
  let existing: Array<{ idempotency_key: string }>;
  try {
    const rs = await client.query({
      query: `SELECT idempotency_key FROM ${table} WHERE project_id = {projectId:String} AND idempotency_key IN {keys:Array(String)} LIMIT 1`,
      query_params: { projectId, keys: idempotencyKeys },
      format: "JSONEachRow",
    });
    existing = await rs.json<{ idempotency_key: string }>();
  } catch (e) {
    throw StorageError.queryFailed(
      `Failed to check idempotency keys in ${table}`,
      e instanceof Error ? e : new Error(String(e))
    );
  }

  if (existing.length > 0) {
    throw StorageError.constraintViolation(
      `Duplicate idempotency key: ${existing[0]!.idempotency_key}`
    );
  }
}

function parsePostgresTimestamp(value: string): DateTime | null {
  const fromSql = LuxonDateTime.fromSQL(value, { zone: "utc" });
  if (fromSql.isValid) return fromSql.toUTC();
  const fromIso = LuxonDateTime.fromISO(value, { zone: "utc" });
  if (fromIso.isValid) return fromIso.toUTC();
  return null;
}

export async function runClickHousePriceQuery(
  userId: UserId,
  beforeTimestamp: DateTime,
  baseQuery: string,
  windowQuery: string,
  eventLabel: string,
  auth: AuthContext
): Promise<number> {
  const chClient = getClickHouseDB();

  if (!userId) {
    throw StorageError.invalidData(
      `Missing userId in ${eventLabel} price request`
    );
  }

  if (!beforeTimestamp.isValid) {
    throw StorageError.invalidTimestamp(
      "beforeTimestamp is not a valid DateTime"
    );
  }
  const beforeTs = toClickHouseDateTime(beforeTimestamp);

  if (!auth.mode) {
    throw StorageError.invalidData(
      `Cannot price ${eventLabel} events without a production/test mode`
    );
  }

  // Errors here must propagate: silently falling back to the unbounded
  // query would bill the user for usage they have already paid for.
  const lastBilled = await getLastBilledTimestamp(
    auth.projectId,
    userId,
    auth.mode
  );

  let query = baseQuery;
  const params: Record<string, unknown> = {
    userId,
    before: beforeTs,
  };

  if (lastBilled) {
    const lastBilledDt = parsePostgresTimestamp(lastBilled);
    if (!lastBilledDt) {
      throw StorageError.invalidTimestamp(
        `Unparseable last billed timestamp: ${lastBilled}`
      );
    }
    query = windowQuery;
    params.lastBilled = toClickHouseDateTime(lastBilledDt);
  }

  try {
    params.projectId = auth.projectId;
    params.mode = auth.mode;

    const rs = await chClient.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });
    const data = await rs.json<{ total: string | null }>();

    if (!data || data.length === 0 || !data[0]?.total) {
      return 0;
    }

    const parsed = parseInt(data[0].total);
    return isNaN(parsed) ? 0 : parsed;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "type" in e &&
      (e as any).name === "StorageError"
    ) {
      throw e;
    }
    throw StorageError.priceCalculationFailed(
      userId,
      e instanceof Error ? e : new Error(String(e))
    );
  }
}
