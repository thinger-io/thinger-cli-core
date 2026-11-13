import { Buffer } from 'node:buffer';
import { input, password as passwordPrompt, select } from '@inquirer/prompts';
import ora from 'ora';
import open, { apps } from 'open';
import {
    getActiveProfile,
    getProfile,
    mergeConfig,
    profileTarget,
    readConfig,
    restoreProfile,
    setActiveProfile,
    withRefreshLock,
    writeConfig,
} from './config.js';
import { label, success, warning, info } from './format.js';
import { identity, loginHint } from './identity.js';

import api from './api.js';
import { TIMEOUTS } from './constants.js';
import { v1 } from './paths.js';
import { apiError, inputError, serverMessage } from './errors.js';

const OAUTH_DEVICE_CODE_TIMEOUT_MS = TIMEOUTS.OAUTH_DEVICE_CODE_MS;

/**
 * Show a prompt, or fail with a clear message when there is no terminal to
 * answer it (pipes, agents, editor-embedded shells): otherwise the prompt
 * library closes on the empty stdin with a cryptic "force closed" error.
 */
function ask(prompt, config) {
    if (!process.stdin.isTTY) {
        throw inputError(
            `"${config.message}" needs an interactive terminal. Run the command in a terminal, or sign in without prompts: ${identity().name} login --server <server> --username <user> --token <API token>`,
        );
    }
    return prompt(config);
}

/**
 * Sign in and store the credentials in the active profile.
 *
 * Every value that is passed in skips its prompt, so scripts and agents
 * can log in without a terminal: `server` + `username` + `token` is a
 * complete non-interactive login.
 *
 * @param {{
 *   method?: 'userpass' | 'token' | 'oauth',
 *   server?: string,
 *   username?: string,
 *   token?: string,
 *   clientId?: string,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function authenticate(opts = {}) {
    // When re-authenticating an existing profile, default the server prompt
    // to the one already stored so `<cli> login` is a couple of keystrokes.
    const existing = readConfig();
    const { defaultServer, oauth } = identity();

    const method =
        opts.method ||
        (opts.token ? 'token' : null) ||
        (await ask(select, {
            message: 'How would you like to authenticate?',
            // A CLI that ships its own OAuth client offers the browser login
            // first; otherwise it needs a client registered by hand, so it
            // goes last.
            choices: oauth.clientId
                ? [
                      { name: 'OAuth (browser)', value: 'oauth' },
                      { name: 'Token', value: 'token' },
                      { name: 'Username and password', value: 'userpass' },
                  ]
                : [
                      { name: 'Username and password', value: 'userpass' },
                      { name: 'Token', value: 'token' },
                      {
                          name: 'OAuth (browser, needs an OAuth client registered on the server)',
                          value: 'oauth',
                      },
                  ],
        }));

    const server =
        opts.server ||
        (await ask(input, {
            message: 'Enter server (host, or URL for http/custom ports):',
            default: existing?.server || defaultServer || undefined,
            validate: (input) => (input ? true : 'Server is required'),
        }));

    // Persist the server first: the API client takes its base URL from the
    // active profile, so the login requests below already reach it.
    // Pin the profile just written, so the merges below land on it even
    // when another profile is the default. A login that fails or is
    // interrupted puts the previous profile back: a wrong password must
    // not leave the user (and their MCP servers) signed out.
    const target = profileTarget(server);
    const previous = target ? getProfile(target) : undefined;
    const name = writeConfig({ server });
    setActiveProfile(name);
    const restore = () => restoreProfile(name, previous);
    const onSigint = () => {
        restore();
        process.exit(130);
    };
    process.once('SIGINT', onSigint);
    try {
        if (method === 'userpass') {
            await authenticateWithUserPass(opts);
        } else if (method === 'oauth') {
            await authenticateWithOAuth(opts, existing).catch(async (error) => {
                // A server older than the CLI's built-in OAuth client, or
                // one whose admin removed it: sign in another way.
                if (error.code !== 'oauth_client_unknown' || !process.stdin.isTTY) throw error;
                console.log(warning(error.message));
                const fallback = await ask(select, {
                    message: 'Sign in another way:',
                    choices: [
                        { name: 'Username and password', value: 'userpass' },
                        { name: 'Token', value: 'token' },
                    ],
                });
                return fallback === 'userpass'
                    ? authenticateWithUserPass(opts)
                    : authenticateWithToken(opts);
            });
        } else {
            await authenticateWithToken(opts);
        }
    } catch (error) {
        restore();
        throw error;
    } finally {
        process.removeListener('SIGINT', onSigint);
    }
}

/**
 * Authenticate with username and password using OAuth2 password flow, then
 * mint a permanent API token on the account so the stored credential does
 * not expire with the session.
 * @returns {Promise<void>}
 */
