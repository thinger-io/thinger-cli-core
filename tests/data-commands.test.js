// @ts-check
import './setup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import api from '../lib/api.js';
import { applyProduct } from '../lib/product-apply.js';
import { exportBucket } from '../lib/bucket-export.js';
import { setJsonMode } from '../lib/output.js';
import { registerDataCommands } from '../lib/commands/data.js';
import { defineCliDocs } from '../lib/docs.js';
import { registerApiCommand } from '../lib/commands/api.js';

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
 * Serve requests with `route(method, url, data)`: it returns the answer's
 * data, or a number for an error status.
 */
async function withServer(route, fn) {
    const calls = [];
    const saved = api.defaults.adapter;
    api.defaults.adapter = async (config) => {
        const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        calls.push({ method: config.method, url: config.url, data });
        const answer = await route(config.method, config.url, data);
        if (typeof answer === 'number') {
            const response = { status: answer, data: {}, headers: {}, config };
            throw Object.assign(new Error(String(answer)), {
                response,
                config,
                isAxiosError: true,
            });
        }
        const body =
            config.responseType === 'arraybuffer'
                ? Buffer.from(typeof answer === 'string' ? answer : JSON.stringify(answer))
                : answer;
        const type = typeof answer === 'string' ? 'text/csv' : 'application/json';
        return { data: body, status: 200, headers: { 'content-type': type }, config };
    };
    try {
        await fn();
    } finally {
        api.defaults.adapter = saved;
    }
    return calls;
}

