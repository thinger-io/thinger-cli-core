// @ts-check
import {
    addImpersonatingProfile,
    describeProfile,
    getActiveProfile,
    getPendingLogin,
    getProfile,
    listProfiles,
    pendingLoginNames,
    updateProfile,
} from '../../config.js';
import { checkDeviceLogin, startDeviceLogin } from '../../device-login.js';
import { inputError } from '../../errors.js';
import { identity } from '../../identity.js';

/** A profile as the tools show it: never its tokens. */
function view(name, active = getActiveProfile()) {
    const data = describeProfile(name) || {};
    const pending = getPendingLogin(name);
    return {
        profile: name,
        server: data.server || pending?.server || name,
        username: data.username || '',
        description: data.description || pending?.description || '',
        active: name === active,
        // Acts as `username` with the session of another profile.
        ...(data.credentials_from && {
            impersonate: data.impersonate,
            credentials_from: data.credentials_from,
        }),
        ...(pending?.status === 'pending' && {
            login: {
                status: 'pending',
                url: pending.verification_uri_complete,
                code: pending.user_code,
                expires_at: new Date(pending.expires_at).toISOString(),
            },
        }),
    };
}

/** What to tell the user, and do next, for a login in each state. */
function nextStep(state) {
    const cli = identity().name;
    switch (state.status) {
        case 'pending':
            return `Give the user this link to approve the sign-in with their account (the code ${state.code} is filled in): ${state.url}. Then call resource_call type "profile" action "status" with ids {"profile": "${state.profile}"}; it saves the session once approved. The code expires at ${state.expires_at}.`;
        case 'approved':
            return `Signed in as ${state.username}: pass "profile": "${state.profile}" to the tools to use it.`;
        case 'denied':
            return 'The user refused the sign-in in the browser. Start another with the action "login" only if they ask.';
        case 'expired':
            return 'The code expired before it was approved. Start another with the action "login" if the user still wants to sign in.';
        default:
            return `No sign-in under way for this profile: start one with the action "login" (or the user runs \`${cli} --profile ${state.profile} login\` in a terminal).`;
    }
}

const withNext = (state) => ({ ...state, next: nextStep(state) });

/**
 * The profiles of this CLI as a type of the resource tools: the lookup of
 * the profiles themselves, so it takes no `profile` (nor `user`).
 *
 * An agent can add a profile that acts as another account with the
 * session of one already signed in, describe a profile, and sign one in
 * through the browser: it starts the login, the user approves it with
 * their account at the link it gets, and `status` saves the session.
 * Passwords and tokens are never taken here: they stay with the user.
 *
 * @type {import('../tools-resource.js').LocalType}
 */
