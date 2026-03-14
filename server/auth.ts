import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_TOKEN =
  process.env.SESSION_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
let csrfToken: string | null = null;

function getCsrfToken(): string {
  if (!csrfToken) csrfToken = crypto.randomBytes(32).toString("hex");
  return csrfToken;
}

const PUBLIC_PATHS = [
  "/api/health",
  "/api/auth/session",
  "/api/hook/", // hook endpoints are open (local only)
  "/api/round-table-meetings", // RemoteCC posts meeting results (local only)
  "/api/docs", // API documentation (agent-accessible)
  "/api/agent-channels", // agent channel map (local agent-accessible)
];

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Public paths
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  // Static files
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }

  // Check cookie or bearer token
  const cookie = req.headers.cookie ?? "";
  const cookieMatch = cookie.match(/pcd_session=([^;]+)/);
  const bearer = req.headers.authorization?.replace("Bearer ", "");
  const token = bearer || cookieMatch?.[1];

  if (token !== SESSION_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

export function sessionRoute(req: Request, res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `pcd_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
  );
  res.json({ ok: true, csrf_token: getCsrfToken() });
}
