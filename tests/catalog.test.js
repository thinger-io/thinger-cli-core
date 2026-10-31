// @ts-check
import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CATALOG,
    VERBS,
    actionRequest,
    actionTemplate,
    ancestry,
    requestFor,
    templateFor,
} from '../lib/mcp/catalog.js';
import { bundledSpec, findOperation, resolveRefs } from '../lib/openapi.js';
import { buildTools } from '../lib/mcp/registry.js';
import { pick } from '../lib/mcp/tools-resource.js';
import api from '../lib/api.js';
import { mergeHooks } from '../lib/mcp/resource-hooks.js';

const doc = bundledSpec();
const tools = buildTools();
const ACCOUNT = 'acme';

describe('resource catalog', () => {
    // The catalog is written by hand: this is what keeps it honest. Every
    // verb must reach the operation the table names, on the bundled copy of
    // the server's OpenAPI document (refresh it with the server's
    // /v1/server/swagger.json when the API changes).
    it('every operation exists in the OpenAPI document, at the path and method the verb maps to', () => {
        const wrong = [];
        for (const [name, type] of Object.entries(CATALOG)) {
            for (const [verb, operationId] of Object.entries(type.ops)) {
                const { method, path } = templateFor(name, /** @type {any} */ (verb));
                const found = findOperation(doc, method, path);
                if (found?.operation.operationId !== operationId) {
                    wrong.push(
                        `${name}.${verb}: ${method.toUpperCase()} ${path} is ${found?.operation.operationId ?? 'missing'}, expected ${operationId}`,
                    );
                }
            }
        }
        assert.deepEqual(wrong, []);
    });

    it('every action exists in the OpenAPI document, at its path and method', () => {
        const wrong = [];
        for (const [name, type] of Object.entries(CATALOG)) {
            for (const [action, spec] of Object.entries(type.actions || {})) {
                const { method, path } = actionTemplate(name, action);
                const found = findOperation(doc, method, path);
                if (found?.operation.operationId !== spec.op) {
                    wrong.push(
                        `${name}.${action}: ${method.toUpperCase()} ${path} is ${found?.operation.operationId ?? 'missing'}, expected ${spec.op}`,
                    );
                }
            }
        }
        assert.deepEqual(wrong, []);
    });

    it('builds server-wide paths without an account, and per-action versions', () => {
        assert.deepEqual(requestFor('domain', 'list', { user: ACCOUNT }), {
            method: 'get',
            url: '/v1/domains',
        });
        assert.deepEqual(actionRequest('domain', 'verify', { ids: { domain: 'iot.acme.com' } }), {
            method: 'post',
            url: '/v1/domains/iot.acme.com/verify',
            query: undefined,
        });
        assert.deepEqual(
            actionRequest('plugin', 'install', {
                ids: { plugin: 'node-red' },
                user: ACCOUNT,
            }),
            {
                method: 'post',
                url: '/v1/users/acme/plugins/node-red',
                query: { action: 'create' },
            },
        );
        assert.equal(
            actionRequest('device', 'stats', { ids: { device: 'd1' }, user: ACCOUNT }).url,
            '/v3/users/acme/devices/d1/stats',
        );
        assert.equal(
            actionRequest('brand', 'test_email', { ids: { brand: 'acme' } }).url,
            '/v1/brands/acme/email/test',
        );
        assert.throws(
            () => actionRequest('domain', 'restart', { ids: { domain: 'x' } }),
            /has no action "restart" \(it has: verify\)/,
        );
    });

    it('only uses known verbs, and every parent is a type with an id', () => {
        for (const [name, type] of Object.entries(CATALOG)) {
            for (const verb of Object.keys(type.ops)) assert.ok(verb in VERBS, `${name}.${verb}`);
            if (type.parent) {
                assert.ok(CATALOG[type.parent], `${name}: unknown parent ${type.parent}`);
                assert.ok(CATALOG[type.parent].id, `${name}: parent without id`);
            }
            assert.ok(type.description.length < 140, `${name}: description too long`);
        }
    });

    it('builds account paths through lib/paths.js, with the parent chain', () => {
        assert.deepEqual(requestFor('device', 'list', { user: ACCOUNT }), {
            method: 'get',
            url: '/v1/users/acme/devices',
        });
        assert.deepEqual(
            requestFor('device_property', 'patch', {
                ids: { device: 'd1', property: 'cfg' },
                user: ACCOUNT,
            }),
            {
                method: 'patch',
                url: '/v3/users/acme/devices/d1/properties/cfg',
            },
        );
        assert.deepEqual(ancestry('device_bucket_tag'), ['device', 'device_bucket']);
        assert.equal(
            requestFor('device_bucket_tag', 'get', {
                ids: { device: 'd1', bucket: 'temps', tag: 'site' },
                user: ACCOUNT,
            }).url,
            '/v3/users/acme/devices/d1/buckets/temps/tags/site',
        );
        assert.equal(
            requestFor('device', 'clone', { ids: { device: 'd1' }, user: ACCOUNT }).url,
            '/v1/users/acme/devices/d1/clone',
        );
        assert.equal(
            requestFor('device_callback', 'get', { ids: { device: 'd1' }, user: ACCOUNT }).url,
            '/v3/users/acme/devices/d1/callback',
        );
    });

    it('creates upsert types with PUT on the item', () => {
        assert.deepEqual(
            requestFor('product_profile_api', 'create', {
                ids: { product: 'p1', resource: 'ingest' },
                user: ACCOUNT,
            }),
            { method: 'put', url: '/v1/users/acme/products/p1/profile/api/ingest' },
        );
    });

    it('rejects missing or malformed ids and unsupported verbs', () => {
        assert.throws(
            () => requestFor('device', 'get', { user: ACCOUNT }),
            /missing device: the device's id/,
        );
        assert.throws(
            () => requestFor('device_bucket_tag', 'list', { ids: { device: 'd1' }, user: ACCOUNT }),
            /missing bucket: the device_bucket's id/,
        );
        assert.throws(
            () =>
                requestFor('device_bucket_tag', 'list', {
                    ids: { device: 'd1', bucket: 'b', tag: 't' },
                }),
            /list takes no tag: leave it out of ids/,
        );
        assert.throws(
            () => requestFor('device_property', 'get', { ids: { device: 'd1', bucket: 'x' } }),
            /device_property takes ids device and property; unknown: bucket/,
        );
        assert.throws(
            () => requestFor('device', 'get', { ids: { device: '..' } }),
            /ids.device: invalid id "\.\."/,
        );
        assert.throws(
            () => requestFor('device', 'get', { ids: { device: '' } }),
            /ids.device: invalid id ""/,
        );
        assert.throws(
            () => requestFor('product_profile_api', 'create', { ids: { product: 'p1' } }),
            /missing resource: the entry's name \(it is stored under it\)/,
        );
        assert.throws(
            () => actionRequest('device', 'overview', { ids: { device: 'd1' } }),
            /has no action "overview"/,
        );
        assert.throws(
            () => requestFor('device_bucket', 'delete', { ids: { device: 'd1' }, user: ACCOUNT }),
            /does not support/,
        );
    });

    it('escapes ids into the URL', () => {
        assert.equal(
            requestFor('device', 'get', { ids: { device: 'a b' }, user: ACCOUNT }).url,
            '/v1/users/acme/devices/a%20b',
        );
        // One id is one segment: a "/" in it does not reach another path.
        assert.equal(
            requestFor('device_property', 'get', {
                ids: { device: 'd/1', property: 7 },
                user: ACCOUNT,
            }).url,
            '/v3/users/acme/devices/d%2F1/properties/7',
        );
    });
});

