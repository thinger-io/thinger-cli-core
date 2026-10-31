// @ts-check
import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    collectFiles,
    defaultStorage,
    entryUrl,
    previewTokenId,
    previewUrl,
    publishApp,
} from '../lib/dashboard.js';
import { CATALOG } from '../lib/mcp/catalog.js';
import { buildTools, listResources, readResource } from '../lib/mcp/registry.js';
import { defineCliDocs, docMimeType, listDocs, readDoc } from '../lib/docs.js';

describe('dashboard files', () => {
    it('collects a folder recursively, without hidden entries or node_modules', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
        fs.mkdirSync(path.join(dir, 'js'));
        fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
        fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'console.log(1)');
        fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
        fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), '');
        const files = collectFiles(dir);
        assert.deepEqual(Object.keys(files).sort(), ['index.html', 'js/app.js']);
        assert.equal(files['js/app.js'].toString(), 'console.log(1)');
    });

    it('refuses what is not a folder', () => {
        assert.throws(() => collectFiles('/no/such/folder'), /Not a folder/);
    });
});

describe('dashboard storage', () => {
    it('is readable when it fits, and a stable 32-character hash otherwise', () => {
        assert.equal(defaultStorage('sales'), 'dashboard_sales');
        assert.equal(
            defaultStorage(undefined, { type: 'device', id: 'gw1' }),
            'dashboard_device_gw1',
        );
        const long = defaultStorage(undefined, { type: 'asset_group', id: 'madrid_north_plant' });
        assert.match(long, /^dashboard_[0-9a-f]{22}$/);
        assert.equal(
            long,
            defaultStorage(undefined, { type: 'asset_group', id: 'madrid_north_plant' }),
        );
        assert.notEqual(
            long,
            defaultStorage(undefined, { type: 'asset_type', id: 'madrid_north_plant' }),
        );
    });
});

describe('dashboard publishing', () => {
    const files = { 'index.html': '<html></html>' };

    // Validation happens before any request, so these need no server.
    it('needs something to do', async () => {
        await assert.rejects(publishApp({}), /nothing to do/);
        await assert.rejects(
            publishApp({ storage: 'app', preview: 0.0 + 1000 }),
            /preview is true or a number of hours/,
        );
        await assert.rejects(publishApp({ files: {} }), /no files/);
        await assert.rejects(
            publishApp({ to: [{ dashboard: 'd' }], prune: true }),
            /prune needs the files/,
        );
    });

    it('checks each destination', async () => {
        await assert.rejects(
            publishApp({ files, to: [{}] }),
            /either \{dashboard\} or \{type, id\}/,
        );
        await assert.rejects(
            publishApp({ files, to: [{ dashboard: 'd', type: 'device', id: 'x' }] }),
            /either \{dashboard\} or \{type, id\}/,
        );
        await assert.rejects(
            publishApp({ files, to: [{ type: 'bucket', id: 'b' }] }),
            /type must be one of/,
        );
        await assert.rejects(publishApp({ files, to: [{ dashboard: 'bad id' }] }), /invalid id/);
        await assert.rejects(
            publishApp({ files, to: [{ dashboard: 'd', entry: '/index.html' }] }),
            /entry is a path inside the storage/,
        );
    });

    it('needs a storage name for an app shared by several destinations', async () => {
        await assert.rejects(
            publishApp({ files, to: [{ dashboard: 'a' }, { dashboard: 'b' }] }),
            /pass storage/,
        );
        await assert.rejects(
            publishApp({ files, storage: 'no spaces allowed', to: [{ dashboard: 'd' }] }),
            /invalid storage id/,
        );
    });

    it('points at the storage folder for its index, at other pages by name', () => {
        assert.equal(
            entryUrl('acme', 'app_plant', { route: '/devices/gw1' }, { index: 'index.html' }),
            '/v1/users/acme/storages/app_plant/files/#/devices/gw1',
        );
        assert.equal(
            entryUrl(
                'acme',
                'app_plant',
                { entry: 'pages/device view.html' },
                { index: 'index.html' },
            ),
            '/v1/users/acme/storages/app_plant/files/pages/device%20view.html',
        );
        assert.equal(
            entryUrl('acme', 'app_plant', { route: '#/x' }),
            '/v1/users/acme/storages/app_plant/files/index.html#/x',
        );
    });

    it('adds ?v= only when asked to bump', () => {
        assert.equal(
            entryUrl('acme', 'app_plant', { route: '/x' }, { index: 'index.html', version: 42 }),
            '/v1/users/acme/storages/app_plant/files/?v=42#/x',
        );
    });
});

