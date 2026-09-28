import { AppConfig, loadConfig } from "../src/config";
import { RideDeps } from "../src/modules/rides/service";
import pino from "pino";
import { Pool } from "pg";
import Redis from "ioredis";
import { randomUUID } from "crypto";

export function testDeps(pool: Pool, redis: Redis, config: Partial<AppConfig> = {}): RideDeps {
  return {
    pool,
    redis,
    config: { ...loadConfig(), jwtSecret: "test-secret", nearbyRadiusKm: 5, ...config },
    publish: async () => undefined,
    emit: () => undefined,
    log: pino({ level: "silent" }),
  };
}

export async function insertUser(pool: Pool, role: "rider" | "driver", name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, 'hash', $3, $4)`,
    [id, `${id}@rideflow.test`, name, role],
  );
  if (role === "driver") {
    await pool.query(`INSERT INTO drivers (user_id) VALUES ($1)`, [id]);
  }
  return id;
}
