// @ts-check
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { classifyError } from '../output.js';
import { identity } from '../identity.js';
import { buildTools, listResources, readResource } from './registry.js';
import { withProfile } from './helpers.js';
import { defineCliDocs } from '../docs.js';

/** What a tool declares that the protocol lists. */
const LISTED = ['name', 'title', 'description', 'inputSchema', 'annotations'];

/**
 * Start the MCP server over stdio. Serves the eight `resource_*` tools over
 * the catalog, the core's types and the CLI's; every tool takes an
 * optional `profile` (and `user`, for admin impersonation, where it
 * applies).
 *
 * stdout is the protocol channel from here on: diagnostics go to stderr.
 *
 * @param {{
 *   version?: string,
 *   instructions?: string,
 *   resourceHooks?: Record<string, import('./resource-hooks.js').ResourceHooks>,
 *   resourceTypes?: Record<string, import('./tools-resource.js').LocalType>,
 *   resourceActions?: Record<string, Record<string, import('./tools-resource.js').LocalAction>>,
 *   docs?: Parameters<typeof import('../docs.js').defineCliDocs>[0],
 *   readOnly?: boolean,
 * }} [opts]
 *   `version` is echoed in the `initialize` response's `serverInfo.version`;
 *   callers pass their `package.json#version` so the two never drift.
 *   `instructions` is the server-level guidance sent to the client.
 *   `resourceHooks` are the CLI's hooks on catalog types; `resourceTypes`
 *   and `resourceActions` the types and actions it adds to the catalog.
 *   `docs` are the guides the CLI ships (see docs.js). `readOnly` serves
 *   only what reads: describe, list, get, and the read-only actions.
 */
export async function startMCPServer({
    version = 'unknown',
    instructions,
    resourceHooks,
    resourceTypes,
    resourceActions,
    docs,
    readOnly = false,
} = {}) {
    const { mcp } = identity();
    defineCliDocs(docs);
    const tools = buildTools({
        hooks: resourceHooks,
        types: resourceTypes,
        actions: resourceActions,
        readOnly,
    });

    const server = new Server(
        {
            name: mcp.serverName,
            version,
        },
        {
            capabilities: { tools: {}, resources: {} },
            ...(instructions ? { instructions } : {}),
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) =>
            Object.fromEntries(LISTED.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])),
        ),
    }));

    /**
     * Ask the user to confirm an action with a high impact, when the client
     * can show a form (elicitation): the agent cannot answer for them.
     */
    const elicit = async (message) => {
        const result = await server.elicitInput({
            message,
            requestedSchema: {
                type: 'object',
                properties: {
                    confirm: {
                        type: 'boolean',
                        title: 'Do it',
                        description: 'Run it as described above.',
                    },
                },
                required: ['confirm'],
            },
        });
        return result.action === 'accept' && result.content?.confirm === true;
    };

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: await listResources(),
    }));

    // Resources are read with the default profile: the protocol gives them
    // no arguments to pick another.
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        const { mimeType, text } = await readResource(uri);
        return { contents: [{ uri, mimeType, text }] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments || {};
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        // An argument the tool does not declare is a misspelled one
        // ("aggregation" for "agg"): say so instead of silently ignoring it.
        const known = tool.inputSchema?.properties;
        const unknown = known ? Object.keys(args).filter((k) => !(k in known)) : [];
        if (unknown.length) {
            // A filter or body key written at the top: say where it goes.
            const hint = tool.explain?.(args, unknown);
            const message = `Unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. ${name} takes: ${Object.keys(known).join(', ')}.${hint ? ` ${hint}.` : ''}`;
            return {
                content: [{ type: 'text', text: `Error [input_error]: ${message}` }],
                isError: true,
                _meta: { code: 'input_error', message },
            };
        }
        const extra = server.getClientCapabilities()?.elicitation ? { elicit } : {};
        try {
            return await withProfile(args.profile, () => tool.handler(args, extra));
        } catch (error) {
            // Surface the same {message, code} pair the CLI emits in JSON
            // mode so MCP clients can pattern-match on `[code]` instead of
            // doing fuzzy matches on the human message.
            const { message, code } = classifyError(error);
            return {
                content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
                isError: true,
                _meta: { code, message },
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${mcp.serverName}-mcp] Server started`);
}
