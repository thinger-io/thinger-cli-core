// @ts-check
import './setup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import api from '../lib/api.js';
import { CATALOG, idKey, idKeys, requestFor, resolveIds, templateFor } from '../lib/mcp/catalog.js';
import { CORE_ACTIONS, CORE_TYPES } from '../lib/mcp/core-types.js';
import { buildTools } from '../lib/mcp/registry.js';
import { CLI, DATA, checkShape } from '../lib/mcp/tools-resource.js';
import { bundledSpec, findOperation } from '../lib/openapi.js';

const doc = bundledSpec();
const jwt = `x.${Buffer.from(JSON.stringify({ usr: 'acme' })).toString('base64url')}.y`;

before(() => {
    process.env.ACME_TOKEN = jwt;
    process.env.ACME_SERVER = 'http://stub';
});
after(() => {
    delete process.env.ACME_TOKEN;
    delete process.env.ACME_SERVER;
});

/**
 * Serve requests with `route(method, url, data, config)`: it returns the
 * answer's data, or a number for an error status.
 */
async function withServer(route, fn) {
    const calls = [];
    const saved = api.defaults.adapter;
    api.defaults.adapter = async (config) => {
        const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        calls.push({ method: config.method, url: config.url, data, params: config.params });
        const answer = await route(config.method, config.url, data, config);
        if (typeof answer === 'number') {
            const response = { status: answer, data: {}, headers: {}, config };
            throw Object.assign(new Error(String(answer)), {
                response,
                config,
                isAxiosError: true,
            });
        }
        return { data: answer, status: 200, headers: {}, config };
    };
    try {
        await fn();
    } finally {
        api.defaults.adapter = saved;
    }
    return calls;
}

const tools = buildTools();
const byName = Object.fromEntries(tools.map((t) => [t.name.replace(/^acme_/, ''), t]));
const call = (tool, args, extra) => byName[tool].handler(args, extra);
const textOf = (result) => result.content.map((c) => c.text).join('\n');

/** Sample ids for a type's parents. */
const parentsOf = (type) =>
    Object.fromEntries(
        idKeys(type)
            .slice(0, idKey(type) ? -1 : undefined)
            .map((k) => [k, `p_${k}`]),
    );

