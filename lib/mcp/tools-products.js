// @ts-check
import api from '../api.js';
import { TIMEOUTS } from '../constants.js';
import { apiError, inputError } from '../errors.js';
import { v1 } from '../paths.js';
import { textResult } from './helpers.js';

const json = (data) => textResult(JSON.stringify(data ?? null, null, 2), data ?? null);

function productPath(args) {
    if (!args.product) throw inputError('product is required');
    return `${v1(args.user)}/products/${encodeURIComponent(args.product)}`;
}

async function toolResourceCall(args) {
    if (!args.resource) throw inputError('resource is required');
    try {
        const res = await api.post(
            `${productPath(args)}/resources/${encodeURIComponent(args.resource)}`,
            args.data ?? {},
            { timeout: TIMEOUTS.API_LONG_MS },
        );
        return json(res.data);
    } catch (e) {
        throw apiError(e, {
            notFound: `Not found: product ${args.product} or its resource ${args.resource}`,
        });
    }
}

const userParam = { type: 'string', description: 'Account to act on (admin only).' };

export const tools = [
    {
        name: 'product_resource_call',
        description:
            "Call a product API resource for the product as a whole, as an external system feeding data in would. The entry needs a `device_id_resolver` (a function of the product code that returns each payload's device); `data` may be an array, one payload per device. To call it for one device, use {tool:device_resource_call}.",
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product id.' },
                resource: { type: 'string', description: 'Resource name in the product profile.' },
                data: { description: 'JSON payload.' },
                user: userParam,
            },
            required: ['product', 'resource'],
        },
        handler: toolResourceCall,
    },
];
