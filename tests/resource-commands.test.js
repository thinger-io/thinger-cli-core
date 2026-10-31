// @ts-check
import './setup.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import api from '../lib/api.js';
import { CATALOG } from '../lib/mcp/catalog.js';
import { setJsonMode } from '../lib/output.js';
import {
    actionName,
    cliDescription,
    cliWording,
    commandPath,
    registerResourceCommands,
} from '../lib/commands/resources.js';
import { apiMethod, apiPath, decodeBody, rawApiCall } from '../lib/raw-api.js';
import { requestFor } from '../lib/mcp/catalog.js';
import { storageFilePath } from '../lib/storage.js';
import { describeArguments } from '../lib/commands/arguments.js';
import { resolveExpiryMs } from '../lib/tokens.js';

const VERBS = ['list', 'get', 'create', 'update', 'delete', 'clone'];

/** A token whose user is `acme`, for the environment profile. */
const jwt = `x.${Buffer.from(JSON.stringify({ usr: 'acme' })).toString('base64url')}.y`;

before(() => {
    process.env.ACME_TOKEN = jwt;
    process.env.ACME_SERVER = 'http://stub';
});
after(() => {
    delete process.env.ACME_TOKEN;
    delete process.env.ACME_SERVER;
});

function program() {
    const p = new Command().name('acme').option('-u, --user <username>').exitOverride();
    registerResourceCommands(p);
    return p;
}

/** Find the command at a path of names. */
function find(p, names) {
    let cmd = p;
    for (const n of names) {
        cmd = cmd.commands.find((c) => c.name() === n);
        if (!cmd) return undefined;
    }
    return cmd;
}

/**
 * Run a command line against a stubbed server: every request answers
 * `data`. Returns the requests and what was printed.
 */
