// @ts-check
import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import api from '../lib/api.js';
import {
    TOKEN_ID_RE,
    createDeviceToken,
    createToken,
    deleteDeviceToken,
    deleteToken,
    getToken,
    listDeviceTokens,
    listTokens,
    resolveExpiry,
    updateToken,
    validatePermissionTree,
} from '../lib/tokens.js';

const USER = 'admin';

function setupBackend(initial = {}) {
    const state = new Map(Object.entries(initial));
    const calls = [];
    api.get = async (path) => {
        calls.push({ method: 'GET', path });
        if (state.has(path)) return { data: state.get(path) };
        const err = new Error('Not found');
        err.response = { status: 404 };
        throw err;
    };
    api.post = async (path, body) => {
        calls.push({ method: 'POST', path, body });
        // Mirror the server: POST to the collection URL stores the created
        // doc under <collection>/<id>, and the response includes the JWT.
        const id = body.token || body.token_name;
        const doc = {
            ...body,
            user: USER,
            access_token: 'fake-jwt-' + id,
            sign_key: 'sk',
            created: 1700000000000,
            modified: 1700000000000,
        };
        state.set(`${path}/${id}`, doc);
        return { data: doc };
    };
    api.put = async (path, body) => {
        calls.push({ method: 'PUT', path, body });
        const existing = state.get(path) || {};
        const next = { ...existing, ...body };
        state.set(path, next);
        return { data: next };
    };
    api.delete = async (path) => {
        calls.push({ method: 'DELETE', path });
        if (!state.has(path)) {
            const err = new Error('Not found');
            err.response = { status: 404 };
            throw err;
        }
        state.delete(path);
        return { data: { ok: true } };
    };
    return { state, calls };
}

// ─── Pure helpers ───────────────────────────────────────────────────

describe('TOKEN_ID_RE', () => {
    it('accepts up-to-50 char alphanumeric+underscore ids', () => {
        for (const id of ['a', 'admin_access', 'A1_b2', '_'.repeat(50)]) {
            assert.ok(TOKEN_ID_RE.test(id), `expected "${id}" accepted`);
        }
    });
    it('rejects bad ids', () => {
        for (const id of ['', '-', 'a-b', 'a'.repeat(51), 'has space', 'a.b']) {
            assert.equal(TOKEN_ID_RE.test(id), false, `expected "${id}" rejected`);
        }
    });
});

describe('resolveExpiry', () => {
    it('returns null for null/undefined/empty', () => {
        assert.equal(resolveExpiry(null), null);
        assert.equal(resolveExpiry(undefined), null);
        assert.equal(resolveExpiry(''), null);
    });

    it('returns numeric input unchanged', () => {
        assert.equal(resolveExpiry(1700000000), 1700000000);
    });

    it('parses integer-looking strings as unix seconds', () => {
        assert.equal(resolveExpiry('1700000000'), 1700000000);
    });

    it('converts relative durations to a future unix-seconds timestamp', () => {
        const now = Math.floor(Date.now() / 1000);
        const got = resolveExpiry('30d');
        assert.ok(got >= now + 30 * 24 * 3600 - 5);
        assert.ok(got <= now + 30 * 24 * 3600 + 5);
    });

    it('supports s/m/h/d/w/y units', () => {
        const now = Math.floor(Date.now() / 1000);
        const oneHour = resolveExpiry('1h');
        assert.ok(oneHour >= now + 3600 - 5 && oneHour <= now + 3600 + 5);
        const oneYear = resolveExpiry('1y');
        assert.ok(oneYear >= now + 365 * 86400 - 5);
    });

    it('rejects malformed durations', () => {
        // Strings that don't match either an integer-looking unix-seconds
        // value or a relative-duration pattern get rejected client-side.
        // Finite non-negative numbers ARE accepted (unix seconds), so they
        // are not part of this case.
        for (const v of ['foo', '30dd', '0d', '-1h', 'd', '12h30m']) {
            assert.throws(
                () => resolveExpiry(v),
                (err) => err.code === 'input_error',
                `expected "${v}" to be rejected`,
            );
        }
    });

    it('rejects negative numbers', () => {
        assert.throws(
            () => resolveExpiry(-1),
            (err) => err.code === 'input_error',
        );
    });
});

describe('validatePermissionTree', () => {
    it('accepts the admin example', () => {
        validatePermissionTree({ '*': { '*': '*' } });
    });

    it('accepts the shared example', () => {
        validatePermissionTree({
            Bucket: { mqtt_bucket: ['ReadBucket'] },
            Device: { '*': ['AccessDeviceResources'] },
        });
    });

    it('accepts undefined / null without complaint', () => {
        validatePermissionTree(undefined);
        validatePermissionTree(null);
    });

    it('rejects an array at the root', () => {
        assert.throws(
            () => validatePermissionTree([]),
            (err) => err.code === 'input_error',
        );
    });

    it('rejects an invalid resource type', () => {
        assert.throws(
            () => validatePermissionTree({ 'has space': { '*': '*' } }),
            (err) => err.code === 'input_error' && /invalid resource type/.test(err.message),
        );
    });

    it('rejects an invalid resource id', () => {
        assert.throws(
            () => validatePermissionTree({ Device: { 'bad id!': ['x'] } }),
            (err) => err.code === 'input_error' && /not a valid resource id/.test(err.message),
        );
    });

    it('rejects a non-array, non-string actions leaf', () => {
        assert.throws(
            () => validatePermissionTree({ Device: { '*': 42 } }),
            (err) => err.code === 'input_error',
        );
    });
});

// ─── HTTP-mocked: user-level tokens ────────────────────────────────

