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

## April 14–15, 2026 Update — Autonomous Agents

### Summary

Built a full autonomous agents system from scratch: a data hygiene agent that watches every entity write and auto-corrects or flags problems in real time, and a transit projects monitor that scrapes urbanrail.net daily and inserts new openings automatically. Both agents post to a private Slack workspace.

### Architecture

New directory structure:
- `agents/` — agent logic, rule engine, scheduler, page cache, run records
- `connectors/` — Slack, Wikipedia, urbanrail.net
- `routes/agents.js` — HTTP endpoints for manual triggering and dry-runs

New MongoDB collections: `agent_runs`, `proposed`, `agent_context`, `agent_config`, `data_source_cache`, `feedback`.

New npm dependencies: `node-cron`, `@slack/web-api`.

New env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`.

### Hygiene Agent

`agents/hygiene.js` + `agents/hygieneRules.js` + `agents/runner.js`

A declarative rule engine evaluates every entity insert/update and either auto-fixes problems or flags them for review. Rules are defined as plain objects with `applies`, `check`, `fix`, and `message` functions.

Rules implemented:
- **U1** Country code normalization (lowercase → uppercase)
- **U2** `been: null` → `false`
- **U3** Key format check (no uppercase/spaces)
- **U4** Wikipedia link lookup for missing links
- **U6** Missing country/countries field (flag)
- **U7** Flag emoji derived from country code
- **U8** `dateAdded` added on agent-created records
- **U9** GeoJSON `location` derived from `coords`
- **U10** `coords` format normalization
- **C1–C3** Confluence-specific: prefix format, coords/prefix consistency, link correctness
- **P1–P4** Projects-specific: date format, valid type, transport emoji, `been: false`
- **T1, T3** Metro/tram/light-rail section validation and transport emoji
- **N1–N2** UNESCO country presence, UNESCO URL → Wikipedia
- **TR1–TR2** Tripoints countries count and flag icons
- **H1** Airbnb/hotels `been` check

The change stream fires the hygiene agent on every entity write in production (disabled locally to avoid double-firing). An hourly cron batch catches anything the change stream misses. A daily digest at 06:00 UTC posts a summary to `#hygiene`. Flags post immediately to `#hygiene` as they occur.

Key engineering detail: an idempotency check in the rule runner prevents infinite loops — if a fix would write the same value already present, it is silently skipped rather than written (which would re-trigger the change stream).

### Transit Projects Monitor

`agents/projects.js` + `connectors/urbanrail.js`

Fetches urbanrail.net/news.htm daily, parses transit openings using Claude Haiku, diffs against existing `projects` entities, and inserts new ones. Posts each new opening to `#projects` on Slack.

Key details:
- The page is served as Windows-1252 with WYSIWYG HTML from 1999. All parsing goes through a `htmlToText` pipeline that replaces type-indicator `<img>` tags (e.g. `metro-minilogo.gif`) with text tokens (`[METRO]`, `[TRAM]`, etc.) before stripping all other markup. Claude Haiku then parses the clean text.
- Only entries newer than the last-inserted date are sent to Claude, keeping token usage minimal on quiet days.
- Cutoff date is stored in `agent_context` and advanced after each successful run.
- Responses are cached in `data_source_cache` with a 23-hour TTL.
- Duplicate detection: exact key match skips insertion; fuzzy name match against undated entries updates their prefix instead; fuzzy match against dated entries warns to `#admin` but still inserts.
- Entity naming follows the existing projects convention: new system → `"Metro"`, new line → `"Line 5"`, extension → `"Line 2 to South Bellvue"`.
- `monorail` is a valid type (7 existing entries); gets `🚝` icon. `people-mover` gets `🚡`. Both are distinct from `metro`.

### HTTP Endpoints

All require admin session:
- `POST /agents/hygiene` `{ entityId, dryRun? }` — run hygiene on one entity
- `POST /agents/hygiene/batch` `{ lookbackHours? }` — manual batch run
- `GET /agents/hygiene/recent?hours=` — recent run records
- `POST /agents/projects` `{ dryRun? }` — run projects monitor
- `GET /agents/projects/recent?hours=` — recent run records

### Slack Channels

Bot (`andrewzc-agent`) is invited to: `#hygiene`, `#projects`, `#ideas`, `#travel`, `#admin`.

Entity edit URL format: `https://andrewzc.net/edit.html?list={list}&key={key}`
Page URL format: `https://andrewzc.net/page.html?id={pageId}#{entityKey}`

### Result

The server now runs autonomously. Every entity edit is inspected and corrected within seconds. New transit openings worldwide are discovered and inserted each morning without any manual action. Slack surfaces everything that needs human attention.

## April 15, 2026 Update — Route Refactoring

### Summary

Split the monolithic `server.js` into focused route modules to reduce file size and make future edits less prone to MCP timeouts.

### Changes Made

- Created `routes/middleware.js` — shared `strip`, `stripKeepSummary`, `cleanError` helpers
- Created `routes/auth.js` — `requireAdminSession` middleware + `/admin/login`, `/admin/logout`, `/admin/me` endpoints; `SESSION_PEPPER` guard moved here
- Created `routes/pages.js` — all `/pages/*` endpoints
- Created `routes/entities.js` — all `/entities/*` endpoints (CRUD, geo, bingo, props, similar, images)
- Created `routes/lookup.js` — top-level lookup endpoints (`/flags`, `/countries`, `/cities`, `/trips`, `/artists`, `/search`, `/coords`, `/wiki`)
- Created `routes/chat.js` — `/chat/*` endpoints + `preloadBots()` export
- Reduced `server.js` to ~116 lines: env guards, app setup, CORS, router mounts, and startup IIFE

### Result

No functional changes. Each route file is independently editable without touching anything else. `server.js` is now a thin entry point.

## April 15, 2026 Update — Chat Naming Cleanup

### Summary

Renamed the legacy chatbot modules from `agent` terminology to `chat` terminology so they no longer conflict conceptually with the newer autonomous agents system.

### Changes Made

- Created a new `chat/` folder for the conversational chatbots
- Moved `agent.js` to `chat/runtime.js`
- Moved `agent-hello.js` to `chat/hello.js`
- Moved `agent-railfan.js` to `chat/railfan.js`
- Moved `agent-senza.js` to `chat/senza.js`
- Renamed shared runtime exports from `chat`/`preload` to `runChat`/`preloadChat`
- Renamed chatbot definitions from `helloBot`, `railfanBot`, and `senzaBot` to `helloChat`, `railfanChat`, and `senzaChat`
- Updated `routes/chat.js` and `server.js` to import the new chat-module paths and names
- Removed an unused legacy top-level `chat.js` file that duplicated the old hello chatbot implementation
- Fixed moved-file imports so the chat modules resolve `../database.js` correctly from their new directory
- Updated the root `/` endpoint listing to include `POST /chat/railfan (admin)`

### Result

The codebase now uses `agents/` for autonomous background systems and `chat/` for user-facing conversational chatbots. That separation should make future growth less confusing and keep naming discipline clearer as the repo expands.
