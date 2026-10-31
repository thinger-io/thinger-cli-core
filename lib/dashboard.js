// @ts-check
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import api from './api.js';
import { TIMEOUTS } from './constants.js';
import { readConfig, serverURL } from './config.js';
import { checkSdk } from './dashboard-sdk.js';
import { apiError, inputError } from './errors.js';
import { identity } from './identity.js';
import { v1, v2, v3 } from './paths.js';

/**
 * Url-source dashboards: an HTML page (plus its scripts, styles, images)
 * kept in a file storage and rendered by the console in an iframe, where it
 * talks to the server through the dashboard SDK (`@thinger-io/dashboard-sdk`, in its build).
 *
 * The storage must be public: the iframe cannot send an Authorization
 * header when it loads the page's files. Only the code is exposed; every API
 * call the page makes carries the viewer's token.
 *
 * A dashboard of the dashboards collection gets an empty context. A
 * per-device (or product, asset type, asset group, project) dashboard is
 * the `dashboard` property of that resource, holding the same
 * `{ source: "url", url }` object: the SDK then gets that id in its context.
 */

/** Resources that can hold a `dashboard` property, and where it lives. */
const TARGETS = {
    device: { path: 'devices', properties: v3, console: 'devices' },
    product: { path: 'products', properties: v1, console: 'products' },
    asset_type: { path: 'types', properties: v1, console: 'types' },
    asset_group: { path: 'groups', properties: v1, console: 'groups' },
    project: { path: 'projects', properties: v1, console: 'projects' },
};

/** The resource a target names, and its `dashboard` property (device properties are v3). */
const targetPath = (type, user, id) => `${v1(user)}/${TARGETS[type].path}/${id}`;
const propertyPath = (type, user, id) =>
    `${TARGETS[type].properties(user)}/${TARGETS[type].path}/${id}/properties/dashboard`;

export const DASHBOARD_TARGETS = Object.keys(TARGETS);

const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
/** Folders never uploaded from a local app folder. */
const SKIPPED = new Set(['node_modules', '.git']);
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Files of a local folder, as { "relative/path": Buffer }. Hidden entries
 * and the `skip` folders (node_modules, .git) are left out.
 *
 * @param {string} dir
 * @param {{ skip?: Set<string>, maxBytes?: number, tooLarge?: string }} [options]
 *   `maxBytes` caps the folder (20 MB by default, an app's build output);
 *   `tooLarge` is the advice added to the error past it.
 * @returns {Record<string, Buffer>}
 */
export function collectFiles(
    dir,
    { skip = SKIPPED, maxBytes = MAX_BYTES, tooLarge = 'publish a build output folder' } = {},
) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw inputError(`Not a folder: ${dir}`);
    }
    /** @type {Record<string, Buffer>} */
    const files = {};
    let total = 0;
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                const content = fs.readFileSync(full);
                total += content.length;
                if (total > maxBytes) {
                    throw inputError(
                        `${dir} holds more than ${maxBytes / 1024 / 1024} MB: ${tooLarge}`,
                    );
                }
                files[path.relative(root, full).split(path.sep).join('/')] = content;
            }
        }
    };
    walk(root);
    return files;
}

/**
 * Storage a dashboard's files go to unless the caller names one:
 * `dashboard_<id>`, `dashboard_<type>_<id>` for per-resource dashboards, or
 * a stable hash of the same when that does not fit the 32 characters a
 * storage id allows. Always the same for the same dashboard, so
 * republishing overwrites its files instead of scattering copies.
 *
 * @param {string | undefined} dashboard
 * @param {{ type: string, id: string }} [target]
 */
export function defaultStorage(dashboard, target) {
    const readable = dashboard ? `dashboard_${dashboard}` : `dashboard_${target.type}_${target.id}`;
    if (readable.length <= 32) return readable;
    const key = dashboard ? `dashboard:${dashboard}` : `${target.type}:${target.id}`;
    return `dashboard_${createHash('sha1').update(key).digest('hex').slice(0, 22)}`;
}

