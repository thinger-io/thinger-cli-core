// @ts-check
import { getProfile, withActiveProfile } from '../config.js';
import { inputError } from '../errors.js';
import { toolName } from './naming.js';

/**
 * Key of the structured answer a tool result carries next to its text, for
 * the CLI commands that run the same handlers (`--json`). A symbol: it
 * never reaches the MCP client.
 */
export const DATA = Symbol('data');

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
    if (!profile) return fn();
    if (!getProfile(profile)) {
        throw inputError(
            `Unknown profile: ${profile}. Use ${toolName('profile_list')} to list available ones.`,
        );
    }
    return withActiveProfile(profile, fn);
}