describe('ids round-trip', () => {
    // Every record a list answers carries the ids to pass back: from the
    // documented answer of each list, those ids locate that record.
    it('every listed record of the documented answers carries complete ids', async () => {
        const missing = [];
        for (const [type, spec] of Object.entries(CATALOG)) {
            if (!('list' in spec.ops) || spec.id === undefined) continue;
            const { method, path } = templateFor(type, 'list');
            const ok = findOperation(doc, method, path)?.operation?.responses?.['200']?.content?.[
                'application/json'
            ];
            const example = ok?.example ?? Object.values(ok?.examples || {})[0]?.value;
            if (example === undefined) {
                if (!spec.recordId) missing.push(`${type}: no example and no recordId`);
                continue;
            }
            let text;
            await withServer(
                () => example,
                async () => {
                    text = textOf(
                        await call('resource_list', { type, ids: parentsOf(type), user: 'acme' }),
                    );
                },
            );
            const match = text.match(/"ids":(\{[^{}]*\})/);
            if (!match) {
                missing.push(`${type}: no ids in ${text.slice(0, 120)}`);
                continue;
            }
            const ids = JSON.parse(match[1]);
            for (const verb of ['get', 'update', 'delete']) {
                if (!(verb in spec.ops)) continue;
                const { url } = requestFor(type, /** @type {any} */ (verb), { ids, user: 'acme' });
                assert.ok(
                    url.endsWith(
                        `/${encodeURIComponent(ids[/** @type {string} */ (idKey(type))])}`,
                    ) || verb !== 'get',
                    `${type} ${verb}: ${url}`,
                );
            }
        }
        assert.deepEqual(missing, []);
    });

    it('reads a record with its ids first, and the CLI without them', async () => {
        await withServer(
            () => ({ property: 'setpoint', value: 21 }),
            async () => {
                const ids = { device: 'boiler', property: 'setpoint' };
                const read = await call('resource_get', {
                    type: 'device_property',
                    ids,
                    user: 'acme',
                });
                assert.deepEqual(Object.keys(JSON.parse(textOf(read))), [
                    'ids',
                    'property',
                    'value',
                ]);
                assert.deepEqual(read[DATA], { property: 'setpoint', value: 21 });
                const cli = await call('resource_get', {
                    type: 'device_property',
                    ids,
                    user: 'acme',
                    [CLI]: true,
                });
                assert.equal(JSON.parse(textOf(cli)).ids, undefined);
            },
        );
    });

    it('creates and clones with the new ids, generated ones from the answer', async () => {
        const calls = await withServer(
            (method, url) =>
                url.endsWith('/tokens') ? { token: 'tk_1', access_token: 'jwt' } : {},
            async () => {
                const made = await call('resource_create', {
                    type: 'device_property',
                    ids: { device: 'boiler', property: 'setpoint' },
                    body: { value: 21 },
                    user: 'acme',
                });
                assert.match(
                    textOf(made),
                    /^Created device_property boiler\/setpoint\.\nids: \{"device":"boiler","property":"setpoint"\}/,
                );
                assert.deepEqual(made[DATA], { id: 'setpoint', result: {} });
                const token = await call('resource_create', {
                    type: 'device_token',
                    ids: { device: 'boiler' },
                    body: { name: 'x' },
                    user: 'acme',
                });
                assert.match(textOf(token), /ids: \{"device":"boiler","token":"tk_1"\}/);
                await assert.rejects(
                    call('resource_create', {
                        type: 'device_token',
                        ids: { device: 'boiler', token: 'mine' },
                        body: {},
                        user: 'acme',
                    }),
                    /device_token ids are generated by the server: leave token out of ids/,
                );
                const copy = await call('resource_clone', {
                    type: 'alarm_rule',
                    ids: { rule: 'high' },
                    body: { rule: 'high_2' },
                    user: 'acme',
                });
                assert.match(
                    textOf(copy),
                    /Cloned alarm_rule high as alarm_rule high_2\.\nids: \{"rule":"high_2"\}/,
                );
                assert.deepEqual(copy[DATA], { id: 'high', copy: 'high_2' });
                await assert.rejects(
                    call('resource_clone', { type: 'alarm_rule', ids: { rule: 'high' }, body: {} }),
                    /clone needs the new id in body.rule/,
                );
            },
        );
        // The own id goes into the body's id field.
        assert.deepEqual(calls[0].data, { property: 'setpoint', value: 21 });
        assert.equal(calls[0].url, '/v3/users/acme/devices/boiler/properties');
    });

    it('drops the ids a read record carries from a body, when they point at it', async () => {
        const calls = await withServer(
            () => ({}),
            async () => {
                const ids = { device: 'boiler', property: 'setpoint' };
                await call('resource_update', {
                    type: 'device_property',
                    ids,
                    body: { ids, value: 22 },
                    user: 'acme',
                });
                await assert.rejects(
                    call('resource_update', {
                        type: 'device_property',
                        ids,
                        body: { ids: { device: 'other', property: 'setpoint' }, value: 1 },
                    }),
                    /body.ids points at other\/setpoint but ids at boiler\/setpoint/,
                );
            },
        );
        assert.deepEqual(calls[0].data, { value: 22 });
    });

    it('names the ids by the names the server uses', async () => {
        assert.deepEqual(idKeys('asset_type_property'), ['type', 'property']);
        assert.deepEqual(idKeys('product_profile_api'), ['product', 'resource']);
        assert.deepEqual(idKeys('alarm_instance'), ['instance']);
        assert.throws(
            () => resolveIds('asset_type', { asset_type: 'boiler' }),
            /asset_type takes ids type; unknown: asset_type/,
        );
        const described = textOf(await call('resource_describe', { type: 'asset_type' }));
        assert.match(
            described,
            /^ids: \{"type": <its own id>\}; ids.type is the id, not the `type` argument$/m,
        );
    });
});

