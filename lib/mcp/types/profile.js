// @ts-check
import { describeProfile, getActiveProfile, listProfiles } from '../../config.js';

/**
 * The profiles of this CLI as a type of the resource tools: the lookup of
 * the profiles themselves, so it takes no `profile` (nor `user`).
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
    notes: 'A profile is a server and an account: `username` is the account it acts on. Some act as another account (`impersonate`) with the session of an admin profile (`credentials_from`): use them like any other for that account; what is not on an account (users, hosts, server settings) needs the admin profile. Another account without a profile of its own is reached with `user` (admin only).',
    examples: [
        {
            tool: 'resource_list',
            arguments: { type: 'profile' },
            does: 'The configured servers, the default one marked active.',
        },
    ],
    list() {
        const active = getActiveProfile();
        return listProfiles().map((name) => {
            const data = describeProfile(name) || {};
            return {
                profile: name,
                server: data.server || name,
                username: data.username || '',
                description: data.description || '',
                active: name === active,
                // Acts as `username` with the session of another profile.
                ...(data.credentials_from && {
                    impersonate: data.impersonate,
                    credentials_from: data.credentials_from,
                }),
            };
        });
    },
};
