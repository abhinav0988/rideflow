import { UserRole } from "@rideflow/shared";
import { Logger } from "pino";

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: {
        id: string;
        role: UserRole;
        email: string;
      };
    }
  }
}

export {};