describe('errors that say what to do', () => {
    it('name every type, the verbs a type has and the types with a verb', async () => {
        await assert.rejects(call('resource_list', { type: 'devices' }), (e) => {
            assert.match(e.message, /^Unknown type "devices"\. Types: device, product/);
            assert.match(e.message, /bucket_data, storage_file, device_resource, doc, profile/);
            return true;
        });
        await assert.rejects(
            call('resource_delete', { type: 'device_bucket', ids: { device: 'd', bucket: 'b' } }),
            /Type "device_bucket" does not support delete \(it supports: list\)\. Types with delete: device, /,
        );
        await assert.rejects(
            call('resource_call', { type: 'bucket_export', action: 'x' }),
            /has no actions\. Types with actions: /,
        );
    });

    it('check filters and bodies of the core types against their schemas', async () => {
        await assert.rejects(
            call('resource_list', {
                type: 'bucket_data',
                ids: { bucket: 'temps' },
                filter: { aggregation: '1h' },
            }),
            /filter of bucket_data has no "aggregation"; it takes: device, items, minutes, min_ts, max_ts, sort, agg, agg_type, tz, fields, group_by/,
        );
        await assert.rejects(
            call('resource_list', {
                type: 'bucket_data',
                ids: { bucket: 'temps' },
                filter: { agg_type: 'avg' },
            }),
            /filter of bucket_data: agg_type must be one of "mean"/,
        );
        await assert.rejects(
            call('resource_list', { type: 'bucket_data', ids: { bucket: 't' }, search: 'x' }),
            /bucket_data takes no search: narrow it with filter/,
        );
        await assert.rejects(
            call('resource_create', {
                type: 'storage_file',
                ids: { storage: 'web', file: 'a.txt' },
                body: { text: 'x' },
            }),
            /body of storage_file has no "text"; it takes: content, local/,
        );
        await assert.rejects(
            call('resource_call', { type: 'dashboard', action: 'init', body: { folder: 'x' } }),
            /body of dashboard.init needs dir/,
        );
        await assert.rejects(
            call('resource_call', { type: 'dashboard', action: 'init' }),
            /body of dashboard.init needs dir/,
        );
        await assert.rejects(
            call('resource_call', { type: 'device', action: 'send', ids: { device: 'd' } }),
            /device.send needs a body/,
        );
        await assert.rejects(
            call('resource_call', { type: 'device', action: 'overview', ids: { device: 'd' } }),
            /overview acts on every device: leave device out of ids/,
        );
        await assert.rejects(
            call('resource_list', { type: 'profile', profile: 'x' }),
            /profile takes no profile/,
        );
    });

    it('add where to look when the server refuses a body', async () => {
        await withServer(
            () => 400,
            () =>
                assert.rejects(
                    call('resource_create', {
                        type: 'device',
                        body: { device: 'd' },
                        user: 'acme',
                    }),
                    /400.*acme_resource_describe type "device" shows the fields and an example/,
                ),
        );
    });

    it('point a misplaced key to where it goes', () => {
        const list = byName.resource_list.explain;
        assert.equal(
            list({ type: 'bucket_data' }, ['device']),
            '`device` goes in filter for type bucket_data: filter: {"device": undefined}',
        );
        assert.equal(
            list({ type: 'device_property', device: 'boiler' }, ['device']),
            '`device` goes in ids: ids: {"device": "boiler"}',
        );
        assert.equal(list({ type: 'bucket_data', nope: 1 }, ['nope']), undefined);
        const create = byName.resource_create.explain;
        assert.match(
            create({ type: 'storage_file', content: 'x' }, ['content']),
            /`content` goes in body: body: \{"content": "x"\}/,
        );
        assert.equal(
            byName.resource_get.explain({ type: 'device', parent: 'x' }, ['parent']),
            undefined,
        );
    });

    it('accept every example they show', async () => {
        const examples = [];
        for (const spec of Object.values({ ...CATALOG, ...CORE_TYPES })) {
            for (const e of spec.examples || []) examples.push(e);
            for (const a of Object.values(spec.actions || {})) examples.push(...(a.examples || []));
        }
        for (const list of Object.values(CORE_ACTIONS)) {
            for (const a of Object.values(list)) examples.push(...(a.examples || []));
        }
        const overview = textOf(await call('resource_describe', {}));
        assert.match(overview, /^Examples, one call per line:$/m);
        for (const line of overview.split('\n').filter((l) => l.startsWith('{"tool":'))) {
            const e = JSON.parse(line);
            examples.push({ ...e, tool: e.tool.replace(/^acme_/, '') });
        }
        assert.ok(examples.length >= 15, `${examples.length} examples`);
        for (const e of examples) {
            const tool = byName[e.tool];
            assert.ok(tool, e.tool);
            const props = tool.inputSchema.properties;
            for (const key of Object.keys(e.arguments))
                assert.ok(key in props, `${e.tool}: ${key}`);
            assert.ok(props.type.enum.includes(e.arguments.type), `${e.tool} ${e.arguments.type}`);
            if (e.tool === 'resource_call') {
                assert.ok(props.action.enum.includes(e.arguments.action), e.arguments.action);
            }
            const type = e.arguments.type;
            const local = CORE_TYPES[type];
            const verb = e.tool.replace('resource_', '');
            const action =
                verb === 'call'
                    ? (CATALOG[type]?.actions?.[e.arguments.action] ??
                      CORE_ACTIONS[type]?.[e.arguments.action] ??
                      local?.actions?.[e.arguments.action])
                    : undefined;
            const on = action?.on ?? 'item';
            const own =
                verb === 'list' || on === 'collection'
                    ? 'forbidden'
                    : verb === 'create' || on === 'either'
                      ? 'optional'
                      : 'required';
            resolveIds(type, e.arguments.ids, { own: /** @type {any} */ (own), local: CORE_TYPES });
            const where = `${type} ${verb}`;
            if (local?.filter && e.arguments.filter)
                checkShape(e.arguments.filter, local.filter, where);
            if (local?.schema && e.arguments.body)
                checkShape(e.arguments.body, local.schema, where);
            if (action?.body && typeof action.run === 'function') {
                // body.confirm answers the action's question: it is not its input.
                const { confirm: _confirm, ...body } = e.arguments.body ?? {};
                checkShape(action.confirm ? body : e.arguments.body, action.body, where);
            }
        }
    });
});

