// @ts-check
import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkDestination, destinationContext, manifestName } from './dashboard.js';
import { SDK_PACKAGE } from './dashboard-sdk.js';
import { inputError } from './errors.js';
import { identity } from './identity.js';
import { opRef } from './mcp/naming.js';
import { extractTgz } from './tgz.js';

const run = promisify(exec);
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 30000;

/**
 * `dashboard init`: a new dashboard app from one of the templates the SDK
 * package ships (`templates/<name>` in @thinger-io/dashboard-sdk), ready to
 * develop with `dashboard dev` and publish with `dashboard publish`: the
 * project, its manifest (`<cli>.json`) and an AGENTS.md with the rules an
 * app in the console's frame follows.
 */

/** Template the init uses unless told otherwise. */
export const DEFAULT_TEMPLATE = 'react';

/** Folders of a template never copied (left there by trying it in place). */
const NOT_COPIED = new Set(['node_modules', 'dist', '.angular']);

/** The SDK package the CLI installs (its own dependency), or null. */
function ownSdk() {
    try {
        return path.dirname(createRequire(import.meta.url).resolve(`${SDK_PACKAGE}/package.json`));
    } catch {
        return null;
    }
}

/** A version or dist-tag of the SDK on npm, as `--from` names it ("0.3.0", "next", "<pkg>@0.3.0"). */
export function sdkSpec(from) {
    const tag = from.startsWith(`${SDK_PACKAGE}@`) ? from.slice(SDK_PACKAGE.length + 1) : from;
    return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(tag) ? tag : null;
}

/**
 * Download a version (or dist-tag) of the SDK package from npm, checking
 * its integrity.
 *
 * @param {string} tag
 * @returns {Promise<Buffer>}
 */
async function downloadSdk(tag) {
    const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const meta = await fetch(`${REGISTRY}/${SDK_PACKAGE}/${encodeURIComponent(tag)}`, {
        signal: signal(),
    });
    if (meta.status === 404) throw inputError(`${SDK_PACKAGE} has no version or tag "${tag}"`);
    if (!meta.ok) throw new Error(`npm answered ${meta.status}`);
    const { dist } = await meta.json();
    if (typeof dist?.tarball !== 'string' || !dist.tarball.startsWith(`${REGISTRY}/`)) {
        throw new Error('npm gave no tarball');
    }
    const res = await fetch(dist.tarball, { signal: signal() });
    if (!res.ok) throw new Error(`npm answered ${res.status} for the tarball`);
    const tgz = Buffer.from(await res.arrayBuffer());
    const sri = /^sha512-(.+)$/.exec(dist.integrity || '');
    if (sri && createHash('sha512').update(tgz).digest('base64') !== sri[1]) {
        throw new Error('the tarball does not match its integrity');
    }
    return tgz;
}

/**
 * The SDK package to take the templates from: by default its latest
 * release on npm (or the CLI's own copy when npm cannot be reached);
 * `from` names a local package folder, a .tgz, or a version or tag on npm.
 *
 * @param {string} [from]
 * @returns {Promise<{ root: string, version: string, dependency: string, notes: string[],
 *   cleanup: () => void }>}
 */
async function sdkPackage(from) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-init-'));
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    const notes = [];
    try {
        const local = from && fs.existsSync(from) ? path.resolve(from) : null;
        let root = local && fs.statSync(local).isDirectory() ? local : null;
        /** @type {Buffer | null} */
        let tgz = root || !local ? null : fs.readFileSync(local);
        if (!root && !tgz) {
            const tag = from ? sdkSpec(from) : 'latest';
            if (!tag) {
                throw inputError(
                    `--from is a folder or .tgz of ${SDK_PACKAGE}, or one of its versions or tags; got "${from}"`,
                );
            }
            try {
                tgz = await downloadSdk(tag);
            } catch (e) {
                // Offline: the copy the CLI installs, unless another one was asked for.
                root = from || e.code === 'input_error' ? null : ownSdk();
                if (!root) {
                    if (e.code === 'input_error') throw e;
                    throw inputError(
                        `could not get ${SDK_PACKAGE}@${tag} from npm (${e.message}); pass --from with a local copy of the package`,
                    );
                }
                notes.push(
                    `npm could not be reached (${e.message}): the template comes from the SDK the CLI installs.`,
                );
            }
        }
        if (tgz) {
            try {
                extractTgz(tgz, tmp, { strip: 1 });
            } catch (e) {
                throw inputError(`${from || SDK_PACKAGE}: ${e.message}`);
            }
            root = tmp;
        }
        const pkgFile = path.join(/** @type {string} */ (root), 'package.json');
        const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : {};
        if (pkg.name !== SDK_PACKAGE) {
            throw inputError(`${from || root} is not the ${SDK_PACKAGE} package`);
        }
        // A local copy is installed from where it is; one from npm by version.
        const dependency = local ? `file:${local}` : `^${pkg.version}`;
        return {
            root: /** @type {string} */ (root),
            version: pkg.version,
            dependency,
            notes,
            cleanup,
        };
    } catch (e) {
        cleanup();
        throw e;
    }
}