export const profile = {
    description:
        'Profiles of this CLI: each one a server and an account, with a description of what it is for. Pass its name as `profile` to any tool to use it for one call; read the descriptions before using one other than the default.',
    id: 'profile',
    profile: false,
    user: false,
    local: true,
    notes: 'A profile is a server and an account: `username` is the account it acts on. Some act as another account (`impersonate`) with the session of an admin profile (`credentials_from`): use them like any other for that account; what is not on an account (users, hosts, server settings) needs the admin profile. Another account without a profile of its own is reached with `user` (admin only).\n\nAdding one: create with credentials_from and impersonate makes a profile that acts as another account with the session of a profile already signed in. A profile with a session of its own is signed in through the browser: the action "login" (body: server for a new one, description) answers a link for the user to approve the sign-in with their account; then the action "status" saves the session (call it once the user says they approved, or every few seconds while they do). Never ask the user for a password or a token: a sign-in with those is done by the user in a terminal. update changes the description. Profiles are removed by the user (`profile delete`), not here.',
    schema: {
        type: 'object',
        properties: {
            description: {
                type: 'string',
                description:
                    'What the profile is for: which account, and which work it is used for.',
            },
            credentials_from: {
                type: 'string',
                description:
                    'create: the profile whose server and session it uses (signed in as an admin).',
            },
            impersonate: {
                type: 'string',
                description: 'create: the account it acts as, with credentials_from.',
            },
        },
    },
    examples: [
        {
            tool: 'resource_list',
            arguments: { type: 'profile' },
            does: 'The configured servers, the default one marked active.',
        },
        {
            tool: 'resource_create',
            arguments: {
                type: 'profile',
                ids: { profile: 'monitoring' },
                body: {
                    credentials_from: 'acme',
                    impersonate: 'monitoring',
                    description: 'Service account monitoring: the monitored servers.',
                },
            },
            does: 'A profile that acts as the account monitoring with the session of the admin profile acme.',
        },
        {
            tool: 'resource_call',
            arguments: {
                type: 'profile',
                action: 'login',
                ids: { profile: 'acme' },
                body: { server: 'acme.aws.thinger.io', description: 'Admin account of acme.' },
            },
            does: 'Start the browser sign-in of a new profile acme: answers the link for the user to approve.',
        },
        {
            tool: 'resource_call',
            arguments: { type: 'profile', action: 'status', ids: { profile: 'acme' } },
            does: 'Check the sign-in: saves the session once the user approved it.',
        },
    ],
    list() {
        const active = getActiveProfile();
        const names = listProfiles();
        // A profile being signed in for the first time, not saved yet.
        for (const name of pendingLoginNames()) if (!names.includes(name)) names.push(name);
        return names.map((name) => view(name, active));
    },
    get(ctx) {
        const name = String(ctx.id);
        if (!getProfile(name) && !getPendingLogin(name)) {
            throw Object.assign(new Error(`Profile not found: ${name}`), { code: 'not_found' });
        }
        return view(name);
    },
    create(body, ctx) {
        const name = String(ctx.id ?? '');
        if (!body.credentials_from || !body.impersonate) {
            throw inputError(
                'create makes a profile that acts as another account: give credentials_from and impersonate. A profile with a session of its own is signed in with the action "login".',
            );
        }
        addImpersonatingProfile(name, {
            credentialsFrom: body.credentials_from,
            impersonate: body.impersonate,
            description: body.description,
        });
        return view(name);
    },
    update(body, ctx) {
        const name = String(ctx.id);
        const other = Object.keys(body).filter((k) => k !== 'description');
        if (other.length || body.description === undefined) {
            throw inputError('update changes the description only: send {"description": "…"}.');
        }
        updateProfile(name, { description: body.description });
        return view(name);
    },
    actions: {
        login: {
            description:
                'Start the browser sign-in of a profile (a new one, or one whose session expired): answers a link for the user to approve with their account. Then call status. Never takes a password or a token.',
            local: true,
            body: {
                type: 'object',
                properties: {
                    server: {
                        type: 'string',
                        description:
                            'The server (host, or URL for http / custom ports); a new profile needs it.',
                    },
                    description: {
                        type: 'string',
                        description: 'What a new profile is for, saved with it.',
                    },
                    client_id: {
                        type: 'string',
                        description:
                            "OAuth client registered on the server, when not the CLI's own.",
                    },
                    make_default: {
                        type: 'boolean',
                        description:
                            'Make it the default profile once signed in (only if the user asks).',
                    },
                },
            },
            async run(body, ctx) {
                const b = body ?? {};
                const existing = getProfile(String(ctx.id));
                if (existing && b.server && b.server !== existing.server) {
                    throw inputError(
                        `Profile ${ctx.id} is of ${existing.server ?? 'another server'}: sign it in there (leave server out), or add a new profile for ${b.server}.`,
                    );
                }
                const state = await startDeviceLogin(String(ctx.id), {
                    server: b.server,
                    clientId: b.client_id,
                    description: b.description,
                    activate: b.make_default === true ? true : undefined,
                });
                return withNext(state);
            },
        },
        status: {
            description:
                'How the browser sign-in of a profile is going: pending (with the link again), approved (the session is saved now), denied or expired.',
            local: true,
            async run(_body, ctx) {
                return withNext(await checkDeviceLogin(String(ctx.id)));
            },
        },
    },
};
