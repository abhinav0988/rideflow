import { NextFunction, Request, Response } from "express";
import Redis from "ioredis";

export function rateLimit(redis: Redis, bucket: string, limit: number, windowSec: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const actor = req.ip || "unknown";
    const key = `rl:${bucket}:${actor}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      if (count > limit) {
        res.status(429).json({ error: "Too many requests", requestId: req.id });
        return;
      }
    } catch (err) {
      req.log?.warn({ err, bucket }, "rate limit skipped because Redis is unavailable");
    }
    next();
  };
}
