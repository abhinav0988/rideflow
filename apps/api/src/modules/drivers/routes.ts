import { Router } from "express";
import { asyncHandler } from "../../middleware/request";
import { requireAuth, requireRole } from "../../middleware/auth";
import { cachedDriverProfile } from "../../redis/cache";
import { searchNearbyDrivers } from "../../redis/geo";
import { RideDeps, setDriverOffline, setDriverOnline, updateDriverLocation } from "../rides/service";

export function driverRoutes(deps: RideDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.config.jwtSecret);

  router.get(
    "/nearby",
    auth,
    asyncHandler(async (req, res) => {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const radiusKm = Number(req.query.radiusKm ?? deps.config.nearbyRadiusKm);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        res.status(400).json({ error: "lat and lng are required" });
        return;
      }
      const drivers = await searchNearbyDrivers(deps.redis, lng, lat, radiusKm);
      res.json({ drivers });
    }),
  );

  router.use(auth, requireRole("driver"));

  router.post(
    "/online",
    asyncHandler(async (req, res) => {
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      await setDriverOnline(deps, req.user!.id, lat, lng);
      res.json({ status: "online" });
    }),
  );

  router.post(
    "/offline",
    asyncHandler(async (req, res) => {
      await setDriverOffline(deps, req.user!.id);
      res.json({ status: "offline" });
    }),
  );

  router.post(
    "/location",
    asyncHandler(async (req, res) => {
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      await updateDriverLocation(deps, req.user!.id, lat, lng);
      const rideId = typeof req.body?.rideId === "string" ? req.body.rideId : undefined;
      if (rideId) {
        deps.emit(`ride:${rideId}`, "ride:location", {
          rideId,
          driverId: req.user!.id,
          lat,
          lng,
        });
      }
      res.json({ ok: true });
    }),
  );

  router.get(
    "/me",
    asyncHandler(async (req, res) => {
      const profile = await cachedDriverProfile(deps.redis, deps.pool, req.user!.id);
      if (!profile) {
        res.status(404).json({ error: "Driver profile not found" });
        return;
      }
      res.json({ driver: profile });
    }),
  );

  return router;
}
