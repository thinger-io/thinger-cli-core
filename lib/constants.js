// @ts-check

/**
 * Central home for the numeric knobs the CLI scatters otherwise.
 * Keep every "magic number" that has meaning beyond its immediate call
 * site here so we can tune them in one place (and grep for them when
 * debugging a missed OAuth poll).
 */

/** Timeouts. All values in ms. */
export const TIMEOUTS = {
    /** Default axios request timeout for control-plane HTTP calls. */
    API_DEFAULT_MS: 10_000,

    /**
     * Requests that do work on the server or move files: resource actions
     * (plugin install pulls a container, bucket import, product export),
     * device and plugin calls, uploads. The server keeps working past a
     * client timeout, so a short one only makes callers retry half-done jobs.
     */
    API_LONG_MS: 10 * 60 * 1000,

    /**
     * Refresh a JWT access token this close to (or past) its `exp`
     * before opening a WebSocket. WS handshakes lack the
     * refresh-on-401 retry that api.js gives HTTP requests.
     */
    TOKEN_EXPIRY_SLACK_MS: 30_000,

    /**
     * Ceiling for the request that renews an OAuth session. Signals are
     * held while it runs (see auth.js), so it also bounds how long Ctrl+C
     * can wait.
     */
    TOKEN_REFRESH_MS: 15_000,

    /**
     * A refresh lock older than this belongs to a process that died
     * without removing it: the request it guards has timed out by then.
     */
    REFRESH_LOCK_STALE_MS: 20_000,

    /** Hard ceiling for the OAuth device-code flow — 10 minutes. */
    OAUTH_DEVICE_CODE_MS: 10 * 60 * 1000,
};

/** Byte units, so callers don't have to eyeball `1073741824`. */
export const BYTES = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
};
