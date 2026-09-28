import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { UserRole } from "@rideflow/shared";
import { HttpError } from "../httpError";

export interface AuthUser {
  id: string;
  role: UserRole;
  email: string;
}

interface TokenPayload {
  sub: string;
  role: UserRole;
  email: string;
}

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, secret, {
    expiresIn: "7d",
  });
}

export function verifyToken(token: string, secret: string): AuthUser {
  const payload = jwt.verify(token, secret) as TokenPayload;
  if (!payload.sub || (payload.role !== "rider" && payload.role !== "driver")) {
    throw new HttpError(401, "Invalid token");
  }
  return { id: payload.sub, role: payload.role, email: payload.email };
}

export function requireAuth(secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      next(new HttpError(401, "Missing token"));
      return;
    }
    try {
      req.user = verifyToken(token, secret);
      next();
    } catch {
      next(new HttpError(401, "Invalid token"));
    }
  };
}

export function requireRole(role: UserRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.role !== role) {
      next(new HttpError(403, `Requires ${role} role`));
      return;
    }
    next();
  };
}
