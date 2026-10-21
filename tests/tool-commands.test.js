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
import { registerToolCommands } from '../lib/commands/tools.js';

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

describe('tool commands', () => {
    function program() {
        const p = new Command().name('acme').option('-u, --user <username>').exitOverride();
        const groups = {
            device: p.command('device'),
            product: p.command('product'),
            bucket: p.command('bucket'),
        };
        groups.product.command('apply').description('the CLI’s own');
        registerToolCommands(p, groups);
        return p;
    }

    it('leave the commands a CLI has of the same name', () => {
        const p = program();
        const product = p.commands.find((c) => c.name() === 'product');
        const apply = product?.commands.filter((c) => c.name() === 'apply');
        assert.equal(apply?.length, 1);
        assert.equal(apply?.[0].description(), 'the CLI’s own');
        assert.ok(product?.commands.some((c) => c.name() === 'resource'));
        const storage = p.commands.find((c) => c.name() === 'storage');
        assert.deepEqual(
            storage?.commands.map((c) => c.name()),
            ['files', 'upload', 'download', 'rm'],
        );
    });

    it('write NDJSON samples to a bucket', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-ndjson-'));
        const file = path.join(dir, 's.ndjson');
        fs.writeFileSync(file, '{"ts":1,"t":20}\n{"ts":2,"t":21}\n');
        const log = console.log;
        console.log = () => {};
        try {
            const calls = await withServer(
                () => ({}),
                () =>
                    program().parseAsync([
                        'node',
                        'acme',
                        'bucket',
                        'write',
                        'temps',
                        '--from',
                        file,
                    ]),
            );
            assert.equal(calls[0].url, '/v1/users/acme/buckets/temps/data');
            assert.deepEqual(calls[0].data, [
                { ts: 1, t: 20 },
                { ts: 2, t: 21 },
            ]);
        } finally {
            console.log = log;
            setJsonMode(false);
        }
    });
});
