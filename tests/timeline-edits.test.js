import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createTimelineRouter } from '../routes/timeline.js';
import { timelineName, TimelineEditError, renameSpan, deleteSpan } from '../timeline-edits.js';
import { TimelineInputError } from '../timeline.js';

const G = 'generation';
const match = (row, filter) => Object.entries(filter).every(([k, v]) => {
  const value = k.split('.').reduce((o, p) => o?.[p], row);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
    if ('$in' in v) return v.$in.includes(value);
    if ('$ne' in v) return value !== v.$ne;
    if ('$gte' in v || '$lte' in v) return (!v.$gte || value >= v.$gte) && (!v.$lte || value <= v.$lte);
  }
  return value === v;
});
function fakeDb(spans, batches) {
  const data = { spans, batches, timeline: [{ _id: 'state:timeline', status: 'complete', activeGeneration: G }] };
  const writes = [];
  const collection = name => ({
    async findOne(filter) { return data[name].find(row => match(row, filter)) || null; },
    find(filter) { return { toArray: async () => data[name].filter(row => match(row, filter)) }; },
    async updateOne(filter, update, options) {
      writes.push({ name, op: 'updateOne', filter, update });
      let row = data[name].find(r => match(r, filter));
      if (!row && options?.upsert) { row = { _id: filter._id, ...update.$setOnInsert }; data[name].push(row); }
      if (!row) return;
      Object.assign(row, update.$set || {});
      if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) row[k] = row[k].filter(x => x !== v);
    },
    async updateMany(filter, update) {
      writes.push({ name, op: 'updateMany', filter, update });
      for (const row of data[name].filter(r => match(r, filter))) Object.assign(row, update.$set);
    },
  });
  return { db: { collection }, data, writes };
}
const span = (key, extra) => ({ _id: key, key, generation: G, recordStatus: 'active', childKeys: [], ...extra });

test('names are trimmed, bounded and plain text', () => {
  assert.equal(timelineName('  Balkans \n trip '), 'Balkans trip');
  for (const bad of ['', '   ', 'x'.repeat(121), 'a\u0000b', 'a‮b', 42, null]) assert.throws(() => timelineName(bad), TimelineInputError);
});

test('renaming a trip writes a date-based trip-name decision and patches the span', async () => {
  const f = fakeDb([span('trip:a', { kind: 'trip', name: 'Venice → Budapest', firstLocalDate: '2006-12-27', lastLocalDate: '2007-01-08' })], []);
  assert.deepEqual(await renameSpan(f.db, 'trip:a', 'Balkans'), { key: 'trip:a', name: 'Balkans' });
  const decision = f.data.timeline.find(row => row._id === 'review:ui-name:trip:2006-12-27:2007-01-08');
  assert.equal(decision.kind, 'trip-name'); assert.equal(decision.name, 'Balkans'); assert.equal(decision.source, 'timeline-ui');
  assert.equal(decision.reviewStatus, 'reviewed'); assert.equal(decision.generation, G);
  assert.equal(f.data.spans[0].name, 'Balkans');
});

test('renaming a home stay keeps the stored prefix and uses span-presentation', async () => {
  const f = fakeDb([span('stay:a', { kind: 'stay', activity: 'home', name: 'At home: Den Haag' })], []);
  assert.equal((await renameSpan(f.db, 'stay:a', 'The Hague')).name, 'At home: The Hague');
  assert.equal(f.data.timeline.find(row => row._id === 'review:ui-name:stay:a').kind, 'span-presentation');
});

