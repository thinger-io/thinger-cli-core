// @ts-check
import api from './api.js';
import { apiError, inputError } from './errors.js';
import { v1 } from './paths.js';

/**
 * Helpers for access tokens — both user-level (broad scope,
 * `allow`/`deny` resource trees) and device-level (narrow, scoped to
 * one device's resources).
 *
 * REST endpoints wrapped here:
 *
 *   User-level
 *   ──────────
 *   GET    /v1/users/{user}/tokens                  → list (no JWT)
 *   POST   /v1/users/{user}/tokens                  → create (returns full doc + JWT)
 *   GET    /v1/users/{user}/tokens/{tokenId}        → read full doc + JWT
 *   PUT    /v1/users/{user}/tokens/{tokenId}        → patch
 *   DELETE /v1/users/{user}/tokens/{tokenId}        → delete
 *
 *   Device-level
 *   ────────────
 *   GET    /v1/users/{user}/devices/{d}/tokens               → list
 *   POST   /v1/users/{user}/devices/{d}/tokens               → create
 *   DELETE /v1/users/{user}/devices/{d}/tokens/{tokenId}     → delete
 *
 * Naming
 * ──────
 * The user-level CREATE_SCHEMA accepts `token` (the id), `name`, `enabled`,
 * `allow`, `deny`, `expire`, `description`. The device-level POST accepts
 * a different field set: `token_name`, `token_resources`, `token_expiration`.
 * See `tokens.cpp` and `devices.cpp` in the backend for the canonical
 * shape. Helpers here keep the two distinct so callers don't get them
 * confused.
 *
 * Permission grammar (user-level only)
 * ────────────────────────────────────
 *   allow / deny: {
 *     "<ResourceType>": { "<id|*>": ["<Action>" | "*"] | "*" }
 *   }
 *
 * Resource types are the platform's resource categories (`Device`,
 * `Bucket`, `Product`, `Endpoint`, `Property`, `Token`, `User`, …) plus
 * `*` (any). The id level can be a literal id or `*` for any. The leaf is
 * either an array of action strings (e.g. `["AccessDeviceResources"]`) or
 * the wildcard string `"*"`.
 *
 * The grammar does NOT scope by *product*; only by resource type + id.
 * To restrict a token to a single product's devices you would have to
 * enumerate the device ids explicitly, or rely on a product-shaped naming
 * convention — see `tokens.cpp:validate_token_permissions` and
 * `tokens.hpp:PERMISSION_DEFINITION`. The MCP descriptions explicitly
 * call this out so callers don't bake in the wrong assumption.
 *
 * JWT visibility
 * ──────────────
 * The list projection on the server omits `access_token`. The full JWT is
 * returned only by the per-token GET (and once on creation). Treat the
 * value as one-shot-readable: persist or hand it off as soon as you fetch
 * it.
 */

// ─── Duration helpers ───────────────────────────────────────────────

const DURATION_RE = /^(\d+)([smhdwy])$/;
const DURATION_MULT = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
    y: 365 * 24 * 60 * 60,
};

/**
 * Convert a relative duration string (e.g. "30d", "12h", "365d") or an
 * absolute unix-seconds timestamp into a unix-seconds expiry. Returns
 * `null` for null/undefined input so callers can pass through "no
 * expiry" without branching.
 */
export function resolveExpiry(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            throw inputError('expiry must be a non-negative number of seconds');
        }
        return Math.floor(value);
    }
    if (typeof value !== 'string') {
        throw inputError('expiry must be a number, a duration string ("30d") or null');
    }
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return Number.parseInt(trimmed, 10);
    }
    const m = DURATION_RE.exec(trimmed);
    if (!m) {
        throw inputError(
            `expiry "${value}" not understood. Use a unix-seconds number or a relative duration like "30d", "12h", "1y".`,
        );
    }
    const n = Number.parseInt(m[1], 10);
    const unit = m[2];
    if (n <= 0) throw inputError('expiry duration must be positive');
    return Math.floor(Date.now() / 1000) + n * DURATION_MULT[unit];
}

/**
 * The expiry of an account token, which the server takes in unix
 * milliseconds (device tokens take seconds: resolveExpiry). A duration
 * ("30d") counts from now; a timestamp is taken as milliseconds, or as
 * seconds when it is too small to be milliseconds (before 2001), as
 * earlier versions of this CLI took it.
 */
