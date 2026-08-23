/**
 * Commute Board data proxy.
 *
 * Speaks the Huxley2 URL shape the app already uses, and serves it from the
 * Rail Data Marketplace LDBWS REST API. Two jobs the browser can't do itself:
 *
 *   1. Holds the Darwin API key. A static PWA on GitHub Pages can't keep a
 *      secret — anything it ships is readable in DevTools.
 *   2. Adds CORS headers. LDBWS doesn't send them, so the browser would block
 *      the response even with a valid key.
 *
 * Routes (matching Huxley2, so app.js needs no changes):
 *   /departures/{from}/{rows}              → all destinations
 *   /departures/{from}/to/{to}/{rows}      → filtered to one destination
 *   /crs/{query}                           → station search (see below)
 *
 * Query params honoured: expand, timeOffset, timeWindow.
 */

// Operations from the "Live Arrival and Departure Boards" (public) product.
// Note these are the Arr/Dep operations, not GetDepBoardWithDetails — that one
// belongs to the separate "Live Departure Boards" product and 404s without it.
const OP_DETAILED = "GetArrDepBoardWithDetails";
const OP_PLAIN = "GetArrivalDepartureBoard";

// Overridden by LDBWS_BASE in wrangler.toml; kept in sync as the fallback.
const LDBWS_DEFAULT_BASE =
  "https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards-arr-and-dep1_1/LDBWS/api/20220120";

// Darwin only serves this far either side of now; asking for more is an error
// rather than a silently wrong board.
const MAX_OFFSET_MIN = 120;

// LDBWS caps numRows at 10. Above it Darwin answers 500 "service is currently
// unavailable" rather than a 4xx, so an over-large request looks exactly like
// an outage — clamp here so it can never be mistaken for one.
const MAX_ROWS = 10;

// Used when ALLOWED_ORIGINS isn't set, so a dashboard deploy (where the only
// required step is adding the DARWIN_KEY secret) is still locked down.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://asxtan.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, cors);
    }
    if (!env.DARWIN_KEY) {
      // Misconfiguration, not a client error — say so plainly in the logs and
      // the body, but never echo any part of the key.
      return json({ error: "Worker is missing the DARWIN_KEY secret" }, 500, cors);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "crs") return json(await stationSearch(), 200, cors);
      if (parts[0] === "departures") return await departures(parts, url, env, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      const status = err && err.status ? err.status : 502;
      return json({ error: String((err && err.message) || err) }, status, cors);
    }
  }
};

/* ------------------------------------------------------------------ CORS */

// Only the app's own origins may read responses. This doesn't protect the key
// (the Worker holds it server-side regardless) but it stops other sites from
// quietly spending your Darwin quota.
function corsHeaders(origin, env) {
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;

  const headers = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}

