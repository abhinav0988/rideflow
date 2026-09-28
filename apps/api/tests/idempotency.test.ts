import Redis from "ioredis";
import { createPool, migrate } from "../src/db/pool";
import { createRide } from "../src/modules/rides/service";
import { RideDto } from "@rideflow/shared";
import { infra } from "./infra";
import { insertUser, testDeps } from "./helpers";

describe("idempotent ride create", () => {
  it("does not create a second ride when the same key is replayed", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    const redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await migrate(pool);
    const riderId = await insertUser(pool, "rider", "Meera");
    const deps = testDeps(pool, redis);
    const pickup = { lat: 12.9716, lng: 77.5946 };
    const dropoff = { lat: 12.995, lng: 77.62 };
    const key = "rider-create-1";

    const first = await createRide(deps, riderId, pickup, dropoff, key);
    const second = await createRide(deps, riderId, pickup, dropoff, key);
    expect((first.body as RideDto).id).toBe((second.body as RideDto).id);

    await pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [riderId]);
    await redis.del(`idem:${riderId}:ride.create:${key}`);
    const third = await createRide(deps, riderId, pickup, dropoff, key);
    expect((third.body as RideDto).id).toBe((first.body as RideDto).id);

    const count = await pool.query(`SELECT count(*)::int AS count FROM rides WHERE rider_id = $1`, [riderId]);
    expect(count.rows[0].count).toBe(1);

    await redis.quit();
    await pool.end();
  });
});
