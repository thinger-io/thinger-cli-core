// @ts-check
import api from '../api.js';
import { TIMEOUTS } from '../constants.js';
import { getActiveProfile } from '../config.js';
import { apiError, inputError } from '../errors.js';
import { readDoc } from '../docs.js';
import { findOperation, resolveRefs, serverSpec } from '../openapi.js';
import {
    CATALOG,
    actionRequest,
    actionTemplate,
    ancestry,
    idHint,
    idNames,
    parentHint,
    requestFor,
    templateFor,
    typeNames,
} from './catalog.js';
import { toolName } from './naming.js';
import { mergeHooks } from './resource-hooks.js';
import { textResult } from './helpers.js';

export { DATA } from './helpers.js';

/**
 * The generic `resource_*` tools: one tool per verb over every type of the
 * catalog, instead of one tool per type and verb. What a type looks like
 * (its fields, the examples the server documents) is not in the tool list
 * but behind `resource_describe`, read from the server's own OpenAPI
 * document when the model needs it.
 */

/**
 * Types and actions a CLI adds to the catalog (`runCli({ resourceTypes,
 * resourceActions })`): its platform's own things, served by the same
 * tools. A CLI type has no REST path: its functions answer each verb.
 *
 * What reaches those functions comes from the model: `parent` and `id` are
 * checked for their number of segments (and `..`, empty or control
 * characters), but `id`, `filter`, `query` and the body are still untrusted
 * input, to be validated before use.
 *
 * @typedef {object} LocalContext
 * @property {string} type
 * @property {string} [parent]
 * @property {string} [id]
 * @property {string | null} [user]
 * @property {Record<string, any>} [filter]  resource_list's filter.
 * @property {Record<string, any>} [query]   resource_call's query.
 * @property {boolean} [full]
 * @property {Record<string, any>} state
 *
 * @typedef {object} LocalAction
 * @property {string} description
 * @property {'item' | 'collection' | 'either'} [on]  Whether it takes an id: item (default)
 *   needs one, collection takes none, either takes it or not.
 * @property {object} [body]  JSON schema of its body, shown by resource_describe.
 * @property {(body: any, ctx: LocalContext) => any} run  Returns the answer: text,
 *   anything JSON, or a whole tool result ({content: [{type, text}], isError}) to flag a
 *   failure (only actions can; the verbs answer text or JSON).
 *
 * @typedef {object} LocalType
 * @property {string} description  One line, shown in the catalog summary.
 * @property {string} [parent]  Type this one hangs off (the server's or another CLI
 *   type with an id): its location is the `parent`.
 * @property {string} [id]      Name of the item id; without one, a single resource of its parent.
 * @property {string} [notes]   Longer guidance returned by resource_describe.
 * @property {object} [schema]  JSON schema of a record, the body of create and update.
 * @property {() => Record<string, any> | Promise<Record<string, any>>} [describe]  More
 *   for resource_describe to show (a reference the type's records follow, say).
 * @property {(ctx: LocalContext) => any[] | Promise<any[]>} [list]  The whole list:
 *   search and paging are done by the tool.
 * @property {(ctx: LocalContext) => any} [get]
 * @property {(body: any, ctx: LocalContext) => any} [create]  Returns a result or a note.
 * @property {(body: any, ctx: LocalContext) => any} [update]
 * @property {(ctx: LocalContext) => any} [delete]
 * @property {Record<string, LocalAction>} [actions]
 */

const LOCAL_VERBS = /** @type {const} */ (['list', 'get', 'create', 'update', 'delete']);
const ACTION_ON = new Set(['item', 'collection', 'either']);
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\x00-\x1f]/;

/** An own key of a plain map: never `constructor` or another inherited one. */
const own = (map, key) =>
    map && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;

/** A whole MCP tool result, as an action may answer to flag a failure. */
const isToolResult = (v) =>
    !!v &&
    typeof v === 'object' &&
    Array.isArray(v.content) &&
    v.content.every((c) => c && typeof c === 'object' && typeof c.type === 'string') &&
    Object.keys(v).every((k) => k === 'content' || k === 'isError' || k === '_meta');

/**
 * Longest answer a CLI type or action gives (characters of the text sent):
 * a file it reads can be huge. Server types are never cut: a record read to
 * be edited and written back must be whole.
 */
export const MAX_TEXT = 100_000;

/** `text` cut at MAX_TEXT, saying so. */
function capped(t) {
    t = String(t ?? '');
    if (t.length <= MAX_TEXT) return t;
    return `${t.slice(0, MAX_TEXT)}\n… (cut: ${t.length} characters in total, showing the first ${MAX_TEXT})`;
}

/**
 * Check what a CLI adds against the catalog: a type or an action that
 * clashes with the server's is a mistake, found when the server starts.
 *
 * @param {Record<string, LocalType>} types
 * @param {Record<string, Record<string, LocalAction>>} actions
 */
