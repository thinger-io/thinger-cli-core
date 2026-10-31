// @ts-check
import { getActiveProfile, getProfile, listProfiles } from '../../config.js';

/**
 * The profiles of this CLI as a type of the resource tools: the lookup of
 * the profiles themselves, so it takes no `profile` (nor `user`).
 *
 * @type {import('../tools-resource.js').LocalType}
 */
export const profile = {
    description:
        'Profiles of this CLI: each one a server with its own credentials. Pass its name as `profile` to any tool to use that server for one call.',
    id: 'profile',
    profile: false,
    user: false,
    local: true,
    notes: 'Profiles are not accounts: another account on the same server is reached with `user` (admin only), not with a profile.',
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
            const data = getProfile(name) || {};
            return {
                profile: name,
                server: data.server || name,
                username: data.username || '',
                active: name === active,
            };
        });
    },
};
