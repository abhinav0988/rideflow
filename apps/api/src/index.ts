import "./loadEnv";
import http from "http";
import Redis from "ioredis";
import { Server } from "socket.io";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool, migrate } from "./db/pool";
import { logger } from "./logger";
import { connectRabbit, startNotificationConsumer } from "./mq/rabbit";
import { startOutboxPublisher } from "./mq/outboxPublisher";
import { expireOfferedRides, RideDeps } from "./modules/rides/service";
import { attachGateway } from "./realtime/gateway";
import { runShutdown, ShutdownState } from "./shutdown";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const redis = await waitFor("redis", () => openRedis(config.redisUrl));
  await waitFor("postgres", () => migrate(pool));

  const rabbit = await waitFor("rabbitmq", () =>
    connectRabbit(config.rabbitUrl, config.notificationRetryTtlMs),
  );
  let rabbitOpen = true;
  rabbit.connection.on("close", () => {
    rabbitOpen = false;
  });
  rabbit.connection.on("error", (err) => {
    rabbitOpen = false;
    logger.error({ err }, "rabbitmq connection error");
  });

  let io: Server | undefined;
  const emitBus: RideDeps["emit"] = (room, event, payload) => {
    io?.to(room).emit(event, payload);
  };
  const deps: RideDeps = {
    pool,
    redis,
    config,
    publish: async () => undefined,
    emit: emitBus,
    log: logger,
  };
  const runtime: ShutdownState = { acceptingTraffic: true };

  const app = createApp(deps, {
    postgres: async () => {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    redis: async () => {
      try {
        const pong = await redis.ping();
        return pong === "PONG";
      } catch {
        return false;
      }
    },
    rabbitmq: () => rabbitOpen,
  }, runtime);

  const server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: config.corsOrigin },
  });
  const closeAdapter = await attachGateway(io, deps, logger);
  const stopConsumer = await startNotificationConsumer(
    rabbit.channel,
    pool,
    logger,
    config.notificationMaxAttempts,
  );
  const stopOutbox = startOutboxPublisher(
    pool,
    (eventType, payload, eventId) => rabbit.publishConfirmed(eventType, payload, eventId),
    logger,
    config.outboxPollMs,
  );

  const expirer = setInterval(() => {
    expireOfferedRides(deps).catch((err) => logger.error({ err }, "offer expiry failed"));
  }, 15_000);

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "RideFlow API listening");
  });

  const shutdown = (signal: string) =>
    runShutdown({
      state: runtime,
      log: logger.child({ signal }),
      timeoutMs: config.shutdownTimeoutMs,
      stopBackground: async () => {
        clearInterval(expirer);
        await stopOutbox();
        await stopConsumer();
      },
      closeHttp: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
      closeSockets: async () => {
        await closeAdapter();
        io?.close();
      },
      closeRabbit: () => rabbit.close(),
      closeRedis: () => redis.quit().then(() => undefined),
      closePostgres: () => pool.end(),
    }).then(() => {
      process.exit(0);
    });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      logger.error({ err }, "shutdown failed");
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      logger.error({ err }, "shutdown failed");
      process.exit(1);
    });
  });
}

async function openRedis(url: string): Promise<Redis> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  client.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));
  try {
    await client.connect();
    return client;
  } catch (err) {
    client.disconnect();
    throw err;
  }
}

async function waitFor<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn({ attempt, label }, "dependency not ready");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

main().catch((err) => {
  logger.error({ err }, "failed to start");
  process.exit(1);
});
