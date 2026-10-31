// @ts-check
import api from '../api.js';
import { TIMEOUTS } from '../constants.js';
import { getActiveProfile } from '../config.js';
import { apiError, inputError } from '../errors.js';
import { readDoc } from '../docs.js';
import {
    bundledSpec,
    findOperation,
    findOperationById,
    resolveRefs,
    serverSpec,
} from '../openapi.js';
import {
    CATALOG,
    actionRequest,
    actionTemplate,
    idKey,
    idLevels,
    idNames,
    listed,
    requestFor,
    resolveIds,
    templateFor,
    typeNames,
} from './catalog.js';
import { CORE_ACTIONS, CORE_TYPES } from './core-types.js';
import { toolName } from './naming.js';
import { mergeHooks } from './resource-hooks.js';
import { CLI, textResult } from './helpers.js';

export { CLI, DATA } from './helpers.js';

/**
 * The generic `resource_*` tools: one tool per verb over every type of the
 * catalog, instead of one tool per type and verb. What a type looks like
 * (its fields, the examples the server documents) is not in the tool list
 * but behind `resource_describe`, read from the server's own OpenAPI
 * document when the model needs it.
 */

/**
 * Types and actions served next to the catalog's: the core's own
 * (core-types.js: data, files, device resources, guides, profiles) and a
 * CLI's (`runCli({ resourceTypes, resourceActions })`), its platform's own
 * things. Such a type has no REST path: its functions answer each verb.
 *
 * What reaches those functions comes from the model: `ids` are checked
 * (every one the type needs, none empty, `.`, `..` or with control
 * characters), and `filter` and the bodies against their schemas when the
 * type declares them, but values are still untrusted input, to be
 * validated before use.
 *
 * @typedef {object} LocalContext
 * @property {string} type
 * @property {Record<string, string>} ids  Every id, by name.
 * @property {string} [parent]  The parents' ids, outermost first, joined with "/".
 * @property {string} [id]      The record's own id (it may hold "/": a path).
 * @property {string | null} [user]
 * @property {Record<string, any>} [filter]  resource_list's filter.
 * @property {Record<string, any>} [query]   resource_call's query.
 * @property {number} [count]   resource_list's count, for lists not paged by the tool.
 * @property {boolean} [full]
 * @property {boolean} [confirmed]  An action that asks first: the user agreed (body.confirm).
 * @property {(plan: string) => any} [plan]  An action that asks first: answer what it would
 *   do instead of doing it (return what this gives).
 * @property {Record<string, any>} state
 *
 * @typedef {object} LocalAction
 * @property {string} description
 * @property {'item' | 'collection' | 'either'} [on]  Whether it takes its own id: item
 *   (default) needs one, collection takes none, either takes it or not.
 * @property {object} [body]  JSON schema of its body, shown by resource_describe and checked
 *   when it has properties (unknown keys too, unless additionalProperties is true).
 * @property {boolean} [bodyRequired]  Refused without a body.
 * @property {boolean} [query]  It reads the call's `query`.
 * @property {boolean} [readOnly]  Changes nothing: served in read-only mode.
 * @property {boolean} [confirm]  May ask first: its run returns ctx.plan(…) unless
 *   ctx.confirmed, when what it would do has a high impact.
 * @property {string | string[]} [op]  The server operations it runs (for describe's
 *   permissions, and for a server to run it natively).
 * @property {boolean} [local]  Runs on the machine of this CLI: no server operation.
 * @property {import('./catalog.js').Example[]} [examples]
 * @property {(body: any, ctx: LocalContext) => any} run  Returns the answer: text,
 *   anything JSON, or a whole tool result ({content: [{type, text}], isError}) to flag a
 *   failure (only actions can; the verbs answer text or JSON).
 *
 * @typedef {object} LocalType
 * @property {string} description  One line, shown in the catalog summary.
 * @property {string} [parent]  Type this one hangs off (the server's or another one
 *   with an id): its ids come first in `ids`.
 * @property {string} [id]      Name of its own id in `ids`; without one, a single record of
 *   its parent (or a list whose records are not addressed one by one).
 * @property {string} [bodyId]  Field of the record that holds its id, when not `id`: create
 *   copies `ids[id]` into it.
 * @property {string} [recordId]  Field of a listed record that holds its id, when it is
 *   neither bodyId nor `id` (the records come from elsewhere: a path, a name).
 * @property {string} [notes]   Longer guidance returned by resource_describe.
 * @property {object} [schema]  JSON schema of a record, the body of create and update.
 * @property {object} [filter]  JSON schema of the filter its list takes (checked).
 * @property {false} [paged]    false: the list is answered as the function returns it, with
 *   neither search nor paging (the function reads `count`).
 * @property {Array<'create' | 'update'>} [optionalId]  Verbs that may go without the own id.
 * @property {false} [profile]  false: takes no `profile` (the profiles themselves).
 * @property {false} [user]     false: takes no `user`.
 * @property {Partial<Record<string, string | string[]>>} [ops]  The server operations of each
 *   verb (for describe's permissions, and for a server to serve it natively).
 * @property {boolean} [local]  Runs on the machine of this CLI: no server operation.
 * @property {import('./catalog.js').Example[]} [examples]
 * @property {() => Record<string, any> | Promise<Record<string, any>>} [describe]  More
 *   for resource_describe to show (a reference the type's records follow, say).
 * @property {(ctx: LocalContext) => any[] | Promise<any[]>} [list]  The whole list:
 *   search and paging are done by the tool (unless paged is false).
 * @property {(ctx: LocalContext) => any} [get]
 * @property {(body: any, ctx: LocalContext) => any} [create]  Returns a result or a note.
 * @property {(body: any, ctx: LocalContext) => any} [update]
 * @property {(ctx: LocalContext) => any} [delete]
 * @property {Record<string, LocalAction>} [actions]
 */

const LOCAL_VERBS = /** @type {const} */ (['list', 'get', 'create', 'update', 'delete']);
const ACTION_ON = new Set(['item', 'collection', 'either']);

/** Tools that only read: the ones served in read-only mode, with resource_call's read-only actions. */
const READ_TOOLS = new Set(['resource_describe', 'resource_list', 'resource_get', 'resource_call']);

/** The last line of what an action that asks first answers. */
const CONFIRM_HINT =
    'Run again with confirm: true in the body to do it; confirm it with the user first.';

/** Key of what ctx.plan gives: an action that asks first answers this instead of acting. */
const PLAN = Symbol('plan');

/**
 * What the MCP server hands a tool next to its arguments.
 *
 * @typedef {object} ToolExtra
 * @property {(message: string) => Promise<boolean>} [elicit]  Ask the user to confirm
 *   (when the client supports elicitation); true when they did.
 */

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
 * Check what a CLI adds against the catalog and the core's types: a type
 * or an action that clashes with theirs is a mistake, found when the
 * server starts.
 *
 * @param {Record<string, LocalType>} types
 * @param {Record<string, Record<string, LocalAction>>} actions
 */