/**
 * The app's storage, created public if missing (in `projects`, when given).
 *
 * @returns {Promise<{ created: boolean, index?: string }>}
 */
async function ensurePublicStorage(storage, label, user, projects = []) {
    try {
        const res = await api.get(`${v1(user)}/storages/${storage}`);
        if (res.data?.public !== true) {
            throw inputError(
                `Storage "${storage}" is private, and the dashboard iframe can only load files from a public one. Pass another storage (it is created public), or make this one public first.`,
            );
        }
        return { created: false, index: res.data.index || undefined };
    } catch (e) {
        if (e.response?.status !== 404) throw e.code === 'input_error' ? e : apiError(e);
    }
    try {
        await api.post(`${v1(user)}/storages`, {
            storage,
            name: label,
            description: 'Files of a url-source dashboard',
            public: true,
        });
        if (projects.length) await api.put(`${v1(user)}/storages/${storage}/projects`, projects);
        return { created: true };
    } catch (e) {
        throw apiError(e);
    }
}

/** Account-relative path of a file in a storage, each segment escaped. */
const storageFile = (user, storage, file, version = 'v1') =>
    `${version === 'v2' ? v2(user) : v1(user)}/storages/${storage}/files/${file
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;

/**
 * Write files into a storage, overwriting what is there.
 *
 * @param {string} storage
 * @param {Record<string, Buffer | string>} files  Paths inside the storage → content.
 * @param {string | null} [user]
 */
export async function uploadFiles(storage, files, user) {
    for (const [file, content] of Object.entries(files)) {
        try {
            await api.put(storageFile(user, storage, file, 'v2'), content, {
                params: { overwrite: true },
                headers: { 'Content-Type': 'application/octet-stream' },
                timeout: TIMEOUTS.API_LONG_MS,
                maxBodyLength: Infinity,
            });
        } catch (e) {
            throw apiError(e, { notFound: `Storage not found: ${storage}` });
        }
    }
}

/** Paths of every file in a storage (empty when it has none yet). */
export async function listFiles(storage, user) {
    try {
        const res = await api.get(`${v1(user)}/storages/${storage}/files`);
        return (Array.isArray(res.data) ? res.data : [])
            .filter((f) => f.type !== 'directory')
            .map((f) => String(f.path ?? f.name).replace(/^\/+/, ''));
    } catch (e) {
        // The server creates a storage's folder with its first file.
        if (e.response?.status === 404) return [];
        throw apiError(e);
    }
}

async function remove(storage, files, user) {
    for (const file of files) {
        try {
            await api.delete(storageFile(user, storage, file, 'v2'));
        } catch (e) {
            if (e.response?.status !== 404) throw apiError(e);
        }
    }
}

/**
 * @typedef {object} Destination  Where an app is shown: a dashboard of the
 *   collection, or the `dashboard` property of a resource (type + id).
 * @property {string} [dashboard]
 * @property {string} [type]
 * @property {string} [id]
 * @property {string} [entry]   Page in the storage (default index.html).
 * @property {string} [route]   Initial route, after `#` (hash routing).
 * @property {string} [name]    Name of a collection dashboard.
 * @property {string} [description]
 */

/** @param {Destination} d */
export function checkDestination(d) {
    if (!d || typeof d !== 'object') throw inputError('each destination must be an object');
    if (!d.dashboard === !(d.type || d.id)) {
        throw inputError('a destination is either {dashboard} or {type, id}');
    }
    if (d.type === 'dashboard') {
        throw inputError(
            `a dashboard of the dashboards collection is {"dashboard": "${d.id ?? '<id>'}"}, not {type, id}`,
        );
    }
    if (d.type && !TARGETS[d.type]) {
        throw inputError(
            `type must be one of ${DASHBOARD_TARGETS.join(', ')} (a dashboard of the collection is {"dashboard": "<id>"})`,
        );
    }

    const id = d.dashboard || d.id;
    if (!id || !ID_RE.test(id)) throw inputError(`invalid id: "${id ?? ''}"`);
    if (
        d.entry !== undefined &&
        (typeof d.entry !== 'string' || !d.entry || d.entry.startsWith('/'))
    ) {
        throw inputError('entry is a path inside the storage, e.g. "index.html"');
    }
}

