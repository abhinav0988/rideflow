import { Logger } from "pino";
import { Pool } from "pg";
import { outboxPublishFailuresTotal, rabbitmqPublishFailuresTotal } from "../metrics";

export interface OutboxPublish {
  (eventType: string, payload: Record<string, unknown>, eventId: string): Promise<void>;
}

const CLAIM_LEASE_SEC = 30;

interface PendingOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

export async function publishPendingOutbox(
  pool: Pool,
  publish: OutboxPublish,
  log: Logger,
  batchSize = 20,
): Promise<number> {
  let published = 0;
  for (let n = 0; n < batchSize; n += 1) {
    const outcome = await publishOne(pool, publish, log);
    if (outcome === "empty") break;
    if (outcome === "published") published += 1;
  }
  return published;
}

async function publishOne(pool: Pool, publish: OutboxPublish, log: Logger): Promise<"empty" | "published" | "failed"> {
  const row = await claimPending(pool, log);
  if (!row) return "empty";
  try {
    await publish(row.event_type, row.payload, row.event_id);
  } catch (err) {
    const attempts = Number(row.attempt_count) + 1;
    const delaySec = backoffSec(attempts);
    const message = err instanceof Error ? err.message : "publish failed";
    rabbitmqPublishFailuresTotal.inc();
    outboxPublishFailuresTotal.inc();
    await pool.query(
      `UPDATE outbox_events
       SET attempt_count = $2,
           last_error = $3,
           available_at = now() + make_interval(secs => $4)
       WHERE id = $1 AND status = 'pending'`,
      [row.id, attempts, message.slice(0, 500), delaySec],
    );
    log.warn({ eventId: row.event_id, attempts, delaySec, err: message }, "outbox publish failed");
    return "failed";
  }

  const marked = await pool.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), last_error = NULL
     WHERE id = $1 AND status = 'pending'`,
    [row.id],
  );
  if (marked.rowCount === 0) {
    log.warn({ eventId: row.event_id }, "outbox row changed before it could be marked published");
    return "failed";
  }
  log.info({ eventId: row.event_id, eventType: row.event_type }, "outbox event published");
  return "published";
}

async function claimPending(pool: Pool, log: Logger): Promise<PendingOutboxRow | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, event_id, event_type, payload, attempt_count
       FROM outbox_events
       WHERE status = 'pending' AND available_at <= now()
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const row = selected.rows[0] as PendingOutboxRow | undefined;
    if (!row) {
      await client.query("COMMIT");
      return undefined;
    }
    await client.query(
      `UPDATE outbox_events
       SET available_at = now() + make_interval(secs => $2)
       WHERE id = $1`,
      [row.id, CLAIM_LEASE_SEC],
    );
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err }, "outbox claim failed");
    throw err;
  } finally {
    client.release();
  }
}

function backoffSec(attempts: number): number {
  const step = Math.max(0, Math.min(attempts - 1, 5));
  return Math.min(30, 2 ** step);
}

export function startOutboxPublisher(
  pool: Pool,
  publish: OutboxPublish,
  log: Logger,
  pollMs: number,
): () => Promise<void> {
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    chain = chain
      .then(() => publishPendingOutbox(pool, publish, log))
      .then(() => undefined)
      .catch((err) => {
        log.error({ err }, "outbox publisher tick failed");
      });
  }, pollMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await chain;
  };
}
