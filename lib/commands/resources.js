// @ts-check
import { writeFile } from 'node:fs/promises';
import { CATALOG, ancestry, idNames } from '../mcp/catalog.js';
import { textResult } from '../mcp/helpers.js';
import { DATA, resourceTools } from '../mcp/tools-resource.js';
import { inputError } from '../errors.js';
import { identity } from '../identity.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import {
    applyJsonFlag,
    collectKeyString,
    collectKeyValue,
    confirmDestructive,
    ensureConfigured,
    extractField,
    getGlobalUser,
    parseJsonValue,
    parseNonNegativeInt,
    parsePositiveInt,
    bodyFromOptions,
    bodyOptions,
} from './_shared.js';

/**
 * The generic resource commands: `<cli> <noun> [<noun>…] list|get|create|
 * update|delete|clone|describe|set|<action>` for every type of the catalog
 * the MCP serves, run by the same handlers as the `resource_*` tools (hooks
 * included), so a type added to the catalog reaches both at once.
 *
 * A type's noun is its name without its parent's, nested under the
 * parent's command (`device property`, `device bucket tag`); server types
 * go under `admin`. Ids are positional, outermost parent first, each named
 * after its noun (`<device> <property>`). A command written by hand wins:
 * a generated verb whose name a group already has is left out.
 */

/** Verbs a type may have, in the order the help shows them. */
const VERBS = /** @type {const} */ (['list', 'get', 'create', 'update', 'delete', 'clone']);

/** Verbs that move data rather than records: their actions go under "Data:". */
export const DATA_VERBS = [
    'read',
    'write',
    'send',
    'export',
    'import',
    'overview',
    'call',
    'upload',
    'download',
];

const kebab = (name) => name.replaceAll('_', '-');

/**
 * Nouns of the types whose command is not their name without the parent's:
 * the product profile categories go under `product profile`, and the export
 * files of a bucket are `export-file` (`bucket export` downloads its data).
 */
const NOUN = {
    product_profile_api: ['profile', 'api'],
    product_profile_bucket: ['profile', 'bucket'],
    product_profile_property: ['profile', 'property'],
    product_profile_autoprovision: ['profile', 'autoprovision'],
    product_profile_flow: ['profile', 'flow'],
    product_profile_code: ['profile', 'code'],
    bucket_export: ['export-file'],
};

/** Id arguments not named after the type's noun. */
const ARG = { bucket_export: 'file' };

/** Actions whose command is not the catalog's name in kebab case. */
const ACTION_NAME = {
    'alarm_rule.test_rule': 'test',
    'host.read_settings': 'get-settings',
    'plugin.remove': 'uninstall',
};

/** Groups that are not types, with their description. */
export const GROUP_DESCRIPTIONS = {
    admin: 'Server administration (admin accounts): users, hosts, domains, brands…',
    'product profile':
        'Profile of a product: the API resources, buckets, properties, autoprovisioning, flows and code its devices get',
    'device resource': "Resources of a connected device: its firmware's API and its product's",
    'storage file': 'Files of a file storage',
};

/**
 * Types whose records have a name and a description: their create and
 * update take `-n` and `-d` (a test checks the set against the server's
 * API).
 */
export const NAMED_FIELDS = new Set([
    'device',
    'product',
    'bucket',
    'dashboard',
    'endpoint',
    'storage',
    'asset_type',
    'asset_group',
    'project',
    'token',
    'alarm_rule',
    'alarm_instance',
    'claim',
    'property',
    'sync',
    'domain',
    'brand',
    'oauth_client',
    'identity_provider',
    'proxy',
    'sync_lock',
    'device_property',
    'product_property',
    'product_profile_api',
    'product_profile_bucket',
    'product_profile_property',
    'product_profile_autoprovision',
    'product_profile_flow',
    'product_service',
    'plugin_property',
    'asset_type_property',
    'asset_group_property',
    'project_property',
]);

