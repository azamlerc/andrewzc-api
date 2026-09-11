// routes/middleware.js
// Shared helpers used across all route files.

// Strip internal fields from all responses.
export function strip(doc) {
  if (!doc) return doc;
  const { _id, wikiSummary, wikiEmbedding, captionEmbeddings, enrichedAt, __isNew, ...rest } = doc;
  return rest;
}

// Strip internal fields but keep wikiSummary (for single-entity responses).
export function stripKeepSummary(doc) {
  if (!doc) return doc;
  const { _id, wikiEmbedding, captionEmbeddings, enrichedAt, ...rest } = doc;
  return rest;
}

export function cleanError(err) {
  if (!err) return err;
  if (typeof err === "string") return err;
  return err.message || String(err);
}
