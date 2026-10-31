// @ts-check
import { resourceTools } from './tools-resource.js';
import { docMimeType, listDocs, readDoc } from '../docs.js';
import { identity } from '../identity.js';
import { expandToolRefs, opRef, toolName } from './naming.js';

/**
 * @typedef {object} ToolOptions
 * @property {Record<string, import('./resource-hooks.js').ResourceHooks>} [hooks]
 *   The CLI's own hooks on catalog types (see resource-hooks.js).
 * @property {Record<string, import('./tools-resource.js').LocalType>} [types]
 *   Resource types the CLI adds, served by the same `resource_*` tools.
 * @property {Record<string, Record<string, import('./tools-resource.js').LocalAction>>} [actions]
 *   Actions the CLI adds to resource types (the server's or its own).
 * @property {boolean} [readOnly]  Serve only what reads (`mcp --read-only`).
 */

/**
 * Build the tool list a CLI serves: the eight `resource_*` tools over the
 * catalog, the core's types and the CLI's, every name prefixed with the
 * identity's tool prefix, `{tool:x}` references in descriptions expanded,
 * and the optional `profile` parameter injected so callers can target any
 * configured environment per call without changing the saved default.
 *
 * Returns fresh objects: the declarations stay untouched, so building
 * twice (tests) never double-prefixes anything.
 *
 * @param {ToolOptions} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function buildTools(opts = {}) {
    const declared = resourceTools(opts);
    const known = new Set(declared.map((t) => t.name));

    return declared.map((t) => {
        const inputSchema = expandSchema(structuredClone(t.inputSchema), known, t.name);
        inputSchema.properties = inputSchema.properties || {};
        inputSchema.properties.profile = {
            type: 'string',
            description: `CLI profile (server) for this call; ${opRef('profile', 'list')} lists them. Omit for the default.`,
        };
        return {
            ...t,
            name: toolName(t.name),
            description: expandToolRefs(t.description, known, t.name),
            inputSchema,
        };
    });
}

/** Expand tool references in every `description` of a JSON schema. */
function expandSchema(node, known, where) {
    if (Array.isArray(node)) return node.map((n) => expandSchema(n, known, where));
    if (!node || typeof node !== 'object') return node;
    for (const [key, value] of Object.entries(node)) {
        node[key] =
            key === 'description' && typeof value === 'string'
                ? expandToolRefs(value, known, where)
                : expandSchema(value, known, where);
    }
    return node;
}

/**
 * MCP resources: the documents of docs.js (the platform's guides, the
 * dashboard SDK's and the CLI's own), each as `<prefix>://<id>`.
 */
export async function listResources() {
    const prefix = identity().mcp.toolPrefix;
    const docs = await listDocs();
    return docs.map((d) => ({
        uri: `${prefix}://${d.id}`,
        name: d.id,
        title: d.title,
        description: `${d.description || d.title} Also through ${opRef('doc', 'get')}.`,
        mimeType: docMimeType(d.format),
    }));
}

/** Text of the resource `<prefix>://<id>`. */
export async function readResource(uri) {
    const prefix = `${identity().mcp.toolPrefix}://`;
    if (!uri.startsWith(prefix)) throw new Error(`Unknown resource: ${uri}`);
    const { doc, text } = await readDoc(uri.slice(prefix.length));
    return { mimeType: docMimeType(doc.format), text };
}
