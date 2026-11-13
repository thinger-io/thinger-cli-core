// @ts-check
import { Command } from 'commander';
import { CATALOG } from '../mcp/catalog.js';
import {
    CORE_COMMANDS,
    actionName,
    commandPath,
    idArgs,
    parentArgs,
    registerResourceCommands,
    TYPE_AT,
} from './resources.js';

/**
 * The grammar every CLI on the core follows, as a check its tests run over
 * the whole command tree: `<cli> <noun> [<noun>…] <verb> [<parent ids>…]
 * [<id>] [<extra>] [options]`.
 *
 * - Groups are nouns (kebab case, at most 3 below the root, `admin` not
 *   counted) and run nothing themselves; leaves are verbs of a closed set.
 * - Positionals are ids, outermost parent first, named after their noun
 *   (`<device> <property>`), never `deviceId` or `device_id`, and described.
 * - Short options keep one meaning everywhere (RESERVED); on create, update
 *   and clone `-n`/`-d` are name and description.
 * - Commands that send JSON take `--from` and `-s, --set`; deletes take
 *   `-y`; lists take `--search --filter --count --index`; every command
 *   that runs something takes `-j, --json`.
 * - Every catalog type has its commands at commandPath(type), and a command
 *   written by hand in the place of a generated one takes at least its
 *   arguments and options. The operations of the core's types and actions
 *   (bucket_data, storage_file, doc…) have theirs at CORE_COMMANDS.
 * - Every command is in a help group; the root's are ROOT_GROUPS.
 *
 * A CLI states what it adds or does otherwise in `exceptions`.
 */

/** Help groups of the root, in the order the help shows them. */
export const ROOT_GROUPS = [
    'Resources:',
    'Administration:',
    'Configuration:',
    'Integration:',
    'Operations:',
];

/** Help groups inside a noun, first; a CLI's own come after. */
export const NOUN_GROUPS = ['Records:', 'Data:', 'Actions:', 'Subresources:'];

/** Verbs a leaf may be named after. */
export const VERBS = {
    records: ['list', 'get', 'create', 'update', 'delete', 'clone', 'describe', 'set'],
    data: ['read', 'write', 'send', 'export', 'import', 'overview', 'call', 'upload', 'download'],
    actions: ['set-product', 'apply', 'replace-all', 'stats'],
    local: ['init', 'dev', 'publish', 'login', 'logout', 'use', 'current', 'add'],
};

/** Short options and the one long option each stands for. */
export const RESERVED = {
    '-h': '--help',
    '-V': '--version',
    '-u': '--user',
    '-j': '--json',
    '-o': '--output',
    '-y': '--yes',
    '-s': '--set',
    '-q': '--query',
    '-X': '--method',
    '-f': '--field',
};

/** Commands at the root that are not resources. */
const ROOT_COMMANDS = ['admin', 'profile', 'login', 'logout', 'api', 'mcp', 'doc'];

/** Verbs whose body comes from `--from` and `-s`. */
const BODY_VERBS = ['create', 'update', 'clone', 'call', 'send', 'write'];

/**
 * @typedef {object} GrammarExceptions
 * @property {string[]} [root]   Root commands the CLI adds (`agent`, `playbook`).
 * @property {string[]} [verbs]  Leaf names the CLI adds (`exec`, `ls`, `tcp`…).
 * @property {Record<string, Record<string, string>>} [shorts]
 *   Per command path, short options with another meaning:
 *   `{ 'device logs': { '-f': '--follow' } }`.
 * @property {Record<string, Array<'json' | 'body' | 'yes' | 'list' | 'parents'>>} [skip]
 *   Per command path, rules it does not follow: `json` (no -j), `body`
 *   (no --from/-s), `yes` (a delete without -y), `list` (no list options),
 *   `parents` (does not take the ids of the nouns above it).
 */

