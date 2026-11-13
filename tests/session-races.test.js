// What can still lose a renewed session or mix two profiles' credentials:
// switches of the default, writes from other processes, exits and signals
// during a renewal, logins that complete meanwhile, streamed uploads.
import { testIdentity } from './setup.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import api from '../lib/api.js';
import { refreshToken } from '../lib/auth.js';
import {
    deleteConfig,
    getProfile,
    readConfig,
    refreshLockPath,
    setActiveProfile,
    setDefaultProfile,
    writeConfig,
} from '../lib/config.js';
import { withProfile } from '../lib/mcp/helpers.js';
import { inChild, jwt, lib, oauthServer } from './oauth-server.js';

const CONFIG = () => path.join(os.homedir(), '.config', testIdentity.configDir, 'config.json');

let srv;
before(async () => {
    srv = await oauthServer();
});
after(() => srv.close());

/** Profiles A (default, OAuth session with an expired access token) and B. */
function seed() {
    deleteConfig();
    setActiveProfile(null);
    srv.reset();
    setActiveProfile('A');
    writeConfig({
        server: srv.baseURL,
        username: 'ana',
        token: jwt(-60),
        refresh_token: srv.issue(),
        oauth_client_id: 'cli',
    });
    setActiveProfile('B');
    writeConfig({ server: 'http://b.invalid', username: 'bob', token: 'T-bob' });
    setActiveProfile(null);
    setDefaultProfile('A');
}

describe('a renewal in flight', () => {
    beforeEach(seed);

    it('saves into its own profile when the default changes meanwhile', async () => {
        srv.delayMs = 100;
        srv.onRefresh = () => setDefaultProfile('B');
        const token = await refreshToken();
        assert.equal(getProfile('A').token, token);
        assert.ok(srv.valid.has(getProfile('A').refresh_token));
        assert.deepEqual(getProfile('B'), {
            server: 'http://b.invalid',
            username: 'bob',
            token: 'T-bob',
        });
    });

    it('gives way to a login saved meanwhile, and hands over its session', async () => {
        srv.delayMs = 100;
        srv.onRefresh = () => {
            // Another process signs the profile in again, as another account.
            setActiveProfile('A');
            writeConfig({ server: srv.baseURL, username: 'carol', token: 'T-carol' });
            setActiveProfile(null);
        };
        assert.equal(await refreshToken(), 'T-carol');
        assert.deepEqual(getProfile('A'), {
            server: srv.baseURL,
            username: 'carol',
            token: 'T-carol',
        });
    });

    it('is saved before the process exits on an error of another request', async () => {
        srv.delayMs = 300;
        srv.route = (req, res) => {
            if (req.url !== '/missing') return false;
            setTimeout(() => {
                res.writeHead(404);
                res.end('{}');
            }, 50);
            return true;
        };
        const child = await inChild(`
            await Promise.all([api.get('/v1/users/ana/devices'), api.get('/missing')]).catch((e) =>
                output.printErr(e.message),
            );
        `);
        assert.equal(child.code, 1, child.out);
        assert.equal(srv.refreshes, 1);
        assert.ok(srv.valid.has(getProfile('A').refresh_token), 'the renewed session was lost');
    });

    it('lets a signal act after the save, through the listeners the process had', async () => {
        srv.delayMs = 300;
        const lock = refreshLockPath('A');
        // A listener that ends the process only when it is the last one,
        // as signal-exit (spinners, prompts) does.
        const child = await inChild(
            `
            const last = () => {
                if (process.listenerCount('SIGTERM') === 1) {
                    process.removeListener('SIGTERM', last);
                    process.kill(process.pid, 'SIGTERM');
                }
            };
            process.on('SIGTERM', last);
            await auth.refreshToken();
            setInterval(() => {}, 1000);
        `,
            {
                onSpawn: (c) => {
                    // A swallowed signal would leave it running: end the test.
                    setTimeout(() => c.kill('SIGKILL'), 5_000).unref();
                    const poll = setInterval(() => {
                        if (srv.refreshes) {
                            clearInterval(poll);
                            c.kill('SIGTERM');
                        }
                    }, 10);
                },
            },
        );
        assert.equal(child.signal, 'SIGTERM', child.out);
        assert.ok(srv.valid.has(getProfile('A').refresh_token), 'the renewed session was lost');
        assert.ok(!fs.existsSync(lock), 'the refresh lock was left behind');
    });

    it('does not resend a streamed body: it renews and asks to run again', async () => {
        await assert.rejects(
            api.post('/v1/users/ana/upload', Readable.from([Buffer.alloc(1024)]), {
                headers: { 'Content-Type': 'application/octet-stream' },
            }),
            (e) => {
                assert.equal(e.code, 'session_renewed');
                return true;
            },
        );
        assert.ok(srv.valid.has(getProfile('A').refresh_token));
    });
});

