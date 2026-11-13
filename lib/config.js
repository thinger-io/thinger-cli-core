import fs from 'fs';
import path from 'path';
import os from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { TIMEOUTS } from './constants.js';
import { withFileLock, withFileLockSync } from './file-lock.js';
import { env, identity, loginHint } from './identity.js';

/**
 * Profile-based configuration store.
 *
 * On disk the config file looks like:
 *   {
 *     "default": "<profile-name>",
 *     "profiles": {
 *       "<profile-name>": { server, username, token, refresh_token, ... }
 *     }
 *   }
 *
 * Profile names default to the server hostname so login against a new
 * server automatically creates an isolated profile.
 *
 * Legacy single-profile files (top-level server/username/token) are
 * detected on read and migrated to the new layout transparently. The
 * migration uses the legacy `server` field as the profile name.
 *
 * The "active" profile is the one all helpers operate on. It is picked
 * (in order): a profile scoped with withActiveProfile(), the override set
 * with setActiveProfile(), the <PREFIX>_PROFILE environment variable, the
 * file's `default` field.
 *
 * The folder and the variable prefix come from the CLI identity, so each
 * CLI keeps its own profiles and never operates on another's servers.
 *
 * A profile can take its server and credentials from another one and act
 * as another account (admin impersonation), so an agent picks the account
 * with --profile and knows nothing of how it is reached:
 *
 *   "monitoring": { "credentials_from": "acme.io", "impersonate": "monitoring" }
 *
 * Read through readConfig it looks like any profile, with `username` the
 * account it acts as (what API paths use; --user still overrides it) and
 * `credentials_user` the account whose session it uses. The tokens live
 * only in the profile that holds the credentials: renewals are saved
 * there, and serialized per credentials (see withRefreshLock), so a
 * profile and those that take its credentials never spend one another's
 * refresh token. One level only: the credentials profile holds its own.
 */

let activeProfileOverride = null;

// Profile scoped to one async call chain. The MCP server serves tool calls
// concurrently, each possibly against a different profile: a process-wide
// switch would let one call's requests leak into another's server.
const scopedProfile = new AsyncLocalStorage();

// A profile being signed in: held in memory until the login completes (see
// withStagedProfile), so the saved one stays as it was until then.
/** @type {AsyncLocalStorage<{ name: string, profile: Record<string, any> }>} */
const stagedProfile = new AsyncLocalStorage();

/**
 * Resolve the on-disk config path, creating the parent directory on
 * first access. Internal — every consumer goes through readStore /
 * writeStore so they never have to know the location.
 */
function getConfigPath() {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', identity().configDir);

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    ownerOnly(configDir, 0o700);
    const configPath = path.join(configDir, 'config.json');
    if (fs.existsSync(configPath)) ownerOnly(configPath, 0o600);
    return configPath;
}

/**
 * Folder for data the CLI can always rebuild (server API descriptions…),
 * next to the profiles. Created on first access.
 */
export function cacheDir() {
    const dir = path.join(os.homedir(), '.config', identity().configDir, 'cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function emptyStore() {
    return { default: null, profiles: {} };
}

function readStore() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return emptyStore();
    const text = fs.readFileSync(configPath, 'utf8');
    if (!text.trim()) return emptyStore();
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        // Read as empty, the next write would erase every profile in it.
        const err = new Error(
            `The profiles file ${configPath} is not valid JSON: fix it, or remove it to start over.`,
        );
        err.code = 'not_configured';
        throw err;
    }

    // Legacy format: top-level {server, username, token, ...}. Migrate to
    // a profile keyed by the server hostname.
    if (raw && typeof raw === 'object' && !raw.profiles && raw.server) {
        const name = String(raw.server);
        return { default: name, profiles: { [name]: { ...raw } } };
    }

    if (!raw || typeof raw !== 'object' || !raw.profiles) return emptyStore();
    return raw;
}

/**
 * Take group and other permissions away from a file or folder made by an
 * older version (or by hand): `mode` on create does not fix existing ones.
 */
function ownerOnly(file, mode) {
    try {
        if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, mode);
    } catch {
        // Not ours to fix (another owner, a filesystem without modes).
    }
}