/** Command a type lives under: `alarm-rule`, `device bucket tag`, `admin user`. */
export function commandPath(type) {
    const spec = CATALOG[type];
    const own = NOUN[type] ?? [kebab(spec.parent ? type.slice(spec.parent.length + 1) : type)];
    if (spec.parent) return [...commandPath(spec.parent), ...own];
    return spec.scope === 'server' ? ['admin', ...own] : own;
}

/** Command of an action: `test` for alarm_rule's test_rule, `test-source`… */
export const actionName = (type, action) => ACTION_NAME[`${type}.${action}`] ?? kebab(action);

/** Argument names of a type's own ids: `<asset-type>`, `<property>`, `<file>`. */
export function idArgs(type) {
    const ids = idNames(CATALOG[type]);
    if (ids.length !== 1) return ids.map(kebab);
    return [ARG[type] ?? commandPath(type).at(-1)];
}

/** Argument names of a type's parents, outermost first. */
export const parentArgs = (type) => ancestry(type).flatMap(idArgs);

/** Type at a command path ('device property' → device_property). */
export const TYPE_AT = new Map(Object.keys(CATALOG).map((t) => [commandPath(t).join(' '), t]));

/** How a type reads in the help: "device property", "oauth-client". */
const noun = (type) =>
    commandPath(type)
        .filter((n, i) => i || n !== 'admin')
        .join(' ');

/**
 * The catalog's description for a command line: what names MCP tools
 * (sentences, or remarks in parentheses) and the form of a `parent` id is
 * for agents; the command line takes the parent ids one by one.
 */
export function cliDescription(text) {
    return cliWording(text)
        .replace(/\s*\([^)]*\btools?\b[^)]*\)/g, '')
        .replace(/\s*\(parent: [^)]*\)/g, '')
        .replace(/`body`/g, 'the body')
        .split(/(?<=\.)\s+/)
        .filter((s) => !s.includes('{tool:') && !/^Confirm with the user\b/.test(s))
        .join(' ')
        .trim()
        .replace(/\.$/, '');
}

/** Commands that do what the MCP tools outside resource_* do. */
const TOOL_COMMANDS = {
    bucket_data_read: 'bucket read',
    bucket_data_write: 'bucket write',
    dashboard_dev: 'dashboard dev',
    dashboard_init: 'dashboard init',
    dashboard_publish: 'dashboard publish',
    device_data_send: 'device send',
    device_overview: 'device overview',
    device_resource_call: 'device resource call',
    device_resource_list: 'device resource list',
    plugin_call: 'plugin call',
    product_resource_call: 'product profile api call',
    profile_list: 'profile list',
    storage_file_delete: 'storage file delete',
    storage_file_list: 'storage file list',
    storage_file_read: 'storage file download',
    storage_file_write: 'storage file upload',
};

/** The command doing what tool `base` does, `type` the resource the text is about. */
function commandFor(base, type) {
    const verb = base.match(/^resource_(\w+)$/)?.[1];
    const at = type && type in CATALOG ? commandPath(type).join(' ') : '<noun>';
    const words = verb ? `${at} ${verb === 'call' ? '<action>' : verb}` : TOOL_COMMANDS[base];
    return words && `\`${identity().name} ${words}\``;
}

/**
 * A text the commands share with the MCP tools, for a command line: the
 * tools it names (`{tool:x}`, or written out with the prefix) as the
 * commands that do the same, and their arguments as options. Tools without
 * a command stay as they are.
 *
 * @param {string} text
 * @param {string} [type]  The resource the text is about.
 */
