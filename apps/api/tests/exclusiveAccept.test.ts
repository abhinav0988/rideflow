import { randomUUID } from "crypto";
import Redis from "ioredis";
import { createPool, migrate } from "../src/db/pool";
import { acceptRide } from "../src/modules/rides/service";
import { infra } from "./infra";
import { insertUser, testDeps } from "./helpers";

describe("exclusive ride accept", () => {
  it("lets only one of two drivers commit the accept", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    const redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await migrate(pool);
    const riderId = await insertUser(pool, "rider", "Riya");
    const driverA = await insertUser(pool, "driver", "Arun");
    const driverB = await insertUser(pool, "driver", "Beena");
    const rideId = randomUUID();
    await pool.query(
      `INSERT INTO rides (
         id, rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents, offered_driver_ids
       ) VALUES ($1, $2, 'offered', 12.97, 77.59, 13.01, 77.64, 500, $3)`,
      [rideId, riderId, [driverA, driverB]],
    );

    const deps = testDeps(pool, redis);
    const results = await Promise.allSettled([
      acceptRide(deps, driverA, rideId, `accept-${driverA}`),
      acceptRide(deps, driverB, rideId, `accept-${driverB}`),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.status).toBe(409);

    const saved = await pool.query(`SELECT driver_id, status FROM rides WHERE id = $1`, [rideId]);
    expect(saved.rows[0].status).toBe("accepted");
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ body: { driverId: string } }>).value.body.driverId;
    expect(saved.rows[0].driver_id).toBe(winner);

    const events = await pool.query(
      `SELECT count(*)::int AS count FROM ride_events WHERE ride_id = $1 AND to_status = 'accepted'`,
      [rideId],
    );
    expect(events.rows[0].count).toBe(1);

    await redis.quit();
    await pool.end();
  });
});
