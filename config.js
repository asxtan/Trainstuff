// App configuration. Edit these and redeploy to change defaults.
window.CONFIG = {
  // Data sources, tried in order; the first that answers is used for the rest
  // of the session. See worker/README.md for the proxy that serves these.
  HUXLEY_BASE_URLS: [
    // Our own Cloudflare Worker (worker/), backed by a Rail Data Marketplace
    // key. First because it's the one whose uptime we control.
    "https://commute-board-api.asxtan.workers.dev",
    // Community instances, kept as fallbacks. They depend on legacy Darwin
    // tokens that stopped working when the Data Portal was retired, so treat
    // them as a bonus rather than a safety net.
    "https://national-rail-api.davwheat.dev",
    "https://huxley2.azurewebsites.net",
    "https://onrails.azurewebsites.net"
  ],

  // Back-compat: honoured only if HUXLEY_BASE_URLS is absent.
  HUXLEY_BASE_URL: "https://national-rail-api.davwheat.dev",

  // First-run defaults only. Home and the two work stations are all editable
  // in-app (the gear button) and saved per device — nothing is hardcoded.
  DEFAULT_HOME: "ECR",   // East Croydon
  DEFAULT_WORK_A: "VIC", // London Victoria
  DEFAULT_WORK_B: "LBG", // London Bridge

  NUM_ROWS: 8,         // how many departures to request per board
  REFRESH_MS: 45000,   // auto-refresh interval (ms)

  // On load, before this hour default to "To work", otherwise "To home".
  MORNING_BEFORE_HOUR: 12,
};
