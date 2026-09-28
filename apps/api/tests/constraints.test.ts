import { randomUUID } from "crypto";
import { createPool, migrate } from "../src/db/pool";
import { infra } from "./infra";
import { insertUser } from "./helpers";

describe("database constraints", () => {
  it("rejects an invalid ride status, fare, or coordinate", async () => {
    const pool = await readyPool();
    const riderId = await insertUser(pool, "rider", "Constraint Rider");
    const insert = (status: string, lat: number, lng: number, fare: number) =>
      pool.query(
        `INSERT INTO rides (
           rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents
         ) VALUES ($1, $2, $3, $4, 12.98, 77.6, $5)`,
        [riderId, status, lat, lng, fare],
      );
    await expect(insert("requested", 12.97, 77.59, -1)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("flying", 12.97, 77.59, 100)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("requested", 90.1, 77.59, 100)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("requested", -90.1, 77.59, 100)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("requested", 12.97, 180.1, 100)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("requested", 12.97, -180.1, 100)).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO rides (
           rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents
         ) VALUES ($1, 'requested', 12.97, 77.59, 12.98, 180.1, 100)`,
        [riderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.end();
  });

  it("rejects a ride event with an unknown status or an unknown actor", async () => {
    const pool = await readyPool();
    const riderId = await insertUser(pool, "rider", "Event Rider");
    const ride = await pool.query(
      `INSERT INTO rides (
         rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents
       ) VALUES ($1, 'requested', 12.97, 77.59, 12.98, 77.6, 100)
       RETURNING id`,
      [riderId],
    );
    const rideId = ride.rows[0].id as string;
    await expect(
      pool.query(
        `INSERT INTO ride_events (ride_id, from_status, to_status) VALUES ($1, 'flying', 'matching')`,
        [rideId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO ride_events (ride_id, from_status, to_status, actor_id) VALUES ($1, 'requested', 'matching', $2)`,
        [rideId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.end();
  });

  it("enforces user-scoped idempotency and unique emails", async () => {
    const pool = await readyPool();
    const first = await insertUser(pool, "rider", "First");
    const second = await insertUser(pool, "rider", "Second");
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, response_status, response_body)
       VALUES ($1, 'ride.create:same', 201, '{}'::jsonb)`,
      [first],
    );
    await expect(
      pool.query(
        `INSERT INTO idempotency_keys (user_id, key, response_status, response_body)
         VALUES ($1, 'ride.create:same', 201, '{}'::jsonb)`,
        [first],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, response_status, response_body)
       VALUES ($1, 'ride.create:same', 201, '{}'::jsonb)`,
      [second],
    );
    await expect(
      pool.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ((SELECT email FROM users WHERE id = $1), 'hash', 'Copy', 'rider')`,
        [first],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.end();
  });

  it("rejects a duplicate outbox event id and a second notification with the same id", async () => {
    const pool = await readyPool();
    const eventId = randomUUID();
    const aggregateId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'ride', $2, 'ride.requested', '{}'::jsonb)`,
      [eventId, aggregateId],
    );
    await expect(
      pool.query(
        `INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'ride', $2, 'ride.requested', '{}'::jsonb)`,
        [eventId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `UPDATE outbox_events SET status = 'published', published_at = NULL WHERE event_id = $1`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `INSERT INTO notifications (id, event_type, payload) VALUES ($1, 'ride.requested', '{}'::jsonb)`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO notifications (id, event_type, payload)
       VALUES ($1, 'ride.requested', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [eventId],
    );
    const count = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id = $1`, [eventId]);
    expect(count.rows[0].n).toBe(1);
    await expect(
      pool.query(
        `INSERT INTO notifications (id, event_type, payload) VALUES ($1, 'ride.requested', '{}'::jsonb)`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.end();
  });

  it("applies schema.sql twice without error", async () => {
    const pool = await readyPool();
    await migrate(pool);
    await pool.end();
  });
});

async function readyPool() {
  const stack = await infra();
  const pool = createPool(stack.databaseUrl);
  await migrate(pool);
  return pool;
}
