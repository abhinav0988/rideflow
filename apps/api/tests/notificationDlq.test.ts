import { randomUUID } from "crypto";
import pino from "pino";
import { createPool, migrate } from "../src/db/pool";
import {
  NOTIFICATION_DLQ,
  RIDE_EXCHANGE,
  connectRabbit,
  startNotificationConsumer,
} from "../src/mq/rabbit";
import { infra } from "./infra";

describe("notification dead-letter queue", () => {
  it("parks a failing event after retries", async () => {
    const stack = await infra();
    const pool = createPool(stack.databaseUrl);
    await migrate(pool);
    const rabbit = await connectRabbit(stack.rabbitUrl, 400);
    const stop = await startNotificationConsumer(rabbit.channel, pool, pino({ level: "silent" }), 3);
    const reader = await rabbit.connection.createChannel();
    const rideId = randomUUID();

    rabbit.channel.publish(
      RIDE_EXCHANGE,
      "ride.requested",
      Buffer.from(JSON.stringify({ event: "ride.requested", rideId })),
      { persistent: true, headers: { "x-fail": "1" } },
    );

    const message = await waitForQueue(reader, NOTIFICATION_DLQ, 20_000);
    expect(message).toBeTruthy();
    expect(Number(message?.properties.headers?.["x-attempts"])).toBeGreaterThanOrEqual(3);

    await stop();
    await reader.close();
    await rabbit.close();
    await pool.end();
  });
});

async function waitForQueue(
  channel: Awaited<ReturnType<Awaited<ReturnType<typeof connectRabbit>>["connection"]["createChannel"]>>,
  queue: string,
  timeoutMs: number,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = await channel.get(queue, { noAck: true });
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}
