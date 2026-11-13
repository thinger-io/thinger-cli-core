// Test helpers: a server that renews sessions as Thinger does, and a way
// to run code in another process of the CLI sharing the same config.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testIdentity } from './setup.js';

export const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/** An unsigned JWT access token that expires in `seconds`. */
export function jwt(seconds, tag = Math.random().toString(36).slice(2)) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + seconds;
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ usr: 'ana', exp, tag })}.sig`;
}

/**
 * Each refresh token works once and the answer carries a new one; the
 * presented one is spent on arrival, then the answer waits `delayMs`.
 * Other requests are valid with any access token the server issued (or
 * `accept`), 401 otherwise. `onRefresh` and `route` let a test step in.
 */
export async function oauthServer() {
    const state = {
        valid: new Set(),
        issued: new Set(),
        refreshes: 0,
        delayMs: 0,
        /** @type {(() => void) | null} */
        onRefresh: null,
        /** @type {((req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean) | null} */
        route: null,
        issue() {
            const refresh = `rt-${Math.random().toString(36).slice(2)}`;
            state.valid.add(refresh);
            return refresh;
        },
        access(seconds = 7200) {
            const token = jwt(seconds);
            state.issued.add(token);
            return token;
        },
        reset() {
            state.valid.clear();
            state.issued.clear();
            state.refreshes = 0;
            state.delayMs = 0;
            state.onRefresh = null;
            state.route = null;
        },
        baseURL: '',
        close: () => {},
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
            if (state.route?.(req, res, body)) return;
            if (req.url === '/oauth/token') {
                const presented = new URLSearchParams(body).get('refresh_token');
                const spent = state.valid.delete(presented);
                const renewed = spent
                    ? { access_token: state.access(), refresh_token: state.issue() }
                    : null;
                state.refreshes++;
                state.onRefresh?.();
                await new Promise((r) => setTimeout(r, state.delayMs));
                res.writeHead(spent ? 200 : 401, { 'Content-Type': 'application/json' });
                return res.end(
                    JSON.stringify(renewed ?? { error: { message: 'invalid refresh token' } }),
                );
            }
            const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
            const ok = state.issued.has(token);
            res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { ok: true } : { error: { message: 'expired' } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    state.baseURL = `http://127.0.0.1:${server.address().port}`;
    state.close = () => {
        server.closeAllConnections();
        server.close();
    };
    return state;
}

/**
 * Run `body` (module code that may `await`) in another process of the CLI,
 * with `cfg`, `auth`, `api` and `output` imported from lib.
 *
 * @returns {Promise<{ code: number | null, signal: string | null, out: string }>}
 */
export function inChild(body, { env = {}, onSpawn } = {}) {
    const imp = (f) => JSON.stringify(path.join(lib, f));
    const code = `
        import { defineIdentity } from ${imp('identity.js')};
        defineIdentity(${JSON.stringify(testIdentity)});
        const cfg = await import(${imp('config.js')});
        const auth = await import(${imp('auth.js')});
        const api = (await import(${imp('api.js')})).default;
        const output = await import(${imp('output.js')});
        ${body}
    `;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, NODE_TEST_CONTEXT: '', ...env },
        });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        onSpawn?.(child);
        child.on('close', (code, signal) => resolve({ code, signal, out: out.trim() }));
    });
}
