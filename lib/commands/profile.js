// @ts-check
import { input } from '@inquirer/prompts';
import {
    listProfiles,
    getActiveProfile,
    getProfile,
    setActiveProfile,
    setDefaultProfile,
    deleteProfile,
} from '../config.js';
import { authenticate } from '../auth.js';
import { identity } from '../identity.js';
import { isJsonMode, printOk, printErr } from '../output.js';
import { hint, success, label } from '../format.js';
import { applyJsonFlag } from './_shared.js';

export function registerProfileCommands(program) {
    const profile = program
        .command('profile')
        .helpGroup('Configuration:')
        .description('Manage configuration profiles');

    profile
        .command('list')
        .helpGroup('Profile:')
        .description('List configured profiles')
        .option('-j, --json', 'Output as JSON')
        .action((opts) => {
            applyJsonFlag(opts);
            const names = listProfiles();
            const active = getActiveProfile();
            if (isJsonMode()) {
                const entries = names.map((name) => {
                    const data = getProfile(name) || {};
                    return {
                        name,
                        active: name === active,
                        username: data.username || null,
                        server: data.server || null,
                    };
                });
                printOk({ active, profiles: entries });
                return;
            }
            if (!names.length) {
                console.log(
                    hint(`No profiles configured. Run \`${identity().name} login\` to set one up.`),
                );
                return;
            }
            for (const name of names) {
                const data = getProfile(name) || {};
                const marker = name === active ? success('* ') : '  ';
                const detail = hint(`${data.username || ''}@${data.server || name}`);
                console.log(`${marker}${label(name)}  ${detail}`);
            }
        });

    profile
        .command('current')
        .helpGroup('Profile:')
        .description('Print the active profile')
        .option('-j, --json', 'Output as JSON')
        .action((opts) => {
            applyJsonFlag(opts);
            const name = getActiveProfile();
            if (isJsonMode()) {
                printOk({ active: name });
                return;
            }
            if (!name) {
                console.log(hint('No active profile.'));
                return;
            }
            console.log(name);
        });

    profile
        .command('use <name>')
        .helpGroup('Profile:')
        .description('Set the default profile')
        .option('-j, --json', 'Output as JSON')
        .action((name, opts) => {
            applyJsonFlag(opts);
            try {
                setDefaultProfile(name);
            } catch (error) {
                printErr(error.message, { code: 'not_found' });
                return;
            }
            if (isJsonMode()) {
                printOk({ active: name });
                return;
            }
            console.log(success(`Default profile set to ${name}`));
        });

    profile
        .command('add [name]')
        .helpGroup('Profile:')
        .description(
            'Add a profile for another server (interactive, or with --server/--username/--token)',
        )
        .option('--no-activate', 'Do not set the new profile as default')
        .option('--server <server>', 'Server host (or URL for http / custom ports)')
        .option('--username <username>', 'Account username')
        .option(
            '--token <token>',
            'Existing API token (non-interactive with --server and --username)',
        )
        .option('--oauth', 'Sign in through the browser (OAuth device flow)')
        .option('--client-id <id>', 'OAuth client id registered on the server')
        .option('-j, --json', 'Output as JSON')
        .action(async (nameArg, opts) => {
            applyJsonFlag(opts);
            let name = nameArg;
            if (!name && !process.stdin.isTTY) {
                printErr('Pass the profile name: profile add <name>', { code: 'input_error' });
                return;
            }
            if (!name) {
                try {
                    name = await input({
                        message: 'Profile name:',
                        validate: (v) => {
                            const trimmed = (v || '').trim();
                            if (!trimmed) return 'Profile name is required';
                            if (/\s/.test(trimmed)) return 'Profile name cannot contain whitespace';
                            return true;
                        },
                    });
                } catch (error) {
                    printErr(error.message || 'Prompt cancelled');
                    return;
                }
            }
            name = name.trim();
            if (getProfile(name)) {
                printErr(`Profile already exists: ${name}`, { code: 'already_exists' });
                return;
            }
            setActiveProfile(name);
            try {
                await authenticate({
                    method: opts.oauth ? 'oauth' : opts.token ? 'token' : undefined,
                    server: opts.server,
                    username: opts.username,
                    token: opts.token,
                    clientId: opts.clientId,
                });
                const saved = getProfile(name);
                if (!saved || !saved.token || !saved.username) {
                    throw new Error('Authentication did not complete; profile discarded.');
                }
            } catch (error) {
                setActiveProfile(null);
                try {
                    deleteProfile(name);
                } catch {
                    // Best-effort cleanup — ignore secondary failures
                }
                printErr(error.message || 'Authentication failed');
                return;
            }
            const activate = opts.activate !== false;
            if (activate) setDefaultProfile(name);
            setActiveProfile(null);
            if (isJsonMode()) {
                printOk({ added: name, activated: activate, active: getActiveProfile() });
                return;
            }
            const suffix = activate ? ' and set as default' : '';
            console.log(success(`Profile ${name} added${suffix}`));
        });

    profile
        .command('delete <name>')
        .helpGroup('Profile:')
        .description('Remove a profile')
        .option('-j, --json', 'Output as JSON')
        .action((name, opts) => {
            applyJsonFlag(opts);
            const ok = deleteProfile(name);
            if (!ok) {
                printErr(`Profile not found: ${name}`, { code: 'not_found' });
                return;
            }
            if (isJsonMode()) {
                printOk({ removed: name });
                return;
            }
            console.log(success(`Removed profile ${name}`));
        });
}
