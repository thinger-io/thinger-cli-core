// Signing in with a token, and with a password on an account with a
// second factor.
import './setup.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { authenticate } from '../lib/auth.js';
import { deleteConfig, getProfile, setActiveProfile } from '../lib/config.js';
import { inChild, lib, oauthServer } from './oauth-server.js';

/** An unsigned JWT of account `usr`, as Thinger's API tokens are. */
function tokenOf(usr) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'HS256' })}.${part({ usr, jti: 'cli' })}.sig`;
}

let srv;
before(async () => {
    srv = await oauthServer();
});
after(() => srv.close());

const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
};

describe('a token login', () => {
    /** Status the server answers to reading the account's profile. */
    let profileStatus;
    beforeEach(() => {
        deleteConfig();
        srv.reset();
        profileStatus = 200;
        srv.route = (req, res) =>
            /\/v1\/users\/[^/]+\/profile$/.test(req.url ?? '')
                ? json(res, profileStatus, profileStatus === 200 ? { name: 'x' } : {})
                : false;
        setActiveProfile('acme');
    });

    const login = (opts) => authenticate({ method: 'token', server: srv.baseURL, ...opts });

    it('reads the account from the token', async () => {
        await login({ token: tokenOf('ana') });
        assert.equal(getProfile('acme').username, 'ana');
    });

    it('refuses a token of another account than the one named', async () => {
        await assert.rejects(
            login({ token: tokenOf('ana'), username: 'bob' }),
            /of account ana, not bob/,
        );
        assert.equal(getProfile('acme'), undefined);
    });

    it('keeps a token scoped away from the profile only when it is of that account', async () => {
        profileStatus = 403;
        await login({ token: tokenOf('ana'), username: 'ana' });
        assert.equal(getProfile('acme').username, 'ana');

        deleteConfig();
        await assert.rejects(
            login({ token: 'opaque', username: 'ana' }),
            /cannot read the profile of ana, and does not say whose it is/,
        );
        assert.equal(getProfile('acme'), undefined);
    });

    it('refuses a token the server does not take', async () => {
        profileStatus = 401;
        await assert.rejects(login({ token: tokenOf('ana') }), /Invalid token/);
    });
});

describe('a password login', () => {
    beforeEach(() => {
        deleteConfig();
        srv.reset();
    });

    /** Sign in as ana in another process, prompts answered: password, then `otp`. */
    async function login(otp = '123456') {
        const prompts = `export const password = async () => 'secret';
            export const input = async () => ${JSON.stringify(otp)};
            export const select = async () => 'x';`;
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
            cfg.setActiveProfile('acme');
            await authenticate({ method: 'userpass', server: ${JSON.stringify(srv.baseURL)}, username: 'ana' })
                .then(() => console.log('signed in'), (e) => console.log('failed: ' + e.message));
        `);
        return child.out;
    }

    /** The server asks for a second factor of the kinds `methods`. */
    function mfaServer(methods) {
        const seen = [];
        srv.route = (req, res, body) => {
            const form = new URLSearchParams(body);
            if (req.url === '/oauth/token' && form.get('grant_type') === 'password') {
                seen.push('password');
                return json(res, 403, {
                    error: 'mfa_required',
                    mfa_token: 'MT',
                    mfa_methods: methods,
                });
            }
            if (req.url === '/oauth/token' && form.get('grant_type') === 'mfa-otp') {
                seen.push(
                    `otp ${form.get('otp')} ${form.get('mfa_token')} ${form.get('password')}`,
                );
                return ['123456', 'ABCD2345'].includes(form.get('otp') ?? '')
                    ? json(res, 200, { access_token: 'session' })
                    : json(res, 401, { error: { message: 'invalid otp code' } });
            }
            if (req.method === 'POST' && req.url === '/v1/users/ana/tokens') {
                seen.push('token');
                return json(res, 200, { access_token: 'perm' });
            }
            return false;
        };
        return seen;
    }

    it('asks for the code of the authenticator app when the account has one', async () => {
        const seen = mfaServer(['totp', 'webauthn']);
        const out = await login();
        assert.match(out, /signed in/, out);
        assert.deepEqual(seen, ['password', 'otp 123456 MT secret', 'token']);
        assert.equal(getProfile('acme').token, 'perm');
    });

    it('takes a backup code as the server wrote it', async () => {
        const seen = mfaServer(['totp']);
        const out = await login('abcd2345');
        assert.match(out, /signed in/, out);
        assert.equal(seen[1], 'otp ABCD2345 MT secret');
    });

    it('says when the code is wrong, and saves nothing', async () => {
        mfaServer(['totp']);
        const out = await login('000000');
        assert.match(out, /failed: The code was not accepted: invalid otp code/, out);
        assert.equal(getProfile('acme'), undefined);
    });

    it('offers the browser login to an account with a security key only', async () => {
        const seen = mfaServer(['webauthn']);
        const out = await login();
        assert.match(
            out,
            /failed: ana signs in with a security key, which only the browser can use: acme login --oauth/,
            out,
        );
        assert.deepEqual(seen, ['password']);
    });

    it('says why the server refuses a password sign-in', async () => {
        srv.route = (req, res) =>
            req.url === '/oauth/token'
                ? json(res, 403, { error: { message: 'password authentication is not enabled' } })
                : false;
        const out = await login();
        assert.match(
            out,
            /failed: password authentication is not enabled\. Sign in through the browser instead: acme login --oauth/,
            out,
        );
    });
});
