import { testIdentity } from './setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../lib/config.js';
import { defineIdentity } from '../lib/identity.js';
import {
    cachedLatest,
    latestVersion,
    updateCheckEnabled,
    updateNotice,
} from '../lib/update-check.js';

const cacheFile = () => path.join(cacheDir(), 'latest-version.json');

describe('update check', () => {
    const saved = {
        fetch: globalThis.fetch,
        ctx: process.env.NODE_TEST_CONTEXT,
        ci: process.env.CI,
    };

    beforeEach(() => {
        // A CLI with a package on npm, outside the test runner and CI.
        defineIdentity({ ...testIdentity, npmPackage: '@acme/cli' });
        delete process.env.NODE_TEST_CONTEXT;
        delete process.env.CI;
        fs.rmSync(cacheFile(), { force: true });
    });
    afterEach(() => {
        defineIdentity(testIdentity);
        globalThis.fetch = saved.fetch;
        if (saved.ctx !== undefined) process.env.NODE_TEST_CONTEXT = saved.ctx;
        if (saved.ci !== undefined) process.env.CI = saved.ci;
        delete process.env.ACME_NO_UPDATE_CHECK;
    });

    it('is off without an npm package, in CI and when turned off', () => {
        assert.equal(updateCheckEnabled(), true);
        process.env.ACME_NO_UPDATE_CHECK = '1';
        assert.equal(updateCheckEnabled(), false);
        delete process.env.ACME_NO_UPDATE_CHECK;
        process.env.CI = 'true';
        assert.equal(updateCheckEnabled(), false);
        delete process.env.CI;
        defineIdentity(testIdentity);
        assert.equal(updateCheckEnabled(), false);
    });

    it('tells only about a newer release', () => {
        assert.equal(
            updateNotice('0.5.1', '0.5.2'),
            'acme 0.5.2 is available (this is 0.5.1). Update with: npm i -g @acme/cli',
        );
        assert.equal(updateNotice('0.5.2', '0.5.2'), undefined);
        assert.equal(updateNotice('0.6.0-alpha.1', '0.5.2'), undefined);
        assert.equal(updateNotice('0.5.1', undefined), undefined);
        assert.equal(updateNotice('unknown', '0.5.2'), undefined);
    });

    it('asks the registry once a day, and keeps the answer', async () => {
        const asked = [];
        globalThis.fetch = async (url) => {
            asked.push(String(url));
            return new Response(JSON.stringify({ version: '0.5.2' }));
        };
        assert.equal(await latestVersion(), '0.5.2');
        assert.deepEqual(asked, ['https://registry.npmjs.org/@acme/cli/latest']);
        assert.deepEqual(cachedLatest(), { latest: '0.5.2', fresh: true });
        assert.equal(await latestVersion(), '0.5.2');
        assert.equal(asked.length, 1);
    });

    it('falls back to the old answer when the registry cannot be reached', async () => {
        fs.writeFileSync(
            cacheFile(),
            JSON.stringify({ latest: '0.5.0', checkedAt: Date.now() - 2 * 86_400_000 }),
        );
        assert.deepEqual(cachedLatest(), { latest: '0.5.0', fresh: false });
        globalThis.fetch = async () => {
            throw new Error('offline');
        };
        assert.equal(await latestVersion(), '0.5.0');
    });

    it('asks nothing when it is off', async () => {
        process.env.ACME_NO_UPDATE_CHECK = '1';
        globalThis.fetch = async () => assert.fail('the registry was asked');
        assert.equal(await latestVersion(), undefined);
    });
});