/**
 * Where a destination points: the storage folder when its entry is the
 * storage's index (`…/files/`, the trailing slash makes the server serve the
 * index), its file otherwise, plus its initial route. Storage files are
 * served with no-cache and an ETag, so viewers get each upload without a
 * version query; `version` adds one (?v=) to make open consoles reload.
 *
 * @param {string | null | undefined} user
 * @param {string} storage
 * @param {{ entry?: string, route?: string }} destination
 * @param {{ index?: string, version?: number | string }} [opts]
 */
export function entryUrl(user, storage, { entry = 'index.html', route }, { index, version } = {}) {
    const hash = route ? `#${String(route).replace(/^#/, '')}` : '';
    const query = version !== undefined ? `?v=${version}` : '';
    return `${storageFile(user, storage, entry === index ? '' : entry)}${query}${hash}`;
}

/**
 * What a preview token may do: read everything the SDK reads, nothing else.
 * Explicit names, not Read*: on devices that would also read their files
 * and web services. Device and product resources are left out, since the
 * same action reads and calls them.
 */
export const PREVIEW_ALLOW = {
    Device: {
        '*': [
            'ListDevices',
            'ReadDeviceConfig',
            'ReadDeviceStatus',
            'ReadDeviceStatistics',
            'ListDeviceProperties',
            'ReadDeviceProperty',
            'ListDeviceBuckets',
            'ReadDeviceBucket',
            'ListDeviceBucketTags',
            'ReadDeviceBucketTag',
        ],
    },
    Bucket: {
        '*': ['ListBuckets', 'ReadBucketConfig', 'ReadBucket', 'ListBucketTags', 'ReadBucketTag'],
    },
    Product: {
        '*': [
            'ListProducts',
            'ReadProductConfig',
            'ListProductProperties',
            'ReadProductProperty',
            'ReadProductProfile',
        ],
    },
    Type: {
        '*': [
            'ListTypes',
            'ReadTypeConfig',
            'ListTypeProperties',
            'ReadTypeProperty',
            'ReadAssetsLocations',
        ],
    },
    Group: {
        '*': [
            'ListGroups',
            'ReadGroupConfig',
            'ListGroupProperties',
            'ReadGroupProperty',
            'ReadAssetsLocations',
        ],
    },
    Asset: { '*': ['ReadAssetsLocations'] },
    Project: {
        '*': ['ListProjects', 'ReadProjectConfig', 'ListProjectProperties', 'ReadProjectProperty'],
    },
    Property: { '*': ['ListProperties', 'ReadProperty'] },
    Alarm: {
        '*': [
            'ListAlarmRules',
            'ReadAlarmRuleConfig',
            'ListAlarmInstances',
            'ReadAlarmInstanceConfig',
            'ReadAlarmInstanceStats',
        ],
    },
    Storage: { '*': ['ListStorages', 'ReadStorageConfig', 'ListStorageFiles', 'ReadStorageFiles'] },
    User: {
        '*': ['SubscribeUserEvents', 'ReadUserProfile', 'ReadUserTimezone', 'ListDeviceLocations'],
    },
};

export const PREVIEW_HOURS = 1;
export const PREVIEW_MAX_HOURS = 24 * 30;

/**
 * Token id of an app's previews: one per storage and project, so publishing
 * again replaces it instead of piling up tokens.
 *
 * @param {string} storage
 * @param {string} [project]
 */
