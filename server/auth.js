/**
 * auth.js — Sessies en rollen (beheer / leerkracht).
 * Sessietokens leven in het geheugen; bij herstart van de server moet men opnieuw aanmelden.
 */
import { randomBytes } from "crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 uur
const sessions = new Map(); // token -> { role, name, userId, expires }

/**
 * Naam van de gebruiker (leerkracht/beheerder) wordt bewaard voor eigenaarschap en audit.
 * `userId` is gezet bij persoonlijke accounts, zodat sessies bij uitschakelen/verwijderen vervallen.
 */
export function createSession(role, name = "", userId = null) {
  const token = randomBytes(32).toString("hex");
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  sessions.set(token, {
    role,
    name: clean || (role === "admin" ? "Beheerder" : "Leerkracht"),
    userId,
    expires: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

/** Beëindigt alle sessies van een persoonlijk account (na uitschakelen, verwijderen of nieuw wachtwoord). */
export function destroySessionsOfUser(userId) {
  if (!userId) return 0;
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(token);
      n++;
    }
  }
  return n;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function tokenFromReq(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return req.headers["x-auth-token"] || null;
}

/** Vereist een geldige sessie met een van de opgegeven rollen. */
export function requireRole(...roles) {
  return (req, res, next) => {
    const s = getSession(tokenFromReq(req));
    if (!s) return res.status(401).json({ error: "Niet aangemeld of sessie verlopen." });
    if (!roles.includes(s.role)) return res.status(403).json({ error: "Onvoldoende rechten." });
    req.role = s.role;
    req.user = s.name;
    next();
  };
}

export function sessionUser(req) {
  return getSession(tokenFromReq(req))?.name ?? null;
}

export function sessionRole(req) {
  return getSession(tokenFromReq(req))?.role ?? null;
}

// ── Eenvoudige rate limit voor aanmeldpogingen ────────────────────────
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export function loginAllowed(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) return true;
  return a.count < MAX_ATTEMPTS;
}

export function registerFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else a.count++;
}

export function registerSuccess(ip) {
  attempts.delete(ip);
}
