import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runMission, capabilities } from './tools.js';

const port = Number(process.env.PORT || 3000);
const sessions = new Map();
const started = Date.now();
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const publicRoot = resolve('public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const origin = process.env.PUBLIC_URL || `${secure ? 'https' : 'http'}://${req.headers.host}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  function json(value, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  let id = /(?:^|; )jarvis=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  let session = sessions.get(id);
  if (!session || session.until < Date.now()) {
    if (id) sessions.delete(id);
    id = randomBytes(32).toString('hex');
    session = { until: Date.now() + 8 * 60 * 60 * 1000, active: new Map(), audit: [] };
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `jarvis=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
  }
  const redirect = process.env.GOOGLE_REDIRECT_URI || `${origin}/auth/google/callback`;
  const log = entry => {
    const record = { id: randomBytes(8).toString('hex'), at: new Date().toISOString(), ...entry };
    session.audit.push(record);
    session.audit = session.audit.slice(-100);
    return record;
  };
  try {
    if (req.method === 'POST') {
      if (!req.headers.origin || req.headers.origin !== origin) return json({ error: 'Same-origin request required.' }, 403);
    }
    if (url.pathname === '/health') return json({ status: 'ok', app: 'Jarvis', version: '1.0.0', uptimeSeconds: Math.floor((Date.now() - started) / 1000) });
    if (url.pathname === '/api/status') return json({
      app: 'Jarvis', engine: process.env.OPENAI_API_KEY ? 'AI + deterministic tools' : 'Local command engine (not a general AI)',
      googleConfigured: Boolean(GOOGLE_ID && GOOGLE_SECRET), googleConnected: Boolean(session.google),
      capabilities, uptimeSeconds: Math.floor((Date.now() - started) / 1000),
      memory: 'Browser-local storage; server sessions are ephemeral', audit: session.audit
    });
    if (url.pathname === '/auth/google') {
      if (!GOOGLE_ID || !GOOGLE_SECRET) return json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in Render.' }, 503);
      session.state = randomBytes(32).toString('hex');
      const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      target.search = new URLSearchParams({ client_id: GOOGLE_ID, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly', state: session.state, access_type: 'offline', prompt: 'consent' }).toString();
      res.writeHead(302, { Location: target.href }); return res.end();
    }
    if (url.pathname === '/auth/google/callback') {
      const state = url.searchParams.get('state') || '';
      if (!session.state || state.length !== session.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(session.state))) return json({ error: 'OAuth state mismatch. Start connection again.' }, 400);
      delete session.state;
      if (!url.searchParams.get('code')) return json({ error: 'Google connection was not approved.' }, 400);
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, code: url.searchParams.get('code'), redirect_uri: redirect, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15000) });
      if (!tokenResponse.ok) throw new Error('Google token exchange failed.');
      session.google = await tokenResponse.json();
      session.google.expires_at = Date.now() + session.google.expires_in * 1000;
      log({ tool: 'google.connect', status: 'verified', detail: 'OAuth exchange completed; read-only scopes.' });
      res.writeHead(302, { Location: '/' }); return res.end();
    }
    if (url.pathname === '/api/disconnect' && req.method === 'POST') {
      if (session.google?.access_token) {
        await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: session.google.access_token }), signal: AbortSignal.timeout(8000) }).catch(() => {});
      }
      delete session.google; log({ tool: 'google.disconnect', status: 'verified', detail: 'Server session token removed.' }); return json({ disconnected: true });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      for (const controller of session.active.values()) controller.abort();
      session.active.clear();
      log({ tool: 'emergency.stop', status: 'verified', detail: 'All active session tool requests cancelled. Completed actions cannot be undone.' });
      return json({ stopped: true });
    }
    if (url.pathname === '/api/mission' && req.method === 'POST') {
      if (session.active.size >= 3) return json({ error: 'Too many active missions.' }, 429);
      const body = await readBody(req);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000) return json({ error: 'Message must be 1–4000 characters.' }, 400);
      if (session.google && session.google.expires_at < Date.now() && session.google.refresh_token) {
        const refresh = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, refresh_token: session.google.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(10000) });
        if (!refresh.ok) { delete session.google; throw new Error('Google session expired. Reconnect Google.'); }
        const fresh = await refresh.json(); Object.assign(session.google, fresh, { expires_at: Date.now() + fresh.expires_in * 1000 });
      }
      const missionId = randomBytes(12).toString('hex');
      const controller = new AbortController();
      session.active.set(missionId, controller);
      const timer = setTimeout(() => controller.abort(), 25000);
      log({ tool: 'mission.prepare', status: 'verified', detail: 'Allowlisted read-only tool plan prepared.', missionId });
      try {
        const result = await runMission(body, { token: session.google?.access_token, signal: controller.signal, log, missionId, started });
        return json({ missionId, ...result });
      } finally { clearTimeout(timer); session.active.delete(missionId); }
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return json({ error: 'Unknown endpoint.' }, 404);
    if (!['GET', 'HEAD'].includes(req.method)) return json({ error: 'Method not allowed.' }, 405);
    const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(publicRoot + '/')) return json({ error: 'Forbidden.' }, 403);
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' })[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (res.headersSent) return res.end();
    const message = error.code === 'ENOENT' ? 'Not found.' : error.name === 'AbortError' ? 'Mission stopped or timed out.' : error.message;
    json({ error: message }, error.code === 'ENOENT' ? 404 : 400);
  }
});
async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 20000) throw new Error('Request too large.'); }
  return JSON.parse(data || '{}');
}
setInterval(() => { for (const [key, value] of sessions) if (value.until < Date.now()) { for (const controller of value.active.values()) controller.abort(); sessions.delete(key); } }, 60000).unref();
server.listen(port, '0.0.0.0', () => console.log(`Jarvis listening on ${port}`));
