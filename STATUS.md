# Status

Updated by Codex on March 12, 2026.

## Summary

Implemented the backend half of a new direct image upload workflow for the personal website.

## Changes Made Today

- Added admin-only image upload endpoints:
  - `POST /entities/:list/:key/images/presign`
  - `POST /entities/:list/:key/images/complete`
- Implemented server-side filename allocation based on the entity's existing `images` array.
- Presigned paired S3 uploads for:
  - original image at `<list>/<filename>`
  - thumbnail at `<list>/tn/<filename>`
- Added Mongo helper logic to append uploaded filenames safely to `entity.images`.
- Moved S3-specific logic out of `server.js` into `aws.js`.
- Updated the root `/` endpoint description to include the new image endpoints.
- Updated `README.md` to document:
  - new AWS-related env vars
  - `images` in the entity model
  - the new upload endpoint flow
- Added AWS SDK dependencies needed for S3 presigning.

## Result

The API now supports direct browser and CLI image uploads via presigned S3 URLs while keeping MongoDB as the source of truth for image association and ordering.

## March 27, 2026 Update

### Summary

Expanded the API with new trip- and artist-oriented aggregation endpoints so the frontend can render richer grouped views without duplicating lookup logic in the browser.

### Changes Made

- Added `GET /trips/:key`, which returns the matching page document plus all entities whose `trips` array contains that trip key.
- Added `GET /artists/:key`, which returns the matching `artists` entity plus all other entities whose `name` or `reference` exactly matches that artist's name.
- Added Mongo helpers for both trip and artist grouping in `database.js`.
- Updated the root `/` endpoint listing to include the new trip and artist routes.
- Updated `README.md` to document both new endpoints and their response shape.

### Result

The API now supports dedicated grouped views for trips and artists, giving the frontend one-call endpoints for those pages instead of forcing it to stitch together related entities client-side.

## March 27, 2026 Update (Bingo)

### Summary

Added a dedicated batch bingo endpoint so the frontend can fetch selected lists for selected countries or states in one API call instead of loading full static JSON datasets.

### Changes Made

- Added `POST /entities/bingo`, which accepts a `pages` array plus exactly one of `countries` or `states`.
- Implemented a new `getBingoEntities(...)` database helper to batch direct-list queries and property-derived pages in one normalized response.
- Reused the existing property-page hoisting logic so pages like `highest`, `lowest`, and `state-capitals` return top-level bingo-friendly fields.
- Normalized returned entities with `matchedPlaces` so the frontend can build bingo grids without rerunning place-membership logic client-side.
- Returned property-derived entities under the requested bingo page key in `list`, while preserving the original source list in `sourceList`.
- Added supporting Mongo indexes for `{ list, country }`, `{ list, countries }`, `{ list, state }`, and `{ list, states }`.
- Updated the root `/` endpoint listing and `README.md` to document the new endpoint and its request/response shape.

### Result

The API now supports a purpose-built bingo query path that is much closer to the frontend's actual data needs, reducing over-fetching and making the remaining bingo refactor straightforward.