/** An npm package name from a folder name. */
export function packageName(dir) {
    const name = path
        .basename(path.resolve(dir))
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[._-]+|[-]+$/g, '');
    return name || 'dashboard-app';
}

/**
 * The storage an app publishes to by default: app_<name>_<random>, within 32
 * characters, so two apps in folders of the same name never share (and
 * prune) one storage.
 */
export function appStorage(name, suffix = randomBytes(2).toString('hex')) {
    return `${`app_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 27)}_${suffix}`;
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name === '_gitignore' ? '.gitignore' : entry.name);
        if (entry.isDirectory()) {
            if (!NOT_COPIED.has(entry.name)) copyDir(src, dest);
        } else if (entry.isFile()) fs.copyFileSync(src, dest);
    }
}

function editJson(file, edit) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(json);
    fs.writeFileSync(file, JSON.stringify(json, null, 4) + '\n');
}

/** Guide for the agents that work on the app. */
function agentsGuide({ name, template, buildDir, devCommand }) {
    const cli = identity().name;
    return `# ${name}

A Thinger dashboard app (${template} template) built on \`${SDK_PACKAGE}\`. The Thinger
console shows it in a sandboxed iframe, loading the build from a file storage; it also runs on
its own as a standalone page.

## Develop

1. \`npm install\`, then \`${devCommand}\` (the app's dev server).
2. \`${cli} dashboard dev\` gives a link that opens the local app against the Thinger server, with
   a temporary token and the context in ${manifestName()} (\`dev\`). Open it in a browser: the
   app gets real data, reloads on every change, and its errors are in the browser console.
   Agents: the MCP call \`${opRef('dashboard', 'dev')}\` gives the same link; open it with
   browser tools.

3. \`npm run build\`, then \`${cli} dashboard publish\`: it uploads \`${buildDir}\` and points the
   destinations in ${manifestName()} at it.

## Reviewing the layout

Dashboards show at website sizes (around 1150 × 758 and 950 × 678) and on phones (around
380 × 600). Open the dev link and resize the window; below about 500 px, where a desktop window
does not shrink, use Playwright with a fixed viewport, or load the dev link in an iframe of that
size from a page of the app's own dev server (same origin, so you can look inside it). Give the
iframe the whole dev link, with its \`#…&thinger_token=…\` part, never \`location.href\`: the SDK
removes the token from the address bar when it starts, and a frame does not take the session
from the tab, so it would have none. The frame posts \`thinger:dashboard-ready\` to the page once
its data is in. The package README has more under "Reviewing the layout".

## Rules (they only fail once published, inside the console)

- Hash routing only: the storage serves real files, not app routes.
- Relative asset URLs and no \`<base>\` tag.
- Render after \`Thinger.ready()\`: it brings the user, the token and the context
  (\`Thinger.context.device\`…).
- No localStorage or cookies (the frame has an opaque origin): keep settings in properties
  through the SDK.
- Reach the server only through the SDK (\`Thinger.*\`), never with a token of your own.
- Reload the app with \`Thinger.reload()\`, never \`location.reload()\`: inside the console a
  plain reload loses the frame's key and the app gets no token.

## Reference

\`node_modules/${SDK_PACKAGE}/README.md\` documents every call of the installed version, and its
types come with the package; \`CHANGELOG.md\` there says what changes between versions.
`;
}

