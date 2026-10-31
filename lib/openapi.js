// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import api from './api.js';
import { cacheDir, readConfig, serverURL } from './config.js';

/**
 * The server's own description of its API.
 *
 * Every Thinger server publishes its OpenAPI document without a token at
 * `/v1/server/swagger.json`, and its version at `/v1/server/version`. The
 * document is what `resource_describe` reads the request schemas and
 * examples from, so they always match the server the profile points at
 * rather than whichever version this package was built against.
 *
 * It is cached per server and version: in memory for the life of the
 * process and on disk under the CLI's cache folder, so a new MCP session
 * costs one small version request instead of a 300 KB download. A server
 * with the document disabled (`deployment.disable_swagger`) falls back to
 * the copy bundled with this package, flagged as such.
 */

const BUNDLED_FILE = new URL('../openapi/swagger.json', import.meta.url);
/** Server version the bundled copy was taken from. */
export const BUNDLED_VERSION = 'develop 2026-10-11 (98)';

/** @type {Map<string, Promise<Spec>>} */
const memory = new Map();

/**
 * @typedef {object} Spec
 * @property {any} doc            The OpenAPI document, or null when none is available.
 * @property {string} source      Where it came from: "server 7.2.4-beta", "bundled copy (…)".
 */

/** The bundled OpenAPI document (also the fixture the tests check the catalog against). */
export function bundledSpec() {
    return JSON.parse(fs.readFileSync(BUNDLED_FILE, 'utf8'));
}

/**
 * OpenAPI document of the active profile's server.
 *
 * @returns {Promise<Spec>}
 */
export async function serverSpec() {
    const base = serverURL(readConfig().server) || '';
    let version = 'unknown';
    try {
        const res = await api.get('/v1/server/version');
        version = String(res.data?.version || 'unknown');
    } catch {
        // An unreachable server fails the real request soon enough; the
        // description can still come from the bundled copy.
    }
    const key = `${base}@${version}`;
    if (!memory.has(key)) {
        const pending = loadSpec(base, version);
        // A failed load must not stick: the next call tries again.
        pending.catch(() => memory.delete(key));
        memory.set(key, pending);
    }
    return memory.get(key);
}

async function loadSpec(base, version) {
    const file = path.join(cacheDir(), `openapi-${slug(base)}-${slug(version)}.json`);
    if (version !== 'unknown') {
        try {
            return { doc: JSON.parse(fs.readFileSync(file, 'utf8')), source: `server ${version}` };
        } catch {
            // Not cached yet (or unreadable): fetch it.
        }
    }
    try {
        const res = await api.get('/v1/server/swagger.json');
        if (res.data && typeof res.data === 'object' && res.data.paths) {
            if (version !== 'unknown') {
                try {
                    fs.writeFileSync(file, JSON.stringify(res.data));
                } catch {
                    // A read-only home only costs the next session a download.
                }
            }
            return { doc: res.data, source: `server ${version}` };
        }
    } catch {
        // Disabled or unreachable: fall through to the bundled copy.
    }
    return {
        doc: bundledSpec(),
        source: `bundled copy (server ${BUNDLED_VERSION}; this server, ${version}, does not publish its own)`,
    };
}

function slug(text) {
    return String(text)
        .replace(/^[a-z]+:\/\//i, '')
        .replace(/[^a-zA-Z0-9.-]+/g, '_');
}

/**
 * Find the operation a method and path template refer to. Ids in the
 * template are written `{}`; a server path parameter matches any segment,
 * and the path with the most literal matches wins, so `profile/code`
 * finds its own entry instead of `profile/{category}`.
 *
 * @param {any} doc
 * @param {string} method
 * @param {string} template
 * @returns {{ path: string, operation: any } | null}
 */
export function findOperation(doc, method, template) {
    const want = template.split('/');
    let best = null;
    let bestScore = -1;
    for (const [p, item] of Object.entries(doc?.paths || {})) {
        const have = p.split('/');
        if (have.length !== want.length || !item[method]) continue;
        let score = 0;
        let ok = true;
        for (let i = 0; i < have.length; i++) {
            const param = have[i].startsWith('{');
            if (param) continue;
            if (have[i] !== want[i]) {
                ok = false;
                break;
            }
            score++;
        }
        if (ok && score > bestScore) {
            best = { path: p, operation: item[method] };
            bestScore = score;
        }
    }
    return best;
}

/**
 * Find an operation by its operationId (the core's types name the
 * operations they run, not their paths).
 *
 * @param {any} doc
 * @param {string} operationId
 * @returns {any} The operation, or null.
 */
export function findOperationById(doc, operationId) {
    for (const item of Object.values(doc?.paths || {})) {
        for (const operation of Object.values(item || {})) {
            if (operation?.operationId === operationId) return operation;
        }
    }
    return null;
}

const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);

const VERBOSE = new Set(['description', 'example', 'examples', 'title']);

/**
 * Copy of `node` with every local `$ref` replaced by what it points to.
 * A schema that refers to itself is cut at the second visit.
 *
 * @param {any} doc
 * @param {any} node
 */
export function resolveRefs(doc, node, seen = new Set()) {
    if (Array.isArray(node)) return node.map((n) => resolveRefs(doc, n, seen));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        if (seen.has(node.$ref)) return { description: `(recursive: ${node.$ref})` };
        const target = node.$ref
            .slice(2)
            .split('/')
            .reduce((n, key) => n?.[key], doc);
        // A shared scalar (resource_id, resource_name…) appears once per
        // field that uses it: its constraints say all there is to say, the
        // prose and examples repeated on every field would only bury them.
        if (target && typeof target === 'object' && SCALARS.has(target.type)) {
            return Object.fromEntries(Object.entries(target).filter(([key]) => !VERBOSE.has(key)));
        }
        return resolveRefs(doc, target, new Set([...seen, node.$ref]));
    }
    return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, resolveRefs(doc, value, seen)]),
    );
}
