// Offline checks for the Worker: no network, no wrangler, no Darwin key.
// Run with: node test.mjs
import worker from "./src/index.js";

const ENV = {
  DARWIN_KEY: "test-key-never-logged",
  ALLOWED_ORIGINS: "https://asxtan.github.io",
  LDBWS_BASE: "https://ldbws.test/api"
};

let upstream = null; // set per test: (url, init) => Response
let lastRequest = null;

globalThis.fetch = async (url, init) => {
  lastRequest = { url: new URL(url), init };
  return upstream(lastRequest.url, init);
};

const ok = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

function get(path, origin = "https://asxtan.github.io") {
  return worker.fetch(
    new Request("https://worker.test" + path, { headers: { Origin: origin } }),
    ENV,
    {}
  );
}

let failures = 0;
function check(name, cond) {
  if (!cond) failures++;
  console.log((cond ? "PASS  " : "FAIL  ") + name);
}

const SAMPLE = {
  locationName: "East Croydon",
  crs: "ECR",
  trainServices: [
    {
      serviceID: "abc",
      std: "08:15",
      etd: "On time",
      platform: "4",
      length: 8,
      operator: "Southern",
      destination: { locationName: "London Victoria", crs: "VIC" },
      subsequentCallingPoints: [{ locationName: "Clapham Junction", crs: "CLJ", st: "08:24", et: "On time" }]
    }
  ],
  nrccMessages: [{ xhtmlMessage: "Engineering works this weekend." }]
};

/* ------------------------------------------------------------------ tests */

// 1. Path + filter mapping
upstream = () => ok(SAMPLE);
let res = await get("/departures/ECR/to/VIC/8?expand=true");
check("200 for a valid filtered board", res.status === 200);
check("uses GetArrDepBoardWithDetails when expand=true",
  lastRequest.url.pathname.includes("GetArrDepBoardWithDetails"));
check("passes filterCrs", lastRequest.url.searchParams.get("filterCrs") === "VIC");
check("passes filterType=to", lastRequest.url.searchParams.get("filterType") === "to");
check("passes numRows", lastRequest.url.searchParams.get("numRows") === "8");
check("sends the key in x-apikey", lastRequest.init.headers["x-apikey"] === ENV.DARWIN_KEY);

// 2. Response shape app.js depends on
let body = await res.json();
const svc = body.trainServices[0];
check("nests subsequentCallingPoints as Huxley does",
  Array.isArray(svc.subsequentCallingPoints[0].callingPoint) &&
  svc.subsequentCallingPoints[0].callingPoint[0].crs === "CLJ");
check("wraps destination in an array", Array.isArray(svc.destination) &&
  svc.destination[0].locationName === "London Victoria");
check("preserves std/etd/platform/length",
  svc.std === "08:15" && svc.etd === "On time" && svc.platform === "4" && svc.length === 8);
check("maps xhtmlMessage to value", body.nrccMessages[0].value.startsWith("Engineering"));

// 3. Unfiltered board (no /to/)
upstream = () => ok(SAMPLE);
await get("/departures/ECR/6");
check("unfiltered board sets no filterCrs", !lastRequest.url.searchParams.has("filterCrs"));
check("unfiltered board still sets numRows", lastRequest.url.searchParams.get("numRows") === "6");

// 4. expand omitted → the cheaper operation
upstream = () => ok(SAMPLE);
await get("/departures/ECR/to/VIC/8");
check("uses GetArrivalDepartureBoard without expand",
  lastRequest.url.pathname.endsWith("/GetArrivalDepartureBoard/ECR"));

// 5. timeOffset clamping (Darwin only serves +/- 120 min)
upstream = () => ok(SAMPLE);
await get("/departures/ECR/to/VIC/8?expand=true&timeOffset=500");
check("clamps timeOffset to +120", lastRequest.url.searchParams.get("timeOffset") === "120");
await get("/departures/ECR/to/VIC/8?expand=true&timeOffset=-500");
check("clamps timeOffset to -120", lastRequest.url.searchParams.get("timeOffset") === "-120");

// 6. Validation happens before spending an upstream call
lastRequest = null;
upstream = () => ok(SAMPLE);
res = await get("/departures/NOTACRS/to/VIC/8");
check("rejects a malformed station code with 400", res.status === 400);
check("malformed code costs no upstream call", lastRequest === null);

