// App configuration. Edit these and redeploy to change defaults.
window.CONFIG = {
  // Data source: a public, CORS-enabled Huxley2 instance (Darwin LDBWS proxy).
  // To use your own key/server later, point this at your self-hosted Huxley2
  // or a Cloudflare Worker that injects a Darwin Rail Data Marketplace token.
  // Tried in order; the first one that answers is used for the rest of the
  // session. These are shared community instances with no uptime guarantee, so
  // more than one matters — when the primary goes down the board just stops.
  HUXLEY_BASE_URLS: [
    "https://national-rail-api.davwheat.dev",
    "https://huxley2.azurewebsites.net"
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
