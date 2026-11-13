import { testIdentity } from './setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from '../lib/api.js';
import { authenticate } from '../lib/auth.js';
import {
    addImpersonatingProfile,
    credentialsProfile,
    deleteConfig,
    getProfile,
    mergeConfig,
    readConfig,
    requireConfig,
    resolveUser,
    setActiveProfile,
    updateProfile,
    withActiveProfile,
    writeConfig,
} from '../lib/config.js';
import { profile as profileType } from '../lib/mcp/types/profile.js';
import { v1 } from '../lib/paths.js';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

const ADMIN = {
    server: 'acme.example.com',
    username: 'alvaro',
    token: 'T-admin',
    refresh_token: 'R-admin',
    oauth_client_id: 'cli',
    token_id: 'acme_cli',
};
const MONITORING = {
    credentials_from: 'admin',
    impersonate: 'monitoring',
    description: 'Monitoring account: build jobs on supermicro',
};

function seed() {
    deleteConfig();
    setActiveProfile('admin');
    writeConfig(ADMIN);
    setActiveProfile(null);
    addImpersonatingProfile('monitoring', {
        credentialsFrom: 'admin',
        impersonate: 'monitoring',
        description: MONITORING.description,
    });
}

/** Run the CLI in its own process (printErr exits); its JSON answer parsed. */
function cli(...args) {
    const code = `
        import { defineIdentity } from ${JSON.stringify(path.join(lib, 'identity.js'))};
        defineIdentity(${JSON.stringify(testIdentity)});
        const { runCli } = await import(${JSON.stringify(path.join(lib, 'cli.js'))});
        await runCli({ argv: ['node', 'acme', ...${JSON.stringify(args)}], version: '0.0.0' });
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, NODE_TEST_CONTEXT: '' },
        encoding: 'utf8',
    });
    let json = null;
    try {
        json = JSON.parse(out.stdout);
    } catch {
        // Human output.
    }
    return { json, stdout: out.stdout, stderr: out.stderr, status: out.status };
}

describe('profiles that take their credentials from another', () => {
    beforeEach(seed);

    it('reach the server with its session, as their own account', () => {
        const config = withActiveProfile('monitoring', () => readConfig());
        assert.equal(config.server, ADMIN.server);
        assert.equal(config.token, ADMIN.token);
        assert.equal(config.username, 'monitoring');
        assert.equal(config.credentials_user, 'alvaro');
        // The CLI token belongs to the other profile's login.
        assert.equal(config.token_id, undefined);
        withActiveProfile('monitoring', () => {
            assert.equal(resolveUser(), 'monitoring');
            assert.equal(v1(), '/v1/users/monitoring');
            // --user still wins.
            assert.equal(resolveUser('other'), 'other');
        });
        assert.deepEqual(getProfile('monitoring'), MONITORING);
    });

    it('save renewed credentials in the profile that holds them', () => {
        withActiveProfile('monitoring', () => mergeConfig({ token: 'T2', refresh_token: 'R2' }));
        assert.equal(getProfile('admin').token, 'T2');
        assert.equal(getProfile('admin').refresh_token, 'R2');
        assert.deepEqual(getProfile('monitoring'), MONITORING);
        assert.equal(credentialsProfile('monitoring'), 'admin');
        assert.equal(credentialsProfile('admin'), 'admin');
    });

    it('say to sign in the credentials profile when it has no session', () => {
        setActiveProfile('admin');
        writeConfig({ server: ADMIN.server });
        setActiveProfile(null);
        assert.throws(
            () => withActiveProfile('monitoring', () => requireConfig()),
            (e) => {
                assert.equal(e.code, 'not_configured');
                assert.match(e.message, /credentials of profile admin, which is not signed in/);
                assert.match(e.message, /`acme --profile admin login`/);
                return true;
            },
        );
    });

    it('say so when the credentials profile is gone or takes its own from another', () => {
        addImpersonatingProfile('ops', { credentialsFrom: 'admin', impersonate: 'ops' });
        setActiveProfile('monitoring');
        writeConfig({ credentials_from: 'ops', impersonate: 'monitoring' });
        setActiveProfile('lost');
        writeConfig({ credentials_from: 'nowhere', impersonate: 'x' });
        setActiveProfile(null);
        const chained = withActiveProfile('monitoring', () => readConfig());
        assert.equal(chained.token, undefined);
        assert.throws(
            () => withActiveProfile('monitoring', () => requireConfig()),
            /takes its own from admin \(only one level/,
        );
        assert.throws(() => withActiveProfile('lost', () => requireConfig()), /does not exist/);
    });

    it('cannot take them from a missing, chained or the same profile', () => {
        const add =
            (name, credentialsFrom, impersonate = 'x') =>
            () =>
                addImpersonatingProfile(name, { credentialsFrom, impersonate });
        assert.throws(add('a', 'nowhere'), /Profile not found: nowhere/);
        assert.throws(add('b', 'monitoring'), /point b at admin instead/);
        assert.throws(add('self', 'self'), /from itself/);
        assert.throws(add('monitoring', 'admin'), /already exists/);
        assert.throws(add('c', 'admin', ''), /--impersonate/);
    });

    it('sign in the credentials profile on login, and stay as they are', async () => {
        updateProfile('admin', { description: 'Admin of acme' });
        setActiveProfile('monitoring');
        const saved = api.defaults.adapter;
        api.defaults.adapter = async (config) => ({
            data: {},
            status: 200,
            statusText: '',
            headers: {},
            config,
        });
        try {
            await authenticate({
                method: 'token',
                server: ADMIN.server,
                username: 'alvaro',
                token: 'T-new',
            });
        } finally {
            api.defaults.adapter = saved;
            setActiveProfile(null);
        }
        assert.equal(getProfile('admin').token, 'T-new');
        // A new session keeps what the profile is for.
        assert.equal(getProfile('admin').description, 'Admin of acme');
        assert.deepEqual(getProfile('monitoring'), MONITORING);
    });

    it('are listed to agents with what they are for, whom they act as and whose session they use', () => {
        const listed = profileType.list();
        assert.deepEqual(
            listed.find((p) => p.profile === 'monitoring'),
            {
                profile: 'monitoring',
                server: ADMIN.server,
                username: 'monitoring',
                description: MONITORING.description,
                active: false,
                impersonate: 'monitoring',
                credentials_from: 'admin',
            },
        );
        const admin = listed.find((p) => p.profile === 'admin');
        assert.equal(admin.username, 'alvaro');
        assert.ok(!('impersonate' in admin));
        assert.match(profileType.description, /read the descriptions before using one other/);
    });
});

describe('profile commands', () => {
    beforeEach(seed);

    it('add one with --credentials-from, --impersonate and a description, and list it', () => {
        const added = cli(
            'profile',
            'add',
            'ops',
            '--credentials-from',
            'admin',
            '--impersonate',
            'ops',
            '-d',
            'Ops account',
            '--no-activate',
            '--json',
        );
        assert.equal(added.status, 0, added.stderr);
        assert.equal(added.json.data.added, 'ops');

        const listed = cli('profile', 'list', '--json');
        const ops = listed.json.data.profiles.find((p) => p.name === 'ops');
        assert.deepEqual(ops, {
            name: 'ops',
            active: false,
            username: 'ops',
            server: ADMIN.server,
            description: 'Ops account',
            impersonate: 'ops',
            credentials_from: 'admin',
        });

        const human = cli('profile', 'list').stdout;
        assert.match(
            human,
            /ops\s+ops@acme\.example\.com\s+impersonating ops with the credentials of admin/,
        );
        assert.match(human, /\n\s+Ops account\n/);
    });

    it('refuse sign-in options on a profile that takes its credentials from another', () => {
        const res = cli(
            'profile',
            'add',
            'ops',
            '--credentials-from',
            'admin',
            '--impersonate',
            'ops',
            '--token',
            'T',
            '--json',
        );
        assert.notEqual(res.status, 0);
        assert.equal(res.json.error.code, 'input_error');
    });

    it('change and remove the description', () => {
        assert.equal(cli('profile', 'update', 'admin', '-d', 'Admin', '--json').status, 0);
        assert.equal(getProfile('admin').description, 'Admin');
        assert.equal(cli('profile', 'update', 'admin', '-d', '', '--json').status, 0);
        assert.equal(getProfile('admin').description, undefined);
        assert.equal(
            cli('profile', 'update', 'nope', '-d', 'x', '--json').json.error.code,
            'not_found',
        );
    });

    it('log one out alone, without revoking the session it borrows', () => {
        const res = cli('--profile', 'monitoring', 'logout');
        assert.equal(res.status, 0, res.stderr);
        assert.equal(getProfile('monitoring'), undefined);
        assert.equal(getProfile('admin').token, ADMIN.token);
    });

    it('keep the credentials profile from being logged out or deleted under them', () => {
        const out = cli('--profile', 'admin', 'logout', '--keep-token');
        assert.notEqual(out.status, 0);
        assert.match(out.stderr, /Profiles monitoring use the credentials of admin/);
        const del = cli('profile', 'delete', 'admin', '--json');
        assert.equal(del.json.error.code, 'input_error');
        assert.equal(getProfile('admin').token, ADMIN.token);
    });
});
