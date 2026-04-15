// routes/auth.js
// Admin auth endpoints and requireAdminSession middleware.
// Exports requireAdminSession so other routers can protect their routes.

import express from "express";
import crypto from "crypto";
import argon2 from "argon2";
import { findAccount, findSession, createSession, touchSession, revokeSession } from "../database.js";
import { cleanError } from "./middleware.js";

// SESSION_PEPPER is read lazily so dotenv.config() in server.js runs first.
// The guard check is in server.js alongside the other env vars.
let SESSION_PEPPER;

// ---- Session helpers ----

function sessionTokenToHash(token) {
  if (!SESSION_PEPPER) SESSION_PEPPER = process.env.SESSION_PEPPER;
  return crypto.createHmac("sha256", SESSION_PEPPER).update(token).digest("hex");
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function adminCookieOptions() {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "none",
    path:     "/",
    maxAge:   1000 * 60 * 60 * 24 * 365 * 10,
  };
}

// ---- Middleware ----

export async function requireAdminSession(req, res, next) {
  try {
    const raw = req.cookies?.admin_session;
    if (!raw) return res.status(401).json({ error: "unauthorized", message: "Missing admin session" });

    const hash    = sessionTokenToHash(raw);
    const session = await findSession(hash);
    if (!session) return res.status(401).json({ error: "unauthorized", message: "Invalid or revoked session" });

    touchSession(hash);
    req.admin = { accountId: session.accountId, sessionId: session._id };
    return next();
  } catch (err) {
    console.error("Auth failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
}

// ---- Router ----

export const authRouter = express.Router();

authRouter.post("/login", async (req, res) => {
  try {
    const { username, password, label } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "bad_request", message: "Missing username or password" });
    }

    const account = await findAccount(username);
    if (!account) return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });

    const ok = await argon2.verify(account.passwordHash, password);
    if (!ok)  return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });

    const token = makeSessionToken();
    const hash  = sessionTokenToHash(token);

    await createSession({
      accountId:        account._id,
      sessionTokenHash: hash,
      label,
      ip:        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
    });

    res.cookie("admin_session", token, adminCookieOptions());
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/login failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

authRouter.post("/logout", requireAdminSession, async (req, res) => {
  try {
    const hash = sessionTokenToHash(req.cookies.admin_session);
    await revokeSession(hash);
    res.clearCookie("admin_session", { path: "/" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/logout failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

authRouter.get("/me", async (req, res) => {
  try {
    const raw = req.cookies?.admin_session;
    if (!raw) return res.json({ authenticated: false });
    const session = await findSession(sessionTokenToHash(raw));
    return res.json({ authenticated: !!session });
  } catch {
    return res.json({ authenticated: false });
  }
});
