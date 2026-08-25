# CLAUDE.md — Commute Board

A static, installable PWA showing live UK train departures (time, status,
expected arrival, journey time, platform, carriages) for a commute. No backend.

## Deploy / workflow
- **Hosting:** GitHub Pages at `https://asxtan.github.io/Trainstuff/`. Repo `asxtan/Trainstuff`.
- **Commit straight to `main`** — every push to `main` auto-deploys via
  `.github/workflows/pages.yml`. (User authorised direct-to-main; no PR needed.)
- Pages source must be "GitHub Actions" (already enabled).
- Egress allowlist now includes `asxtan.github.io`, `*.workers.dev`,
  `api1.raildata.org.uk` and `wiki.openraildata.com`, so the live site, the
  Worker and the Darwin upstream **can** be verified from the sandbox with curl.
- Keep chat replies concise; user prefers shorter responses.

## Data source
- **Own Cloudflare Worker only** (`worker/`), listed in `API_BASE_URLS` in
  `config.js`. The public Huxley2 instances were removed: their legacy Darwin
  tokens died with the National Rail Data Portal, and each dead host cost an
  8 s timeout before the board could report an error. `app.js` still reads the
  old `HUXLEY_BASE_URLS` / `HUXLEY_BASE_URL` keys as a fallback, so a stale
  cached `config.js` degrades instead of leaving no base at all.
- `apiJson()` walks `API_BASE_URLS` in order and pins `activeBase` to the first
  that answers. It fails over on transport errors, 5xx, and empty/non-JSON
  bodies; only a 4xx stops the walk, since that means *our request* was wrong
  (e.g. a bad CRS) and the next base would reject it identically.
- `getJson` gives each request an 8 s deadline; 401/403/408/429 are read as
  instance faults so the walk continues. After a full sweep fails, `apiJson`
  waits ~1 s and sweeps once more before surfacing an error, and `explain()`
  translates 401/5xx into plain English.
- Boards are cached in memory per request path for 30 s and in-flight requests
  are shared per path, so tabbing between return origins re-renders from memory
  instead of firing (and abandoning) a request each time. Auto-refresh and the
  refresh button pass `force` to bypass the cache; the "Updated" stamp shows
  when the *data* was fetched.
- On a failed load the last board for that route is re-rendered with its own
  timestamp and a "couldn't refresh" banner, rather than blanking the screen —
  but only if it's younger than `STALE_MAX_MS` (10 min). **A home-screen PWA is
  suspended, not reloaded**, so `boardCache` survives overnight; without the cap
  a morning outage showed last night's trains as if they were the next ones.
  Past the cap the entry is dropped and a plain error shown instead.
- Board: `/departures/{from}/to/{to}/{rows}?expand=true`. `expand=true` gets
  calling points → expected arrival + journey time. Station search
  (`/crs/{query}`) returns `[]` from the Worker — LDBWS has no search
  operation, so the picker uses the bundled `stations.json`.
- `to` is optional (`/departures/{from}/{rows}`) → an all-destinations board.
- `timeOffset` / `timeWindow` (minutes) move the board off "now". **Darwin only
  serves ±120 min**, so Trip mode clamps to it (and the Worker clamps again)
  and explains itself in the banner rather than silently showing wrong trains.

## Own data proxy (`worker/`)
- Cloudflare Worker serving the Huxley2 URL shape from the **Rail Data
  Marketplace LDBSVWS (staff)** API, so `app.js` is unchanged — only the base
  URL in `config.js`.
- Exists because a static PWA can't hold the Darwin key (readable in DevTools)
  and LDBSVWS sends no CORS headers. Key is a Worker secret, never in git.
- **Staff, not public.** The public product's `filterCrs` 500s for some
  stations — VIC consistently — which left the return board with 2 services
  instead of 8. The staff filter works everywhere, and its explicit time
  parameter removes the ±120 min limit on trip lookups. One source, one mapper.
- **Time is a path segment in ISO basic form** (`20260823T165000`). Any colon,
  raw or percent-encoded, fails to route and returns an ASP.NET error page
  instead of JSON. It must be **London local time** — Workers run in UTC, so
  BST would put every board an hour out (`londonBasic()`).
- **`platformIsHidden: true` means "not shown on public boards"** — and the
  number may or may not accompany it. KGX 18:03 came back `platform: "2",
  hidden: true` half an hour out: known, withheld publicly, visible to us. VIC
  services beyond ~8 min come back `platform: "", hidden: true`: not assigned
  yet, and one was watched flipping to `("15", false)` as it neared departure.
  **Don't generalise from one station** — an early sample of VIC only led to the
  wrong conclusion that nothing is ever withheld.
- Staff boards also carry freight, empty stock, operational calls and
  suppressed services; `normalise()` drops all of those, plus arrival-only
  services (`?terminating=true` keeps the last group).
- **Schema differs from the public product** and `normalise()` bridges it:
  ISO timestamps → `HH:MM`, `subsequentLocations` → `subsequentCallingPoints`
  (dropping junctions with no CRS), `sta`/`eta` → `st`/`et`, `rid` → `serviceID`.
- **`numRows` is 10** whatever you ask for (149 returns 10). `MAX_ROWS` clamps.
- **Darwin 5xx is common and station-specific.** On a 5xx for a *filtered*
  board the Worker refetches unfiltered and filters on the calling points,
  tagging the payload `filteredBy: "worker"`.
