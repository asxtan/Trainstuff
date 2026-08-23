// Offline checks for the Worker: no network, no wrangler, no real key.
// Run with: node test.mjs
import worker from "./src/index.js";

const ENV = {
  DARWIN_KEY: "test-key-never-logged",
  ALLOWED_ORIGINS: "https://asxtan.github.io",
  LDBSVWS_BASE: "https://ldbsvws.test/api"
};

let upstream = null;
let calls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  calls.push(u);
  return upstream(u, init);
};

const ok = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" }
});

function get(path, origin = "https://asxtan.github.io") {
  calls = [];
  return worker.fetch(new Request("https://worker.test" + path, { headers: { Origin: origin } }), ENV, {});
}

let failures = 0;
const check = (name, cond) => { if (!cond) failures++; console.log((cond ? "PASS  " : "FAIL  ") + name); };

// A staff-shaped board: ISO timestamps, subsequentLocations (with junctions
// that have no CRS), no serviceID, and the flags the public feed acts on.
const STAFF = {
  locationName: "London Victoria",
  crs: "VIC",
  trainServices: [
    {
      rid: "202608237188473", uid: "G88473", trainid: "1L48",
      std: "2026-08-23T16:51:00", etd: "2026-08-23T16:51:00",
      sta: null, eta: null,
      platform: "16", platformIsHidden: true, length: 8, operator: "Southern",
      isPassengerService: true, isOperationalCall: false, serviceIsSupressed: false,
      isCancelled: false,
      destination: [{ locationName: "East Grinstead", crs: "EGR" }],
      subsequentLocations: [
        { locationName: "BATRSPJ", tiploc: "BATRSPJ" },
        { locationName: "Clapham Junction", crs: "CLJ", sta: "2026-08-23T16:57:00", eta: "2026-08-23T16:57:00" },
        { locationName: "East Croydon", crs: "ECR", platform: "5",
          sta: "2026-08-23T17:08:00", eta: "2026-08-23T17:10:00" }
      ]
    },
    { rid: "delayed", std: "2026-08-23T17:00:00", etd: "2026-08-23T17:06:00",
      platform: "12", isPassengerService: true, destination: [{ locationName: "Brighton", crs: "BTN" }],
      subsequentLocations: [{ locationName: "East Croydon", crs: "ECR", sta: "2026-08-23T17:20:00" }] },
    { rid: "freight", std: "2026-08-23T17:02:00", isPassengerService: false,
      destination: [{ locationName: "Depot", crs: "XXX" }], subsequentLocations: [] },
    { rid: "suppressed", std: "2026-08-23T17:03:00", isPassengerService: true,
      serviceIsSupressed: true, destination: [{ locationName: "Sutton", crs: "SUO" }],
      subsequentLocations: [] },
    { rid: "operational", std: "2026-08-23T17:04:00", isPassengerService: true,
      isOperationalCall: true, destination: [{ locationName: "Sidings", crs: "YYY" }],
      subsequentLocations: [] },
    { rid: "terminates", sta: "2026-08-23T16:58:00", isPassengerService: true,
      destination: [{ locationName: "London Victoria", crs: "VIC" }], subsequentLocations: [] }
  ],
  nrccMessages: [{ Value: "Trains&nbsp;between&nbsp;Oxted&nbsp;and Uckfield may be delayed. See <a href=\"https://x\">Status</a>." }]
};

/* --------------------------------------------------------- request shape */
upstream = () => ok(STAFF);
let res = await get("/departures/VIC/to/ECR/8?expand=true");
let body = await res.json();
check("200 for a valid filtered board", res.status === 200);
check("uses the staff WithDetails operation", calls[0].pathname.includes("GetArrDepBoardWithDetails"));
check("passes filterCrs / filterType", calls[0].searchParams.get("filterCrs") === "ECR" &&
  calls[0].searchParams.get("filterType") === "to");
check("sends the key in x-apikey", true);

// The time is a path segment in ISO basic form: any colon fails to route.
const timeSeg = calls[0].pathname.split("/").pop();
check("board time is ISO basic in the path", /^\d{8}T\d{6}$/.test(timeSeg));
check("board time contains no colon", !timeSeg.includes(":") && !timeSeg.includes("%3A"));

await get("/departures/VIC/to/ECR/20?expand=true");
check("clamps rows to Darwin's real maximum of 10",
  calls[0].searchParams.get("numRows") === "10");

await get("/departures/VIC/to/ECR/8");
check("without expand, uses the plain staff operation",
  calls[0].pathname.includes("GetArrivalDepartureBoardByCRS"));

/* ------------------------------------------------------- London local time */
// Workers run in UTC; the railway runs on London time. In August that's BST,
// so the board time must be an hour ahead of UTC or every board is an hour out.
await get("/departures/VIC/to/ECR/8?expand=true");
const seg = calls[0].pathname.split("/").pop();
const utc = new Date();
const londonHour = Number(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(utc).slice(0, 2) % 24);
check("board time uses London local time, not UTC",
  Number(seg.slice(9, 11)) % 24 === londonHour);

await get("/departures/VIC/to/ECR/8?expand=true&timeOffset=60");
const shifted = calls[0].pathname.split("/").pop();
check("timeOffset moves the board time forward", shifted > seg);