export function resolveExpiryMs(value) {
    const resolved = resolveExpiry(value);
    if (resolved === null) return null;
    const duration = typeof value === 'string' && DURATION_RE.test(value.trim());
    return duration || resolved < 1e12 ? resolved * 1000 : resolved;
}

// ─── User-level token validators ────────────────────────────────────

export const TOKEN_ID_RE = /^[a-zA-Z0-9_]{1,50}$/;

function assertValidTokenId(id) {
    if (typeof id !== 'string' || !TOKEN_ID_RE.test(id)) {
        throw inputError(
            'token_id must match /^[a-zA-Z0-9_]{1,50}$/ (letters, digits, underscore, ≤ 50 chars)',
        );
    }
}

/**
 * Client-side mirror of the server-side `validate_token_permissions`
 * check. Catches grammar mistakes before the request leaves the box so
 * callers get a precise error pointing at the offending node.
 */
export function validatePermissionTree(node, label = 'allow') {
    if (node === undefined || node === null) return;
    if (typeof node !== 'object' || Array.isArray(node)) {
        throw inputError(`${label} must be an object keyed by ResourceType`);
    }
    for (const [type, byId] of Object.entries(node)) {
        if (!/^[a-zA-Z0-9_-]{1,32}$|^\*$/.test(type)) {
            throw inputError(
                `${label} contains invalid resource type "${type}" (allowed: A-Z, a-z, 0-9, underscore, dash; up to 32 chars; or "*")`,
            );
        }
        if (typeof byId !== 'object' || Array.isArray(byId) || byId === null) {
            throw inputError(`${label}.${type} must be an object keyed by resource id (or "*")`);
        }
        for (const [id, actions] of Object.entries(byId)) {
            if (!/^[a-zA-Z0-9_]{1,32}(?:@[a-zA-Z0-9_]{1,32})?$|^\*$/.test(id)) {
                throw inputError(
                    `${label}.${type}.${id} is not a valid resource id (letters, digits, underscore, optional @suffix, ≤ 32 chars; or "*")`,
                );
            }
            if (typeof actions === 'string') {
                if (!/^[a-zA-Z0-9_*]{1,64}$/.test(actions) && actions !== '*') {
                    throw inputError(
                        `${label}.${type}.${id} action "${actions}" is not a valid action name`,
                    );
                }
            } else if (Array.isArray(actions)) {
                for (const action of actions) {
                    if (typeof action === 'string') {
                        if (!/^[a-zA-Z0-9_*]{1,64}$/.test(action) && action !== '*') {
                            throw inputError(
                                `${label}.${type}.${id}: action "${action}" is not a valid action name`,
                            );
                        }
                    } else if (typeof action === 'object' && action !== null) {
                        // nested object form — minimal shape check.
                        for (const k of Object.keys(action)) {
                            if (!/^[a-zA-Z0-9_-]{1,32}$/.test(k)) {
                                throw inputError(
                                    `${label}.${type}.${id}: nested action key "${k}" is invalid`,
                                );
                            }
                        }
                    } else {
                        throw inputError(
                            `${label}.${type}.${id}: actions must be strings or nested objects`,
                        );
                    }
                }
            } else {
                throw inputError(
                    `${label}.${type}.${id} must be an array of action strings or the wildcard "*"`,
                );
            }
        }
    }
}

// ─── User-level tokens ──────────────────────────────────────────────

export async function listTokens(user) {
    try {
        const res = await api.get(`${v1(user)}/tokens`);
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
        throw apiError(e);
    }
}

export async function getToken(tokenId, user) {
    assertValidTokenId(tokenId);
    try {
        const res = await api.get(`${v1(user)}/tokens/${tokenId}`);
        return res.data || {};
    } catch (e) {
        throw apiError(e, { notFound: `Token not found: ${tokenId}` });
    }
}

/**
 * Create a user-level token. Returns the persisted document, including
 * the freshly-issued JWT under `access_token` (only ever returned on
 * create and on per-token GET — list responses strip it).
 *
 * @param {{
 *   token: string,
 *   name: string,
 *   allow: Record<string, Record<string, string[] | string>>,
 *   deny?: Record<string, Record<string, string[] | string>>,
 *   description?: string,
 *   expire?: number | string | null,
 *   enabled?: boolean,
 * }} body
 */
