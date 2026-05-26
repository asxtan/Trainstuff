// App configuration. Edit these and redeploy to change defaults.
window.CONFIG = {
  // Data source: a public, CORS-enabled Huxley2 instance (Darwin LDBWS proxy).
  // To use your own key/server later, point this at your self-hosted Huxley2
  // or a Cloudflare Worker that injects a Darwin Rail Data Marketplace token.
  HUXLEY_BASE_URL: "https://national-rail-api.davwheat.dev",

  // First-run default station pair (overridden once the user picks/saves one).
  DEFAULT_FROM: "ECR", // East Croydon
  DEFAULT_TO: "VIC",   // London Victoria

  NUM_ROWS: 6,         // how many departures to request
  REFRESH_MS: 45000,   // auto-refresh interval (ms)

  // On very first run with no saved pair, flip direction by time of day:
  // before midday -> DEFAULT_FROM->DEFAULT_TO, otherwise reversed.
  AUTO_DIRECTION_BY_TIME: true,
};
