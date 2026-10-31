// @ts-check
import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../lib/mcp/registry.js';
import { MAX_TEXT } from '../lib/mcp/tools-resource.js';

/** A CLI type over an in-memory folder of notes, hanging off a device. */
function notesType() {
    /** @type {Map<string, Map<string, any>>} */
    const store = new Map();
    const of = (device) => store.get(device) ?? store.set(device, new Map()).get(device);
    const calls = [];
    return {
        store,
        calls,
        type: {
            description: 'Notes kept on a device.',
            parent: 'device',
            id: 'note',
            bodyId: 'name',
            schema: { type: 'object', properties: { name: {}, text: {} } },
            describe: async () => ({ reference: { kinds: ['memo', 'todo'] } }),
            notes: 'Use {tool:resource_call} action "archive" to archive one.',
            list: (ctx) => {
                calls.push(['list', ctx.parent, ctx.filter]);
                return [...of(ctx.parent).values()];
            },
            get: (ctx) => {
                const note = of(ctx.parent).get(ctx.id);
                if (!note)
                    throw Object.assign(new Error(`No note ${ctx.id}`), { code: 'not_found' });
                return note;
            },
            create: (body, ctx) => {
                if (of(ctx.parent).has(ctx.id)) throw new Error(`${ctx.id} already exists`);
                of(ctx.parent).set(ctx.id, body);
            },
            update: (body, ctx) => {
                of(ctx.parent).set(ctx.id, { ...of(ctx.parent).get(ctx.id), ...body });
                return 'saved';
            },
            delete: (ctx) => {
                of(ctx.parent).delete(ctx.id);
            },
            actions: {
                archive: {
                    description: 'Archive a note.',
                    run: (_body, ctx) => ({ archived: ctx.id }),
                },
                fail: {
                    description: 'Always fails.',
                    on: 'either',
                    run: () => ({ content: [{ type: 'text', text: 'it failed' }], isError: true }),
                },
                count: {
                    description: 'How many notes the device has.',
                    on: 'collection',
                    run: (_body, ctx) => `${of(ctx.parent).size} notes`,
                },
            },
        },
    };
}