async function authenticateWithUserPass(opts) {
    const { token: cliToken } = identity();
    const username =
        opts.username ||
        (await ask(input, {
            message: 'Enter username:',
            validate: (input) => (input ? true : 'Username is required'),
        }));
    const password = await ask(passwordPrompt, {
        message: 'Enter password:',
        mask: '*',
        validate: (input) => (input ? true : 'Password is required'),
    });

    const spinner = ora('Authenticating...').start();

    try {
        // OAuth2 password grant
        const formData = new URLSearchParams();
        formData.append('grant_type', 'password');
        formData.append('username', username);
        formData.append('password', password);

        const { data: session } = await api.post(`/oauth/token`, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        // Nothing is stored yet, so the token requests below carry the
        // session token explicitly.
        const headers = { Authorization: `Bearer ${session.access_token}` };

        // Replace any existing token with a fresh permanent one
        spinner.text = 'Preparing user token...';
        try {
            await api.delete(`${v1(username)}/tokens/${cliToken.id}`, { headers });
        } catch (error) {
            if (error.response && error.response.status !== 404) throw error;
        }

        spinner.text = 'Creating new user token...';
        const createTokenResponse = await api.post(
            `${v1(username)}/tokens`,
            {
                enabled: true,
                allow: { '*': { '*': '*' } },
                deny: {},
                token: cliToken.id,
                name: cliToken.name,
                description: `Created by ${identity().name} login`,
            },
            { headers: { ...headers, 'Content-Type': 'application/json' } },
        );
        const permanentToken = createTokenResponse.data.access_token;

        // server was already persisted by the outer authenticate(); only
        // username + token need to be merged here. `token_id` records that
        // this CLI minted the token, so logout can revoke it.
        mergeConfig({ username, token: permanentToken, token_id: cliToken.id });
        spinner.succeed('Authentication successful');
    } catch (error) {
        spinner.fail('Authentication failed');
        if (error.response && (error.response.status === 400 || error.response.status === 401)) {
            throw Object.assign(new Error('Invalid username or password', { cause: error }), {
                code: 'unauthorized',
            });
        }
        if (error.response && error.response.status === 404) {
            throw new Error('Authentication endpoint not found. Please check the server.', {
                cause: error,
            });
        }
        throw error;
    }
}

/**
 * Exchange the saved refresh_token for a fresh access_token. Throws a
 * tagged `code: 'unauthorized'` Error when no refresh_token is on
 * record (e.g. logins made with username/password don't get one) or
 * when the OAuth server rejects the refresh — both cases mean the
 * caller has to re-authenticate.
 *
 * The server rotates refresh tokens on use: the one presented is spent
 * and a new one comes back. So renewals of a profile never overlap:
 * - callers in this process share a single in-flight refresh;
 * - processes take turns on a lock file (config.js withRefreshLock), and
 *   one that waited finds the session the other saved and uses it;
 * - a token rejected because another process (an older CLI without the
 *   lock) spent it meanwhile is not taken for an expired session either.
 *
 * Signals are held from the request until the new tokens are saved: a
 * process stopped in between would leave on disk a refresh token the
 * server has already spent, and the session could not be renewed again.
 *
 * Only a refresh the server rejects (400/401) means the session is over;
 * a network error, a timeout or a server error keep it, and say so.
 *
 * @param {string} [staleToken] The access token the caller found expired
 *   or rejected; by default the stored one. A different, valid one on disk
 *   means another process has renewed the session already.
 * @returns {Promise<string>} The new access token.
 */
const inFlightRefresh = new Map();

export async function refreshToken(staleToken) {
    const profile = getActiveProfile();
    if (inFlightRefresh.has(profile)) return inFlightRefresh.get(profile);
    const seen = staleToken ?? readConfig().token;
    const pending = withRefreshLock(profile, () => doRefresh(seen), {
        staleMs: TIMEOUTS.REFRESH_LOCK_STALE_MS,
    }).finally(() => {
        inFlightRefresh.delete(profile);
    });
    inFlightRefresh.set(profile, pending);
    return pending;
}

function sessionExpired(reason) {
    const err = new Error(`Session expired${reason ? ` (server: ${reason})` : ''}. ${loginHint()}`);
    err.code = 'unauthorized';
    return err;
}

/**
 * A renewal that failed for another reason than the session itself: the
 * session may still be good, so it is not reported as expired.
 */
function refreshFailed(error) {
    const { message, code } = apiError(error);
    const reason =
        code === 'timeout'
            ? `no answer from the server within ${TIMEOUTS.TOKEN_REFRESH_MS / 1000} s.`
            : message;
    const err = new Error(`Could not renew the session: ${reason} Try again.`, {
        cause: error,
    });
    err.code = code;
    return err;
}

/** A stored access token that is not about to expire (no `exp`: never). */
function usable(token) {
    if (!token) return false;
    const expiresAt = jwtExpiryMs(token);
    return expiresAt === null || expiresAt - Date.now() > TIMEOUTS.TOKEN_EXPIRY_SLACK_MS;
}

async function doRefresh(seen) {
    const config = readConfig();
    // Renewed by another process while this one waited for the lock.
    if (config.token !== seen && usable(config.token)) return config.token;

    const clientId = config.oauth_client_id || identity().oauth.clientId;
    if (!config.refresh_token || !clientId) throw sessionExpired();

    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('client_id', clientId);
    formData.append('refresh_token', config.refresh_token);

    try {
        return await holdingSignals(async () => {
            // `_isRefresh` flags this request so the response interceptor
            // skips its own refresh-on-401 logic — otherwise a refresh that
            // returned 401 would recurse back here forever.
            const response = await api.post('/oauth/token', formData, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: TIMEOUTS.TOKEN_REFRESH_MS,
                _isRefresh: true,
            });
            const { access_token, refresh_token } = response.data;
            mergeConfig({
                token: access_token,
                // A server that does not rotate them answers none: keep ours.
                refresh_token: refresh_token || config.refresh_token,
            });
            return access_token;
        });
    } catch (error) {
        // Spent by another process meanwhile, which saved the new session.
        const now = readConfig();
        if (now.refresh_token !== config.refresh_token && usable(now.token)) return now.token;
        const status = error.response?.status;
        if (status === 400 || status === 401) {
            throw sessionExpired(serverMessage(error.response.data));
        }
        throw refreshFailed(error);
    }
}

