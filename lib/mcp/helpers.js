// @ts-check
import { getActiveProfile, getProfile, withActiveProfile } from '../config.js';
import { inputError } from '../errors.js';
import { opRef } from './naming.js';

/**
 * Key of the structured answer a tool result carries next to its text, for
 * the CLI commands that run the same handlers (`--json`). A symbol: it
 * never reaches the MCP client.
 */
export const DATA = Symbol('data');

/**
 * Set on the arguments of a call a CLI command makes (runTool): the
 * answer is read by a person, so records go without the `ids` an agent
 * passes back.
 */
export const CLI = Symbol('cli');

/** A text tool result, with `data` for the CLI's --json when given. */
export const textResult = (t, data) => ({
    content: [{ type: 'text', text: t }],
    isError: false,
    ...(data === undefined ? {} : { [DATA]: data }),
});

/** Run `fn` against `profile` (when supplied) so callers can target any
 *  configured environment per tool call without persisting the change.
 *  The switch is scoped to this call's async chain: tool calls served
 *  concurrently against different profiles don't see each other's. */
export async function withProfile(profile, fn) {
    if (!profile) {
        // The default when the call starts, for all of it: changing the
        // default meanwhile must not move half the call to another server.
        const current = getActiveProfile();
        return current ? withActiveProfile(current, fn) : fn();
    }
    if (!getProfile(profile)) {
        throw inputError(
            `Unknown profile: ${profile}. ${opRef('profile', 'list')} lists the available ones.`,
        );
    }
    return withActiveProfile(profile, fn);
}
