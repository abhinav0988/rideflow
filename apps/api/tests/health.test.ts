import request from "supertest";
import { Pool } from "pg";
import Redis from "ioredis";
import { createApp } from "../src/app";
import { ShutdownState } from "../src/shutdown";
import { testDeps } from "./helpers";

function appFor(checks: { postgres: boolean; redis: boolean; rabbitmq: boolean }, state?: ShutdownState) {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const deps = testDeps(pool, {} as Redis);
  return createApp(
    deps,
    {
      postgres: async () => checks.postgres,
      redis: async () => checks.redis,
      rabbitmq: () => checks.rabbitmq,
    },
    state,
  );
}

describe("health endpoints", () => {
  it("stays live when dependencies are down and reports readiness separately", async () => {
    const state: ShutdownState = { acceptingTraffic: true };
    const healthy = appFor({ postgres: true, redis: true, rabbitmq: false }, state);
    await request(healthy).get("/api/health/live").expect(200, { status: "live" });
    const ready = await request(healthy).get("/api/health/ready").expect(200);
    expect(ready.body.status).toBe("ready");
    expect(ready.body.dependencies.rabbitmq).toBe("down");

    state.acceptingTraffic = false;
    await request(healthy).get("/api/health/live").expect(200);
    await request(healthy).get("/api/health/ready").expect(503);

    const dbDown = appFor({ postgres: false, redis: true, rabbitmq: true });
    await request(dbDown).get("/api/health/live").expect(200);
    await request(dbDown).get("/api/health/ready").expect(503);
    await request(dbDown).get("/api/health").expect(503);
  });
});
