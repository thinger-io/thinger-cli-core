import { testIdentity } from './setup.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteConfig, getProfile, setActiveProfile, writeConfig } from '../lib/config.js';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

// A server whose OAuth device flow is never approved; it tells the test
// when the login has asked for its code.
let server;
let baseURL;
let onDeviceCode = () => {};

before(async () => {
    server = http.createServer((req, _res) => {
        req.resume();
        req.on('end', () => {
            if (req.url === '/oauth/device/authorize') onDeviceCode();
            // Never answered: the user has not approved it yet.
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections();
    server.close();
});

describe('login', () => {
    it('keeps the saved profile when the process is killed half-way', async () => {
        deleteConfig();
        const saved = {
            server: baseURL,
            username: 'monitoring',
            token: 'T-saved',
            refresh_token: 'R-saved',
            oauth_client_id: 'cli',
        };
        setActiveProfile('monitoring');
        writeConfig(saved);
        setActiveProfile(null);

        const code = `
            import { defineIdentity } from ${JSON.stringify(path.join(lib, 'identity.js'))};
            defineIdentity(${JSON.stringify(testIdentity)});
            const { setActiveProfile } = await import(${JSON.stringify(path.join(lib, 'config.js'))});
            const { authenticate } = await import(${JSON.stringify(path.join(lib, 'auth.js'))});
            setActiveProfile('monitoring');
            await authenticate({ method: 'oauth', server: ${JSON.stringify(baseURL)}, username: 'alvarolb', clientId: 'cli' });
        `;
        const signal = await new Promise((resolve) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
                env: { ...process.env, NODE_TEST_CONTEXT: '' },
                stdio: 'ignore',
            });
            // Killed while it waits for the device code: nothing can clean up.
            onDeviceCode = () => child.kill('SIGKILL');
            child.on('close', (_code, sig) => resolve(sig));
        });
        assert.equal(signal, 'SIGKILL');
        assert.deepEqual(getProfile('monitoring'), saved);
    });
});
