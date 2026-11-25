import express from 'express';
import cors from 'cors';
import { requireAdminSession } from './auth.js';
import { connectToMongo } from '../database.js';
import { TimelineInputError, parseTimelineQuery, timelineKey, queryTimeline, timelineYears } from '../timeline.js';

export const TIMELINE_SESSION_MAX_AGE_MS = 30 * 86400000;

export function validTimelineSession(session, account, now = Date.now()) {
  if (!session || session.revokedAt != null || !account || account.disabled !== false || !Array.isArray(account.roles) || !account.roles.includes('admin')) return false;
  const created = +new Date(session.createdAt);
  if (!Number.isFinite(created) || created > now + 60000 || now - created > TIMELINE_SESSION_MAX_AGE_MS) return false;
  if (session.expiresAt != null && (!Number.isFinite(+new Date(session.expiresAt)) || +new Date(session.expiresAt) <= now)) return false;
  return true;
}

function privateHeaders(_req, res, next) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store', Pragma: 'no-cache', Expires: '0',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.vary('Cookie'); res.vary('Origin'); next();
}
const send = (res, status, data) => res.status(status).type('application/json').end(JSON.stringify(data));

export function createTimelineRouter({ authenticate = requireAdminSession, connect = connectToMongo,
  production = () => !['development','test'].includes(process.env.NODE_ENV), now = () => Date.now() } = {}) {
  const router = express.Router();
  router.use(privateHeaders);
  router.use((req, res, next) => {
    const allowed = ['https://andrewzc.net', 'https://api.andrewzc.net'];
    if (!production()) allowed.push('http://localhost', 'http://localhost:3000', 'http://localhost:8080');
    if ((req.headers.origin && !allowed.includes(req.headers.origin))
      || (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.origin)) return send(res, 403, { error: 'forbidden' });
    next();
  });
  router.use(cors({ origin: true, credentials: true, methods: ['GET', 'OPTIONS'], maxAge: 0 }));
  router.use(authenticate);
  router.use(async (req, res, next) => {
    try {
      const db = await connect();
      const session = await db.collection('sessions').findOne({ _id: req.admin.sessionId, accountId: req.admin.accountId, revokedAt: null },
        { projection: { createdAt: 1, expiresAt: 1, revokedAt: 1 }, maxTimeMS: 3000 });
      const account = await db.collection('accounts').findOne({ _id: req.admin.accountId },
        { projection: { disabled: 1, roles: 1 }, maxTimeMS: 3000 });
      if (!validTimelineSession(session, account, now())) return send(res, 401, { error: 'reauthentication_required' });
      req.timelineDb = db; next();
    } catch (error) {
      // Never log private record values, queries, cookies or database error messages.
      console.error('[timeline] authorization unavailable', error.name);
      return send(res, 503, { error: 'unavailable' });
    }
  });
  const handle = callback => async (req, res) => {
    try { await callback(req, res); }
    catch (error) {
      if (error instanceof TimelineInputError) return send(res, 400, { error: 'bad_request' });
      console.error('[timeline] read unavailable', error.name);
      return send(res, 503, { error: 'unavailable' });
    }
  };
  router.get('/years', handle(async (req, res) => {
    if (Object.keys(req.query).length) throw new TimelineInputError('No filters');
    return send(res, 200, { years: await timelineYears(req.timelineDb) });
  }));
  router.get('/', handle(async (req, res) => send(res, 200,
    await queryTimeline(req.timelineDb, parseTimelineQuery(req.query)))));
  router.get('/spans/:key/children', handle(async (req, res) => {
    const key = timelineKey(req.params.key);
    const result = await queryTimeline(req.timelineDb, parseTimelineQuery(req.query, key), key);
    return send(res, result ? 200 : 404, result || { error: 'not_found' });
  }));
  return router;
}

export const timelineRouter = createTimelineRouter();