async function run(argv, data = {}) {
    const calls = [];
    const out = [];
    const saved = { adapter: api.defaults.adapter, log: console.log, write: process.stdout.write };
    api.defaults.adapter = async (config) => {
        calls.push(config);
        return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    console.log = (...a) => out.push(a.join(' '));
    // @ts-ignore -- captured for the test
    process.stdout.write = (chunk) => out.push(String(chunk)) || true;
    try {
        await program().parseAsync(['node', 'acme', ...argv]);
    } finally {
        api.defaults.adapter = saved.adapter;
        console.log = saved.log;
        process.stdout.write = saved.write;
        setJsonMode(false);
    }
    return { calls, out: out.join('\n') };
}

describe('generic resource commands', () => {
    it('give every type of the catalog its verbs, describe and actions', () => {
        const p = program();
        for (const [type, spec] of Object.entries(CATALOG)) {
            const group = find(p, commandPath(type));
            assert.ok(group, `no command for ${type}`);
            const names = group.commands.map((c) => c.name());
            for (const verb of VERBS.filter((v) => v in spec.ops)) {
                assert.ok(names.includes(verb), `${type} lacks ${verb}`);
            }
            assert.ok(names.includes('describe'), `${type} lacks describe`);
            for (const action of Object.keys(spec.actions || {})) {
                assert.ok(names.includes(actionName(type, action)), `${type} lacks ${action}`);
            }
            if (spec.id === 'property' && 'update' in spec.ops) {
                assert.ok(names.includes('set'), `${type} lacks set`);
            }
        }
    });

    it('put server types under admin and keep commands written by hand', () => {
        const p = new Command().name('acme');
        const device = p.command('device');
        device.command('list').description('hand-written');
        registerResourceCommands(p);
        assert.equal(find(p, ['device', 'list'])?.description(), 'hand-written');
        assert.equal(p.commands.filter((c) => c.name() === 'device').length, 1);
        assert.ok(find(p, ['device', 'update']));
        assert.ok(find(p, ['admin', 'host', 'restart']));
        assert.equal(find(p, ['user']), undefined);
    });

    it('send updates with --set fields, nested by dots', async () => {
        const { calls } = await run([
            'device',
            'property',
            'update',
            'boiler',
            'setpoint',
            '-s',
            'value.target=21',
            '-s',
            'value.mode="eco"',
            '--merge',
        ]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'patch');
        assert.match(calls[0].url, /\/users\/acme\/devices\/boiler\/properties\/setpoint$/);
        assert.deepEqual(JSON.parse(calls[0].data), { value: { target: 21, mode: 'eco' } });
    });

    it('take parents and ids as arguments, and clone under a new id', async () => {
        const tag = await run(['device', 'bucket', 'tag', 'get', 'd1', 'b1', 't1']);
        assert.match(tag.calls[0].url, /\/devices\/d1\/buckets\/b1\/tags\/t1$/);
        const clone = await run(['endpoint', 'clone', 'e1', 'e2', '-s', 'name=Copy']);
        assert.equal(clone.calls[0].method, 'post');
        assert.match(clone.calls[0].url, /\/endpoints\/e1\/clone$/);
        assert.deepEqual(JSON.parse(clone.calls[0].data), { name: 'Copy', endpoint: 'e2' });
    });

    it('list everything unless --count, and answer { ok, data } with --json', async () => {
        const records = Array.from({ length: 60 }, (_, i) => ({ endpoint: `e${i}` }));
        const { calls, out } = await run(['endpoint', 'list', '-j'], records);
        assert.equal(calls[0].params.count, undefined);
        const parsed = JSON.parse(out);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.data.length, 60);
    });

    it('run actions, on items and on collections', async () => {
        const stats = await run(['alarm', 'instance', 'stats', '-j'], { active: 2 });
        assert.equal(stats.calls[0].method, 'get');
        assert.deepEqual(JSON.parse(stats.out).data, { active: 2 });
        const call = await run(['endpoint', 'call', 'e1', '-s', 'temp=20']);
        assert.equal(call.calls[0].method, 'post');
        assert.match(call.calls[0].url, /\/endpoints\/e1\/call$/);
        assert.deepEqual(JSON.parse(call.calls[0].data), { temp: 20 });
    });

    it('run the hooks the MCP runs: token expiries in milliseconds', async () => {
        const { calls } = await run([
            'token',
            'create',
            'ci',
            '-s',
            'name=CI',
            '-s',
            'expire="1d"',
            '-s',
            'allow={"Device":{"*":"*"}}',
        ]);
        const body = JSON.parse(calls[0].data);
        assert.equal(body.token, 'ci');
        assert.ok(body.expire > Date.now() + 23 * 3600 * 1000);
    });

    it('refuse an array body where one record is expected', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-core-arr-')), 'a.json');
        fs.writeFileSync(file, '[1,2]');
        const exit = process.exit;
        const err = process.stderr.write;
        let code;
        // @ts-ignore -- printErr exits: record it instead
        process.exit = (c) => {
            code = c;
            throw new Error('exit');
        };
        // @ts-ignore
        process.stderr.write = () => true;
        try {
            await run(['endpoint', 'clone', 'e1', 'e2', '--from', file]).catch(() => {});
        } finally {
            process.exit = exit;
            process.stderr.write = err;
        }
        assert.equal(code, 1);
    });

    it('set the value of a property, and create it when the server has none', async () => {
        const set = await run(['device', 'property', 'set', 'boiler', 'setpoint', '21', '-j']);
        assert.equal(set.calls.length, 1);
        assert.equal(set.calls[0].method, 'put');
        assert.match(set.calls[0].url, /\/devices\/boiler\/properties\/setpoint$/);
        assert.deepEqual(JSON.parse(set.calls[0].data), { value: 21 });
        assert.deepEqual(JSON.parse(set.out).data, {
            parent: 'boiler',
            id: 'setpoint',
            value: 21,
        });

        // The account's properties: a 404 on the update creates it.
        const calls = [];
        const saved = api.defaults.adapter;
        const log = console.log;
        api.defaults.adapter = async (config) => {
            calls.push(config);
            if (config.method === 'put') {
                const response = { status: 404, data: {}, headers: {}, config };
                throw Object.assign(new Error('404'), { response, config, isAxiosError: true });
            }
            return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
        };
        console.log = () => {};
        try {
            await program().parseAsync(['node', 'acme', 'property', 'set', 'mode', '"eco"']);
        } finally {
            api.defaults.adapter = saved;
            console.log = log;
        }
        assert.deepEqual(
            calls.map((c) => c.method),
            ['put', 'post'],
        );
        assert.deepEqual(JSON.parse(calls[1].data), { property: 'mode', value: 'eco' });
    });

    it('print one field of a record with -f', async () => {
        const record = { endpoint: 'e1', config: { url: 'https://x', headers: { a: 1 } } };
        const text = await run(['endpoint', 'get', 'e1', '-f', 'config.url'], record);
        assert.equal(text.out, 'https://x');
        const obj = await run(['endpoint', 'get', 'e1', '-f', 'config.headers', '-j'], record);
        assert.deepEqual(JSON.parse(obj.out).data, { a: 1 });
    });

    it('take -n and -d over --set on create and update', async () => {
        const created = await run([
            'endpoint',
            'create',
            'e1',
            '-s',
            'name=From set',
            '-n',
            'Notify',
            '-d',
            'Sends a mail',
        ]);
        assert.deepEqual(JSON.parse(created.calls[0].data), {
            endpoint: 'e1',
            name: 'Notify',
            description: 'Sends a mail',
        });
        const updated = await run(['bucket', 'update', 'temps', '-n', 'Temperatures']);
        assert.equal(updated.calls[0].method, 'put');
        assert.deepEqual(JSON.parse(updated.calls[0].data), { name: 'Temperatures' });
        const p = program();
        const options = (path) =>
            find(p, path)?.options.map((o) => o.long) ?? assert.fail(path.join(' '));
        assert.ok(!options(['role', 'create']).includes('--name'));
        assert.ok(options(['product', 'profile', 'bucket', 'create']).includes('--name'));
    });

    it('name ids after their noun and put the profile under product profile', () => {
        const p = program();
        const usage = (path) => find(p, path)?.usage();
        assert.equal(usage(['asset', 'type', 'get']), '[options] <asset-type>');
        assert.equal(usage(['admin', 'oauth-client', 'get']), '[options] <oauth-client>');
        assert.equal(usage(['product', 'profile', 'api', 'get']), '[options] <product> <api>');
        assert.equal(usage(['bucket', 'export-file', 'delete']), '[options] <bucket> <file>');
        assert.equal(usage(['alarm', 'rule', 'test']), '[options] <alarm-rule>');
        assert.equal(usage(['admin', 'host', 'get-settings']), '[options] <host>');
        assert.equal(usage(['plugin', 'uninstall']), '[options] <plugin>');
        assert.equal(usage(['sync', 'lock', 'list']), '[options] <sync>');
        assert.ok(find(p, ['product', 'profile', 'code', 'update']));
    });

    it('ask before replacing a whole profile category', async () => {
        const exit = process.exit;
        const write = process.stdout.write;
        const err = process.stderr.write;
        let code;
        // @ts-ignore -- printErr exits: record it instead
        process.exit = (c) => {
            code = c;
            throw new Error('exit');
        };
        // @ts-ignore
        process.stderr.write = () => true;
        try {
            const { calls } = await run([
                'product',
                'profile',
                'bucket',
                'replace-all',
                'meter',
                '-s',
                'b1.enabled=true',
            ]).catch(() => ({ calls: [] }));
            assert.equal(calls.length, 0);
        } finally {
            process.exit = exit;
            process.stdout.write = write;
            process.stderr.write = err;
        }
        assert.equal(code, 1);
        const { calls } = await run([
            'product',
            'profile',
            'bucket',
            'replace-all',
            'meter',
            '-s',
            'b1.enabled=true',
            '-y',
        ]);
        assert.equal(calls[0].method, 'put');
        assert.match(calls[0].url, /\/products\/meter\/profile\/buckets$/);
    });

    it('treat aliases of hand-written commands as taken', () => {
        const p = new Command().name('acme');
        p.command('device').command('read').alias('get').description('hand-written');
        registerResourceCommands(p);
        const device = find(p, ['device']);
        assert.equal(device?.commands.filter((c) => c.name() === 'get').length, 0);
    });

    it('leave alone a leaf command of a type name', () => {
        const p = new Command().name('acme');
        p.command('endpoint')
            .description('leaf')
            .action(() => {});
        p.command('admin')
            .description('leaf')
            .action(() => {});
        registerResourceCommands(p);
        assert.equal(find(p, ['endpoint'])?.commands.length, 0);
        assert.equal(find(p, ['admin'])?.commands.length, 0);
    });

    it('describe every argument, generated or written by hand', () => {
        const p = new Command().name('acme');
        p.command('device').command('status <device> <unit>');
        registerResourceCommands(p);
        describeArguments(p, { byCommand: { 'device status': { unit: 'Systemd unit' } } });
        assert.deepEqual(
            find(p, ['device', 'status'])?.registeredArguments.map((a) => a.description),
            ['Device ID', 'Systemd unit'],
        );
        const args = find(p, ['device', 'property', 'get'])?.registeredArguments;
        assert.deepEqual(
            args?.map((a) => a.description),
            ['ID of the device', 'ID of the device property'],
        );
    });

    it('describe commands with the commands instead of the tools', () => {
        assert.equal(
            cliDescription(
                'Data buckets (time series). Data is read with {tool:bucket_data_read}.',
            ),
            'Data buckets (time series). Data is read with `acme bucket read`',
        );
        assert.equal(
            cliDescription('Devices. Their sessions are listed with {tool:sessions}.'),
            'Devices',
        );
        assert.equal(
            cliWording('Created device_property boiler/x; pass index: 50 for more'),
            'Created device_property boiler/x; pass --index 50 for more',
        );
        assert.equal(
            cliDescription(
                'File storages (their files are handled with the storage_file_* tools).',
            ),
            'File storages',
        );
    });
});

