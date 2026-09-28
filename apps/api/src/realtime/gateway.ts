import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Logger } from "pino";
import { Pool } from "pg";
import { verifyToken } from "../middleware/auth";
import { mapRide, RideRow } from "../db/rideMapper";
import { updateDriverLocation, RideDeps } from "../modules/rides/service";

export async function useRedisAdapter(io: Server, redisUrl: string): Promise<() => Promise<void>> {
  const pub = createClient({ url: redisUrl });
  const sub = pub.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));
  return async () => {
    await pub.quit();
    await sub.quit();
  };
}

export async function attachGateway(
  io: Server,
  deps: RideDeps,
  log: Logger,
): Promise<() => Promise<void>> {
  let closeAdapter: () => Promise<void> = async () => {};
  try {
    closeAdapter = await useRedisAdapter(io, deps.config.redisUrl);
    log.info("socket.io redis adapter enabled");
  } catch (err) {
    log.error({ err }, "Redis adapter unavailable; Socket.IO is single-node");
  }

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.user = verifyToken(token, deps.config.jwtSecret);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as { id: string; role: "rider" | "driver" };
    socket.join(`user:${user.id}`);
    if (user.role === "driver") socket.join(`driver:${user.id}`);

    socket.on("ride:join", async (rideId: string) => {
      if (typeof rideId !== "string") return;
      const ride = await loadRide(deps.pool, rideId);
      if (!ride) return;
      const allowed =
        ride.riderId === user.id ||
        ride.driverId === user.id ||
        ride.offeredDriverIds.includes(user.id);
      if (!allowed) return;
      socket.join(`ride:${rideId}`);
      socket.emit("ride:update", ride);
    });

    socket.on("driver:location", async (body: { lat?: number; lng?: number; rideId?: string }) => {
      if (user.role !== "driver") return;
      const lat = Number(body?.lat);
      const lng = Number(body?.lng);
      try {
        await updateDriverLocation(deps, user.id, lat, lng);
      } catch (err) {
        socket.emit("driver:error", {
          error: err instanceof Error ? err.message : "Location update failed",
        });
        return;
      }
      if (typeof body?.rideId === "string") {
        io.to(`ride:${body.rideId}`).emit("ride:location", {
          rideId: body.rideId,
          driverId: user.id,
          lat,
          lng,
        });
      }
    });
  });

  return closeAdapter;
}

async function loadRide(pool: Pool, rideId: string) {
  const { rows } = await pool.query(`SELECT * FROM rides WHERE id = $1`, [rideId]);
  return rows[0] ? mapRide(rows[0] as RideRow) : null;
}
