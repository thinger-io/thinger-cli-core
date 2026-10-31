// @ts-check
import api from '../../api.js';
import { TIMEOUTS } from '../../constants.js';
import { apiError, inputError } from '../../errors.js';
import { pluginApi } from '../../paths.js';
import { textResult } from '../helpers.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * The API an installed plugin serves, at its own paths (no catalog): an
 * action of the catalog type plugin. Its body is an envelope (path,
 * method, body) and `query` goes to the plugin as is.
 *
 * @type {import('../tools-resource.js').LocalAction}
 */
export const pluginCall = {
    description:
        "Call the API an installed plugin serves: body {path, method, body} and the call's `query` go to the plugin as they are (what it offers depends on the plugin; see its documentation or try GET on its root).",
    query: true,
    body: {
        type: 'object',
        additionalProperties: false,
        properties: {
            path: { type: 'string', description: 'Path inside the plugin, e.g. "/api/status".' },
            method: { type: 'string', enum: METHODS, description: 'Default get.' },
            body: { description: 'JSON body for post, put and patch.' },
        },
    },
    examples: [
        {
            tool: 'resource_call',
            arguments: {
                type: 'plugin',
                action: 'call',
                ids: { plugin: 'node-red' },
                body: { path: '/api/status', method: 'get' },
            },
            does: "GET the plugin's /api/status.",
        },
    ],
    async run(body, ctx) {
        const b = body ?? {};
        const method = String(b.method || 'get').toLowerCase();
        if (!METHODS.includes(method))
            throw inputError(`body.method must be one of ${METHODS.join(', ')}`);
        const path = b.path ? `/${String(b.path).replace(/^\/+/, '')}` : '';
        // %2e%2e is resolved like .. by the URL parser.
        const dots = (seg) => /^(\.|%2e){1,2}$/i.test(seg);
        if (path.split('/').some(dots))
            throw inputError('body.path must not contain "." or ".." segments');
        try {
            const res = await api.request({
                method,
                url: `${pluginApi(ctx.user, String(ctx.id))}${path}`,
                data: method === 'get' || method === 'delete' ? undefined : (b.body ?? {}),
                params: ctx.query,
                paramsSerializer: { indexes: null },
                transformResponse: [(x) => x],
                responseType: 'text',
                timeout: TIMEOUTS.API_LONG_MS,
            });
            const raw = String(res.data ?? '');
            let text = raw;
            let data = raw;
            try {
                data = JSON.parse(raw);
                text = JSON.stringify(data, null, 2);
            } catch {}
            return textResult(text || `${res.status} (no content)`, data === '' ? null : data);
        } catch (e) {
            throw apiError(e, { notFound: `Not found: plugin ${ctx.id}${path}` });
        }
    },
};