function writeStore(store) {
    const configPath = getConfigPath();
    // The file holds API tokens: readable by its owner only. Written aside
    // and renamed, so a crash or a concurrent reader never sees half a file,
    // and the rename leaves the new file's mode on the path.
    const tmp = `${configPath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    ownerOnly(tmp, 0o600);
    fs.renameSync(tmp, configPath);
}

/** How long a config write may hold its lock, and waits for it. */
const CONFIG_LOCK = { staleMs: 5_000, waitMs: 10_000 };
let configLockDepth = 0;

/**
 * Read the profiles, let `fn` change them and save them, holding the
 * config lock: every process of the CLI writes the whole file, so without
 * it a write made by another process between this one's read and write
 * (a renewed session, another profile, the default) would be undone.
 * Reentrant within the process.
 *
 * @template T
 * @param {(store: { default: string | null, profiles: Record<string, any> }) => T} fn
 * @returns {T}
 */
function mutateStore(fn) {
    const run = () => {
        const store = readStore();
        const result = fn(store);
        writeStore(store);
        return result;
    };
    if (configLockDepth) return run();
    const lock = `${getConfigPath()}.lock`;
    return withFileLockSync(
        lock,
        () => {
            configLockDepth++;
            try {
                return run();
            } finally {
                configLockDepth--;
            }
        },
        CONFIG_LOCK,
    );
}

/**
 * Run `fn` holding the refresh lock of a set of credentials (the profile
 * that holds them), shared by every process of this CLI on the machine.
 * The server rotates the refresh token on each use, so two processes
 * renewing the same session at once make one of them present a token the
 * other has already spent; with the lock the second waits and then finds
 * the renewed session saved by the first. See file-lock.js.
 *
 * @template T
 * @param {string | null} profile
 * @param {() => Promise<T>} fn
 * @param {{ staleMs: number }} options
 * @returns {Promise<T>}
 */
export async function withRefreshLock(profile, fn, { staleMs }) {
    return withFileLock(refreshLockPath(profile), fn, { staleMs, waitMs: staleMs + 5_000 });
}

/** @param {string | null} profile */
export function refreshLockPath(profile) {
    const name = String(profile ?? 'default');
    // Readable, and distinct for names that differ only in what is replaced.
    const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
    const safe = `${name.replace(/[^\w.-]/g, '_')}-${hash}`;
    return path.join(path.dirname(getConfigPath()), `refresh-${safe}.lock`);
}

/**
 * Override the active profile for the current process. Pass null to fall
 * back to env var / file default. Used by the CLI entry point when the
 * user passes --profile.
 */
export function setActiveProfile(name) {
    activeProfileOverride = name || null;
}

/**
 * Resolve the active profile name, or null if no profile exists.
 */
export function getActiveProfile() {
    const staged = stagedProfile.getStore();
    if (staged) return staged.name;
    const scoped = scopedProfile.getStore();
    if (scoped) return scoped;
    if (activeProfileOverride) return activeProfileOverride;
    if (env('PROFILE')) return env('PROFILE');
    // A profile given by the environment has no name: readConfig reads it.
    if (envProfile()) return null;
    const store = readStore();
    if (store.default && store.profiles[store.default]) return store.default;
    // Fall back to the only profile if there's exactly one.
    const names = Object.keys(store.profiles);
    return names.length === 1 ? names[0] : null;
}

/**
 * Run `fn` with `name` as the active profile for every config read made
 * within its async call chain, without touching the process-wide choice.
 */
export function withActiveProfile(name, fn) {
    return scopedProfile.run(name, fn);
}

/**
 * Base URL of a server as stored in a profile. Profiles store a bare host
 * (`acme.aws.thinger.io`), which means HTTPS; a value carrying its own
 * scheme (`http://localhost:8080`) is used as is.
 */
export function serverURL(server) {
    if (!server) return undefined;
    return /^[a-z]+:\/\//i.test(server) ? server.replace(/\/+$/, '') : `https://${server}`;
}

/**
 * WebSocket base URL of a server: `wss://` for HTTPS servers (bare hosts
 * included), `ws://` for plain HTTP ones.
 */
export function serverWebSocketURL(server) {
    const url = serverURL(server);
    return url && url.replace(/^http(s?):\/\//i, (_, s) => `ws${s}://`);
}

/**
 * Default profile name for a server: its host (and port), without the
 * scheme a URL-style server carries.
 */
export function profileNameFor(server) {
    if (!server) return null;
    try {
        return /^[a-z]+:\/\//i.test(server) ? new URL(server).host : server;
    } catch {
        return server;
    }
}

/**
 * List all profile names.
 */
export function listProfiles() {
    return Object.keys(readStore().profiles);
}

/**
 * Get a specific profile by name (or undefined if missing).
 */
export function getProfile(name) {
    const store = readStore();
    return store.profiles[name];
}

/**
 * Set the persisted default profile.
 */
export function setDefaultProfile(name) {
    mutateStore((store) => {
        if (!store.profiles[name]) {
            throw new Error(`Profile not found: ${name}`);
        }
        store.default = name;
    });
}

/**
 * Remove a profile by name. Returns true if removed.
 */
export function deleteProfile(name) {
    return mutateStore((store) => {
        // A sign-in under way would bring it back once approved.
        const pending = pendingLogins(store);
        const hadPending = !!pending[name];
        delete pending[name];
        if (!Object.keys(pending).length) delete store.pending_logins;
        if (!store.profiles[name]) return hadPending;
        delete store.profiles[name];
        if (store.default === name) {
            // Not another one picked silently (it could be an admin's):
            // only the one left, if just one is.
            const remaining = Object.keys(store.profiles);
            store.default = remaining.length === 1 ? remaining[0] : null;
        }
        return true;
    });
}

/**
 * Check if any profile is configured.
 */
export function configExists() {
    if (envProfile()) return true;
    const store = readStore();
    if (!Object.keys(store.profiles).length) return false;
    return getActiveProfile() != null;
}

/**
 * A profile given by the environment, for CI and other machines without a
 * login: <PREFIX>_TOKEN (an access token) and <PREFIX>_SERVER (a host or a
 * url; never the identity's default server, which would receive a token
 * meant for another one). The user comes from the
 * token. It applies unless a profile is named (--profile, <PREFIX>_PROFILE,
 * a tool call's `profile`), which keeps reading the saved ones.
 *
 * @returns {{ server: string | undefined, token: string, username: string, env: true } | null}
 */
function envProfile() {
    const token = env('TOKEN');
    if (!token || scopedProfile.getStore() || activeProfileOverride || env('PROFILE')) return null;
    // Without a server it is still the profile in use: requireConfig says what is missing.
    const server = env('SERVER') || undefined;
    let username = null;
    try {
        username = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).usr;
    } catch {
        // Not a JWT: requireConfig reports the missing user.
    }
    return {
        server,
        token,
        username,
        env: true,
    };
}

/**
 * Read the active profile's data.
 * @returns {Object} Active profile fields (server, username, token, ...) or {}
 */
export function readConfig() {
    const staged = stagedProfile.getStore();
    if (staged) return staged.profile;
    const fromEnv = envProfile();
    if (fromEnv) return fromEnv;
    const store = readStore();
    const name = getActiveProfile();
    if (!name) return {};
    return profileView(store, name) || {};
}

/**
 * A stored profile as the commands use it: one that takes its credentials
 * from another gets that one's server and session, and its own account.
 */
function profileView(store, name) {
    const own = store.profiles[name];
    if (!own?.credentials_from) return own;
    const source = store.profiles[own.credentials_from];
    // Chains are not followed: the credentials profile must hold its own.
    const usable = source && !source.credentials_from ? source : {};
    return {
        ...usable,
        // Only what says what it is: the credentials are the other's.
        credentials_from: own.credentials_from,
        impersonate: own.impersonate,
        description: own.description,
        username: own.impersonate,
        credentials_user: usable.username ?? null,
        // The CLI token it minted belongs to the other profile's login.
        token_id: undefined,
    };
}

/**
 * The profile as `profile list` shows it (see readConfig), or undefined.
 *
 * @param {string} name
 */
export function describeProfile(name) {
    return profileView(readStore(), name);
}

/**
 * The profile that holds the credentials of `name`: the one it takes them
 * from, or itself.
 *
 * @param {string | null} name
 */
export function credentialsProfile(name) {
    if (!name) return name;
    return readStore().profiles[name]?.credentials_from || name;
}

/** The profiles that take their credentials from `name`. */
export function profilesUsingCredentialsOf(name) {
    const { profiles } = readStore();
    return Object.keys(profiles).filter((p) => profiles[p]?.credentials_from === name);
}

/**
 * Add a profile that takes server and credentials from `credentialsFrom`
 * and acts as the account `impersonate`.
 *
 * @param {string} name
 * @param {{ credentialsFrom: string, impersonate: string, description?: string }} link
 */
export function addImpersonatingProfile(name, { credentialsFrom, impersonate, description }) {
    mutateStore((store) => linkProfile(store, name, { credentialsFrom, impersonate, description }));
}

function linkProfile(store, name, { credentialsFrom, impersonate, description }) {
    const fail = (message, code = 'input_error') => {
        throw Object.assign(new Error(message), { code });
    };
    if (store.profiles[name]) fail(`Profile already exists: ${name}`, 'already_exists');
    if (name === credentialsFrom) fail('A profile cannot take its credentials from itself.');
    const source = store.profiles[credentialsFrom];
    if (!source) fail(`Profile not found: ${credentialsFrom}`, 'not_found');
    if (source.credentials_from) {
        fail(
            `Profile ${credentialsFrom} takes its credentials from ${source.credentials_from}: point ${name} at ${source.credentials_from} instead.`,
        );
    }
    if (!impersonate) fail('Name the account to act as (--impersonate <user>).');
    store.profiles[name] = {
        credentials_from: credentialsFrom,
        impersonate,
        ...(description && { description }),
    };
    // The first profile becomes the default; with others, choosing one is the user's.
    if (!store.default && Object.keys(store.profiles).length === 1) store.default = name;
}

/**
 * Set what a profile is for (`description`), which tells an agent which
 * profile to pick; an empty one removes it.
 *
 * @param {string} name
 * @param {{ description?: string }} fields
 */
export function updateProfile(name, { description }) {
    mutateStore((store) => {
        const profile = store.profiles[name];
        if (!profile) {
            throw Object.assign(new Error(`Profile not found: ${name}`), { code: 'not_found' });
        }
        if (description !== undefined) {
            if (description) profile.description = description;
            else delete profile.description;
        }
    });
}

/**
 * Read the active profile and assert that it has the fields every API
 * call needs (server, username, token). Throws a tagged error so the
 * MCP and CLI surfaces both classify the failure as `not_configured`
 * via classifyError. Replaces the same boilerplate that used to live
 * at the top of every helper in lib/.
 */
/**
 * The account an API call is addressed to: an explicit one when acting on
 * behalf of another account, the active profile's own otherwise. Single
 * source of truth — every path in lib/paths.js goes through it.
 */
export function resolveUser(user) {
    return user || requireConfig().username;
}

// The account asked for explicitly (-u for the whole command, the MCP
// `user` for one tool call): what a profile acting as another account may
// also reach. See checkImpersonation in api.js.
let commandUser = null;
const callUser = new AsyncLocalStorage();

/** The -u of the command line. */
export function setExplicitUser(user) {
    commandUser = user || null;
}

/** Run `fn` (a tool call) with `user` asked for explicitly. */
export function withExplicitUser(user, fn) {
    return user ? callUser.run(user, fn) : fn();
}

/** @returns {string | null} */
export function explicitUser() {
    return callUser.getStore() ?? commandUser;
}

export function requireConfig() {
    const config = readConfig();
    if (config.env && !config.server) {
        const { envPrefix } = identity();
        const err = new Error(
            `${envPrefix}_TOKEN is set without ${envPrefix}_SERVER: set both, or unset ${envPrefix}_TOKEN to use the saved profiles.`,
        );
        err.code = 'not_configured';
        throw err;
    }
    if (config.credentials_from) {
        const name = getActiveProfile();
        const source = getProfile(config.credentials_from);
        let problem = null;
        if (!source) problem = 'which does not exist';
        else if (source.credentials_from) {
            problem = `which takes its own from ${source.credentials_from} (only one level is followed)`;
        } else if (!config.token || !config.server || !config.credentials_user) {
            problem = `which is not signed in. ${loginHint(config.credentials_from)}`;
        }
        if (problem) {
            const err = new Error(
                `Profile ${name} acts as ${config.impersonate} with the credentials of profile ${config.credentials_from}, ${problem}`,
            );
            err.code = 'not_configured';
            throw err;
        }
    }
    if (!config.token || !config.server || !config.username) {
        const none = !config.env && !getActiveProfile() && listProfiles().length;
        const err = new Error(
            none
                ? `No default profile: pass --profile <name>, or choose one with \`${identity().name} profile use <name>\` (\`profile list\` says what each is for).`
                : `Not configured. ${loginHint()}`,
        );
        err.code = 'not_configured';
        throw err;
    }
    return config;
}

/**
 * Write a fresh profile from the supplied data. The profile name is
 * picked (in order): an explicit override set via setActiveProfile()
 * (used by `profile add` to scope the write to a named profile), the
 * supplied `server` (its host, see profileNameFor), or the currently
 * active profile name. Becomes the
 * default if there isn't one yet. Returns the profile name written.
 */
export function writeConfig(config) {
    const staged = stagedProfile.getStore();
    if (staged) {
        staged.profile = { ...config };
        return staged.name;
    }
    const name = profileTarget(config && config.server);
    if (!name) {
        throw new Error('Cannot write config without a server / profile name');
    }
    mutateStore((store) => {
        store.profiles[name] = { ...config };
        if (!store.default && Object.keys(store.profiles).length === 1) store.default = name;
    });
    return name;
}

/** The profile writeConfig({ server }) writes to. */
export function profileTarget(server) {
    return activeProfileOverride || profileNameFor(server) || getActiveProfile();
}

/**
 * Sign a profile in without touching the saved one until it succeeds:
 * within `fn`'s async call chain the profile `name` is `profile`, held in
 * memory (readConfig, mergeConfig and writeConfig work on it), and only
 * when `fn` resolves is it saved, replacing the one on disk. A login that
 * fails, is cancelled or whose process is killed leaves the saved profile
 * (and the processes using it) as it was.
 *
 * @template T
 * @param {string} name
 * @param {Record<string, any>} profile  What the login starts from.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStagedProfile(name, profile, fn) {
    const staged = { name, profile: { ...profile } };
    const result = await stagedProfile.run(staged, fn);
    await saveStaged(staged);
    return result;
}

/**
 * Run `fn` with `name` being `profile`, held in memory and never saved:
 * the requests of a login under way reach its server and carry no session
 * (not the default profile's, which may be another server's).
 *
 * @template T
 * @param {string} name
 * @param {Record<string, any>} profile
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withDraftProfile(name, profile, fn) {
    return stagedProfile.run({ name, profile: { ...profile } }, fn);
}

/** @param {{ name: string, profile: Record<string, any> }} staged */
async function saveStaged({ name, profile }) {
    // Saved between renewals of the session it replaces: a renewal in
    // flight would otherwise write its tokens over the new login.
    await withRefreshLock(
        name,
        async () =>
            mutateStore((store) => {
                store.profiles[name] = profile;
                if (!store.default && Object.keys(store.profiles).length === 1) {
                    store.default = name;
                }
            }),
        { staleMs: TIMEOUTS.REFRESH_LOCK_STALE_MS },
    );
}

/**
 * Browser logins started and not finished yet (`login --oauth` without a
 * terminal, the MCP profile `login` action), by the profile they sign in:
 * what the server answered (the device code and where to approve it) and
 * what to save on approval. Kept in the profiles file, under its lock,
 * until a while after they expire, so whoever checks one learns how it
 * ended. A profile has at most one: starting another replaces it.
 *
 * @typedef {object} PendingLogin
 * @property {string} server
 * @property {string} client_id
 * @property {string} device_code
 * @property {string} user_code
 * @property {string} verification_uri
 * @property {string} verification_uri_complete
 * @property {number} interval      Seconds between checks, as the server asks.
 * @property {number} expires_at    Epoch ms: the code is no good after it.
 * @property {number} [last_check]  Epoch ms of the last check with the server.
 * @property {'pending' | 'approved' | 'denied' | 'expired' | 'failed'} status
 * @property {string} [username]    The account signed in, once approved.
 * @property {string} [error]       Why an approved login was not saved.
 * @property {boolean} [create]     A new profile: one made meanwhile is left alone.
 * @property {string} [account]     The account the profile was of: approved as another, not saved.
 * @property {string} [description] For a profile it creates.
 * @property {boolean} [activate]   Make it the default once signed in.
 */

/** How long a finished login is remembered after its code expires. */
const PENDING_KEEP_MS = 60 * 60 * 1000;

/** @param {any} store */
function pendingLogins(store) {
    const now = Date.now();
    const all =
        store.pending_logins && typeof store.pending_logins === 'object'
            ? store.pending_logins
            : {};
    for (const [name, p] of Object.entries(all)) {
        if (!p || now > p.expires_at + PENDING_KEEP_MS) delete all[name];
    }
    store.pending_logins = all;
    return all;
}

/**
 * @param {string} name
 * @returns {PendingLogin | undefined}
 */
export function getPendingLogin(name) {
    return pendingLogins(readStore())[name];
}

/** The profiles with a browser login under way, existing or not yet. */
export function pendingLoginNames() {
    return Object.entries(pendingLogins(readStore()))
        .filter(([, p]) => p.status === 'pending')
        .map(([name]) => name);
}

/**
 * Record (or replace) the login under way of `name`; null forgets it.
 *
 * @param {string} name
 * @param {PendingLogin | null} login
 */
export function setPendingLogin(name, login) {
    mutateStore((store) => {
        const all = pendingLogins(store);
        if (login) all[name] = login;
        else delete all[name];
        if (!Object.keys(all).length) delete store.pending_logins;
    });
}

/**
 * Run `fn` holding the lock of the login under way of `name`, so two
 * checks of it (two MCP calls, a CLI waiting and an agent asking) never
 * both take the session the server hands out once.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withLoginLock(name, fn) {
    const lock = refreshLockPath(name).replace(/refresh-([^/\\]+)$/, 'login-$1');
    // Never run without it: two checks would take the session twice.
    return withFileLock(lock, fn, {
        staleMs: TIMEOUTS.REFRESH_LOCK_STALE_MS,
        waitMs: 60_000,
        required: true,
    });
}

/**
 * Merge fields into the active profile.
 */
export function mergeConfig(newConfig) {
    const staged = stagedProfile.getStore();
    if (staged) {
        Object.assign(staged.profile, newConfig);
        return;
    }
    const name = getActiveProfile();
    if (!name) {
        // No active profile yet: fall back to writeConfig semantics.
        return writeConfig(newConfig);
    }
    mutateStore((store) => {
        // Credentials are saved where they live: a profile that takes them
        // from another one writes there.
        const target = store.profiles[name]?.credentials_from || name;
        store.profiles[target] = { ...store.profiles[target], ...newConfig };
    });
}

/**
 * Delete the entire config (all profiles).
 */
export function deleteConfig() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return true;
    try {
        fs.unlinkSync(configPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Save a renewed session in the profile that holds it, only if that
 * profile still holds the session that was renewed (`presented` is its
 * refresh token): a login or a renewal saved meanwhile wins.
 *
 * @param {string} holder
 * @param {string} presented
 * @param {{ token: string, refresh_token: string }} session
 * @returns {boolean} Whether it was saved.
 */
export function saveRenewedSession(holder, presented, session) {
    return mutateStore((store) => {
        const profile = store.profiles[holder];
        if (!profile || profile.refresh_token !== presented) return false;
        Object.assign(profile, session);
        return true;
    });
}