export function checkLocal(types, actions) {
    for (const [name, t] of Object.entries(types)) {
        if (CATALOG[name]) throw new Error(`Resource type "${name}" is already a server type`);
        if (own(CORE_TYPES, name))
            throw new Error(`Resource type "${name}" is already a core type`);
        if (!t.description) throw new Error(`Resource type "${name}" needs a description`);
        if (t.parent && !CATALOG[t.parent] && !own(types, t.parent) && !own(CORE_TYPES, t.parent)) {
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
        if (!CATALOG[type] && !types[type] && !own(CORE_TYPES, type)) {
            throw new Error(`Actions for unknown resource type "${type}"`);
        }
        for (const [a, spec] of Object.entries(list)) {
            const core = own(CORE_ACTIONS, type)?.[a] ?? own(CORE_TYPES, type)?.actions?.[a];
            if (CATALOG[type]?.actions?.[a] || types[type]?.actions?.[a] || core) {
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

/** An operation in a text: `{op:<type>.<verb or action>}`. */
const OP_REF = /\{op:([a-z0-9_]+)\.([a-z0-9_]+)\}/g;

/** JSON type of a value, as a schema names it. */
function jsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** A schema type (or several) as an error names it: "a JSON object or an array". */
const typeWords = (type) =>
    [type]
        .flat()
        .map(
            (t) =>
                ({
                    object: 'a JSON object',
                    array: 'an array',
                    integer: 'an integer',
                    null: 'null',
                })[t] ?? `a ${t}`,
        )
        .join(' or ');

/** Whether `value` is of the schema type (or one of them). */
function typeOk(value, type) {
    const types = [type].flat();
    const actual = jsonType(value);
    return types.some(
        (t) =>
            t === actual ||
            (t === 'integer' && Number.isInteger(value)) ||
            (t === 'number' && actual === 'number'),
    );
}

/**
 * Check a value against the top level of its schema: its type, the keys
 * it requires, keys it does not take (unless additionalProperties is true,
 * or `unknown` is false) and each key's type and allowed values. Free
 * values (no properties) pass. The errors say what it takes.
 *
 * @param {unknown} value
 * @param {any} schema
 * @param {string} where  What it is, for the errors: "filter of bucket_data".
 * @param {{ unknown?: boolean }} [opts]
 */
export function checkShape(value, schema, where, { unknown = true } = {}) {
    if (!schema || typeof schema !== 'object' || value === undefined) return;
    if (schema.type && !typeOk(value, schema.type)) {
        throw inputError(`${where} must be ${typeWords(schema.type)}`);
    }
    const props = schema.properties;
    if (!props || jsonType(value) !== 'object') return;
    const record = /** @type {Record<string, any>} */ (value);
    const missing = (schema.required || []).filter((k) => record[k] === undefined);
    if (missing.length) throw inputError(`${where} needs ${listed(missing)}`);
    if (unknown && schema.additionalProperties !== true) {
        const stray = Object.keys(record).filter((k) => !Object.hasOwn(props, k));
        if (stray.length) {
            throw inputError(
                `${where} has no ${stray.map((k) => `"${k}"`).join(', ')}; it takes: ${Object.keys(props).join(', ')}`,
            );
        }
    }
    for (const [key, v] of Object.entries(record)) {
        const field = own(props, key);
        if (!field || v === undefined) continue;
        if (field.type && !typeOk(v, field.type)) {
            throw inputError(`${where}: ${key} must be ${typeWords(field.type)}`);
        }
        if (Array.isArray(field.enum) && !field.enum.includes(v)) {
            throw inputError(
                `${where}: ${key} must be one of ${field.enum.map((e) => JSON.stringify(e)).join(', ')}`,
            );
        }
    }
}

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
 * @param {Record<string, any>} [ids]
 */
function label(type, ids = {}) {
    const where = Object.values(ids || {})
        .filter((v) => v !== undefined && v !== null && v !== '')
        .join('/');
    return where ? `${type} ${where}` : type;
}

/** The field of a catalog record that holds its id, as `create` and `clone` bodies write it. */
const idField = (t) => (t.bodyId ?? idNames(t))[0];

/** The id a create or clone body names, when it carries the id field. */
function bodyIdOf(t, body) {
    const field = idField(t);
    if (!field || !body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const id = body[field];
    return id !== undefined && id !== null && id !== '' ? String(id) : undefined;
}

/**
 * @param {string} type
 * @param {import('./catalog.js').Verb} verb
 * @param {{ ids?: Record<string, any>, user?: string | null }} args
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
        throw apiError(e, { notFound: `Not found: ${label(type, args.ids)}` });
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

/**
 * One record per line: lists stay readable without paying for indentation.
 * `shown` gives what a line shows of a record (its ids first, for agents).
 */
function formatList(type, data, pageSize, shown = (record) => record) {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (!data.length) return `No ${type} found.`;
    const lines = data.map((item) => JSON.stringify(shown(item)));
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
 * Sample ids for the examples resource_describe makes up: real-looking
 * values, never placeholders.
 */
const SAMPLE_IDS = {
    device: 'boiler',
    product: 'boiler_kit',
    bucket: 'temps',
    storage: 'web_app',
    dashboard: 'plant_overview',
    endpoint: 'alert_webhook',
    property: 'setpoint',
    project: 'plant_a',
    rule: 'high_temp',
    instance: 'high_temp_boiler',
    type: 'boiler',
    group: 'plant_a',
    token: 'dashboard_viewer',
    plugin: 'node-red',
    resource: 'uplink',
    tag: 'device',
    user: 'alice',
    host: 'console.example.com',
};
const sampleId = (key) => SAMPLE_IDS[key] ?? `my_${key}`;

/**
 * The tools, over the catalog, the core's types and what the CLI adds.
 *
 * @param {{
 *   hooks?: Record<string, import('./resource-hooks.js').ResourceHooks>,
 *   types?: Record<string, LocalType>,
 *   actions?: Record<string, Record<string, LocalAction>>,
 *   readOnly?: boolean,
 * }} [opts]  `readOnly`: serve only what reads (describe, list, get, and
 *   resource_call with the read-only actions).
 * @returns {Array<Record<string, any>>}  The tools: name, description, inputSchema,
 *   annotations, handler(args, extra) and explain(args, unknownKeys).
 */
export function resourceTools({
    hooks: extraHooks,
    types: cliTypes = {},
    actions: cliActions = {},
    readOnly = false,
} = {}) {
    checkLocal(cliTypes, cliActions);
    const hooks = mergeHooks(extraHooks);
    /** @type {Record<string, LocalType>} */
    const local = { ...CORE_TYPES, ...cliTypes };
    /** @type {Record<string, Record<string, LocalAction>>} */
    const extra = {};
    for (const [type, list] of [...Object.entries(CORE_ACTIONS), ...Object.entries(cliActions)]) {
        extra[type] = { ...(extra[type] || {}), ...list };
    }
    /** Core types and actions are served whole; a CLI's answers are capped. */
    const isCore = (type, action) =>
        action
            ? !!(own(CORE_ACTIONS, type)?.[action] ?? own(CORE_TYPES, type)?.actions?.[action])
            : !!own(CORE_TYPES, type);
    const cap = (type, action, t) => (isCore(type, action) ? String(t ?? '') : capped(t));
    const served = new Set([...typeNames(), ...Object.keys(local)]);

    /** Verbs of a type: the catalog's, or the functions a local type has. */
    const opsOf = (name) =>
        own(local, name)
            ? Object.fromEntries(
                  LOCAL_VERBS.filter((v) => typeof local[name][v] === 'function').map((v) => [
                      v,
                      'cli',
                  ]),
              )
            : CATALOG[name].ops;
    /** The verbs this server runs on a type: in read-only mode, list and get. */
    const servedOps = (name) =>
        Object.fromEntries(
            Object.entries(opsOf(name)).filter(([v]) => !readOnly || v === 'list' || v === 'get'),
        );
    /** Actions the core or a CLI adds, to their own types or to the server's. */

    const localActionsOf = (name) => ({
        ...(own(local, name)?.actions || {}),
        ...(own(extra, name) || {}),
    });
    /** Every action of a type, the catalog's and the added ones. */
    const allActionsOf = (name) => ({ ...(CATALOG[name]?.actions || {}), ...localActionsOf(name) });
    const actionNames = (name) =>
        Object.entries(allActionsOf(name))
            .filter(([, spec]) => !readOnly || spec.readOnly)
            .map(([a]) => a);
    const namesWith = (verb) => [...served].filter((n) => verb in opsOf(n));
    const actionTypes = () => [...served].filter((n) => actionNames(n).length);
    const levelsOf = (name) => idLevels(name, local);
    /** Whether a type has an id of its own (not a single record of its parent). */
    const hasOwnId = (name) => (own(local, name) ? !!local[name].id : idKey(name) !== undefined);

    /**
     * `{op:t.v}` → the call that runs it, checked: a typo in a text fails
     * when the tools are built, not when a model follows it.
     */
    const expand = (text) =>
        expandNotes(text).replace(OP_REF, (all, type, op) => {
            if (!served.has(type)) throw new Error(`${all}: unknown type "${type}"`);
            if (op === 'describe') return `${toolName('resource_describe')} type "${type}"`;
            if (op in opsOf(type)) return `${toolName(`resource_${op}`)} type "${type}"`;
            if (op in allActionsOf(type)) {
                return `${toolName('resource_call')} type "${type}" action "${op}"`;
            }
            throw new Error(`${all}: ${type} has no operation "${op}"`);
        });

    // Every reference of every text, checked now.
    for (const name of served) {
        const t = own(local, name) ?? CATALOG[name];
        for (const text of [
            t.description,
            t.notes,
            ...Object.values(allActionsOf(name)).map((a) => a.description),
        ]) {
            if (text) expand(text);
        }
    }

    /** Describe's line about a type's ids
: their names, and the REST names where they differ. */
    function idsLine(name) {
        const levels = levelsOf(name);
        if (!levels.length) return 'none';
        const mine = hasOwnId(name) ? levels.at(-1) : undefined;
        const shape = levels
            .map((l) => `"${l.key}": <${l === mine ? 'its own id' : `${l.type} id`}>`)
            .join(', ');
        // `type` of an asset type is an id, not the type argument.
        const clash = levels.some((l) => l.key === 'type')
            ? '; ids.type is the id, not the `type` argument'
            : '';
        return `{${shape}}${clash}`;
    }

    /** What describe says about the own id of a create. */
    function ownIdRule(name) {
        if (!hasOwnId(name)) return undefined;
        const key = levelsOf(name).at(-1)?.key;
        if (own(local, name)) {
            const t = local[name];
            if (!('create' in opsOf(name))) return undefined;
            if (t.optionalId?.includes('create')) return `optional on create`;
            return `required: in ids.${key}, or the body field "${t.bodyId ?? t.id}"`;
        }
        const t = CATALOG[name];
        if (!('create' in t.ops)) return undefined;
        if (t.upsert) return `required on create, in ids.${key} (the entry is stored under it)`;
        if (!idField(t)) return `generated by the server: create takes none`;
        return `create takes it in ids.${key} or in the body field "${idField(t)}"`;
    }

    /** The ids of a record a list or get answered, to pass back as they are. */
    function recordIds(type, record, parentIds, key) {
        if (!hasOwnId(type)) return { ...parentIds };
        const mine = levelsOf(type).at(-1);
        let value;
        if (own(local, type)) {
            const t = local[type];
            const field = t.recordId ?? t.bodyId ?? t.id;
            value =
                record && typeof record === 'object'
                    ? record[/** @type {string} */ (field)]
                    : undefined;
        } else {
            const t = CATALOG[type];
            const rule = t.recordId || {};
            if (rule.from === 'key') value = key;
            else if (rule.from === 'value') value = typeof record === 'string' ? record : undefined;
            else if (record && typeof record === 'object')
                value = record[rule.field ?? idField(t) ?? t.id];
        }
        if (value === undefined || value === null || value === '') return undefined;
        return { ...parentIds, [/** @type {any} */ (mine).key]: String(value) };
    }

    /** A record as agents see it: its ids first. */
    function withIds(type, record, parentIds, key) {
        if (!hasOwnId(type)) return record;
        const ids = recordIds(type, record, parentIds, key);
        if (!ids) return record;
        if (typeof record === 'string') return { ids };
        return record && typeof record === 'object' && !Array.isArray(record)
            ? { ids, ...record }
            : record;
    }

    /** The parents' ids of a call, by name. */
    const parentIdsOf = (type, ids) => {
        const keys = levelsOf(type)
            .slice(0, hasOwnId(type) ? -1 : undefined)
            .map((l) => l.key);
        return Object.fromEntries(keys.map((k) => [k, ids[k]]));
    };

    function catalogSummary(names) {
        const lines = names.map((name) => {
            const t = local[name] || CATALOG[name];
            const keys = levelsOf(name).map((l) => l.key);
            const single = !hasOwnId(name) && !('list' in opsOf(name));
            const shown =
                single || t.parent || (keys.length && keys[0] !== name)
                    ? ` (ids ${keys.join(', ')}${single ? '; single record' : ''})`
                    : '';
            const actions = actionNames(name);
            const ops =
                Object.keys(opsOf(name)).join(' ') +
                (actions.length ? ` | ${actions.join(' ')}` : '');
            return `${name}${shown}: ${expand(t.description)} [${ops}]`;
        });
        return `Resource types, with their operations and, after |, their actions (run with ${toolName('resource_call')}). ${toolName('resource_describe')} with a type gives its ids, schemas and ready-to-send examples.\n\n${lines.join('\n')}`;
    }

    /**
     * Check a call's `ids` for a type and verb: what resolveIds gives, plus
     * the parents' ids joined (`parent`), as the context of hooks and of
     * local types has them.
     *
     * @param {string} type
     * @param {Record<string, any>} args
     * @param {'required' | 'optional' | 'forbidden'} ownRule
     * @param {(key: string) => string} [forbidden]
     */
    function where(type, args, ownRule, forbidden) {
        const resolved = resolveIds(type, args.ids, { own: ownRule, forbidden, local });
        return {
            ids: resolved.ids,
            parent: resolved.levels.length ? resolved.levels.join('/') : undefined,
            id: resolved.own,
        };
    }

    /** Context of a call on a local type or action, its ids already checked. */
    function localContext(args, at, { state = {}, confirmed = false } = {}) {
        return {
            type: args.type,
            ids: at.ids,
            parent: at.parent,
            id: at.id,
            user: args.user,
            filter: args.filter,
            query: args.query,
            count: args.count,
            full: args.full === true,
            confirmed,
            plan: (text) => ({ [PLAN]: text }),
            state,
        };
    }

    /** What a local function answered, as tool text. */
    const answer = (value) =>
        value === undefined || value === null || value === ''
            ? undefined
            : typeof value === 'string'
              ? value
              : JSON.stringify(value, null, 2);

    /** Every type, for the error of an unknown one. */
    const unknownType = (type) =>
        inputError(
            `Unknown type "${type ?? ''}". Types: ${[...served].join(', ')} (${toolName('resource_describe')} describes them).`,
        );

    /**
     * Validate the type for a verb, its ids and the arguments it refuses,
     * and build the hook context.
     *
     * @param {Record<string, any>} args
     * @param {import('./catalog.js').Verb} verb
     */
    function prepare(args, verb) {
        const type = args.type;
        if (!type || !served.has(type)) throw unknownType(type);
        if (!(verb in opsOf(type))) {
            const allowed = Object.keys(opsOf(type)).join(', ') || 'none';
            const others = namesWith(verb).join(', ');
            throw inputError(
                `Type "${type}" does not support ${verb} (it supports: ${allowed}). Types with ${verb}: ${others}.`,
            );
        }
        const t = own(local, type);
        if (t?.user === false && args.user !== undefined) {
            throw inputError(`${type} takes no user: it is the same for every account`);
        }
        if (t?.profile === false && args.profile !== undefined) {
            throw inputError(`${type} takes no profile: it lists this CLI's own`);
        }
        if (t && args.merge) throw inputError(`${type} takes no merge: send the fields to change`);
        const ownRule =
            verb === 'list'
                ? 'forbidden'
                : verb === 'create' || (t?.optionalId?.includes(/** @type {any} */ (verb)) ?? false)
                  ? 'optional'
                  : 'required';
        const at = where(
            type,
            args,
            ownRule,
            (key) => `${verb} takes no ${key}: leave it out of ids`,
        );
        const ctx = {
            type,
            ids: at.ids,
            parent: at.parent,
            id: at.id,
            user: args.user,
            full: args.full === true,
            merge: args.merge === true,
            state: {},
        };
        return { type, at, ctx, hook: hooks[type] || {} };
    }

    /**
     * The body of a create, update or clone, without the `ids` a record
     * read before carries: they must point where the call does.
     */
    function bodyArg(args, verb) {
        const body = args.body ?? {};
        if (typeof body !== 'object' || body === null) {
            throw inputError('body must be a JSON object (or array where the type takes one)');
        }
        if (Array.isArray(body)) return body;
        const { ids: carried, ...rest } = body;
        if (carried !== undefined && carried !== null && typeof carried === 'object') {
            const given = args.ids || {};
            const differ = Object.entries(carried).some(
                ([k, v]) => given[k] !== undefined && String(given[k]) !== String(v),
            );
            if (differ) {
                throw inputError(
                    `body.ids points at ${Object.values(carried).join('/')} but ids at ${Object.values(given).join('/')}`,
                );
            }
        }
        // A clone says which id it lacks.
        if (verb === 'update' && !Object.keys(rest).length) {
            throw inputError('body is required');
        }
        return rest;
    }

    /** Actions as resource_describe shows them: how to run, what they do, their body. */
    function describeActions(name) {
        return Object.fromEntries(
            Object.entries(allActionsOf(name))
                .filter(([, spec]) => !readOnly || spec.readOnly)
                .map(([a, spec]) => {
                    const entry = {
                        run: `${toolName('resource_call')} type "${name}" action "${a}"`,
                        does: expand(spec.description),
                    };
                    const on = spec.on || 'item';
                    const key = levelsOf(name).at(-1)?.key;
                    if (on === 'collection') entry.ids = `parents only: no ${key}`;
                    if (on === 'either') entry.ids = `${key} optional`;
                    if (spec.readOnly) entry.read_only = true;
                    if (spec.bodyRequired) entry.body_required = true;
                    if (spec.confirm) {
                        entry.asks_first =
                            'without body.confirm: true it answers what it would do instead of doing it';
                    }
                    if (spec.local) entry.runs = 'on the machine of this CLI';
                    if (typeof spec.run === 'function' && spec.body)
                        entry.body = { schema: spec.body };
                    return [a, entry];
                }),
        );
    }

    /** The examples of a type: its own and its actions', then made-up ones for the verbs left. */
    function examplesOf(name) {
        const t = own(local, name) ?? CATALOG[name];
        const given = [
            ...(t.examples || []),
            ...Object.values(allActionsOf(name)).flatMap((a) => a.examples || []),
        ];
        const covered = new Set(given.map((e) => e.tool));
        const levels = levelsOf(name);
        const all = Object.fromEntries(levels.map((l) => [l.key, sampleId(l.key)]));
        const parents = hasOwnId(name) ? Object.fromEntries(Object.entries(all).slice(0, -1)) : all;
        const made = [];
        const idsArg = (ids) => (Object.keys(ids).length ? { ids } : {});
        if ('list' in opsOf(name) && !covered.has('resource_list')) {
            made.push({
                tool: 'resource_list',
                arguments: { type: name, ...idsArg(parents) },
                does: `List the ${name} records.`,
            });
        }
        if ('get' in opsOf(name) && !covered.has('resource_get')) {
            made.push({
                tool: 'resource_get',
                arguments: { type: name, ...idsArg(all) },
                does: `Read one ${name}.`,
            });
        }
        return [...given, ...made].filter(allowedExample);
    }

    /** Whether this server runs an example: in read-only mode, only reads. */
    function allowedExample(e) {
        if (!readOnly) return true;
        if (!READ_TOOLS.has(e.tool)) return false;
        if (e.tool !== 'resource_call') return true;
        return !!own(allActionsOf(e.arguments.type), e.arguments.action)?.readOnly;
    }

    /** Examples as describe prints them: one JSON call per line. */
    const exampleLines = (examples) =>
        examples
            .map((e) =>
                JSON.stringify({ tool: toolName(e.tool), arguments: e.arguments, does: e.does }),
            )
            .join('\n');

    /** What a token needs to allow each verb and action of a local type, from their operations. */
    function localPermissions(doc, name) {
        const ops = {
            ...Object.fromEntries(
                Object.entries(own(local, name)?.ops || {}).map(([verb, op]) => [verb, op]),
            ),
            ...Object.fromEntries(
                Object.entries(localActionsOf(name))
                    .filter(([, a]) => a.op)
                    .map(([a, spec]) => [a, spec.op]),
            ),
        };
        const actions = {};
        let resourceType;
        for (const [what, op] of Object.entries(ops)) {
            const found = [op]
                .flat()
                .map((id) => findOperationById(doc, /** @type {string} */ (id)))
                .filter(Boolean);
            if (!found.length) continue;
            resourceType ??= String(found[0].operationId).split('_')[0];
            actions[what] = [...new Set(found.map((o) => o.summary).filter(Boolean))].join(', ');
        }
        return resourceType ? { resource_type: resourceType, actions } : undefined;
    }

    /** resource_describe of a local type: everything it says comes from its definition. */
    async function describeLocal(name) {
        const t = local[name];
        const out = { type: name, description: expand(t.description) };
        out.ids = idsLine(name);
        const rule = ownIdRule(name);
        if (rule && !readOnly) out.own_id = rule;
        out.operations = operationsOf(servedOps(name));
        if (t.filter) out.filter = t.filter;
        if (t.schema) out.fields = t.schema;
        if (Object.keys(allActionsOf(name)).length) out.actions = describeActions(name);
        if (t.notes) out.notes = expand(t.notes);
        if (t.local) out.runs = 'on the machine of this CLI';
        if (hooks[name]?.describe) out.cli = await hooks[name].describe();
        if (t.describe) {
            try {
                Object.assign(out, await t.describe());
            } catch (e) {
                out.reference = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
            }
        }
        const spec = await serverSpec().catch(() => ({ doc: null }));
        if (spec.doc) {
            const permissions = localPermissions(spec.doc, name);
            if (permissions) out.permissions = permissions;
        }
        const lines = Object.entries(out).map(
            ([key, value]) =>
                `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        );
        return `${lines.join('\n')}\nexamples:\n${exampleLines(examplesOf(name))}`;
    }

    /**
     * The examples of the overview: the calls agents need most, taken from
     * the types' own, and a property set.
     */
    function overviewExamples() {
        const pick = (type, test) => examplesOf(type).find(test);
        const picked = [
            pick('bucket_data', (e) => e.tool === 'resource_list'),
            pick('storage_file', (e) => e.tool === 'resource_create'),
            pick('device_resource', (e) => e.tool === 'resource_call'),
            pick('device', (e) => e.arguments.action === 'send'),
            pick('dashboard', (e) => e.arguments.action === 'publish'),
            pick('doc', (e) => e.tool === 'resource_get'),
            {
                tool: 'resource_update',
                arguments: {
                    type: 'device_property',
                    ids: { device: 'boiler', property: 'setpoint' },
                    body: { value: { target: 21.5 } },
                },
                does: 'Set the value of a device property.',
            },
        ];
        return exampleLines(picked.filter((e) => e && allowedExample(e)));
    }

    async function toolDescribe(args) {
        if (args.type === undefined || args.type === '') {
            // The overview call: the types, examples, and the guide to the
            // platform's concepts.
            const concepts = await readDoc('concepts').then(
                (d) => d.text,
                () => '',
            );
            const examples = overviewExamples();
            const summary = `${catalogSummary([...served])}${examples ? `\n\nExamples, one call per line:\n${examples}` : ''}`;
            return text(concepts ? `${summary}\n\n---\n\n${concepts}` : summary);
        }
        if (!served.has(args.type)) throw unknownType(args.type);
        const name = args.type;
        if (own(local, name)) return text(cap(name, undefined, await describeLocal(name)));
        const type = CATALOG[name];
        const out = { type: name, description: expand(type.description) };
        out.ids = idsLine(name);
        const rule = ownIdRule(name);
        if (rule && !readOnly) out.own_id = rule;
        const verbs = servedOps(name);
        out.operations = operationsOf(verbs);
        const actions = describeActions(name);
        if (Object.keys(actions).length) out.actions = actions;
        if (type.notes) out.notes = expand(type.notes);
        if (type.sdk) {
            out.sdk = await readDoc('dashboard-sdk').then(
                (d) => d.text,
                (e) => `unavailable: ${e.message}`,
            );
        }
        if (hooks[name]?.describe) out.cli = await hooks[name].describe();

        const spec = await serverSpec();
        if (spec.doc) {
            for (const verb of /** @type {const} */ (['create', 'update', 'clone'])) {
                if (!(verb in verbs)) continue;
                const { method, path } = templateFor(name, verb);
                const body = bodyOf(spec.doc, findOperation(spec.doc, method, path)?.operation);
                if (body) out[verb] = body;
            }
            // What a token needs to allow each verb: the server names the
            // action in each operation's summary, its ResourceType in the
            // operationId prefix (Device_ReadStatus → Device:ReadDeviceStatus).
            const allowed = {};
            let resourceType;
            for (const verb of Object.keys(verbs)) {
                const { method, path } = templateFor(name, /** @type {any} */ (verb));
                const op = findOperation(spec.doc, method, path)?.operation;
                if (!op?.summary) continue;
                resourceType ??= String(op.operationId || '').split('_')[0];
                allowed[verb] = op.summary;
            }
            for (const [a] of Object.entries(type.actions || {})) {
                if (!actions[a]) continue;
                const { method, path } = actionTemplate(name, a);
                const op = findOperation(spec.doc, method, path)?.operation;
                if (op?.summary) {
                    resourceType ??= String(op.operationId || '').split('_')[0];
                    allowed[a] = op.summary;
                }
                const body = bodyOf(spec.doc, op);
                if (body && body.schema && JSON.stringify(body.schema) !== '{"type":"object"}') {
                    actions[a].body = body;
                }
            }
            // The core's and the CLI's actions on it name their operations.
            const added = localPermissions(spec.doc, name);
            for (const [a, summary] of Object.entries(added?.actions || {})) {
                if (actions[a]) allowed[a] = summary;
            }
            resourceType ??= added?.resource_type;
            if (resourceType) out.permissions = { resource_type: resourceType, actions: allowed };
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
        const lines = Object.entries(shareSchemas(out)).map(
            ([key, value]) =>
                `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        );
        return text(`${lines.join('\n')}\nexamples:\n${exampleLines(examplesOf(name))}`);
    }

    async function toolList(args) {
        const { type, at, ctx } = prepare(args, 'list');
        // Records carry the ids to pass back; a person reading the CLI's
        // output does not need them.
        const shown = (record, key) => (args[CLI] ? record : withIds(type, record, at.ids, key));
        const mine = own(local, type);
        if (mine) {
            if (mine.filter) checkShape(args.filter, mine.filter, `filter of ${type}`);

            if (mine.paged === false) {
                if (args.search !== undefined) {
                    throw inputError(`${type} takes no search: narrow it with filter`);
                }
                if (args.index !== undefined) throw inputError(`${type} takes no index`);
            }
            const data = (await mine.list?.(localContext(args, at, { state: ctx.state }))) ?? [];
            if (mine.paged === false) {
                const said = Array.isArray(data)
                    ? formatList(type, data, Infinity, shown)
                    : (answer(data) ?? `No ${type} found.`);
                return text(cap(type, undefined, said), data);
            }
            const page = pageOf(type, data, args, true, shown);
            return text(cap(type, undefined, page.text), page.data);
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
        let data = await sendList(type, { ids: at.ids, user: args.user }, params);
        const fields = CATALOG[type].listFields;
        if (fields && Array.isArray(data)) data = data.map((record) => pick(record, fields));
        // Maps (product profile categories): each entry under its id.
        if (data && typeof data === 'object' && !Array.isArray(data) && !args[CLI]) {
            const entries = Object.entries(data).map(([key, record]) => [key, shown(record, key)]);
            return text(JSON.stringify(Object.fromEntries(entries), null, 2), data);
        }
        const page = pageOf(type, data, args, whole, shown);
        return text(page.text, page.data);
    }

    /**
     * A list as resource_list answers it: searched here when the source
     * answers it whole, and paged here when it ignores count/index. `all`
     * (the CLI's, not a tool argument) takes every record. Returns the text
     * and the records shown.
     */
    function pageOf(type, data, args, whole, shown) {
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
                text: `${formatList(type, page, Infinity, shown)}\n(${data.length} in total, showing ${from}–${from + page.length - 1}${next})`,
                data: page,
            };
        }
        return { text: formatList(type, data, whole ? Infinity : pageSize, shown), data };
    }

    /** A plain record: what `ids` can go in front of. */
    const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

    async function toolGet(args) {
        const { type, at, ctx, hook } = prepare(args, 'get');
        const mine = own(local, type);
        let record = mine
            ? await mine.get?.(localContext(args, at, { state: ctx.state }))
            : await send(type, 'get', { ids: at.ids, user: args.user });
        if (hook.afterGet) record = await hook.afterGet(record, ctx);
        // The ids it was read with are the ones to pass back.
        const shown = isRecord(record) && !args[CLI] ? { ids: at.ids, ...record } : record;
        if (!mine) return text(JSON.stringify(shown, null, 2), record ?? null);
        return text(
            cap(type, undefined, answer(shown) ?? `No ${label(type, at.ids)}.`),
            record ?? null,
        );
    }

    /** An error of the server on a create or update, with where to look when it is the body. */
    const withFields = (type) => (e) => {
        if (e?.status === 400) {
            e.message += `. ${toolName('resource_describe')} type "${type}" shows the fields and an example`;
        }
        throw e;
    };

    async function toolCreate(args) {
        const { type, at, ctx, hook } = prepare(args, 'create');
        if (own(local, type)) return createLocal(args, at, ctx, hook);
        const t = CATALOG[type];
        let body = bodyArg(args, 'create');
        // `projects` is not a field the server takes on create: set it right
        // after, as update does, so one call leaves the resource in place.
        let projects;
        if (isRecord(body) && 'projects' in body) {
            ({ projects, ...body } = body);
            if (!Array.isArray(projects)) {
                throw inputError('projects must be an array of "<owner>@<project>"');
            }
            if (!('projects' in t.ops)) throw inputError(`${type} cannot belong to projects`);
        }
        const key = idKey(type);
        const field = idField(t);
        let ownId = at.id;
        // An entry stored under its name may name it in the body instead.
        if (t.upsert && ownId === undefined) ownId = bodyIdOf(t, body);
        // The id can come apart from the body: copy it into the body's id
        // field when the server takes it there (POST).
        if (!t.upsert && ownId !== undefined) {
            if (!field) {
                throw inputError(
                    `${type} ids are generated by the server: leave ${key} out of ids`,
                );
            }
            if (!isRecord(body)) {
                throw inputError(
                    `an array creates several ${type}, each with its own ${field}: leave ${key} out of ids`,
                );
            }
            if (body[field] !== undefined && String(body[field]) !== ownId) {
                throw inputError(`ids.${key} and body.${field} differ`);
            }
            body = { [field]: ownId, ...body };
        }
        if (hook.beforeCreate) body = await hook.beforeCreate(body, ctx);
        if (!t.upsert) ownId ??= bodyIdOf(t, body);
        if (projects && ownId === undefined) {
            throw inputError(
                `give the ${type} id to set its projects on create: ids.${key}, or the body field "${field}"`,
            );
        }
        const parents = parentIdsOf(type, at.ids);
        const target = t.upsert
            ? { ...parents, ...(ownId !== undefined ? { [key]: ownId } : {}) }
            : parents;
        const result = await send(
            type,
            'create',
            { ids: target, user: args.user },
            { data: body },
        ).catch(withFields(type));
        // Ids the server generates are read from what it answers.
        const madeId = ownId ?? (key ? recordIds(type, result, parents)?.[key] : undefined);
        const ids =
            Array.isArray(body) || !hasOwnId(type)
                ? parents
                : madeId !== undefined
                  ? { ...parents, [key]: madeId }
                  : undefined;
        const lines = [`Created ${label(type, ids ?? parents)}.`];
        if (projects) {
            await send(type, 'projects', { ids, user: args.user }, { data: projects });
            lines[0] = lines[0].replace(/\.$/, ` in projects ${JSON.stringify(projects)}.`);
        }
        if (ids && !args[CLI] && !Array.isArray(body)) lines.push(`ids: ${JSON.stringify(ids)}`);
        if (result && typeof result === 'object' && Object.keys(result).length) {
            lines.push(JSON.stringify(result, null, 2));
        }
        const note = hook.afterCreate && (await hook.afterCreate(result, ctx));
        if (note) lines.push('', note);
        return text(lines.join('\n'), created(ownId, result, note, projects));
    }

    /** What a create answers with --json: the id, the server's answer, the hook's note. */
    function created(id, result, note, projects) {
        const out = { id: id ?? null };
        if (projects) out.projects = projects;
        if (result !== undefined && result !== null && result !== '') out.result = result;
        if (note) out.note = note;
        return out;
    }

    /** A body checked against the schema of a local type's records. */
    function localBody(type, body) {
        const schema = local[type].schema;
        if (schema) checkShape(body, schema, `body of ${type}`);
        else if (!isRecord(body)) throw inputError('body must be a JSON object');
        return body;
    }

    async function createLocal(args, at, ctx, hook) {
        const type = args.type;
        const t = local[type];
        let body = localBody(type, bodyArg(args, 'create'));
        const field = t.bodyId;
        if (field && isRecord(body)) {
            if (at.id !== undefined && body[field] !== undefined && String(body[field]) !== at.id) {
                throw inputError(`ids.${t.id} and body.${field} differ`);
            }
            if (at.id !== undefined && body[field] === undefined)
                body = { [field]: at.id, ...body };
        }
        // The hook may set or normalise the id: read it after.
        if (hook.beforeCreate) body = await hook.beforeCreate(body, ctx);
        let id = at.id ?? (field && isRecord(body) ? body[field] : undefined);
        if (id === null || id === '') id = undefined;
        if (t.id && id === undefined && !t.optionalId?.includes('create')) {
            throw inputError(
                `missing ${t.id}: give it in ids.${t.id}${field ? ` or in the body field "${field}"` : ''}`,
            );
        }
        const ids = id !== undefined ? { ...at.ids, [t.id]: String(id) } : at.ids;
        ctx.id = id === undefined ? undefined : String(id);
        ctx.ids = ids;
        const result = await t.create?.(
            body,
            localContext(args, { ...at, id: ctx.id, ids }, { state: ctx.state }),
        );
        // Without an id of its own it is data written, not a record made.
        const lines = [
            t.id && id !== undefined
                ? `Created ${label(type, ids)}.`
                : `Wrote to ${label(type, at.ids)}.`,
        ];
        if (t.id && id !== undefined && !args[CLI]) lines.push(`ids: ${JSON.stringify(ids)}`);
        const said = answer(result);
        if (said) lines.push(said);
        const note = hook.afterCreate && (await hook.afterCreate(result, ctx));
        if (note) lines.push('', note);
        return text(cap(type, undefined, lines.join('\n')), created(id, result, note));
    }

    async function toolUpdate(args) {
        if (typeof args.type !== 'string' || !served.has(args.type)) throw unknownType(args.type);
        /** @type {import('./catalog.js').Verb} */
        const verb = args.merge ? 'patch' : 'update';
        if (own(local, args.type)) {
            const { type, at, ctx, hook } = prepare(args, 'update');
            let body = localBody(type, bodyArg(args, 'update'));
            if (hook.beforeUpdate) body = await hook.beforeUpdate(body, ctx);
            const result = await local[type].update?.(
                body,
                localContext(args, at, { state: ctx.state }),
            );
            const said = answer(result);
            const keys = isRecord(body) ? Object.keys(body) : [];
            return text(
                cap(
                    type,
                    undefined,
                    `Updated ${label(type, at.ids)}: ${keys.join(', ')}.${said ? `\n${said}` : ''}`,
                ),
                { id: at.id ?? null, fields: keys, ...(said ? { result } : {}) },
            );
        }
        const all = bodyArg(args, 'update');
        if (!isRecord(all)) throw inputError('body must be a JSON object');
        const { projects, ...fields } = all;
        const { type, at, ctx, hook } = prepare(args, projects !== undefined ? 'projects' : verb);
        const where = { ids: at.ids, user: args.user };
        const done = [];
        if (projects !== undefined) {
            if (!Array.isArray(projects)) {
                throw inputError('projects must be an array of "<owner>@<project>"');
            }
            await send(type, 'projects', where, { data: projects });
            done.push(`projects set to ${JSON.stringify(projects)}`);
        }
        if (Object.keys(fields).length) {
            prepare(args, verb);
            let body = fields;
            // Profile entries are written whole (the same PUT creates them):
            // keep the fields left out by sending them from the saved entry.
            const t = CATALOG[type];
            if (verb === 'update' && t.upsert && t.ops.get !== t.ops.list) {
                const saved = await send(type, 'get', where);
                if (isRecord(saved)) body = { ...saved, ...fields };
            }
            if (hook.beforeUpdate) body = await hook.beforeUpdate(body, ctx);
            await send(type, verb, where, { data: body }).catch(withFields(type));
            done.push(`${args.merge ? 'merged' : 'updated'} ${Object.keys(fields).join(', ')}`);
        }
        return text(`Updated ${label(type, at.ids)}: ${done.join('; ')}.`, {
            id: at.id ?? null,
            fields: Object.keys(fields),
            ...(projects !== undefined ? { projects } : {}),
            ...(args.merge ? { merged: true } : {}),
        });
    }

    async function toolDelete(args) {
        const { type, at, ctx, hook } = prepare(args, 'delete');
        const mine = own(local, type);
        const result = mine
            ? await mine.delete?.(localContext(args, at, { state: ctx.state }))
            : await send(type, 'delete', { ids: at.ids, user: args.user });
        const lines = [`Deleted ${label(type, at.ids)}.`];
        const said = mine && answer(result);
        if (said) lines.push(said);
        const note = hook.afterDelete && (await hook.afterDelete(ctx));
        if (note) lines.push(note);
        return text(lines.join('\n'), { id: at.id ?? null, ...(note ? { note } : {}) });
    }

    async function toolClone(args) {
        const { type, at } = prepare(args, 'clone');
        const t = CATALOG[type];
        let body = bodyArg(args, 'clone');
        if (!isRecord(body)) throw inputError('body must be a JSON object');
        const key = /** @type {string} */ (idKey(type));
        const field = idField(t) ?? key;
        const copy = bodyIdOf(t, body);
        if (copy === undefined) throw inputError(`clone needs the new id in body.${field}`);
        await send(type, 'clone', { ids: at.ids, user: args.user }, { data: body });
        const ids = { ...parentIdsOf(type, at.ids), [key]: copy };
        const lines = [`Cloned ${label(type, at.ids)} as ${label(type, ids)}.`];
        if (!args[CLI]) lines.push(`ids: ${JSON.stringify(ids)}`);
        return text(lines.join('\n'), { id: at.id ?? null, copy });
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

    /** The bundled OpenAPI document, read once: it checks the bodies of catalog actions. */
    let bundled;
    const bundledDoc = () => {
        if (bundled === undefined) {
            try {
                bundled = bundledSpec();
            } catch {
                bundled = null;
            }
        }
        return bundled;
    };

    /** A catalog action's body against its documented schema: required keys and types only. */
    function checkActionBody(type, action, body) {
        const doc = bundledDoc();
        if (!doc || body === undefined) return;
        const { method, path } = actionTemplate(type, action);
        const op = findOperation(doc, method, path)?.operation;
        const schema = op?.requestBody?.content?.['application/json']?.schema;
        if (schema)
            checkShape(body, resolveRefs(doc, schema), `body of ${type}.${action}`, {
                unknown: false,
            });
    }

    /** "a, b and c", or "none". */
    const some = (words) => (words.length ? listed(words) : 'none');

    /**
     * What a catalog action that asks first would do, as concrete as a
     * read can make it: the entries a replace_all removes, the settings it
     * changes.
     */
    async function planOf(type, action, spec, at, body, user) {
        const where = { ids: at.ids, user };
        const target = label(type, at.ids);
        if (action === 'replace_all') {
            const now = await send(type, 'list', where).catch(() => undefined);
            const before = isRecord(now) ? Object.keys(now) : [];
            const after = isRecord(body) ? Object.keys(body) : [];
            return `It would replace the ${before.length} ${type} entries with ${after.length}: removes ${some(before.filter((k) => !after.includes(k)))}; adds ${some(after.filter((k) => !before.includes(k)))}; overwrites ${some(after.filter((k) => before.includes(k)))}.`;
        }
        if (action === 'update_settings' && own(allActionsOf(type), 'read_settings')) {
            const read = actionRequest(type, 'read_settings', where);
            const now = await api
                .request({ method: read.method, url: read.url })
                .then((r) => r.data)
                .catch(() => undefined);
            if (isRecord(now) && isRecord(body)) {
                const changed = Object.keys(body).filter(
                    (k) => JSON.stringify(now[k]) !== JSON.stringify(body[k]),
                );
                const dropped = Object.keys(now).filter((k) => !(k in body));
                return `It would replace the settings of ${target}: changes ${some(changed)}; removes ${some(dropped)} (left out of the body).`;
            }
        }
        if (action === 'test_notification') {
            const rule = await send(type, 'get', where).catch(() => undefined);
            const to = isRecord(rule)
                ? (rule.notification ?? rule.notifications ?? rule.endpoints)
                : undefined;
            if (to !== undefined) {
                return `It would send the notification of ${target} for real, to: ${JSON.stringify(to)}.`;
            }
        }
        return `It would run ${action} on ${target}: ${expand(spec.description)}`;
    }

    /**
     * An action that asks first and was not confirmed: ask the user when the
     * client can (elicitation), or answer the plan. Returns true to go on.
     *
     * @param {string} plan
     * @param {ToolExtra} [extra]
     */
    async function ask(plan, extra) {
        if (!extra?.elicit) return false;
        try {
            return await extra.elicit(plan);
        } catch {
            return false;
        }
    }

    /** The answer of an action that asked first and was not done. */
    const planned = (plan, extra) =>
        text(
            extra?.elicit
                ? `${plan}\nThe user did not confirm it: nothing was done.`
                : `${plan}\nNothing was done. ${CONFIRM_HINT}`,
            { plan },
        );

    /**
     * @param {Record<string, any>} args
     * @param {ToolExtra} [extra]
     */
    async function toolCall(args, extra) {
        const type = args.type;
        if (typeof type !== 'string' || !served.has(type)) throw unknownType(type);
        const names = actionNames(type);
        if (!names.length) {
            throw inputError(
                `Type "${type}" has no actions${readOnly ? ' served read-only' : ''}. Types with actions: ${actionTypes().join(', ')}.`,
            );
        }
        const spec = own(allActionsOf(type), args.action);
        if (!spec || (readOnly && !spec.readOnly)) {
            throw inputError(
                `Type "${type}" has no action "${args.action ?? ''}"${spec ? ' served read-only' : ''} (it has: ${names.join(', ')})`,
            );
        }
        const on = spec.on || 'item';
        const at = where(
            type,
            args,
            on === 'collection' ? 'forbidden' : on === 'either' ? 'optional' : 'required',
            (key) => `${args.action} acts on every ${type}: leave ${key} out of ids`,
        );
        let body = args.body;
        if (spec.bodyRequired && (body === undefined || body === null)) {
            throw inputError(
                `${type}.${args.action} needs a body: ${expand(spec.description)} (${toolName('resource_describe')} type "${type}" shows it)`,
            );
        }
        // Actions that ask first: body.confirm is the answer, not their input.
        let confirmed = false;
        if (spec.confirm && isRecord(body) && 'confirm' in body) {
            const { confirm, ...rest } = body;
            confirmed = confirm === true;
            body = rest;
        }
        const ran = `Ran ${args.action} on ${label(type, at.ids)}.`;

        if (typeof spec.run === 'function') {
            // A refused input: show a call that works, when the action has one.
            const withExample = (e) => {
                const ex = spec.examples?.[0];
                if (e?.code === 'input_error' && ex && !e.message.includes('\nExample: ')) {
                    e.message += `\nExample: ${toolName(ex.tool)} ${JSON.stringify(ex.arguments)} (${ex.does})`;
                }
                return e;
            };
            const state = {};
            const run = (ok) => spec.run(body, localContext(args, at, { state, confirmed: ok }));
            let result;
            try {
                // An id in the body (device_exec's old `device`): it goes in
                // ids, unless the action takes none.
                if (
                    on !== 'collection' &&
                    isRecord(body) &&
                    spec.body?.properties &&
                    spec.body.additionalProperties !== true
                ) {
                    const key = levelsOf(type)
                        .map((l) => l.key)
                        .find((k) => k in body && !Object.hasOwn(spec.body.properties, k));
                    if (key) {
                        throw inputError(
                            `body of ${type}.${args.action} has no "${key}": pass the ${key} in ids ({"${key}": ${JSON.stringify(body[key])}})`,
                        );
                    }
                }
                const required = spec.body?.required?.length;
                checkShape(
                    body ?? (required ? {} : undefined),
                    spec.body,
                    `body of ${type}.${args.action}`,
                );
                result = await run(confirmed);
                if (result && typeof result === 'object' && PLAN in result) {
                    if (!(await ask(result[PLAN], extra))) return planned(result[PLAN], extra);
                    result = await run(true);
                }
            } catch (e) {
                throw withExample(e);
            }

            if (isToolResult(result)) {
                return {
                    ...result,
                    content: result.content.map((c) =>
                        c.type === 'text' ? { ...c, text: cap(type, args.action, c.text) } : c,
                    ),
                };
            }
            const said = answer(result);
            return text(cap(type, args.action, said ?? ran), result ?? null);
        }

        checkActionBody(type, args.action, body);
        const { method, url, query } = actionRequest(type, args.action, {
            ids: at.ids,
            user: args.user,
        });
        if (spec.confirm && !confirmed) {
            const plan = await planOf(type, args.action, spec, at, body, args.user);
            if (!(await ask(plan, extra))) return planned(plan, extra);
        }
        const started = Date.now();
        try {
            // Actions that evaluate a resource (test_rule) take the saved one
            // when no body is given.
            const data =
                body === undefined && spec.bodyFromRecord
                    ? pick(
                          await send(type, 'get', { ids: at.ids, user: args.user }),
                          spec.bodyFromRecord,
                      )
                    : body;
            const res = await api.request({
                method,
                url,
                data: method === 'get' ? undefined : (data ?? {}),
                params: { ...(args.query || {}), ...(query || {}) },
                paramsSerializer: { indexes: null },
                timeout: TIMEOUTS.API_LONG_MS,
            });
            const answered = res.data;
            if (answered === undefined || answered === null || answered === '')
                return text(ran, null);
            if (typeof answered !== 'string')
                return text(JSON.stringify(answered, null, 2), answered);
            return text(lastProgress(answered, Date.now() - started) ?? answered, answered);
        } catch (e) {
            const err = apiError(e, { notFound: `Not found: ${label(type, at.ids)}` });
            // A 400 on an action called without a body is nearly always the
            // missing body: say what it takes instead of leaving the guess.
            if (e?.response?.status === 400 && body === undefined && method !== 'get') {
                err.message += `. ${args.action} takes a body: ${expand(spec.description || '')} (${toolName('resource_describe')} type "${type}" shows its schema)`;
            }
            throw err;
        }
    }

    /**
     * Where a key the tool does not take belongs, when it is a filter, body
     * or id key of the type: the model put it one level too high.
     *
     * @param {string} base  Bare tool name.
     * @param {Record<string, any>} args
     * @param {string[]} unknown
     */
    function explainUnknown(base, args, unknown) {
        const type = typeof args.type === 'string' && served.has(args.type) ? args.type : undefined;
        if (!type) return undefined;
        const mine = own(local, type);
        const ids = new Set(levelsOf(type).map((l) => l.key));
        const bodyKeys = new Set();
        const doc = bundledDoc();
        if (base === 'resource_call') {
            const spec = own(allActionsOf(type), args.action);
            Object.keys(spec?.body?.properties || {}).forEach((k) => bodyKeys.add(k));
            if (spec && !spec.run && doc && CATALOG[type]?.actions?.[args.action]) {
                const { method, path } = actionTemplate(type, args.action);
                const op = findOperation(doc, method, path)?.operation;
                const schema = op?.requestBody?.content?.['application/json']?.schema;
                Object.keys(schema ? resolveRefs(doc, schema).properties || {} : {}).forEach((k) =>
                    bodyKeys.add(k),
                );
            }
        } else if (BODY_VERBS.has(base.replace('resource_', ''))) {
            const verb = /** @type {any} */ (base.replace('resource_', ''));
            if (mine) Object.keys(mine.schema?.properties || {}).forEach((k) => bodyKeys.add(k));
            else if (doc && verb in CATALOG[type].ops) {
                const { method, path } = templateFor(type, verb);
                const schema = findOperation(doc, method, path)?.operation?.requestBody?.content?.[
                    'application/json'
                ]?.schema;
                Object.keys(schema ? resolveRefs(doc, schema).properties || {} : {}).forEach((k) =>
                    bodyKeys.add(k),
                );
            }
        }
        const value = (k) => JSON.stringify(args[k]);
        const hints = unknown.map((k) => {
            if (ids.has(k)) return `\`${k}\` goes in ids: ids: {"${k}": ${value(k)}}`;
            if (base === 'resource_list' && (mine ? mine.filter?.properties?.[k] : true)) {
                return `\`${k}\` goes in filter for type ${type}: filter: {"${k}": ${value(k)}}`;
            }
            if (bodyKeys.has(k)) return `\`${k}\` goes in body: body: {"${k}": ${value(k)}}`;
            return undefined;
        });
        return hints.filter(Boolean).join('; ') || undefined;
    }

    const typeParam = (verb) => ({
        type: 'string',
        enum: verb ? namesWith(verb) : [...served],
        description: 'Resource type (see {tool:resource_describe}).',
    });
    const user = {
        type: 'string',
        description: 'Account to act on (admin only). Omit for your own.',
    };
    const ids = {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
            'Ids of the record and of its parents, each under its name: {"device": "boiler"}; {"device": "boiler", "property": "setpoint"}; {"device": "boiler", "bucket": "temps", "tag": "location"}. {tool:resource_describe} gives the names of each type. Leave out the record\'s own id to list, to create with the id in the body, or for actions on the whole collection.',
    };
    const body = (description) => ({ type: 'object', description });
    const actionEnum = [...new Set(actionTypes().flatMap((n) => actionNames(n)))].sort();

    /** The actions this CLI adds, one line each, for resource_call's description. */
    /** @type {Array<[string, string, LocalAction]>} */
    const cliAdded = Object.entries(cliActions)
        .flatMap(([type, list]) =>
            Object.entries(list).map(([a, spec]) => /** @type {any} */ ([type, a, spec])),
        )
        .concat(
            Object.entries(cliTypes).flatMap(([type, t]) =>
                Object.entries(t.actions || {}).map(
                    ([a, spec]) => /** @type {any} */ ([type, a, spec]),
                ),
            ),
        );
    const added = cliAdded
        .filter(([, , spec]) => !readOnly || spec.readOnly)
        .map(
            ([type, a, spec]) =>
                `\n- type "${type}", action "${a}": ${expand(spec.description).split(/(?<=\.)\s/)[0]}`,
        )
        .join('');

    /** @type {Array<Record<string, any>>} */
    const tools = [
        {
            name: 'resource_describe',
            description:
                "Describe a resource type: its ids, its operations and actions, the filter its list takes, and the bodies of create, update, clone and each action, with the schemas and examples of this server's API, the permission each needs, and ready-to-send example calls. Call it before writing a type or running an action for the first time. Without `type`: every type with its operations and actions, example calls, and the guide to the platform's concepts (start here).",
            inputSchema: {
                type: 'object',
                properties: { type: typeParam() },
                required: [],
            },
            annotations: {
                title: 'Describe resource types',
                readOnlyHint: true,
                openWorldHint: false,
            },
            handler: toolDescribe,
        },
        {
            name: 'resource_list',
            description:
                'List the records of a type, one JSON record per line with the `ids` to pass back, in pages of 50 (`count`, `index`). `search` finds by id or name. `filter` narrows by product, type, asset_type, asset_group, project (its short id, "plant_a", not "<owner>@plant_a") or labels (key present), e.g. {"product": "boiler"}; alarm instances also take state and severity. A field of the listed records filters by exact value, nested ones with dots ({"alarm.rule": "r1"}); an array matches any of its values. Child types take their parent\'s ids: {"device": "boiler"} lists a device_property.\n\nAlso: the time series of a bucket (type "bucket_data", ids {"bucket": …}, filter {items, minutes or min_ts/max_ts, device, agg, agg_type, tz, fields, group_by, sort}), the files of a storage (type "storage_file", ids {"storage": …}, filter {path: folder}), what a connected device exposes (type "device_resource", ids {"device": …}), the guides (type "doc") and this CLI\'s profiles (type "profile"). {tool:resource_describe} shows the filter each type takes.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('list'),
                    ids,
                    filter: {
                        type: 'object',
                        description:
                            'Query filters (see above). Types with their own filter (bucket_data, storage_file…) take only its keys.',
                    },
                    search: {
                        type: 'string',
                        description:
                            'Text to look for in ids and names (partial, any case; descriptions are not searched). On the plugin catalog, words matched against every field shown.',
                    },
                    count: {
                        type: 'number',
                        description:
                            'Page size (default 50); for bucket_data, the samples to return (filter.items).',
                    },
                    index: { type: 'number', description: 'Offset of the first record.' },
                    user,
                },
                required: ['type'],
            },
            annotations: { title: 'List resources', readOnlyHint: true, openWorldHint: false },
            handler: toolList,
        },
        {
            name: 'resource_get',
            description:
                'Read one record as JSON, located by `ids`. Single records (device_callback, product_profile_code) take only their parent\'s ids. Also reads a text file of a storage (type "storage_file", ids {"storage", "file": its path}) and a guide (type "doc", ids {"doc"}, from resource_list type "doc"): read the relevant guide before building something new.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('get'),
                    ids,
                    full: {
                        type: 'boolean',
                        description:
                            'Plugin catalog manifests: also include the product code and the console dashboard (large). Types that take it say so in their notes.',
                    },
                    user,
                },
                required: ['type'],
            },
            annotations: { title: 'Read a resource', readOnlyHint: true, openWorldHint: false },
            handler: toolGet,
        },
        {
            name: 'resource_create',
            description:
                'Create a record from `body`, shaped as {tool:resource_describe} shows. The record\'s own id goes in `ids` or in the body\'s id field; product_profile_* and product_service entries are stored under their id in `ids`, replacing any entry of that name. `projects` in the body (["<owner>@<project>"]) also puts the new record in those projects. Writes data too: samples to a bucket (type "bucket_data", ids {"bucket"}; body one sample, stored now or at its `ts`, or an array of samples each with its `ts`; rate limited: import a CSV for long histories) and files to a storage (type "storage_file", ids {"storage", "file": the path}; body {content} for text, or {local} for a file or folder of this machine, binary too, where ids.file is optional: a file keeps its name, a folder goes to the root), overwriting what is there.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('create'),
                    ids,
                    body: {
                        type: ['object', 'array'],
                        description:
                            'Fields of the new record; an array creates several at once where the type allows it (properties, bucket_data samples).',
                    },
                    user,
                },
                required: ['type'],
            },
            annotations: {
                title: 'Create a resource',
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            handler: toolCreate,
        },
        {
            name: 'resource_update',
            description:
                'Update the record `ids` locates with the fields in `body`; fields left out are kept, except for property values, which are replaced unless `merge` is true. `projects` in the body (["<owner>@<project>"]) sets the projects the record belongs to. A storage_file is overwritten, with the body of create.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('update'),
                    ids,
                    body: body('Fields to change.'),
                    merge: {
                        type: 'boolean',
                        description:
                            'Patch (JSON merge) instead of replacing: property types and brands.',
                    },
                    user,
                },
                required: ['type', 'body'],
            },
            annotations: {
                title: 'Update a resource',
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            handler: toolUpdate,
        },
        {
            name: 'resource_delete',
            description:
                'Delete the record `ids` locates (a storage_file: that file). Immediate and permanent: confirm with the user first.',
            inputSchema: {
                type: 'object',
                properties: { type: typeParam('delete'), ids, user },
                required: ['type'],
            },
            annotations: {
                title: 'Delete a resource',
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            handler: toolDelete,
        },
        {
            name: 'resource_clone',
            description:
                'Copy the record `ids` locates under a new id: `body` holds the new id in the record\'s id field (e.g. {"device": "copy_1"}, {"rule": "copy_1"} for an alarm_rule; {tool:resource_describe} shows it) and optionally name, description and enabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: typeParam('clone'),
                    ids,
                    body: body('New id and overrides.'),
                    user,
                },
                required: ['type', 'ids', 'body'],
            },
            annotations: {
                title: 'Copy a resource',
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            handler: toolClone,
        },
        {
            name: 'resource_call',
            description: readOnly
                ? `Run a read-only action of a resource: statistics, an overview, logs, a test that changes nothing. \`body\` is its input and \`query\` its query parameters; {tool:resource_describe} lists each type's actions (after |) with their bodies. The most used: type "device", action "overview" (no ids; body {locations: true} adds positions).${added}`
                : `Run an action of a resource: what is not create/read/update/delete. \`body\` is its input and \`query\` its query parameters; {tool:resource_describe} lists each type's actions (after |) with their bodies. The most used:
- type "device_resource", ids {"device", "resource"}, action "call": run a resource of a connected device with \`body\` as its input; without a body its output is read (a resource without input runs);
- type "device", action "send" (ids {"device"}; body the data an HTTP device sends) and "overview" (no ids; body {locations: true} adds positions);
- type "product_profile_api", ids {"product", "resource"}, action "call": call it for the whole product;
- type "plugin", ids {"plugin"}, action "call": its own API, body {path, method, body}, and \`query\`;
- type "dashboard", actions "init", "dev" and "publish" (no ids): create, develop and publish dashboard apps on the dashboard SDK; publish body {dir: "./dist", storage: <app storage>, to: [{"dashboard": <dashboard id>}]}.${added}


Others: verify a domain, restart a host, export a product, test an alarm rule, install a plugin… Actions act at once: confirm with the user before those that change, remove or notify. Those with a high impact answer what they would do until called again with confirm: true in the body.`,
            inputSchema: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: actionTypes(),
                        description: 'Resource type.',
                    },
                    action: {
                        type: 'string',
                        enum: actionEnum,
                        description:
                            'Action name: "call", "send", "verify"… (each type has its own: resource_describe).',
                    },
                    ids: {
                        ...ids,
                        description: `${ids.description} Actions on the whole collection (overview, init, stats…) take only the parents' ids.`,
                    },
                    body: {
                        description:
                            'Action input, when it takes one (its shape: resource_describe); confirm: true for an action that asks first.',
                    },
                    query: {
                        type: 'object',
                        description:
                            "Query parameters, when it takes them (a plugin call's, a host's logs).",
                    },
                    user,
                },
                required: ['type', 'action'],
            },
            annotations: readOnly
                ? { title: 'Run a read-only action', readOnlyHint: true, openWorldHint: true }
                : {
                      title: 'Run a resource action',
                      readOnlyHint: false,
                      destructiveHint: true,
                      idempotentHint: false,
                      openWorldHint: true,
                  },
            handler: toolCall,
        },
    ];
    return tools
        .filter((t) => !readOnly || READ_TOOLS.has(t.name))
        .map((t) => ({ ...t, explain: (args, unknown) => explainUnknown(t.name, args, unknown) }));
}
