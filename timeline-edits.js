// Private timeline edits from the timeline page (rename, delete).
//
// Each edit does two things:
// - writes a reviewed decision to the `timeline` metadata collection, so the
//   next andrewzc-v4 timeline cleanup run keeps the change, and
// - patches the active spans right away, so the page shows it without a rerun.
//
// Renames: a trip gets a `trip-name` decision on its exact dates (applied after
// other trip names); any other span gets a `span-presentation` decision by key.
// Deletes: the photo batches behind the span are excluded as not-travel, the
// same as a reviewed `batch-exclusion`; a manual visit is withdrawn instead.
// Home stays cannot be deleted: that would discard months of evidence.
import { TimelineInputError } from './timeline.js';

export class TimelineEditError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const MAX_NAME = 120;
export function timelineName(value) {
  if (typeof value !== 'string') throw new TimelineInputError('Invalid name');
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME || /[\p{Cc}\p{Cf}]/u.test(name)) throw new TimelineInputError('Invalid name');
  return name;
}

const today = () => new Date().toISOString().slice(0, 10);

async function activeContext(db) {
  const state = await db.collection('timeline').findOne({ _id: 'state:timeline', status: 'complete' },
    { projection: { activeGeneration: 1 }, maxTimeMS: 3000 });
  if (!state) throw new TimelineEditError(409, 'not_ready');
  return { generation: state.activeGeneration, recordStatus: 'active' };
}

async function activeSpan(db, active, key) {
  const span = await db.collection('spans').findOne({ ...active, key }, { maxTimeMS: 3000 });
  if (!span) throw new TimelineEditError(404, 'not_found');
  return span;
}

async function saveDecision(db, active, decision) {
  const now = new Date();
  await db.collection('timeline').updateOne({ _id: decision._id },
    { $set: { ...decision, reviewStatus: 'reviewed', reviewedBy: 'andrewzc', source: 'timeline-ui',
      generation: active.generation, recordStatus: 'active', updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true });
}

export async function renameSpan(db, key, value) {
  const name = timelineName(value);
  const active = await activeContext(db);
  const span = await activeSpan(db, active, key);
  if (span.kind === 'trip') {
    await saveDecision(db, active, {
      _id: `review:ui-name:trip:${span.firstLocalDate}:${span.lastLocalDate}`, kind: 'trip-name', name,
      firstLocalDate: span.firstLocalDate, lastLocalDate: span.lastLocalDate,
      reason: `Andrew renamed this trip on the timeline page (${today()})`,
    });
  } else {
    await saveDecision(db, active, {
      _id: `review:ui-name:${span.key}`, kind: 'span-presentation', spanKey: span.key, name,
      reason: `Andrew renamed this span on the timeline page (${today()})`,
    });
  }
  // Stays are stored as "At home: X"; the page strips that prefix.
  const stored = span.activity === 'home' && /^At home:\s*/.test(span.name || '') && !/^At home:/.test(name) ? `At home: ${name}` : name;
  await db.collection('spans').updateOne({ _id: span._id }, { $set: { name: stored, uiEditedAt: new Date() } });
  return { key: span.key, name: stored };
}

async function descendants(db, active, span) {
  const rows = [span];
  for (let i = 0; i < rows.length; i++) {
    const keys = rows[i].childKeys || [];
    if (!keys.length) continue;
    rows.push(...await db.collection('spans').find({ ...active, key: { $in: keys } }, { maxTimeMS: 3000 }).toArray());
    if (rows.length > 5000) throw new TimelineEditError(400, 'too_large');
  }
  return rows;
}

export async function deleteSpan(db, key) {
  const active = await activeContext(db);
  const span = await activeSpan(db, active, key);
  if (span.kind === 'stay' || span.kind === 'home' || span.activity === 'home') throw new TimelineEditError(400, 'not_deletable');
  const rows = await descendants(db, active, span);
  const manual = rows.filter(row => row.manualVisitReviewDecision).map(row => row.manualVisitReviewDecision);
  // Destination windows are built from consecutive batches, so a destination's
  // observed window holds exactly its own batches (same-country check as a guard).
  const batchKeys = new Set();
  for (const destination of rows.filter(row => row.kind === 'destination' && !row.manualVisitReviewDecision)) {
    const code = destination.location?.country;
    const batches = await db.collection('batches').find({
      generation: active.generation, recordStatus: 'active',
      first: { $gte: new Date(destination.observedFirst) }, last: { $lte: new Date(destination.observedLast) },
      ...(code ? { 'location.country': code } : {}),
    }, { projection: { key: 1 }, maxTimeMS: 3000 }).toArray();
    for (const batch of batches) batchKeys.add(batch.key);
  }
  if (!batchKeys.size && !manual.length) throw new TimelineEditError(409, 'no_evidence');
  for (const batchKey of batchKeys) {
    await saveDecision(db, active, {
      _id: `review:not-travel:ui:${batchKey}`, kind: 'batch-exclusion', batchKey,
      reason: `Andrew deleted "${span.name}" (${span.firstLocalDate}) on the timeline page (${today()})`,
    });
  }
  if (manual.length) await db.collection('timeline').updateMany({ _id: { $in: manual } },
    { $set: { reviewStatus: 'withdrawn', withdrawnAt: new Date(), withdrawnVia: 'timeline-ui' } });
  // Hide now; the next cleanup run rebuilds names and boundaries around the gap.
  await db.collection('spans').updateMany({ _id: { $in: rows.map(row => row._id) } },
    { $set: { recordStatus: 'superseded', uiDeletedAt: new Date() } });
  if (span.parentKey) await db.collection('spans').updateOne({ ...active, key: span.parentKey }, { $pull: { childKeys: span.key } });
  return { key: span.key, excludedBatches: batchKeys.size, withdrawnManualVisits: manual.length };
}
