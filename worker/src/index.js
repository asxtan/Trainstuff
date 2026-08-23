/**
 * Commute Board data proxy.
 *
 * Speaks the Huxley2 URL shape the app already uses, and serves it from the
 * Rail Data Marketplace LDBSVWS (staff) API. Two jobs the browser can't do:
 *
 *   1. Holds the Darwin API key. A static PWA on GitHub Pages can't keep a
 *      secret — anything it ships is readable in DevTools.
 *   2. Adds CORS headers. LDBSVWS doesn't send them, so the browser would
 *      block the response even with a valid key.
 *
 * Staff rather than public, because the public product's destination filter
 * 500s for some stations (London Victoria consistently), which left the return
 * board with two services instead of eight. The staff filter works everywhere,
 * and its explicit time parameter lifts the +/-120 minute limit on trip
 * lookups. One data source, one mapper.
 *
 * ON HIDDEN PLATFORMS: platformIsHidden=true means the platform has not been
 * published yet, not that it is being kept from us — such a service arrives
 * with platform="", and when the platform is set the flag flips to false and
 * the number appears. Victoria publishes ~8 min before departure, East Croydon
 * and London Bridge much earlier. Whatever Darwin sends is passed through.
 *
 * This Worker has no authentication: anyone who knows the URL can read it.
 *
 * Routes (matching Huxley2, so app.js needs no changes):
 *   /departures/{from}/{rows}              → all destinations
 *   /departures/{from}/to/{to}/{rows}      → filtered to one destination
 *   /crs/{query}                           → station search (see below)
 *
 * Query params honoured: expand, timeOffset, timeWindow, terminating.
 */

const LDBSVWS_DEFAULT_BASE =
  "https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards---staff-version1_0/LDBSVWS/api/20220120";

const OP_DETAILED = "GetArrDepBoardWithDetails";
const OP_PLAIN = "GetArrivalDepartureBoardByCRS";

// Darwin serves 10 board rows per call whatever you ask for: numRows=149 comes
// back with 10. Clamp so the request states what it will actually get.
const MAX_ROWS = 10;

// Trip lookups can name any time, but a board hours away is rarely useful and
// the request should stay bounded.
const MAX_OFFSET_MIN = 24 * 60;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://asxtan.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);
    if (!env.DARWIN_KEY) {
      return json({ error: "Worker is missing the DARWIN_KEY secret" }, 500, cors);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "crs") return json([], 200, cors);
      if (parts[0] === "departures") return await departures(parts, url, env, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, (err && err.status) || 502, cors);
    }
  }
};

/* ------------------------------------------------------------------ CORS */

