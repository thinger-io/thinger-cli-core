// @ts-check
import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { appStorage, initApp, packageName, sdkSpec } from '../lib/dashboard-init.js';
import { extractTgz } from '../lib/tgz.js';

/** A local copy of the SDK package with a react and an angular template. */
function fakeSdk() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakesdk-'));
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    write('package.json', JSON.stringify({ name: '@thinger-io/dashboard-sdk', version: '0.2.0' }));
    write(
        'templates/react/package.json',
        JSON.stringify({
            name: 'thinger-dashboard-react',
            scripts: { dev: 'vite' },
            dependencies: { '@thinger-io/dashboard-sdk': '^0.1.0', react: '^19' },
        }),
    );
    write('templates/react/_gitignore', 'node_modules\n');
    write('templates/react/src/main.tsx', 'export {};\n');
    write(
        'templates/angular/package.json',
        JSON.stringify({
            name: 'thinger-dashboard-angular',
            scripts: { start: 'ng serve' },
            dependencies: { '@thinger-io/dashboard-sdk': '^0.1.0' },
        }),
    );
    write(
        'templates/angular/angular.json',
        '{"projects":{"thinger-dashboard-angular":{"outputPath":"dist/thinger-dashboard-angular"}}}',
    );
    return root;
}

/** A ustar archive of [path, content] entries. */
function tarOf(entries) {
    const blocks = [];
    for (const [name, content] of entries) {
        const body = Buffer.from(content);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100);
        header.write('0000644\0', 100);
        header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
        header.write('0', 156);
        header.write('ustar\0' + '00', 257);
        header.fill(' ', 148, 156);
        let sum = 0;
        for (const b of header) sum += b;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

/** A folder as npm packs it: every file under package/. */
function packDir(root) {
    const entries = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else
                entries.push([
                    `package/${path.relative(root, full).split(path.sep).join('/')}`,
                    fs.readFileSync(full),
                ]);
        }
    };
    walk(root);
    return zlib.gzipSync(tarOf(entries));
}

describe('dashboard init', () => {
    const sdk = fakeSdk();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));

    it('names the package and the storage after the folder', () => {
        assert.equal(packageName('/x/Green House App'), 'green-house-app');
        assert.equal(appStorage('green-house-app', 'ab12'), 'app_green-house-app_ab12');
        assert.match(appStorage('green-house-app'), /^app_green-house-app_[0-9a-f]{4}$/);
        assert.equal(appStorage('a'.repeat(40), 'ab12').length, 32);
    });

    it('creates a React app with its manifest and agent guide', async () => {
        const dir = path.join(parent, 'Greenhouse');
        const r = await initApp({ dir, from: sdk, to: { type: 'device', id: 'gh_01' }, ci: true });
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        assert.equal(pkg.name, 'greenhouse');
        assert.equal(pkg.dependencies['@thinger-io/dashboard-sdk'], `file:${sdk}`);
        assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
        assert.ok(!fs.existsSync(path.join(dir, '_gitignore')));
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'acme.json'), 'utf8'));
        assert.match(manifest.dashboard.storage, /^app_greenhouse_[0-9a-f]{4}$/);
        assert.deepEqual(manifest.dashboard, {
            dir: 'dist',
            storage: manifest.dashboard.storage,
            prune: true,
            to: [{ type: 'device', id: 'gh_01' }],
            dev: { url: 'http://localhost:5173/' },
        });
        assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Hash routing only/);
        assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
        assert.match(
            fs.readFileSync(path.join(dir, '.github', 'workflows', 'dashboard.yml'), 'utf8'),
            /ACME_TOKEN: \$\{\{ secrets\.ACME_TOKEN \}\}/,
        );
        assert.deepEqual(r.context, { device: 'gh_01' });
        assert.equal(r.devCommand, 'npm run dev');
        assert.match(r.notes[0], /points at a local copy \(file:/);
        assert.match(
            fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
            /acme_resource_call type "dashboard" action "dev"/,
        );
    });

    it('renames the Angular project, which names its build folder', async () => {
        const dir = path.join(parent, 'plant');
        const r = await initApp({ dir, from: sdk, template: 'angular' });
        assert.equal(r.build, 'dist/plant/browser');
        assert.equal(r.devCommand, 'npm start');
        assert.match(
            fs.readFileSync(path.join(dir, 'angular.json'), 'utf8'),
            /"plant".*dist\/plant/,
        );
    });

    it('takes versions and tags of the SDK as --from, nothing else', async () => {
        assert.equal(sdkSpec('0.3.0'), '0.3.0');
        assert.equal(sdkSpec('@thinger-io/dashboard-sdk@next'), 'next');
        for (const bad of ['x & calc', '--registry=evil', 'a/b', '../x', 'react@1']) {
            assert.equal(sdkSpec(bad), null, bad);
        }
        await assert.rejects(
            initApp({ dir: path.join(parent, 'bad'), from: 'x & calc' }),
            /--from is a folder or \.tgz/,
        );
        assert.ok(!fs.existsSync(path.join(parent, 'bad')));
    });

    it('creates the app from a .tgz, and removes it when the template is missing', async () => {
        const tgz = path.join(parent, 'sdk.tgz');
        fs.writeFileSync(tgz, packDir(sdk));
        const dir = path.join(parent, 'fromtgz');
        const r = await initApp({ dir, from: tgz });
        assert.equal(r.dependency, `file:${tgz}`);
        assert.ok(fs.existsSync(path.join(dir, 'src', 'main.tsx')));
        await assert.rejects(
            initApp({ dir: path.join(parent, 'vue2'), from: tgz, template: 'vue' }),
            /no template/,
        );
        assert.ok(!fs.existsSync(path.join(parent, 'vue2')));
    });

    it('extracts only inside the folder', () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tgz-'));
        const evil = zlib.gzipSync(tarOf([['package/../../escape.txt', 'x']]));
        assert.throws(() => extractTgz(evil, out, { strip: 1 }), /unsafe path/);
        assert.throws(() => extractTgz(Buffer.from('nope'), out), /not a \.tgz/);
    });

    it('refuses a folder with files and an unknown template', async () => {
        await assert.rejects(initApp({ dir: path.join(parent, 'plant'), from: sdk }), /not empty/);
        await assert.rejects(
            initApp({ dir: path.join(parent, 'vue'), from: sdk, template: 'vue' }),
            /no template "vue"; it has (react, angular|angular, react)/,
        );
    });
});
