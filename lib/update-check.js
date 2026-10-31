// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './config.js';
import { compareVersions } from './dashboard-sdk.js';
import { env, identity } from './identity.js';

/**
 * Whether a newer release of the CLI is on npm, so the CLI and its MCP
 * server can tell the user (and the agent) to update. The answer of the
 * registry is kept for a day in the cache folder; everything here is
 * advice: what cannot be read gives no notice.
 */

const REGISTRY = 'https://registry.npmjs.org';
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;
const CACHE_FILE = 'latest-version.json';

/**
 * Off without an npm package to ask about, in CI and tests, and when the
 * user turns it off (`<PREFIX>_NO_UPDATE_CHECK=1` or the common
 * `NO_UPDATE_NOTIFIER`).
 */
export function updateCheckEnabled() {
    if (!identity().npmPackage) return false;
    const off = (v) => v !== undefined && v !== '' && !/^(0|false|no)$/i.test(v);
    return !(
        off(env('NO_UPDATE_CHECK')) ||
        off(process.env.NO_UPDATE_NOTIFIER) ||
        off(process.env.CI) ||
        process.env.NODE_TEST_CONTEXT
    );
}

function cachePath() {
    return path.join(cacheDir(), CACHE_FILE);
}

/** The latest version the cache knows, and whether it is less than a day old. */
export function cachedLatest() {
    try {
        const { latest, checkedAt } = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
        if (typeof latest !== 'string') return {};
        return { latest, fresh: Date.now() - Number(checkedAt) < DAY_MS };
    } catch {
        return {};
    }
}

/**
 * The latest version on npm: from the cache when it is fresh, otherwise
 * asked to the registry (and cached). Undefined when it cannot be known.
 *
 * @returns {Promise<string | undefined>}
 */
export async function latestVersion() {
    if (!updateCheckEnabled()) return undefined;
    const cached = cachedLatest();
    if (cached.fresh) return cached.latest;
    try {
        const res = await fetch(`${REGISTRY}/${identity().npmPackage}/latest`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return cached.latest;
        const { version } = /** @type {{ version?: unknown }} */ (await res.json());
        if (typeof version !== 'string') return cached.latest;
        fs.writeFileSync(cachePath(), JSON.stringify({ latest: version, checkedAt: Date.now() }));
        return version;
    } catch {
        return cached.latest;
    }
}

/**
 * The line that tells the user a newer release is out, or undefined when
 * `version` is the latest (or newer: a development build).
 *
 * @param {string} version  The running CLI's.
 * @param {string | undefined} latest
 */
export function updateNotice(version, latest) {
    if (!latest || !version || version === 'unknown') return undefined;
    if (compareVersions(latest, version) <= 0) return undefined;
    const { name, npmPackage } = identity();
    return `${name} ${latest} is available (this is ${version}). Update with: npm i -g ${npmPackage}`;
}