export async function createToken(body, user) {
    if (!body || typeof body !== 'object') throw inputError('token body is required');
    assertValidTokenId(body.token);
    if (!body.name || typeof body.name !== 'string') {
        throw inputError('token name is required');
    }
    if (!body.allow || typeof body.allow !== 'object') {
        throw inputError(
            'token allow is required (top-level: ResourceType strings; second-level: ids/"*"; leaves: arrays of action strings or "*")',
        );
    }
    validatePermissionTree(body.allow, 'allow');
    validatePermissionTree(body.deny, 'deny');

    const payload = {
        token: body.token,
        name: body.name,
        enabled: body.enabled === undefined ? true : !!body.enabled,
        allow: body.allow,
    };
    if (body.deny) payload.deny = body.deny;
    if (body.description !== undefined) payload.description = String(body.description);
    const expire = resolveExpiryMs(body.expire);
    if (expire !== null && expire !== undefined) payload.expire = expire;

    try {
        const res = await api.post(`${v1(user)}/tokens`, payload);
        return res.data;
    } catch (e) {
        throw apiError(e);
    }
}

/**
 * Patch a token. Only the fields accepted by the server's UPDATE_SCHEMA
 * (name, description, expire, enabled, allow, deny) are propagated.
 */
export async function updateToken(tokenId, patch, user) {
    assertValidTokenId(tokenId);
    if (!patch || typeof patch !== 'object') throw inputError('patch is required');

    const body = {};
    if (patch.name !== undefined) body.name = String(patch.name);
    if (patch.description !== undefined) body.description = String(patch.description);
    if (patch.enabled !== undefined) body.enabled = !!patch.enabled;
    if (patch.expire !== undefined) {
        const expire = resolveExpiryMs(patch.expire);
        if (expire !== null && expire !== undefined) body.expire = expire;
    }
    if (patch.allow !== undefined) {
        validatePermissionTree(patch.allow, 'allow');
        body.allow = patch.allow;
    }
    if (patch.deny !== undefined) {
        validatePermissionTree(patch.deny, 'deny');
        body.deny = patch.deny;
    }

    if (Object.keys(body).length === 0) {
        throw inputError(
            'patch must set at least one of: name, description, enabled, expire, allow, deny',
        );
    }

    try {
        const res = await api.put(`${v1(user)}/tokens/${tokenId}`, body);
        return res.data;
    } catch (e) {
        throw apiError(e, { notFound: `Token not found: ${tokenId}` });
    }
}

export async function deleteToken(tokenId, user) {
    assertValidTokenId(tokenId);
    try {
        await api.delete(`${v1(user)}/tokens/${tokenId}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

// ─── Device-level tokens ────────────────────────────────────────────

export async function listDeviceTokens(deviceId, user) {
    if (!deviceId) throw inputError('device is required');
    try {
        const res = await api.get(`${v1(user)}/devices/${deviceId}/tokens`);
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
        throw apiError(e, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Create a device-scoped token. Server-side payload shape (different from
 * user-level tokens):
 *
 *   { token_name, token_resources?, token_expiration? }
 *
 * `token_resources` omitted ⇒ all resources of the device.
 * `token_expiration` omitted ⇒ no expiry.
 */
export async function createDeviceToken(deviceId, body, user) {
    if (!deviceId) throw inputError('device is required');
    if (!body || typeof body !== 'object') throw inputError('token body is required');
    if (!body.token_name || typeof body.token_name !== 'string') {
        throw inputError('token_name is required');
    }
    const payload = { token_name: body.token_name };
    if (body.token_resources !== undefined) {
        if (!Array.isArray(body.token_resources)) {
            throw inputError('token_resources must be an array of resource names');
        }
        for (const r of body.token_resources) {
            if (typeof r !== 'string' || !r) {
                throw inputError('token_resources entries must be non-empty strings');
            }
        }
        payload.token_resources = body.token_resources;
    }
    const expiration = resolveExpiry(body.token_expiration);
    if (expiration !== null && expiration !== undefined) {
        payload.token_expiration = expiration;
    }

    try {
        const res = await api.post(`${v1(user)}/devices/${deviceId}/tokens`, payload);
        return res.data;
    } catch (e) {
        throw apiError(e, { notFound: `Device not found: ${deviceId}` });
    }
}

export async function deleteDeviceToken(deviceId, tokenId, user) {
    if (!deviceId) throw inputError('device is required');
    if (!tokenId) throw inputError('token_id is required');
    try {
        await api.delete(`${v1(user)}/devices/${deviceId}/tokens/${tokenId}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}
