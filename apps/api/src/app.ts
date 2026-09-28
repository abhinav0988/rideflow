import cors from "cors";
import express, { Express } from "express";
import { authRoutes } from "./modules/auth/routes";
import { driverRoutes } from "./modules/drivers/routes";
import { rideRoutes } from "./modules/rides/routes";
import { RideDeps } from "./modules/rides/service";
import { errorHandler, requestLogger } from "./middleware/request";
import { register, renderMetrics } from "./metrics";
import { ShutdownState } from "./shutdown";

export interface AppHealth {
  postgres: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  rabbitmq: () => boolean;
}

export function createApp(deps: RideDeps, health: AppHealth, state?: ShutdownState): Express {
  const runtime = state ?? { acceptingTraffic: true };
  const app = express();
  app.use(cors({ origin: deps.config.corsOrigin }));
  app.use(express.json());
  app.use(requestLogger);

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await renderMetrics(deps.pool));
  });

  app.get("/api/health/live", (_req, res) => {
    res.status(200).json({ status: "live" });
  });

  app.get("/api/health/ready", async (req, res) => {
    const dependencies = {
      postgres: await up(health.postgres),
      redis: await up(health.redis),
      rabbitmq: health.rabbitmq() ? "up" : "down",
    };
    const ready = runtime.acceptingTraffic && dependencies.postgres === "up" && dependencies.redis === "up";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      dependencies,
      requestId: req.id,
    });
  });

  app.get("/api/health", async (req, res) => {
    const checks = {
      postgres: await health.postgres(),
      redis: await health.redis(),
      rabbitmq: health.rabbitmq(),
    };
    const ok = checks.postgres && checks.redis && checks.rabbitmq;
    res.status(ok ? 200 : 503).json({ ok, ...checks, requestId: req.id });
  });

  app.use("/api/auth", authRoutes(deps));
  app.use("/api/drivers", driverRoutes(deps));
  app.use("/api/rides", rideRoutes(deps));
  app.use(errorHandler);
  return app;
}

async function up(check: () => Promise<boolean>): Promise<"up" | "down"> {
  try {
    return (await check()) ? "up" : "down";
  } catch {
    return "down";
  }
}