- **Gotcha:** LDBWS capitalises `nrccMessages[].Value`, and the body is HTML
  with entities — `pickMessage`/`plainText` handle both. Silently dropping
  every disruption message is the failure mode if that regresses.
- **Deployed:** `https://commute-board-api.asxtan.workers.dev`, the sole entry
  in `API_BASE_URLS`. **No authentication** — anyone with the URL can read it.
  `CLOUDFLARE_API_TOKEN` is in the cloud env, so `npx wrangler deploy` and
  `npx wrangler tail` both work from the sandbox (account
  `ceb98bebf3a3cf18d57648d53108e005`). Tail emits pretty-printed JSON: parse it
  as a JSON *stream* (`JSONDecoder.raw_decode` in a loop), not line by line.
- `worker/README.md` has the RDM signup + deploy steps. `node worker/test.mjs`
  runs offline against a stubbed fetch (41 checks).

## Files
- `index.html` / `app.js` / `styles.css` — the app.
- `config.js` — `API_BASE_URLS`, defaults (home ECR, work A VIC, work B LBG),
  `NUM_ROWS`, `REFRESH_MS`, `MORNING_BEFORE_HOUR`.
- `manifest.webmanifest`, `sw.js` — PWA shell.
- `stations.json` — bundled station list for the picker / offline.
- `sample_board.json` — demo payload (`?demo=1`); includes calling points.
- `tools/make_icons.py` — pure-stdlib PNG generator (green train, white bg);
  outputs `icon-512/192.png`, `apple-touch-icon.png`. Re-run to change the icon.

## Key behaviours / decisions
- **Stations are user-set in-app** (gear → settings), saved per device in
  localStorage. Home + Work A (required) + Work B (**optional**). A cleared B is
  stored as `""` (vs `null` = unset) so "one station" persists.
- **To work / To home toggle**, defaults by time of day (`MORNING_BEFORE_HOUR`).
  - To work, two stations: merged board of Home→A and Home→B, deduped by
    serviceID, time-sorted, each train tagged (blue = A, purple = B). One
    station: plain Home→A board.
  - To home: A|B return picker (hidden when only one work station) → origin→Home.
- **Trip mode** (third segment) — a one-off lookup, not part of the commute:
  From + optional To + optional "Leaving at" time, saved separately from the
  commute stations. Blank To = every departure from that station (the row drops
  its arrival line, since there's nothing to arrive at). With a time set, the
  board opens ~10 min before it and the first departure at/after it is flagged
  "Your train" (`.row.is-pick`) — that's the row whose platform you came for.
  - `tripWindow()` returns `outOfWindow` based on the *requested time*, not the
    shifted offset — the 10-min lead-in can be in range when the train isn't.
  - Platforms are typically only assigned ~20 min out, so an in-window lookup
    for later can legitimately show "—". The banner says so.
- Station matching folds apostrophes/hyphens (`foldName`), so "kings cross"
  finds "London King's Cross".
- **"Hidden" beside the platform** (`.plat-hidden`) marks `platformIsHidden`,
  but **only when a number is actually shown**. The flag covers two cases: the
  platform is known and withheld from public boards (KGX, ~15–35 min early), or
  nothing is assigned yet and the number is blank (most of a VIC board). Only
  the first is worth marking — on a blank platform the tag is pure clutter.
  Measured over one evening at KGX: the tag leads the National Rail site by
  15–35 min, the site publishes within ~30 s of the flag clearing, and the
  number is stable except that it can be *refined* (1 → 1A) at publication.
- **Carriage chip** shows the coach count, with typical loading under it in a
  quieter style (`.cars-load`, "usually 91%"). Coach counts are patchy and
  operator-specific — Southern reported none at ECR/VIC on a weekday morning
  while Thameslink and Great Northern reported all of theirs — so the loading
  line often carries the only information in that column. Darwin only ever
  sends `type: "Typical"` (33/33 sampled), i.e. a historical expectation for
  this service at this time, **not** live crowding: hence "usually".
- **Row layout:** left column = all time info (departure big, status, then
  "→ arrival · journey"); middle = destination/tags + platform (big number);
  right = carriages chip. Order chosen so it reads chronologically when delayed.
- Auto-refresh every `REFRESH_MS`; refresh button has spinner + min-visible delay;
  "updated" stamp pulses.

## Caching gotchas (important)
- `sw.js` is **network-first** for the app shell (so deploys show immediately),
  cache only as offline fallback. Train API is cross-origin → never cached.
- **Bump `CACHE` version in `sw.js` whenever assets change**, so old caches purge.
- **Cache-bust asset URLs when replacing a file in place** (e.g. icons use
  `?v=2` in `index.html`/`manifest`/`sw.js`) — iOS Add-to-Home-Screen otherwise
  pulls a stale `apple-touch-icon`.
- iOS Home Screen icons don't update in place: user must delete + re-add.

## Security
- Render API values via `textContent` only (never `innerHTML`) — DOM-XSS guard.
  `stripTags()` removes markup with regex, not by parsing. Inline SVGs are static.

## Verify
- `node --check app.js`, validate JSON, `python3 -m http.server` + curl for 200s.
- Logic checks run in Node (no DOM); `?demo=1` renders the bundled sample.
