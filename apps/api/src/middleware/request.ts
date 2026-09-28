import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { HttpError } from "../httpError";
import { logger } from "../logger";
import { httpRequestDurationSeconds, httpRequestsTotal, routeLabel } from "../metrics";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header("x-request-id") || randomUUID();
  req.id = requestId;
  req.log = logger.child({ requestId });
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    const route = routeLabel(req);
    httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
    httpRequestDurationSeconds.observe({ method: req.method, route }, ms / 1000);
    req.log.info(
      {
        method: req.method,
        path: req.originalUrl,
        route,
        status: res.statusCode,
        ms,
      },
      "request",
    );
  });
  next();
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.id;
  if (err instanceof HttpError) {
    req.log?.warn({ status: err.status, err: err.message }, "request failed");
    res.status(err.status).json({ error: err.message, requestId });
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal server error", requestId });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
