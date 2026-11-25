// Private timeline read model. Only the authenticated timeline router calls it.
const KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const MAX_LIMIT = 100;
export const TIMELINE_FIELDS = {
  _id: 0, key: 1, kind: 1, name: 1, activity: 1, role: 1, tripType: 1, purpose: 1, modes: 1,
  observedFirst: 1, observedLast: 1, firstLocalDate: 1, lastLocalDate: 1,
  coreObservedFirst: 1, coreObservedLast: 1, countries: 1, coreCountries: 1,
  childKeys: 1, parentKey: 1, reviewStatus: 1, reviewScope: 1, needsReview: 1, boundaryStatus: 1,
};

export class TimelineInputError extends Error {}
const scalar = (value, name) => {
  if (typeof value !== 'string') throw new TimelineInputError(`Invalid ${name}`);
  return value;
};
export function timelineKey(value) {
  if (typeof value !== 'string' || !KEY.test(value)) throw new TimelineInputError('Invalid span key');
  return value;
}
function day(value, name) {
  value = scalar(value, name);
  const date = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) throw new TimelineInputError(`Invalid ${name}`);
  return date;
}
export function parseTimelineQuery(query, scope = 'top') {
  for (const key of Object.keys(query)) if (!['from', 'to', 'limit', 'cursor'].includes(key)) throw new TimelineInputError(`Unknown filter ${key}`);
  const from = query.from === undefined ? null : day(query.from, 'from');
  const to = query.to === undefined ? null : day(query.to, 'to');
  if (from && to && from >= to) throw new TimelineInputError('Invalid date range');
  const limit = query.limit === undefined ? 50 : Number(scalar(query.limit, 'limit'));
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TimelineInputError('Invalid limit');
  let cursor = null;
  if (query.cursor !== undefined) {
    const text = scalar(query.cursor, 'cursor');
    if (text.length > 800 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new TimelineInputError('Invalid cursor');
    try {
      cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
      if (cursor.scope !== scope || typeof cursor.key !== 'string' || !KEY.test(cursor.key) || typeof cursor.date !== 'string'
        || new Date(cursor.date).toISOString() !== cursor.date) throw new Error();
    } catch { throw new TimelineInputError('Invalid cursor'); }
  }
  return { from, to, limit, cursor };
}

export function timelineDTO(row) {
  // Explicit output allowlist: never return source IDs, Photos identifiers,
  // Mongo IDs, private database configuration or raw evidence diagnostics.
  return Object.fromEntries([
    ...['key','kind','name','activity','role','tripType','purpose','modes','observedFirst','observedLast',
      'firstLocalDate','lastLocalDate','coreObservedFirst','coreObservedLast','countries','coreCountries',
      'parentKey','reviewStatus','reviewScope','needsReview','boundaryStatus']
      .filter(key => row[key] !== undefined).map(key => [key, row[key]]),
    ['childCount', Array.isArray(row.childKeys) ? row.childKeys.length : 0],
  ]);
}

async function stateFilter(db) {
  const state = await db.collection('timeline').findOne({ _id: 'state:timeline', status: 'complete' },
    { projection: { activeGeneration: 1 }, maxTimeMS: 3000 });
  if (!state) return null;
  return { generation: state.activeGeneration, recordStatus: 'active' };
}

export async function queryTimeline(db, options, parent = null) {
  const active = await stateFilter(db);
  if (!active) return { spans: [], nextCursor: null };
  if (parent && !await db.collection('spans').findOne({ ...active, key: parent }, { projection: { _id: 1 }, maxTimeMS: 3000 })) return null;
  const filter = { ...active, ...(parent ? { parentKey: parent } : { level: 'top', parentKey: null }) };
  const and = [];
  if (options.from) and.push({ observedLast: { $gte: options.from } });
  if (options.to) and.push({ observedFirst: { $lt: options.to } });
  const ascending = Boolean(parent), direction = ascending ? 1 : -1;
  if (options.cursor) {
    const operator = ascending ? '$gt' : '$lt';
    const date = new Date(options.cursor.date);
    and.push({ $or: [{ observedFirst: { [operator]: date } }, { observedFirst: date, key: { [operator]: options.cursor.key } }] });
  }
  if (and.length) filter.$and = and;
  const rows = await db.collection('spans').find(filter, { projection: TIMELINE_FIELDS, maxTimeMS: 3000 })
    .sort({ observedFirst: direction, key: direction }).limit(options.limit + 1).toArray();
  const more = rows.length > options.limit, selected = rows.slice(0, options.limit), end = selected.at(-1);
  return { spans: selected.map(timelineDTO), nextCursor: more ? Buffer.from(JSON.stringify({
    scope: parent || 'top', date: new Date(end.observedFirst).toISOString(), key: end.key,
  })).toString('base64url') : null };
}

export async function timelineYears(db) {
  const active = await stateFilter(db);
  if (!active) return [];
  const [bounds] = await db.collection('spans').aggregate([
    { $match: { ...active, level: 'top', parentKey: null } },
    { $group: { _id: null, first: { $min: '$observedFirst' }, last: { $max: '$observedLast' } } },
  ], { maxTimeMS: 3000 }).toArray();
  if (!bounds) return [];
  const first = new Date(bounds.first).getUTCFullYear(), last = new Date(bounds.last).getUTCFullYear();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 150) throw new Error('Invalid timeline bounds');
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}