describe('product apply', () => {
    const doc = {
        product: 'meter',
        name: 'Meter',
        enabled: true,
        created: 1,
        config: { icons: [] },
        profile: { buckets: { b: { enabled: true } }, code: { code: 'x' }, console: {} },
        _resources: { properties: [{ property: 'dashboard', value: { tabs: [] }, modified: 2 }] },
    };

    it('creates a missing product with its properties', async () => {
        const calls = await withServer(
            (method) => (method === 'get' ? 404 : {}),
            async () => {
                const result = await applyProduct(doc);
                assert.deepEqual(result, {
                    product: 'meter',
                    created: true,
                    properties: { created: ['dashboard'], updated: [] },
                });
            },
        );
        const post = calls.find((c) => c.method === 'post' && c.url.endsWith('/products'));
        assert.equal(post?.data.product, 'meter');
        assert.equal(post?.data.created, undefined);
        assert.equal(post?.data._resources, undefined);
        const prop = calls.find((c) => c.url.endsWith('/products/meter/properties'));
        assert.deepEqual(prop?.data, { property: 'dashboard', value: { tabs: [] } });
    });

    it('updates an existing one: fields, each profile category, properties', async () => {
        const calls = await withServer(
            () => ({}),
            async () => {
                const result = await applyProduct(doc);
                assert.equal(result.created, false);
                assert.deepEqual(result.properties.updated, ['dashboard']);
            },
        );
        const puts = calls.filter((c) => c.method === 'put');
        assert.deepEqual(
            puts.map((c) => c.url.replace('/v1/users/acme/products/meter', '')),
            ['', '/profile/buckets', '/profile/code', '/properties/dashboard'],
        );
        assert.deepEqual(puts[0].data, { name: 'Meter', enabled: true, config: { icons: [] } });
        assert.deepEqual(puts[3].data, { value: { tabs: [] } });
    });

    it('names the step that failed and the categories it leaves', async () => {
        await withServer(
            (method, url) => (method === 'put' && url.endsWith('/profile/code') ? 404 : {}),
            () => assert.rejects(applyProduct(doc), /Not found: profile code \(PUT /),
        );
        await withServer(
            () => ({}),
            async () => assert.deepEqual((await applyProduct(doc)).ignored, ['profile.console']),
        );
    });

    it('refuses a document without its product id', async () => {
        await assert.rejects(applyProduct({ name: 'x' }), /"product" id/);
    });
});

describe('bucket export', () => {
    it('waits for the file, downloads it and deletes it', async () => {
        let polls = 0;
        const calls = await withServer(
            (method, url) => {
                if (method === 'post') return { file: 'f.csv', state: 0 };
                if (method === 'get' && url.endsWith('/exports'))
                    return [{ file: 'f.csv', state: ++polls > 1 ? 1 : 0 }];
                if (method === 'get') return '"t";"ts"\n1;"2026"\n';
                return {};
            },
            async () => {
                const { file, data } = await exportBucket({ bucket: 'temps', pollMs: 1 });
                assert.equal(file, 'f.csv');
                assert.match(String(data), /^"t";"ts"/);
            },
        );
        assert.deepEqual(calls[0].data, { data_type: 'csv', timestamp_format: 'iso' });
        assert.equal(calls.at(-1)?.method, 'delete');
    });

    it('stops when the server fails the export', async () => {
        await withServer(
            (method) => (method === 'post' ? { file: 'f.csv' } : [{ file: 'f.csv', state: 2 }]),
            () => assert.rejects(exportBucket({ bucket: 'temps', pollMs: 1 }), /could not export/),
        );
    });
});

describe('data commands', () => {
    function program() {
        const p = new Command().name('acme').option('-u, --user <username>').exitOverride();
        // Groups written by hand (with commands: an empty one is a CLI's leaf).
        p.command('device').command('list');
        p.command('bucket').command('list');
        p.command('product').command('apply').description('the CLI’s own');
        registerDataCommands(p);
        registerApiCommand(p);
        return p;
    }

    /** Run a command line against `route`, quiet; returns the requests and stdout. */
    async function run(argv, route = () => ({})) {
        const out = [];
        const saved = { log: console.log, write: process.stdout.write };
        console.log = (...a) => out.push(a.join(' '));
        // Captured for the test. Only strings: the test runner's own reports
        // to its parent go through stdout as buffers and must still get there.
        // @ts-ignore
        process.stdout.write = (chunk, ...rest) =>
            typeof chunk === 'string'
                ? out.push(chunk) > 0
                : saved.write.call(process.stdout, chunk, ...rest);
        let calls;
        try {
            calls = await withServer(route, () => program().parseAsync(['node', 'acme', ...argv]));
        } finally {
            console.log = saved.log;
            process.stdout.write = saved.write;
            setJsonMode(false);
        }
        return { calls, out: out.join('\n') };
    }

    it('leave the commands a CLI has of the same name', () => {
        const p = program();
        const product = p.commands.find((c) => c.name() === 'product');
        const apply = product?.commands.filter((c) => c.name() === 'apply');
        assert.equal(apply?.length, 1);
        assert.equal(apply?.[0].description(), 'the CLI’s own');
        const names = (cmd) => cmd?.commands.map((c) => c.name());
        const find = (...path) =>
            path.reduce((cmd, n) => cmd?.commands.find((c) => c.name() === n), p);
        assert.deepEqual(names(find('product', 'profile', 'api')), ['call']);
        assert.equal(
            find('product', 'profile', 'api', 'call').usage(),
            '[options] <product> <resource>',
        );
        assert.deepEqual(names(find('doc')), ['list', 'get']);
        assert.equal(find('doc').helpGroup(), 'Integration:');
        assert.deepEqual(names(find('device', 'resource')), ['list', 'call']);
        assert.deepEqual(names(find('storage', 'file')), ['list', 'upload', 'download', 'delete']);
    });

    it('write NDJSON samples to a bucket', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-ndjson-'));
        const file = path.join(dir, 's.ndjson');
        fs.writeFileSync(file, '{"ts":1,"t":20}\n{"ts":2,"t":21}\n');
        const { calls } = await run(['bucket', 'write', 'temps', '--from', file]);
        assert.equal(calls[0].url, '/v1/users/acme/buckets/temps/data');
        assert.deepEqual(calls[0].data, [
            { ts: 1, t: 20 },
            { ts: 2, t: 21 },
        ]);
    });

    // --json answers keep the shapes they had before the tools became types.
    it('keep their --json shapes', async () => {
        const json = (r) => JSON.parse(r.out).data;
        const write = await run(['bucket', 'write', 'temps', '-s', 't=20', '--ts', '5', '-j']);
        assert.deepEqual(write.calls[0].data, { t: 20 });
        assert.equal(write.calls[0].url, '/v1/users/acme/buckets/temps/data');
        assert.deepEqual(json(write), { bucket: 'temps', samples: 1 });

        const sent = await run(['device', 'send', 'd1', '-s', 't=20', '-j'], () => ({ ok: 1 }));
        assert.equal(sent.calls[0].method, 'post');
        assert.equal(sent.calls[0].url, '/v3/users/acme/devices/d1/callback/data');
        assert.deepEqual(json(sent), { device: 'd1', answer: { ok: 1 } });
        const quiet = await run(['device', 'send', 'd1', '-s', 't=20', '-j'], () => '');
        assert.deepEqual(json(quiet), { device: 'd1' });

        const overview = await run(['device', 'overview', '--locations', '-j'], (m, url) =>
            url.endsWith('/stats') ? { days: [] } : [{ device: 'd1' }],
        );
        assert.deepEqual(json(overview), { stats: { days: [] }, locations: [{ device: 'd1' }] });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-up-'));
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        const up = await run(['storage', 'file', 'upload', 'web', path.join(dir, 'a.txt'), '-j']);
        assert.deepEqual(json(up), { storage: 'web', files: ['a.txt'], bytes: 5 });

        const del = await run(['storage', 'file', 'delete', 'web', '/a.txt', '-y', '-j']);
        assert.deepEqual(json(del), { path: 'a.txt', deleted: true });

        const plugin = await run(['plugin', 'call', 'nr', '/api/x', '-j'], () => '{"up":true}');
        assert.match(plugin.calls[0].url, /\/plugins\/nr\/api\/x$/);
        assert.deepEqual(json(plugin), { up: true });

        const listed = await run(['storage', 'file', 'list', 'web'], () => []);
        assert.equal(listed.out, 'No files.');
    });

    it('list and read the guides', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-docs-'));
        fs.writeFileSync(path.join(dir, 'g.md'), '# Guide\n\nRead me.');
        defineCliDocs([{ id: 'acme-guide', title: 'The guide', file: path.join(dir, 'g.md') }]);
        try {
            const listed = await run(['doc', 'list', '-j'], () => 404);
            const docs = JSON.parse(listed.out).data;
            assert.ok(docs.some((d) => d.doc === 'acme-guide' && d.title === 'The guide'));
            const got = await run(['doc', 'get', 'acme-guide'], () => 404);
            assert.match(got.out, /Read me\./);
        } finally {
            defineCliDocs([]);
        }
    });

    it('call a device resource with -s as its input, and read one field', async () => {
        const call = await run(
            ['device', 'resource', 'call', 'd1', 'led', '-s', 'on=true', '-f', 'state'],
            () => ({ state: 'on', since: 1 }),
        );
        assert.equal(call.calls[0].method, 'post');
        assert.equal(call.calls[0].url, '/v3/users/acme/devices/d1/resources/led');
        assert.deepEqual(call.calls[0].data, { on: true });
        assert.equal(call.out, 'on');
        // Without input, it reads the resource.
        const read = await run(['device', 'resource', 'call', 'd1', 'temp', '-j'], () => ({
            celsius: 21.5,
        }));
        assert.equal(read.calls[0].method, 'get');
        assert.deepEqual(JSON.parse(read.out), { ok: true, data: { celsius: 21.5 } });
    });

    it('list the resources of a device as data with --json', async () => {
        const { out } = await run(['device', 'resource', 'list', 'd1', '-j'], (method, url) =>
            url.endsWith('/resources/api') ? { temp: { fn: 3 } } : { out: 0 },
        );
        assert.deepEqual(JSON.parse(out).data, [{ name: 'temp', fn: 3, out: 0 }]);
    });

    it('call a product API resource for the whole product', async () => {
        const { calls } = await run([
            'product',
            'profile',
            'api',
            'call',
            'meter',
            'ingest',
            '-s',
            'temp=20',
        ]);
        assert.equal(calls[0].url, '/v1/users/acme/products/meter/resources/ingest');
        assert.deepEqual(calls[0].data, { temp: 20 });
    });

    it('send a body built with -s from api', async () => {
        const { calls } = await run([
            'api',
            '/v1/users/{user}/buckets',
            '-s',
            'bucket=temps',
            '-s',
            'config.source=write',
        ]);
        assert.equal(calls[0].method, 'post');
        assert.equal(calls[0].url, '/v1/users/acme/buckets');
        assert.deepEqual(calls[0].data, {
            bucket: 'temps',
            config: { source: 'write' },
        });
    });

    it('list, delete and download storage files', async () => {
        const list = await run(['storage', 'file', 'list', 'web', 'assets', '-j'], () => [
            { path: 'assets/a.js' },
        ]);
        assert.equal(list.calls[0].url, '/v1/users/acme/storages/web/files');
        assert.deepEqual(JSON.parse(list.out).data, [{ path: 'assets/a.js' }]);
        const del = await run(['storage', 'file', 'delete', 'web', 'a b.txt', '-y', '-j']);
        assert.equal(del.calls[0].method, 'delete');
        assert.match(del.calls[0].url, /\/storages\/web\/files\/a%20b\.txt$/);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-dl-'));
        const file = path.join(dir, 'index.html');
        await run(['storage', 'file', 'download', 'web', 'index.html', '-o', file], () => '<p>');
        assert.equal(fs.readFileSync(file, 'utf8'), '<p>');
    });
});

describe('product apply --from', () => {
    it('reads the product from --from, with -s over it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-apply-'));
        const file = path.join(dir, 'meter.json');
        fs.writeFileSync(file, JSON.stringify({ product: 'meter', name: 'Meter' }));
        const p = new Command().name('acme').option('-u, --user <username>').exitOverride();
        registerDataCommands(p);
        const log = console.log;
        console.log = () => {};
        let calls;
        try {
            calls = await withServer(
                (method) => (method === 'get' ? 404 : {}),
                () =>
                    p.parseAsync([
                        'node',
                        'acme',
                        'product',
                        'apply',
                        '--from',
                        file,
                        '-s',
                        'name=Meter 2',
                    ]),
            );
        } finally {
            console.log = log;
        }
        const post = calls.find((c) => c.method === 'post');
        assert.equal(post?.data.product, 'meter');
        assert.equal(post?.data.name, 'Meter 2');
        // The file is no argument any more.
        const err = process.stderr.write;
        // @ts-ignore -- commander's error line
        process.stderr.write = () => true;
        try {
            await assert.rejects(
                p.parseAsync(['node', 'acme', 'product', 'apply', 'meter.json']),
                /too many arguments/,
            );
        } finally {
            process.stderr.write = err;
        }
    });
});
