// @ts-check
import { authenticate, revokeCliToken } from '../auth.js';
import {
    configExists,
    credentialsProfile,
    deleteConfig,
    deleteProfile,
    getActiveProfile,
    getProfile,
    listProfiles,
    profilesUsingCredentialsOf,
    setActiveProfile,
} from '../config.js';
import { hint, info, warning } from '../format.js';
import { env, identity } from '../identity.js';
import { classifyError, createSpinner, printErr } from '../output.js';

/**
 * `login` (re)authenticates a profile; `logout` forgets one — or all — and
 * revokes the API token the CLI minted for it, if any.
 */
export function registerAuthCommands(program) {
    program
        .command('login')
        .helpGroup('Configuration:')
        .description(
            'Sign in: re-authenticate the current profile, or create the first one. Use `profile add` for more servers.',
        )
        .option('--server <server>', 'Server host (or URL for http / custom ports)')
        .option('--username <username>', 'Account username')
        .option(
            '--token <token>',
            'Existing API token (non-interactive login with --server and --username)',
        )
        .option('--oauth', 'Sign in through the browser (OAuth device flow)')
        .option('--client-id <id>', 'OAuth client id registered on the server')
        .action(async (opts) => {
            try {
                // Pin the target to the active/default profile by name so
                // the refreshed credentials overwrite it in place, even when
                // the profile name differs from the server hostname.
                const name = getActiveProfile();
                if (name) setActiveProfile(name);
                const holder = credentialsProfile(name);
                if (holder !== name) {
                    console.log(
                        info(
                            `Profile ${name} uses the credentials of ${holder}: signing in ${holder}.`,
                        ),
                    );
                }
                await authenticate({
                    method: opts.oauth ? 'oauth' : opts.token ? 'token' : undefined,
                    server: opts.server,
                    username: opts.username,
                    token: opts.token,
                    clientId: opts.clientId,
                });
                console.log(info(`Signed in (profile ${getActiveProfile()}).`));
                if (env('TOKEN')) {
                    console.log(
                        warning(
                            `${identity().envPrefix}_TOKEN is set: commands use it instead of this profile until you unset it.`,
                        ),
                    );
                }
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    program
        .command('logout')
        .helpGroup('Configuration:')
        .description(
            'Forget the current profile (or --all) and revoke the API token the CLI created',
        )
        .option('--all', 'Forget every profile')
        .option('--keep-token', 'Do not revoke the API token on the server')
        .action(async (opts) => {
            if (!configExists()) {
                console.log(warning('No configuration found. Already logged out.'));
                return;
            }
            const active = getActiveProfile();
            if (!opts.all && !active && env('TOKEN')) {
                // <PREFIX>_TOKEN stands for the profile: there is nothing saved to forget.
                const prefix = identity().envPrefix;
                console.log(
                    warning(
                        `${prefix}_TOKEN is set and stands for the profile: unset it, or pass --profile to log out of a saved one.`,
                    ),
                );
                return;
            }
            const names = opts.all ? listProfiles() : [active];
            if (!opts.all) {
                // Its credentials are theirs too: forgetting it signs them out.
                const users = profilesUsingCredentialsOf(active);
                if (users.length) {
                    printErr(
                        `Profiles ${users.join(', ')} use the credentials of ${active}: remove them first (\`${identity().name} --profile <name> logout\`), or log out of everything with --all.`,
                        { code: 'input_error' },
                    );
                    return;
                }
            }
            for (const name of names) {
                const spinner = createSpinner(`Logging out of ${name}...`).start();
                // One that takes its credentials from another has none of its
                // own to revoke: forgetting it is all.
                if (!opts.keepToken && !getProfile(name)?.credentials_from) {
                    setActiveProfile(name);
                    try {
                        const outcome = await revokeCliToken();
                        if (outcome === 'revoked') spinner.text = `Revoked API token of ${name}`;
                    } catch (error) {
                        // Still forget the profile: a server that is gone or
                        // a token already invalid must not trap the user.
                        spinner.warn(
                            `Could not revoke the API token of ${name}: ${classifyError(error).message}`,
                        );
                    }
                    setActiveProfile(null);
                }
                const profile = getProfile(name);
                deleteProfile(name);
                spinner.succeed(
                    `Logged out of ${name} (${profile?.username || ''}@${profile?.server || name})`,
                );
            }
            if (opts.all) deleteConfig();
            if (!opts.all && listProfiles().length) {
                console.log(hint(`Default profile is now ${getActiveProfile()}.`));
            }
        });
}
