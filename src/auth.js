const jwt = require("jsonwebtoken");
const { db } = require("./db");

const COOKIE_NAME = "session_token";

function sessionSecret() {
  return process.env.SESSION_SECRET || "dev-session-secret-change-me";
}

function buildSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    slug: user.slug,
    status: user.status || "active",
  };
}

function signSessionToken(user) {
  const sessionVersion = Number(user?.session_version || 0);
  return jwt.sign(
    {
      ...buildSessionUser(user),
      sv: Number.isFinite(sessionVersion) ? sessionVersion : 0,
    },
    sessionSecret(),
    {
    expiresIn: "7d",
    }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

function loadUserFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, sessionSecret());
    const user = db
      .prepare("select id, name, email, role, slug, status, session_version from users where id = ?")
      .get(payload.id);
    if (!user) return null;
    if (String(user.status || "active").toLowerCase() !== "active") return null;
    const tokenVersion = Number(payload.sv);
    if (Number.isFinite(tokenVersion) && tokenVersion !== Number(user.session_version || 0)) {
      return null;
    }
    return user || null;
  } catch {
    return null;
  }
}

function attachCurrentUser(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  const user = loadUserFromToken(token);
  req.user = user || null;
  res.locals.currentUser = user || null;
  next();
}

function wantsHtml(req) {
  return !String(req.originalUrl || "").startsWith("/api/") && !!req.accepts("html");
}

function loginPathForRequest(req) {
  const originalUrl = String(req.originalUrl || "");
  const safeReturnTo = originalUrl.startsWith("/") && !originalUrl.startsWith("//")
    ? encodeURIComponent(originalUrl)
    : "";
  return safeReturnTo ? `/signin?returnTo=${safeReturnTo}` : "/signin";
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (wantsHtml(req)) {
      return res.redirect(loginPathForRequest(req));
    }
    return res.status(401).json({ error: "Authentication required." });
  }
  return next();
}

function requireRole(allowedRoles, options = {}) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const failureMessage = options.failureMessage || "Access denied.";
  return (req, res, next) => {
    if (!req.user) {
      if (wantsHtml(req)) {
        return res.redirect(loginPathForRequest(req));
      }
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!roles.includes(req.user.role)) {
      if (wantsHtml(req)) {
        return res.status(403).render("error", {
          title: "Access denied",
          message: failureMessage,
        });
      }
      return res.status(403).json({ error: failureMessage });
    }
    return next();
  };
}

function requireAdmin(req, res, next) {
  return requireRole("admin", { failureMessage: "Admin access required." })(req, res, next);
}

function requireVendor(req, res, next) {
  return requireRole("vendor", { failureMessage: "Vendor access required." })(req, res, next);
}

function requireUser(req, res, next) {
  return requireRole("user", { failureMessage: "User access required." })(req, res, next);
}

function requireAdminOrVendor(req, res, next) {
  return requireRole(["admin", "vendor"], { failureMessage: "Admin or vendor access required." })(req, res, next);
}

function requireAdminOrUser(req, res, next) {
  return requireRole(["admin", "user"], { failureMessage: "Admin or user access required." })(req, res, next);
}

module.exports = {
  COOKIE_NAME,
  attachCurrentUser,
  buildSessionUser,
  clearSessionCookie,
  requireRole,
  requireAdmin,
  requireVendor,
  requireUser,
  requireAdminOrVendor,
  requireAdminOrUser,
  requireAuth,
  setSessionCookie,
  signSessionToken,
};
