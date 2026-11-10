import { getAuth } from "@clerk/express";
import type { Request, RequestHandler } from "express";
import { storage } from "../storage";
import type { User } from "@shared/models/auth";
import { withStoragePrincipal } from "../storageBackend";

declare global {
  namespace Express {
    interface Request {
      dbUser?: User;
    }
  }
}

// The migrated subject (externalId) remains the application's primary key.
export function sessionUserId(req: Request): string | null {
  const auth = getAuth(req);
  if (!auth.userId) return null;
  const subject = auth.sessionClaims?.userId;
  return typeof subject === "string" && subject ? subject : auth.userId;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const id = sessionUserId(req);
    if (!id) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    // Clerk establishes identity; the selected application store owns its record.
    await withStoragePrincipal(id, async () => {
      const dbUser = await storage.ensureUser(id);
      if (!dbUser) {
        res.status(403).json({ message: "Account access unavailable" });
        return;
      }
      req.dbUser = dbUser;
      next();
    });
  } catch (error) {
    next(error);
  }
};

// Mixed API-key/browser endpoints remain public to API clients, but a browser
// session must still resolve its local account before its first write.
export const optionalAuth: RequestHandler = (req, res, next) => {
  if (!sessionUserId(req)) return next();
  return requireAuth(req, res, next);
};