export function cliWording(text, type) {
    const prefix = identity().mcp.toolPrefix;
    const tool = `(?:\\{tool:([a-z0-9_]+)\\}|\\b${prefix}_([a-z0-9_]+))`;
    return text
        .replace(
            new RegExp(`(?:\\{tool:doc_read\\}|\\b${prefix}_doc_read)(?: id "[^"]*")?`, 'g'),
            'the documentation',
        )
        .replace(new RegExp(tool, 'g'), (all, a, b) => commandFor(a ?? b, type) ?? all)
        .replace(/\bpass index: (\d+)/g, 'pass --index $1')
        .replace(/narrow it with filter\b/g, 'narrow it with --search or --filter');
}

/** The first sentence, for a line of help: the whole text goes after the options. */
const firstSentence = (text) => text.split(/(?<=[.;:])\s+/)[0].replace(/[.;:]$/, '');

/** Whether a command answers to `name`, by its name or an alias. */
export const named = (cmd, name) => cmd.name() === name || cmd.aliases().includes(name);

/**
 * The group at `path` below `program`, made on the way when missing (with
 * the type's description, or GROUP_DESCRIPTIONS'): groups written by hand
 * keep theirs. Null when a segment is a command without subcommands, a
 * CLI's own leaf: no group can go there.
 *
 * @param {import('commander').Command} program
 * @param {string[]} path
 */
export function groupAt(program, path) {
    let parent = program;
    for (let i = 0; i < path.length; i++) {
        const found = parent.commands.find((c) => named(c, path[i]));
        if (found) {
            if (!found.commands.length) return null;
            parent = found;
            continue;
        }
        const at = path.slice(0, i + 1).join(' ');
        const type = TYPE_AT.get(at);
        const top = path[0] === 'admin' ? 'Administration:' : 'Resources:';
        parent = parent
            .command(path[i])
            .helpGroup(i ? 'Subresources:' : top)
            .description(
                type ? cliDescription(CATALOG[type].description) : (GROUP_DESCRIPTIONS[at] ?? ''),
            );
    }
    return parent;
}

/** Describe the id arguments of a command on `type`: "ID of the alarm rule". */
function describeIds(cmd, type) {
    const help = new Map(
        [...ancestry(type), type].flatMap((t) =>
            idArgs(t).map((n) => [n, `ID of the ${t.replaceAll('_', ' ')}`]),
        ),
    );
    help.set('new-id', 'ID of the copy');
    help.set('value', 'Value, parsed as JSON (text when it is not JSON)');
    for (const arg of cmd.registeredArguments) {
        if (!arg.description) arg.description = help.get(arg.name()) ?? '';
    }
    return cmd;
}

/**
 * `--search`, `--filter`, `--count` and `--index`: the options of every
 * list, generated or written by hand.
 *
 * @param {import('commander').Command} cmd
 */
export function listOptions(cmd) {
    return cmd
        .option('--search <text>', 'Text to look for in ids and names')
        .option(
            '--filter <key=value>',
            'Filter (repeatable): product, type, asset_type, asset_group, project, labels, or a field of the records',
            collectKeyValue,
        )
        .option('--count <n>', 'Page size (default: all)', parsePositiveInt('count'))
        .option('--index <n>', 'Offset of the first record', parseNonNegativeInt('index'));
}

/** Whether a list was given any of the listOptions. */
export const hasListOptions = (opts) =>
    ['search', 'filter', 'count', 'index'].some((o) => opts[o] !== undefined);

/** The listOptions as resource_list takes them: every record unless --count. */
function listArgs(opts) {
    return {
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(opts.count ? { count: opts.count } : { all: true }),
        ...(opts.index !== undefined ? { index: opts.index } : {}),
    };
}

/** Handlers of the resource tools without a CLI's hooks, for the commands written by hand. */
let plainTools;
const plain = () =>
    (plainTools ??= Object.fromEntries(resourceTools().map((t) => [t.name, t.handler])));

/**
 * The records of a list with the listOptions, through resource_list: what
 * the lists written by hand show in their own table.
 *
 * @param {string} type
 * @param {Record<string, any>} opts
 * @param {string | null} [user]
 */
