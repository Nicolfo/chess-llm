import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';

// Optional password protection: enabled only when APP_PASSWORD is set.
// A successful login sets an HttpOnly cookie holding an HMAC derived from the password,
// so changing the password logs everyone out and no session store is needed.
const COOKIE = 'chess_llm_session';
const MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_FAILURES = 10; // per IP and window, then 429
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/logout', '/healthz']);

interface AuthOptions {
  password: string | undefined;
  publicDir: string;
  secureCookie?: boolean;
}

export function authMiddleware({ password, publicDir, secureCookie = false }: AuthOptions): express.Router {
  const router = express.Router();
  if (!password) return router;

  const token = crypto.createHmac('sha256', password).update('chess-llm-session-v1').digest('base64url');
  const failures = new Map<string | undefined, { count: number; since: number }>(); // by client IP

  router.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));

  router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const entry = failures.get(ip);
    if (entry && now - entry.since > FAILURE_WINDOW_MS) failures.delete(ip);
    if ((failures.get(ip)?.count ?? 0) >= MAX_FAILURES) {
      return res.redirect(303, loginUrl({ error: 'locked', next: req.body?.next }));
    }

    if (!safeEqual(String(req.body?.password ?? ''), password)) {
      const f = failures.get(ip) ?? { count: 0, since: now };
      f.count++;
      failures.set(ip, f);
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      return res.redirect(303, loginUrl({ error: '1', next: req.body?.next }));
    }

    failures.delete(ip);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie || req.secure,
      maxAge: MAX_AGE_S * 1000,
      path: '/',
    });
    res.redirect(303, safeNext(req.body?.next));
  });

  router.get('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  router.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || safeEqual(readCookie(req, COOKIE) ?? '', token)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
    res.redirect(303, loginUrl({ next: req.originalUrl }));
  });

  setInterval(() => {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    for (const [ip, f] of failures) if (f.since < cutoff) failures.delete(ip);
  }, FAILURE_WINDOW_MS).unref();

  console.log('[auth] password protection enabled');
  return router;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req: express.Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// Only same-site relative paths, so the login page can't be used as an open redirect.
function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

function loginUrl({ error, next }: { error?: string; next?: unknown }): string {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (safeNext(next) !== '/') params.set('next', safeNext(next));
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
