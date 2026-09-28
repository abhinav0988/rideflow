import {
  LatLng,
  RideDto,
  RideEvents,
  RideStatus,
  assertTransition,
  canTransition,
} from "@rideflow/shared";
import Redis from "ioredis";
import { Logger } from "pino";
import { Pool, PoolClient } from "pg";
import { AppConfig } from "../../config";
import { insertOutbox } from "../../db/outbox";
import { mapRide, RideRow } from "../../db/rideMapper";
import { HttpError, isUniqueViolation } from "../../httpError";
import {
  redisErrorsTotal,
  rideCancelledTotal,
  rideCompletedTotal,
  rideMatchingDurationSeconds,
  rideRequestsTotal,
} from "../../metrics";
import { cachedFareCents, invalidateDriverCache } from "../../redis/cache";
import { clearDriverPresence, markDriverPresent, searchNearbyDrivers } from "../../redis/geo";
import { readIdempotency, saveIdempotency, StoredResponse } from "../../redis/idempotency";

export interface RideDeps {
  pool: Pool;
  redis: Redis;
  config: AppConfig;
  publish: (routingKey: string, payload: object) => Promise<void>;
  emit: (room: string, event: string, payload: unknown) => void;
  log: Logger;
}

export async function registerDriver(pool: Pool, userId: string): Promise<void> {
  await pool.query(`INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
}

export async function setDriverOnline(
  deps: RideDeps,
  driverId: string,
  lat: number,
  lng: number,
): Promise<void> {
  assertLatLng(lat, lng, "Location");
  await deps.pool.query(
    `UPDATE drivers SET status = 'online', updated_at = now() WHERE user_id = $1`,
    [driverId],
  );
  try {
    await markDriverPresent(deps.redis, driverId, lng, lat, deps.config.driverPresenceTtlSec);
  } catch (err) {
    await deps.pool.query(
      `UPDATE drivers SET status = 'offline', updated_at = now() WHERE user_id = $1`,
      [driverId],
    );
    throw err;
  }
  await invalidateDriverCache(deps.redis, driverId);
}

export async function setDriverOffline(deps: RideDeps, driverId: string): Promise<void> {
  await deps.pool.query(
    `UPDATE drivers SET status = 'offline', updated_at = now() WHERE user_id = $1`,
    [driverId],
  );
  await clearDriverPresence(deps.redis, driverId);
  await invalidateDriverCache(deps.redis, driverId);
}

export async function updateDriverLocation(
  deps: RideDeps,
  driverId: string,
  lat: number,
  lng: number,
): Promise<void> {
  assertLatLng(lat, lng, "Location");
  const { rows } = await deps.pool.query(`SELECT status FROM drivers WHERE user_id = $1`, [driverId]);
  if (!rows[0]) throw new HttpError(404, "Driver profile not found");
  if (rows[0].status !== "online") throw new HttpError(409, "Driver is offline");
  await markDriverPresent(deps.redis, driverId, lng, lat, deps.config.driverPresenceTtlSec);
}

export async function createRide(
  deps: RideDeps,
  riderId: string,
  pickup: LatLng,
  dropoff: LatLng,
  idempotencyKey: string | undefined,
): Promise<StoredResponse> {
  if (!idempotencyKey) throw new HttpError(400, "Idempotency-Key header is required");
  assertLatLng(pickup.lat, pickup.lng, "Pickup");
  assertLatLng(dropoff.lat, dropoff.lng, "Dropoff");

  const storedKey = `ride.create:${idempotencyKey}`;
  const replay = await readIdempotency(deps.pool, deps.redis, riderId, storedKey);
  if (replay) return replay;

  const fareCents = await cachedFareCents(deps.redis, pickup, dropoff);
  const client = await deps.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const inserted = await insertRequestedRide(client, riderId, pickup, dropoff, fareCents, storedKey);
    await recordEvent(client, inserted.id, null, "requested", riderId);
    await transition(client, inserted.id, "requested", "matching", riderId);

    let nearby: Array<{ driverId: string; distanceKm: number }>;
    const matchStarted = process.hrtime.bigint();
    try {
      nearby = await searchNearbyDrivers(
        deps.redis,
        pickup.lng,
        pickup.lat,
        deps.config.nearbyRadiusKm,
      );
    } catch (err) {
      await client.query("COMMIT");
      committed = true;
      rideRequestsTotal.inc();
      throw err instanceof HttpError
        ? new HttpError(
            503,
            "Redis is unavailable; the ride was saved as matching and was not assigned",
          )
        : err;
    } finally {
      const elapsed = Number(process.hrtime.bigint() - matchStarted) / 1e9;
      if (Number.isFinite(elapsed)) rideMatchingDurationSeconds.observe(elapsed);
    }

    const offeredIds = nearby.slice(0, 5).map((driver) => driver.driverId);
    const finalStatus: RideStatus = offeredIds.length === 0 ? "no_drivers" : "offered";
    const finalRow = await transition(client, inserted.id, "matching", finalStatus, riderId, {
      offeredDriverIds: offeredIds,
    });
    await insertOutbox(client, finalRow.id, RideEvents.Requested, {
      rideId: finalRow.id,
      riderId,
      at: new Date().toISOString(),
    });
    await client.query("COMMIT");
    committed = true;
    rideRequestsTotal.inc();

    const dto = mapRide(finalRow);
    deps.emit(`user:${riderId}`, "ride:update", dto);
    if (finalStatus === "offered") {
      for (const driverId of offeredIds) {
        deps.emit(`driver:${driverId}`, "ride:offer", dto);
      }
    }
    await saveIdempotency(deps.pool, deps.redis, riderId, storedKey, 201, dto);
    return { status: 201, body: dto };
  } catch (err) {
    if (!committed) await client.query("ROLLBACK");
    if (isUniqueViolation(err)) {
      const existing = await rideByIdempotency(deps.pool, storedKey);
      if (existing?.status === "matching") return resumeMatching(deps, existing);
      if (existing) return { status: 200, body: mapRide(existing) };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function resumeMatching(deps: RideDeps, row: RideRow): Promise<StoredResponse> {
  const nearby = await searchNearbyDrivers(
    deps.redis,
    row.pickup_lng,
    row.pickup_lat,
    deps.config.nearbyRadiusKm,
  );
  const offeredIds = nearby.slice(0, 5).map((driver) => driver.driverId);
  const finalStatus: RideStatus = offeredIds.length === 0 ? "no_drivers" : "offered";
  const client = await deps.pool.connect();
  let finalRow: RideRow;
  try {
    await client.query("BEGIN");
    finalRow = await transition(client, row.id, "matching", finalStatus, row.rider_id, {
      offeredDriverIds: offeredIds,
    });
    await insertOutbox(client, finalRow.id, RideEvents.Requested, {
      rideId: finalRow.id,
      riderId: row.rider_id,
      at: new Date().toISOString(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const current = await mustGetRide(deps.pool, row.id);
    if (current.status !== "matching") return { status: 200, body: mapRide(current) };
    throw err;
  } finally {
    client.release();
  }
  const dto = mapRide(finalRow);
  deps.emit(`user:${row.rider_id}`, "ride:update", dto);
  if (finalStatus === "offered") {
    for (const driverId of offeredIds) deps.emit(`driver:${driverId}`, "ride:offer", dto);
  }
  await saveIdempotency(deps.pool, deps.redis, row.rider_id, row.idempotency_key ?? "", 200, dto);
  return { status: 200, body: dto };
}

export async function acceptRide(
  deps: RideDeps,
  driverId: string,
  rideId: string,
  idempotencyKey: string | undefined,
): Promise<StoredResponse> {
  if (!idempotencyKey) throw new HttpError(400, "Idempotency-Key header is required");
  const storedKey = `ride.accept:${rideId}:${idempotencyKey}`;
  const replay = await readIdempotency(deps.pool, deps.redis, driverId, storedKey);
  if (replay) return replay;

  const ride = await mustGetRide(deps.pool, rideId);
  if (ride.driver_id === driverId && ride.status !== "offered") {
    return { status: 200, body: mapRide(ride) };
  }
  if (ride.status !== "offered") throw new HttpError(409, "Ride is not open for acceptance");
  if (!ride.offered_driver_ids.includes(driverId)) {
    throw new HttpError(403, "This ride was not offered to you");
  }

  const lockKey = `ride:${rideId}:lock`;
  let locked = false;
  try {
    const acquired = await deps.redis.set(lockKey, driverId, "PX", 5000, "NX");
    if (acquired !== "OK") {
      const current = await mustGetRide(deps.pool, rideId);
      if (current.driver_id === driverId) return { status: 200, body: mapRide(current) };
      throw new HttpError(409, "Another driver is accepting this ride");
    }
    locked = true;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    redisErrorsTotal.inc();
    throw new HttpError(
      503,
      "Redis is unavailable; refusing to assign the ride without a lock",
    );
  }

  const client = await deps.pool.connect();
  try {
    assertTransition("offered", "accepted");
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE rides
       SET status = 'accepted', driver_id = $1, updated_at = now()
       WHERE id = $2 AND status = 'offered' AND $1 = ANY (offered_driver_ids)
       RETURNING *`,
      [driverId, rideId],
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      const current = await mustGetRide(deps.pool, rideId);
      if (current.driver_id === driverId) return { status: 200, body: mapRide(current) };
      throw new HttpError(409, "Ride was already taken");
    }
    await recordEvent(client, rideId, "offered", "accepted", driverId);
    await insertOutbox(client, rideId, RideEvents.Accepted, {
      rideId,
      driverId,
      at: new Date().toISOString(),
    });
    await client.query("COMMIT");
    const dto = mapRide(result.rows[0] as RideRow);
    broadcastRide(deps, dto);
    await saveIdempotency(deps.pool, deps.redis, driverId, storedKey, 200, dto);
    return { status: 200, body: dto };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    if (locked) {
      await deps.redis.del(lockKey).catch(() => undefined);
    }
  }
}