describe('resource tools', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // Permissions by verb: each tool offers exactly the types that support
    // its verb, so the model cannot even name a delete the catalog forbids.
    it('offer, per verb, exactly the types that support it', () => {
        const core = { list: ['bucket_data', 'storage_file', 'device_resource', 'doc', 'profile'] };
        Object.assign(core, {
            get: ['storage_file', 'doc'],
            create: ['bucket_data', 'storage_file'],
            delete: ['storage_file'],
            clone: [],
        });
        for (const verb of ['list', 'get', 'create', 'delete', 'clone']) {
            const tool = byName[`acme_resource_${verb}`];
            const expected = Object.keys(CATALOG).filter((n) => verb in CATALOG[n].ops);
            assert.deepEqual(
                tool.inputSchema.properties.type.enum,
                [...expected, ...core[verb]],
                verb,
            );
        }
        assert.ok(
            !byName.acme_resource_delete.inputSchema.properties.type.enum.includes('device_bucket'),
        );
    });

    it('describe types without a server, from the catalog', async () => {
        const result = await byName.acme_resource_describe.handler({});
        assert.match(result.content[0].text, /^device_property \(ids device, property\): /m);
        assert.match(result.content[0].text, /^device_callback \(ids device; single record\): /m);
    });
});

describe('list projection', () => {
    it('keeps only the listed dot paths', () => {
        const record = {
            name: 'a',
            version: '1',
            metadata: { name: 'A', image: 'x' },
            resources: [1],
        };
        assert.deepEqual(pick(record, ['name', 'metadata.name', 'missing']), {
            name: 'a',
            metadata: { name: 'A' },
        });
    });
});

describe('openapi helpers', () => {
    it('resolve $refs, cutting recursion', () => {
        const op = findOperation(doc, 'put', '/v3/users/{}/devices/{}/properties/{}');
        const schema = resolveRefs(
            doc,
            op.operation.requestBody.content['application/json'].schema,
        );
        assert.doesNotMatch(JSON.stringify(schema), /\$ref/);
        const loop = {
            components: { schemas: { a: { items: { $ref: '#/components/schemas/a' } } } },
        };
        assert.deepEqual(resolveRefs(loop, { $ref: '#/components/schemas/a' }), {
            items: { description: '(recursive: #/components/schemas/a)' },
        });
    });

    it('prefer literal path segments over parameters', () => {
        const found = findOperation(doc, 'get', '/v1/users/{}/products/{}/profile/code');
        assert.equal(found.operation.operationId, 'Product_ReadProfileCode');
    });
});