describe('the profiles file', () => {
    beforeEach(seed);

    it('keeps the writes of every process', async () => {
        const N = 200;
        const writer = (profile) =>
            inChild(`
                cfg.setActiveProfile(${JSON.stringify(profile)});
                for (let i = 1; i <= ${N}; i++) cfg.mergeConfig({ count: i });
            `);
        const results = await Promise.all([writer('A'), writer('B')]);
        for (const r of results) assert.equal(r.code, 0, r.out);
        assert.equal(getProfile('A').count, N);
        assert.equal(getProfile('B').count, N);
        assert.ok(srv.valid.has(getProfile('A').refresh_token));
    });

    it('is not taken for empty, and not overwritten, when it is not valid JSON', () => {
        fs.writeFileSync(CONFIG(), '{ "profiles": ');
        assert.throws(() => readConfig(), /not valid JSON: fix it, or remove it/);
        setActiveProfile('A');
        assert.throws(() => writeConfig({ server: 'x' }), /not valid JSON/);
        setActiveProfile(null);
        assert.equal(fs.readFileSync(CONFIG(), 'utf8'), '{ "profiles": ');
    });

    it('gives distinct refresh locks to names that differ only in symbols', () => {
        assert.notEqual(refreshLockPath('host:8080'), refreshLockPath('host_8080'));
    });
});

describe('a tool call of the MCP server', () => {
    beforeEach(seed);

    it('stays on the default it started with', async () => {
        const servers = await withProfile(undefined, async () => {
            const first = readConfig().server;
            setDefaultProfile('B');
            return [first, readConfig().server];
        });
        assert.deepEqual(servers, [srv.baseURL, srv.baseURL]);
    });
});

describe('a password login', () => {
    beforeEach(() => {
        seed();
        setActiveProfile('A');
        writeConfig({
            server: srv.baseURL,
            username: 'ana',
            token: 'perm-old',
            token_id: 'acme_cli_old',
        });
        setActiveProfile(null);
    });

    /** Sign A in with a password in another process, prompts answered. */
    async function login({ failCreate = false } = {}) {
        const calls = [];
        srv.route = (req, res, body) => {
            const ok = (data) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
                return true;
            };
            if (req.url === '/oauth/token' && body.includes('grant_type=password')) {
                calls.push('session');
                return ok({ access_token: 'session' });
            }
            if (req.method === 'POST' && req.url === '/v1/users/ana/tokens') {
                const id = JSON.parse(body).token;
                calls.push(`create ${id}`);
                if (failCreate) {
                    res.writeHead(503);
                    res.end('{}');
                    return true;
                }
                return ok({ access_token: `perm-${id}` });
            }
            if (req.method === 'DELETE') {
                // What the profile holds on disk when the old token goes.
                calls.push(
                    `revoke ${req.url.split('/').pop()} (saved ${getProfile('A').token_id})`,
                );
                return ok({});
            }
            return false;
        };
        const prompts = `export const password = async () => 'secret';
            export const input = async () => 'x'; export const select = async () => 'x';`;
        const child = await inChild(`
            const { registerHooks } = await import('node:module');
            registerHooks({
                resolve: (spec, ctx, next) =>
                    spec === '@inquirer/prompts'
                        ? { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(prompts)}), shortCircuit: true }
                        : next(spec, ctx),
            });
            process.stdin.isTTY = true;
            const { authenticate } = await import(${JSON.stringify(path.join(lib, 'auth.js'))} + '?prompted');
            cfg.setActiveProfile('A');
            await authenticate({ method: 'userpass', server: ${JSON.stringify(srv.baseURL)}, username: 'ana' })
                .catch((e) => console.log('failed: ' + e.message));
        `);
        return { calls, out: child.out };
    }

    it('creates a token of its own and revokes the one it had once the new one is saved', async () => {
        const { calls, out } = await login();
        const id = getProfile('A').token_id;
        assert.match(id, /^acme_cli_[0-9a-f]{8}$/, out);
        assert.equal(getProfile('A').token, `perm-${id}`);
        assert.deepEqual(calls, ['session', `create ${id}`, `revoke acme_cli_old (saved ${id})`]);
    });

    it('revokes nothing when the new token cannot be made', async () => {
        const { calls, out } = await login({ failCreate: true });
        assert.match(out, /failed/);
        assert.equal(calls.filter((c) => c.startsWith('revoke')).length, 0);
        assert.equal(getProfile('A').token, 'perm-old');
    });
});
