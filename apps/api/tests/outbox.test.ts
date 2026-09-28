import { randomUUID } from "crypto";
import pino from "pino";
import Redis from "ioredis";
import { createPool, migrate } from "../src/db/pool";
import { insertOutbox } from "../src/db/outbox";
import { connectRabbit, startNotificationConsumer } from "../src/mq/rabbit";
import { publishPendingOutbox } from "../src/mq/outboxPublisher";
import { createRide } from "../src/modules/rides/service";
import { RideDto } from "@rideflow/shared";
import { infra } from "./infra";
import { insertUser, testDeps } from "./helpers";

const log = pino({ level: "silent" });

describe("transactional outbox", () => {
  it("commits the ride and an unpublished outbox row together", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    const redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await migrate(pool);
    const riderId = await insertUser(pool, "rider", "Outbox Rider");
    const created = await createRide(
      testDeps(pool, redis),
      riderId,
      { lat: 12.97, lng: 77.59 },
      { lat: 12.99, lng: 77.62 },
      `outbox-${randomUUID()}`,
    );
    const rideId = (created.body as RideDto).id;
    const rows = await pool.query(
      `SELECT status, event_type FROM outbox_events WHERE aggregate_id = $1`,
      [rideId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ status: "pending", event_type: "ride.requested" });
    await redis.quit();
    await pool.end();
  });

  it("keeps the event unpublished when RabbitMQ rejects it, then publishes after recovery", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    await migrate(pool);
    const rideId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'ride', $2, 'ride.requested', $3::jsonb)`,
      [randomUUID(), rideId, JSON.stringify({ event: "ride.requested", rideId })],
    );

    const failed = await publishPendingOutbox(pool, async () => {
      throw new Error("broker down");
    }, log, 5);
    expect(failed).toBe(0);
    const pending = await pool.query(
      `SELECT status, attempt_count FROM outbox_events WHERE aggregate_id = $1`,
      [rideId],
    );
    expect(pending.rows[0].status).toBe("pending");
    expect(Number(pending.rows[0].attempt_count)).toBeGreaterThanOrEqual(1);

    await pool.query(`UPDATE outbox_events SET available_at = now() WHERE aggregate_id = $1`, [rideId]);
    const rabbit = await connectRabbit(stack.rabbitUrl, 400);
    const published = await publishPendingOutbox(
      pool,
      (eventType, payload, eventId) => rabbit.publishConfirmed(eventType, payload, eventId),
      log,
      5,
    );
    expect(published).toBe(1);
    const done = await pool.query(`SELECT status FROM outbox_events WHERE aggregate_id = $1`, [rideId]);
    expect(done.rows[0].status).toBe("published");
    await rabbit.close();
    await pool.end();
  });

  it("does not let two workers publish the same outbox row", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    await migrate(pool);
    const rideId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'ride', $2, 'ride.accepted', $3::jsonb)`,
      [randomUUID(), rideId, JSON.stringify({ rideId })],
    );
    let calls = 0;
    const publish = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
    };
    const started = Date.now();
    const [left, right] = await Promise.all([
      publishPendingOutbox(pool, publish, log, 5),
      publishPendingOutbox(pool, publish, log, 5),
    ]);
    expect(left + right).toBe(1);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
    const published = await pool.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND status = 'published'`,
      [rideId],
    );
    expect(published.rows[0].n).toBe(1);
    await pool.end();
  });

  it("does not insert a second notification when the same event id is delivered twice", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    await migrate(pool);
    const rabbit = await connectRabbit(stack.rabbitUrl, 400);
    const stop = await startNotificationConsumer(rabbit.channel, pool, log, 3);
    const eventId = randomUUID();
    const rideId = randomUUID();
    const body = Buffer.from(JSON.stringify({ event: "ride.accepted", rideId, eventId }));
    rabbit.channel.publish("ride.events", "ride.accepted", body, {
      persistent: true,
      headers: { event_id: eventId },
    });
    rabbit.channel.publish("ride.events", "ride.accepted", body, {
      persistent: true,
      headers: { event_id: eventId },
    });
    await waitForCount(pool, eventId);
    const count = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id = $1`, [eventId]);
    expect(count.rows[0].n).toBe(1);
    await stop();
    await rabbit.close();
    await pool.end();
  });

  it("rolls back the ride event and the outbox row together", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    const redis = new Redis(stack.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await migrate(pool);
    const riderId = await insertUser(pool, "rider", "Rollback Rider");
    const created = await createRide(
      testDeps(pool, redis),
      riderId,
      { lat: 12.97, lng: 77.59 },
      { lat: 12.98, lng: 77.6 },
      `rollback-${randomUUID()}`,
    );
    const rideId = (created.body as RideDto).id;
    const eventsBefore = await pool.query(`SELECT count(*)::int AS n FROM ride_events WHERE ride_id = $1`, [rideId]);
    const outboxBefore = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [rideId]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ride_events (ride_id, from_status, to_status, actor_id) VALUES ($1, 'offered', 'accepted', $2)`,
        [rideId, riderId],
      );
      await insertOutbox(client, rideId, "ride.accepted", { rideId });
      throw new Error("database write failed");
    } catch (err) {
      await client.query("ROLLBACK");
      expect((err as Error).message).toBe("database write failed");
    } finally {
      client.release();
    }
    const eventsAfter = await pool.query(`SELECT count(*)::int AS n FROM ride_events WHERE ride_id = $1`, [rideId]);
    const outboxAfter = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [rideId]);
    expect(eventsAfter.rows[0].n).toBe(eventsBefore.rows[0].n);
    expect(outboxAfter.rows[0].n).toBe(outboxBefore.rows[0].n);
    await redis.quit();
    await pool.end();
  });
});

async function waitForCount(pool: ReturnType<typeof createPool>, eventId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const count = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id = $1`, [eventId]);
    if (count.rows[0].n === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("notification was not stored");
}
