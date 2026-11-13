// @ts-check
import { authenticate, revokeCliToken } from '../auth.js';
import { waitDeviceLogin } from '../device-login.js';
import {
    getPendingLogin,
    configExists,
    deleteConfig,
    deleteProfile,
    getActiveProfile,
    getProfile,
    listProfiles,
    profilesUsingCredentialsOf,
    setActiveProfile,
} from '../config.js';
import { hint, info, label, warning } from '../format.js';
import { env, identity } from '../identity.js';
import { classifyError, createSpinner, isJsonMode, printErr, printOk } from '../output.js';
import { applyJsonFlag, parseNonNegativeInt } from './_shared.js';

/**
 * `login` (re)authenticates a profile; `logout` forgets one — or all — and
 * revokes the API token the CLI minted for it, if any.
 */
/** The account and server the active profile is signed in to now. */
function signedIn() {
    const profile = getProfile(getActiveProfile() ?? '') ?? {};
    return { username: profile.username ?? null, server: profile.server ?? null };
}

/**
 * Say where to approve a browser login just started, and how to finish it.
 *
 * @param {import('../device-login.js').LoginState} state
 */
export function reportStarted(state) {
    const next = `${identity().name} --profile ${state.profile} login --wait`;
    if (isJsonMode()) {
        printOk({ ...state, next });
        return;
    }
    console.log(
        `Open this page to approve the sign-in of profile ${label(state.profile)} (code ${label(state.code ?? '')}):`,
    );
    console.log(`  ${state.url}`);
    console.log(
        hint(
            `The code expires at ${new Date(state.expires_at ?? 0).toLocaleTimeString()}. Once approved, run: ${next}`,
        ),
    );
}

/**
 * `login --wait`: wait for the browser login under way of `name` and say
 * how it ended. Exits non-zero unless it was approved.
 *
 * @param {string} name
 * @param {number} [timeoutSeconds]
 */
async function finishLogin(name, timeoutSeconds) {
    const pending = getPendingLogin(name);
    if (!pending) {
        printErr(
            `No browser login under way for profile ${name}: start one with ${identity().name} --profile ${name} login --oauth --no-wait`,
            { code: 'not_found' },
        );
        return;
    }
    const spinner =
        pending.status === 'pending'
            ? createSpinner(
                  `Waiting for the approval at ${pending.verification_uri_complete} (code ${pending.user_code})...`,
              ).start()
            : null;
    let state;
    try {
        state = await waitDeviceLogin(name, {
            timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
        });
    } finally {
        spinner?.stop();
    }
    if (state.warning) console.error(warning(state.warning));
    if (state.status === 'approved') {
        if (isJsonMode()) {
            printOk(state);
            return;
        }
        console.log(info(`Signed in as ${state.username} (profile ${name}).`));
        return;
    }
    const again = `${identity().name} --profile ${name} login --oauth --no-wait`;
    const outcome = {
        pending: [
            `Not approved yet: open ${state.url} (code ${state.code}), then run this again.`,
            'pending',
        ],
        denied: [`The sign-in was refused in the browser. Start another: ${again}`, 'unauthorized'],
        expired: [`The code expired before it was approved. Start another: ${again}`, 'expired'],
        failed: [`It was approved, but not saved: ${state.error} Start another: ${again}`, 'error'],
        none: [`No browser login under way for profile ${name}: ${again}`, 'not_found'],
    }[state.status];
    // Exit code 2: not approved yet, run it again; 1: it ended without a session.
    printErr(outcome[0], { code: outcome[1], exitCode: state.status === 'pending' ? 2 : 1 });
}

export function registerAuthCommands(program) {
    program
        .command('login')
        .helpGroup('Configuration:')
        .description(
            'Sign in: re-authenticate the current profile, or create the first one. Without a terminal, --oauth starts the browser login and `login --wait` finishes it once approved. Use `profile add` for more servers.',
        )
        .option('--server <server>', 'Server host (or URL for http / custom ports)')
        .option('--username <username>', 'Account username')
        .option(
            '--token <token>',
            'Existing API token (non-interactive login with --server; the username is read from the token)',
        )
        .option('--oauth', 'Sign in through the browser (OAuth device flow)')
        .option('--client-id <id>', 'OAuth client id registered on the server')
        .option(
            '--wait',
            'Finish the browser login started without a terminal (or with --no-wait): wait for the approval and save the session',
        )
        .option(
            '--no-wait',
            'With --oauth: only start the browser login, print where to approve it, and return',
        )
        .option(
            '--timeout <seconds>',
            'With --wait: give up after this long (0 checks once; exit code 2 while not approved yet); by default until the code expires',
            parseNonNegativeInt('--timeout'),
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (opts) => {
            applyJsonFlag(opts);
            try {
                // Pin the target to the active/default profile by name so
                // the refreshed credentials overwrite it in place, even when
                // the profile name differs from the server hostname.
                const name = getActiveProfile();
                if (name) setActiveProfile(name);
                if (opts.wait === true) {
                    const others = ['server', 'username', 'token', 'oauth', 'clientId'].filter(
                        (o) => opts[o],
                    );
                    if (others.length || !name) {
                        printErr(
                            others.length
                                ? '--wait finishes a browser login already started: pass no sign-in options with it.'
                                : 'Name the profile whose browser login to finish: --profile <name> login --wait',
                            { code: 'input_error' },
                        );
                        return;
                    }
                    await finishLogin(name, opts.timeout);
                    return;
                }
                if (opts.timeout !== undefined) {
                    printErr('--timeout goes with --wait.', { code: 'input_error' });
                    return;
                }
                const state = await authenticate({
                    method: opts.oauth ? 'oauth' : opts.token ? 'token' : undefined,
                    server: opts.server,
                    username: opts.username,
                    token: opts.token,
                    clientId: opts.clientId,
                    // JSON is for scripts: the browser login is only started.
                    noWait: opts.wait === false || isJsonMode(),
                });
                if (state) {
                    reportStarted(state);
                    return;
                }
                if (isJsonMode()) {
                    printOk({ profile: getActiveProfile(), status: 'approved', ...signedIn() });
                    return;
                }
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
                // The server has no way to end one browser session: it lapses
                // on its own once unused, and this machine no longer has it.
                if (profile?.refresh_token) {
                    console.log(
                        hint(
                            `The browser session of ${name} is forgotten here; the server keeps it valid until it goes unused for about two months (it cannot end a single session yet).`,
                        ),
                    );
                }
            }
            if (opts.all) deleteConfig();
            if (!opts.all && listProfiles().length) {
                const now = getActiveProfile();
                console.log(
                    hint(
                        now
                            ? `Default profile is now ${now}.`
                            : `No default profile now: choose one with \`${identity().name} profile use <name>\`.`,
                    ),
                );
            }
        });
}
