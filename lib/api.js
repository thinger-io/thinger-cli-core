import axios from 'axios';
import { refreshToken } from './auth.js';
import { getActiveProfile, readConfig, serverURL } from './config.js';
import { TIMEOUTS } from './constants.js';
import { env } from './identity.js';
import http from 'http';
import https from 'https';

const httpAgent = new http.Agent({ keepAlive: true });
// Accept self-signed certificates when talking to local dev servers
// (localhost / 127.0.0.1). Any other host still enforces full TLS
// validation. Toggleable via <PREFIX>_INSECURE=1 for other local setups.
const httpsAgent = new https.Agent({ keepAlive: true });
const insecureAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const api = axios.create({
    timeout: TIMEOUTS.API_DEFAULT_MS,
    httpAgent,
    httpsAgent,
    // Arrays as repeated keys (product=a&product=b), which the server reads
    // as "any of"; axios's default product[]=a matches only the first.
    paramsSerializer: { indexes: null },
});

api.interceptors.request.use(
    (request) => {
        // The server comes from the active profile on every request rather
        // than from a process-wide default, so concurrent MCP tool calls
        // scoped to different profiles each reach their own server. Server
        // and token come from one read, so both are the same profile's.
        const config = readConfig();
        if (!request.baseURL) request.baseURL = serverURL(config.server);

        if (config.credentials_from) checkImpersonation(request, config);

        // A caller probing a token it hasn't persisted yet sets the header
        // itself; don't overwrite it with the stored one.
        if (!request.headers['Authorization'] && config.token) {
            request.headers['Authorization'] = `Bearer ${config.token}`;
        }

        // Allow self-signed TLS against localhost / 127.0.0.1 or when the user
        // opts in explicitly. Anything else keeps default certificate validation.
        // A malformed URL here is not worth aborting the request over — the
        // HTTPS layer will surface the real error downstream; we only care
        // about detecting localhost cheaply.
        try {
            const url = new URL(request.url || '', request.baseURL || 'https://placeholder/');
            const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
            if (url.protocol === 'https:' && (isLocal || env('INSECURE') === '1')) {
                request.httpsAgent = insecureAgent;
            }
        } catch {
            // Intentionally swallowed — see note above.
        }

        return request;
    },
    (error) => {
        return Promise.reject(error);
    },
);

/**
 * Paths outside an account that a profile acting as another account may
 * still reach: the server's version and API description (read only), the
 * OAuth endpoints, and the relays thinr opens to that account's devices.
 */
const OUTSIDE_ACCOUNTS = [
    { methods: ['get'], path: /^\/v1\/server\/(version|swagger\.json)$/ },
    { path: /^\/oauth\// },
    { methods: ['post'], path: /^\/v1\/proxies$/ },
    { methods: ['delete'], path: /^\/v1\/proxies\/[^/]+$/ },
];

/**
 * A profile that acts as another account (`impersonate`) uses the session
 * of an admin profile: everything outside an account's paths (users,
 * hosts, domains, OAuth clients…) would run with the admin's rights under
 * a profile chosen to be that account. Refused; `-u` still reaches any
 * account, and the admin profile itself does the rest.
 */
function checkImpersonation(request, config) {
    let pathname;
    try {
        pathname = new URL(request.url || '', request.baseURL || 'https://placeholder/').pathname;
    } catch {
        return;
    }
    if (/^\/(v\d+\/)?users\/[^/]+(\/|$)/.test(pathname)) return;
    const method = String(request.method || 'get').toLowerCase();
    const allowed = OUTSIDE_ACCOUNTS.some(
        (rule) => rule.path.test(pathname) && (!rule.methods || rule.methods.includes(method)),
    );
    if (allowed) return;
    const err = new Error(
        `Profile ${getActiveProfile()} acts as ${config.impersonate} with the session of profile ${config.credentials_from}: ${method.toUpperCase()} ${pathname} is not on an account, so it would run with ${config.credentials_from}'s rights. Use --profile ${config.credentials_from} for it.`,
    );
    err.code = 'forbidden';
    throw err;
}

api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        // Only intervene on 401s; everything else surfaces unchanged.
        if (error.response?.status !== 401) return Promise.reject(error);

        // Don't recurse: refresh requests themselves and already-retried
        // requests must not trigger another refresh.
        if (originalRequest?._isRefresh || originalRequest?._retry) {
            return Promise.reject(error);
        }

        // Tokens issued via the username/password flow have no
        // refresh_token. Skip the refresh attempt and let the 401 reach
        // the caller — they can log in again.
        if (!readConfig().refresh_token) return Promise.reject(error);

        originalRequest._retry = true;

        try {
            // The token this request was rejected with: when another process
            // has renewed the session meanwhile, the one it saved is used.
            const sent = String(originalRequest.headers?.['Authorization'] ?? '');
            const newToken = await refreshToken(sent.replace(/^Bearer\s+/i, '') || undefined);
            // A streamed body has been read already: it cannot be sent again.
            if (typeof originalRequest.data?.pipe === 'function') {
                const err = new Error(
                    'The session expired while sending a stream, and has been renewed: run the command again.',
                    { cause: error },
                );
                err.code = 'session_renewed';
                return Promise.reject(err);
            }
            // Patch only this request; subsequent requests pick up the new
            // token from config via the request interceptor.
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
            return api(originalRequest);
        } catch (refreshError) {
            return Promise.reject(refreshError);
        }
    },
);

export default api;
