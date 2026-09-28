import amqp from "amqplib";
import { Logger } from "pino";
import { Pool } from "pg";
import { notificationDlqTotal, notificationRetriesTotal } from "../metrics";

export const RIDE_EXCHANGE = "ride.events";
export const NOTIFICATION_QUEUE = "notifications";
export const NOTIFICATION_RETRY_QUEUE = "notifications.retry";
export const NOTIFICATION_DLQ = "notifications.dlq";

const EVENT_KEYS = ["ride.requested", "ride.accepted", "ride.completed", "ride.cancelled", "ride.retry"];

export async function assertRideTopology(channel: amqp.Channel, retryTtlMs: number): Promise<void> {
  await channel.assertExchange(RIDE_EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(NOTIFICATION_DLQ, { durable: true });
  await channel.assertQueue(NOTIFICATION_RETRY_QUEUE, {
    durable: true,
    arguments: {
      "x-message-ttl": retryTtlMs,
      "x-dead-letter-exchange": RIDE_EXCHANGE,
      "x-dead-letter-routing-key": "ride.retry",
    },
  });
  await channel.assertQueue(NOTIFICATION_QUEUE, { durable: true });
  for (const key of EVENT_KEYS) {
    await channel.bindQueue(NOTIFICATION_QUEUE, RIDE_EXCHANGE, key);
  }
}

export interface RabbitHandle {
  connection: Awaited<ReturnType<typeof amqp.connect>>;
  channel: amqp.Channel;
  publish: (routingKey: string, payload: object) => Promise<void>;
  publishConfirmed: (routingKey: string, payload: object, eventId: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function connectRabbit(url: string, retryTtlMs: number): Promise<RabbitHandle> {
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  const confirmChannel = await connection.createConfirmChannel();
  await assertRideTopology(channel, retryTtlMs);
  return {
    connection,
    channel,
    async publish(routingKey: string, payload: object) {
      channel.publish(RIDE_EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
        persistent: true,
        contentType: "application/json",
      });
    },
    publishConfirmed(routingKey: string, payload: object, eventId: string) {
      return new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          RIDE_EXCHANGE,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            contentType: "application/json",
            messageId: eventId,
            headers: { event_id: eventId },
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
    async close() {
      await confirmChannel.close().catch(() => undefined);
      await channel.close().catch(() => undefined);
      await connection.close();
    },
  };
}

export async function startNotificationConsumer(
  channel: amqp.Channel,
  pool: Pool,
  log: Logger,
  maxAttempts: number,
): Promise<() => Promise<void>> {
  await channel.prefetch(10);
  const { consumerTag } = await channel.consume(NOTIFICATION_QUEUE, (msg) => {
    if (!msg) return;
    handleDelivery(channel, pool, log, maxAttempts, msg).catch((err) => {
      log.error({ err }, "notification consumer failed before ack");
      channel.nack(msg, false, false);
    });
  });
  return async () => {
    await channel.cancel(consumerTag);
  };
}

async function handleDelivery(
  channel: amqp.Channel,
  pool: Pool,
  log: Logger,
  maxAttempts: number,
  msg: amqp.ConsumeMessage,
): Promise<void> {
  const fail = String(msg.properties.headers?.["x-fail"] ?? "") === "1";
  if (fail) {
    requeueOrDeadLetter(channel, msg, maxAttempts, log);
    return;
  }

  const body = JSON.parse(msg.content.toString()) as { event?: string; rideId?: string; eventId?: string };
  const eventType = body.event ?? "unknown";
  const rideId = body.rideId ?? null;
  const headerEventId = msg.properties.headers?.["event_id"];
  const eventId = body.eventId ?? (typeof headerEventId === "string" ? headerEventId : undefined);
  const id = eventId ?? `${eventType}:${rideId ?? "none"}`;
  try {
    await pool.query(
      `INSERT INTO notifications (id, ride_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, rideId, eventType, JSON.stringify(body)],
    );
    channel.ack(msg);
  } catch (err) {
    log.error({ err, eventType, rideId }, "notification write failed");
    requeueOrDeadLetter(channel, msg, maxAttempts, log);
  }
}

function requeueOrDeadLetter(
  channel: amqp.Channel,
  msg: amqp.ConsumeMessage,
  maxAttempts: number,
  log: Logger,
): void {
  const previous = Number(msg.properties.headers?.["x-attempts"] ?? 0);
  const attempts = previous + 1;
  const headers = {
    "x-fail": msg.properties.headers?.["x-fail"],
    "x-attempts": attempts,
  };
  if (attempts >= maxAttempts) {
    channel.sendToQueue(NOTIFICATION_DLQ, msg.content, { persistent: true, headers });
    channel.ack(msg);
    notificationDlqTotal.inc();
    log.warn({ attempts }, "notification moved to dead-letter queue");
    return;
  }
  channel.sendToQueue(NOTIFICATION_RETRY_QUEUE, msg.content, { persistent: true, headers });
  channel.ack(msg);
  notificationRetriesTotal.inc();
  log.info({ attempts }, "notification scheduled for retry");
}