export async function rejectRide(deps: RideDeps, driverId: string, rideId: string): Promise<RideDto> {
  const ride = await mustGetRide(deps.pool, rideId);
  if (ride.status !== "offered") throw new HttpError(409, "Ride is not offered");
  if (!ride.offered_driver_ids.includes(driverId)) throw new HttpError(403, "This ride was not offered to you");
  const remaining = ride.offered_driver_ids.filter((id) => id !== driverId);
  if (remaining.length === 0) {
    const row = await transition(deps.pool, rideId, "offered", "no_drivers", driverId, {
      offeredDriverIds: [],
    });
    const dto = mapRide(row);
    deps.emit(`user:${dto.riderId}`, "ride:update", dto);
    return dto;
  }
  const result = await deps.pool.query(
    `UPDATE rides
     SET offered_driver_ids = $1, updated_at = now()
     WHERE id = $2 AND status = 'offered'
     RETURNING *`,
    [remaining, rideId],
  );
  if (result.rowCount === 0) throw new HttpError(409, "Ride is no longer offered");
  return mapRide(result.rows[0] as RideRow);
}

export async function advanceRide(
  deps: RideDeps,
  driverId: string,
  rideId: string,
  to: Extract<RideStatus, "arrived" | "in_progress" | "completed">,
): Promise<RideDto> {
  const ride = await mustGetRide(deps.pool, rideId);
  if (ride.driver_id !== driverId) throw new HttpError(403, "You are not the assigned driver");
  if (!canTransition(ride.status, to)) {
    throw new HttpError(409, `Cannot move a ride from ${ride.status} to ${to}`);
  }
  const client = await deps.pool.connect();
  let row: RideRow;
  try {
    await client.query("BEGIN");
    row = await transition(client, rideId, ride.status, to, driverId);
    if (to === "completed") {
      await insertOutbox(client, rideId, RideEvents.Completed, {
        rideId,
        driverId,
        at: new Date().toISOString(),
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const dto = mapRide(row);
  if (to === "completed") rideCompletedTotal.inc();
  broadcastRide(deps, dto);
  return dto;
}

export async function cancelRide(deps: RideDeps, userId: string, rideId: string): Promise<RideDto> {
  const ride = await mustGetRide(deps.pool, rideId);
  const participant = ride.rider_id === userId || ride.driver_id === userId;
  if (!participant) throw new HttpError(403, "You are not a participant on this ride");
  if (!canTransition(ride.status, "cancelled")) {
    throw new HttpError(409, `Cannot cancel a ride that is ${ride.status}`);
  }
  const client = await deps.pool.connect();
  let row: RideRow;
  try {
    await client.query("BEGIN");
    row = await transition(client, rideId, ride.status, "cancelled", userId);
    await insertOutbox(client, rideId, RideEvents.Cancelled, {
      rideId,
      actorId: userId,
      at: new Date().toISOString(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const dto = mapRide(row);
  rideCancelledTotal.inc();
  broadcastRide(deps, dto);
  return dto;
}

export async function getRideForUser(deps: RideDeps, userId: string, rideId: string): Promise<RideDto> {
  const ride = await mustGetRide(deps.pool, rideId);
  const allowed =
    ride.rider_id === userId ||
    ride.driver_id === userId ||
    ride.offered_driver_ids.includes(userId);
  if (!allowed) throw new HttpError(403, "You cannot view this ride");
  return mapRide(ride);
}

export async function listOffers(deps: RideDeps, driverId: string): Promise<RideDto[]> {
  const { rows } = await deps.pool.query(
    `SELECT * FROM rides
     WHERE status = 'offered' AND $1 = ANY (offered_driver_ids)
     ORDER BY created_at DESC`,
    [driverId],
  );
  return (rows as RideRow[]).map(mapRide);
}

export async function activeRide(deps: RideDeps, userId: string): Promise<RideDto | null> {
  const { rows } = await deps.pool.query(
    `SELECT * FROM rides
     WHERE (
       rider_id = $1 AND status NOT IN ('completed', 'cancelled', 'expired', 'no_drivers')
     ) OR (
       driver_id = $1 AND status IN ('accepted', 'arrived', 'in_progress')
     )
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapRide(rows[0] as RideRow) : null;
}

export async function expireOfferedRides(deps: RideDeps): Promise<number> {
  const { rows } = await deps.pool.query(
    `SELECT id FROM rides
     WHERE status = 'offered' AND updated_at < now() - make_interval(secs => $1::int)`,
    [deps.config.offerTtlSec],
  );
  let expired = 0;
  for (const row of rows) {
    try {
      const updated = await transition(deps.pool, row.id as string, "offered", "expired", null);
      const dto = mapRide(updated);
      broadcastRide(deps, dto);
      expired += 1;
    } catch (err) {
      deps.log.warn({ err, rideId: row.id }, "could not expire offer");
    }
  }
  return expired;
}

async function insertRequestedRide(
  client: PoolClient,
  riderId: string,
  pickup: LatLng,
  dropoff: LatLng,
  fareCents: number,
  idempotencyKey: string,
): Promise<RideRow> {
  const result = await client.query(
    `INSERT INTO rides (
       rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents, idempotency_key
     ) VALUES ($1, 'requested', $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [riderId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, fareCents, idempotencyKey],
  );
  return result.rows[0] as RideRow;
}

async function transition(
  db: Pool | PoolClient,
  rideId: string,
  from: RideStatus,
  to: RideStatus,
  actorId: string | null,
  patch?: { offeredDriverIds?: string[]; driverId?: string | null },
): Promise<RideRow> {
  assertTransition(from, to);
  const sets = ["status = $1", "updated_at = now()"];
  const values: unknown[] = [to];
  if (patch?.offeredDriverIds) {
    values.push(patch.offeredDriverIds);
    sets.push(`offered_driver_ids = $${values.length}`);
  }
  if (patch && "driverId" in patch) {
    values.push(patch.driverId ?? null);
    sets.push(`driver_id = $${values.length}`);
  }
  values.push(rideId, from);
  const idPos = values.length - 1;
  const fromPos = values.length;
  const result = await db.query(
    `UPDATE rides SET ${sets.join(", ")} WHERE id = $${idPos} AND status = $${fromPos} RETURNING *`,
    values,
  );
  if (result.rowCount === 0) throw new HttpError(409, `Ride is no longer ${from}`);
  await recordEvent(db, rideId, from, to, actorId);
  return result.rows[0] as RideRow;
}

async function recordEvent(
  db: Pool | PoolClient,
  rideId: string,
  from: RideStatus | null,
  to: RideStatus,
  actorId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ride_events (ride_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4)`,
    [rideId, from, to, actorId],
  );
}

async function mustGetRide(pool: Pool, rideId: string): Promise<RideRow> {
  const { rows } = await pool.query(`SELECT * FROM rides WHERE id = $1`, [rideId]);
  if (!rows[0]) throw new HttpError(404, "Ride not found");
  return rows[0] as RideRow;
}

async function rideByIdempotency(pool: Pool, key: string): Promise<RideRow | null> {
  const { rows } = await pool.query(`SELECT * FROM rides WHERE idempotency_key = $1`, [key]);
  return (rows[0] as RideRow | undefined) ?? null;
}

function broadcastRide(deps: RideDeps, ride: RideDto): void {
  deps.emit(`user:${ride.riderId}`, "ride:update", ride);
  deps.emit(`ride:${ride.id}`, "ride:update", ride);
  if (ride.driverId) deps.emit(`driver:${ride.driverId}`, "ride:update", ride);
  for (const driverId of ride.offeredDriverIds) {
    deps.emit(`driver:${driverId}`, "ride:update", ride);
  }
}

function assertLatLng(lat: number, lng: number, label: string): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new HttpError(400, `${label} latitude is invalid`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new HttpError(400, `${label} longitude is invalid`);
  }
}