export function previewTokenId(storage, project) {
    const readable = project ? `preview_${storage}_${project}` : `preview_${storage}`;
    if (readable.length <= 32) return readable;
    const key = `${storage}:${project || ''}`;
    return `preview_${createHash('sha1').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * A read-only access token for previews, valid for `hours` (default 1). The
 * expiry is signed into the token, so it is renewed by deleting it and
 * creating it again. Inside a project (?project=) it only works there.
 *
 * @param {string} storage
 * @param {{ project?: string, hours?: number, user?: string | null }} [opts]
 * @returns {Promise<{ token: string, accessToken: string, expire: number }>}
 */
export async function previewToken(storage, { project, hours = PREVIEW_HOURS, user } = {}) {
    return replaceToken(previewTokenId(storage, project), {
        name: `Preview of ${storage}${project ? ` (${project})` : ''}`,
        allow: PREVIEW_ALLOW,
        hours,
        project,
        user,
    });
}

/**
 * Create an access token valid for `hours`, replacing the one with the same
 * id: the expiry is signed into the token, so it is renewed by deleting it
 * and creating it again. Inside a project (?project=) it only works there.
 *
 * @param {string} token  Token id.
 * @param {{ name: string, allow: object, hours: number, project?: string, user?: string | null }} opts
 * @returns {Promise<{ token: string, accessToken: string, expire: number }>}
 */
export async function replaceToken(token, { name, allow, hours, project, user }) {
    const params = project ? { project } : undefined;
    try {
        await api.delete(`${v1(user)}/tokens/${token}`, { params });
    } catch (e) {
        if (e.response?.status !== 404) throw apiError(e);
    }
    const expire = Date.now() + hours * 3600 * 1000;
    let res;
    try {
        res = await api.post(
            `${v1(user)}/tokens`,
            { token, name, enabled: true, allow, expire },
            { params },
        );
    } catch (e) {
        throw apiError(e);
    }
    const accessToken = res.data?.access_token;
    if (!accessToken) throw new Error(`the server returned no access token for ${token}`);
    return { token, accessToken, expire };
}

/**
 * The entry url opened as a standalone page: the SDK takes the session from
 * the fragment (thinger_* params after the route) and strips it before the
 * app starts, so it never reaches the server.
 *
 * @param {string} url  Absolute entry url, with its optional #route.
 * @param {string} token  Access token.
 * @param {Record<string, string | undefined>} [context]  SDK context: project, device, product, type, group.
 */
export function previewUrl(url, token, context = {}) {
    const params = new URLSearchParams({ thinger_token: token });
    for (const [key, id] of Object.entries(context)) if (id) params.set(`thinger_${key}`, id);
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    const route = hash < 0 ? '' : url.slice(hash + 1);
    // The route goes first in the fragment: it must not add parameters of its own.
    if (/[&#]/.test(route)) throw inputError(`a route has no "&" or "#": ${route}`);
    return `${base}#${route || '/'}&${params}`;
}

/** The SDK context key each destination type fills. */
export const CONTEXT_KEYS = {
    device: 'device',
    product: 'product',
    asset_type: 'type',
    asset_group: 'group',
    project: 'project',
};

/** Point one destination at `url`; returns where to open it in the console. */
async function point(d, url, user) {
    const base = serverURL(readConfig().server) || '';
    if (d.dashboard) {
        const body = {
            source: 'url',
            url,
            ...(d.name ? { name: d.name } : {}),
            ...(d.description !== undefined ? { description: d.description } : {}),
        };
        try {
            await api.put(`${v1(user)}/dashboards/${d.dashboard}`, body);
        } catch (e) {
            if (e.response?.status !== 404) throw apiError(e);
            try {
                await api.post(`${v1(user)}/dashboards`, {
                    dashboard: d.dashboard,
                    name: d.name || d.dashboard,
                    ...body,
                });
            } catch (e2) {
                throw apiError(e2);
            }
        }
        return `${base}/console/dashboards/${d.dashboard}`;
    }
    const property = propertyPath(d.type, user, d.id);
    const value = { source: 'url', url };
    try {
        await api.put(property, { value });
    } catch (e) {
        if (e.response?.status !== 404) throw apiError(e);
        // No dashboard property yet: create it.
        try {
            await api.post(property.replace(/\/dashboard$/, ''), { property: 'dashboard', value });
        } catch (e2) {
            throw apiError(e2, { notFound: `${d.type} not found: ${d.id}` });
        }
    }
    return `${base}/console/${TARGETS[d.type].console}/${d.id}/dashboard`;
}

