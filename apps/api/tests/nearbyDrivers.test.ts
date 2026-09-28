import Redis from "ioredis";
import { createPool, migrate } from "../src/db/pool";
import { clearDriverPresence, markDriverPresent, searchNearbyDrivers } from "../src/redis/geo";
import { infra } from "./infra";
import { randomUUID } from "crypto";

describe("nearby drivers", () => {
  let redis: Redis | undefined;

  beforeAll(async () => {
    const stack = await infra();
    redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    const pool = createPool(stack.databaseUrl);
    await migrate(pool);
    await pool.end();
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it("returns fresh drivers and drops stale geo entries", async () => {
    if (!redis) throw new Error("redis did not start");
    const fresh = randomUUID();
    const stale = randomUUID();
    await markDriverPresent(redis, fresh, 77.5946, 12.9716, 30);
    await redis.geoadd("drivers:geo", 77.6, 12.98, stale);
    await redis.del(`driver:${stale}:presence`);

    const found = await searchNearbyDrivers(redis, 77.5946, 12.9716, 8);
    expect(found.map((driver) => driver.driverId)).toContain(fresh);
    expect(found.map((driver) => driver.driverId)).not.toContain(stale);
    expect(await redis.zscore("drivers:geo", stale)).toBeNull();

    await clearDriverPresence(redis, fresh);
  });
});