describe('user-level token CRUD', () => {
    let mock;
    beforeEach(() => {
        mock = setupBackend();
    });

    it('listTokens returns the array verbatim', async () => {
        setupBackend({ [`/v1/users/${USER}/tokens`]: [{ token: 'a' }, { token: 'b' }] });
        const list = await listTokens(USER);
        assert.deepEqual(list, [{ token: 'a' }, { token: 'b' }]);
    });

    it('listTokens returns [] when the server replies with a non-array', async () => {
        setupBackend({ [`/v1/users/${USER}/tokens`]: { not: 'array' } });
        const list = await listTokens(USER);
        assert.deepEqual(list, []);
    });

    it('createToken posts the right body and surfaces the JWT', async () => {
        const doc = await createToken(
            {
                token: 'backup_notifier',
                name: 'Backup Notifier',
                allow: { Device: { '*': ['AccessDeviceResources'] } },
                expire: '90d',
            },
            USER,
        );
        const post = mock.calls.find((c) => c.method === 'POST');
        assert.ok(post, 'expected POST call');
        assert.equal(post.path, `/v1/users/${USER}/tokens`);
        assert.equal(post.body.token, 'backup_notifier');
        assert.equal(post.body.name, 'Backup Notifier');
        assert.deepEqual(post.body.allow, { Device: { '*': ['AccessDeviceResources'] } });
        assert.equal(typeof post.body.expire, 'number');
        // Account tokens expire in unix milliseconds.
        assert.ok(post.body.expire > Date.now() + 89 * 24 * 3600 * 1000);
        assert.equal(doc.access_token, 'fake-jwt-backup_notifier');
    });

    it('createToken rejects an invalid token id before contacting the server', async () => {
        await assert.rejects(
            createToken({ token: 'bad-id', name: 'x', allow: {} }, USER),
            (err) => err.code === 'input_error' && /token_id/.test(err.message),
        );
    });

    it('createToken rejects a malformed permission tree', async () => {
        await assert.rejects(
            createToken({ token: 'tok', name: 'x', allow: 'no' }, USER),
            (err) => err.code === 'input_error',
        );
    });

    it('getToken reads a single doc', async () => {
        setupBackend({
            [`/v1/users/${USER}/tokens/foo`]: {
                token: 'foo',
                name: 'Foo',
                access_token: 'jwt-foo',
            },
        });
        const doc = await getToken('foo', USER);
        assert.equal(doc.access_token, 'jwt-foo');
    });

    it('updateToken patches with the accepted UPDATE_SCHEMA fields', async () => {
        setupBackend({ [`/v1/users/${USER}/tokens/foo`]: { token: 'foo' } });
        await updateToken('foo', { name: 'New', enabled: false }, USER);
        // We don't have direct visibility of the call here without the
        // outer mock; redo with capture:
        const captured = setupBackend({
            [`/v1/users/${USER}/tokens/foo`]: { token: 'foo' },
        });
        await updateToken('foo', { name: 'New', enabled: false }, USER);
        const put = captured.calls.find((c) => c.method === 'PUT');
        assert.ok(put);
        assert.deepEqual(put.body, { name: 'New', enabled: false });
    });

    it('updateToken rejects an empty patch', async () => {
        setupBackend({ [`/v1/users/${USER}/tokens/foo`]: { token: 'foo' } });
        await assert.rejects(
            updateToken('foo', {}, USER),
            (err) => err.code === 'input_error' && /at least one of/.test(err.message),
        );
    });

    it('deleteToken returns true on success, false on 404', async () => {
        setupBackend({ [`/v1/users/${USER}/tokens/foo`]: {} });
        assert.equal(await deleteToken('foo', USER), true);
        assert.equal(await deleteToken('foo', USER), false);
    });
});

// ─── HTTP-mocked: device-level tokens ──────────────────────────────

describe('device-level token CRUD', () => {
    it('createDeviceToken sends token_name + optional resources/expiration', async () => {
        const mock = setupBackend();
        await createDeviceToken(
            'd1',
            { token_name: 'ops', token_resources: ['m', 'r'], token_expiration: '24h' },
            USER,
        );
        const post = mock.calls.find((c) => c.method === 'POST');
        assert.equal(post.path, `/v1/users/${USER}/devices/d1/tokens`);
        assert.equal(post.body.token_name, 'ops');
        assert.deepEqual(post.body.token_resources, ['m', 'r']);
        assert.equal(typeof post.body.token_expiration, 'number');
    });

    it('createDeviceToken omits optional fields when not supplied', async () => {
        const mock = setupBackend();
        await createDeviceToken('d1', { token_name: 'ops' }, USER);
        const post = mock.calls.find((c) => c.method === 'POST');
        assert.deepEqual(Object.keys(post.body), ['token_name']);
    });

    it('createDeviceToken rejects non-array token_resources', async () => {
        setupBackend();
        await assert.rejects(
            createDeviceToken('d1', { token_name: 't', token_resources: 'no' }, USER),
            (err) => err.code === 'input_error',
        );
    });

    it('listDeviceTokens / deleteDeviceToken go through the right URLs', async () => {
        const mock = setupBackend({
            [`/v1/users/${USER}/devices/d1/tokens`]: [{ token_id: 't1' }],
            [`/v1/users/${USER}/devices/d1/tokens/t1`]: {},
        });
        const list = await listDeviceTokens('d1', USER);
        assert.deepEqual(list, [{ token_id: 't1' }]);
        assert.equal(await deleteDeviceToken('d1', 't1', USER), true);
        assert.equal(await deleteDeviceToken('d1', 't1', USER), false);
        const del = mock.calls.find((c) => c.method === 'DELETE');
        assert.equal(del.path, `/v1/users/${USER}/devices/d1/tokens/t1`);
    });
});
