// @ts-check
import { Buffer } from 'node:buffer';
import api from './api.js';
import {
    credentialsProfile,
    getPendingLogin,
    getProfile,
    mergeConfig,
    setDefaultProfile,
    setPendingLogin,
    withActiveProfile,
    withDraftProfile,
    withLoginLock,
    withStagedProfile,
} from './config.js';
import { apiError } from './errors.js';
import { identity, loginHint } from './identity.js';
import { v1 } from './paths.js';

/**
 * The browser login (OAuth 2.0 device authorization grant, RFC 8628),
 * in the pieces both ways of signing in use:
 * - in a terminal, `login --oauth` asks for a code, shows it and waits
 *   (auth.js);
 * - without one (agents, scripts, the MCP server), the login is started
 *   (`startDeviceLogin`: the URL and code to approve, recorded as the
 *   profile's pending login) and finished later (`checkDeviceLogin` once,
 *   `waitDeviceLogin` until it ends), possibly from another process.
 * Nothing is saved in the profile until the account approves: a login
 * never approved leaves it as it was.
 *
 * Only the browser login works this way. Passwords and tokens are never
 * taken without a terminal from anything but the command line flags the
 * user typed.
 */

const FORM = { headers: { 'content-type': 'application/x-www-form-urlencoded' } };
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Ask the server for a device code. Runs within the profile being signed
 * in (its server, no session).
 *
 * @param {string} clientId
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, verification_uri_complete: string, interval: number, expires_in: number }>}
 */
export async function requestDeviceCode(clientId) {
    try {
        const { data } = await api.post('/oauth/device/authorize', { client_id: clientId }, FORM);
        return {
            ...data,
            verification_uri_complete:
                data.verification_uri_complete ||
                `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`,
            interval: Number(data.interval) > 0 ? Number(data.interval) : 5,
            expires_in: Number(data.expires_in) > 0 ? Number(data.expires_in) : 600,
        };
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 404) {
            throw Object.assign(
                new Error(
                    `The server does not know the OAuth client ${clientId} (Thinger 7.5.0 and later have it built in). Sign in with a token or username and password instead.`,
                ),
                { code: 'oauth_client_unknown' },
            );
        }
        throw error;
    }
}

/**
 * One check of a device code with the server.
 *
 * @param {string} clientId
 * @param {string} deviceCode
 * @returns {Promise<{ status: 'approved', tokens: Record<string, any> } | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }>}
 */
export async function checkDeviceCode(clientId, deviceCode) {
    try {
        const { data } = await api.post(
            '/oauth/token',
            { grant_type: DEVICE_GRANT, client_id: clientId, device_code: deviceCode },
            FORM,
        );
        if (!data?.access_token) throw new Error('The server approved the login without a token');
        return { status: 'approved', tokens: data };
    } catch (error) {
        const code = error.response?.status === 400 ? error.response.data?.error : undefined;
        if (code === 'authorization_pending') return { status: 'pending' };
        if (code === 'slow_down') return { status: 'slow_down' };
        if (code === 'access_denied') return { status: 'denied' };
        if (code === 'expired_token') return { status: 'expired' };
        if (code) {
            throw Object.assign(new Error(`OAuth error: ${code}`, { cause: error }), {
                code: 'unauthorized',
            });
        }
        throw error;
    }
}

/** The account a session's access token is of. */
export function sessionUser(accessToken) {
    try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
        if (typeof payload.usr === 'string' && payload.usr) return payload.usr;
    } catch {
        // Falls through.
    }
    throw new Error('The server answered a session without its account');
}

/**
 * The fields a browser login saves in its profile.
 *
 * @param {Record<string, any>} tokens  What /oauth/token answered.
 * @param {string} clientId
 */
export function oauthSession(tokens, clientId) {
    return {
        username: sessionUser(tokens.access_token),
        token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        oauth_client_id: clientId,
    };
}

/**
 * Revoke the API token a password login of this CLI minted for the
 * profile before (`previous`), now that a new session of the same account
 * is saved: it would stay valid on the server, unused and forgotten.
 *
 * @param {Record<string, any>} previous  The profile as it was.
 * @param {string} username  The account signed in now.
 * @param {string} token     Its new session or token.
 * @param {string} [keep]    The token id saved now, if any.
 * @returns {Promise<string | null>} A warning, when it could not be revoked.
 */