/** What the core's own commands do otherwise. */
const CORE_EXCEPTIONS = {
    shorts: {
        'dashboard init': { '-s': '--storage' },
        'dashboard publish': { '-s': '--storage' },
    },
    skip: {
        // Interactive, or a server on stdio.
        login: ['json'],
        logout: ['json'],
        mcp: ['json'],
        // Local profiles, and lists that are not server collections.
        'profile list': ['list'],
        'profile delete': ['yes'],
        'profile update': ['body'],
        'device resource list': ['list'],
        'storage file list': ['list'],
        'doc list': ['list'],
    },
};

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const visible = (cmd) => cmd.commands.filter((c) => !c._hidden);
const find = (root, path) =>
    path.reduce((cmd, name) => cmd?.commands.find((c) => c.name() === name), root);
const longs = (cmd) => new Set(cmd.options.map((o) => o.long).filter(Boolean));

/**
 * Check a CLI's command tree against the grammar.
 *
 * @param {Command} program  As buildProgram makes it.
 * @param {{ exceptions?: GrammarExceptions }} [opts]
 * @returns {string[]}  The problems found, one line each: none when it follows it.
 */
export function checkGrammar(program, { exceptions = {} } = {}) {
    const problems = [];
    const say = (path, message) => problems.push(`${path.join(' ') || '(root)'}: ${message}`);
    const skip = (key, rule) =>
        [...(CORE_EXCEPTIONS.skip[key] || []), ...(exceptions.skip?.[key] || [])].includes(rule);
    const shortFor = (key, short) =>
        exceptions.shorts?.[key]?.[short] ?? CORE_EXCEPTIONS.shorts[key]?.[short];

    const catalogActions = Object.entries(CATALOG).flatMap(([t, s]) =>
        Object.keys(s.actions || {}).map((a) => actionName(t, a)),
    );
    const verbs = new Set([
        ...Object.values(VERBS).flat(),
        ...catalogActions,
        ...(exceptions.verbs || []),
    ]);
    const rootNames = new Set([
        ...Object.keys(CATALOG).map((t) => commandPath(t)[0]),
        ...ROOT_COMMANDS,
        ...(exceptions.root || []),
    ]);

    // Options of the root (-u, --profile) are never redefined below it.
    for (const o of program.options) {
        if (o.short && RESERVED[o.short] && RESERVED[o.short] !== o.long) {
            say([], `${o.short} is ${o.long}, not ${RESERVED[o.short]}`);
        }
    }

    const walk = (cmd, path) => {
        for (const sub of visible(cmd)) {
            const at = [...path, sub.name()];
            const key = at.join(' ');
            const nouns = (sub.commands.length ? at : path).filter((n, i) => i || n !== 'admin');
            if (!KEBAB.test(sub.name())) say(at, 'not kebab case');
            if (nouns.length > 3) say(at, `${nouns.length} nouns (at most 3)`);
            if (!sub.helpGroup()) say(at, 'in no help group');
            if (!path.length) {
                if (!rootNames.has(sub.name())) say(at, 'not a command of the root');
                if (!ROOT_GROUPS.includes(sub.helpGroup())) {
                    say(at, `help group "${sub.helpGroup()}" is not one of the root's`);
                }
            }
            if (sub.commands.length) {
                // @ts-ignore -- commander keeps the handler private
                if (sub._actionHandler) say(at, 'a group that runs something');
                if (VERBS.records.includes(sub.name())) say(at, 'a group named after a verb');
                walk(sub, at);
                continue;
            }
            if (path.length && !verbs.has(sub.name())) say(at, 'not a verb of the grammar');
            checkArguments(sub, path, at, key);
            checkOptions(sub, at, key);
        }
    };

    /** Positionals: kebab case, described, the parents' ids first, then the own id. */
    const checkArguments = (leaf, path, at, key) => {
        const names = leaf.registeredArguments.map((a) => a.name());
        for (const arg of leaf.registeredArguments) {
            if (!KEBAB.test(arg.name())) say(at, `argument <${arg.name()}> is not kebab case`);
            if (!arg.description) say(at, `argument <${arg.name()}> has no description`);
        }
        if (!path.length || skip(key, 'parents')) return;
        // The ids of the types above the leaf's group, outermost first.
        const parents = path.slice(0, -1).flatMap((_, i) => {
            const type = TYPE_AT.get(path.slice(0, i + 1).join(' '));
            return type ? idArgs(type) : [];
        });
        const own = TYPE_AT.get(path.join(' '));
        const verb = leaf.name();
        const expected = own && verb !== 'describe' ? [...parentArgs(own)] : parents;
        if (verb === 'describe') {
            if (names.length) say(at, 'describe takes no arguments');
            return;
        }
        if (names.slice(0, expected.length).join(' ') !== expected.join(' ')) {
            say(at, `arguments <${names.join('> <')}> do not start with <${expected.join('> <')}>`);
        }
        if (own && ['get', 'update', 'delete', 'clone', 'set'].includes(verb)) {
            const ids = idArgs(own);
            const mine = names.slice(expected.length, expected.length + ids.length);
            if (mine.join(' ') !== ids.join(' ')) {
                say(at, `the id of a ${own} is <${ids.join('> <')}>, not <${mine.join('> <')}>`);
            }
        }
    };

    const checkOptions = (leaf, at, key) => {
        const verb = leaf.name();
        const has = longs(leaf);
        for (const o of leaf.options) {
            if (o.short === '-u' || o.long === '--user' || o.long === '--profile') {
                say(at, `${o.flags} redefines an option of the root`);
            }
            const meaning = shortFor(key, o.short) ?? RESERVED[o.short];
            if (o.short && meaning && meaning !== o.long) {
                say(at, `${o.short} is ${o.long}, not ${meaning}`);
            }
            if (['create', 'update', 'clone'].includes(verb)) {
                if (o.short === '-n' && o.long !== '--name') say(at, `-n is ${o.long}, not --name`);
                if (o.short === '-d' && o.long !== '--description') {
                    say(at, `-d is ${o.long}, not --description`);
                }
            }
        }
        const short = (long) => leaf.options.find((o) => o.long === long)?.short;
        if (!skip(key, 'json') && short('--json') !== '-j') say(at, 'no -j, --json');
        if (BODY_VERBS.includes(verb) && !skip(key, 'body')) {
            if (!has.has('--from') || short('--set') !== '-s') say(at, 'no --from and -s, --set');
        }
        if ((verb === 'delete' || verb === 'replace-all') && !skip(key, 'yes')) {
            if (short('--yes') !== '-y') say(at, 'no -y, --yes');
        }
        if (verb === 'list' && !skip(key, 'list')) {
            for (const o of ['--search', '--filter', '--count', '--index']) {
                if (!has.has(o)) say(at, `no ${o}`);
            }
        }
    };

    walk(program, []);

    // Every type has its commands, and a command written by hand in the
    // place of a generated one takes at least its arguments and options.
    const generated = new Command();
    registerResourceCommands(generated);
    for (const type of Object.keys(CATALOG)) {
        const path = commandPath(type);
        const mine = find(program, path);
        if (!mine) {
            say(path, `no commands for ${type}`);
            continue;
        }
        for (const ref of find(generated, path).commands.filter((c) => !c.commands.length)) {
            const at = [...path, ref.name()];
            const leaf = mine.commands.find((c) => c.name() === ref.name());
            if (!leaf || leaf._hidden) {
                say(at, `missing (${type})`);
                continue;
            }
            const args = (c) => c.registeredArguments.map((a) => a.name()).join(' ');
            if (args(leaf) !== args(ref)) {
                say(at, `takes <${args(leaf)}> where the generated command takes <${args(ref)}>`);
            }
            const has = longs(leaf);
            const lacking = [...longs(ref)].filter((o) => !has.has(o));
            if (lacking.length) say(at, `lacks ${lacking.join(', ')} of the generated command`);
        }
    }
    for (const [op, words] of Object.entries(CORE_COMMANDS)) {
        const leaf = find(program, words.split(' '));
        if (!leaf || leaf._hidden || leaf.commands.length) say(words.split(' '), `missing (${op})`);
    }
    return problems;
}
