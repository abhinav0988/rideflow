import Redis from "ioredis";
import { HttpError } from "../httpError";
import { redisErrorsTotal } from "../metrics";

const GEO_KEY = "drivers:geo";

export function presenceKey(driverId: string): string {
  return `driver:${driverId}:presence`;
}

export async function markDriverPresent(
  redis: Redis,
  driverId: string,
  lng: number,
  lat: number,
  ttlSec: number,
): Promise<void> {
  try {
    await redis.geoadd(GEO_KEY, lng, lat, driverId);
    await redis.set(presenceKey(driverId), "1", "EX", ttlSec);
  } catch (err) {
    redisErrorsTotal.inc();
    throw new HttpError(503, redisDown("driver presence could not be updated", err));
  }
}

export async function clearDriverPresence(redis: Redis, driverId: string): Promise<void> {
  try {
    await redis.zrem(GEO_KEY, driverId);
    await redis.del(presenceKey(driverId));
  } catch (err) {
    redisErrorsTotal.inc();
    throw new HttpError(503, redisDown("driver presence could not be cleared", err));
  }
}

export async function searchNearbyDrivers(
  redis: Redis,
  lng: number,
  lat: number,
  radiusKm: number,
): Promise<Array<{ driverId: string; distanceKm: number }>> {
  let raw: unknown;
  try {
    raw = await redis.call(
      "GEOSEARCH",
      GEO_KEY,
      "FROMLONLAT",
      String(lng),
      String(lat),
      "BYRADIUS",
      String(radiusKm),
      "km",
      "ASC",
      "COUNT",
      "20",
      "WITHDIST",
    );
  } catch (err) {
    redisErrorsTotal.inc();
    throw new HttpError(503, redisDown("nearby driver search cannot run", err));
  }

  const fresh: Array<{ driverId: string; distanceKm: number }> = [];
  for (const [driverId, distance] of parseGeoResults(raw)) {
    let alive = 0;
    try {
      alive = await redis.exists(presenceKey(driverId));
    } catch (err) {
      redisErrorsTotal.inc();
      throw new HttpError(503, redisDown("nearby driver search cannot run", err));
    }
    if (!alive) {
      await redis.zrem(GEO_KEY, driverId).catch(() => undefined);
      continue;
    }
    fresh.push({ driverId, distanceKm: Number(distance) });
  }
  return fresh;
}

export function parseGeoResults(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (Array.isArray(raw[0])) {
    return (raw as unknown[][]).map((row) => [String(row[0]), String(row[1])]);
  }
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < raw.length; i += 2) {
    pairs.push([String(raw[i]), String(raw[i + 1])]);
  }
  return pairs;
}

function redisDown(reason: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : "connection failed";
  return `Redis is unavailable; ${reason} (${detail})`;
}
