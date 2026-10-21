// @ts-check
import api from '../api.js';
import { TIMEOUTS } from '../constants.js';
import { apiError, inputError } from '../errors.js';
import { pluginApi } from '../paths.js';
import { textResult } from './helpers.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Call the API a plugin serves (its routes are its own: no catalog). */
async function toolPluginCall(args) {
    if (!args.plugin) throw inputError('plugin is required');
    const method = (args.method || 'get').toLowerCase();
    if (!METHODS.includes(method)) throw inputError(`method must be one of ${METHODS.join(', ')}`);
    const path = args.path ? `/${String(args.path).replace(/^\/+/, '')}` : '';
    // %2e%2e is resolved like .. by the URL parser.
    const dots = (seg) => /^(\.|%2e){1,2}$/i.test(seg);
    if (path.split('/').some(dots)) throw inputError('path must not contain "." or ".." segments');
    try {
        const res = await api.request({
            method,
            url: `${pluginApi(args.user, args.plugin)}${path}`,
            data: method === 'get' || method === 'delete' ? undefined : (args.body ?? {}),
            params: args.query,
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
        throw apiError(e, { notFound: `Not found: plugin ${args.plugin}${path}` });
    }
}

export const tools = [
    {
        name: 'plugin_call',
        description:
            'Call the API an installed plugin serves, at its own `path` (what it offers depends on the plugin; see its documentation or try GET on its root). Find plugins with {tool:resource_list} type "plugin".',
        inputSchema: {
            type: 'object',
            properties: {
                plugin: { type: 'string', description: 'Plugin id.' },
                path: {
                    type: 'string',
                    description: 'Path inside the plugin, e.g. "/api/status".',
                },
                method: { type: 'string', enum: METHODS, description: 'Default get.' },
                body: { description: 'JSON body for post / put / patch.' },
                query: { type: 'object', description: 'Query parameters.' },
                user: { type: 'string', description: 'Account to act on (admin only).' },
            },
            required: ['plugin'],
        },
        handler: toolPluginCall,
    },
];
