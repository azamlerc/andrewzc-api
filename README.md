# andrewzc-api

REST API for the [andrewzc.net](https://andrewzc.net) personal website database. Serves the ~36,000 entities and 342 thematic lists that power the site, with support for name search, semantic search, geo search, and a natural language query interface backed by OpenAI function calling.

Live at: `https://api.andrewzc.net`

---

## Running Locally

```bash
npm install
cp .env.example .env   # fill in values
npm run dev            # node --watch server.js
```

### Environment Variables

| Variable         | Required | Description                                      |
|------------------|----------|--------------------------------------------------|
| `MONGODB_URI`    | ✅        | MongoDB connection string                        |
| `MONGODB_DB`     | ✅        | Database name                                    |
| `SESSION_PEPPER` | ✅        | HMAC secret for session token hashing            |
| `OPENAI_API_KEY` | ✅        | Required for semantic search and `/search`       |
| `AWS_REGION`     | —        | AWS region for presigned image uploads (default: `us-east-1`) |
| `S3_BUCKET`      | —        | S3 bucket for entity image uploads               |
| `PORT`           | —        | Port to listen on (default: 3000)                |

---

## Data Model

### Pages

A **page** is a thematic list — one of the 342 categories on the site. Each page has a unique `key` (e.g. `metros`, `confluence`, `cathedrals`) and corresponds to a page on the website.

Key fields:

| Field         | Type     | Description                                              |
|---------------|----------|----------------------------------------------------------|
| `key`         | string   | Unique identifier, used in all API calls                 |
| `name`        | string   | Display name (e.g. "Metros", "Confluence Points")        |
| `icon`        | string   | Emoji used to represent the list                         |
| `header`      | string   | One-line description shown at the top of the page        |
| `tags`        | string[] | Controls key generation and display behavior             |
| `notes`       | string[] | Editorial notes shown on the page                        |
| `propertyOf`  | string   | If set, this page is a detail list derived from a parent |

### Entities

An **entity** is a single item on a list — a metro system, a cathedral, a confluence point, a country, etc. Entities belong to one page via their `list` field.

Key fields:

| Field          | Type     | Description                                                   |
|----------------|----------|---------------------------------------------------------------|
| `list`         | string   | The page key this entity belongs to                           |
| `key`          | string   | Unique within the list; auto-derived from name + tags         |
| `name`         | string   | Display name                                                  |
| `link`         | string   | Wikipedia URL (most entities have one)                        |
| `icons`        | string   | Emoji or badge string shown next to the name                  |
| `been`         | boolean  | Whether Andrew has visited this place                         |
| `country`      | string   | ISO 2-letter country code (e.g. `FR`, `DE`)                  |
| `countries`    | string[] | For entities spanning multiple countries                      |
| `city`         | string   | City display name (e.g. `"Paris"`, `"New York, NY"`)         |
| `coords`       | object   | `{ lat, lon }` — display coordinates                         |
| `location`     | GeoJSON  | `{ type: "Point", coordinates: [lon, lat] }` — for geo search |
| `reference`    | string   | Secondary identifier used in key generation for some lists    |
| `notes`        | string[] | Personal notes in Andrew's voice                              |
| `props`        | object   | Structured facts (Wikidata-style); schema varies by list      |
| `images`       | string[] | Image filenames stored in S3 under `<list>/`                  |
| `wikiSummary`  | string   | First paragraph of Wikipedia article (returned on single fetch)|

#### The `props` object

`props` stores objective, structured facts about an entity. The schema varies by list but is consistent within a list. Values can be booleans, strings, numbers, or arrays of objects. Examples:

```json
// A metro system
"props": {
  "stations": 68,
  "opened": 1900,
  "lines": 16,
  "automatic": true
}

// A country
"props": {
  "european-union": true,
  "eurozone": true,
  "schengen": true,
  "population": 67000000
}
```

#### `been` and visit tracking

Most place entities have a `been` boolean. `true` means Andrew has been there; `false` (or absent) means it's on the list but not yet visited. The meaning of "visited" varies by list — see `website-intro.md` in the context repo for the nuances.

---

## Endpoints

### Health

```
GET /healthz
```
Returns `200 ok`. Use for uptime checks.

---

### Pages

#### List all pages
```
GET /pages
```
Returns all 342 pages with full metadata.

#### Create a page
```
POST /pages
```
Admin-only. Creates a page document, deriving `key` from `name` via `simplify(name)`.

#### Page summaries (lightweight)
```
GET /pages/summaries
```
Returns `{ key, name, description }` for each page — used to build context for the natural language search router. Much smaller payload than `/pages`.

#### Fetch a page
```
GET /pages/:key
```
Returns the page document from the `pages` collection.

#### Update a page
```
PUT /pages/:key
```
Admin-only. Accepts a sparse document and merges it into the stored page with a shallow `$set`.

#### Page with its entities
```
GET /pages/:key/entities
```
Returns the page metadata and all entities belonging to it.

- [/pages/metros](https://api.andrewzc.net/pages/metros)
- [/pages/confluence](https://api.andrewzc.net/pages/confluence)
- [/pages/cathedrals](https://api.andrewzc.net/pages/cathedrals)
- [/pages/countries](https://api.andrewzc.net/pages/countries)
- [/pages/heritage](https://api.andrewzc.net/pages/heritage)
- [/pages/metros/entities](https://api.andrewzc.net/pages/metros/entities)

---

### Entities

#### Name search
```
GET /entities?name=<query>[&list=<key>][&limit=<n>]
```
Case-insensitive substring match on the `name` field. Optionally restrict to one list. Max 50 results.

- [/entities?name=central](https://api.andrewzc.net/entities?name=central)
- [/entities?name=central&list=stations](https://api.andrewzc.net/entities?name=central&list=stations)

#### Semantic search
```
GET /entities?search=<query>[&list=<key>][&limit=<n>]
```
Embeds the query with OpenAI and runs a vector search against the MongoDB Atlas index. Returns semantically related entities regardless of exact name match.

- [/entities?search=underground+stations+with+unusual+architecture](https://api.andrewzc.net/entities?search=underground+stations+with+unusual+architecture)
- [/entities?search=historic+steam+railway&list=heritage](https://api.andrewzc.net/entities?search=historic+steam+railway&list=heritage)

#### Fetch a single entity
```
GET /entities/:list/:key
```
Returns the full entity including `wikiSummary` (stripped from list results to keep payloads small).

- [/entities/metros/paris-metro](https://api.andrewzc.net/entities/metros/paris-metro)
- [/entities/confluence/48n-2e](https://api.andrewzc.net/entities/confluence/48n-2e)
- [/entities/countries/france-FR](https://api.andrewzc.net/entities/countries/france-FR)

#### Query by props
```
GET /entities/:list/props?filter=<json>[&sortBy=<field>][&sortDir=asc|desc][&limit=<n>]
```
Filter entities in a list using a MongoDB query object on their `props` fields. Useful for structured queries like "metros with more than 100 stations" or "countries in the Schengen area."

- [/entities/metros/props?filter={"props.stations":{"$gte":100}}](https://api.andrewzc.net/entities/metros/props?filter=%7B%22props.stations%22%3A%7B%22%24gte%22%3A100%7D%7D)
- [/entities/countries/props?filter={"props.eurozone":true}&sortBy=name&sortDir=asc](https://api.andrewzc.net/entities/countries/props?filter=%7B%22props.eurozone%22%3Atrue%7D&sortBy=name&sortDir=asc)

#### Find similar entities
```
GET /entities/:list/:key/similar[?limit=<n>]
```
Returns entities whose Wikipedia embeddings are most similar to the given entity. Useful for "more like this."

- [/entities/metros/paris-metro/similar](https://api.andrewzc.net/entities/metros/paris-metro/similar)
- [/entities/cities/amsterdam/similar](https://api.andrewzc.net/entities/cities/amsterdam/similar)

#### Presign image uploads
```
POST /entities/:list/:key/images/presign
```
Admin-only. Allocates the next numbered image filenames for an entity and returns presigned S3 upload URLs for both the original image and its thumbnail.

Request body:

```json
{ "count": 2 }
```

Response shape:

```json
{
  "list": "hamburgers",
  "key": "bareburger",
  "uploads": [
    {
      "filename": "bareburger3.jpg",
      "originalKey": "hamburgers/bareburger3.jpg",
      "thumbKey": "hamburgers/tn/bareburger3.jpg",
      "originalUploadUrl": "https://...",
      "thumbUploadUrl": "https://..."
    }
  ]
}
```

The backend allocates filenames from the entity's existing `images` array, so a burger with `["bareburger1.jpg", "bareburger2.jpg"]` will receive `bareburger3.jpg` next.

#### Complete image uploads
```
POST /entities/:list/:key/images/complete
```
Admin-only. Call this after both the original image and the thumbnail have been uploaded successfully. Appends the filenames to the entity's `images` array.

Request body:

```json
{ "filenames": ["bareburger3.jpg", "bareburger4.jpg"] }
```

---

### Geo Search

#### Nearby a coordinate
```
GET /entities/nearby?lat=<lat>&lon=<lon>[&radius=<km>][&list=<key>][&limit=<n>]
```
Finds entities within a radius of a point. Default radius: 50 km. Results are sorted by distance ascending and include a `distanceKm` field.

- [/entities/nearby?lat=48.8566&lon=2.3522&radius=20](https://api.andrewzc.net/entities/nearby?lat=48.8566&lon=2.3522&radius=20) — within 20 km of central Paris
- [/entities/nearby?lat=50.8503&lon=4.3517&radius=100&list=confluence](https://api.andrewzc.net/entities/nearby?lat=50.8503&lon=4.3517&radius=100&list=confluence) — confluence points within 100 km of Brussels

#### Nearby a known entity
```
GET /entities/:list/:key/nearby[?radius=<km>][&limit=<n>]
```
Same as above but uses the coordinates of an existing entity as the center point.

- [/entities/metros/paris-metro/nearby?radius=30](https://api.andrewzc.net/entities/metros/paris-metro/nearby?radius=30)

---

### Country and City Groupings

#### All entities associated with a country
```
GET /countries/:code
```
Returns all entities tagged with a given ISO 2-letter country code, across all lists.

- [/countries/BE](https://api.andrewzc.net/countries/BE) — Belgium
- [/countries/JP](https://api.andrewzc.net/countries/JP) — Japan
- [/countries/FR](https://api.andrewzc.net/countries/FR) — France

#### All entities associated with a city
```
GET /cities/:key
```
The city key is the display name lowercased and hyphenated. US/Canadian cities may include a state code suffix.

- [/cities/paris](https://api.andrewzc.net/cities/paris)
- [/cities/new-york-ny](https://api.andrewzc.net/cities/new-york-ny)
- [/cities/den-haag](https://api.andrewzc.net/cities/den-haag)

---

### Natural Language Search

```
POST /search
Content-Type: application/json

{ "query": "..." }
```

The most powerful endpoint. Sends the query to OpenAI with function calling — the model selects the most appropriate search strategy (filter, name search, semantic search, or geo search) and executes it against the database. Returns results plus metadata about which tool was used.

```bash
curl -X POST https://api.andrewzc.net/search \
  -H "Content-Type: application/json" \
  -d '{"query": "metro systems in Germany"}'

curl -X POST https://api.andrewzc.net/search \
  -d '{"query": "canals I have visited in Belgium"}'

curl -X POST https://api.andrewzc.net/search \
  -d '{"query": "confluence points near Paris"}'

curl -X POST https://api.andrewzc.net/search \
  -d '{"query": "cities with unusual tram networks"}'
```

---

### Wikipedia Link Lookup

```
GET /wiki?q=<query>
```
Looks up the most likely Wikipedia article for a search string and returns its URL. Useful for enriching new entities.

- [/wiki?q=Amsterdam+Metro](https://api.andrewzc.net/wiki?q=Amsterdam+Metro)
- [/wiki?q=Gare+du+Nord](https://api.andrewzc.net/wiki?q=Gare+du+Nord)

---

### Admin (authenticated)

Admin endpoints require an `admin_session` cookie obtained via login. These are for internal use only.

```
POST /admin/login       — { username, password }  → sets cookie
POST /admin/logout      — clears cookie
GET  /admin/me          — returns { authenticated: bool }

POST /entities/:list    — create an entity (admin)
PUT  /entities/:list/:key — update an entity (admin)
```

---

## Query Examples: "I want to know..." → API call

| Question | Endpoint |
|---|---|
| What metro systems are in Germany? | `POST /search` `{"query": "metro systems in Germany"}` |
| Which European metros have I completed (been to every station)? | `GET /pages/metros` then filter `been` — or `POST /search {"query": "completed metro systems in Europe"}` |
| What confluence points have I visited in France? | `POST /search {"query": "confluence points I visited in France"}` |
| What's near a given confluence point? | `GET /entities/confluence/:key/nearby?radius=50` |
| Which countries in my list are in the EU? | `GET /entities/countries/props?filter={"props.european-union":true}` |
| What cathedrals have I visited? | `GET /pages/cathedrals` (filter client-side on `been: true`) or `POST /search {"query": "cathedrals I have visited"}` |
| Tell me about the Paris Metro | `GET /entities/metros/paris-metro` |
| What's similar to the Amsterdam Metro? | `GET /entities/metros/amsterdam-metro/similar` |
| What transit systems are there in Belgium? | `GET /countries/BE` |
| Find stations called "Central" | `GET /entities?name=central&list=stations` |
| What's near the Eiffel Tower? | `GET /entities/nearby?lat=48.8584&lon=2.2945&radius=5` |

---

## Response Format

All list endpoints strip internal fields (`_id`, `wikiEmbedding`, `enrichedAt`). Single-entity fetches via `GET /entities/:list/:key` additionally return `wikiSummary`.

Errors follow a consistent shape:
```json
{ "error": "not_found", "message": "Entity not found" }
```

Common error codes: `not_found`, `page_not_found`, `bad_request`, `conflict`, `unauthorized`, `internal_error`.