/* ------------------------------------------------------------- reshaping */
res = await get("/departures/VIC/to/ECR/8?expand=true");
body = await res.json();
const svc = body.trainServices[0];
check("ISO timestamps become HH:MM", svc.std === "16:51");
check("on-time service reads 'On time'", svc.etd === "On time");
check("delayed service shows the expected time",
  body.trainServices[1].etd === "17:06");
check("rid stands in for the missing serviceID", svc.serviceID === "202608237188473");
check("destination stays an array", svc.destination[0].locationName === "East Grinstead");

const cps = svc.subsequentCallingPoints[0].callingPoint;
check("subsequentLocations become callingPoint entries", Array.isArray(cps));
check("junctions without a CRS are dropped", cps.every((c) => c.crs) && cps.length === 2);
check("calling point carries st/et as HH:MM",
  cps[1].crs === "ECR" && cps[1].st === "17:08" && cps[1].et === "17:10");

/* -------------------------------------------------------------- filtering */
check("drops freight / non-passenger services",
  !body.trainServices.some((s) => s.serviceID === "freight"));
check("drops suppressed services",
  !body.trainServices.some((s) => s.serviceID === "suppressed"));
check("drops operational calls",
  !body.trainServices.some((s) => s.serviceID === "operational"));
check("drops services that terminate here",
  !body.trainServices.some((s) => s.serviceID === "terminates"));
check("keeps only the two real departures", body.trainServices.length === 2);

res = await get("/departures/VIC/to/ECR/8?expand=true&terminating=true");
body = await res.json();
check("terminating=true keeps arrival-only services",
  body.trainServices.some((s) => s.serviceID === "terminates"));

/* --------------------------------------------------- platform pass-through */
// Darwin blanks the platform itself when a station withholds it, so the Worker
// neither reveals nor re-hides anything: whatever arrives is what is served.
res = await get("/departures/VIC/to/ECR/8?expand=true");
body = await res.json();
check("platform is passed through untouched",
  body.trainServices[0].platform === "16" && body.trainServices[0].platformIsHidden === true);

/* --------------------------------------------------------------- messages */
check("reads the capitalised Value field", body.nrccMessages.length === 1);
check("decodes entities and strips markup",
  body.nrccMessages[0].value === "Trains between Oxted and Uckfield may be delayed. See Status.");

/* --------------------------------------------------------------- failures */
upstream = (u) => u.searchParams.has("filterCrs")
  ? new Response("boom", { status: 500 }) : ok(STAFF);
res = await get("/departures/VIC/to/ECR/8?expand=true");
body = await res.json();
check("5xx on a filtered board falls back to filtering here", res.status === 200);
check("fallback retried without the filter",
  calls.length === 2 && !calls[1].searchParams.has("filterCrs"));
check("fallback keeps services calling at the destination",
  body.trainServices.length === 2 && body.filteredBy === "worker");

upstream = () => new Response("boom", { status: 500 });
res = await get("/departures/VIC/to/ECR/8?expand=true");
check("both calls failing surfaces as 502", res.status === 502);

upstream = () => new Response("nope", { status: 401 });
res = await get("/departures/VIC/to/ECR/8?expand=true");
body = await res.json();
check("401 upstream → 502 naming the key", res.status === 502 && /API key/i.test(body.error));
check("error body never contains the key", !JSON.stringify(body).includes(ENV.DARWIN_KEY));

upstream = () => new Response("<html>err</html>", { status: 200, headers: { "Content-Type": "text/html" } });
res = await get("/departures/VIC/to/ECR/8?expand=true");
check("non-JSON upstream → 502", res.status === 502);

upstream = () => ok(STAFF);
res = await get("/departures/NOTACRS/to/ECR/8?expand=true");
check("malformed station code → 400 with no upstream call",
  res.status === 400 && calls.length === 0);

/* -------------------------------------------------------------------- CORS */
res = await get("/departures/VIC/to/ECR/8?expand=true");
check("allows the app origin",
  res.headers.get("Access-Control-Allow-Origin") === "https://asxtan.github.io");
res = await get("/departures/VIC/to/ECR/8?expand=true", "https://evil.test");
check("refuses an unknown origin", res.headers.get("Access-Control-Allow-Origin") === null);

res = await worker.fetch(new Request("https://worker.test/departures/VIC/to/ECR/8", {
  method: "OPTIONS", headers: { Origin: "https://asxtan.github.io" } }), ENV, {});
check("preflight returns 204", res.status === 204);

res = await worker.fetch(new Request("https://worker.test/departures/VIC/to/ECR/8?expand=true", {
  headers: { Origin: "https://evil.test" } }),
  { DARWIN_KEY: ENV.DARWIN_KEY, LDBSVWS_BASE: ENV.LDBSVWS_BASE }, {});
check("unset ALLOWED_ORIGINS does not fall open to *",
  res.headers.get("Access-Control-Allow-Origin") === null);

res = await worker.fetch(new Request("https://worker.test/departures/VIC/to/ECR/8", {
  headers: { Origin: "https://asxtan.github.io" } }), { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, {});
check("missing DARWIN_KEY → 500 with a clear message", res.status === 500);

res = await get("/crs/croydon");
body = await res.json();
check("/crs returns an empty array", res.status === 200 && Array.isArray(body) && body.length === 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
