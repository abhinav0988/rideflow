import { Router } from "express";
import { UserRole } from "@rideflow/shared";
import { asyncHandler } from "../../middleware/request";
import { requireAuth, signToken } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { RideDeps } from "../rides/service";
import { getUser, loginUser, registerUser } from "./service";

export function authRoutes(deps: RideDeps): Router {
  const router = Router();
  const limitLogin = rateLimit(deps.redis, "login", 20, 60);

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const user = await registerUser(deps.pool, {
        email: String(req.body?.email ?? ""),
        password: String(req.body?.password ?? ""),
        name: String(req.body?.name ?? ""),
        role: req.body?.role as UserRole,
      });
      const token = signToken({ id: user.id, role: user.role, email: user.email }, deps.config.jwtSecret);
      res.status(201).json({ token, user });
    }),
  );

  router.post(
    "/login",
    limitLogin,
    asyncHandler(async (req, res) => {
      const { user, auth } = await loginUser(
        deps.pool,
        String(req.body?.email ?? ""),
        String(req.body?.password ?? ""),
      );
      const token = signToken(auth, deps.config.jwtSecret);
      res.json({ token, user });
    }),
  );

  router.get(
    "/me",
    requireAuth(deps.config.jwtSecret),
    asyncHandler(async (req, res) => {
      const user = await getUser(deps.pool, req.user!.id);
      res.json({ user });
    }),
  );

  return router;
}