describe('plugin catalog', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const catalog = [
        {
            name: 'ws101',
            version: '1.0.0',
            metadata: { name: 'WS101', description: 'LoRaWAN button', vendor: 'milesight-iot' },
            repository: { type: 'git' },
        },
        { name: 'other', version: '1.0.0', metadata: { description: 'Modbus gateway' } },
    ];

    /** Answer every request with `data`, counting them. */
    function stub(data) {
        const calls = [];
        const saved = { adapter: api.defaults.adapter, baseURL: api.defaults.baseURL };
        api.defaults.baseURL = 'http://stub';
        api.defaults.adapter = async (config) => {
            calls.push(config);
            return { data, status: 200, statusText: 'OK', headers: {}, config };
        };
        return { calls, restore: () => Object.assign(api.defaults, saved) };
    }

    it('lists metadata, searches it and keeps the catalog for a while', async () => {
        const s = stub(catalog);
        try {
            const list = (search) =>
                byName.acme_resource_list.handler({
                    type: 'plugin',
                    user: 'acme',
                    filter: { filter: 'available' },
                    search,
                });
            const text = (await list('lorawan milesight')).content[0].text;
            assert.match(text, /^1 plugin:/);
            assert.match(text, /"vendor":"milesight-iot"/);
            assert.doesNotMatch(text, /repository/);
            assert.match((await list('modbus')).content[0].text, /"name":"other"/);
            assert.equal(s.calls.length, 1);
        } finally {
            s.restore();
        }
    });

    it('leaves the code and dashboard out of catalog manifests unless asked', async () => {
        const manifest = {
            name: 'lht65n',
            resources: {
                products: [
                    {
                        product: 'lht65n',
                        _resources: { properties: [{ dashboard: 1 }] },
                        profile: {
                            buckets: { b: {} },
                            code: { code: 'x'.repeat(100), version: '1.0' },
                        },
                    },
                ],
            },
        };
        const s = stub(manifest);
        try {
            const get = async (full) =>
                JSON.parse(
                    (
                        await byName.acme_resource_get.handler({
                            type: 'plugin',
                            ids: { plugin: 'lht65n' },
                            user: 'acme',
                            full,
                        })
                    ).content[0].text,
                );
            const short = await get(undefined);
            assert.deepEqual(short.ids, { plugin: 'lht65n' });
            delete short.ids;
            const product = short.resources.products[0];
            assert.equal(product._resources, undefined);
            assert.deepEqual(product.profile, { buckets: { b: {} }, code: { version: '1.0' } });
            assert.match(short.omitted, /full: true/);
            const whole = await get(true);
            delete whole.ids;
            assert.deepEqual(whole, manifest);
        } finally {
            s.restore();
        }
    });
});

describe('resource hooks', () => {
    const ctx = () => ({ type: 'device', state: {} });

    it('generate credentials for devices that need them, and show them once', async () => {
        const hooks = mergeHooks();
        const c = ctx();
        const body = await hooks.device.beforeCreate({ device: 'd1' }, c);
        assert.ok(body.credentials?.length >= 6);
        assert.match(await hooks.device.afterCreate({}, c), new RegExp(body.credentials));
        const http = await hooks.device.beforeCreate({ device: 'd2', type: 'HTTP' }, ctx());
        assert.equal(http.credentials, undefined);
    });

    it('turn token durations into unix seconds and check permission trees', async () => {
        const hooks = mergeHooks();
        const body = await hooks.token.beforeCreate(
            { token: 't', name: 't', allow: { Device: { '*': '*' } }, expire: '1d' },
            ctx(),
        );
        assert.ok(body.expire > Date.now() / 1000);
        assert.equal(body.enabled, true);
        assert.throws(() => hooks.token.beforeCreate({ allow: 'all' }, ctx()), /allow/);
    });

    it('chain the hooks a CLI adds after the core ones', async () => {
        const hooks = mergeHooks({
            device: {
                beforeCreate: (body) => ({ ...body, labels: { by: 'cli' } }),
                afterCreate: () => 'cli note',
            },
            product: { afterDelete: () => 'storage removed' },
        });
        const c = ctx();
        const body = await hooks.device.beforeCreate({ device: 'd1' }, c);
        assert.ok(body.credentials);
        assert.deepEqual(body.labels, { by: 'cli' });
        assert.match(await hooks.device.afterCreate({}, c), /credentials[\s\S]*cli note/);
        assert.equal(
            await hooks.product.afterDelete({ type: 'product', state: {} }),
            'storage removed',
        );
    });
});