// 7. Upstream failures map to 502, and never leak the key
upstream = () => new Response("nope", { status: 401 });
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("401 upstream → 502", res.status === 502);
check("401 message names the key problem", /API key/i.test(body.error));
check("error body never contains the key", !JSON.stringify(body).includes(ENV.DARWIN_KEY));

upstream = () => new Response("<html>down</html>", { status: 200, headers: { "Content-Type": "text/html" } });
res = await get("/departures/ECR/to/VIC/8?expand=true");
check("non-JSON upstream → 502 (the failure mode we hit)", res.status === 502);

// 8. CORS
upstream = () => ok(SAMPLE);
res = await get("/departures/ECR/to/VIC/8?expand=true");
check("allows the app origin",
  res.headers.get("Access-Control-Allow-Origin") === "https://asxtan.github.io");
res = await get("/departures/ECR/to/VIC/8?expand=true", "https://evil.test");
check("does not allow an unknown origin",
  res.headers.get("Access-Control-Allow-Origin") === null);

res = await worker.fetch(
  new Request("https://worker.test/departures/ECR/to/VIC/8", {
    method: "OPTIONS",
    headers: { Origin: "https://asxtan.github.io" }
  }), ENV, {});
check("preflight returns 204", res.status === 204);

// A dashboard deploy sets only DARWIN_KEY, so the built-in origin list has to
// hold on its own — an unset ALLOWED_ORIGINS must not fall open to "*".
const NO_ORIGINS_ENV = { DARWIN_KEY: ENV.DARWIN_KEY, LDBWS_BASE: ENV.LDBWS_BASE };
upstream = () => ok(SAMPLE);
res = await worker.fetch(
  new Request("https://worker.test/departures/ECR/to/VIC/8?expand=true", {
    headers: { Origin: "https://asxtan.github.io" }
  }), NO_ORIGINS_ENV, {});
check("unset ALLOWED_ORIGINS still allows the app origin",
  res.headers.get("Access-Control-Allow-Origin") === "https://asxtan.github.io");
res = await worker.fetch(
  new Request("https://worker.test/departures/ECR/to/VIC/8?expand=true", {
    headers: { Origin: "https://evil.test" }
  }), NO_ORIGINS_ENV, {});
check("unset ALLOWED_ORIGINS does not fall open to *",
  res.headers.get("Access-Control-Allow-Origin") === null);

