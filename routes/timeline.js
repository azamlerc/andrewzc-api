import express from 'express';
import { requireAdminSession } from './auth.js';
import { connectToMongo } from '../database.js';
import { TimelineInputError, parseTimelineQuery, timelineKey, queryTimeline, timelineYears } from '../timeline.js';
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

export function createTimelineRouter({ authenticate = requireAdminSession, connect = connectToMongo } = {}) {
  const router = express.Router();
  router.use(privateHeaders);
  router.use(authenticate);
  router.use(async (req, res, next) => {
    try {
      const db = await connect();
      req.timelineDb = db; next();
    } catch (error) {
      // Never log private record values, queries, cookies or database error messages.
      console.error('[timeline] connection unavailable', error.name);
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
