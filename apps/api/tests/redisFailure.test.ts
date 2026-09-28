import Redis from "ioredis";
import { Pool } from "pg";
import { HttpError } from "../src/httpError";
import { acceptRide } from "../src/modules/rides/service";
import { testDeps } from "./helpers";

describe("Redis failure", () => {
  it("refuses to assign a ride when the lock cannot be taken", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM idempotency_keys")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM rides")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "11111111-1111-1111-1111-111111111111",
                rider_id: "22222222-2222-2222-2222-222222222222",
                driver_id: null,
                status: "offered",
                pickup_lat: 12.97,
                pickup_lng: 77.59,
                dropoff_lat: 13.01,
                dropoff_lng: 77.64,
                fare_cents: 450,
                offered_driver_ids: ["33333333-3333-3333-3333-333333333333"],
                idempotency_key: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    const redis = {
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
      set: async () => {
        throw new Error("ECONNREFUSED");
      },
      del: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as Redis;

    const deps = testDeps(pool, redis);
    await expect(
      acceptRide(deps, "33333333-3333-3333-3333-333333333333", "11111111-1111-1111-1111-111111111111", "retry-key"),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      acceptRide(deps, "33333333-3333-3333-3333-333333333333", "11111111-1111-1111-1111-111111111111", "retry-key"),
    ).rejects.toMatchObject({ status: 503 });
    expect(queries.some((sql) => sql.includes("UPDATE rides"))).toBe(false);
  });
});