function build(extra = {}) {
    const notes = notesType();
    const tools = buildTools({
        types: { device_note: notes.type, ...(extra.types || {}) },
        actions: extra.actions,
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const call = (tool, args) => byName[`acme_${tool}`].handler(args);
    return { notes, tools, byName, call };
}

const textOf = (result) => result.content[0].text;

describe('resource types a CLI adds', () => {
    it('serves list, get, create, update and delete through the resource tools', async () => {
        const { call } = build();
        const where = { type: 'device_note', ids: { device: 'pump_1' } };
        const at = (note) => ({ type: 'device_note', ids: { device: 'pump_1', note } });
        const created = textOf(await call('resource_create', { ...at('a'), body: { text: 'hi' } }));
        assert.match(
            created,
            /^Created device_note pump_1\/a\.\nids: \{"device":"pump_1","note":"a"\}/,
        );
        // The id may come in the body field instead.
        await call('resource_create', { ...where, body: { name: 'b', text: 'there' } });
        const list = textOf(await call('resource_list', where));
        assert.match(list, /^2 device_note:/);
        // Each record starts with the ids to pass back.
        assert.match(list, /^\{"ids":\{"device":"pump_1","note":"a"\},"name":"a"/m);
        assert.deepEqual(JSON.parse(textOf(await call('resource_get', at('a')))), {
            ids: { device: 'pump_1', note: 'a' },
            name: 'a',
            text: 'hi',
        });
        assert.match(
            textOf(await call('resource_update', { ...at('a'), body: { text: 'bye' } })),
            /Updated device_note pump_1\/a: text\.\nsaved/,
        );
        await call('resource_delete', at('b'));
        assert.match(textOf(await call('resource_list', where)), /^1 device_note:/);
    });

    it('searches and pages what the CLI lists whole', async () => {
        const { call, notes } = build();
        const device = new Map();
        for (let i = 0; i < 60; i++)
            device.set(`n${i}`, { name: `n${i}`, text: i % 2 ? 'odd' : 'even' });
        notes.store.set('pump_1', device);
        const where = { type: 'device_note', ids: { device: 'pump_1' } };
        const page = textOf(await call('resource_list', where));
        assert.match(page, /60 in total, showing 0–49; pass index: 50/);
        const odd = textOf(
            await call('resource_list', { ...where, search: 'odd', filter: { path: '/x' } }),
        );
        assert.match(odd, /^30 device_note:/);
        // The filter reaches the CLI's function.
        assert.deepEqual(notes.calls.at(-1), ['list', 'pump_1', { path: '/x' }]);
    });

    it('asks for the parent and the id', async () => {
        const { call } = build();
        const where = { type: 'device_note', ids: { device: 'pump_1' } };
        await assert.rejects(
            call('resource_list', { type: 'device_note' }),
            /missing device: the device's id/,
        );
        await assert.rejects(call('resource_get', where), /missing note: the device_note's id/);
        await assert.rejects(
            call('resource_create', { ...where, body: { text: 'x' } }),
            /missing note: give it in ids.note or in the body field "name"/,
        );
        await assert.rejects(
            call('resource_create', {
                type: 'device_note',
                ids: { device: 'pump_1', note: 'a' },
                body: { name: 'b' },
            }),
            /ids.note and body.name differ/,
        );
        await assert.rejects(
            call('resource_list', { type: 'device_note', ids: { device: 'pump_1', note: 'a' } }),
            /list takes no note: leave it out of ids/,
        );
        await assert.rejects(
            call('resource_clone', {
                type: 'device_note',
                ids: { device: 'pump_1', note: 'a' },
                body: {},
            }),
            /does not support clone \(it supports: list, get, create, update, delete\)/,
        );
    });

    it('runs its actions with resource_call, with or without id as declared', async () => {
        const { call } = build();
        const where = { type: 'device_note', ids: { device: 'pump_1' } };
        const a = { type: 'device_note', ids: { device: 'pump_1', note: 'a' } };
        await call('resource_create', { ...a, body: {} });
        assert.deepEqual(
            JSON.parse(textOf(await call('resource_call', { ...a, action: 'archive' }))),
            { archived: 'a' },
        );
        assert.equal(textOf(await call('resource_call', { ...where, action: 'count' })), '1 notes');
        await assert.rejects(
            call('resource_call', { ...where, action: 'archive' }),
            /missing note: the device_note's id/,
        );
        await assert.rejects(
            call('resource_call', { ...a, action: 'count' }),
            /count acts on every device_note: leave note out of ids/,
        );
        await assert.rejects(
            call('resource_call', { ...where, action: 'nope' }),
            /has no action "nope" \(it has: archive, fail, count\)/,
        );
        const failed = await call('resource_call', { ...where, action: 'fail' });
        assert.equal(failed.isError, true);
        assert.equal(textOf(failed), 'it failed');
    });

    it('adds actions to the server types', async () => {
        const { call, byName } = build({
            actions: {
                device: {
                    reboot: {
                        description: 'Reboot the device.',
                        run: (_b, ctx) => `rebooting ${ctx.id}`,
                    },
                    enroll: {
                        description: 'Install command for a new device.',
                        on: 'collection',
                        body: { type: 'object', properties: { product: { type: 'string' } } },
                        run: (body) => `install --product ${body?.product}`,
                    },
                },
            },
        });
        assert.equal(
            textOf(
                await call('resource_call', {
                    type: 'device',
                    action: 'reboot',
                    ids: { device: 'pump_1' },
                }),
            ),
            'rebooting pump_1',
        );
        assert.equal(
            textOf(
                await call('resource_call', {
                    type: 'device',
                    action: 'enroll',
                    body: { product: 'p' },
                }),
            ),
            'install --product p',
        );
        assert.ok(byName.acme_resource_call.inputSchema.properties.type.enum.includes('device'));
        assert.ok(
            byName.acme_resource_call.inputSchema.properties.type.enum.includes('device_note'),
        );
    });

    it('describes them from their definition, and lists them with the server types', async () => {
        const { call, byName } = build({
            actions: { device: { reboot: { description: 'Reboot the device.', run: () => '' } } },
        });
        const described = textOf(await call('resource_describe', { type: 'device_note' }));
        assert.match(described, /^type: device_note/m);
        assert.match(described, /^ids: \{"device": <device id>, "note": <its own id>\}$/m);
        assert.match(described, /^own_id: required: in ids.note, or the body field "name"$/m);
        assert.match(described, /"list":"acme_resource_list"/);
        assert.match(
            described,
            /"count":\{"run":"acme_resource_call type \\"device_note\\" action \\"count\\"".*"ids":"parents only: no note"/,
        );
        assert.match(
            described,
            /^examples:\n\{"tool":"acme_resource_list","arguments":\{"type":"device_note","ids":\{"device":"boiler"\}\}/m,
        );
        assert.match(described, /Use acme_resource_call action "archive"/);
        assert.match(described, /^fields: /m);
        assert.match(described, /^reference: \{"kinds":\["memo","todo"\]\}$/m);
        const summary = textOf(await call('resource_describe', {}));
        assert.match(
            summary,
            /^device_note \(ids device, note\): Notes kept on a device\. \[list get create update delete \| archive fail count\]$/m,
        );
        assert.match(summary, /^device: .*\| .*reboot\]$/m);
        for (const tool of [
            'resource_list',
            'resource_get',
            'resource_create',
            'resource_delete',
        ]) {
            assert.ok(
                byName[`acme_${tool}`].inputSchema.properties.type.enum.includes('device_note'),
                tool,
            );
        }
        // A type that cannot clone is not offered to resource_clone.
        assert.ok(
            !byName.acme_resource_clone.inputSchema.properties.type.enum.includes('device_note'),
        );
    });

    it('cuts long reads', async () => {
        const { call, notes } = build();
        notes.store.set(
            'pump_1',
            new Map([['big', { name: 'big', text: 'x'.repeat(MAX_TEXT + 10) }]]),
        );
        const read = textOf(
            await call('resource_get', {
                type: 'device_note',
                ids: { device: 'pump_1', note: 'big' },
            }),
        );
        assert.ok(read.length < MAX_TEXT + 200);
        assert.match(read, /… \(cut: \d+ characters in total, showing the first 100000\)$/);
    });

    it('refuses what clashes with the server catalog', () => {
        const run = () => {};
        assert.throws(
            () => buildTools({ types: { device: { description: 'x', list: () => [] } } }),
            /"device" is already a server type/,
        );
        assert.throws(
            () =>
                buildTools({
                    types: { thing: { description: 'x', parent: 'nope', list: () => [] } },
                }),
            /unknown parent "nope"/,
        );
        assert.throws(
            () =>
                buildTools({
                    actions: { alarm_instance: { stats: { description: 'x', run } } },
                }),
            /already has an action "stats"/,
        );
        assert.throws(
            () => buildTools({ actions: { nope: { x: { description: 'x', run } } } }),
            /unknown resource type "nope"/,
        );
        assert.throws(
            () => buildTools({ types: { thing: { description: 'x' } } }),
            /has no operations/,
        );
    });
});

describe('resource types a CLI adds: what the review asked for', () => {
    const run = (_b, ctx) => `ran on ${ctx.parent ?? '-'} ${ctx.id ?? '-'}`;

    it('locates actions added to server types like the server ones', async () => {
        const { call } = build({
            actions: {
                device: { reboot: { description: 'Reboot.', run } },
                device_property: { touch: { description: 'Touch.', run } },
                device_bucket: { flush: { description: 'Flush.', on: 'collection', run } },
            },
        });
        await assert.rejects(
            call('resource_call', { type: 'device', action: 'reboot' }),
            /missing device: the device's id/,
        );
        await assert.rejects(
            call('resource_call', {
                type: 'device_property',
                action: 'touch',
                ids: { property: 'p' },
            }),
            /missing device: the device's id/,
        );
        assert.equal(
            textOf(
                await call('resource_call', {
                    type: 'device_property',
                    action: 'touch',
                    ids: { device: 'pump_1', property: 'p' },
                }),
            ),
            'ran on pump_1 p',
        );
        // Ids are values: never empty, `.`, `..` or with control characters.
        for (const device of ['..', '.', '', 'a\nb', true]) {
            await assert.rejects(
                call('resource_call', {
                    type: 'device_property',
                    action: 'touch',
                    ids: { device, property: 'p' },
                }),
                /ids.device: invalid id/,
                String(device),
            );
        }
        await assert.rejects(
            call('resource_call', { type: 'device', action: 'reboot', ids: 'pump_1' }),
            /ids must be an object/,
        );
        assert.equal(
            textOf(
                await call('resource_call', {
                    type: 'device_bucket',
                    action: 'flush',
                    ids: { device: 'pump_1' },
                }),
            ),
            'ran on pump_1 -',
        );
    });

    it('checks the parent of CLI types, nested ones included, and keeps paths as ids', async () => {
        const seen = [];
        const { call } = build({
            types: {
                box: {
                    description: 'Boxes of a device.',
                    parent: 'device',
                    id: 'box',
                    get: (ctx) => ({ box: ctx.id }),
                },
                box_item: {
                    description: 'Items of a box.',
                    parent: 'box',
                    id: 'item',
                    get: (ctx) => (seen.push([ctx.parent, ctx.id, ctx.ids]), { item: ctx.id }),
                },
            },
        });
        const summary = textOf(await call('resource_describe', {}));
        assert.match(summary, /^box_item \(ids device, box, item\): /m);
        const ids = { device: 'pump_1', box: 'b1', item: '/a/b.txt' };
        const got = JSON.parse(textOf(await call('resource_get', { type: 'box_item', ids })));
        assert.deepEqual(got.ids, ids);
        assert.deepEqual(seen, [['pump_1/b1', '/a/b.txt', ids]]);
        await assert.rejects(
            call('resource_get', { type: 'box_item', ids: { device: 'pump_1', item: 'x' } }),
            /missing box: the box's id/,
        );
        await assert.rejects(
            call('resource_get', { type: 'box_item', ids: { ...ids, item: 'a\nb' } }),
            /ids.item: invalid id/,
        );
    });

    it('runs hooks on CLI types after locating them, with the id from the body and one state', async () => {
        const order = [];
        const notes = notesType();
        notes.type.get = (ctx) => {
            ctx.state.read = true;
            return { name: ctx.id };
        };
        const tools = buildTools({
            types: { device_note: notes.type },
            hooks: {
                device_note: {
                    beforeCreate: (body) => (
                        order.push('beforeCreate'),
                        { ...body, name: 'from_hook' }
                    ),
                    afterCreate: (_r, ctx) => `created ${ctx.id}`,
                    afterGet: (record, ctx) => ({ ...record, shared: ctx.state.read === true }),
                },
            },
        });
        const call = (tool, args) => tools.find((t) => t.name === `acme_${tool}`).handler(args);
        // Not located: the hook does not run.
        await assert.rejects(
            call('resource_create', { type: 'device_note', body: {} }),
            /missing device/,
        );
        assert.deepEqual(order, []);
        const created = textOf(
            await call('resource_create', {
                type: 'device_note',
                ids: { device: 'pump_1' },
                body: { text: 'x' },
            }),
        );
        assert.match(created, /Created device_note pump_1\/from_hook\./);
        assert.match(created, /created from_hook/);
        const got = JSON.parse(
            textOf(
                await call('resource_get', {
                    type: 'device_note',
                    ids: { device: 'pump_1', note: 'from_hook' },
                }),
            ),
        );
        assert.equal(got.shared, true);
    });

    it('refuses what CLI types cannot take and survives empty answers', async () => {
        const { call, notes } = build();
        const where = { type: 'device_note', ids: { device: 'pump_1', note: 'a' } };
        await assert.rejects(
            call('resource_update', { ...where, body: { text: 'x' }, merge: true }),
            /takes no merge/,
        );
        await assert.rejects(call('resource_update', { ...where, body: ['x'] }), /JSON object/);
        await assert.rejects(
            call('resource_update', { ...where, body: { ids: { device: 'other' }, text: 'x' } }),
            /body.ids points at other but ids at pump_1\/a/,
        );
        notes.type.get = () => undefined;
        assert.equal(textOf(await call('resource_get', where)), 'No device_note pump_1/a.');
        const device = { type: 'device', ids: { device: 'x' } };
        await assert.rejects(
            call('resource_call', { ...device, action: 'constructor' }),
            /has no action "constructor"/,
        );
        await assert.rejects(
            call('resource_call', { ...device, action: 'nope' }),
            /has no action "nope" \(it has: stats, send, overview\)/,
        );
        await assert.rejects(
            call('resource_call', { type: 'bucket_export', action: 'x' }),
            /Type "bucket_export" has no actions\. Types with actions: .*device/,
        );
    });

    it('pages lists answered whole from any index', async () => {
        const { call, notes } = build();
        notes.store.set('pump_1', new Map(['a', 'b', 'c'].map((n) => [n, { name: n }])));
        const page = textOf(
            await call('resource_list', {
                type: 'device_note',
                ids: { device: 'pump_1' },
                index: 1,
            }),
        );
        assert.match(page, /^2 device_note:/);
        assert.match(page, /3 in total, showing 1–2/);
    });

    it('answers only well-formed tool results as they are, cut', async () => {
        const { call } = build({
            actions: {
                device: {
                    record: {
                        description: 'A record with content.',
                        run: () => ({ content: ['a'] }),
                    },
                    big: {
                        description: 'Big.',
                        run: () => ({
                            content: [{ type: 'text', text: 'x'.repeat(MAX_TEXT + 5) }],
                        }),
                    },
                },
            },
        });
        const d = { type: 'device', ids: { device: 'd' } };
        const record = await call('resource_call', { ...d, action: 'record' });
        assert.deepEqual(JSON.parse(textOf(record)), { content: ['a'] });
        const big = await call('resource_call', { ...d, action: 'big' });
        assert.match(textOf(big), /cut: \d+ characters/);
    });

    it('keeps describe working when a type reference fails', async () => {
        const { call } = build({
            types: {
                flaky: {
                    description: 'Flaky.',
                    list: () => [],
                    describe: () => {
                        throw new Error('no reference today');
                    },
                },
            },
        });
        assert.match(
            textOf(await call('resource_describe', { type: 'flaky' })),
            /^reference: unavailable: no reference today$/m,
        );
    });

    it('rejects bad definitions at start', () => {
        const run = () => {};
        assert.throws(
            () =>
                buildTools({
                    actions: { device: { x: { description: 'x', on: 'colection', run } } },
                }),
            /on must be item, collection or either/,
        );
        assert.throws(
            () =>
                buildTools({
                    types: {
                        a: { description: 'a', parent: 'b', id: 'a', list: () => [] },
                        b: { description: 'b', parent: 'a', id: 'b', list: () => [] },
                    },
                }),
            /loop/,
        );
        assert.throws(
            () =>
                buildTools({
                    types: {
                        single: { description: 's', parent: 'device', list: () => [] },
                        child: { description: 'c', parent: 'single', id: 'c', list: () => [] },
                    },
                }),
            /parent "single" has no id/,
        );
    });
});

describe('server types are not cut', () => {
    it('answers a big server record whole', async () => {
        const api = (await import('../lib/api.js')).default;
        const saved = { adapter: api.defaults.adapter, baseURL: api.defaults.baseURL };
        api.defaults.baseURL = 'http://stub';
        api.defaults.adapter = async (config) => ({
            data: { brand: 'b', logo: 'x'.repeat(MAX_TEXT + 10) },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
        });
        try {
            const { call } = build();
            const read = textOf(
                await call('resource_get', {
                    type: 'device',
                    ids: { device: 'big' },
                    user: 'acme',
                }),
            );
            assert.equal(JSON.parse(read).logo.length, MAX_TEXT + 10);
        } finally {
            Object.assign(api.defaults, saved);
        }
    });
});