// 9. Missing secret is reported, not silently broken
res = await worker.fetch(
  new Request("https://worker.test/departures/ECR/to/VIC/8", {
    headers: { Origin: "https://asxtan.github.io" }
  }), { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, {});
check("missing DARWIN_KEY → 500 with a clear message", res.status === 500);

// 10. Arr/Dep boards list terminating services too. They have sta but no std,
// and app.js falls back to sta, so they'd render as departures that never go.
upstream = () => ok({
  locationName: "East Croydon",
  trainServices: [
    { serviceID: "terminates", sta: "08:10", eta: "On time", platform: "1",
      destination: { locationName: "East Croydon", crs: "ECR" } },
    { serviceID: "departs", std: "08:15", etd: "On time", platform: "4",
      destination: { locationName: "London Victoria", crs: "VIC" } }
  ],
  nrccMessages: []
});
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("drops arrival-only services from a departure board",
  body.trainServices.length === 1 && body.trainServices[0].serviceID === "departs");

res = await get("/departures/ECR/to/VIC/8?expand=true&terminating=true");
body = await res.json();
check("terminating=true keeps them, for a future arrivals view",
  body.trainServices.length === 2);

// Arrival fields survive for trains that both arrive and depart, so an
// arrivals view wouldn't need any Worker change to read them.
upstream = () => ok({
  trainServices: [{ serviceID: "through", sta: "08:12", eta: "08:14",
    std: "08:15", etd: "On time", destination: { locationName: "London Victoria", crs: "VIC" } }],
  nrccMessages: []
});
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("passes sta/eta through untouched",
  body.trainServices[0].sta === "08:12" && body.trainServices[0].eta === "08:14");

// 10b. Darwin's filterCrs 500s for some stations (VIC observed) while the
// unfiltered board answers. Fall back to fetching wide and filtering here.
const WIDE = {
  locationName: "London Victoria",
  trainServices: [
    { serviceID: "calls-ecr", std: "16:20", etd: "On time", platform: "12",
      destination: { locationName: "Brighton", crs: "BTN" },
      subsequentCallingPoints: [{ callingPoint: [
        { locationName: "Clapham Junction", crs: "CLJ", st: "16:26" },
        { locationName: "East Croydon", crs: "ECR", st: "16:38" }] }] },
    { serviceID: "misses-ecr", std: "16:24", etd: "On time", platform: "9",
      destination: { locationName: "Epsom", crs: "EPS" },
      subsequentCallingPoints: [{ callingPoint: [
        { locationName: "Sutton", crs: "SUO", st: "16:45" }] }] },
    { serviceID: "terminates-ecr", std: "16:30", etd: "On time", platform: "15",
      destination: { locationName: "East Croydon", crs: "ECR" },
      subsequentCallingPoints: [{ callingPoint: [
        { locationName: "Clapham Junction", crs: "CLJ", st: "16:36" }] }] }
  ],
  nrccMessages: []
};
let calls = [];
upstream = (u) => {
  calls.push(u.toString());
  if (u.searchParams.has("filterCrs")) return new Response("upstream boom", { status: 500 });
  return ok(WIDE);
};
res = await get("/departures/VIC/to/ECR/8?expand=true");
body = await res.json();
check("recovers from a 5xx on the filtered call", res.status === 200);
check("retried without the filter", calls.length === 2 && !new URL(calls[1]).searchParams.has("filterCrs"));
check("asked for extra rows before filtering",
  new URL(calls[1]).searchParams.get("numRows") === "20");
check("keeps services calling at the destination",
  body.trainServices.some((s) => s.serviceID === "calls-ecr"));
check("keeps services terminating at the destination",
  body.trainServices.some((s) => s.serviceID === "terminates-ecr"));
check("drops services that never reach the destination",
  !body.trainServices.some((s) => s.serviceID === "misses-ecr"));
check("marks the payload as worker-filtered", body.filteredBy === "worker");

// Without calling points there is nothing to filter on, so don't guess.
calls = [];
res = await get("/departures/VIC/to/ECR/8");
check("no expand -> reports the outage instead of guessing", res.status === 502);

// A 5xx with no destination filter is just an outage.
calls = [];
upstream = () => new Response("boom", { status: 500 });
res = await get("/departures/VIC/8?expand=true");
check("unfiltered 5xx still surfaces as 502", res.status === 502);

// A healthy filtered call must not trigger the fallback.
calls = [];
upstream = (u) => { calls.push(u.toString()); return ok(SAMPLE); };
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("healthy filtered call makes exactly one upstream request", calls.length === 1);
check("healthy filtered call is not marked worker-filtered", body.filteredBy === undefined);

// 11. NRCC messages: LDBWS REST capitalises the field, and the body is HTML.
upstream = () => ok({
  trainServices: [{ serviceID: "a", std: "08:15", etd: "On time",
    destination: { locationName: "London Victoria", crs: "VIC" } }],
  nrccMessages: [
    { Value: "Trains&nbsp;between&nbsp;Oxted&nbsp;and Uckfield may be delayed by up to&nbsp;15 minutes. See <a href=\"https://example.com\">Status</a>." },
    { Value: "" },
    { Value: "   " }
  ]
});
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("reads the capitalised Value field", body.nrccMessages.length === 1);
const msg = body.nrccMessages[0].value;
check("decodes &nbsp; to real spaces", msg.includes("Trains between Oxted and Uckfield"));
check("strips anchor markup", !msg.includes("<a") && !msg.includes("</a>"));
check("keeps the human text around the link", msg.includes("See Status"));
check("no gap before punctuation left by stripped markup", !/ \./.test(msg));
check("drops blank messages", !body.nrccMessages.some((m) => !m.value.trim()));

// Entity decoding shouldn't reintroduce markup that textContent would show raw.
upstream = () => ok({
  trainServices: [{ serviceID: "a", std: "08:15", destination: { locationName: "X", crs: "VIC" } }],
  nrccMessages: [{ Value: "Delays &amp; cancellations &lt;here&gt;" }]
});
res = await get("/departures/ECR/to/VIC/8?expand=true");
body = await res.json();
check("decodes &amp; &lt; &gt;",
  body.nrccMessages[0].value === "Delays & cancellations <here>");

// 11. Station search is a clean no-op (app falls back to stations.json)
res = await get("/crs/croydon");
body = await res.json();
check("/crs returns an empty array, not an error",
  res.status === 200 && Array.isArray(body) && body.length === 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