describe('actions that ask first', () => {
    const replace = (body, extra) =>
        call(
            'resource_call',
            {
                type: 'product_profile_bucket',
                action: 'replace_all',
                ids: { product: 'meter' },
                body,
                user: 'acme',
            },
            extra,
        );
    const route = (method) => (method === 'get' ? { old: {}, kept: {} } : {});

    it('answer what they would do, and do it only with confirm', async () => {
        let plan;
        const calls = await withServer(route, async () => {
            plan = await replace({ kept: {}, added: {} });
        });
        assert.equal(plan.isError, false);
        assert.match(
            textOf(plan),
            /^It would replace the 2 product_profile_bucket entries with 2: removes old; adds added; overwrites kept\.\nNothing was done\. Run again with confirm: true in the body to do it; confirm it with the user first\.$/,
        );
        assert.deepEqual(
            calls.map((c) => c.method),
            ['get'],
        );
        const done = await withServer(route, () => replace({ kept: {}, confirm: true }));
        assert.deepEqual(
            done.map((c) => [c.method, c.data]),
            [['put', { kept: {} }]],
        );
    });

    it('ask the user through the client when it can', async () => {
        const asked = [];
        const yes = { elicit: async (m) => (asked.push(m), true) };
        const done = await withServer(route, () => replace({ kept: {} }, yes));
        assert.match(asked[0], /^It would replace the 2 product_profile_bucket entries/);
        assert.equal(done.at(-1)?.method, 'put');
        const no = { elicit: async () => false };
        let answer;
        const calls = await withServer(route, async () => {
            answer = await replace({ kept: {} }, no);
        });
        assert.match(textOf(answer), /The user did not confirm it: nothing was done\.$/);
        assert.ok(calls.every((c) => c.method === 'get'));
    });

    it('run as they are when no confirmation is needed', async () => {
        const calls = await withServer(
            () => ({}),
            () =>
                call('resource_call', {
                    type: 'plugin',
                    action: 'start',
                    ids: { plugin: 'nr' },
                    user: 'acme',
                }),
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'post');
    });
});

describe('read-only mode', () => {
    const ro = Object.fromEntries(
        buildTools({ readOnly: true }).map((t) => [t.name.replace(/^acme_/, ''), t]),
    );

    it('refuses the actions that change things', async () => {
        await assert.rejects(
            ro.resource_call.handler({
                type: 'device',
                action: 'send',
                ids: { device: 'd' },
                body: {},
            }),
            /has no action "send" served read-only \(it has: stats, overview\)/,
        );
        await assert.rejects(
            ro.resource_call.handler({ type: 'device_resource', action: 'call' }),
            /Type "device_resource" has no actions served read-only/,
        );
        const described = textOf(await ro.resource_describe.handler({ type: 'bucket_data' }));
        assert.doesNotMatch(described, /resource_create/);
    });

    // A read must never write: list and get of the core types send GETs only.
    it('reads the core types with GETs only', async () => {
        const calls = await withServer(
            (method, url) => {
                if (method !== 'get') throw new Error(`${method} ${url} in a read`);
                if (url.includes('/resources')) return {};
                return [];
            },
            async () => {
                const reads = [
                    ['resource_list', { type: 'bucket_data', ids: { bucket: 'b' } }],
                    ['resource_list', { type: 'storage_file', ids: { storage: 's' } }],
                    ['resource_list', { type: 'device_resource', ids: { device: 'd' } }],
                    ['resource_list', { type: 'profile' }],
                    [
                        'resource_call',
                        { type: 'device', action: 'overview', body: { locations: true } },
                    ],
                ];
                for (const [tool, args] of reads)
                    await ro[tool].handler({ ...args, user: 'acme' }).catch((e) => {
                        if (/in a read/.test(e.message)) throw e;
                    });
            },
        );
        assert.ok(calls.length >= 4);
    });
});

