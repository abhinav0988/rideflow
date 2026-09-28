import { LatLng, quoteFareCents } from "@rideflow/shared";
import Redis from "ioredis";
import { Pool } from "pg";

export async function cachedFareCents(redis: Redis, pickup: LatLng, dropoff: LatLng): Promise<number> {
  const key = [
    "cache:fare",
    pickup.lat.toFixed(3),
    pickup.lng.toFixed(3),
    dropoff.lat.toFixed(3),
    dropoff.lng.toFixed(3),
  ].join(":");
  try {
    const hit = await redis.get(key);
    if (hit) return Number(hit);
  } catch {
    // Cache misses fall through to the fare function. Pricing does not depend on Redis.
  }
  const fare = quoteFareCents(pickup, dropoff);
  try {
    await redis.set(key, String(fare), "EX", 300);
  } catch {
    // A cache write failure does not change the quote.
  }
  return fare;
}

export interface DriverProfile {
  id: string;
  name: string;
  email: string;
  vehicle: string;
  status: string;
}

export async function cachedDriverProfile(
  redis: Redis,
  pool: Pool,
  driverId: string,
): Promise<DriverProfile | null> {
  const key = `cache:driver:${driverId}`;
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as DriverProfile;
  } catch {
    // Read the profile from Postgres when Redis is down.
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, d.vehicle, d.status
     FROM users u
     JOIN drivers d ON d.user_id = u.id
     WHERE u.id = $1`,
    [driverId],
  );
  const profile = (rows[0] as DriverProfile | undefined) ?? null;
  if (!profile) return null;
  try {
    await redis.set(key, JSON.stringify(profile), "EX", 60);
  } catch {
    // Profile is still returned from Postgres.
  }
  return profile;
}

export async function invalidateDriverCache(redis: Redis, driverId: string): Promise<void> {
  try {
    await redis.del(`cache:driver:${driverId}`);
  } catch {
    // The cache entry expires on its own.
  }
}