export async function revokeReplacedToken(previous, username, token, keep) {
    const old = previous?.token_id;
    if (!old || previous.username !== username || old === keep) return null;
    try {
        await api.delete(`${v1(username)}/tokens/${old}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    } catch (error) {
        if (error.response?.status !== 404) {
            return `Could not revoke the previous API token ${old}: ${apiError(error).message}`;
        }
    }
    return null;
}

/**
 * @typedef {object} LoginState
 * @property {string} profile
 * @property {'pending' | 'approved' | 'denied' | 'expired' | 'none'} status
 * @property {string} [server]
 * @property {string} [url]        Where the account approves it, the code filled in.
 * @property {string} [code]       The code to check there.
 * @property {string} [expires_at] ISO time: no good after it.
 * @property {string} [username]   The account signed in, once approved.
 * @property {number} [retry_after] Seconds before the server takes another check.
 * @property {string} [warning]
 */

/** @returns {LoginState} */
function stateOf(name, p, extra = {}) {
    if (!p) return { profile: name, status: 'none' };
    return {
        profile: name,
        status: p.status,
        server: p.server,
        ...(p.status === 'pending' && {
            url: p.verification_uri_complete,
            code: p.user_code,
            expires_at: new Date(p.expires_at).toISOString(),
        }),
        ...(p.username && { username: p.username }),
        ...extra,
    };
}

/** A profile that acts as another account has no sign-in of its own. */
function refuseLinked(name) {
    const holder = credentialsProfile(name);
    if (holder && holder !== name) {
        throw Object.assign(
            new Error(
                `Profile ${name} uses the session of profile ${holder}: sign that one in. ${loginHint(holder)}`,
            ),
            { code: 'input_error' },
        );
    }
}

/**
 * Start a browser login of profile `name` and record it as pending: the
 * account approves it at the URL answered, and checkDeviceLogin (or
 * waitDeviceLogin) saves the session then.
 *
 * @param {string} name
 * @param {{ server?: string, clientId?: string, description?: string, activate?: boolean, create?: boolean }} opts
 *   `create`: the profile must not exist yet (profile add).
 * @returns {Promise<LoginState>}
 */
export async function startDeviceLogin(name, opts = {}) {
    if (!name)
        throw Object.assign(new Error('Name the profile to sign in.'), { code: 'input_error' });
    const existing = getProfile(name);
    if (opts.create && existing) {
        throw Object.assign(new Error(`Profile already exists: ${name}`), {
            code: 'already_exists',
        });
    }
    refuseLinked(name);
    const server = opts.server || existing?.server;
    if (!server) {
        throw Object.assign(new Error(`Profile ${name} does not exist yet: pass its server.`), {
            code: 'input_error',
        });
    }
    const clientId = opts.clientId || identity().oauth.clientId || existing?.oauth_client_id;
    if (!clientId) {
        throw Object.assign(
            new Error(
                'This CLI has no OAuth client of its own: pass the client id registered on the server.',
            ),
            { code: 'input_error' },
        );
    }
    const data = await withDraftProfile(name, { server }, () => requestDeviceCode(clientId));
    /** @type {import('./config.js').PendingLogin} */
    const pending = {
        server,
        client_id: clientId,
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete,
        interval: data.interval,
        expires_at: Date.now() + data.expires_in * 1000,
        status: 'pending',
        ...(opts.description && { description: opts.description }),
        ...(opts.activate !== undefined && { activate: opts.activate }),
    };
    setPendingLogin(name, pending);
    return stateOf(name, pending);
}

/**
 * Check the pending login of `name` once: it saves the session when the
 * account has approved it. A check sooner than the server allows is not
 * sent (retry_after says when). Approved, denied or expired, the answer
 * stays for whoever asks next.
 *
 * @param {string} name
 * @returns {Promise<LoginState>}
 */
export async function checkDeviceLogin(name) {
    return withLoginLock(name, async () => {
        const p = getPendingLogin(name);
        if (!p || p.status !== 'pending') return stateOf(name, p);
        const now = Date.now();
        if (now >= p.expires_at) {
            setPendingLogin(name, { ...p, status: 'expired' });
            return stateOf(name, { ...p, status: 'expired' });
        }
        const wait = (p.last_check ?? 0) + p.interval * 1000 - now;
        if (wait > 0) return stateOf(name, p, { retry_after: Math.ceil(wait / 1000) });
        setPendingLogin(name, { ...p, last_check: now });
        let result;
        try {
            result = await withDraftProfile(name, { server: p.server }, () =>
                checkDeviceCode(p.client_id, p.device_code),
            );
        } catch (error) {
            // The server could not be reached or failed: still pending, ask again.
            if (error.code !== 'unauthorized' && !(error.response?.status < 500)) {
                return stateOf(name, p, {
                    retry_after: p.interval,
                    warning: `Could not reach ${p.server}: ${apiError(error).message}`,
                });
            }
            throw error;
        }
        if (result.status === 'pending') return stateOf(name, p, { retry_after: p.interval });
        if (result.status === 'slow_down') {
            // RFC 8628: five seconds more between checks from now on.
            const slower = { ...p, last_check: now, interval: p.interval + 5 };
            setPendingLogin(name, slower);
            return stateOf(name, slower, { retry_after: slower.interval });
        }
        if (result.status !== 'approved') {
            setPendingLogin(name, { ...p, status: result.status });
            return stateOf(name, { ...p, status: result.status });
        }
        const warning = await saveDeviceLogin(name, p, result.tokens);
        const done = {
            ...p,
            status: /** @type {const} */ ('approved'),
            username: sessionUser(result.tokens.access_token),
        };
        setPendingLogin(name, done);
        return stateOf(name, done, warning ? { warning } : {});
    });
}

/** Save the session of an approved login in its profile. */
async function saveDeviceLogin(name, p, tokens) {
    // Checked again: the profile may have been linked meanwhile.
    refuseLinked(name);
    const previous = getProfile(name) ?? {};
    const description = previous.description ?? p.description;
    const session = oauthSession(tokens, p.client_id);
    await withStagedProfile(
        name,
        { server: p.server, ...(description && { description }) },
        async () => mergeConfig(session),
    );
    if (p.activate) setDefaultProfile(name);
    // Within the profile signed in: its server, whatever the default is.
    return withActiveProfile(name, () =>
        revokeReplacedToken(previous, session.username, session.token),
    );
}

/**
 * Check the pending login of `name` until it ends or `timeoutMs` passes
 * (0: check once).
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, onWait?: (state: LoginState) => void }} [opts]
 * @returns {Promise<LoginState>}
 */
export async function waitDeviceLogin(name, { timeoutMs, onWait } = {}) {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
        const state = await checkDeviceLogin(name);
        if (state.status !== 'pending') return state;
        let delay = (state.retry_after ?? 5) * 1000;
        // Checked again right after the code expires, to say so.
        if (state.expires_at)
            delay = Math.min(delay, Math.max(0, Date.parse(state.expires_at) - Date.now()) + 50);
        if (Date.now() + delay > deadline) return state;
        onWait?.(state);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}