export async function listRecords(type, opts, user) {
    const result = await plain().resource_list({
        type,
        ...listArgs(opts),
        ...(user ? { user } : {}),
    });
    return result[DATA] ?? [];
}

/** `--projects a@p1,b@p2` → ['a@p1', 'b@p2']. */
const parseProjects = (list) =>
    String(list)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

/** The `--projects` option of a create or update. */
export const projectsOption = (cmd) =>
    cmd.option('--projects <list>', 'Projects it belongs to, comma-separated "<owner>@<project>"');

/**
 * Set the projects of a record a command written by hand created
 * (`--projects`), as the generated create does. A failure says the record
 * is there all the same.
 *
 * @param {string} type
 * @param {string} id
 * @param {string} list  "<owner>@<project>", comma-separated.
 * @param {string | null} [user]
 */
export async function setProjects(type, id, list, user) {
    try {
        await plain().resource_update({
            type,
            id,
            body: { projects: parseProjects(list) },
            ...(user ? { user } : {}),
        });
    } catch (error) {
        const { message, code } = classifyError(error);
        throw Object.assign(
            new Error(`${type} ${id} was created, but not its projects: ${message}`),
            {
                code,
            },
        );
    }
}

/**
 * Register the commands on `program`.
 *
 * @param {import('commander').Command} program
 * @param {{
 *   hooks?: Record<string, import('../mcp/resource-hooks.js').ResourceHooks>,
 *   strict?: boolean,
 * }} [opts]
 *   `strict` (tests): a type whose path a CLI's own leaf takes throws,
 *   instead of being left out (said on stderr with DEBUG set).
 */
export function registerResourceCommands(program, { hooks, strict = false } = {}) {
    const tools = Object.fromEntries(resourceTools({ hooks }).map((t) => [t.name, t.handler]));

    // Parents first: a child's group goes into its parent's.
    const types = Object.keys(CATALOG).sort((a, b) => ancestry(a).length - ancestry(b).length);
    for (const type of types) {
        const spec = CATALOG[type];
        const cmd = groupAt(program, commandPath(type));
        if (!cmd) {
            const message = `${commandPath(type).join(' ')}: a command of the CLI takes the place of the ${type} commands`;
            if (strict) throw new Error(message);
            if (process.env.DEBUG) process.stderr.write(`${message}\n`);
            continue;
        }
        const has = (name) => cmd.commands.some((c) => named(c, name));

        for (const verb of VERBS) {
            if (verb in spec.ops && !has(verb)) addVerb(cmd, type, verb, tools);
        }
        if (spec.id === 'property' && 'update' in spec.ops && !has('set')) {
            addVerb(cmd, type, 'set', tools);
        }
        if (!has('describe')) addDescribe(cmd, type, tools);
        for (const [action, a] of Object.entries(spec.actions || {})) {
            if (!has(actionName(type, action))) addAction(cmd, type, action, a, tools);
        }
    }
}

/** Positional arguments → `{ parent, id }` as the tools take them. */
function locate(type, values, { withId }) {
    const parents = parentArgs(type);
    const ids = withId ? idNames(CATALOG[type]) : [];
    const parent = values.slice(0, parents.length);
    const id = values.slice(parents.length, parents.length + ids.length).filter(Boolean);
    return {
        ...(parents.length ? { parent: parent.join('/') } : {}),
        ...(id.length ? { id: id.join('/') } : {}),
    };
}

/** `<device> <bucket>`: commander's spelling of the arguments. */
const argSpec = (names, optional = false) =>
    names.map((n) => (optional ? `[${n}]` : `<${n}>`)).join(' ');

