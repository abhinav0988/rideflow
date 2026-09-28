export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  rabbitUrl: string;
  jwtSecret: string;
  corsOrigin: string[];
  logLevel: string;
  notificationRetryTtlMs: number;
  notificationMaxAttempts: number;
  driverPresenceTtlSec: number;
  nearbyRadiusKm: number;
  offerTtlSec: number;
  outboxPollMs: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: numberFrom(env.PORT, 4000),
    databaseUrl:
      env.DATABASE_URL ?? "postgres://rideflow:rideflow@localhost:5433/rideflow",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6380",
    rabbitUrl: env.RABBITMQ_URL ?? "amqp://rideflow:rideflow@localhost:5672",
    jwtSecret: env.JWT_SECRET ?? "dev-secret-change-me",
    corsOrigin: (env.CORS_ORIGIN ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? "info",
    notificationRetryTtlMs: numberFrom(env.NOTIFICATION_RETRY_TTL_MS, 2000),
    notificationMaxAttempts: numberFrom(env.NOTIFICATION_MAX_ATTEMPTS, 3),
    driverPresenceTtlSec: numberFrom(env.DRIVER_PRESENCE_TTL_SEC, 30),
    nearbyRadiusKm: numberFrom(env.NEARBY_RADIUS_KM, 5),
    offerTtlSec: numberFrom(env.OFFER_TTL_SEC, 120),
    outboxPollMs: numberFrom(env.OUTBOX_POLL_MS, 500),
    shutdownTimeoutMs: numberFrom(env.SHUTDOWN_TIMEOUT_MS, 10_000),
  };
}

function numberFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}
