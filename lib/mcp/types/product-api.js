// @ts-check
import api from '../../api.js';
import { TIMEOUTS } from '../../constants.js';
import { apiError } from '../../errors.js';
import { v1 } from '../../paths.js';

/**
 * A product API resource called for the product as a whole: an action of
 * the catalog type product_profile_api.
 *
 * @type {import('../tools-resource.js').LocalAction}
 */
export const apiCall = {
    description:
        "Call a product API resource for the product as a whole, as an external system feeding data in would, with `body` as its payload. The entry needs a `device_id_resolver` (a function of the product code that returns each payload's device); the body may be an array, one payload per device. To call it for one device, use {op:device_resource.call}.",
    op: 'Product_AccessResources',
    examples: [
        {
            tool: 'resource_call',
            arguments: {
                type: 'product_profile_api',
                action: 'call',
                ids: { product: 'boiler_kit', resource: 'uplink' },

                body: [{ dev_eui: 'a1b2c3', temperature: 21.5 }],
            },
            does: 'Feed one payload in; the device_id_resolver of the entry finds its device.',
        },
    ],
    async run(body, ctx) {
        try {
            const res = await api.post(
                `${v1(ctx.user)}/products/${encodeURIComponent(String(ctx.parent))}/resources/${encodeURIComponent(String(ctx.id))}`,
                body ?? {},
                { timeout: TIMEOUTS.API_LONG_MS },
            );
            return res.data ?? null;
        } catch (e) {
            throw apiError(e, {
                notFound: `Not found: product ${ctx.parent} or its resource ${ctx.id}`,
            });
        }
    },
};
