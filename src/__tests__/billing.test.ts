import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import {
  createTestApiKey,
  insertKey,
  TEST_PROJECT_ID,
} from "./fixtures/apiKey";
import { clearDatabase } from "./db";
import { getPostgresDB } from "../storage/db/postgres/db";
import { sessionsTable } from "../storage/db/postgres/schema";
import { calculatePaymentPrice } from "../services/pricingService";
import { BasicUsage } from "../events/BasicUsage";
import { storeEvent } from "../utils/eventHelpers";
import type { AuthContext } from "../context/auth";

// Timestamps are stored with millisecond precision; a short pause keeps
// "before" and "after" a payment strictly ordered.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

async function storeBasic(
  auth: AuthContext,
  userId: string,
  debitAmount: number,
  reportedTimestamp: DateTime = DateTime.utc()
): Promise<void> {
  const event = new BasicUsage(
    userId,
    reportedTimestamp,
    { basicUsageType: "RAW", debitAmount },
    crypto.randomUUID(),
    crypto.randomUUID()
  );
  await storeEvent(event, auth);
}

async function recordPaidSession(
  auth: AuthContext,
  userId: string,
  billedUpto: DateTime
): Promise<void> {
  await getPostgresDB()
    .insert(sessionsTable)
    .values({
      projectId: auth.projectId,
      sessionId: `cks_${crypto.randomUUID()}`,
      processed: "succeeded",
      userId,
      apiKeyId: auth.apiKeyId,
      billed_upto: billedUpto.toISO()!,
      checkoutUrl: "https://example.com/checkout",
      mode: auth.mode!,
    });
}

async function priceNow(auth: AuthContext, userId: string): Promise<number> {
  await tick();
  return calculatePaymentPrice(userId, DateTime.utc(), auth);
}

describe("Billing window", () => {
  let testAuth: AuthContext;
  let productionAuth: AuthContext;

  beforeAll(async () => {
    const testKey = await createTestApiKey();
    testAuth = {
      apiKeyId: testKey.id,
      role: "test",
      mode: "test",
      projectId: TEST_PROJECT_ID,
    };

    const liveKeyId = await insertKey(
      `scrn_live_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
      "production"
    );
    productionAuth = {
      apiKeyId: liveKeyId,
      role: "production",
      mode: "production",
      projectId: TEST_PROJECT_ID,
    };
  });

  afterAll(async () => {
    await clearDatabase();
  });

  it("bills only usage ingested since the last paid session", async () => {
    const userId = crypto.randomUUID();

    await storeBasic(testAuth, userId, 100);
    await tick();
    await recordPaidSession(testAuth, userId, DateTime.utc());
    await tick();
    await storeBasic(testAuth, userId, 40);

    expect(await priceNow(testAuth, userId)).toBe(40);
  });

  it("bills late events whose reported timestamp predates the last payment", async () => {
    const userId = crypto.randomUUID();

    await storeBasic(testAuth, userId, 100);
    await tick();
    const paidAt = DateTime.utc();
    await recordPaidSession(testAuth, userId, paidAt);
    await tick();
    await storeBasic(testAuth, userId, 25, paidAt.minus({ hours: 1 }));

    expect(await priceNow(testAuth, userId)).toBe(25);
  });

  it("does not let test-mode payments affect production billing", async () => {
    const userId = crypto.randomUUID();

    await storeBasic(productionAuth, userId, 300);
    await tick();
    await recordPaidSession(testAuth, userId, DateTime.utc());

    expect(await priceNow(productionAuth, userId)).toBe(300);
  });

  it("does not reopen a billed window when an older session is paid last", async () => {
    const userId = crypto.randomUUID();

    await storeBasic(testAuth, userId, 100);
    await tick();
    const olderBilledUpto = DateTime.utc();
    await tick();
    await storeBasic(testAuth, userId, 50);
    await tick();
    const newerBilledUpto = DateTime.utc();

    await recordPaidSession(testAuth, userId, newerBilledUpto);
    await recordPaidSession(testAuth, userId, olderBilledUpto);
    await tick();
    await storeBasic(testAuth, userId, 7);

    expect(await priceNow(testAuth, userId)).toBe(7);
  });
});
