import { randomUUID } from "crypto";
import { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export async function insertOutbox(
  db: Queryable,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const eventId = randomUUID();
  const body = { ...payload, event: eventType, eventId };
  await db.query(
    `INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'ride', $2, $3, $4::jsonb)`,
    [eventId, aggregateId, eventType, JSON.stringify(body)],
  );
  return eventId;
}
