import client from "prom-client";
import { Pool } from "pg";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP responses by method, route pattern, and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets,
  registers: [register],
});

export const rideRequestsTotal = new client.Counter({
  name: "ride_requests_total",
  help: "Ride rows committed by create",
  registers: [register],
});

export const rideCompletedTotal = new client.Counter({
  name: "ride_completed_total",
  help: "Rides transitioned to completed",
  registers: [register],
});

export const rideCancelledTotal = new client.Counter({
  name: "ride_cancelled_total",
  help: "Rides transitioned to cancelled",
  registers: [register],
});

export const rideMatchingDurationSeconds = new client.Histogram({
  name: "ride_matching_duration_seconds",
  help: "Time spent on nearby-driver search while creating a ride",
  buckets,
  registers: [register],
});

export const redisErrorsTotal = new client.Counter({
  name: "redis_errors_total",
  help: "Redis operations that failed",
  registers: [register],
});

export const rabbitmqPublishFailuresTotal = new client.Counter({
  name: "rabbitmq_publish_failures_total",
  help: "RabbitMQ publisher confirms that failed",
  registers: [register],
});

export const outboxPublishFailuresTotal = new client.Counter({
  name: "outbox_publish_failures_total",
  help: "Outbox rows whose publish attempt failed",
  registers: [register],
});

export const notificationRetriesTotal = new client.Counter({
  name: "notification_retries_total",
  help: "Notification messages scheduled onto the retry queue",
  registers: [register],
});

export const notificationDlqTotal = new client.Counter({
  name: "notification_dlq_total",
  help: "Notification messages copied to the dead-letter queue",
  registers: [register],
});

export const activeRides = new client.Gauge({
  name: "active_rides",
  help: "Rides that are not in a terminal status",
  registers: [register],
});

export const activeDrivers = new client.Gauge({
  name: "active_drivers",
  help: "Drivers marked online in Postgres",
  registers: [register],
});

export const outboxUnpublishedEvents = new client.Gauge({
  name: "outbox_unpublished_events",
  help: "Outbox rows still waiting to be published",
  registers: [register],
});

export async function refreshGauges(pool: Pool): Promise<void> {
  try {
    const rides = await pool.query(
      `SELECT count(*)::int AS n FROM rides
       WHERE status IN ('requested', 'matching', 'offered', 'accepted', 'arrived', 'in_progress')`,
    );
    activeRides.set(Number(rides.rows[0].n));
    const drivers = await pool.query(`SELECT count(*)::int AS n FROM drivers WHERE status = 'online'`);
    activeDrivers.set(Number(drivers.rows[0].n));
    const outbox = await pool.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE status = 'pending'`,
    );
    outboxUnpublishedEvents.set(Number(outbox.rows[0].n));
  } catch {
    // Keep the last gauge values. A metrics scrape should not fail the process.
  }
}

export async function renderMetrics(pool?: Pool): Promise<string> {
  if (pool) await refreshGauges(pool);
  return register.metrics();
}

export function routeLabel(req: { baseUrl?: string; route?: { path?: string | string[] } }): string {
  const pattern = req.route?.path;
  const path = Array.isArray(pattern) ? pattern.join(",") : pattern;
  if (!path) return "unmatched";
  return `${req.baseUrl ?? ""}${path}`;
}
