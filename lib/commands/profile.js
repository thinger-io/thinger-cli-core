// @ts-check
import { input } from '@inquirer/prompts';
import {
    addImpersonatingProfile,
    describeProfile,
    listProfiles,
    profilesUsingCredentialsOf,
    updateProfile,
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
                    const data = describeProfile(name) || {};
                    return {
                        name,
                        active: name === active,
                        username: data.username || null,
                        server: data.server || null,
                        description: data.description || null,
                        impersonate: data.impersonate || null,
                        credentials_from: data.credentials_from || null,
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
                const data = describeProfile(name) || {};
                const marker = name === active ? success('* ') : '  ';
                const account = `${data.username || ''}@${data.server || name}`;
                const detail = data.credentials_from
                    ? `${account}  impersonating ${data.impersonate} with the credentials of ${data.credentials_from}`
                    : account;
                console.log(`${marker}${label(name)}  ${hint(detail)}`);
                if (data.description) console.log(`    ${data.description}`);
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
            'Add a profile for another server (interactive, or with --server/--username/--token), or one that acts as another account with the credentials of a profile (--credentials-from with --impersonate)',
        )
        .option('--no-activate', 'Do not set the new profile as default')
        .option(
            '-d, --description <text>',
            'What the profile is for (which account and work), shown to whoever picks a profile',
        )
        .option(
            '--credentials-from <profile>',
            'Use the server and session of this profile (no sign-in of its own); with --impersonate',
        )
        .option(
            '--impersonate <user>',
            'Act as this account (admin impersonation); with --credentials-from',
        )
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
            if (opts.credentialsFrom || opts.impersonate) {
                addImpersonating(nameArg, opts);
                return;
            }
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
                if (opts.description) updateProfile(name, { description: opts.description });
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
        .command('update <name>')
        .helpGroup('Profile:')
        .description('Change what a profile is for (its description)')
        .option(
            '-d, --description <text>',
            'What the profile is for (which account and work); "" removes it',
        )
        .option('-j, --json', 'Output as JSON')
        .action((name, opts) => {
            applyJsonFlag(opts);
            if (opts.description === undefined) {
                printErr('Nothing to change: pass -d, --description <text>.', {
                    code: 'input_error',
                });
                return;
            }
            try {
                updateProfile(name, { description: opts.description });
            } catch (error) {
                printErr(error.message, { code: error.code || 'error' });
                return;
            }
            if (isJsonMode()) {
                printOk({ updated: name, description: opts.description || null });
                return;
            }
            console.log(success(`Profile ${name} updated`));
        });

    profile
        .command('delete <name>')
        .helpGroup('Profile:')
        .description('Remove a profile')
        .option('-j, --json', 'Output as JSON')
        .action((name, opts) => {
            applyJsonFlag(opts);
            const users = profilesUsingCredentialsOf(name);
            if (users.length) {
                printErr(
                    `Profiles ${users.join(', ')} use the credentials of ${name}: delete them first.`,
                    { code: 'input_error' },
                );
                return;
            }
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

/**
 * `profile add <name> --credentials-from <profile> --impersonate <user>`:
 * nothing to sign in, the credentials are the other profile's.
 */
function addImpersonating(name, opts) {
    const signIn = ['server', 'username', 'token', 'oauth', 'clientId'].filter((o) => opts[o]);
    if (!name || !opts.credentialsFrom || !opts.impersonate || signIn.length) {
        printErr(
            'An impersonating profile takes a name, --credentials-from <profile> and --impersonate <user>, and no sign-in options: profile add <name> --credentials-from <profile> --impersonate <user>',
            { code: 'input_error' },
        );
        return;
    }
    try {
        addImpersonatingProfile(name, {
            credentialsFrom: opts.credentialsFrom,
            impersonate: opts.impersonate,
            description: opts.description,
        });
    } catch (error) {
        printErr(error.message, { code: error.code || 'error' });
        return;
    }
    const activate = opts.activate !== false;
    if (activate) setDefaultProfile(name);
    if (isJsonMode()) {
        printOk({
            added: name,
            impersonate: opts.impersonate,
            credentials_from: opts.credentialsFrom,
            activated: activate,
            active: getActiveProfile(),
        });
        return;
    }
    const suffix = activate ? ' and set as default' : '';
    console.log(
        success(
            `Profile ${name} added${suffix}: impersonates ${opts.impersonate} with the credentials of ${opts.credentialsFrom}`,
        ),
    );
}