/**
 * Publish an HTML app to a public storage and/or point dashboards at it.
 *
 * Both halves are optional: upload a new build without touching the
 * dashboards, point more dashboards at an app already uploaded, or both at
 * once. One storage can hold an app shared by many dashboards, each opening
 * its own entry page or initial route. Storage files are served with
 * no-cache and an ETag, so viewers get the new upload on their next load;
 * `bump` adds ?v=<publish time> to the urls so open consoles reload at once.
 *
 * With `preview`, each destination also gets a standalone link carrying a
 * read-only token that expires in an hour (see previewToken).
 *
 * @param {{
 *   storage?: string,
 *   files?: Record<string, Buffer | string>,
 *   prune?: boolean,
 *   to?: Destination[],
 *   preview?: boolean | number,
 *   point?: boolean,
 *   bump?: boolean,
 *   user?: string | null,
 *   dir?: string,
 * }} opts  `dir`: the folder the files come from, to check the SDK it was built with.
 */
export async function publishApp({
    storage,
    files,
    prune = false,
    to = [],
    preview = false,
    point: repoint = true,
    bump = false,
    user,
    dir,
}) {
    if (!Array.isArray(to)) throw inputError('to must be a list of destinations');
    to.forEach(checkDestination);
    const names = files ? Object.keys(files) : [];
    if (files && !names.length) throw inputError('no files to publish');
    if (!files && !to.length && !preview)
        throw inputError('nothing to do: pass files to upload, to to point, or both');
    const hours = preview === true ? PREVIEW_HOURS : Number(preview || 0);
    if (preview !== false && !(hours > 0 && hours <= PREVIEW_MAX_HOURS)) {
        throw inputError(`preview is true or a number of hours, up to ${PREVIEW_MAX_HOURS}`);
    }
    if (prune && !files) throw inputError('prune needs the files of the new version');

    if (!storage && to.length !== 1) {
        throw inputError('pass storage: it names the app shared by these destinations');
    }
    const storageId =
        storage ||
        defaultStorage(
            to[0].dashboard,
            to[0].dashboard ? undefined : { type: to[0].type, id: to[0].id },
        );
    if (!ID_RE.test(storageId)) throw inputError(`invalid storage id: "${storageId}"`);

    // Check the resources before creating or filling any storage for them,
    // and gather their projects: a storage created for them joins those.
    const owner = user || readConfig().username;
    const projects = new Set();
    for (const d of to.filter((x) => x.type)) {
        let record;
        try {
            record = (await api.get(targetPath(d.type, user, d.id))).data;
        } catch (e) {
            throw apiError(e, { notFound: `${d.type} not found: ${d.id}` });
        }
        if (d.type === 'project') projects.add(`${owner}@${d.id}`);
        for (const p of Array.isArray(record?.project) ? record.project : []) projects.add(p);
    }

    let storageInfo;
    let deleted = [];
    if (files) {
        const label = to.length === 1 && to[0].name ? to[0].name : `App ${storageId}`;
        storageInfo = await ensurePublicStorage(storageId, label, user, [...projects]);
        await uploadFiles(
            storageId,
            Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
            user,
        );
        if (prune) {
            const keep = new Set(names);
            deleted = (await listFiles(storageId, user)).filter((f) => !keep.has(f));
            await remove(storageId, deleted, user);
        }
    }

    // Every entry must be in the storage before anything points at it.
    const available = new Set(storageInfo?.created ? [] : await listFiles(storageId, user));
    for (const name of names) available.add(name);
    for (const d of to) {
        const entry = d.entry || 'index.html';
        if (!available.has(entry)) {
            throw inputError(`storage ${storageId} has no ${entry}: upload the app first`);
        }
    }
    storageInfo ??= await ensurePublicStorage(storageId, `App ${storageId}`, user, [...projects]);

    // The storage's index, served at its folder url: kept while it is in the
    // storage, else index.html or the first destination's entry.
    let index = storageInfo.index;
    if (!index || !available.has(index)) {
        const fallback = available.has('index.html') ? 'index.html' : to[0]?.entry;
        if (fallback && fallback !== index) {
            try {
                await api.put(`${v1(user)}/storages/${storageId}`, { index: fallback });
            } catch (e) {
                throw apiError(e);
            }
        }
        index = fallback;
    }

    const urlOpts = { index, version: bump ? Date.now() : undefined };
    const pointed = [];
    for (const d of repoint ? to : []) {
        const url = entryUrl(user, storageId, d, urlOpts);
        pointed.push({
            to: d.dashboard ? `dashboard ${d.dashboard}` : `${d.type} ${d.id}`,
            url,
            open: await point(d, url, user),
        });
    }

    // One token per project the previews run in (none for account dashboards).
    const previews = [];
    if (preview) {
        const base = serverURL(readConfig().server) || '';
        const tokens = new Map();
        for (const d of to.length ? to : [{}]) {
            const project = d.type === 'project' ? d.id : undefined;
            if (!tokens.has(project)) {
                tokens.set(project, await previewToken(storageId, { project, hours, user }));
            }
            const { accessToken, expire } = tokens.get(project);
            const url = previewUrl(
                base + entryUrl(user, storageId, d, urlOpts),
                accessToken,
                d.type ? { [CONTEXT_KEYS[d.type]]: d.id } : {},
            );
            previews.push({
                to: d.dashboard ? `dashboard ${d.dashboard}` : d.type ? `${d.type} ${d.id}` : 'app',
                url,
                expire,
            });
        }
    }
    return {
        storage: storageId,
        storageCreated: storageInfo.created,
        uploaded: names,
        deleted,
        pointed,
        previews,
        sdk: files ? await checkSdk({ dir, files }) : [],
    };
}

