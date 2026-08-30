import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  findActiveSessionByToken,
  setSessionCookie,
  touchSession,
} from "../lib/session";

export interface AuthenticatedUser {
  id: string;
  username: string;
  name: string;
  age: number;
  email: string | null;
  mobileNumber: string | null;
  mobileVerificationStatus: "not_started" | "pending" | "verified";
  accountStatus: "active" | "suspended" | "deactivated";
  termsAcceptedAt: Date | null;
  role: "user" | "admin" | "manager" | "support" | "omb_host" | "tournament_host";
  createdAt: Date;
}

export function requireRole(
  ...roles: AuthenticatedUser["role"][]
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}

/**
 * Server-side session auth middleware. Validates a header token or the `sid`
 * cookie against `user_sessions`, extends the session's sliding expiration on
 * success, and attaches the authenticated user to `req.user`. Responds 401 otherwise.
 */
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authorizationHeader = req.get("authorization") ?? "";
  const xAccessTokenHeader = req.get("x-access-token") ?? "";

  let token = "";

  if (authorizationHeader) {
    const normalized = authorizationHeader.trim();
    if (/^Bearer\s+/i.test(normalized)) {
      token = normalized.replace(/^Bearer\s+/i, "").trim();
    } else {
      token = normalized;
    }
  }

  if (!token && xAccessTokenHeader) {
    token = xAccessTokenHeader.trim();
  }

  if (!token && req.cookies) {
    token = typeof req.cookies[SESSION_COOKIE_NAME] === "string" ? req.cookies[SESSION_COOKIE_NAME] : "";
  }

  if (!token) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const session = await findActiveSessionByToken(token);

  if (!session) {
    clearSessionCookie(res);
    res.status(401).json({ message: "Session is invalid or has expired." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId))
    .limit(1);

  if (!user || user.accountStatus !== "active") {
    clearSessionCookie(res);
    res.status(401).json({ message: "Session is invalid or has expired." });
    return;
  }

  const expiresAt = await touchSession(session.id);
  setSessionCookie(res, token, expiresAt);

  req.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    age: user.age,
    email: user.email ?? null,
    mobileNumber: user.mobileNumber ?? null,
    mobileVerificationStatus: user.mobileVerificationStatus,
    accountStatus: user.accountStatus,
    termsAcceptedAt: user.termsAcceptedAt ?? null,
    role: user.role,
    createdAt: user.createdAt,
  };

  next();
}