describe('core types', () => {
    it('read a bucket with count as filter.items', async () => {
        const calls = await withServer(
            () => [{ ts: 1, t: 20 }],
            () =>
                call('resource_list', {
                    type: 'bucket_data',
                    ids: { bucket: 'temps' },
                    filter: { agg: '1h', agg_type: 'mean', tz: 'Europe/Madrid' },
                    count: 24,
                    user: 'acme',
                }),
        );
        assert.match(calls[0].url, /\/buckets\/temps\/data$/);
        assert.equal(calls[0].params.items, 24);
        assert.equal(calls[0].params.agg_type, 'mean');
    });

    it('upload a local folder to a storage, keeping the paths', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-site-'));
        fs.mkdirSync(path.join(dir, 'css'));
        fs.writeFileSync(path.join(dir, 'index.html'), '<p>');
        fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'p{}');
        let result;
        await withServer(
            () => ({}),
            async () => {
                result = await call('resource_create', {
                    type: 'storage_file',
                    ids: { storage: 'web' },
                    body: { local: dir },
                    user: 'acme',
                });
            },
        );
        assert.match(textOf(result), /^Wrote to storage_file web\./);
        assert.deepEqual(result[DATA].result.files.sort(), ['css/a.css', 'index.html']);
    });

    it('list the files of a folder by their whole path, as their ids', async () => {
        let text;
        await withServer(
            () => [{ name: 'a.txt', path: 'a.txt', size: 5, type: 'file' }],
            async () => {
                text = textOf(
                    await call('resource_list', {
                        type: 'storage_file',
                        ids: { storage: 'web' },
                        filter: { path: 'dir/' },
                    }),
                );
            },
        );
        assert.match(text, /"ids":\{"storage":"web","file":"dir\/a.txt"\}/);
        assert.match(text, /"path":"dir\/a.txt"/);
    });

    it('list device resources with their kind and their ids', async () => {
        let text;
        await withServer(
            (method, url) => (url.endsWith('/resources/api') ? { temp: { fn: 3 } } : { out: 1 }),
            async () => {
                text = textOf(
                    await call('resource_list', {
                        type: 'device_resource',
                        ids: { device: 'd1' },
                        user: 'acme',
                    }),
                );
            },
        );
        assert.match(text, /\{"ids":\{"device":"d1","resource":"temp"\},"name":"temp","fn":3/);
        assert.match(text, /"kind":"output"/);
    });

    it('describe themselves with their ids, filter and examples', async () => {
        const text = textOf(await call('resource_describe', { type: 'bucket_data' }));
        assert.match(text, /^ids: \{"bucket": <bucket id>\}$/m);
        assert.match(text, /^filter: \{"type":"object"/m);
        assert.match(
            text,
            /^examples:\n\{"tool":"acme_resource_list","arguments":\{"type":"bucket_data"/m,
        );
        const storage = textOf(await call('resource_describe', { type: 'storage_file' }));
        assert.match(storage, /^own_id: optional on create$/m);
    });

    it('point an id given in an action body to ids', async () => {
        const tools = buildTools({
            actions: {
                device: {
                    probe: {
                        description: 'Probe a device.',
                        on: 'either',
                        body: { type: 'object', properties: { x: { type: 'number' } } },
                        run: () => 'ok',
                    },
                },
            },
        });
        const run = (args) => tools.find((t) => t.name === 'acme_resource_call').handler(args);
        await assert.rejects(
            run({ type: 'device', action: 'probe', body: { device: 'd1', x: 1 } }),
            /body of device.probe has no "device": pass the device in ids \(\{"device": "d1"\}\)/,
        );
        assert.match(
            textOf(await run({ type: 'device', action: 'probe', ids: { device: 'd1' } })),
            /ok/,
        );
    });

    it('show what the describe hooks of the CLI add', async () => {
        const tools = buildTools({
            hooks: {
                bucket_data: { describe: () => ({ rule: 'cli rule' }) },
                doc: { describe: () => 'only from the CLI' },
            },
        });
        const run = (args) => tools.find((t) => t.name === 'acme_resource_describe').handler(args);
        assert.match(textOf(await run({ type: 'bucket_data' })), /^cli: \{"rule":"cli rule"\}$/m);
        assert.match(textOf(await run({ type: 'doc' })), /^cli: only from the CLI$/m);
    });
});
