// @ts-check
import { listDocs, readDoc } from '../../docs.js';

/**
 * The guides for agents and app developers (docs.js) as a type of the
 * resource tools: list them, read one whole.
 *
 * @type {import('../tools-resource.js').LocalType}
 */
export const doc = {
    description:
        "Guides for agents and app developers: the platform's concepts, product code, server administration, the dashboard SDK reference and types (the version the project in this folder uses), and this CLI's own.",
    id: 'doc',
    user: false,
    local: true,
    notes: 'Read the relevant guide before building something new: list gives the ids.',
    examples: [
        {
            tool: 'resource_get',
            arguments: { type: 'doc', ids: { doc: 'concepts' } },
            does: "Read the guide to the platform's concepts.",
        },
    ],
    async list() {
        return (await listDocs()).map((d) => ({
            doc: d.id,
            title: d.title,
            ...(d.description ? { description: d.description } : {}),
            format: d.format,
        }));
    },
    async get(ctx) {
        return (await readDoc(String(ctx.id))).text;
    },
};