/**
 * Run `fn` with SIGINT, SIGTERM and SIGHUP held, then act on the first one
 * that arrived as the process would have.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function holdingSignals(fn) {
    const signals = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
    /** @type {NodeJS.Signals | undefined} */
    let caught;
    const hold = (/** @type {NodeJS.Signals} */ signal) => {
        caught ??= signal;
    };
    for (const signal of signals) process.on(signal, hold);
    try {
        return await fn();
    } finally {
        for (const signal of signals) process.off(signal, hold);
        // Others listening got the signal already; without them, the default.
        if (caught && process.listenerCount(caught) === 0) process.kill(process.pid, caught);
    }
}

/**
 * Milliseconds-since-epoch expiry of a JWT access token, or null when
 * the token is not a decodable JWT (permanent API tokens have no exp).
 */
function jwtExpiryMs(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

/**
 * Return a currently-valid access token, refreshing first when the
 * stored one is an expired (or about-to-expire) JWT. HTTP requests
 * recover from expiry through the api.js response interceptor, but
 * WebSocket handshakes have no retry layer: callers opening a WS use
 * this to start from a valid token. Tokens without a decodable `exp`
 * and profiles without a refresh_token pass through untouched.
 */
export async function ensureFreshToken() {
    const config = readConfig();
    if (!config?.token || !config.refresh_token) return config?.token ?? null;
    const expiresAt = jwtExpiryMs(config.token);
    if (expiresAt === null || expiresAt - Date.now() > TIMEOUTS.TOKEN_EXPIRY_SLACK_MS) {
        return config.token;
    }
    return refreshToken();
}

/**
 * Revoke the API token this CLI minted for the active profile at login.
 * Profiles that hold a pasted token or an OAuth session have nothing to
 * revoke: the token belongs to whoever created it.
 *
 * @returns {Promise<'revoked' | 'absent' | 'not_owned'>}
 */
export async function revokeCliToken() {
    const config = readConfig();
    if (!config.token_id || !config.username) return 'not_owned';
    try {
        await api.delete(`${v1(config.username)}/tokens/${config.token_id}`);
        return 'revoked';
    } catch (error) {
        if (error.response?.status === 404) return 'absent';
        throw error;
    }
}

/**
 * Authenticate with an existing API token.
 * @returns {Promise<void>}
 */
async function authenticateWithToken(opts) {
    const username =
        opts.username ||
        (await ask(input, {
            message: 'Enter username:',
            validate: (input) => (input ? true : 'Username is required'),
        }));
    const token =
        opts.token ||
        (await ask(passwordPrompt, {
            message: 'Enter token:',
            mask: '*',
            validate: (input) => (input ? true : 'Token is required'),
        }));

    const spinner = ora('Validating token...').start();
    try {
        // The api interceptor attaches Authorization from the saved
        // config; at this point we haven't persisted the token yet, so
        // the header has to be passed explicitly for the probe request.
        await api.get(`${v1(username)}/profile`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        spinner.succeed('Token validation successful');
    } catch (error) {
        const status = error.response?.status;
        // 403: the token is valid but scoped away from the user profile.
        // Keep it — it may well cover what the user wants to do.
        if (status === 403) {
            spinner.warn('Token accepted, but it cannot read the user profile (limited scope)');
        } else {
            spinner.fail('Token validation failed');
            if (status === 401) {
                throw Object.assign(new Error('Invalid token', { cause: error }), {
                    code: 'unauthorized',
                });
            }
            throw error;
        }
    }
    mergeConfig({ username, token });
}

/**
 * Authenticate with the OAuth device flow. Needs an OAuth client registered
 * on the server: the identity's own when it has one, otherwise the one the
 * user names (remembered per profile, since refreshing needs it again).
 * @returns {Promise<void>}
 */
async function authenticateWithOAuth(opts, existing) {
    const client_id =
        opts.clientId ||
        identity().oauth.clientId ||
        (await ask(input, {
            message: 'OAuth client id (registered on the server):',
            default: existing?.oauth_client_id || undefined,
            validate: (input) => (input ? true : 'Client id is required'),
        }));
    let oauth_tokens = {};

    const spinner = ora('Requesting OAuth User Code...').start();
    let data;
    try {
        ({ data } = await api.post(
            `/oauth/device/authorize`,
            { client_id },
            { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
        ));
        spinner.succeed('OAuth User Code received');
    } catch (error) {
        spinner.fail('OAuth device-code request failed');
        const status = error.response?.status;
        if (status === 401 || status === 404) {
            throw Object.assign(
                new Error(
                    `The server does not know the OAuth client ${client_id} (Thinger 7.5.0 and later have it built in). Sign in with a token or username and password instead.`,
                ),
                { code: 'oauth_client_unknown' },
            );
        }
        throw error;
    }

    console.log('\nYour one time device code is: ' + label(data.user_code));
    console.log(
        info('Press ' + label('ENTER')) +
            ' to open your browser or submit your device code here: ' +
            data.verification_uri +
            '\n',
    );

    const device_code = data.device_code;
    let pollDeviceIntervalId;
    let interval = 5000;
    let pollError = null; // captured by polling, surfaced after the await
    const controller = new AbortController();

    function setPollingInterval(ms) {
        if (pollDeviceIntervalId) clearInterval(pollDeviceIntervalId);
        pollDeviceIntervalId = setInterval(pollDevice, ms);
    }

    async function pollDevice() {
        try {
            const response = await api.post(
                `/oauth/token`,
                {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    client_id,
                    device_code,
                },
                { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
            );
            if (response.status === 200) {
                oauth_tokens = response.data;
                controller.abort('validated');
            }
        } catch (e) {
            if (e.response && e.response.status === 400) {
                const err = e.response.data && e.response.data.error;
                if (err === 'authorization_pending') return;
                if (err === 'slow_down') {
                    interval += 1000;
                    setPollingInterval(interval);
                    return;
                }
                if (err === 'access_denied') {
                    pollError = new Error('User denied the authorization request');
                    controller.abort('error');
                    return;
                }
                if (err === 'expired_token') {
                    pollError = new Error('Device code expired');
                    controller.abort('error');
                    return;
                }
                pollError = new Error(`OAuth error: ${err}`);
                controller.abort('error');
            }
        }
    }

    setPollingInterval(interval);

    // 10-minute hard ceiling on the user finishing in the browser
    const timeoutId = setTimeout(() => {
        clearInterval(pollDeviceIntervalId);
        controller.abort('timeout');
    }, OAUTH_DEVICE_CODE_TIMEOUT_MS);

    if (!process.stdin.isTTY) {
        clearInterval(pollDeviceIntervalId);
        clearTimeout(timeoutId);
        throw inputError(
            `The OAuth login needs an interactive terminal (open ${data.verification_uri_complete} there).`,
        );
    }

    try {
        await input(
            {
                message: 'Press ENTER to continue or wait for authentication...',
                waitUserInput: true,
                validate: () => {
                    open(data.verification_uri_complete, {
                        app: [{ name: apps.browser }, 'firefox-developer-edition'],
                    });
                    return '';
                },
            },
            {
                signal: controller.signal,
            },
        ).catch((error) => {
            if (error.cause === 'timeout') {
                console.log(warning('Polling aborted due to timeout'));
            } else if (error.cause === 'validated') {
                console.log(success('Device authenticated successfully'));
            }
            // 'error' cause falls through; we surface pollError below.
        });
    } finally {
        clearInterval(pollDeviceIntervalId);
        clearTimeout(timeoutId);
    }

    if (pollError) throw pollError;
    if (!oauth_tokens.access_token) throw new Error('OAuth flow ended without a token');

    const token = oauth_tokens.access_token;
    const refresh_token = oauth_tokens.refresh_token;
    const decodedJWT = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const username = decodedJWT.usr;

    mergeConfig({ username, token, refresh_token, oauth_client_id: client_id });
    console.log(success('OAuth token validation successful\n'));
}

/**
 * Access token of the active profile, or null when there is none.
 * Silent on purpose: under `mcp` stdout is the protocol channel.
 * @returns {string | null}
 */
export function getAccessToken() {
    return readConfig()?.token || null;
}
