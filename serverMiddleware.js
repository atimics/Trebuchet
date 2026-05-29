// serverMiddleware.js
//
// Express middleware extracted from server.js so each piece can be
// tested independently without driving route handlers. Imported by
// server.js at startup.
//
// Exports:
//   ALLOWED_HOSTS              — Set of hostnames allowed through the DNS-rebinding defense
//   hostCheckMiddleware        — rejects requests with untrusted Host headers
//   securityHeadersMiddleware  — sets CSP + frame/type-sniff headers
//   apiSessionMiddleware       — requires x-trebuchet-session for /api/* (except /session, /proxy-image)
//   upload                     — multer instance for logo uploads
//   resolvePublicDir           — resolves the public/ dir path through asar-unpacked when packaged

import crypto from 'crypto';
import multer from 'multer';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const API_SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// Multer
// ---------------------------------------------------------------------------

const storage = multer.memoryStorage();
export const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 }, // 100KB Arweave free-tier limit
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true);
      return;
    }
    cb(new Error('Logo must be a PNG or JPG image'));
  },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * DNS-rebinding defense. Rejects any request whose Host header does not
 * claim to be 127.0.0.1 or localhost. Registered before the body parser
 * so a rejected request never has its body read into memory.
 */
export function hostCheckMiddleware(req, res, next) {
  const hostHeader = req.headers.host || '';
  const hostname = hostHeader.split(':')[0];
  if (!ALLOWED_HOSTS.has(hostname)) {
    console.warn(
      `Rejected request with disallowed Host header: ${hostHeader} ` +
      `${req.method} ${req.url}`,
    );
    return res
      .status(403)
      .json({ success: false, error: 'invalid Host header' });
  }
  next();
}

/**
 * Sets Content-Security-Policy, X-Frame-Options, and X-Content-Type-Options
 * headers on every response.
 */
export function securityHeadersMiddleware(_req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

/**
 * Requires a valid x-trebuchet-session header on all /api/* routes except
 * /api/session (which hands out the token) and /api/proxy-image (which is
 * a read-only passthrough loaded via HTML elements that can't attach
 * custom headers).
 */
export function apiSessionMiddleware(req, res, next) {
  if (req.path === '/session' || req.path === '/proxy-image') return next();
  const token = req.get('x-trebuchet-session');
  if (token !== API_SESSION_TOKEN) {
    return res
      .status(403)
      .json({ success: false, error: 'invalid API session' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Static file resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the public/ directory's path on disk. In dev/web mode, joins
 * against __dirname. In packaged Electron, rewrites the path past
 * app.asar to app.asar.unpacked so Express's streaming static middleware
 * can find unpacked files.
 */
export function resolvePublicDir(serverDirname) {
  const marker = `${path.sep}app.asar`;
  const idx = serverDirname.indexOf(marker);
  if (idx === -1) {
    return path.join(serverDirname, 'public');
  }
  const after = serverDirname[idx + marker.length];
  if (after !== undefined && after !== path.sep) {
    return path.join(serverDirname, 'public');
  }
  const rewritten =
    serverDirname.slice(0, idx) +
    `${path.sep}app.asar.unpacked` +
    serverDirname.slice(idx + marker.length);
  return path.join(rewritten, 'public');
}
