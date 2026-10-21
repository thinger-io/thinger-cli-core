// @ts-check
import api from './api.js';
import { apiError, inputError } from './errors.js';
import { v1 } from './paths.js';

/** Fields of an export the server sets itself. */
const SERVER_FIELDS = ['created', 'modified', 'user', '_id'];

/** What a product update (PUT) takes; the rest is written apart. */
const UPDATE_FIELDS = ['name', 'description', 'enabled', 'config'];

/** Profile categories written whole with PUT …/profile/{category}. */
const PROFILE_CATEGORIES = ['properties', 'buckets', 'flows', 'endpoints', 'api', 'autoprovisions'];

const exists = async (url) => {
    try {
        await api.get(url);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
};

/**
 * Make a product match a document as `product export` writes it (the
 * product, its profile and, under `_resources.properties`, its properties):
 * created when missing, updated when it exists. Each profile category the
 * document has replaces the product's (entries it leaves out are removed);
 * product properties and services it leaves out are kept.
 *
 * @param {Record<string, any>} doc
 * @param {string | null} [user]
 * @returns {Promise<{ product: string, created: boolean, properties: { created: string[], updated: string[] }, ignored?: string[] }>}
 */
export async function applyProduct(doc, user) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw inputError('the product document must be a JSON object');
    }
    const id = doc.product;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw inputError('the document needs its "product" id (letters, digits, _ and -)');
    }
    const { _resources, ...rest } = doc;
    const product = Object.fromEntries(
        Object.entries(rest).filter(([k]) => !SERVER_FIELDS.includes(k)),
    );
    const properties = _resources?.properties ?? [];
    if (!Array.isArray(properties)) throw inputError('_resources.properties must be an array');
    for (const p of properties) {
        if (!p || typeof p.property !== 'string' || !p.property) {
            throw inputError('every entry of _resources.properties needs its "property" id');
        }
    }

    const base = `${v1(user)}/products`;
    const item = `${base}/${encodeURIComponent(id)}`;
    const found = await exists(item);
    /** One request, its 404 named after what it wrote. */
    const write = async (method, url, body, what) => {
        try {
            await api.request({ method, url, data: body });
        } catch (e) {
            throw apiError(e, { notFound: `Not found: ${what} (${method.toUpperCase()} ${url})` });
        }
    };
    /** Profile categories this server takes no PUT for: left as they are. */
    const ignored = [];
    if (!found) {
        await write('post', base, product, `products of the account`);
    } else {
        // An update takes the record's own fields; the profile goes
        // category by category (each PUT replaces the whole category),
        // and the services one by one.
        const fields = Object.fromEntries(
            UPDATE_FIELDS.filter((k) => k in product).map((k) => [k, product[k]]),
        );
        if (Object.keys(fields).length) await write('put', item, fields, `product ${id}`);
        for (const [category, value] of Object.entries(product.profile || {})) {
            if (!PROFILE_CATEGORIES.includes(category) && category !== 'code') {
                ignored.push(`profile.${category}`);
                continue;
            }
            await write('put', `${item}/profile/${category}`, value ?? {}, `profile ${category}`);
        }
        for (const [service, value] of Object.entries(product.services || {})) {
            await write(
                'put',
                `${item}/services/${encodeURIComponent(service)}`,
                value,
                `service ${service}`,
            );
        }
    }

    const done = { created: [], updated: [] };
    for (const p of properties) {
        const record = Object.fromEntries(
            Object.entries(p).filter(([k]) => !SERVER_FIELDS.includes(k)),
        );
        const url = `${item}/properties/${encodeURIComponent(p.property)}`;
        try {
            if (found && (await exists(url))) {
                const { property: _id, ...fields } = record;
                await api.put(url, fields);
                done.updated.push(p.property);
            } else {
                await api.post(`${item}/properties`, record);
                done.created.push(p.property);
            }
        } catch (e) {
            throw apiError(e, { notFound: `Product property not found: ${p.property}` });
        }
    }
    return {
        product: id,
        created: !found,
        properties: done,
        ...(ignored.length ? { ignored } : {}),
    };
}
