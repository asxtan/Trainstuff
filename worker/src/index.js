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

const LDBWS_DEFAULT_BASE =
  "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";

// Darwin only serves this far either side of now; asking for more is an error
// rather than a silently wrong board.
const MAX_OFFSET_MIN = 120;

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
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const headers = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (allowed.length === 0) {
    headers["Access-Control-Allow-Origin"] = "*"; // unconfigured → permissive
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

  const numRows = clamp(parseInt(rows, 10) || 10, 1, 20);
  const detailed = url.searchParams.get("expand") === "true";

  const op = detailed ? "GetDepBoardWithDetails" : "GetDepartureBoard";
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

  const res = await fetch(target.toString(), {
    headers: { "x-apikey": env.DARWIN_KEY, Accept: "application/json" },
    // Shared edge cache: several devices refreshing the same board cost one
    // upstream call, which is what keeps the free RDM quota comfortable.
    cf: { cacheTtl: 30, cacheEverything: true }
  });

  if (res.status === 401 || res.status === 403) {
    throw bad("Darwin rejected the API key (check the RDM subscription)", 502);
  }
  if (!res.ok) {
    throw bad(`Darwin returned HTTP ${res.status}`, 502);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw bad("Darwin sent a non-JSON reply", 502);
  }

  return json(normalise(data), 200, cors);
}

/* ------------------------------------------------------------ reshaping */

// LDBWS REST is the SOAP schema rendered as JSON, and Huxley derived its output
// from that same schema, so the two are close. This smooths over the places
// they drift: the calling-point nesting and the NRCC message field name.
function normalise(data) {
  const services = arr(data && (data.trainServices || data.services)).map((svc) => {
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

  const messages = arr(data && data.nrccMessages).map((m) => {
    if (typeof m === "string") return { value: m };
    return { value: m.value || m.xhtmlMessage || m.message || "" };
  });

  return {
    locationName: (data && data.locationName) || "",
    crs: (data && data.crs) || "",
    generatedAt: (data && data.generatedAt) || new Date().toISOString(),
    trainServices: services,
    nrccMessages: messages
  };
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