export function checkLocal(types, actions) {
    for (const [name, t] of Object.entries(types)) {
        if (CATALOG[name]) throw new Error(`Resource type "${name}" is already a server type`);
        if (!t.description) throw new Error(`Resource type "${name}" needs a description`);
        if (t.parent && !CATALOG[t.parent] && !own(types, t.parent)) {
            throw new Error(`Resource type "${name}": unknown parent "${t.parent}"`);
        }
        const seen = new Set([name]);
        for (let p = t.parent; p && own(types, p); p = types[p].parent) {
            if (seen.has(p)) throw new Error(`Resource type "${name}": its parents loop`);
            if (!types[p].id) throw new Error(`Resource type "${name}": parent "${p}" has no id`);
            seen.add(p);
        }
        if (!LOCAL_VERBS.some((v) => typeof t[v] === 'function') && !t.actions) {
            throw new Error(`Resource type "${name}" has no operations`);
        }
        for (const [a, spec] of Object.entries(t.actions || {})) checkAction(name, a, spec);
    }
    for (const [type, list] of Object.entries(actions)) {
        if (!CATALOG[type] && !types[type]) {
            throw new Error(`Actions for unknown resource type "${type}"`);
        }
        for (const [a, spec] of Object.entries(list)) {
            if (CATALOG[type]?.actions?.[a] || types[type]?.actions?.[a]) {
                throw new Error(`Resource type "${type}" already has an action "${a}"`);
            }
            checkAction(type, a, spec);
        }
    }
}

function checkAction(type, name, spec) {
    if (typeof spec?.run !== 'function' || !spec.description) {
        throw new Error(`Action "${name}" of "${type}" needs a description and run()`);
    }
    if (spec.on !== undefined && !ACTION_ON.has(spec.on)) {
        throw new Error(`Action "${name}" of "${type}": on must be item, collection or either`);
    }
}

/** `{tool:x}` in catalog notes → full tool names (tests check they exist). */
const expandNotes = (notes) => notes.replace(/\{tool:([a-z0-9_]+)\}/g, (_, base) => toolName(base));

/** Verbs whose request carries a body. */
const BODY_VERBS = new Set(['create', 'update', 'patch', 'clone']);

/** Examples named like this document one field each: noise in a description. */
const FIELD_EXAMPLE = /^Update '/;

/** A tool result; `data` is what the CLI prints with --json. */
const text = textResult;

/**
 * A type and the ids that locate it, for messages: `device_property thermostat/setpoint`.
 *
 * @param {string} type
 * @param {{ parent?: string, id?: string }} [where]
 */
function label(type, { parent, id } = {}) {
    const where = [parent, id].filter(Boolean).join('/');
    return where ? `${type} ${where}` : type;
}

/** The id a create or clone body names, when it carries every id field. */
function bodyIdOf(t, body) {
    const fields = t.bodyId ?? idNames(t);
    if (!fields.length || !body || typeof body !== 'object' || Array.isArray(body))
        return undefined;
    const ids = fields.map((f) => body[f]);
    return ids.every((v) => v !== undefined && v !== null && v !== '') ? ids.join('/') : undefined;
}

/**
 * @param {string} type
 * @param {import('./catalog.js').Verb} verb
 * @param {{ parent?: string, id?: string, user?: string | null }} args
 * @param {{ data?: any, params?: Record<string, any> }} [request]
 */
async function send(type, verb, args, { data, params } = {}) {
    const { method, url } = requestFor(type, verb, args);
    try {
        const res = await api.request({
            method,
            url,
            data,
            params,
            // Repeated keys (`state=1&state=2`), as the server expects them.
            paramsSerializer: { indexes: null },
        });
        return res.data;
    } catch (e) {
        throw apiError(e, { notFound: `Not found: ${label(type, args)}` });
    }
}

/**
 * Lists kept for a while per profile and request (`listCache` of the
 * catalog): the plugin catalog is a proxy of a remote one, slow and long,
 * and is searched many times in a row.
 * @type {Map<string, { at: number, data: any }>}
 */
const listCache = new Map();

/** `send` of a list, cached when the type's `listCache` matches the query. */
async function sendList(type, args, params) {
    const rule = CATALOG[type].listCache;
    const cached =
        rule && Object.entries(rule.params).every(([k, v]) => String(params[k]) === String(v));
    if (!cached) return send(type, 'list', args, { params });
    // Answered whole: paging is done here, so it is not part of the key.
    const { count: _count, index: _index, ...query } = params;
    const key = JSON.stringify([getActiveProfile(), requestFor(type, 'list', args).url, query]);
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < rule.minutes * 60_000) return hit.data;
    const data = await send(type, 'list', args, { params: query });
    listCache.set(key, { at: Date.now(), data });
    return data;
}

/** The given dot paths of a record, for lists whose records are too big. */
export function pick(record, fields) {
    if (!record || typeof record !== 'object') return record;
    const out = {};
    for (const field of fields) {
        const keys = field.split('.');
        const value = keys.reduce(
            (v, k) => (v && typeof v === 'object' ? v[k] : undefined),
            record,
        );
        if (value === undefined) continue;
        let node = out;
        keys.slice(0, -1).forEach((k) => (node = node[k] ??= {}));
        node[keys[keys.length - 1]] = value;
    }
    return out;
}

/** One record per line: lists stay readable without paying for indentation. */
function formatList(type, data, pageSize) {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (!data.length) return `No ${type} found.`;
    const lines = data.map((item) => JSON.stringify(item));
    const full =
        data.length === pageSize
            ? `\n(page full: there may be more; pass index: ${data.length} for the next page)`
            : '';
    return `${data.length} ${type}:\n${lines.join('\n')}${full}`;
}

