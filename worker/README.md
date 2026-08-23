# Commute Board data proxy

A Cloudflare Worker that serves the app's train data from the **Rail Data
Marketplace** LDBWS REST API, replacing the public Huxley2 instances.

It exists for two reasons a static PWA can't solve on its own:

- **It holds the Darwin API key.** Anything the page ships is readable in
  DevTools, so the key can't live in `config.js`.
- **It adds CORS headers.** LDBWS doesn't send them, so the browser would block
  the response even with a valid key.

It speaks the same URL shape as Huxley2, so `app.js` needs no changes — only the
base URL in `config.js` moves.

## 1. Get a Darwin key

The National Rail Data Portal was retired in early 2026; legacy OpenLDBWS
tokens no longer work. Keys now come from the Rail Data Marketplace:

1. Create an account at <https://raildata.org.uk>
2. In the Data Product Catalogue, search **LDBWS**
3. Subscribe to **"Live Arrival and Departure Boards - Staff Version"**.
   The Worker uses its `GetArrDepBoardWithDetails` /
   `GetArrivalDepartureBoardByCRS` operations. The public product is not used:
   its destination filter 500s for some stations (VIC consistently)
4. Accept the licence (approval is normally instant for the free tier)
5. Open the product's **Specification** tab and copy the **Consumer key**

Free tier is 100,000 calls/month — comfortably more than this app uses.

While you're on the Specification tab, check the **base URL**. The product slug
is subscription-specific, so if requests come back 404, copy the exact base from
that tab into `LDBSVWS_BASE` in `wrangler.toml`.

## 2. Deploy

### Option A — Cloudflare dashboard (no terminal needed)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Start
   from Hello World** → **Deploy**
2. **Edit code**, replace the contents with `src/index.js` from this repo, and
   **Deploy** again
3. **Settings → Variables and Secrets** → add a **Secret** named `DARWIN_KEY`
   with the RDM consumer key → **Deploy**

Nothing else is required: the LDBWS base URL and the allowed origins both have
working defaults compiled in. Add them as plain variables only to override.

### Option B — wrangler CLI

From this directory, with Node installed. No global install needed.

```sh
npx wrangler login              # opens a browser once
npx wrangler secret put DARWIN_KEY   # paste the Consumer key when prompted
npx wrangler deploy
```

`wrangler deploy` prints the Worker's URL, e.g.
`https://commute-board-api.<your-subdomain>.workers.dev`.

The key is stored as a Cloudflare secret. It is never written to this repo and
never appears in a response body — `test.mjs` asserts that.

## 3. Point the app at it

In `config.js`, point `API_BASE_URLS` at the Worker. The public Huxley2
instances used to sit here as fallbacks and were removed: their legacy Darwin
tokens stopped working, so each one only added an 8 s timeout before the board
could report an error.

```js
API_BASE_URLS: ["https://commute-board-api.<your-subdomain>.workers.dev"],
```

Then bump the `config.js` cache-buster in `index.html` and `sw.js`, and the
`CACHE` version in `sw.js`, per the caching notes in `CLAUDE.md`.

## 4. Verify

```sh
curl "https://commute-board-api.<your-subdomain>.workers.dev/departures/ECR/to/VIC/3?expand=true"
```

Expect JSON with a `trainServices` array. Common failures:

| Response | Meaning |
| --- | --- |
| `502` + "Darwin rejected the API key" | Wrong key, or the subscription isn't approved |
| `502` + "Darwin returned HTTP 404" | `LDBSVWS_BASE` slug doesn't match your subscription |
| `500` + "missing the DARWIN_KEY secret" | `wrangler secret put` wasn't run, or ran against a different Worker |
| CORS error in the browser only | Your origin isn't in `ALLOWED_ORIGINS` in `wrangler.toml` |

## Configuration

| Name | Where | Purpose |
| --- | --- | --- |
| `DARWIN_KEY` | secret | RDM Consumer key |
| `LDBSVWS_BASE` | `wrangler.toml` | LDBSVWS product base URL |
| `ALLOWED_ORIGINS` | `wrangler.toml` | Comma-separated origins allowed to read responses |

`ALLOWED_ORIGINS` doesn't protect the key — the Worker holds that server-side
regardless — but it stops other sites from spending your Darwin quota.

## Tests

```sh
node test.mjs
```

Runs offline against a stubbed `fetch`: no network, no wrangler, no real key.
Covers path/filter mapping, the response reshaping `app.js` depends on,
`timeOffset` clamping, the `numRows` cap, the filter fallback, NRCC message
decoding, CORS, and that the key never reaches a response body.

## Notes

- **Station search** (`/crs/{query}`) returns `[]`. LDBWS has no search
  operation; the app already falls back to the bundled `stations.json`.
- **Caching.** Upstream calls are edge-cached for 30 s, so several devices
  refreshing the same board cost one Darwin call.
- **`numRows` is 10** whatever you ask for — 149 comes back with 10.
- **The time is a path segment in ISO basic form** (`20260823T165000`), in
  London local time. Any colon breaks routing; UTC puts the board an hour out
  during BST.
- **Hidden platforms can't be shown.** Darwin blanks them itself, so a service
  with `platformIsHidden: true` arrives with `platform: ""`.
- **No authentication.** Anyone with the Worker URL can read it.
- **Darwin's `filterCrs` is unreliable per-station** (VIC observed 500ing on
  every filtered call while its unfiltered board was fine). On a 5xx for a
  filtered board the Worker refetches unfiltered and filters on the calling
  points, tagging the payload `filteredBy: "worker"`.
- **`expand=true`** maps to `GetArrDepBoardWithDetails`, which returns calling
  points — the source of the arrival time and journey duration.
- **Terminating services are dropped by default.** An Arr/Dep board lists
  trains that arrive but don't depart; they carry `sta` but no `std`, and the
  app falls back to `sta`, so they would render as departures that never leave.
  Pass `?terminating=true` to keep them — the basis for an arrivals view later.
- **Arrival times are already available.** `sta`/`eta` pass through untouched
  for any service that both arrives and departs; the app simply doesn't render
  them yet. Subscribing to Arr/Dep rather than departures-only costs nothing
  and keeps that option open.
- **The Staff version (LDBSVWS) is not used.** It takes an explicit `{time}`,
  which would lift Trip mode past Darwin's ±120 min limit, but it has a
  different response schema and a stricter licence. Worth revisiting only if
  Trip mode needs times further out.