test('deleting a trip excludes the batches of its destinations and hides it', async () => {
  const d1 = span('destination:a', { kind: 'destination', parentKey: 'trip:a', location: { country: 'SE' },
    observedFirst: new Date('2008-04-05T10:00:00Z'), observedLast: new Date('2008-04-05T12:00:00Z') });
  const trip = span('trip:a', { kind: 'trip', name: 'Sweden', firstLocalDate: '2008-04-05', childKeys: ['destination:a'] });
  const batches = [
    { key: 'batch-in', generation: G, recordStatus: 'active', location: { country: 'SE' }, first: new Date('2008-04-05T10:00:00Z'), last: new Date('2008-04-05T12:00:00Z') },
    { key: 'batch-other-country', generation: G, recordStatus: 'active', location: { country: 'NL' }, first: new Date('2008-04-05T11:00:00Z'), last: new Date('2008-04-05T11:00:00Z') },
    { key: 'batch-later', generation: G, recordStatus: 'active', location: { country: 'SE' }, first: new Date('2008-04-06T10:00:00Z'), last: new Date('2008-04-06T10:00:00Z') },
  ];
  const f = fakeDb([trip, d1], batches);
  assert.deepEqual(await deleteSpan(f.db, 'trip:a'), { key: 'trip:a', excludedBatches: 1, withdrawnManualVisits: 0 });
  const exclusion = f.data.timeline.find(row => row.kind === 'batch-exclusion');
  assert.equal(exclusion.batchKey, 'batch-in'); assert.equal(exclusion._id, 'review:not-travel:ui:batch-in');
  assert.ok(f.data.spans.every(row => row.recordStatus === 'superseded'));
});

test('home stays cannot be deleted; manual visits are withdrawn instead of excluded', async () => {
  const f = fakeDb([span('stay:a', { kind: 'stay', activity: 'home' })], []);
  await assert.rejects(deleteSpan(f.db, 'stay:a'), error => error instanceof TimelineEditError && error.status === 400);
  const g = fakeDb([span('trip:b', { kind: 'trip', childKeys: ['destination:m'] }),
    span('destination:m', { kind: 'destination', parentKey: 'trip:b', manualVisitReviewDecision: 'review:manual-visit:x' })], []);
  g.data.timeline.push({ _id: 'review:manual-visit:x', reviewStatus: 'reviewed' });
  assert.equal((await deleteSpan(g.db, 'destination:m')).withdrawnManualVisits, 1);
  assert.equal(g.data.timeline.find(row => row._id === 'review:manual-visit:x').reviewStatus, 'withdrawn');
  assert.deepEqual(g.data.spans[0].childKeys, []);
});

async function server(t, db) {
  const app = express(); app.use(express.json());
  app.use('/timeline', createTimelineRouter({ connect: async () => db, authenticate: (req, res, next) => next() }));
  const s = createServer(app); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => s.close(resolve)));
  return `http://127.0.0.1:${s.address().port}`;
}

test('edit routes require a trusted Origin and a JSON body with only a name', async t => {
  const f = fakeDb([span('trip:a', { kind: 'trip', name: 'Old', firstLocalDate: '2008-01-01', lastLocalDate: '2008-01-02' })], []);
  const url = await server(t, f.db);
  const patch = (headers, body) => fetch(url + '/timeline/spans/trip%3Aa', { method: 'PATCH', headers, body });
  assert.equal((await patch({ 'Content-Type': 'application/json' }, '{"name":"New"}')).status, 403);
  assert.equal((await patch({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{"name":"New"}')).status, 403);
  assert.equal((await patch({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://andrewzc.net' }, 'name=New')).status, 415);
  assert.equal((await patch({ 'Content-Type': 'application/json', Origin: 'https://andrewzc.net' }, '{"name":"New","x":1}')).status, 400);
  assert.equal(f.writes.length, 0);
  const ok = await patch({ 'Content-Type': 'application/json', Origin: 'https://andrewzc.net' }, '{"name":"New"}');
  assert.equal(ok.status, 200); assert.equal((await ok.json()).name, 'New');
  const missing = await fetch(url + '/timeline/spans/trip%3Ab', { method: 'DELETE', headers: { Origin: 'https://andrewzc.net' } });
  assert.equal(missing.status, 404);
});