/** npm package of the running CLI, to run it with npx in CI. */
function cliPackage() {
    if (identity().npmPackage) return identity().npmPackage;
    try {
        let dir = path.dirname(fs.realpathSync(process.argv[1]));
        for (;;) {
            const file = path.join(dir, 'package.json');
            if (fs.existsSync(file)) {
                const { name } = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (name) return name;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch {
        // fall back to the binary name
    }
    return identity().name;
}

/** Workflow that publishes the app on every push to main. */
function ciWorkflow() {
    const { envPrefix } = identity();
    return `name: Publish dashboard
on:
    push:
        branches: [main]
jobs:
    publish:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: 22
            - run: npm ci && npm run build
            - run: npx -y ${cliPackage()} dashboard publish
              env:
                  ${envPrefix}_SERVER: \${{ vars.${envPrefix}_SERVER }}
                  ${envPrefix}_TOKEN: \${{ secrets.${envPrefix}_TOKEN }}
`;
}

/**
 * Create a dashboard app in `dir` (new or empty).
 *
 * @param {{ dir: string, template?: string, to?: import('./dashboard.js').Destination,
 *   storage?: string, from?: string, ci?: boolean, install?: boolean }} opts
 */
export async function initApp({
    dir,
    template = DEFAULT_TEMPLATE,
    to,
    storage,
    from,
    ci = false,
    install = false,
}) {
    if (!dir) throw inputError('pass the folder of the new app');
    const target = path.resolve(dir);
    const existed = fs.existsSync(target);
    if (existed && !fs.statSync(target).isDirectory()) throw inputError(`${dir} is a file`);
    if (existed && fs.readdirSync(target).some((f) => f !== '.git')) {
        throw inputError(`${dir} is not empty: pass a new folder`);
    }
    if (to) checkDestination(to);

    const pkg = await sdkPackage(from);
    try {
        return await createApp({ target, dir, template, to, storage, ci, install, pkg });
    } catch (e) {
        // Leave no half-made app behind (a .git that was there stays).
        if (existed) {
            for (const f of fs.readdirSync(target)) {
                if (f !== '.git') fs.rmSync(path.join(target, f), { recursive: true, force: true });
            }
        } else fs.rmSync(target, { recursive: true, force: true });
        throw e;
    } finally {
        pkg.cleanup();
    }
}

/** The steps of initApp once the package is at hand. */
async function createApp({ target, dir, template, to, storage, ci, install, pkg }) {
    const notes = [...pkg.notes];
    {
        const templates = path.join(pkg.root, 'templates');
        const available = fs.existsSync(templates)
            ? fs
                  .readdirSync(templates, { withFileTypes: true })
                  .filter((e) => e.isDirectory())
                  .map((e) => e.name)
            : [];
        if (!available.includes(template)) {
            throw inputError(
                `${SDK_PACKAGE} ${pkg.version} has no template "${template}"; it has ${available.join(', ') || 'none'}`,
            );
        }
        copyDir(path.join(templates, template), target);
    }
    if (!fs.existsSync(path.join(target, 'package.json'))) {
        throw inputError(`template "${template}" has no package.json`);
    }

    const name = packageName(target);
    let original;
    editJson(path.join(target, 'package.json'), (json) => {
        original = json.name;
        json.name = name;
        for (const deps of [json.dependencies, json.devDependencies]) {
            if (deps?.[SDK_PACKAGE]) deps[SDK_PACKAGE] = pkg.dependency;
        }
    });
    const scripts = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).scripts;

    // Angular names its build folder after the project: dist/<project>/browser.
    const angular = fs.existsSync(path.join(target, 'angular.json'));
    if (angular && original) {
        for (const file of ['angular.json', 'README.md']) {
            const full = path.join(target, file);
            if (fs.existsSync(full)) {
                fs.writeFileSync(full, fs.readFileSync(full, 'utf8').split(original).join(name));
            }
        }
    }
    const buildDir = angular ? `dist/${name}/browser` : 'dist';
    const devCommand = scripts?.dev ? 'npm run dev' : 'npm start';
    const devUrl = angular ? 'http://localhost:4200/' : 'http://localhost:5173/';

    const manifest = {
        dashboard: {
            dir: buildDir,
            storage: storage || appStorage(name),
            prune: true,
            ...(to ? { to: [to] } : {}),
            dev: { url: devUrl },
        },
    };
    fs.writeFileSync(path.join(target, manifestName()), JSON.stringify(manifest, null, 4) + '\n');
    fs.writeFileSync(
        path.join(target, 'AGENTS.md'),
        agentsGuide({ name, template, buildDir, devCommand }),
    );
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), '@AGENTS.md\n');
    if (ci && pkg.dependency.startsWith('file:')) {
        notes.push(
            `The SDK dependency points at a local copy (${pkg.dependency}): the workflow's npm ci fails until it names a published version.`,
        );
    }
    if (ci) {
        const workflows = path.join(target, '.github', 'workflows');
        fs.mkdirSync(workflows, { recursive: true });
        fs.writeFileSync(path.join(workflows, 'dashboard.yml'), ciWorkflow());
    }
    if (install) {
        try {
            // a fixed command line, run in the app's folder
            await run('npm install --no-fund --no-audit', { cwd: target });
        } catch (e) {
            throw inputError(
                `created ${dir}, but npm install failed: ${
                    String(e.stderr || e.message)
                        .trim()
                        .split('\n')
                        .slice(-1)[0]
                }`,
            );
        }
    }
    return {
        dir: target,
        name,
        template,
        sdk: pkg.version,
        dependency: pkg.dependency,
        build: buildDir,
        devCommand,
        devUrl,
        storage: manifest.dashboard.storage,
        context: destinationContext(to),
        installed: install,
        notes,
    };
}
