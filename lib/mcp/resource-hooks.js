// @ts-check
import { CREDENTIAL_DEVICE_TYPES, generateDeviceCredentials } from '../devices.js';
import { identity } from '../identity.js';
import { resolveExpiry, resolveExpiryMs, validatePermissionTree } from '../tokens.js';
import { toolName } from './naming.js';

/**
 * What the generic `resource_*` tools do beyond the plain request, for the
 * few types where the CLI knows better than a bare call: generated device
 * credentials, the identity's product template, token expiries written as
 * "30d". Everything else goes to the server as the caller wrote it.
 *
 * A CLI adds its own hooks (its platform's extra cleanup on delete, say)
 * through `runCli({ resourceHooks })`; they run after these.
 *
 * @typedef {object} HookContext
 * @property {string} type
 * @property {string} [parent]
 * @property {string} [id]
 * @property {string | null} [user]
 * @property {boolean} [full]  resource_get asked for the whole record.
 * @property {Record<string, any>} state  Scratch space shared by the hooks of one call.
 *
 * @typedef {object} ResourceHooks
 * @property {(body: any, ctx: HookContext) => any} [beforeCreate]  Returns the body to send.
 * @property {(body: any, ctx: HookContext) => any} [beforeUpdate]  Returns the body to send.
 * @property {(result: any, ctx: HookContext) => string | void | Promise<string | void>} [afterCreate]
 *   Returns a note added to the tool's answer.
 * @property {(record: any, ctx: HookContext) => any} [afterGet]  Returns the record to show.
 * @property {(ctx: HookContext) => string | void | Promise<string | void>} [afterDelete]
 *   Returns a note added to the tool's answer.
 */

/** Token bodies: expiry as a duration (or unix ms), permission trees checked before sending. */
function tokenBody(body) {
    validatePermissionTree(body.allow, 'allow');
    validatePermissionTree(body.deny, 'deny');
    if (body.expire === undefined) return body;
    const expire = resolveExpiryMs(body.expire);
    const { expire: _expire, ...rest } = body;
    return expire === null ? rest : { ...rest, expire };
}

/** @type {Record<string, ResourceHooks>} */
export const coreHooks = {
    device: {
        // Credentials are stored hashed: generated ones must be shown now
        // or never.
        // The server requires a type; Generic (IOTMP) is the usual one.
        beforeCreate(body, ctx) {
            const type = body.type || 'Generic';
            if (!CREDENTIAL_DEVICE_TYPES.has(type) || body.credentials) return { ...body, type };
            ctx.state.credentials = generateDeviceCredentials();
            return { ...body, type, credentials: ctx.state.credentials };
        },
        afterCreate(_result, ctx) {
            if (!ctx.state.credentials) return;
            return `Generated credentials: ${ctx.state.credentials}\nThe server stores them hashed: this is the only time they can be read. Hand them to whoever flashes the device now.`;
        },
    },
    product: {
        beforeCreate(body) {
            const template = identity().productTemplate || {};
            const config = { ...structuredClone(template.config || {}), ...(body.config || {}) };
            const profile = body.profile || (template.profile && structuredClone(template.profile));
            return {
                ...body,
                name: body.name || body.product,
                description: body.description ?? template.description ?? '',
                enabled: body.enabled ?? true,
                ...(Object.keys(config).length ? { config } : {}),
                ...(profile ? { profile } : {}),
            };
        },
    },
    token: {
        beforeCreate: (body) => tokenBody({ enabled: true, ...body }),
        beforeUpdate: (body) => tokenBody(body),
        afterCreate: () =>
            `Keep the access_token now: lists never show it (${toolName('resource_get')} on the token does).`,
    },
    plugin: {
        // A catalog manifest (no `state`: not installed) carries each
        // product's code and console dashboard, thousands of tokens of
        // little use until asked for.
        afterGet(record, ctx) {
            const products = record?.resources?.products;
            if (ctx.full || record?.state !== undefined || !Array.isArray(products)) return record;
            let left = false;
            const trimmed = products.map((product) => {
                const { _resources, ...rest } = product || {};
                const code = rest.profile?.code;
                if (_resources !== undefined) left = true;
                if (!code || typeof code !== 'object' || code.code === undefined) return rest;
                left = true;
                const { code: _source, ...meta } = code;
                return { ...rest, profile: { ...rest.profile, code: meta } };
            });
            if (!left) return record;
            return {
                ...record,
                resources: { ...record.resources, products: trimmed },
                omitted: `profile.code.code and _resources (console dashboard) of each product: ${toolName('resource_get')} with full: true includes them`,
            };
        },
    },
    device_token: {
        beforeCreate(body) {
            if (body.token_expiration === undefined) return body;
            const expiration = resolveExpiry(body.token_expiration);
            const { token_expiration: _e, ...rest } = body;
            return expiration === null ? rest : { ...rest, token_expiration: expiration };
        },
    },
};

/**
 * Chain the core hooks with a CLI's: for each type and stage the CLI's
 * runs on what the core's produced.
 *
 * @param {Record<string, ResourceHooks>} [extra]
 * @returns {Record<string, ResourceHooks>}
 */
export function mergeHooks(extra = {}) {
    const merged = { ...coreHooks };
    for (const [type, hooks] of Object.entries(extra)) {
        const base = merged[type] || {};
        /** @type {any} */
        const out = { ...base };
        for (const [stage, fn] of Object.entries(hooks)) {
            const first = base[stage];
            if (!first) {
                out[stage] = fn;
            } else if (stage === 'afterCreate' || stage === 'afterDelete') {
                // Both notes are kept.
                out[stage] = async (a, b) =>
                    [await first(a, b), await fn(a, b)].filter(Boolean).join('\n') || undefined;
            } else {
                out[stage] = async (value, ctx) => fn(await first(value, ctx), ctx);
            }
        }
        merged[type] = out;
    }
    return merged;
}