function bad(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* -------------------------------------------------------------- endpoints */

// LDBWS has no station-search operation. The app already falls back to the
// bundled stations.json and treats [] as "no live suggestions", so an empty
// list is the correct answer rather than an error.
async function stationSearch() {
  return [];
}

async function departures(parts, url, env, cors) {
  // /departures/FROM/ROWS  or  /departures/FROM/to/TO/ROWS
  const from = crs(parts[1]);
  let to = null;
  let rows;

  if (parts[2] === "to") {
    to = crs(parts[3]);
    rows = parts[4];
  } else {
    rows = parts[2];
  }

  const numRows = clamp(parseInt(rows, 10) || MAX_ROWS, 1, MAX_ROWS);
  const detailed = url.searchParams.get("expand") === "true";
  // Opt in to keep services that terminate here (arrivals with no onward
  // departure). Off by default because the app is a departure board, but the
  // data is there if anything ever wants an arrivals view.
  const keepTerminating = url.searchParams.get("terminating") === "true";

  const op = detailed ? OP_DETAILED : OP_PLAIN;
  const base = (env.LDBWS_BASE || LDBWS_DEFAULT_BASE).replace(/\/+$/, "");
  const target = new URL(`${base}/${op}/${from}`);
  target.searchParams.set("numRows", String(numRows));
  if (to) {
    target.searchParams.set("filterCrs", to);
    target.searchParams.set("filterType", "to");
  }

  const offset = intParam(url, "timeOffset");
  const window = intParam(url, "timeWindow");
  if (offset !== null) {
    target.searchParams.set("timeOffset", String(clamp(offset, -MAX_OFFSET_MIN, MAX_OFFSET_MIN)));
  }
  if (window !== null) {
    target.searchParams.set("timeWindow", String(clamp(window, 1, MAX_OFFSET_MIN)));
  }

  let data = await callDarwin(target, env);

  // Darwin's filterCrs is unreliable for some stations — London Victoria has
  // been seen 500ing on every filtered request while the unfiltered board for
  // the same station answers normally. When that happens, ask for the whole
  // board and do the filtering here: with expand=true we already have the
  // calling points, which is exactly what the filter was for.
  let filteredLocally = false;
  if (data === UPSTREAM_5XX) {
    if (!to || !detailed) throw bad("Darwin is not answering for this station", 502);
    const wide = new URL(`${base}/${op}/${from}`);
    // Ask for as much as Darwin allows: we're about to discard everything that
    // doesn't call at the destination. Capped at MAX_ROWS -- asking for more
    // is what made this fallback 500 every time it was needed.
    wide.searchParams.set("numRows", String(MAX_ROWS));
    for (const k of ["timeOffset", "timeWindow"]) {
      if (target.searchParams.has(k)) wide.searchParams.set(k, target.searchParams.get(k));
    }
    data = await callDarwin(wide, env);
    if (data === UPSTREAM_5XX) throw bad("Darwin is not answering for this station", 502);
    filteredLocally = true;
  }

  const out = normalise(data, keepTerminating);
  if (filteredLocally) {
    out.trainServices = out.trainServices
      .filter((svc) => callsAt(svc, to))
      .slice(0, numRows);
    out.filteredBy = "worker"; // visible in the payload when debugging
  }
  return json(out, 200, cors);
}


// Sentinel: the upstream answered, but with a 5xx we may be able to route
// around. Distinct from a thrown error, which is terminal.
const UPSTREAM_5XX = Symbol("upstream-5xx");

async function callDarwin(target, env) {
  const res = await fetch(target.toString(), {
    headers: { "x-apikey": env.DARWIN_KEY, Accept: "application/json" },
    // Shared edge cache: several devices refreshing the same board cost one
    // upstream call, which is what keeps the free RDM quota comfortable.
    cf: { cacheTtl: 30, cacheEverything: true }
  });

  if (res.status === 401 || res.status === 403) {
    throw bad("Darwin rejected the API key (check the RDM subscription)", 502);
  }
  if (res.status >= 500) return UPSTREAM_5XX;
  if (!res.ok) throw bad(`Darwin returned HTTP ${res.status}`, 502);

  try {
    return await res.json();
  } catch (e) {
    throw bad("Darwin sent a non-JSON reply", 502);
  }
}

// Does this service call at `crs` after leaving? Mirrors what filterType=to
// means, using the calling points expand=true already gives us.
function callsAt(svc, crsCode) {
  const target = String(crsCode || "").toUpperCase();
  const scp = (svc && svc.subsequentCallingPoints) || [];
  for (const leg of scp) {
    for (const cp of (leg && leg.callingPoint) || []) {
      if (String((cp && cp.crs) || "").toUpperCase() === target) return true;
    }
  }
  const dest = (svc && svc.destination) || [];
  return dest.some((d) => String((d && d.crs) || "").toUpperCase() === target);
}

/* ------------------------------------------------------------ reshaping */

// LDBWS REST is the SOAP schema rendered as JSON, and Huxley derived its output
// from that same schema, so the two are close. This smooths over the places
// they drift: the calling-point nesting and the NRCC message field name.
function normalise(data, keepTerminating) {
  const services = arr(data && (data.trainServices || data.services))
    // An Arr/Dep board also lists services that terminate here. They carry sta
    // but no std, and app.js falls back to sta for the big time — which would
    // render a train that never leaves as a departure. This is a departure
    // board, so drop them unless the caller asked for them. Services that both
    // arrive and depart keep their sta/eta either way.
    .filter((svc) => svc && (keepTerminating || svc.std))
    .map((svc) => {
      const out = { ...svc };

      // Huxley nests as subsequentCallingPoints[0].callingPoint[]; LDBWS REST
      // sometimes flattens it to a plain array. app.js tolerates both, but
      // normalising here keeps that tolerance from being load-bearing.
      const scp = svc.subsequentCallingPoints;
      if (Array.isArray(scp) && scp.length && !scp[0].callingPoint) {
        out.subsequentCallingPoints = [{ callingPoint: scp }];
      }

      if (out.destination && !Array.isArray(out.destination)) {
        out.destination = [out.destination];
      }
      return out;
    });

  const messages = arr(data && data.nrccMessages)
    .map((m) => (typeof m === "string" ? m : pickMessage(m)))
    .map(plainText)
    .filter(Boolean)
    .map((value) => ({ value }));

  return {
    locationName: (data && data.locationName) || "",
    crs: (data && data.crs) || "",
    generatedAt: (data && data.generatedAt) || new Date().toISOString(),
    trainServices: services,
    nrccMessages: messages
  };
}


// LDBWS REST capitalises this field ("Value"); Huxley used "value" and the SOAP
// schema also carried "xhtmlMessage". Match case-insensitively so a casing
// change upstream doesn't silently drop every disruption message again.
function pickMessage(m) {
  if (!m || typeof m !== "object") return "";
  for (const key of Object.keys(m)) {
    const k = key.toLowerCase();
    if (k === "value" || k === "xhtmlmessage" || k === "message") {
      if (typeof m[key] === "string" && m[key].trim()) return m[key];
    }
  }
  return "";
}

// NRCC messages are HTML fragments: markup plus entities. The app renders via
// textContent, which shows entities literally ("Oxted&nbsp;and"), so flatten to
// real plain text here. app.js still runs its own stripTags as a second guard.
const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'"
};

function plainText(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
      const key = code.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
      if (key[0] === "#") {
        const n = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : " ";
      }
      return " ";
    })
    .replace(/\s+/g, " ")
    // Stripping inline markup leaves gaps before punctuation ("Disruptions .").
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/* ---------------------------------------------------------------- helpers */

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Station codes are exactly three letters. Validating here means a malformed
// path fails fast instead of spending an upstream call to be told the same.
function crs(v) {
  const s = String(v || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw bad(`Invalid station code: ${v}`, 400);
  return s;
}
