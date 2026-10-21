// @ts-check
import { writeFile } from 'node:fs/promises';
import { CATALOG, ancestry, idNames } from '../mcp/catalog.js';
import { DATA, resourceTools } from '../mcp/tools-resource.js';
import { inputError } from '../errors.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import {
    applyJsonFlag,
    collectKeyString,
    collectKeyValue,
    confirmDestructive,
    ensureConfigured,
    getGlobalUser,
    parseNonNegativeInt,
    parsePositiveInt,
    bodyFromOptions,
    bodyOptions,
} from './_shared.js';

/**
 * The generic resource commands: `<cli> <type> list|get|create|update|
 * delete|clone|describe|<action>` for every type of the catalog the MCP
 * serves, run by the same handlers as the `resource_*` tools (hooks
 * included), so a type added to the catalog reaches both at once.
 *
 * Account types are top-level commands named after the type in kebab case
 * (`alarm-rule`, `device-property`: child types name their parent first and
 * take its ids as the first arguments); server types go under `admin`.
 * A command written by hand wins: a generated verb whose name a group
 * already has is left out.
 */

/** Verbs a type may have, in the order the help shows them. */
const VERBS = /** @type {const} */ (['list', 'get', 'create', 'update', 'delete', 'clone']);

const kebab = (name) => name.replaceAll('_', '-');

/** Command a type lives under: `alarm-rule`, `admin user`. */
export function commandPath(type) {
    return CATALOG[type].scope === 'server' ? ['admin', kebab(type)] : [kebab(type)];
}

/**
 * The catalog's description for a command line: what names MCP tools
 * (sentences, or remarks in parentheses) is for agents.
 */
export function cliDescription(text) {
    return text
        .replace(/\s*\([^)]*\btools?\b[^)]*\)/g, '')
        .split(/(?<=\.)\s+/)
        .filter((s) => !s.includes('{tool:'))
        .join(' ')
        .trim()
        .replace(/\.$/, '');
}

/** The first sentence, for a line of help: the whole text goes after the options. */
const firstSentence = (text) => text.split(/(?<=[.;:])\s+/)[0].replace(/[.;:]$/, '');

/** Whether a command answers to `name`, by its name or an alias. */
export const named = (cmd, name) => cmd.name() === name || cmd.aliases().includes(name);

/** Argument names of a type's parents, outermost first. */
const parentArgs = (type) => ancestry(type).flatMap((t) => idNames(CATALOG[t]));

/**
 * Register the commands on `program`.
 *
 * @param {import('commander').Command} program
 * @param {{
 *   hooks?: Record<string, import('../mcp/resource-hooks.js').ResourceHooks>,
 * }} [opts]
 */
