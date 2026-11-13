import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { input, password as passwordPrompt, select } from '@inquirer/prompts';
import ora from 'ora';
import open, { apps } from 'open';
import {
    credentialsProfile,
    getActiveProfile,
    getProfile,
    mergeConfig,
    saveRenewedSession,
    serverURL,
    profileTarget,
    readConfig,
    setActiveProfile,
    withRefreshLock,
    withStagedProfile,
} from './config.js';
import { label, success, warning, info } from './format.js';
import { identity, loginHint } from './identity.js';

import api from './api.js';
import { TIMEOUTS } from './constants.js';
import { v1 } from './paths.js';
import {
    checkDeviceCode,
    oauthSession,
    requestDeviceCode,
    revokeReplacedToken,
    startDeviceLogin,
} from './device-login.js';
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
            `"${config.message}" needs an interactive terminal. Run the command in a terminal, or sign in without prompts: ${identity().name} login --oauth --server <server> (approve it in the browser, then ${identity().name} login --wait), or ${identity().name} login --server <server> --username <user> --token <API token>`,
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
 *   noWait?: boolean,
 *   description?: string,
 *   activate?: boolean,
 *   create?: boolean,
 * }} [opts]
 *   `noWait` (implied without a terminal): a browser login is only started,
 *   and the state answered says where to approve it; `<cli> login --wait`
 *   (or the MCP profile `status` action) finishes it. `description`,
 *   `activate` and `create` are for the profile such a login creates.
 * @returns {Promise<import('./device-login.js').LoginState | void>}
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

    // Without a terminal the browser login cannot be waited for here: it is
    // started, and finished by another call once approved.
    if (method === 'oauth' && (opts.noWait || !process.stdin.isTTY)) {
        const name = profileTarget(opts.server);
        return startDeviceLogin(name, {
            server: opts.server,
            clientId: opts.clientId,
            description: opts.description,
            activate: opts.activate,
            create: opts.create,
        });
    }

    const server =
        opts.server ||
        (await ask(input, {
            message: 'Enter server (host, or URL for http/custom ports):',
            default: existing?.server || defaultServer || undefined,
            validate: (input) => (input ? true : 'Server is required'),
        }));

    // The login works on the profile in memory, starting from the server
    // (the API client takes its base URL from it), and saves it only once
    // signed in: a wrong password, a device code never approved or a
    // killed process leave the saved profile as it was, so the user (and
    // their MCP servers, and other processes) stay signed in.
    const name = profileTarget(server);
    if (!name) throw new Error('Cannot sign in without a server / profile name');
    // A profile acting as another account has no session of its own to sign
    // in; signing in the admin's from it could replace that one by mistake.
    const holder = credentialsProfile(name);
    if (holder !== name) {
        throw Object.assign(
            new Error(
                `Profile ${name} uses the session of profile ${holder}: sign that one in. ${loginHint(holder)}`,
            ),
            { code: 'input_error' },
        );
    }
    // What the profile is for outlives its sessions.
    const description = getProfile(name)?.description;
    /** @type {(() => Promise<void>) | undefined} */
    let afterSave;
    await withStagedProfile(name, { server, ...(description && { description }) }, async () => {
        if (method === 'userpass') {
            afterSave = await authenticateWithUserPass(opts);
        } else if (method === 'oauth') {
            afterSave = await authenticateWithOAuth(opts, existing).catch(async (error) => {
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
                if (fallback === 'userpass') return authenticateWithUserPass(opts);
                await authenticateWithToken(opts);
                return undefined;
            });
        } else {
            await authenticateWithToken(opts);
        }
    });
    // Later reads in this process (the CLI's "Signed in" line) see it.
    setActiveProfile(name);
    await afterSave?.();
}

