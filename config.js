// App configuration. Edit these and redeploy to change defaults.
window.CONFIG = {
  // Our own Cloudflare Worker (worker/), backed by a Rail Data Marketplace
  // subscription. A list because apiJson() walks it on failure, but the
  // community Huxley2 instances that used to sit here are gone: their legacy
  // Darwin tokens died with the National Rail Data Portal, so keeping them
  // only bought a ~24 s walk through dead hosts before surfacing an error.
  API_BASE_URLS: ["https://commute-board-api.asxtan.workers.dev"],

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