/**
 * A destination written as `kind:id` on the command line: `dashboard:sales`,
 * `device:gw1`, `product:meter`, `asset_type:pump`, `asset_group:plant`,
 * `project:demo`.
 *
 * @param {string} value
 * @returns {Destination}
 */
export function parseDestination(value) {
    const m = /^([a-z_]+):(.+)$/.exec(String(value));
    const kinds = ['dashboard', ...DASHBOARD_TARGETS];
    if (!m || !kinds.includes(m[1])) {
        throw inputError(
            `a destination is <${kinds.join('|')}>:<id>, e.g. device:gw1; got "${value}"`,
        );
    }
    const d = m[1] === 'dashboard' ? { dashboard: m[2] } : { type: m[1], id: m[2] };
    checkDestination(d);
    return d;
}

/** The SDK context a destination gives its app (empty for collection dashboards). */
export function destinationContext(d) {
    return d?.type ? { [CONTEXT_KEYS[d.type]]: d.id } : {};
}

/** File, in an app's folder, describing how it is published and developed. */
export function manifestName() {
    return `${identity().name}.json`;
}

/**
 * The `dashboard` section of an app's manifest (`<cli>.json`), or null when
 * there is none. Paths in it are relative to the manifest.
 *
 *   {
 *     "dashboard": {
 *       "dir": "dist/app/browser",      // build output to publish
 *       "storage": "app_greenhouse",
 *       "prune": true,
 *       "to": [{ "type": "device", "id": "gh_01", "route": "/" }],
 *       "dev": { "url": "http://localhost:4200/",   // the app's dev server
 *                "context": { "device": "gh_01" } } // default: the first destination's
 *     }
 *   }
 *
 * @param {string} [file]  Manifest path (default: <cli>.json in the working folder).
 * @returns {{ file: string, dir?: string, storage?: string, prune?: boolean, entry?: string,
 *   to?: Destination[], dev?: { url?: string, context?: Record<string, string>,
 *   route?: string, hours?: number } } | null}
 */