export function registerResourceCommands(program, { hooks } = {}) {
    const tools = Object.fromEntries(resourceTools({ hooks }).map((t) => [t.name, t.handler]));

    /**
     * Find or make a subcommand: groups written by hand keep theirs. A
     * command of that name without subcommands is the CLI's own leaf: no
     * group (`leaf`).
     */
    const group = (parent, name, describe) => {
        const found = parent.commands.find((c) => named(c, name));
        if (found) return { cmd: found, existing: true, leaf: !found.commands.length };
        const cmd = parent.command(name).description(describe());
        return { cmd, existing: false, leaf: false };
    };

    let admin;
    for (const [type, spec] of Object.entries(CATALOG)) {
        let parent = program;
        const path = commandPath(type);
        if (path.length === 2) {
            admin ??= group(
                program,
                'admin',
                () => 'Server administration (admin accounts): users, hosts, domains, brands…',
            );
            if (admin.leaf) continue;
            if (!admin.existing) admin.cmd.helpGroup('Administration:');
            parent = admin.cmd;
        }
        const { cmd, existing, leaf } = group(parent, path[path.length - 1], () =>
            cliDescription(spec.description),
        );
        if (leaf) continue;
        if (!existing && parent === program) cmd.helpGroup('Resources:');
        const has = (name) => cmd.commands.some((c) => named(c, name));

        for (const verb of VERBS) {
            if (verb in spec.ops && !has(verb)) addVerb(cmd, type, verb, tools);
        }
        if (!has('describe')) addDescribe(cmd, type, tools);
        for (const [action, a] of Object.entries(spec.actions || {})) {
            if (!has(kebab(action))) addAction(cmd, type, action, a, tools);
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

/**
 * Run an MCP tool handler as a command and print its answer: its text, or
 * its data with --json.
 *
 * @param {(args: any) => any} handler
 * @param {Record<string, any>} args
 * @param {{ output?: string }} [opts]  `output`: write the answer (JSON) to this file.
 */
export async function runTool(handler, args, { output } = {}) {
    try {
        const result = await handler(args);
        if (result?.isError) {
            const message = result.content?.map((c) => c.text).join('\n') || 'failed';
            printErr(message, { code: 'error' });
            return;
        }
        if (output) {
            const data =
                DATA in result ? result[DATA] : result.content?.map((c) => c.text).join('\n');
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
        if (isJsonMode()) {
            printOk(DATA in result ? result[DATA] : result.content?.map((c) => c.text).join('\n'));
            return;
        }
        for (const c of result.content || []) if (c.type === 'text') console.log(c.text);
    } catch (error) {
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
}

const SUMMARY = {
    list: (t) => `List ${t} records`,
    get: (t) => `Show a ${t} as JSON`,
    create: (t) => `Create a ${t} from --from and --set`,
    update: (t) => `Update fields of a ${t} (fields left out are kept)`,
    delete: (t) => `Delete a ${t}`,
    clone: (t) => `Copy a ${t} under a new id`,
};

function addVerb(group, type, verb, tools) {
    const spec = CATALOG[type];
    const parents = parentArgs(type);
    const ids = idNames(spec);
    const what = kebab(type);
    // A create may take its id from the body, unless it is stored under it.
    const optionalIds = verb === 'create' && !spec.upsert;
    const usage = [
        verb,
        argSpec(parents),
        verb === 'list' ? '' : argSpec(ids, optionalIds),
        verb === 'clone' ? '<new-id>' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const cmd = group
        .command(usage)
        .helpGroup('Generic:')
        .description(SUMMARY[verb](what))
        .option('-j, --json', 'Output as JSON');

    if (verb === 'list') {
        cmd.option('--search <text>', 'Text to look for in ids and names')
            .option(
                '--filter <key=value>',
                'Filter (repeatable): product, type, asset_type, asset_group, project, labels, or a field of the records',
                collectKeyValue,
            )
            .option('--count <n>', 'Page size (default: all)', parsePositiveInt('count'))
            .option('--index <n>', 'Offset of the first record', parseNonNegativeInt('index'));
    }
    if (verb === 'create' || verb === 'update' || verb === 'clone') bodyOptions(cmd);
    if ((verb === 'create' || verb === 'update') && 'projects' in spec.ops) {
        cmd.option(
            '--projects <list>',
            'Projects it belongs to, comma-separated "<owner>@<project>"',
        );
    }
    if (verb === 'update' && 'patch' in spec.ops) {
        cmd.option('--merge', 'Patch the value (JSON merge) instead of replacing it');
    }
    if (verb === 'delete') cmd.option('-y, --yes', 'Do not ask for confirmation');
    if (verb === 'get') cmd.option('-o, --output <file>', 'Write the JSON to a file');

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
            if (verb === 'list') {
                return runTool(tools.resource_list, {
                    ...base,
                    ...(opts.search ? { search: opts.search } : {}),
                    ...(opts.filter ? { filter: opts.filter } : {}),
                    ...(opts.count ? { count: opts.count } : { all: true }),
                    ...(opts.index !== undefined ? { index: opts.index } : {}),
                });
            }
            if (verb === 'get') return runTool(tools.resource_get, base, { output: opts.output });
            if (verb === 'delete') {
                const ok = await confirmDestructive(
                    opts,
                    `Delete ${what} ${[where.parent, where.id].filter(Boolean).join('/')}?`,
                );
                if (ok) await runTool(tools.resource_delete, base);
                return;
            }
            let body = (await bodyFromOptions(opts)) ?? {};
            // Only a create may take several records (an array of properties).
            if (verb !== 'create' && (typeof body !== 'object' || Array.isArray(body))) {
                throw inputError(`${verb} takes a JSON object`);
            }
            if (opts.projects) {
                if (Array.isArray(body)) throw inputError('--projects needs a JSON object body');
                body = {
                    ...body,
                    projects: opts.projects
                        .split(',')
                        .map((p) => p.trim())
                        .filter(Boolean),
                };
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
            const fields = spec.bodyId ?? ids;
            if (fields.length !== 1)
                throw inputError(`${what} cannot be cloned from the command line`);
            const copy = values[values.length - 1];
            return runTool(tools.resource_clone, { ...base, body: { ...body, [fields[0]]: copy } });
        } catch (error) {
            const { message, code } = classifyError(error);
            printErr(message, { code });
        }
    });
}

function addDescribe(group, type, tools) {
    group
        .command('describe')
        .helpGroup('Generic:')
        .description(`Fields, examples and permissions of a ${kebab(type)}, from the server's API`)
        .option('-j, --json', 'Output as JSON')
        .action(async (opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            await runTool(tools.resource_describe, { type });
        });
}

function addAction(group, type, action, spec, tools) {
    const parents = parentArgs(type);
    const ids = spec.on === 'collection' ? [] : idNames(CATALOG[type]);
    const usage = [kebab(action), argSpec(parents), argSpec(ids)].filter(Boolean).join(' ');
    const cmd = group
        .command(usage)
        .helpGroup('Actions:')
        .description(firstSentence(cliDescription(spec.description)))
        .option('-q, --query <key=value>', 'Query parameter (repeatable)', collectKeyString)
        .option('-o, --output <file>', 'Write the answer to a file')
        .option('-j, --json', 'Output as JSON');
    if (spec.method !== 'get') bodyOptions(cmd);
    const full = cliDescription(spec.description);
    if (full !== firstSentence(full)) cmd.addHelpText('after', `\n${full}.`);
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
                { output: opts.output },
            );
        } catch (error) {
            const { message, code } = classifyError(error);
            printErr(message, { code });
        }
    });
}
