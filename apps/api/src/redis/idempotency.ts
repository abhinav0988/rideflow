import Redis from "ioredis";
import { Pool } from "pg";

export interface StoredResponse {
  status: number;
  body: unknown;
}

export async function readIdempotency(
  pool: Pool,
  redis: Redis,
  userId: string,
  key: string,
): Promise<StoredResponse | null> {
  try {
    const hit = await redis.get(idemRedisKey(userId, key));
    if (hit) return JSON.parse(hit) as StoredResponse;
  } catch {
    // Postgres is the durable copy.
  }
  const { rows } = await pool.query(
    `SELECT response_status, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  if (!rows[0]) return null;
  return { status: rows[0].response_status as number, body: rows[0].response_body };
}

export async function saveIdempotency(
  pool: Pool,
  redis: Redis,
  userId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (user_id, key, response_status, response_body)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, key, status, JSON.stringify(body)],
  );
  try {
    await redis.set(
      idemRedisKey(userId, key),
      JSON.stringify({ status, body }),
      "EX",
      60 * 60 * 24,
    );
  } catch {
    // The Postgres row is enough for a replay.
  }
}

function idemRedisKey(userId: string, key: string): string {
  return `idem:${userId}:${key}`;
}