export function readManifest(file) {
    const full = path.resolve(file || manifestName());
    if (!fs.existsSync(full)) {
        if (file) throw inputError(`No such file: ${file}`);
        return null;
    }
    let json;
    try {
        json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
        throw inputError(`${full} is not valid JSON: ${e.message}`);
    }
    const section = json?.dashboard;
    if (!section || typeof section !== 'object') {
        if (file) throw inputError(`${full} has no "dashboard" section`);
        return null;
    }
    if (section.to !== undefined) {
        if (!Array.isArray(section.to)) throw inputError(`${full}: dashboard.to must be a list`);
        section.to.forEach(checkDestination);
    }
    const base = path.dirname(full);
    const dir = section.dir ? path.resolve(base, String(section.dir)) : undefined;
    // A manifest may come with someone else's repository: what it publishes
    // stays inside its folder (a folder outside it is passed on the command line).
    if (dir) {
        const rel = path.relative(base, dir);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw inputError(`${full}: dashboard.dir must be inside its folder`);
        }
    }
    const types = { storage: 'string', prune: 'boolean', entry: 'string', dev: 'object' };
    for (const [key, type] of Object.entries(types)) {
        if (section[key] !== undefined && typeof section[key] !== type) {
            throw inputError(`${full}: dashboard.${key} must be a ${type}`);
        }
    }
    const dev = section.dev || {};
    const devTypes = { url: 'string', context: 'object', route: 'string', hours: 'number' };
    for (const [key, type] of Object.entries(devTypes)) {
        if (dev[key] !== undefined && (typeof dev[key] !== type || dev[key] === null)) {
            throw inputError(`${full}: dashboard.dev.${key} must be a ${type}`);
        }
    }
    return { ...section, file: full, dir };
}

/**
 * Human summary of a publishApp result, as the CLI prints it and the MCP
 * tool answers it.
 *
 * @param {Awaited<ReturnType<typeof publishApp>>} result
 * @param {{ point?: boolean }} [opts]
 */
export function publishSummary(result, { point: repoint = true } = {}) {
    const lines = [];
    if (result.uploaded.length) {
        lines.push(
            `Uploaded ${result.uploaded.length} file(s) to ${result.storageCreated ? 'new public' : 'public'} storage ${result.storage}` +
                (result.deleted.length
                    ? `; deleted ${result.deleted.length} no longer in the app.`
                    : '.'),
        );
    }
    for (const p of result.pointed) lines.push(`${p.to} → ${p.url}\n  open: ${p.open}`);
    if (!result.pointed.length && repoint !== false) {
        lines.push(
            'No dashboard was pointed: those already showing this storage load the new files the next time they open.',
        );
    }
    if (result.previews.length) {
        const until = new Date(result.previews[0].expire)
            .toISOString()
            .slice(0, 16)
            .replace('T', ' ');
        lines.push(
            `Preview links (standalone pages for a browser, read-only token valid until ${until} UTC; servers that ignore token expiry keep it until the next preview replaces it; the previous preview links of this storage stop working):`,
        );
        for (const p of result.previews) {
            lines.push(`${p.to} → ${p.url}`);
        }
    }
    for (const note of result.sdk || []) lines.push(`SDK: ${note}`);
    return lines.join('\n');
}
