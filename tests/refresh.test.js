import { testIdentity } from './setup.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from '../lib/api.js';
import { refreshToken } from '../lib/auth.js';
import {
    addImpersonatingProfile,
    deleteConfig,
    getProfile,
    readConfig,
    refreshLockPath,
    withActiveProfile,
    writeConfig,
} from '../lib/config.js';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/** An unsigned JWT access token that expires in `seconds`. */
function jwt(seconds, tag = Math.random().toString(36).slice(2)) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ usr: 'ana', exp: Math.floor(Date.now() / 1000) + seconds, tag })}.sig`;
}

// A server that renews sessions as Thinger does: each refresh token works
// once, and the answer carries a new one.
const oauth = {
    valid: new Set(),
    refreshes: 0,
    delayMs: 0,
    /** @type {((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null} */
    override: null,
};
let server;
let baseURL;

function issue() {
    const refresh = `rt-${Math.random().toString(36).slice(2)}`;
    oauth.valid.add(refresh);
    return refresh;
}

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
            if (oauth.override?.(req, res)) return;
            if (req.url === '/oauth/token') {
                // The presented token is spent on arrival, then the answer
                // takes its time: a client gone meanwhile never gets the new one.
                const presented = new URLSearchParams(body).get('refresh_token');
                const spent = oauth.valid.delete(presented);
                const renewed = spent ? issue() : null;
                oauth.refreshes++;
                await new Promise((r) => setTimeout(r, oauth.delayMs));
                if (!spent) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: { message: 'invalid refresh token' } }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ access_token: jwt(7200), refresh_token: renewed }));
            }
            // Any other request: valid only with the token stored last.
            const ok = req.headers.authorization === `Bearer ${readConfig().token}`;
            res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { ok: true } : { error: { message: 'expired' } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
    deleteConfig();
    oauth.valid.clear();
    oauth.refreshes = 0;
    oauth.delayMs = 0;
    oauth.override = null;
    writeConfig({
        server: baseURL,
        username: 'ana',
        token: jwt(-60),
        refresh_token: issue(),
        oauth_client_id: 'cli',
    });
});

/** Renew the session in another process sharing the same config. */
function refreshInChild({ onSpawn, profile } = {}) {
    const code = `
        import { defineIdentity } from ${JSON.stringify(path.join(lib, 'identity.js'))};
        defineIdentity(${JSON.stringify(testIdentity)});
        const { refreshToken } = await import(${JSON.stringify(path.join(lib, 'auth.js'))});
        try { await refreshToken(); console.log('ok'); }
        catch (e) { console.log('error ' + e.code + ' ' + e.message); }
    `;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            env: {
                ...process.env,
                NODE_TEST_CONTEXT: '',
                ...(profile && { ACME_PROFILE: profile }),
            },
        });
        onSpawn?.(child);
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        child.on('close', (_code, signal) => resolve(signal ?? out.trim()));
    });
}

describe('session refresh', () => {
    it('saves the rotated refresh token with the new access token', async () => {
        const before = readConfig();
        const token = await refreshToken();
        const now = readConfig();
        assert.equal(now.token, token);
        assert.notEqual(now.refresh_token, before.refresh_token);
        assert.ok(oauth.valid.has(now.refresh_token));
        // And the next renewal works with it.
        await refreshToken();
        assert.equal(oauth.refreshes, 2);
    });

    it('lets processes take turns: the second uses the session the first saved', async () => {
        oauth.delayMs = 300;
        const results = await Promise.all([refreshInChild(), refreshInChild(), refreshInChild()]);
        assert.deepEqual(results, ['ok', 'ok', 'ok']);
        assert.equal(oauth.refreshes, 1);
        assert.ok(oauth.valid.has(readConfig().refresh_token));
    });

    it('saves the renewed session before a signal stops the process', async () => {
        oauth.delayMs = 500;
        const result = await refreshInChild({
            // Stopped while the server has spent the old token but not answered.
            onSpawn: (child) => {
                const poll = setInterval(() => {
                    if (oauth.refreshes) {
                        clearInterval(poll);
                        child.kill('SIGTERM');
                    }
                }, 10);
            },
        });
        assert.equal(result, 'SIGTERM');
        assert.equal(oauth.refreshes, 1);
        assert.ok(oauth.valid.has(readConfig().refresh_token));
    });

    it('takes over the lock of a process that died', async () => {
        const lock = refreshLockPath(new URL(baseURL).host);
        fs.writeFileSync(lock, '999999');
        const started = Date.now();
        await refreshToken();
        assert.ok(Date.now() - started < 2_000);
        assert.ok(!fs.existsSync(lock));
    });

    it('says the session expired only when the server rejects the refresh', async () => {
        oauth.valid.clear();
        await assert.rejects(refreshToken(), (e) => {
            assert.equal(e.code, 'unauthorized');
            assert.match(e.message, /^Session expired \(server: invalid refresh token\)/);
            return true;
        });
    });

    it('keeps the session when the server fails or cannot be reached', async () => {
        const saved = readConfig().refresh_token;
        oauth.override = (req, res) => {
            if (req.url !== '/oauth/token') return false;
            res.writeHead(503);
            res.end();
            return true;
        };
        await assert.rejects(refreshToken(), (e) => {
            assert.equal(e.code, 'server_error');
            assert.match(e.message, /^Could not renew the session: Server error: 503/);
            return true;
        });
        assert.equal(readConfig().refresh_token, saved);
        // Once the server is back, the same session renews.
        oauth.override = null;
        await refreshToken();
    });

    it('uses the session another process saved when its token was spent meanwhile', async () => {
        // An older CLI, without the lock, renews while this request travels.
        oauth.override = (req) => {
            if (req.url !== '/oauth/token') return false;
            const config = readConfig();
            oauth.valid.delete(config.refresh_token);
            writeConfig({ ...config, token: jwt(7200, 'other'), refresh_token: issue() });
            return false;
        };
        const token = await refreshToken();
        assert.equal(token, readConfig().token);
        assert.match(Buffer.from(token.split('.')[1], 'base64url').toString(), /"tag":"other"/);
    });

    it('retries a rejected request with the session another process renewed', async () => {
        const old = readConfig().token;
        writeConfig({ ...readConfig(), token: jwt(7200) });
        const res = await api.get('/v1/users/ana', {
            baseURL,
            headers: { Authorization: `Bearer ${old}` },
        });
        assert.deepEqual(res.data, { ok: true });
        assert.equal(oauth.refreshes, 0);
    });

    describe('of a profile and those that take its credentials', () => {
        const host = () => new URL(baseURL).host;
        beforeEach(() => {
            addImpersonatingProfile('monitoring', {
                credentialsFrom: host(),
                impersonate: 'monitoring',
            });
        });

        it('is one renewal in a process, saved where the credentials live', async () => {
            oauth.delayMs = 100;
            const tokens = await Promise.all([
                withActiveProfile(host(), () => refreshToken()),
                withActiveProfile('monitoring', () => refreshToken()),
            ]);
            assert.equal(oauth.refreshes, 1);
            assert.equal(tokens[0], tokens[1]);
            assert.equal(getProfile(host()).token, tokens[0]);
            assert.ok(oauth.valid.has(getProfile(host()).refresh_token));
            assert.deepEqual(getProfile('monitoring'), {
                credentials_from: host(),
                impersonate: 'monitoring',
            });
        });

        it('takes turns across processes on the same lock', async () => {
            oauth.delayMs = 300;
            const results = await Promise.all([
                refreshInChild({ profile: 'monitoring' }),
                refreshInChild({ profile: host() }),
                refreshInChild({ profile: 'monitoring' }),
            ]);
            assert.deepEqual(results, ['ok', 'ok', 'ok']);
            assert.equal(oauth.refreshes, 1);
            assert.ok(oauth.valid.has(getProfile(host()).refresh_token));
        });

        it('says to sign in the profile that holds them when the session is over', async () => {
            oauth.valid.clear();
            await assert.rejects(
                withActiveProfile('monitoring', () => refreshToken()),
                (e) => {
                    assert.equal(e.code, 'unauthorized');
                    assert.match(
                        e.message,
                        new RegExp(
                            `in profile ${host().replace(/\./g, '\\.')}\\. Run \`acme --profile ${host().replace(/\./g, '\\.')} login\``,
                        ),
                    );
                    return true;
                },
            );
        });
    });
});
