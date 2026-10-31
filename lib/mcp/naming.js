// @ts-check
import { identity } from '../identity.js';

/**
 * Tool names carry the CLI's prefix (`thinger_devices`, `thinr_devices`), so
 * two CLIs can be plugged into the same MCP client side by side. Tool
 * modules declare the bare name (`devices`) and refer to other tools in
 * their descriptions as `{tool:devices}`, or to a family of them as
 * `{family:token}` (→ `thinger_token_*`); the registry expands both once
 * the identity is known. Handlers building messages at call time use
 * `toolName()` directly.
 *
 * The tools are the eight `resource_*` ones: an operation is a type and a
 * verb or action, written `{op:<type>.<verb|action>}` in the texts (the
 * resource tools expand it, checking it exists) and `opRef()` in code.
 */

const TOOL_REF = /\{(tool|family):([a-z0-9_]+)\}/g;

/** Full name of a tool: `<prefix>_<base>`. */
export function toolName(base) {
    return `${identity().mcp.toolPrefix}_${base}`;
}

/**
 * Replace every `{tool:<base>}` in `text` with the full tool name, and every
 * `{family:<stem>}` with `<prefix>_<stem>_*`. Throws on a reference to a
 * tool (or a family with no tool) that does not exist, so a renamed or
 * dropped tool cannot leave descriptions pointing nowhere.
 *
 * @param {string} text
 * @param {Set<string>} known Bare names of the registered tools.
 * @param {string} where Tool being expanded, for the error message.
 */
export function expandToolRefs(text, known, where) {
    return text.replace(TOOL_REF, (_, kind, base) => {
        if (kind === 'family') {
            if (![...known].some((name) => name.startsWith(`${base}_`))) {
                throw new Error(`MCP tool "${where}" refers to unknown tool family "${base}"`);
            }
            return `${toolName(base)}_*`;
        }
        if (!known.has(base)) {
            throw new Error(`MCP tool "${where}" refers to unknown tool "${base}"`);
        }
        return toolName(base);
    });
}

/** Verbs with a tool of their own; anything else is an action of resource_call. */
const VERB_TOOLS = new Set(['describe', 'list', 'get', 'create', 'update', 'delete', 'clone']);

/**
 * How an operation is called: `<prefix>_resource_list type "bucket_data"`,
 * `<prefix>_resource_call type "device" action "send"`.
 *
 * @param {string} type
 * @param {string} op  A verb or an action.
 */
export function opRef(type, op) {
    return VERB_TOOLS.has(op)
        ? `${toolName(`resource_${op}`)} type "${type}"`
        : `${toolName('resource_call')} type "${type}" action "${op}"`;
}
