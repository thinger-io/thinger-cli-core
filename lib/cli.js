// @ts-check
import { Command } from 'commander';
import { setActiveProfile } from './config.js';
import { identity } from './identity.js';
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
import { registerToolCommands } from './commands/tools.js';
import { describeArguments } from './commands/arguments.js';

/**
 * Build and run a CLI on top of the core: global options, the generic
 * commands (login, logout, profile, device, product, bucket, dashboard) and `mcp`.
 * The identity must be defined before calling it.
 *
 * @param {{
 *   version: string,
 *   argv?: string[],
 *   register?: (program: Command, groups: { device: Command, product: Command, bucket: Command, dashboard: Command }) => void,
 *   onNoCommand?: (program: Command) => Promise<void> | void,
 *   mcpTools?: Array<object>,
 *   mcpInstructions?: string,
 *   resourceHooks?: Record<string, import('./mcp/resource-hooks.js').ResourceHooks>,
 *   resourceTypes?: Record<string, import('./mcp/tools-resource.js').LocalType>,
 *   resourceActions?: Record<string, Record<string, import('./mcp/tools-resource.js').LocalAction>>,
 *   docs?: Parameters<typeof import('./docs.js').defineCliDocs>[0],
 * }} opts
 *   `register` adds the CLI's own commands, at the top level or inside the
 *   generic groups. `onNoCommand` runs when the CLI is called without
 *   arguments (default: print the help). `mcpTools` are the CLI's own MCP
 *   tools (see buildTools), and `resourceHooks` its hooks on the
 *   catalog types the generic `resource_*` tools serve; `resourceTypes` and
 *   `resourceActions` are types and actions it adds to that catalog (its
 *   platform's own things, served by the same tools). `docs` are guides
 *   the CLI ships, served by `doc_read` and as MCP resources next to the
 *   server's documentation.
 */
export async function runCli({
    version,
    argv = process.argv,
    register,
    onNoCommand,
    mcpTools = [],
    mcpInstructions,
    resourceHooks,
    resourceTypes,
    resourceActions,
    docs,
}) {
    const id = identity();

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
    registerToolCommands(program, groups);
    registerResourceCommands(program, { hooks: resourceHooks });
    describeArguments(program);

    program
        .command('mcp')
        .helpGroup('Integration:')
        .description('Start the MCP server (stdio) for AI tool integration')
        .action(async () => {
            try {
                await startMCPServer({
                    version,
                    tools: mcpTools,
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

    if (argv.length <= 2) {
        if (onNoCommand) await onNoCommand(program);
        else program.help();
        return;
    }
    await program.parseAsync(argv);
}