describe('raw api calls', () => {
    it('only take paths of the server, with {user} filled in', () => {
        assert.equal(apiPath('/v1/users/{user}/devices'), '/v1/users/acme/devices');
        assert.equal(apiPath('/v1/users/{user}/devices', 'other'), '/v1/users/other/devices');
        assert.throws(() => apiPath('https://evil.example/x'), /must start with/);
        assert.throws(() => apiPath('//evil.example/x'), /must start with/);
        assert.throws(() => apiPath('/v1/a b'), /spaces/);
    });

    it('pick the method as gh api does', () => {
        assert.equal(apiMethod(undefined, false), 'GET');
        assert.equal(apiMethod(undefined, true), 'POST');
        assert.equal(apiMethod('put', true), 'PUT');
        assert.throws(() => apiMethod('TRACE', false), /unknown method/);
    });

    it('decode JSON, text and binary answers', () => {
        assert.deepEqual(decodeBody(Buffer.from('{"a":1}'), 'application/json'), {
            kind: 'json',
            body: { a: 1 },
        });
        assert.equal(
            decodeBody(Buffer.from('{"p":1}\n{"p":2}\n'), 'application/json').kind,
            'text',
        );
        assert.equal(decodeBody(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png').kind, 'binary');
        assert.equal(decodeBody(Buffer.alloc(0), 'application/json').kind, 'empty');
    });

    it('send the request and decode the server error', async () => {
        const saved = api.defaults.adapter;
        const calls = [];
        api.defaults.adapter = async (config) => {
            calls.push(config);
            if (config.url.endsWith('/missing')) {
                const response = {
                    data: Buffer.from('{"error":{"message":"no such thing"}}'),
                    status: 400,
                    statusText: 'Bad Request',
                    headers: { 'content-type': 'application/json' },
                    config,
                };
                throw Object.assign(new Error('400'), { response, config, isAxiosError: true });
            }
            return {
                data: Buffer.from('[1,2]'),
                status: 200,
                headers: { 'content-type': 'application/json' },
                config,
            };
        };
        try {
            const res = await rawApiCall({ path: '/v1/users/{user}/x', query: { n: '007' } });
            assert.deepEqual(res.body, [1, 2]);
            assert.equal(calls[0].url, '/v1/users/acme/x');
            assert.deepEqual(calls[0].params, { n: '007' });
            await assert.rejects(rawApiCall({ path: '/v1/missing' }), /no such thing/);
        } finally {
            api.defaults.adapter = saved;
        }
    });
});

describe('paths that would point elsewhere', () => {
    it('refuse . and .. as ids: the URL would reach the parent', () => {
        assert.throws(
            () => requestFor('device_property', 'delete', { parent: 'dev', id: '..' }),
            /invalid id/,
        );
        assert.throws(() => requestFor('device', 'get', { id: '.' }), /invalid id/);
    });

    it('escape every segment of a storage file and refuse dot segments', () => {
        assert.equal(storageFilePath('/web/a#b c.txt'), 'web/a%23b%20c.txt');
        for (const bad of ['..', 'web/../x', './a', 'a//b', '']) {
            assert.throws(() => storageFilePath(bad), /invalid file path/, bad);
        }
    });
});

describe('account token expiries', () => {
    it('take durations from now and timestamps as ms, or seconds when too small', () => {
        assert.ok(resolveExpiryMs('1d') > Date.now() + 23 * 3600 * 1000);
        assert.equal(resolveExpiryMs(1767225600), 1767225600000);
        assert.equal(resolveExpiryMs('1767225600000'), 1767225600000);
        assert.equal(resolveExpiryMs(null), null);
    });
});