/** Print the value `-f` picked: text as is, anything else as JSON; nothing when missing. */
function printValue(value) {
    if (value === undefined) return;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/**
 * Run an MCP tool handler as a command and print its answer: its text, or
 * its data with --json.
 *
 * @param {(args: any) => any} handler
 * @param {Record<string, any>} args
 * @param {{ output?: string, field?: string }} [opts]  `output`: write the
 *   answer (JSON) to this file; `field`: only this field (dot path) of it.
 */
export async function runTool(handler, args, { output, field } = {}) {
    try {
        const result = await handler(args);
        if (result?.isError) {
            const message = result.content?.map((c) => c.text).join('\n') || 'failed';
            printErr(message, { code: 'error' });
            return;
        }
        let data = DATA in result ? result[DATA] : result.content?.map((c) => c.text).join('\n');
        if (field !== undefined) data = extractField(data, field);
        if (output) {
            await writeFile(
                output,
                typeof data === 'string'
                    ? data
                    : data === null || data === undefined
                      ? ''
                      : `${JSON.stringify(data, null, 2)}\n`,
            );
            if (isJsonMode()) printOk({ file: output });
            else process.stderr.write(`Saved to ${output}\n`);
            return;
        }
        if (isJsonMode()) return printOk(data);
        if (field !== undefined) return printValue(data);
        for (const c of result.content || []) {
            if (c.type === 'text') console.log(cliText(c.text, args.type));
        }
    } catch (error) {
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
}

/**
 * `set`: the value of a property, created when missing (an update first,
 * then a create when the server has none).
 */
async function setValue(tools, args) {
    try {
        await tools.resource_update(args);
    } catch (error) {
        if (classifyError(error).code !== 'not_found') throw error;
        await tools.resource_create(args);
    }
    const where = [args.parent, args.id].filter(Boolean).join('/');
    return textResult(`Set ${noun(args.type)} ${where} to ${JSON.stringify(args.body.value)}.`, {
        ...(args.parent ? { parent: args.parent } : {}),
        id: args.id,
        value: args.body.value,
    });
}

/** "an endpoint", "a device". */
const article = (t) => `${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}`;

const SUMMARY = {
    list: (t) => `List ${t} records`,
    get: (t) => `Show ${article(t)} as JSON`,
    create: (t) => `Create ${article(t)} from --from and --set`,
    update: (t) => `Update fields of ${article(t)} (fields left out are kept)`,
    delete: (t) => `Delete ${article(t)}`,
    clone: (t) => `Copy ${article(t)} under a new id`,
    set: (t) => `Set the value of ${article(t)} (created when missing)`,
};

function addVerb(group, type, verb, tools) {
    const spec = CATALOG[type];
    const parents = parentArgs(type);
    const ids = idArgs(type);
    const what = noun(type);
    // A create may take its id from the body, unless it is stored under it.
    const optionalIds = verb === 'create' && !spec.upsert;
    const usage = [
        verb,
        argSpec(parents),
        verb === 'list' ? '' : argSpec(ids, optionalIds),
        verb === 'clone' ? '<new-id>' : '',
        verb === 'set' ? '<value>' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const cmd = group
        .command(usage)
        .helpGroup('Records:')
        .description(SUMMARY[verb](what))
        .option('-j, --json', 'Output as JSON');
    describeIds(cmd, type);

    if (verb === 'list') listOptions(cmd);
    if (['create', 'update', 'clone'].includes(verb) && NAMED_FIELDS.has(type)) {
        cmd.option('-n, --name <name>', 'Name (over --from and --set)').option(
            '-d, --description <text>',
            'Description (over --from and --set)',
        );
    }
    if (verb === 'create' || verb === 'update' || verb === 'clone') bodyOptions(cmd);
    if ((verb === 'create' || verb === 'update') && 'projects' in spec.ops) projectsOption(cmd);
    if (verb === 'update' && 'patch' in spec.ops) {
        cmd.option('--merge', 'Patch the value (JSON merge) instead of replacing it');
    }
    if (verb === 'delete') cmd.option('-y, --yes', 'Do not ask for confirmation');
    if (verb === 'get') {
        cmd.option('-f, --field <path>', 'Print only this field (dot path, e.g. config.source)');
        cmd.option('-o, --output <file>', 'Write the JSON to a file');
    }

    cmd.action(async (...params) => {
        const command = params[params.length - 1];
        const opts = params[params.length - 2];
        const values = params.slice(0, -2);
        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(command);
        try {
            const where = locate(type, values, { withId: verb !== 'list' });
            const base = { type, ...where, ...(user ? { user } : {}) };
            if (verb === 'list')
                return runTool(tools.resource_list, { ...base, ...listArgs(opts) });
            if (verb === 'get') {
                return runTool(tools.resource_get, base, {
                    output: opts.output,
                    field: opts.field,
                });
            }
            if (verb === 'delete') {
                const ok = await confirmDestructive(
                    opts,
                    `Delete ${what} ${[where.parent, where.id].filter(Boolean).join('/')}?`,
                );
                if (ok) await runTool(tools.resource_delete, base);
                return;
            }
            if (verb === 'set') {
                const value = parseJsonValue(values[values.length - 1]);
                return runTool((args) => setValue(tools, args), { ...base, body: { value } });
            }
            let body = (await bodyFromOptions(opts)) ?? {};
            // Only a create may take several records (an array of properties).
            if (verb !== 'create' && (typeof body !== 'object' || Array.isArray(body))) {
                throw inputError(`${verb} takes a JSON object`);
            }
            const fields = {
                ...(opts.name !== undefined ? { name: opts.name } : {}),
                ...(opts.description !== undefined ? { description: opts.description } : {}),
                ...(opts.projects ? { projects: parseProjects(opts.projects) } : {}),
            };
            if (Object.keys(fields).length) {
                if (typeof body !== 'object' || Array.isArray(body)) {
                    const flags = Object.keys(fields).map((f) => `--${f}`);
                    throw inputError(`${flags.join(', ')} need a JSON object body`);
                }
                body = { ...body, ...fields };
            }
            if (verb === 'create') return runTool(tools.resource_create, { ...base, body });
            if (verb === 'update') {
                return runTool(tools.resource_update, {
                    ...base,
                    body,
                    ...(opts.merge ? { merge: true } : {}),
                });
            }
            // clone: the new id goes into the body's id field.
            const idFields = spec.bodyId ?? idNames(spec);
            if (idFields.length !== 1)
                throw inputError(`${what} cannot be cloned from the command line`);
            const copy = values[values.length - 1];
            return runTool(tools.resource_clone, {
                ...base,
                body: { ...body, [idFields[0]]: copy },
            });
        } catch (error) {
            const { message, code } = classifyError(error);
            printErr(message, { code });
        }
    });
}

function addDescribe(group, type, tools) {
    group
        .command('describe')
        .helpGroup('Records:')
        .description(
            `Fields, examples and permissions of ${article(noun(type))}, from the server's API`,
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            await runTool(
                async (args) => {
                    const result = await tools.resource_describe(args);
                    if (result.isError || isJsonMode()) return result;
                    const said = result.content.map((c) => c.text).join('\n');
                    return textResult(describeForCli(said, type, group));
                },
                { type },
            );
        });
}

/**
 * resource_describe's answer, for a command line: the commands of the type
 * instead of the tools that run its operations and actions, the actions by
 * their command names, and no hint on how a tool takes the parent ids.
 */
function describeForCli(text, type, group) {
    const at = `${identity().name} ${commandPath(type).join(' ')}`;
    const actions = Object.keys(CATALOG[type]?.actions || {});
    const rename = (line) =>
        actions.reduce(
            (out, a) =>
                actionName(type, a) === a
                    ? out
                    : out.replace(new RegExp(`\\b${a}\\b`, 'g'), actionName(type, a)),
            line,
        );
    return text
        .split('\n')
        .map((line) => {
            const [, key, value] = line.match(/^(\w+): (.*)$/s) || [];
            if (key === 'operations') {
                const verbs = group.commands
                    .filter((c) => !c.commands.length && c.helpGroup() === 'Records:')
                    .map((c) => c.name());
                return `commands: ${at} ${verbs.join('|')}`;
            }
            if (key === 'actions') {
                let entries;
                try {
                    entries = Object.entries(JSON.parse(value));
                } catch {
                    return line;
                }
                const lines = entries.map(
                    ([a, { does }]) => `  ${at} ${actionName(type, a)}: ${rename(does ?? '')}`,
                );
                return `actions:\n${lines.join('\n')}`;
            }
            if (key === 'parent') return line.replace(/\s*\(write it as [^)]*\)$/, '');
            if (key !== 'notes' && key !== 'description') return line;
            return rename(line).replace(
                /\bproduct_profile_\* types\b/g,
                `\`${identity().name} product profile\` commands`,
            );
        })
        .join('\n');
}

/**
 * A tool's text, for a command line (see cliWording), its type by the
 * command's noun. Lines of JSON records are printed as they come.
 */
function cliText(text, type) {
    const label = type && type in CATALOG ? new RegExp(`\\b${type}\\b`, 'g') : null;
    return text
        .split('\n')
        .map((line) => {
            if (/^\s*[[{]/.test(line)) return line;
            const out = cliWording(line, type);
            return label && !out.includes('{') ? out.replace(label, noun(type)) : out;
        })
        .join('\n');
}

/**
 * Actions that undo things as a delete does, asking first unless -y: the
 * question each asks, of the type's noun and the ids.
 */
const DESTRUCTIVE = {
    replace_all: (what, of) => `Replace every ${what} of ${of}?`,
    'plugin.remove': (what, of) => `Uninstall plugin ${of}? Its data is removed.`,
    'host.restart': (what, of) => `Restart host ${of}? Every connection drops meanwhile.`,
};

function addAction(group, type, action, spec, tools) {
    const parents = parentArgs(type);
    const ids = spec.on === 'collection' ? [] : idArgs(type);
    const name = actionName(type, action);
    const destructive = DESTRUCTIVE[`${type}.${action}`] ?? DESTRUCTIVE[action];
    const usage = [name, argSpec(parents), argSpec(ids)].filter(Boolean).join(' ');
    const cmd = group
        .command(usage)
        .helpGroup(DATA_VERBS.includes(name) ? 'Data:' : 'Actions:')
        // The group lists the first sentence; the command's help, all of it.
        .summary(firstSentence(cliDescription(spec.description)))
        .description(cliDescription(spec.description))
        .option('-q, --query <key=value>', 'Query parameter (repeatable)', collectKeyString)
        .option('-f, --field <path>', 'Print only this field of the answer (dot path)')
        .option('-o, --output <file>', 'Write the answer to a file')
        .option('-j, --json', 'Output as JSON');
    describeIds(cmd, type);
    if (spec.method !== 'get') bodyOptions(cmd);
    if (destructive) cmd.option('-y, --yes', 'Do not ask for confirmation');
    cmd.action(async (...params) => {
        const command = params[params.length - 1];
        const opts = params[params.length - 2];
        const values = params.slice(0, -2);
        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(command);
        try {
            const where = locate(type, values, { withId: spec.on !== 'collection' });
            const body = await bodyFromOptions(opts);
            const of = [where.parent, where.id].filter(Boolean).join('/');
            if (destructive && !(await confirmDestructive(opts, destructive(noun(type), of)))) {
                return;
            }
            await runTool(
                tools.resource_call,
                {
                    type,
                    action,
                    ...where,
                    ...(body !== undefined ? { body } : {}),
                    ...(opts.query ? { query: opts.query } : {}),
                    ...(user ? { user } : {}),
                },
                { output: opts.output, field: opts.field },
            );
        } catch (error) {
            const { message, code } = classifyError(error);
            printErr(message, { code });
        }
    });
}
