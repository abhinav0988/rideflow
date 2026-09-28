import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit";
import { asyncHandler } from "../../middleware/request";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  acceptRide,
  activeRide,
  advanceRide,
  cancelRide,
  createRide,
  getRideForUser,
  listOffers,
  rejectRide,
  RideDeps,
} from "./service";

export function rideRoutes(deps: RideDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.config.jwtSecret);
  const limitCreate = rateLimit(deps.redis, "ride-create", 10, 60);

  router.post(
    "/",
    auth,
    requireRole("rider"),
    limitCreate,
    asyncHandler(async (req, res) => {
      const result = await createRide(
        deps,
        req.user!.id,
        { lat: Number(req.body?.pickupLat), lng: Number(req.body?.pickupLng) },
        { lat: Number(req.body?.dropoffLat), lng: Number(req.body?.dropoffLng) },
        headerKey(req.header("idempotency-key")),
      );
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    "/active",
    auth,
    asyncHandler(async (req, res) => {
      const ride = await activeRide(deps, req.user!.id);
      res.json({ ride });
    }),
  );

  router.get(
    "/offers",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      const rides = await listOffers(deps, req.user!.id);
      res.json({ rides });
    }),
  );

  router.get(
    "/:id",
    auth,
    asyncHandler(async (req, res) => {
      const ride = await getRideForUser(deps, req.user!.id, req.params.id);
      res.json({ ride });
    }),
  );

  router.post(
    "/:id/accept",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      const result = await acceptRide(
        deps,
        req.user!.id,
        req.params.id,
        headerKey(req.header("idempotency-key")),
      );
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/:id/reject",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      const ride = await rejectRide(deps, req.user!.id, req.params.id);
      res.json(ride);
    }),
  );

  router.post(
    "/:id/arrive",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      res.json(await advanceRide(deps, req.user!.id, req.params.id, "arrived"));
    }),
  );

  router.post(
    "/:id/start",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      res.json(await advanceRide(deps, req.user!.id, req.params.id, "in_progress"));
    }),
  );

  router.post(
    "/:id/complete",
    auth,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      res.json(await advanceRide(deps, req.user!.id, req.params.id, "completed"));
    }),
  );

  router.post(
    "/:id/cancel",
    auth,
    asyncHandler(async (req, res) => {
      res.json(await cancelRide(deps, req.user!.id, req.params.id));
    }),
  );

  return router;
}

function headerKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