/** Request body schema and examples of an operation, `$ref`s resolved. */
function bodyOf(doc, operation) {
    const content = operation?.requestBody?.content?.['application/json'];
    if (!content) return undefined;
    const out = {};
    if (content.schema) out.schema = resolveRefs(doc, content.schema);
    const examples = Object.entries(content.examples || {})
        .filter(([name]) => !FIELD_EXAMPLE.test(name))
        .slice(0, 4);
    if (examples.length) {
        out.examples = Object.fromEntries(examples.map(([name, ex]) => [name, ex.value]));
    } else if (content.example !== undefined) {
        out.examples = { example: content.example };
    }
    return out;
}

/** First record of the documented response, to show the shape of the data. */
/**
 * The description with each request schema written once. Profile entries,
 * for one, take the same 16 KB schema to create, to update and, as the
 * values of a map, to replace the whole category: the copies become a
 * pointer to the first. Actions move after the schemas they refer to.
 *
 * @param {Record<string, any>} out
 */
export function shareSchemas(out) {
    const seen = new Map();
    const visit = (node) => {
        if (!node || typeof node !== 'object') return node;
        const json = JSON.stringify(node);
        if (json.length > 400 && seen.has(json)) return `(same as the ${seen.get(json)} schema)`;
        return Array.isArray(node)
            ? node.map(visit)
            : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
    };
    const take = (body, label) => {
        if (!body?.schema) return body;
        const shared = { ...body, schema: visit(body.schema) };
        const json = JSON.stringify(body.schema);
        if (!seen.has(json)) seen.set(json, label);
        return shared;
    };
    const { actions, ...rest } = out;
    for (const verb of ['create', 'update', 'clone']) {
        if (rest[verb]) rest[verb] = take(rest[verb], verb);
    }
    if (!actions) return rest;
    const shared = Object.fromEntries(
        Object.entries(actions).map(([a, spec]) => [
            a,
            spec.body ? { ...spec, body: take(spec.body, `${a} body`) } : spec,
        ]),
    );
    const { schema_source, record_example, permissions, ...head } = rest;
    return Object.fromEntries(
        Object.entries({
            ...head,
            actions: shared,
            permissions,
            record_example,
            schema_source,
        }).filter(([, value]) => value !== undefined),
    );
}

function responseExample(operation) {
    const ok = operation?.responses?.['200']?.content?.['application/json'];
    const example = ok?.example ?? Object.values(ok?.examples || {})[0]?.value;
    return Array.isArray(example) ? example[0] : example;
}

/** Which tool runs each verb of a type. */
function operationsOf(ops) {
    const tools = {
        list: toolName('resource_list'),
        get: toolName('resource_get'),
        create: toolName('resource_create'),
        update: toolName('resource_update'),
        patch: `${toolName('resource_update')} with merge: true`,
        delete: toolName('resource_delete'),
        clone: toolName('resource_clone'),
        projects: `${toolName('resource_update')} with {projects: [...]}`,
    };
    return Object.fromEntries(Object.keys(ops).map((verb) => [verb, tools[verb]]));
}

/**
 * The tools, over the catalog and what the CLI adds to it.
 *
 * @param {{
 *   hooks?: Record<string, import('./resource-hooks.js').ResourceHooks>,
 *   types?: Record<string, LocalType>,
 *   actions?: Record<string, Record<string, LocalAction>>,
 * }} [opts]
 */
