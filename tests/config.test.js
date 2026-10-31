import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    deleteConfig,
    getActiveProfile,
    getProfile,
    profileNameFor,
    readConfig,
    serverURL,
    serverWebSocketURL,
    setActiveProfile,
    withActiveProfile,
    writeConfig,
} from '../lib/config.js';
import api from '../lib/api.js';
import { authenticate } from '../lib/auth.js';

const CONFIG = () => path.join(os.homedir(), '.config', 'acme-cli', 'config.json');

function seed() {
    setActiveProfile('prod');
    writeConfig({ server: 'prod.example.com', username: 'alice', token: 'T-prod' });
    setActiveProfile('lab');
    writeConfig({ server: 'http://localhost:8080', username: 'bob', token: 'T-lab' });
    setActiveProfile(null);
}

describe('profiles', () => {
    beforeEach(() => {
        deleteConfig();
        setActiveProfile(null);
        delete process.env.ACME_PROFILE;
        seed();
    });

    it('live under the identity folder, readable by the owner only', () => {
        assert.ok(fs.existsSync(CONFIG()));
        assert.equal(fs.statSync(CONFIG()).mode & 0o777, 0o600);
        assert.deepEqual(fs.readdirSync(path.join(os.homedir(), '.config')), ['acme-cli']);
    });

    it('take group and other permissions away from a file made by an older version', () => {
        const dir = path.dirname(CONFIG());
        fs.chmodSync(CONFIG(), 0o644);
        fs.chmodSync(dir, 0o755);
        setActiveProfile('lab');
        writeConfig({ server: 'http://localhost:8080', username: 'bob', token: 'T-lab2' });
        assert.equal(fs.statSync(CONFIG()).mode & 0o777, 0o600);
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
        assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    });

    it('fix those permissions on a plain read too', () => {
        fs.chmodSync(CONFIG(), 0o644);
        readConfig();
        assert.equal(fs.statSync(CONFIG()).mode & 0o777, 0o600);
    });

    it('default to the first one written', () => {
        assert.equal(getActiveProfile(), 'prod');
        assert.equal(readConfig().username, 'alice');
    });

    it('honour <PREFIX>_PROFILE, and only that prefix', () => {
        process.env.OTHER_PROFILE = 'lab';
        assert.equal(getActiveProfile(), 'prod');
        process.env.ACME_PROFILE = 'lab';
        assert.equal(getActiveProfile(), 'lab');
        delete process.env.OTHER_PROFILE;
    });

    it('scope a profile to one async call chain without leaking into another', async () => {
        const seen = await Promise.all([
            withActiveProfile('lab', async () => {
                await new Promise((r) => setTimeout(r, 10));
                return readConfig().username;
            }),
            withActiveProfile('prod', async () => readConfig().username),
            (async () => {
                await new Promise((r) => setTimeout(r, 5));
                return readConfig().username;
            })(),
        ]);
        assert.deepEqual(seen, ['bob', 'alice', 'alice']);
        assert.equal(getActiveProfile(), 'prod');
    });
});

describe('profile names', () => {
    it('default to the host of the server, without scheme', () => {
        assert.equal(profileNameFor('acme.aws.thinger.io'), 'acme.aws.thinger.io');
        assert.equal(profileNameFor('http://localhost:8080'), 'localhost:8080');
        assert.equal(profileNameFor(undefined), null);
    });
});

describe('server URLs', () => {
    it('default to https for a bare host and keep an explicit scheme', () => {
        assert.equal(serverURL('acme.aws.thinger.io'), 'https://acme.aws.thinger.io');
        assert.equal(serverURL('http://localhost:8080/'), 'http://localhost:8080');
        assert.equal(serverURL(undefined), undefined);
    });

    it('map to ws:// or wss:// for WebSockets', () => {
        assert.equal(serverWebSocketURL('acme.aws.thinger.io'), 'wss://acme.aws.thinger.io');
        assert.equal(serverWebSocketURL('http://localhost:8080'), 'ws://localhost:8080');
    });
});

describe('api requests', () => {
    // Run the request interceptor the way axios would, without a network.
    const intercept = (config) =>
        api.interceptors.request.handlers[0].fulfilled({ headers: {}, ...config });

    beforeEach(() => {
        deleteConfig();
        setActiveProfile(null);
        seed();
    });

    it('take server and token from the profile active for the call', async () => {
        const prod = await intercept({ url: '/v1/users/alice/devices' });
        assert.equal(prod.baseURL, 'https://prod.example.com');
        assert.equal(prod.headers.Authorization, 'Bearer T-prod');

        const lab = await withActiveProfile('lab', () =>
            intercept({ url: '/v1/users/bob/devices' }),
        );
        assert.equal(lab.baseURL, 'http://localhost:8080');
        assert.equal(lab.headers.Authorization, 'Bearer T-lab');
    });

    it('keep an Authorization header the caller set (token probes at login)', async () => {
        const req = await intercept({ url: '/x', headers: { Authorization: 'Bearer probe' } });
        assert.equal(req.headers.Authorization, 'Bearer probe');
    });
});

describe('login', () => {
    beforeEach(() => {
        deleteConfig();
        setActiveProfile(null);
        seed();
    });

    /** Answer every request with `status`. */
    async function withServer(status, fn) {
        const saved = api.defaults.adapter;
        api.defaults.adapter = async (config) => {
            const response = { data: {}, status, statusText: '', headers: {}, config };
            if (status < 300) return response;
            throw Object.assign(new Error(`status ${status}`), { response, config });
        };
        try {
            return await fn();
        } finally {
            api.defaults.adapter = saved;
        }
    }

    it('keeps the current profile when the new credentials are refused', async () => {
        setActiveProfile('prod');
        const login = () =>
            authenticate({
                method: 'token',
                server: 'prod.example.com',
                username: 'alice',
                token: 'wrong',
            });
        await withServer(401, () => assert.rejects(login, /Invalid token/));
        setActiveProfile(null);
        const prod = await withActiveProfile('prod', () => readConfig());
        assert.deepEqual(prod, { server: 'prod.example.com', username: 'alice', token: 'T-prod' });
    });

    it('leaves no half-made profile behind for a new server', async () => {
        setActiveProfile(null);
        const login = () =>
            authenticate({
                method: 'token',
                server: 'new.example.com',
                username: 'carol',
                token: 'wrong',
            });
        await withServer(401, () => assert.rejects(login));
        setActiveProfile(null);
        assert.equal(getProfile('new.example.com'), undefined);
        assert.equal(getActiveProfile(), 'prod');
    });

    it('says when the server does not know the OAuth client, and keeps the profile', async () => {
        setActiveProfile('prod');
        const login = () =>
            authenticate({ method: 'oauth', server: 'old.example.com', clientId: 'cli' });
        await withServer(401, () => assert.rejects(login, /does not know the OAuth client cli/));
        setActiveProfile(null);
        assert.equal(getProfile('old.example.com'), undefined);
        assert.equal(getActiveProfile(), 'prod');
    });

    it('saves the profile when the token is accepted', async () => {
        setActiveProfile('prod');
        await withServer(200, () =>
            authenticate({
                method: 'token',
                server: 'prod.example.com',
                username: 'alice',
                token: 'T-new',
            }),
        );
        setActiveProfile(null);
        assert.equal(getProfile('prod').token, 'T-new');
    });
});
