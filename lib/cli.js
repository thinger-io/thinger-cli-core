// @ts-check
import { Command } from 'commander';
import { setActiveProfile } from './config.js';
import { env, identity } from './identity.js';

import { classifyError, detectJsonModeFromArgv } from './output.js';
import { startMCPServer } from './mcp/server.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerDeviceCommands } from './commands/device.js';
import { registerProductCommands } from './commands/product.js';
import { registerBucketCommands } from './commands/bucket.js';
import { registerDashboardCommands } from './commands/dashboard.js';
import { registerApiCommand } from './commands/api.js';
import { registerResourceCommands } from './commands/resources.js';
import { registerDataCommands } from './commands/data.js';
import { describeArguments } from './commands/arguments.js';
import { NOUN_GROUPS, ROOT_GROUPS } from './commands/grammar.js';

/** Verbs of the records, in the order the help shows them. */
const RECORD_VERBS = ['list', 'get', 'create', 'update', 'delete', 'clone', 'set', 'describe'];

/**
 * Sort the commands of `cmd` (and below) by help group, records by verb,
 * keeping the order they were added in otherwise: the hand-written ones
 * and the generated ones of a group come together.
 *
 * @param {Command} cmd
 * @param {string[]} groups
 */
function orderHelp(cmd, groups) {
    const rank = (c) => {
        const i = groups.indexOf(c.helpGroup());
        // Other verbs of the records (thinr's `logs presets`) go after these.
        const verb = RECORD_VERBS.indexOf(c.name());
        const at = c.helpGroup() === 'Records:' ? (verb === -1 ? RECORD_VERBS.length : verb) : 0;
        return (i === -1 ? groups.length : i) * 100 + at;
    };
    // `commands` is typed readonly, but it is a plain array the help reads in order.
    /** @type {Command[]} */ (cmd.commands).sort((a, b) => rank(a) - rank(b));
    for (const sub of cmd.commands) orderHelp(sub, NOUN_GROUPS);
}

/**
 * @typedef {object} CliOptions
 * @property {string} version
 * @property {(program: Command, groups: { device: Command, product: Command, bucket: Command, dashboard: Command }) => void} [register]
 *   Adds the CLI's own commands, at the top level or inside the generic
 *   groups.
 * @property {(program: Command) => Promise<void> | void} [onNoCommand]
 *   Runs when the CLI is called without arguments (default: print the help).
 * @property {string} [mcpInstructions]
 * @property {Record<string, import('./mcp/resource-hooks.js').ResourceHooks>} [resourceHooks]
 *   The CLI's hooks on the catalog types the generic `resource_*` tools
 *   (and the generated commands) serve.
 * @property {Record<string, import('./mcp/tools-resource.js').LocalType>} [resourceTypes]
 *   Types the CLI adds to that catalog (its platform's own things).
 * @property {Record<string, Record<string, import('./mcp/tools-resource.js').LocalAction>>} [resourceActions]
 *   Actions it adds to the catalog's types and its own.
 * @property {Parameters<typeof import('./docs.js').defineCliDocs>[0]} [docs]
 *   Guides the CLI ships, served as type `doc` of the resource tools and as
 *   MCP resources next to the server's documentation.
 * @property {Parameters<typeof describeArguments>[1]} [argumentHelp]
 *   Help of the positional arguments of the CLI's own commands.
 */

/**
 * The command tree of a CLI on top of the core: global options, the
 * commands written by hand (login, logout, profile, device, product,
 * bucket, dashboard, api), the CLI's own (`register`), the commands over
 * the MCP tools, the generated resource commands and `mcp`. The identity
 * must be defined before calling it.
 *
 * @param {CliOptions & { strict?: boolean }} opts
 *   `strict` (tests): a generated group a CLI's command takes the place of
 *   throws instead of being left out.
 */
export function buildProgram({
    version,
    register,
    mcpInstructions,
    resourceHooks,
    resourceTypes,
    resourceActions,
    docs,
    argumentHelp,
    strict = false,
}) {
    const id = identity();
    const program = new Command();
    program
        .name(id.name)
        .description(id.description)
        .version(version)
        .option('-u, --user <username>', 'API user override (admin impersonation)')
        .option('--profile <name>', 'Configuration profile to use (defaults to the saved default)');

    const groups = {
        device: registerDeviceCommands(program),
        product: registerProductCommands(program),
        bucket: registerBucketCommands(program),
        dashboard: registerDashboardCommands(program),
    };
    registerAuthCommands(program);
    registerProfileCommands(program);
    registerApiCommand(program);
    register?.(program, groups);
    // After the CLI's own: a command it registers keeps its name.
    registerDataCommands(program);
    registerResourceCommands(program, { hooks: resourceHooks, strict });
    describeArguments(program, argumentHelp);

    program
        .command('mcp')
        .helpGroup('Integration:')
        .description('Start the MCP server (stdio) for AI tool integration')
        .option(
            '--read-only',
            `Serve only the tools that read: describe, list, get and the read-only actions (or set ${identity().envPrefix}_MCP_READ_ONLY=1)`,
        )
        .action(async (opts) => {
            try {
                await startMCPServer({
                    version,
                    readOnly: !!opts.readOnly || /^(1|true|yes)$/i.test(env('MCP_READ_ONLY') ?? ''),
                    instructions: mcpInstructions,
                    resourceHooks,
                    resourceTypes,
                    resourceActions,
                    docs,
                });
            } catch (error) {
                console.error(`Error: ${classifyError(error).message}`);
                process.exit(1);
            }
        });

    orderHelp(program, ROOT_GROUPS);
    return program;
}

/**
 * Build and run a CLI on top of the core (see buildProgram). The identity
 * must be defined before calling it.
 *
 * @param {CliOptions & { argv?: string[] }} opts
 */
export async function runCli({ argv = process.argv, onNoCommand, ...opts }) {
    // Pick up --profile early so subsequent config reads use the right one.
    // Commander parses options later, but the config is touched before that.
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') break;
        if (a === '--profile' && argv[i + 1]) {
            setActiveProfile(argv[i + 1]);
            break;
        }
        if (a.startsWith('--profile=')) {
            setActiveProfile(a.slice('--profile='.length));
            break;
        }
    }

    // Set JSON mode before any command runs so spinners/logs can opt out.
    detectJsonModeFromArgv(argv);

    const program = buildProgram(opts);
    if (argv.length <= 2) {
        if (onNoCommand) await onNoCommand(program);
        else program.help();
        return;
    }
    await program.parseAsync(argv);
}
