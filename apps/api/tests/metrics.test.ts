import request from "supertest";
import { Pool } from "pg";
import Redis from "ioredis";
import { createApp } from "../src/app";
import { testDeps } from "./helpers";

describe("metrics", () => {
  it("exposes Prometheus metrics without high-cardinality labels", async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("outbox_events")) return { rows: [{ n: 2 }], rowCount: 1 };
        if (sql.includes("drivers")) return { rows: [{ n: 1 }], rowCount: 1 };
        return { rows: [{ n: 4 }], rowCount: 1 };
      },
    } as unknown as Pool;
    const app = createApp(testDeps(pool, {} as Redis), {
      postgres: async () => true,
      redis: async () => true,
      rabbitmq: () => true,
    });
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("http_requests_total");
    expect(response.text).toContain("active_rides 4");
    expect(response.text).toContain("active_drivers 1");
    expect(response.text).toContain("outbox_unpublished_events 2");
    expect(response.text).not.toContain("ride_id");
    expect(response.headers["content-type"]).toContain("text/plain");
  });
});