describe('dashboard MCP surface', () => {
    it("lists the platform's and the SDK's documents as resources, with no server", async () => {
        // No profile is configured in the tests: nothing comes from a server.
        const resources = await listResources();
        assert.deepEqual(
            resources.map((r) => r.uri),
            [
                'acme://concepts',
                'acme://product-code',
                'acme://server-admin',
                'acme://dashboard-sdk',
                'acme://dashboard-sdk-types',
            ],
        );
        assert.match(resources[0].description, /acme_resource_get type "doc"/);
        assert.equal(resources[0].mimeType, 'text/markdown');
        assert.match((await readResource('acme://concepts')).text, /^# Thinger concepts/);
        assert.doesNotMatch((await readResource('acme://concepts')).text, /\/sdk\//);
        await assert.rejects(readResource('other://concepts'), /Unknown resource/);
        assert.equal(docMimeType('typescript'), 'text/plain');
    });

    // A CLI ships its own guides: they are listed and read even when no
    // server can be reached (no profile in the tests), first in the list.
    it("serves the CLI's own guides next to the server's", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
        fs.writeFileSync(path.join(dir, 'guide.md'), '# Acme guide');
        defineCliDocs([
            { id: 'acme-guide', title: 'Acme guide', file: path.join(dir, 'guide.md') },
        ]);
        try {
            const docs = await listDocs();
            assert.deepEqual(
                docs.map((d) => d.id),
                [
                    'acme-guide',
                    'concepts',
                    'product-code',
                    'server-admin',
                    'dashboard-sdk',
                    'dashboard-sdk-types',
                ],
            );
            assert.equal((await readDoc('acme-guide')).text, '# Acme guide');
            await assert.rejects(
                readDoc('nope'),
                /Unknown document "nope". Available: acme-guide, concepts/,
            );
            const resources = await listResources();
            assert.equal(resources[0].uri, 'acme://acme-guide');
            assert.equal((await readResource('acme://acme-guide')).text, '# Acme guide');
        } finally {
            defineCliDocs([]);
        }
        assert.throws(() => defineCliDocs([{ id: 'x' }]), /needs id, title and file/);
    });

    // The SDK's reference and types come from its package: the one the
    // project in the working folder uses.
    it("serves the SDK's documents from the project's package", async () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkdocs-'));
        const pkg = path.join(project, 'node_modules', '@thinger-io', 'dashboard-sdk');
        fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"0.2.0"}');
        fs.writeFileSync(path.join(pkg, 'README.md'), '# SDK');
        fs.writeFileSync(
            path.join(pkg, 'dist', 'index.d.ts'),
            "export * from './types.js';\n//# sourceMappingURL=index.d.ts.map",
        );
        fs.writeFileSync(path.join(pkg, 'dist', 'types.d.ts'), 'export type Id = string;');
        fs.writeFileSync(path.join(pkg, 'dist', 'alarms.d.ts'), 'export {};');
        const cwd = process.cwd();
        process.chdir(project);
        try {
            const docs = await listDocs();
            const sdk = docs.filter((d) => d.id.startsWith('dashboard-sdk'));
            assert.deepEqual(
                sdk.map((d) => d.id),
                ['dashboard-sdk', 'dashboard-sdk-types'],
            );
            assert.match(sdk[0].title, /@thinger-io\/dashboard-sdk 0\.2\.0/);
            assert.equal((await readDoc('dashboard-sdk')).text, '# SDK');
            const types = (await readDoc('dashboard-sdk-types')).text;
            assert.equal(
                types,
                "// index.d.ts\nexport * from './types.js';\n\n// types.d.ts\nexport type Id = string;\n\n// alarms.d.ts\nexport {};",
            );
        } finally {
            process.chdir(cwd);
        }
    });

    it('catalog notes refer to existing tools and operations', () => {
        // Operations are checked when the tools are built.
        assert.throws(
            () =>
                buildTools({
                    types: { x: { description: 'See {op:device.reboot}.', list: () => [] } },
                }),
            /\{op:device\.reboot\}: device has no operation "reboot"/,
        );

        const names = new Set(buildTools().map((t) => t.name.replace(/^acme_/, '')));
        for (const [name, type] of Object.entries(CATALOG)) {
            for (const text of [type.description, type.notes || '']) {
                for (const [, ref] of text.matchAll(/\{tool:([a-z0-9_]+)\}/g)) {
                    assert.ok(names.has(ref), `${name} refers to unknown tool ${ref}`);
                }
            }
        }
    });
});

describe('dashboard preview', () => {
    it('puts the session after the route, defaulting to #/', () => {
        assert.equal(
            previewUrl('https://s/v1/users/u/storages/app/files/#/devices', 'a.b.c', {
                project: 'plant',
            }),
            'https://s/v1/users/u/storages/app/files/#/devices&thinger_token=a.b.c&thinger_project=plant',
        );
        assert.equal(
            previewUrl('https://s/x/files/', 't', { group: 'north', device: undefined }),
            'https://s/x/files/#/&thinger_token=t&thinger_group=north',
        );
    });

    it('names one token per app and project, within 32 characters', () => {
        assert.equal(previewTokenId('app_plant'), 'preview_app_plant');
        assert.equal(previewTokenId('app', 'plant'), 'preview_app_plant');
        const long = previewTokenId('dashboard_device_gateway_01', 'north_plant');
        assert.ok(long.length <= 32);
        assert.equal(long, previewTokenId('dashboard_device_gateway_01', 'north_plant'));
        assert.notEqual(long, previewTokenId('dashboard_device_gateway_01', 'south_plant'));
    });
});