export function resourceTools({ hooks: extraHooks, types: local = {}, actions: extra = {} } = {}) {
    checkLocal(local, extra);
    const hooks = mergeHooks(extraHooks);
    const served = new Set([...typeNames(), ...Object.keys(local)]);

    /** Verbs of a type: the catalog's, or the functions a CLI type has. */
    const opsOf = (name) =>
        own(local, name)
            ? Object.fromEntries(
                  LOCAL_VERBS.filter((v) => typeof local[name][v] === 'function').map((v) => [
                      v,
                      'cli',
                  ]),
              )
            : CATALOG[name].ops;
    /** Actions a CLI adds, to its own types or to the server's. */
    const localActionsOf = (name) => ({
        ...(own(local, name)?.actions || {}),
        ...(own(extra, name) || {}),
    });
    const actionNames = (name) => [
        ...Object.keys(CATALOG[name]?.actions || {}),
        ...Object.keys(localActionsOf(name)),
    ];
    const namesWith = (verb) => [...served].filter((n) => verb in opsOf(n));
    /** How the parent of a type is written: `<device>`, `<device>/<bucket>`. */
    const parentOf = (name) => {
        if (!own(local, name)) return parentHint(name);
        const p = local[name].parent;
        return p ? [parentOf(p), idOf(p)].filter(Boolean).join('/') : '';
    };
    function idOf(name) {
        if (!own(local, name)) return idHint(name);
        return local[name].id ? `<${local[name].id}>` : '';
    }

    /**
     * `parent` (and `id`, when needed) as many segments as the type's
     * location has, none empty, `.`, `..` or with control characters. The
     * id of a CLI type is one value, which may hold "/" (a path).
     */
    function checkLocation(args, { needsId }) {
        const bad = (part) => !part || part === '.' || part === '..' || CONTROL.test(part);
        const segments = (value, hint, what) => {
            if (!hint) return;
            const parts = value === undefined || value === null ? [] : String(value).split('/');
            if (parts.length !== hint.split('/').length || parts.some(bad)) {
                throw inputError(`${what} (${hint}) is required`);
            }
        };
        segments(args.parent, parentOf(args.type), 'parent');
        if (!needsId || !idOf(args.type)) return;
        if (own(local, args.type)) {
            const id = args.id === undefined || args.id === null ? '' : String(args.id);
            if (!id || CONTROL.test(id))
                throw inputError(`id (${idOf(args.type)}) is required`);
        } else {
            segments(args.id, idOf(args.type), 'id');
        }
    }

    function catalogSummary(names) {
        const lines = names.map((name) => {
            const t = local[name] || CATALOG[name];
            const parent = t.parent ? ` (parent ${parentOf(name)})` : '';
            const id = idOf(name) ? '' : ' (single, no id)';
            const actions = actionNames(name);
            const ops =
                Object.keys(opsOf(name)).join(' ') +
                (actions.length ? ` | ${actions.join(' ')}` : '');
            return `${name}${parent}${id}: ${expandNotes(t.description)} [${ops}]`;
        });
        return `Resource types, with their operations and, after |, their actions (run with ${toolName('resource_call')}). ${toolName('resource_describe')} with a type gives its schemas and examples.\n\n${lines.join('\n')}`;
    }

    /** Context of a call on a CLI type or action, with its parent and id checked. */
    function localContext(args, { needsId = true, state = {} } = {}) {
        checkLocation(args, { needsId });
        return {
            type: args.type,
            parent: args.parent,
            id: args.id,
            user: args.user,
            filter: args.filter,
            query: args.query,
            full: args.full === true,
            state,
        };
    }

    /** What a CLI function answered, as tool text. */
    const answer = (value) =>
        value === undefined || value === null || value === ''
            ? undefined
            : typeof value === 'string'
              ? value
              : JSON.stringify(value, null, 2);

    /**
     * Validate the type for a verb and build the hook context.
     *
     * @param {Record<string, any>} args
     * @param {import('./catalog.js').Verb} verb
     */
    function prepare(args, verb) {
        const type = args.type;
        if (!type || !served.has(type)) {
            throw inputError(
                `Unknown type "${type ?? ''}". ${toolName('resource_describe')} lists them.`,
            );
        }
        if (!(verb in opsOf(type))) {
            const allowed = Object.keys(opsOf(type)).join(', ');
            throw inputError(`Type "${type}" does not support ${verb} (it supports: ${allowed})`);
        }
        // CLI types: located before any hook runs; the id of a create may
        // still come from the body.
        if (own(local, type)) {
            if (args.merge) throw inputError(`${type} takes no merge: send the fields to change`);
            checkLocation(args, { needsId: verb !== 'list' && verb !== 'create' });
        }
        const ctx = {
            type,
            parent: args.parent,
            id: args.id,
            user: args.user,
            full: args.full === true,
            state: {},
        };
        return { type, ctx, hook: hooks[type] || {} };
    }

    function bodyArg(args, verb) {
        const body = args.body ?? {};
        if (typeof body !== 'object' || body === null) {
            throw inputError('body must be a JSON object (or array where the type takes one)');
        }
        if (BODY_VERBS.has(verb) && verb !== 'create' && !Object.keys(body).length) {
            throw inputError('body is required');
        }
        return body;
    }

    /** Actions as resource_describe shows them: how to run, what they do, their body. */
    function describeActions(actions) {
        return Object.fromEntries(
            Object.entries(actions).map(([a, spec]) => {
                const entry = {
                    run: `${toolName('resource_call')} action "${a}"`,
                    does: expandNotes(spec.description),
                };
                if (typeof spec.run === 'function') {
                    const on = spec.on || 'item';
                    if (on !== 'item') entry.id = on === 'collection' ? 'none' : 'optional';
                    if (spec.body) entry.body = { schema: spec.body };
                } else if (spec.on === 'collection') {
                    entry.id = 'none';
                }
                return [a, entry];
            }),
        );
    }

    /** resource_describe of a CLI type: everything it says comes from its definition. */
    async function describeLocal(name) {
        const t = local[name];
        const out = { type: name, description: expandNotes(t.description) };
        if (t.parent) out.parent = `${t.parent} (write it as "${parentOf(name)}")`;
        out.id = t.id ? idOf(name) : 'none: a single resource of its parent';
        out.operations = operationsOf(opsOf(name));
        if (t.schema) out.fields = t.schema;
        const actions = localActionsOf(name);
        if (Object.keys(actions).length) out.actions = describeActions(actions);
        if (t.notes) out.notes = expandNotes(t.notes);
        if (t.describe) {
            try {
                Object.assign(out, await t.describe());
            } catch (e) {
                out.reference = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
            }
        }
        return Object.entries(out)
            .map(
                ([key, value]) =>
                    `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
            )
            .join('\n');
    }

    async function toolDescribe(args) {
        if (!args.type) {
            // The overview call: the types, plus the guide to the
            // platform's concepts.
            const concepts = await readDoc('concepts').then(
                (d) => d.text,
                () => '',
            );
            return text(
                concepts
                    ? `${catalogSummary([...served])}\n\n---\n\n${concepts}`
                    : catalogSummary([...served]),
            );
        }
        if (!served.has(args.type)) {
            throw inputError(`Unknown type "${args.type}".\n\n${catalogSummary([...served])}`);
        }
        const name = args.type;
        if (own(local, name)) return text(capped(await describeLocal(name)));
        const type = CATALOG[name];
        const out = { type: name, description: expandNotes(type.description) };
        const chain = ancestry(name);
        if (chain.length) out.parent = `${chain.join(' > ')} (write it as "${parentHint(name)}")`;
        out.id = idNames(type).length ? idHint(name) : 'none: a single resource of its parent';
        out.operations = operationsOf(type.ops);
        const allActions = { ...(type.actions || {}), ...localActionsOf(name) };
        if (Object.keys(allActions).length) out.actions = describeActions(allActions);
        if (type.notes) out.notes = expandNotes(type.notes);
        if (type.sdk) {
            out.sdk = await readDoc('dashboard-sdk').then(
                (d) => d.text,
                (e) => `unavailable: ${e.message}`,
            );
        }

        const spec = await serverSpec();
        if (spec.doc) {
            for (const verb of /** @type {const} */ (['create', 'update', 'clone'])) {
                if (!(verb in type.ops)) continue;
                const { method, path } = templateFor(name, verb);
                const body = bodyOf(spec.doc, findOperation(spec.doc, method, path)?.operation);
                if (body) out[verb] = body;
            }
            // What a token needs to allow each verb: the server names the
            // action in each operation's summary, its ResourceType in the
            // operationId prefix (Device_ReadStatus → Device:ReadDeviceStatus).
            const actions = {};
            let resourceType;
            for (const verb of Object.keys(type.ops)) {
                const { method, path } = templateFor(name, /** @type {any} */ (verb));
                const op = findOperation(spec.doc, method, path)?.operation;
                if (!op?.summary) continue;
                resourceType ??= String(op.operationId || '').split('_')[0];
                actions[verb] = op.summary;
            }
            for (const [a] of Object.entries(type.actions || {})) {
                const { method, path } = actionTemplate(name, a);
                const op = findOperation(spec.doc, method, path)?.operation;
                if (op?.summary) {
                    resourceType ??= String(op.operationId || '').split('_')[0];
                    actions[a] = op.summary;
                }
                const body = bodyOf(spec.doc, op);
                if (body && body.schema && JSON.stringify(body.schema) !== '{"type":"object"}') {
                    out.actions[a].body = body;
                }
            }
            if (resourceType) out.permissions = { resource_type: resourceType, actions };
            const read = 'get' in type.ops ? 'get' : /** @type {const} */ ('list');
            if (read in type.ops) {
                const { method, path } = templateFor(name, read);
                const example = responseExample(findOperation(spec.doc, method, path)?.operation);
                if (example !== undefined) out.record_example = example;
            }
        }
        out.schema_source = spec.source;
        // One line per key, schemas without indentation: half the size of
        // pretty-printed JSON, and still easy to read.
        return text(
            Object.entries(shareSchemas(out))
                .map(
                    ([key, value]) =>
                        `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
                )
                .join('\n'),
        );
    }

    async function toolList(args) {
        const { type, ctx } = prepare(args, 'list');
        if (own(local, type)) {
            const lctx = localContext(args, { needsId: false, state: ctx.state });
            const data = (await local[type].list?.(lctx)) ?? [];
            const page = pageOf(type, data, args, true);
            return text(capped(page.text), page.data);
        }
        const params = { ...(CATALOG[type].listQuery || {}), ...(args.filter || {}) };
        // Search: the server matches `name` against ids and names (partial,
        // case-insensitive, as a regular expression: escape it). Lists the
        // server answers whole are searched here instead, over every field.
        const whole = CATALOG[type].listWhole;
        if (args.search && !whole && params.name === undefined) {
            params.name = String(args.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (args.count !== undefined) params.count = args.count;
        if (args.index !== undefined) params.index = args.index;
        let data = await sendList(type, args, params);
        const fields = CATALOG[type].listFields;
        if (fields && Array.isArray(data)) data = data.map((record) => pick(record, fields));
        const page = pageOf(type, data, args, whole);
        return text(page.text, page.data);
    }

    /**
     * A list as resource_list answers it: searched here when the source
     * answers it whole, and paged here when it ignores count/index. `all`
     * (the CLI's, not a tool argument) takes every record. Returns the text
     * and the records shown.
     */
    function pageOf(type, data, args, whole) {
        // Lists answered whole: every word must appear in what a record shows.
        if (args.search && whole && Array.isArray(data)) {
            const words = String(args.search).toLowerCase().split(/\s+/).filter(Boolean);
            data = data.filter((record) => {
                const haystack = JSON.stringify(record).toLowerCase();
                return words.every((w) => haystack.includes(w));
            });
        }
        // Some collections ignore count/index and answer everything: page
        // them here so one call cannot flood the conversation.
        const pageSize = args.count ?? (args.all ? Infinity : 50);
        const from = args.index ?? 0;
        if (Array.isArray(data) && (data.length > pageSize || (whole && from > 0))) {
            const page = data.slice(from, from + pageSize);
            const next =
                from + page.length < data.length
                    ? `; pass index: ${from + page.length} for more, or narrow it with filter`
                    : '';
            return {
                text: `${formatList(type, page, Infinity)}\n(${data.length} in total, showing ${from}–${from + page.length - 1}${next})`,
                data: page,
            };
        }
        return { text: formatList(type, data, whole ? Infinity : pageSize), data };
    }

    async function toolGet(args) {
        const { type, ctx, hook } = prepare(args, 'get');
        const mine = own(local, type);
        let record = mine
            ? await mine.get?.(localContext(args, { state: ctx.state }))
            : await send(type, 'get', args);
        if (hook.afterGet) record = await hook.afterGet(record, ctx);
        if (!mine) return text(JSON.stringify(record, null, 2), record ?? null);
        return text(capped(answer(record) ?? `No ${label(type, args)}.`), record ?? null);
    }

    async function toolCreate(args) {
        const { type, ctx, hook } = prepare(args, 'create');
        if (own(local, type)) return createLocal(args, ctx, hook);
        const t = CATALOG[type];
        let body = bodyArg(args, 'create');
        // `projects` is not a field the server takes on create: set it right
        // after, as update does, so one call leaves the resource in place.
        let projects;
        if (body && typeof body === 'object' && !Array.isArray(body) && 'projects' in body) {
            ({ projects, ...body } = body);
            if (!Array.isArray(projects)) {
                throw inputError('projects must be an array of "<owner>@<project>"');
            }
            if (!('projects' in t.ops)) throw inputError(`${type} cannot belong to projects`);
        }
        // The id can come apart from the body: copy it into the body's id
        // fields when the server takes it there (POST), unless already set.
        if (!t.upsert && args.id !== undefined && !Array.isArray(body)) {
            const fields = t.bodyId ?? idNames(t);
            if (!fields.length) throw inputError(`${type} ids are generated by the server`);
            const ids = String(args.id).split('/');
            if (ids.length !== fields.length) throw inputError(`id must be ${idHint(type)}`);
            body = { ...Object.fromEntries(fields.map((f, i) => [f, ids[i]])), ...body };
        }
        if (hook.beforeCreate) body = await hook.beforeCreate(body, ctx);
        const createdId = args.id ?? bodyIdOf(t, body);
        if (projects && createdId === undefined) {
            const where = (t.bodyId ?? idNames(t)).map((f) => `"${f}"`).join(' and ');
            throw inputError(
                `give the ${type} id to set its projects on create: \`id\`, or the body field ${where}`,
            );
        }
        const result = await send(type, 'create', args, { data: body });
        const lines = [`Created ${label(type, { parent: args.parent, id: createdId })}.`];
        if (projects) {
            await send(type, 'projects', { ...args, id: createdId }, { data: projects });
            lines[0] = lines[0].replace(/\.$/, ` in projects ${JSON.stringify(projects)}.`);
        }
        if (result && typeof result === 'object' && Object.keys(result).length) {
            lines.push(JSON.stringify(result, null, 2));
        }
        const note = hook.afterCreate && (await hook.afterCreate(result, ctx));
        if (note) lines.push('', note);
        return text(lines.join('\n'), created(createdId, result, note, projects));
    }

    /** What a create answers with --json: the id, the server's answer, the hook's note. */
    function created(id, result, note, projects) {
        const out = { id: id ?? null };
        if (projects) out.projects = projects;
        if (result !== undefined && result !== null && result !== '') out.result = result;
        if (note) out.note = note;
        return out;
    }

    async function createLocal(args, ctx, hook) {
        const t = local[args.type];
        let body = bodyArg(args, 'create');
        if (Array.isArray(body)) throw inputError('body must be a JSON object');
        if (t.id && args.id !== undefined && body[t.id] === undefined)
            body = { [t.id]: args.id, ...body };
        // The hook may set or normalise the id: read it after.
        if (hook.beforeCreate) body = await hook.beforeCreate(body, ctx);
        const id = args.id ?? (t.id ? body?.[t.id] : undefined);
        if (t.id && (id === undefined || id === null || id === '')) {
            throw inputError(`give the ${args.type} id: \`id\`, or the body field "${t.id}"`);
        }
        ctx.id = id;
        const lctx = localContext({ ...args, id }, { state: ctx.state });
        const result = await t.create?.(body, lctx);
        const lines = [`Created ${label(args.type, { parent: args.parent, id })}.`];
        const said = answer(result);
        if (said) lines.push(said);
        const note = hook.afterCreate && (await hook.afterCreate(result, ctx));
        if (note) lines.push('', note);
        return text(lines.join('\n'), created(id, result, note));
    }

    async function toolUpdate(args) {
        /** @type {import('./catalog.js').Verb} */
        const verb = args.merge ? 'patch' : 'update';
        if (own(local, args.type)) {
            const { type, ctx, hook } = prepare(args, 'update');
            let body = bodyArg(args, 'update');
            if (Array.isArray(body)) throw inputError('body must be a JSON object');
            if (hook.beforeUpdate) body = await hook.beforeUpdate(body, ctx);
            const result = await local[type].update?.(
                body,
                localContext(args, { state: ctx.state }),
            );
            const said = answer(result);
            return text(
                `Updated ${label(type, args)}: ${Object.keys(body).join(', ')}.${said ? `\n${said}` : ''}`,
                { id: args.id ?? null, fields: Object.keys(body), ...(said ? { result } : {}) },
            );
        }
        const { projects, ...fields } = bodyArg(args, 'update');
        const { type, ctx, hook } = prepare(args, projects !== undefined ? 'projects' : verb);
        const done = [];
        if (projects !== undefined) {
            if (!Array.isArray(projects)) {
                throw inputError('projects must be an array of "<owner>@<project>"');
            }
            await send(type, 'projects', args, { data: projects });
            done.push(`projects set to ${JSON.stringify(projects)}`);
        }
        if (Object.keys(fields).length) {
            prepare(args, verb);
            let body = fields;
            // Profile entries are written whole (the same PUT creates them):
            // keep the fields left out by sending them from the saved entry.
            const t = CATALOG[type];
            if (verb === 'update' && t.upsert && t.ops.get !== t.ops.list) {
                const saved = await send(type, 'get', args);
                if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
                    body = { ...saved, ...fields };
                }
            }
            if (hook.beforeUpdate) body = await hook.beforeUpdate(body, ctx);
            await send(type, verb, args, { data: body });
            done.push(`${args.merge ? 'merged' : 'updated'} ${Object.keys(fields).join(', ')}`);
        }
        return text(`Updated ${label(type, args)}: ${done.join('; ')}.`, {
            id: args.id ?? null,
            fields: Object.keys(fields),
            ...(projects !== undefined ? { projects } : {}),
            ...(args.merge ? { merged: true } : {}),
        });
    }

    async function toolDelete(args) {
        const { type, ctx, hook } = prepare(args, 'delete');
        const mine = own(local, type);
        const result = mine
            ? await mine.delete?.(localContext(args, { state: ctx.state }))
            : await send(type, 'delete', args);
        const lines = [`Deleted ${label(type, args)}.`];
        const said = mine && answer(result);
        if (said) lines.push(said);
        const note = hook.afterDelete && (await hook.afterDelete(ctx));
        if (note) lines.push(note);
        return text(lines.join('\n'), { id: args.id ?? null, ...(note ? { note } : {}) });
    }

    async function toolClone(args) {
        const { type } = prepare(args, 'clone');
        const body = bodyArg(args, 'clone');
        await send(type, 'clone', args, { data: body });
        const copy = bodyIdOf(CATALOG[type], body);
        return text(
            `Cloned ${label(type, args)} as ${copy ? label(type, { parent: args.parent, id: copy }) : JSON.stringify(body)}.`,
            { id: args.id ?? null, copy: copy ?? null },
        );
    }

    /**
     * A streamed answer of progress lines ({"progress": N} per line, as a
     * bucket import sends) shortened to its last line: the rest only fills
     * the context. Anything else is left as is (undefined).
     */
    const lastProgress = (body, ms) => {
        const lines = body.split('\n').filter((l) => l.trim());
        if (lines.length < 2) return undefined;
        let parsed;
        try {
            parsed = lines.map((l) => JSON.parse(l));
        } catch {
            return undefined;
        }
        if (!parsed.every((p) => p && typeof p === 'object' && 'progress' in p)) return undefined;
        return `${lines[lines.length - 1]}\n(${lines.length} progress updates, ${(ms / 1000).toFixed(1)} s)`;
    };

    async function toolCall(args) {
        const type = args.type;
        const known = typeof type === 'string' && served.has(type);
        const mine = known ? own(localActionsOf(type), args.action) : undefined;
        if (mine) {
            const on = mine.on || 'item';
            if (on === 'collection' && args.id !== undefined) {
                throw inputError(`${args.action} takes no id`);
            }
            const ctx = localContext(args, { needsId: on === 'item' });
            const result = await mine.run(args.body, ctx);
            if (isToolResult(result)) {
                return {
                    ...result,
                    content: result.content.map((c) =>
                        c.type === 'text' ? { ...c, text: capped(c.text) } : c,
                    ),
                };
            }
            const said = answer(result);
            return text(capped(said ?? `Ran ${args.action} on ${label(type, args)}.`), result ?? null);
        }
        if (!known || !actionNames(type).length) {
            throw inputError(
                `Type "${type ?? ''}" has no actions. ${toolName('resource_describe')} lists them after |.`,
            );
        }
        if (!own(CATALOG[type]?.actions, args.action)) {
            throw inputError(
                `Type "${type}" has no action "${args.action}" (it has: ${actionNames(type).join(', ')})`,
            );
        }
        const { method, url, query } = actionRequest(type, args.action, args);
        const spec = CATALOG[type].actions?.[args.action];
        const started = Date.now();
        try {
            // Actions that evaluate a resource (test_rule) take the saved one
            // when no body is given.
            const body =
                args.body === undefined && spec?.bodyFromRecord
                    ? pick(await send(type, 'get', args), spec.bodyFromRecord)
                    : args.body;
            const res = await api.request({
                method,
                url,
                data: method === 'get' ? undefined : (body ?? {}),
                params: { ...(args.query || {}), ...(query || {}) },
                paramsSerializer: { indexes: null },
                timeout: TIMEOUTS.API_LONG_MS,
            });
            const data = res.data;
            if (data === undefined || data === null || data === '') {
                return text(`Ran ${args.action} on ${label(type, args)}.`, null);
            }
            if (typeof data !== 'string') return text(JSON.stringify(data, null, 2), data);
            return text(lastProgress(data, Date.now() - started) ?? data, data);
        } catch (e) {
            const err = apiError(e, { notFound: `Not found: ${label(type, args)}` });
            // A 400 on an action called without a body is nearly always the
            // missing body: say what it takes instead of leaving the guess.
            if (e?.response?.status === 400 && args.body === undefined && method !== 'get') {
                err.message += `. ${args.action} takes a body: ${expandNotes(spec?.description || '')} (${toolName('resource_describe')} ${type} shows its schema)`;
            }
            throw err;
        }
    }

    const typeParam = (verb) => ({
        type: 'string',
        enum: verb ? namesWith(verb) : [...served],
        description: 'Resource type (see {tool:resource_describe}).',
    });
    const common = {
        parent: {
            type: 'string',
            description:
                'Parent id, for child types: the device of a device_property, "<device>/<bucket>" for a device_bucket_tag.',
        },
        user: {
            type: 'string',
            description: 'Account to act on (admin only). Omit for your own.',
        },
    };
    const id = { type: 'string', description: 'Resource id.' };
    const body = (description) => ({ type: 'object', description });

    return [
        {
            name: 'resource_describe',
            description:
                "Describe a resource type: its parent and id, the operations it supports and, from this server's API, the request schemas and examples for create, update and clone. Call it before writing a type for the first time. Without `type`: all types and a guide to the platform's concepts (start here).",
            inputSchema: {
                type: 'object',
                properties: { type: typeParam() },
                required: [],
            },
            handler: toolDescribe,
        },
        {
            name: 'resource_list',
            description:
                'List resources of a type, one JSON record per line, in pages of 50 (`count`, `index`). `search` finds by id or name. `filter` narrows by product, type, asset_type, asset_group, project (its short id, "plant_a", not "<owner>@plant_a") or labels (key present), e.g. {"product": "boiler"}; alarm instances also take state and severity. A field of the listed records filters by exact value, nested ones with dots ({"alarm.rule": "r1"}); an array matches any of its values.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('list'),
                    parent: common.parent,
                    filter: { type: 'object', description: 'Query filters (see above).' },
                    search: {
                        type: 'string',
                        description:
                            'Text to look for in ids and names (partial, any case; descriptions are not searched). On the plugin catalog, words matched against every field shown.',
                    },
                    count: { type: 'number', description: 'Page size (default 50).' },
                    index: { type: 'number', description: 'Offset of the first record.' },
                    user: common.user,
                },
                required: ['type'],
            },
            handler: toolList,
        },
        {
            name: 'resource_get',
            description:
                'Read one resource as JSON. Single resources (device_callback, product_profile_code) take only `parent`.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('get'),
                    parent: common.parent,
                    id,
                    full: {
                        type: 'boolean',
                        description:
                            'Plugin catalog manifests: also include the product code and the console dashboard (large). Types that take it say so in their notes.',
                    },
                    user: common.user,
                },
                required: ['type'],
            },
            handler: toolGet,
        },
        {
            name: 'resource_create',
            description:
                'Create a resource from `body`, shaped as {tool:resource_describe} shows. `id` goes into the body\'s id field when the body lacks it; product_profile_* and product_service entries are stored under `id`, replacing any entry of that name. `projects` in the body (["<owner>@<project>"]) also puts the new resource in those projects.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('create'),
                    parent: common.parent,
                    id,
                    body: {
                        type: ['object', 'array'],
                        description:
                            'Fields of the new resource; an array of them creates several at once where the type allows it (properties).',
                    },
                    user: common.user,
                },
                required: ['type'],
            },
            handler: toolCreate,
        },
        {
            name: 'resource_update',
            description:
                'Update a resource with the fields in `body`; fields left out are kept, except for property values, which are replaced unless `merge` is true. `projects` in the body (["<owner>@<project>"]) sets the projects the resource belongs to.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('update'),
                    parent: common.parent,
                    id,
                    body: body('Fields to change.'),
                    merge: {
                        type: 'boolean',
                        description:
                            'Patch (JSON merge) instead of replacing: property types and brands.',
                    },
                    user: common.user,
                },
                required: ['type', 'body'],
            },
            handler: toolUpdate,
        },
        {
            name: 'resource_delete',
            description: 'Delete a resource. Immediate and permanent: confirm with the user first.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('delete'),
                    parent: common.parent,
                    id,
                    user: common.user,
                },
                required: ['type'],
            },
            handler: toolDelete,
        },
        {
            name: 'resource_clone',
            description:
                'Copy a resource under a new id. `body` holds the new id in the type\'s id field (e.g. {"device": "copy_1"}) and optionally name, description and enabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('clone'),
                    parent: common.parent,
                    id,
                    body: body('New id and overrides.'),
                    user: common.user,
                },
                required: ['type', 'id', 'body'],
            },
            handler: toolClone,
        },
        {
            name: 'resource_call',
            description:
                "Run an action of a resource that is not create/read/update/delete: verify a domain, restart a host, call an endpoint, export a product, test an alarm rule… {tool:resource_describe} lists each type's actions (after |) and their bodies.",
            inputSchema: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: [...served].filter((n) => actionNames(n).length),
                        description: 'Resource type.',
                    },
                    action: { type: 'string', description: 'Action name, e.g. "verify".' },
                    parent: common.parent,
                    id,
                    body: { description: 'Action input, when it takes one.' },
                    query: { type: 'object', description: 'Query parameters, when it takes them.' },
                    user: common.user,
                },
                required: ['type', 'action'],
            },
            handler: toolCall,
        },
    ];
}