/**
 * Authenticate with username and password using OAuth2 password flow, then
 * mint a permanent API token on the account so the stored credential does
 * not expire with the session.
 *
 * Each profile gets a token of its own (`<id>_<random>`): a login on
 * another machine or profile of the same account leaves this one's alone.
 * The token this profile had before is revoked only once the new one is
 * saved (the function returned), so a login that fails half-way never
 * leaves the profile with a revoked token.
 *
 * @returns {Promise<() => Promise<void>>} What to do once the profile is saved.
 */
async function authenticateWithUserPass(opts) {
    const { token: cliToken } = identity();
    // The profile as saved, untouched while this login is staged.
    const previous = getProfile(getActiveProfile()) ?? {};
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

        let session;
        try {
            ({ data: session } = await api.post(`/oauth/token`, formData, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }));
        } catch (error) {
            if (error.response?.status !== 403) throw error;
            const body = error.response.data;
            if (body?.error !== 'mfa_required') {
                // Password sign-in disabled, or a second factor to set up first.
                throw Object.assign(
                    new Error(
                        `${serverMessage(error.response?.data) || 'The server refused the password sign-in'}. Sign in through the browser instead: ${identity().name} login --oauth`,
                        { cause: error },
                    ),
                    { code: 'unauthorized' },
                );
            }
            spinner.stop();
            session = await secondFactor(username, password, body);
            spinner.start('Creating new user token...');
        }
        // Nothing is stored yet, so the token requests below carry the
        // session token explicitly.
        const headers = { Authorization: `Bearer ${session.access_token}` };

        spinner.text = 'Creating new user token...';
        const tokenId = `${cliToken.id}_${crypto.randomBytes(4).toString('hex')}`;
        const createTokenResponse = await api.post(
            `${v1(username)}/tokens`,
            {
                enabled: true,
                allow: { '*': { '*': '*' } },
                deny: {},
                token: tokenId,
                name: cliToken.name,
                description: `Created by ${identity().name} login`,
            },
            { headers: { ...headers, 'Content-Type': 'application/json' } },
        );
        const permanentToken = createTokenResponse.data.access_token;

        // The outer authenticate() set the server; only username + token
        // need to be merged here. `token_id` records that
        // this CLI minted the token, so logout can revoke it.
        mergeConfig({ username, token: permanentToken, token_id: tokenId });
        spinner.succeed('Authentication successful');
        return async () => {
            const problem = await revokeReplacedToken(previous, username, permanentToken, tokenId);
            if (problem) console.log(warning(problem));
        };
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
 * The second step of a password sign-in on an account with multi-factor
 * authentication: the code of an authenticator app (TOTP). A security key
 * (WebAuthn) needs the browser, so the browser login is offered instead.
 *
 * @param {string} username
 * @param {string} password
 * @param {{ mfa_token: string, mfa_methods?: string[] }} challenge
 */
