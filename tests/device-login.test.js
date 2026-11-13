// The browser login without a terminal: started by one call (a command,
// an MCP tool), approved by the user in the browser, finished by another
// call, possibly in another process. Nothing is saved until approved.
import { testIdentity } from './setup.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    addImpersonatingProfile,
    deleteConfig,
    deleteProfile,
    getActiveProfile,
    getPendingLogin,
    getProfile,
    setActiveProfile,
    setDefaultProfile,
    setPendingLogin,
    writeConfig,
} from '../lib/config.js';
import { checkDeviceLogin, startDeviceLogin, waitDeviceLogin } from '../lib/device-login.js';
import { buildTools } from '../lib/mcp/registry.js';
import { inChild, lib, oauthServer } from './oauth-server.js';

/** An unsigned JWT of account `usr`. */
function jwtOf(usr, seconds = 7200) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'HS256' })}.${part({ usr, exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

let srv;
/** What the device flow of the test server does, and saw. */
let dev;

before(async () => {
    srv = await oauthServer();
});
after(() => srv.close());

function deviceServer() {
    dev = {
        state: 'pending',
        user: 'ana',
        interval: 0.05,
        codes: 0,
        checks: 0,
        exchanged: 0,
        /** Authorization headers of the login's requests. */
        auth: [],
        deleted: [],
    };
    srv.reset();
    srv.route = (req, res, body) => {
        const json = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        };
        if (req.url === '/oauth/device/authorize') {
            dev.auth.push(req.headers.authorization ?? null);
            dev.codes++;
            const code = `CODE-${dev.codes}`;
            return json(200, {
                device_code: `DC-${dev.codes}`,
                user_code: code,
                verification_uri: `${srv.baseURL}/activate`,
                verification_uri_complete: `${srv.baseURL}/activate?user_code=${code}`,
                interval: dev.interval,
                expires_in: 600,
            });
        }
        if (req.url === '/oauth/token' && body.includes('device_code')) {
            dev.auth.push(req.headers.authorization ?? null);
            dev.checks++;
            if (dev.state === 'approved') {
                // The session is handed out once.
                if (dev.exchanged++) return json(400, { error: 'expired_token' });
                return json(200, { access_token: jwtOf(dev.user), refresh_token: 'R-new' });
            }
            const error = {
                pending: 'authorization_pending',
                denied: 'access_denied',
                slow_down: 'slow_down',
                expired: 'expired_token',
            }[dev.state];
            return json(400, { error });
        }
        if (req.method === 'DELETE') {
            dev.deleted.push(req.url);
            return json(200, {});
        }
        return false;
    };
}

/** Let the next check reach the server now. */
function checkNow(name) {
    const p = getPendingLogin(name);
    if (p) setPendingLogin(name, { ...p, last_check: 0 });
}

beforeEach(() => {
    deleteConfig();
    setActiveProfile(null);
    deviceServer();
    // The default profile: its session must never reach the login's server.
    setActiveProfile('home');
    writeConfig({ server: 'http://home.invalid', username: 'me', token: 'T-home' });
    setActiveProfile(null);
});

describe('a browser login without a terminal', () => {
    it('saves nothing until approved, then the profile with its session', async () => {
        const started = await startDeviceLogin('acme', {
            server: srv.baseURL,
            clientId: 'cli',
            description: 'Admin of acme',
            create: true,
        });
        assert.equal(started.status, 'pending');
        assert.equal(started.url, `${srv.baseURL}/activate?user_code=CODE-1`);
        assert.equal(started.code, 'CODE-1');
        assert.equal(getProfile('acme'), undefined);

        assert.equal((await checkDeviceLogin('acme')).status, 'pending');
        assert.equal(getProfile('acme'), undefined);

        dev.state = 'approved';
        checkNow('acme');
        const done = await checkDeviceLogin('acme');
        assert.equal(done.status, 'approved');
        assert.equal(done.username, 'ana');
        const saved = getProfile('acme');
        assert.equal(saved.server, srv.baseURL);
        assert.equal(saved.username, 'ana');
        assert.equal(saved.refresh_token, 'R-new');
        assert.equal(saved.oauth_client_id, 'cli');
        assert.equal(saved.description, 'Admin of acme');
        // The default stays what it was.
        assert.equal(getActiveProfile(), 'home');
        // No session of another profile went to the server.
        assert.deepEqual(dev.auth, [null, null, null]);

        // Asked again, it says how it ended without another exchange.
        assert.equal((await checkDeviceLogin('acme')).status, 'approved');
        assert.equal(dev.exchanged, 1);
    });

    it('becomes the default once approved only when asked to', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli', activate: true });
        dev.state = 'approved';
        assert.equal((await waitDeviceLogin('acme')).status, 'approved');
        assert.equal(getActiveProfile(), 'acme');
    });

    it('does not reach the server sooner than it asks, and slows down when told', async () => {
        dev.interval = 30;
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        assert.equal((await checkDeviceLogin('acme')).status, 'pending');
        const early = await checkDeviceLogin('acme');
        assert.equal(early.status, 'pending');
        assert.ok(early.retry_after > 0 && early.retry_after <= 30);
        assert.equal(dev.checks, 1);

        dev.state = 'slow_down';
        checkNow('acme');
        const slower = await checkDeviceLogin('acme');
        assert.equal(slower.retry_after, 35);
        assert.equal(getPendingLogin('acme').interval, 35);
    });

    it('says when the user refused it, or the code expired, and saves nothing', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        dev.state = 'denied';
        assert.equal((await checkDeviceLogin('acme')).status, 'denied');
        assert.equal(getProfile('acme'), undefined);

        await startDeviceLogin('other', { server: srv.baseURL, clientId: 'cli' });
        setPendingLogin('other', { ...getPendingLogin('other'), expires_at: Date.now() - 1 });
        assert.equal((await checkDeviceLogin('other')).status, 'expired');
        assert.equal(getProfile('other'), undefined);
    });

    it('keeps a check that cannot reach the server pending', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        setPendingLogin('acme', { ...getPendingLogin('acme'), server: 'http://127.0.0.1:9' });
        const state = await checkDeviceLogin('acme');
        assert.equal(state.status, 'pending');
        assert.match(state.warning, /Could not reach/);
    });

    it('takes the session once when two processes check it at the same time', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        dev.state = 'approved';
        const check = () =>
            inChild(`
                const { checkDeviceLogin } = await import(${JSON.stringify(path.join(lib, 'device-login.js'))});
                console.log('status ' + (await checkDeviceLogin('acme')).status);
            `);
        const results = await Promise.all([check(), check(), check()]);
        for (const r of results) assert.match(r.out, /status approved/, r.out);
        assert.equal(dev.exchanged, 1);
        assert.equal(getProfile('acme').refresh_token, 'R-new');
    });

    it('signs an existing profile in again: keeps its description, revokes its old CLI token', async () => {
        setActiveProfile('acme');
        writeConfig({
            server: srv.baseURL,
            username: 'ana',
            token: 'T-old',
            token_id: 'acme_cli_old',
            description: 'Admin of acme',
        });
        setActiveProfile(null);
        await startDeviceLogin('acme', { clientId: 'cli' });
        // Still signed in with the old session meanwhile.
        assert.equal(getProfile('acme').token, 'T-old');
        dev.state = 'approved';
        await waitDeviceLogin('acme');
        const saved = getProfile('acme');
        assert.equal(saved.description, 'Admin of acme');
        assert.equal(saved.refresh_token, 'R-new');
        assert.equal(saved.token_id, undefined);
        assert.deepEqual(dev.deleted, ['/v1/users/ana/tokens/acme_cli_old']);
    });

    it('refuses a profile that acts as another account, and one that exists when adding', async () => {
        setActiveProfile('admin');
        writeConfig({ server: srv.baseURL, username: 'root', token: 'T-root' });
        setActiveProfile(null);
        addImpersonatingProfile('monitoring', {
            credentialsFrom: 'admin',
            impersonate: 'monitoring',
        });
        await assert.rejects(
            startDeviceLogin('monitoring', { clientId: 'cli' }),
            /uses the session of profile admin: sign that one in/,
        );
        await assert.rejects(
            startDeviceLogin('admin', { clientId: 'cli', create: true }),
            /already exists/,
        );
        await assert.rejects(startDeviceLogin('new', { clientId: 'cli' }), /pass its server/);
        assert.equal(dev.codes, 0);
    });

    it('leaves a profile made meanwhile as it is, and says why the login was not saved', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli', create: true });
        setActiveProfile('acme');
        writeConfig({
            server: 'http://b.invalid',
            username: 'ana',
            token: 'T-b',
            token_id: 'tid_B',
        });
        setActiveProfile(null);
        dev.state = 'approved';
        const state = await checkDeviceLogin('acme');
        assert.equal(state.status, 'failed');
        assert.match(state.error, /was made meanwhile/);
        assert.equal(getProfile('acme').server, 'http://b.invalid');
        assert.deepEqual(dev.deleted, []);
        // Asked again, the same answer, not "expired".
        assert.equal((await checkDeviceLogin('acme')).status, 'failed');
    });

    it('does not sign a profile in again as another account', async () => {
        setActiveProfile('acme');
        writeConfig({ server: srv.baseURL, username: 'ana', token: 'T-ana' });
        setActiveProfile(null);
        await startDeviceLogin('acme', { clientId: 'cli' });
        dev.state = 'approved';
        dev.user = 'eve';
        const state = await checkDeviceLogin('acme');
        assert.equal(state.status, 'failed');
        assert.match(state.error, /approved as eve, but profile acme is of ana/);
        assert.equal(getProfile('acme').token, 'T-ana');
    });

    it('is forgotten when its profile is deleted, so an approval does not bring it back', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        deleteProfile('acme');
        dev.state = 'approved';
        assert.equal((await checkDeviceLogin('acme')).status, 'none');
        assert.equal(getProfile('acme'), undefined);
        assert.equal(dev.exchanged, 0);
    });

    it('started again while a check is in flight, keeps the new code', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        const slow = srv.route;
        let release;
        const held = new Promise((r) => (release = r));
        srv.route = (req, res, body) => {
            if (req.url === '/oauth/token' && body.includes('DC-1')) {
                // The check of code 1 waits until code 2 is asked for, then is refused.
                held.then(() => {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'access_denied' }));
                });
                return true;
            }
            return slow(req, res, body);
        };
        const check = checkDeviceLogin('acme');
        const restart = startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        await new Promise((r) => setTimeout(r, 100));
        release();
        await check;
        const second = await restart;
        assert.equal(second.code, 'CODE-2');
        assert.equal(getPendingLogin('acme').device_code, 'DC-2');
        assert.equal(getPendingLogin('acme').status, 'pending');
    });

    it('waits until approved, or gives up after the time given', async () => {
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        assert.equal((await waitDeviceLogin('acme', { timeoutMs: 0 })).status, 'pending');
        setTimeout(() => (dev.state = 'approved'), 150);
        assert.equal((await waitDeviceLogin('acme', { timeoutMs: 5000 })).status, 'approved');
    });
});

