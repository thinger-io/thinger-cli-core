// @ts-check
import api from './api.js';
import { resolveUser } from './config.js';
import { TIMEOUTS } from './constants.js';
import { apiError, inputError } from './errors.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The path of a raw API call, with `{user}` replaced by the account (the
 * profile's, or `user`). Only paths on the profile's server: a full URL
 * would send its token to another host.
 *
 * @param {string} path
 * @param {string | null} [user]
 */
export function apiPath(path, user) {
    const p = String(path ?? '').trim();
    if (!p.startsWith('/') || p.startsWith('//')) {
        throw inputError(`the path must start with "/" (e.g. /v1/users/{user}/devices): ${p}`);
    }
    // eslint-disable-next-line no-control-regex -- control characters are what it looks for
    if (/[\x00-\x1f\s]/.test(p))
        throw inputError('the path cannot hold spaces or control characters');
    return p.includes('{user}') ? p.replaceAll('{user}', encodeURIComponent(resolveUser(user))) : p;
}

/**
 * Method of a raw call: the one given, else POST when it carries a body
 * and GET otherwise (as `gh api` does).
 *
 * @param {string | undefined} method
 * @param {boolean} hasBody
 */
export function apiMethod(method, hasBody) {
    const m = (method || (hasBody ? 'POST' : 'GET')).toUpperCase();
    if (!METHODS.has(m))
        throw inputError(`unknown method ${method}: use ${[...METHODS].join(', ')}`);
    return m;
}

/**
 * The answer's body as the caller should see it: parsed JSON, text, or the
 * raw bytes when it is neither.
 *
 * @param {Buffer} data
 * @param {string} [contentType]
 * @returns {{ kind: 'json' | 'text' | 'binary' | 'empty', body: any }}
 */
export function decodeBody(data, contentType = '') {
    if (!data || !data.length) return { kind: 'empty', body: null };
    const type = contentType.toLowerCase();
    const textual =
        type.includes('json') || type.startsWith('text/') || type.includes('xml') || !type;
    if (!textual) return { kind: 'binary', body: data };
    const text = data.toString('utf8');
    if (type.includes('json') || !type) {
        try {
            return { kind: 'json', body: JSON.parse(text) };
        } catch {
            // Streamed answers (one JSON object per line) and plain text.
        }
    }
    // Without a content type, bytes that are not text stay bytes.
    if (!type && text.includes('�')) return { kind: 'binary', body: data };
    return { kind: 'text', body: text };
}

/**
 * Send a request to the profile's server as is: the escape hatch for what
 * no command covers.
 *
 * @param {{
 *   method?: string,
 *   path: string,
 *   query?: Record<string, any>,
 *   body?: any,
 *   user?: string | null,
 *   timeout?: number,
 * }} opts
 */
export async function rawApiCall({ method, path, query, body, user, timeout }) {
    const url = apiPath(path, user);
    const m = apiMethod(method, body !== undefined);
    try {
        const res = await api.request({
            method: m,
            url,
            params: query,
            data: body,
            responseType: 'arraybuffer',
            timeout: timeout ?? TIMEOUTS.API_LONG_MS,
            // Plain bodies (a string) go as text; objects as JSON.
            headers: typeof body === 'string' ? { 'Content-Type': 'text/plain' } : undefined,
        });
        const raw = Buffer.from(res.data);
        const decoded = decodeBody(raw, String(res.headers['content-type'] || ''));
        // `raw`: the bytes as they came, for files (decoding is for showing).
        return { status: res.status, contentType: res.headers['content-type'], ...decoded, raw };
    } catch (e) {
        // The error body arrives as bytes too: decode it so its message shows.
        if (e?.response?.data instanceof ArrayBuffer || Buffer.isBuffer(e?.response?.data)) {
            const { body: errBody } = decodeBody(
                Buffer.from(e.response.data),
                String(e.response.headers?.['content-type'] || ''),
            );
            e.response.data = errBody;
        }
        throw apiError(e, { notFound: `Not found: ${m} ${url}` });
    }
}