async function secondFactor(username, password, challenge) {
    const methods = challenge.mfa_methods ?? [];
    if (!methods.includes('totp')) {
        throw Object.assign(
            new Error(
                `${username} signs in with a security key, which only the browser can use: ${identity().name} login --oauth`,
            ),
            { code: 'unauthorized' },
        );
    }
    const otp = await ask(input, {
        message: 'Code from your authenticator app (or a backup code):',
        validate: (v) =>
            /^[A-Za-z0-9-]{6,16}$/.test((v || '').trim()) ? true : 'Enter the 6-digit code',
    });
    const spinner = ora('Verifying code...').start();
    try {
        const form = new URLSearchParams({
            grant_type: 'mfa-otp',
            mfa_token: challenge.mfa_token,
            password,
            // Backup codes are upper case, with or without the dash shown.
            otp: /^\d+$/.test(otp.trim()) ? otp.trim() : otp.trim().replace(/-/g, '').toUpperCase(),
        });
        const { data } = await api.post('/oauth/token', form, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        spinner.succeed('Code verified');
        return data;
    } catch (error) {
        spinner.fail('Code not accepted');
        const status = error.response?.status;
        throw Object.assign(
            new Error(
                status === 400 || status === 401 || status === 403
                    ? `The code was not accepted: ${serverMessage(error.response?.data) || 'invalid code'}`
                    : apiError(error).message,
                { cause: error },
            ),
            { code: 'unauthorized' },
        );
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
    // Per credentials, not per profile: a profile that takes its
    // credentials from another renews that one's session. Resolved once:
    // the refresh reads and writes this profile by name, whatever the
    // default becomes meanwhile.
    const holder = credentialsProfile(getActiveProfile());
    if (inFlightRefresh.has(holder)) return inFlightRefresh.get(holder);
    const seen = staleToken ?? readConfig().token;
    /** @type {(() => void) | null} */
    let release = null;
    const holdSignalsNow = () => {
        release ??= holdSignals();
    };
    guardExit();
    const pending = withRefreshLock(holder, () => doRefresh(holder, seen, holdSignalsNow), {
        staleMs: TIMEOUTS.REFRESH_LOCK_STALE_MS,
    }).finally(() => {
        inFlightRefresh.delete(holder);
        // After the lock is released, so a signal acted on now leaves none.
        release?.();
        unguardExit();
    });
    inFlightRefresh.set(holder, pending);
    return pending;
}

/** @param {string | null} holder  The profile that holds the credentials. */
function sessionExpired(holder, reason) {
    // Signing in again happens where the credentials live.
    const elsewhere = holder && holder !== getActiveProfile() ? ` in profile ${holder}` : '';
    const err = new Error(
        `Session expired${reason ? ` (server: ${reason})` : ''}${elsewhere}. ${loginHint(holder)}`,
    );
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

/** The stored session of the profile that holds the credentials. */
function sessionOf(holder) {
    if (!holder) return readConfig();
    const profile = getProfile(holder) ?? {};
    // A chain is not followed: such a profile holds no credentials.
    return profile.credentials_from ? {} : profile;
}

async function doRefresh(holder, seen, holdSignalsNow) {
    const config = sessionOf(holder);
    // Renewed by another process while this one waited for the lock.
    if (config.token !== seen && usable(config.token)) return config.token;

    const clientId = config.oauth_client_id || identity().oauth.clientId;
    if (!config.refresh_token || !clientId) throw sessionExpired(holder);
    const presented = config.refresh_token;

    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('client_id', clientId);
    formData.append('refresh_token', presented);

    // From here until the new tokens are saved, a stopped process would
    // leave on disk a refresh token the server has already spent.
    holdSignalsNow();
    let response;
    try {
        // `_isRefresh` flags this request so the response interceptor
        // skips its own refresh-on-401 logic — otherwise a refresh that
        // returned 401 would recurse back here forever.
        response = await api.post('/oauth/token', formData, {
            baseURL: serverURL(config.server),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: TIMEOUTS.TOKEN_REFRESH_MS,
            _isRefresh: true,
        });
    } catch (error) {
        // Spent by another process meanwhile, which saved the new session.
        const now = sessionOf(holder);
        if (now.refresh_token !== presented && usable(now.token)) return now.token;
        const status = error.response?.status;
        if (status === 400 || status === 401) {
            throw sessionExpired(holder, serverMessage(error.response.data));
        }
        throw refreshFailed(error);
    }

    const { access_token, refresh_token } = response.data;
    const session = {
        token: access_token,
        // A server that does not rotate them answers none: keep ours.
        refresh_token: refresh_token || presented,
    };
    if (!holder) {
        mergeConfig(session);
        return access_token;
    }
    // Saved only over the session it renewed: a login (or a renewal by an
    // older CLI) saved meanwhile wins, and is what the caller gets.
    if (saveRenewedSession(holder, presented, session)) return access_token;
    const now = sessionOf(holder);
    if (usable(now.token)) return now.token;
    throw sessionExpired(holder);
}

/*
 * Signals held while a session is renewed. Every listener of SIGINT,
 * SIGTERM and SIGHUP is set aside while any renewal holds them (a spinner
 * or a prompt that ends the process, one that only restores the terminal),
 * and put back when the last one is done; a signal that arrived meanwhile
 * is then raised again, so they run once, after the save, or the default
 * applies when there are none.
 */
const SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
let signalHolds = 0;
/** @type {NodeJS.Signals | undefined} */
let caughtSignal;
/** @type {Map<string, Function[]>} */
const setAside = new Map();
const holdListener = (/** @type {NodeJS.Signals} */ signal) => {
    caughtSignal ??= signal;
};

/** @returns {() => void} Its release. */
function holdSignals() {
    if (signalHolds++ === 0) {
        for (const signal of SIGNALS) {
            setAside.set(signal, process.rawListeners(signal));
            process.removeAllListeners(signal);
            process.on(signal, holdListener);
        }
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--signalHolds > 0) return;
        for (const signal of SIGNALS) {
            process.removeListener(signal, holdListener);
            for (const listener of setAside.get(signal) ?? []) {
                process.on(signal, /** @type {any} */ (listener));
            }
        }
        setAside.clear();
        const signal = caughtSignal;
        caughtSignal = undefined;
        if (signal) process.kill(process.pid, signal);
    };
}

/*
 * process.exit while a renewal is in flight (an error printed by another
 * request of the same command) waits for it to be saved, up to the
 * renewal's timeout: exiting at once could leave a spent refresh token.
 */
/** @type {typeof process.exit | null} */
let realExit = null;
let exitRequested = false;

function guardExit() {
    if (realExit) return;
    const exit = process.exit;
    realExit = exit;
    process.exit = /** @type {any} */ (
        (code) => {
            // The first exit decides the code; later ones only wait with it.
            if (exitRequested) return;
            exitRequested = true;
            if (code !== undefined) process.exitCode = code;
            const limit = new Promise((resolve) =>
                setTimeout(resolve, TIMEOUTS.TOKEN_REFRESH_MS + 1_000),
            );
            Promise.race([Promise.allSettled([...inFlightRefresh.values()]), limit]).finally(() =>
                exit.call(process, process.exitCode),
            );
        }
    );
}

/** Whether the process is waiting to exit: no new requests start then. */
export function exitPending() {
    return exitRequested;
}

function unguardExit() {
    if (!realExit || inFlightRefresh.size || exitRequested) return;
    process.exit = realExit;
    realExit = null;
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
 * Authenticate with an existing API token. The account it belongs to is
 * read from the token (Thinger's are JWTs naming it): a token of another
 * account than --username is refused, and the username may be left out.
 * The token is kept when the server accepts it, or when it is valid but
 * scoped away from the account's profile (403) and names that account.
 *
 * @returns {Promise<void>}
 */
async function authenticateWithToken(opts) {
    const token =
        opts.token ||
        (await ask(passwordPrompt, {
            message: 'Enter token:',
            mask: '*',
            validate: (input) => (input ? true : 'Token is required'),
        }));
    const owner = tokenOwner(token);
    if (owner && opts.username && owner !== opts.username) {
        throw Object.assign(new Error(`The token is of account ${owner}, not ${opts.username}.`), {
            code: 'input_error',
        });
    }
    const username =
        opts.username ||
        owner ||
        (await ask(input, {
            message: 'Enter username:',
            validate: (input) => (input ? true : 'Username is required'),
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
        // 403: valid, but scoped away from the account's profile. Kept only
        // when the token says it is of that account: a token of another
        // account gets a 403 too.
        if (status === 403 && owner === username) {
            spinner.warn('Token accepted, but it cannot read the user profile (limited scope)');
        } else {
            spinner.fail('Token validation failed');
            if (status === 401) {
                throw Object.assign(new Error('Invalid token', { cause: error }), {
                    code: 'unauthorized',
                });
            }
            if (status === 403) {
                throw Object.assign(
                    new Error(
                        `The token cannot read the profile of ${username}, and does not say whose it is: use a token of ${username} that can.`,
                        { cause: error },
                    ),
                    { code: 'unauthorized' },
                );
            }
            throw error;
        }
    }
    mergeConfig({ username, token });
}

/** The account a Thinger API token names (its `usr` claim), or null. */
function tokenOwner(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return typeof payload.usr === 'string' && payload.usr ? payload.usr : null;
    } catch {
        return null;
    }
}

/**
 * Authenticate with the OAuth device flow, in a terminal: show the code,
 * open the browser on ENTER, and wait for the approval. Needs an OAuth
 * client registered on the server: the identity's own when it has one,
 * otherwise the one the user names (remembered per profile, since
 * refreshing needs it again).
 *
 * @returns {Promise<() => Promise<void>>} What to do once the profile is saved.
 */
async function authenticateWithOAuth(opts, existing) {
    const previous = getProfile(getActiveProfile()) ?? {};
    const client_id =
        opts.clientId ||
        identity().oauth.clientId ||
        (await ask(input, {
            message: 'OAuth client id (registered on the server):',
            default: existing?.oauth_client_id || undefined,
            validate: (input) => (input ? true : 'Client id is required'),
        }));

    const spinner = ora('Requesting OAuth User Code...').start();
    let data;
    try {
        data = await requestDeviceCode(client_id);
        spinner.succeed('OAuth User Code received');
    } catch (error) {
        spinner.fail('OAuth device-code request failed');
        throw error;
    }

    console.log('\nYour one time device code is: ' + label(data.user_code));
    console.log(
        info('Press ' + label('ENTER')) +
            ' to open your browser or submit your device code here: ' +
            data.verification_uri +
            '\n',
    );

    // Checked one at a time, as often as the server allows (RFC 8628: five
    // seconds more after each slow_down), until approved, refused, expired
    // or the ceiling of this CLI. A network error does not end the login.
    const controller = new AbortController();
    /** @type {Record<string, any> | null} */
    let tokens = null;
    let pollError = null;
    let interval = data.interval * 1000;
    const until = Date.now() + Math.min(data.expires_in * 1000, OAUTH_DEVICE_CODE_TIMEOUT_MS);
    let timer;
    const poll = async () => {
        if (controller.signal.aborted) return;
        if (Date.now() >= until) return controller.abort('timeout');
        try {
            const result = await checkDeviceCode(client_id, data.device_code);
            if (result.status === 'approved') {
                tokens = result.tokens;
                return controller.abort('validated');
            }
            if (result.status === 'slow_down') interval += 5000;
            if (result.status === 'denied') {
                pollError = new Error('User denied the authorization request');
                return controller.abort('error');
            }
            if (result.status === 'expired') {
                pollError = new Error('Device code expired');
                return controller.abort('error');
            }
        } catch (error) {
            if (error.code === 'unauthorized' || error.response?.status < 500) {
                pollError = error;
                return controller.abort('error');
            }
        }
        if (!controller.signal.aborted) timer = setTimeout(poll, interval);
    };
    timer = setTimeout(poll, interval);

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
            } else if (error.cause !== 'error') {
                // The prompt ended otherwise (Ctrl+C): stop checking.
                controller.abort('cancelled');
                throw error;
            }
        });
    } finally {
        clearTimeout(timer);
        if (!controller.signal.aborted) controller.abort('done');
    }

    if (pollError) throw pollError;
    if (!tokens) throw new Error('OAuth flow ended without a token');

    const session = oauthSession(tokens, client_id);
    mergeConfig(session);
    console.log(success('OAuth token validation successful\n'));
    return async () => {
        const problem = await revokeReplacedToken(previous, session.username, session.token);
        if (problem) console.log(warning(problem));
    };
}

/**
 * Access token of the active profile, or null when there is none.
 * Silent on purpose: under `mcp` stdout is the protocol channel.
 * @returns {string | null}
 */
export function getAccessToken() {
    return readConfig()?.token || null;
}