function corsHeaders(origin, env) {
  const configured = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const headers = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
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

async function departures(parts, url, env, cors) {
  const from = crs(parts[1]);
  let to = null;
  let rows;
  if (parts[2] === "to") { to = crs(parts[3]); rows = parts[4]; } else { rows = parts[2]; }

  const numRows = clamp(parseInt(rows, 10) || MAX_ROWS, 1, MAX_ROWS);
  const detailed = url.searchParams.get("expand") === "true";
  const keepTerminating = url.searchParams.get("terminating") === "true";
  const op = detailed ? OP_DETAILED : OP_PLAIN;
  const base = (env.LDBSVWS_BASE || LDBSVWS_DEFAULT_BASE).replace(/\/+$/, "");

  // The staff API takes the board time as a path segment, in ISO *basic*
  // format. Any colon — raw or percent-encoded — fails to route and returns an
  // ASP.NET error page rather than JSON.
  const offset = clamp(intParam(url, "timeOffset") || 0, -MAX_OFFSET_MIN, MAX_OFFSET_MIN);
  const when = londonBasic(new Date(Date.now() + offset * 60000));

  const target = new URL(`${base}/${op}/${from}/${when}`);
  target.searchParams.set("numRows", String(numRows));
  if (to) {
    target.searchParams.set("filterCrs", to);
    target.searchParams.set("filterType", "to");
  }
  const window = intParam(url, "timeWindow");
  if (window !== null) target.searchParams.set("timeWindow", String(clamp(window, 1, 120)));

  let data = await callDarwin(target, env);

  // Darwin 5xxs are common and station-specific. If a filtered board fails,
  // fetch the whole board and filter on the calling points we already have.
  let filteredLocally = false;
  if (data === UPSTREAM_5XX) {
    if (!to || !detailed) throw bad("Darwin is not answering for this station", 502);
    const wide = new URL(`${base}/${op}/${from}/${when}`);
    wide.searchParams.set("numRows", String(MAX_ROWS));
    if (window !== null) wide.searchParams.set("timeWindow", target.searchParams.get("timeWindow"));
    data = await callDarwin(wide, env);
    if (data === UPSTREAM_5XX) throw bad("Darwin is not answering for this station", 502);
    filteredLocally = true;
  }

  const out = normalise(data, keepTerminating);
  if (filteredLocally) {
    out.trainServices = out.trainServices.filter((svc) => callsAt(svc, to)).slice(0, numRows);
    out.filteredBy = "worker";
  }
  return json(out, 200, cors);
}

const UPSTREAM_5XX = Symbol("upstream-5xx");

async function callDarwin(target, env) {
  const res = await fetch(target.toString(), {
    headers: { "x-apikey": env.DARWIN_KEY, Accept: "application/json" },
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

/* ------------------------------------------------------------ reshaping */

// LDBSVWS → the Huxley-shaped payload app.js reads. Three real differences:
// times are full ISO timestamps, calling points are "subsequentLocations" and
// include non-station timing points, and there is no serviceID.
function normalise(data, keepTerminating) {
  const services = arr(data && data.trainServices)
    // Not trains anyone can board: freight, empty stock, operational calls, and
    // services the operator has suppressed from departure boards.
    .filter((svc) => svc && svc.isPassengerService !== false)
    .filter((svc) => svc && svc.isOperationalCall !== true)
    .filter((svc) => svc && svc.serviceIsSupressed !== true)
    // A departure board: drop anything that terminates here and never leaves.
    .filter((svc) => keepTerminating || hhmm(svc && svc.std))
    .map((svc) => ({
      ...svc,
      std: hhmm(svc.std),
      etd: etdText(svc),
      sta: hhmm(svc.sta),
      eta: hhmm(svc.eta),
      serviceID: svc.rid || svc.uid || svc.trainid || "",
      destination: arr(svc.destination),
      subsequentCallingPoints: [{ callingPoint: callingPoints(svc) }]
    }));

  return {
    locationName: (data && data.locationName) || "",
    crs: (data && data.crs) || "",
    generatedAt: (data && data.generatedAt) || new Date().toISOString(),
    trainServices: services,
    nrccMessages: arr(data && data.nrccMessages)
      .map((m) => (typeof m === "string" ? m : pickMessage(m)))
      .map(plainText)
      .filter(Boolean)
      .map((value) => ({ value }))
  };
}

// The app shows "On time" or an expected clock time. Staff gives scheduled and
// estimated as timestamps, so compare them rather than passing text through.
function etdText(svc) {
  const std = hhmm(svc.std);
  const etd = hhmm(svc.etd);
  if (svc.isCancelled) return "Cancelled";
  if (!etd) return std ? "On time" : "";
  return etd === std ? "On time" : etd;
}

// subsequentLocations carries junctions and other timing points with no CRS.
// Those aren't stations, so they can't be a destination — drop them.
function callingPoints(svc) {
  return arr(svc.subsequentLocations)
    .filter((loc) => loc && loc.crs)
    .map((loc) => ({
      locationName: loc.locationName || "",
      crs: loc.crs,
      st: hhmm(loc.sta) || hhmm(loc.std),
      et: hhmm(loc.eta) || hhmm(loc.etd),
      platform: loc.platform || ""
    }));
}

function callsAt(svc, crsCode) {
  const target = String(crsCode || "").toUpperCase();
  const cps = ((svc.subsequentCallingPoints || [])[0] || {}).callingPoint || [];
  if (cps.some((cp) => String(cp.crs || "").toUpperCase() === target)) return true;
  return arr(svc.destination).some((d) => String((d && d.crs) || "").toUpperCase() === target);
}

/* ---------------------------------------------------------------- helpers */

// "2026-08-23T16:51:00" → "16:51". Anything else → "".
function hhmm(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ""));
  return m ? `${m[4]}:${m[5]}` : "";
}

// The board time the staff API wants: ISO basic, in London local time, since
// that is the clock the railway runs on. Workers run in UTC, so BST would put
// the board an hour out for half the year.
function londonBasic(date) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  const hour = p.hour === "24" ? "00" : p.hour; // some engines render midnight as 24
  return `${p.year}${p.month}${p.day}T${hour}${p.minute}${p.second}`;
}

function pickMessage(m) {
  if (!m || typeof m !== "object") return "";
  for (const key of Object.keys(m)) {
    const k = key.toLowerCase();
    if ((k === "value" || k === "xhtmlmessage" || k === "message") &&
        typeof m[key] === "string" && m[key].trim()) return m[key];
  }
  return "";
}

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
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function arr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function crs(v) {
  const s = String(v || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw bad(`Invalid station code: ${v}`, 400);
  return s;
}