describe('the login command without a terminal', () => {
    /** Run the CLI in another process, stdin not a terminal. */
    const cli = (...args) =>
        inChild(`
            const { runCli } = await import(${JSON.stringify(path.join(lib, 'cli.js'))});
            await runCli({ version: '0.0.0', argv: ['node', 'acme', ...${JSON.stringify(args)}] });
        `);

    it('starts the browser login, and finishes it with --wait once approved', async () => {
        const start = await cli(
            'profile',
            'add',
            'acme',
            '--server',
            srv.baseURL,
            '--oauth',
            '--client-id',
            'cli',
            '--no-activate',
            '-d',
            'Admin of acme',
        );
        assert.equal(start.code, 0, start.out);
        assert.match(start.out, /activate\?user_code=CODE-1/);
        assert.match(start.out, /acme --profile acme login --wait/);
        assert.equal(getProfile('acme'), undefined);

        const early = await cli('--profile', 'acme', 'login', '--wait', '--timeout', '0', '-j');
        // 2: not approved yet, run it again.
        assert.equal(early.code, 2, early.out);
        assert.match(early.out, /"code": "pending"/);

        dev.state = 'approved';
        checkNow('acme');
        const done = await cli('--profile', 'acme', 'login', '--wait');
        assert.equal(done.code, 0, done.out);
        assert.match(done.out, /Signed in as ana \(profile acme\)/);
        assert.equal(getProfile('acme').description, 'Admin of acme');
        assert.equal(getActiveProfile(), 'home');
    });

    it('asks for the server when there is no profile to sign in', async () => {
        deleteConfig();
        const r = await cli('login', '--oauth', '--client-id', 'cli');
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /Pass the server to sign in to \(--server <server>\)/);
    });

    it('says how to start one when there is none to wait for', async () => {
        const r = await cli('--profile', 'acme', 'login', '--wait');
        assert.notEqual(r.code, 0);
        assert.match(
            r.out,
            /No browser login under way for profile acme: start one with acme --profile acme login --oauth --no-wait/,
        );
    });

    it('says on logout that the server keeps a browser session until it lapses', async () => {
        setActiveProfile('acme');
        writeConfig({ server: srv.baseURL, username: 'ana', token: 'T', refresh_token: 'R' });
        setActiveProfile(null);
        const r = await cli('--profile', 'acme', 'logout');
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /browser session of acme is forgotten here; the server keeps it valid/);
        assert.equal(getProfile('acme'), undefined);
    });

    it('asks for no password: without --oauth or a token it says how to sign in', async () => {
        const r = await cli('profile', 'add', 'acme', '--server', srv.baseURL);
        assert.notEqual(r.code, 0);
        assert.match(r.out, /needs an interactive terminal.*login --oauth --server <server>/s);
    });
});

describe('the profile type of the MCP server', () => {
    const tools = buildTools();
    const byName = Object.fromEntries(
        tools.map((t) => [t.name.replace(`${testIdentity.mcp.toolPrefix}_`, ''), t]),
    );
    const call = async (tool, args) => {
        const result = await byName[tool].handler(args, {});
        const text = result.content.map((c) => c.text).join('\n');
        if (result.isError) throw new Error(text);
        // A record answered after a line or two saying what was done.
        const at = text.search(/^[{[]/m);
        try {
            return JSON.parse(at >= 0 ? text.slice(at) : text);
        } catch {
            return text;
        }
    };

    it('starts a sign-in with a link for the user, and saves it on status once approved', async () => {
        const started = await call('resource_call', {
            type: 'profile',
            action: 'login',
            ids: { profile: 'acme' },
            body: { server: srv.baseURL, client_id: 'cli', description: 'Admin of acme' },
        });
        assert.equal(started.status, 'pending');
        assert.equal(started.url, `${srv.baseURL}/activate?user_code=CODE-1`);
        assert.match(started.next, /Give the user this link/);

        const listed = await call('resource_list', { type: 'profile' });
        const text = JSON.stringify(listed);
        assert.match(text, /CODE-1/);
        assert.doesNotMatch(text, /DC-1|T-home/);

        dev.state = 'approved';
        checkNow('acme');
        const done = await call('resource_call', {
            type: 'profile',
            action: 'status',
            ids: { profile: 'acme' },
        });
        assert.equal(done.status, 'approved');
        assert.equal(getProfile('acme').username, 'ana');
        assert.equal(getActiveProfile(), 'home');
    });

    it('never takes a password or a token', async () => {
        for (const body of [
            { server: srv.baseURL, password: 'secret' },
            { server: srv.baseURL, token: 'T' },
            { server: srv.baseURL, username: 'ana' },
        ]) {
            await assert.rejects(
                call('resource_call', {
                    type: 'profile',
                    action: 'login',
                    ids: { profile: 'x' },
                    body,
                }),
                /has no "(password|token|username)"/,
            );
        }
        await assert.rejects(
            call('resource_create', {
                type: 'profile',
                ids: { profile: 'x' },
                body: { server: srv.baseURL, token: 'T' },
            }),
            /has no "(server|token)"/,
        );
        assert.equal(dev.codes, 0);
    });

    it('does not move an existing profile to another server', async () => {
        await assert.rejects(
            call('resource_call', {
                type: 'profile',
                action: 'login',
                ids: { profile: 'home' },
                body: { server: srv.baseURL, client_id: 'cli' },
            }),
            /Profile home is of http:\/\/home.invalid/,
        );
    });

    it('adds a profile acting as another account, and changes descriptions', async () => {
        const made = await call('resource_create', {
            type: 'profile',
            ids: { profile: 'monitoring' },
            body: {
                credentials_from: 'home',
                impersonate: 'monitoring',
                description: 'Monitored servers',
            },
        });
        assert.equal(made.impersonate, 'monitoring');
        assert.equal(made.credentials_from, 'home');
        assert.equal(made.description, 'Monitored servers');
        assert.equal(getProfile('monitoring').token, undefined);

        const updated = await call('resource_update', {
            type: 'profile',
            ids: { profile: 'home' },
            body: { description: 'My own account' },
        });
        assert.equal(updated.description, 'My own account');
        await assert.rejects(
            call('resource_update', {
                type: 'profile',
                ids: { profile: 'home' },
                body: { credentials_from: 'x' },
            }),
            /description only/,
        );
        await assert.rejects(
            call('resource_create', {
                type: 'profile',
                ids: { profile: 'y' },
                body: { description: 'no credentials' },
            }),
            /action "login"/,
        );
    });
});

describe('setting the default', () => {
    it('is not taken by a profile added while there is none on purpose', async () => {
        for (const name of ['a', 'b']) {
            setActiveProfile(name);
            writeConfig({ server: srv.baseURL, username: name, token: `T-${name}` });
        }
        setActiveProfile(null);
        deleteProfile('home');
        assert.equal(getActiveProfile(), null);
        addImpersonatingProfile('mon', { credentialsFrom: 'a', impersonate: 'zed' });
        assert.equal(getActiveProfile(), null);
        await startDeviceLogin('c', { server: srv.baseURL, clientId: 'cli' });
        dev.state = 'approved';
        assert.equal((await checkDeviceLogin('c')).status, 'approved');
        assert.equal(getActiveProfile(), null);
    });

    it('is untouched by a pending login', async () => {
        setDefaultProfile('home');
        await startDeviceLogin('acme', { server: srv.baseURL, clientId: 'cli' });
        assert.equal(getActiveProfile(), 'home');
    });
});
