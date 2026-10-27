// @ts-check
import path from 'node:path';
import open from 'open';
import {
    collectFiles,
    destinationContext,
    manifestName,
    parseDestination,
    publishApp,
    publishSummary,
    readManifest,
} from '../dashboard.js';
import { DEV_HOURS, devLink } from '../dashboard-dev.js';
import { DEFAULT_TEMPLATE, initApp } from '../dashboard-init.js';
import { inputError } from '../errors.js';
import { accent, hint, warning } from '../format.js';
import { identity } from '../identity.js';
import { isJsonMode, printOk } from '../output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser, runCommand } from './_shared.js';

const collect = (value, previous = []) => [...previous, value];

/** Destinations of the command line, each with the shared --entry / --route / --name. */
function flagDestinations(opts) {
    return (opts.to || []).map((value) => ({
        ...parseDestination(value),
        ...(opts.entry ? { entry: opts.entry } : {}),
        ...(opts.route ? { route: opts.route } : {}),
        ...(opts.name ? { name: opts.name } : {}),
    }));
}

/** `<cli> dashboard dev|publish` — url-source dashboard apps. */
export function registerDashboardCommands(program) {
    const cli = identity().name;
    const dashboard = program
        .command('dashboard')
        .helpGroup('Resources:')
        .description(
            'Dashboards: apps on the dashboard SDK (create, develop and publish them) and their records',
        )
        .addHelpText(
            'after',
            `
Both commands read defaults from ${manifestName()} in the working folder (or --config):
  { "dashboard": { "dir": "dist/greenhouse/browser", "storage": "app_greenhouse", "prune": true,
                   "to": [{ "type": "device", "id": "gh_01" }],
                   "dev": { "url": "http://localhost:4200/", "context": { "device": "gh_01" } } } }

In CI, ${identity().envPrefix}_TOKEN and ${identity().envPrefix}_SERVER replace the saved profile (unless --profile or ${identity().envPrefix}_PROFILE names one).`,
        );

    dashboard
        .command('init <dir>')
        .helpGroup('Apps:')
        .description(
            'Create a dashboard app (TypeScript, on @thinger-io/dashboard-sdk) from a template of the SDK',
        )
        .option(
            '-t, --template <name>',
            `Template of the SDK package: react, angular… (default ${DEFAULT_TEMPLATE})`,
        )
        .option(
            '--to <destination>',
            'Where it publishes: device:<id>, product:<id>, dashboard:<id>…',
        )
        .option('-s, --storage <id>', 'Storage it publishes to (default app_<folder>_<random>)')
        .option(
            '--from <package>',
            'SDK package to take the template from: a version or tag on npm, or a folder or .tgz',
        )
        .option('--ci', 'Add a GitHub workflow that publishes it on every push to main')
        .option('--install', 'Run npm install')
        .option('-j, --json', 'Output as JSON')
        .action(async (dir, opts) => {
            applyJsonFlag(opts);
            await runCommand({
                start: 'Creating the app...',
                fn: () =>
                    initApp({
                        dir,
                        template: opts.template,
                        to: opts.to ? parseDestination(opts.to) : undefined,
                        storage: opts.storage,
                        from: opts.from,
                        ci: !!opts.ci,
                        install: !!opts.install,
                    }),
                success: (r) =>
                    `Created ${r.name} (${r.template}, ${r.sdk ? `SDK ${r.sdk}` : 'SDK'})`,
                failure: 'Failed to create the app',
                onSuccess: (r) => {
                    if (isJsonMode()) {
                        printOk(r);
                        return;
                    }
                    console.log(
                        hint(
                            `  ${r.dir}: ${r.template} app on ${r.dependency.startsWith('file:') ? r.dependency : `@thinger-io/dashboard-sdk ${r.dependency}`}, ${manifestName()} (publishes ${r.build} to ${r.storage}) and AGENTS.md.`,
                        ),
                    );
                    console.log(`\n  cd ${dir}`);
                    if (!r.installed) console.log('  npm install');
                    console.log(`  ${r.devCommand}`);
                    console.log(
                        `  ${cli} dashboard dev${Object.keys(r.context).length ? '' : ' --device <id>'}   ${hint('# link to the running app against the server')}`,
                    );
                    console.log(`  npm run build && ${cli} dashboard publish`);
                },
            });
        });

    dashboard
        .command('dev [url]')
        .helpGroup('Apps:')
        .description(
            'Link that opens the app on its own dev server (ng serve, Vite…) against the server, with a temporary token',
        )
        .option(
            '--to <destination>',
            'Context of a destination: device:<id>, product:<id>, dashboard:<id>…',
        )
        .option('--device <id>', 'Device in the SDK context')
        .option('--product <id>', 'Product in the SDK context')
        .option('--asset-type <id>', 'Asset type in the SDK context')
        .option('--asset-group <id>', 'Asset group in the SDK context')
        .option('--project <id>', 'Project the app runs in')
        .option('--route <route>', 'Initial route, e.g. /devices')
        .option('--hours <hours>', `Hours the token lasts (default ${DEV_HOURS})`, Number)
        .option('--open', 'Open the link in the browser')
        .option(
            '--allow-remote',
            'Allow an app url that is not on this machine (the link carries a full-access token)',
        )
        .option('--config <file>', `Manifest (default ${manifestName()})`)
        .option('-j, --json', 'Output as JSON')
        .addHelpText(
            'after',
            `
Start the app's dev server first (the command warns when nothing answers at the url).
The app bundles @thinger-io/dashboard-sdk, which takes the server, a temporary token and the
context from the link: its dev server needs no proxy. Each run replaces the previous link's
token (one per project).`,
        )
        .action(async (url, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: 'Creating the dev link...',
                fn: async () => {
                    const manifest = readManifest(opts.config);
                    const dev = manifest?.dev || {};
                    const app = url || dev.url;
                    if (!app) {
                        throw inputError(
                            `pass the app's dev server url (e.g. ${cli} dashboard dev http://localhost:4200/ --device gw1), or set dev.url in ${manifestName()}`,
                        );
                    }
                    const explicit = {
                        device: opts.device,
                        product: opts.product,
                        type: opts.assetType,
                        group: opts.assetGroup,
                        project: opts.project,
                    };
                    const to = opts.to ? parseDestination(opts.to) : manifest?.to?.[0];
                    const context = Object.values(explicit).some(Boolean)
                        ? explicit
                        : !opts.to && dev.context
                          ? dev.context
                          : destinationContext(to);
                    return devLink({
                        url: app,
                        context,
                        route: opts.route ?? dev.route ?? to?.route,
                        hours: opts.hours ?? dev.hours,
                        user,
                        dir: manifest ? path.dirname(manifest.file) : process.cwd(),
                        allowRemote: !!opts.allowRemote,
                    });
                },
                success: () => 'Dev link ready',
                failure: 'Failed to create the dev link',
                onSuccess: async (dev) => {
                    if (isJsonMode()) printOk(dev);
                    else {
                        const ctx = Object.entries(dev.context).map(([k, v]) => `${k} ${v}`);
                        const until = new Date(dev.expire).toTimeString().slice(0, 5);
                        console.log(`  ${accent(dev.link)}`);
                        console.log(
                            hint(
                                `  ${dev.app} → ${dev.server} as ${dev.user}${ctx.length ? `, ${ctx.join(', ')}` : ''}. Temporary token ${dev.token} until ${until}: writes are real.`,
                            ),
                        );
                        for (const note of dev.notes) console.log(warning(`  ${note}`));
                    }
                    if (opts.open) await open(dev.link).catch(() => {});
                },
            });
        });

    dashboard
        .command('publish [dir]')
        .helpGroup('Apps:')
        .description('Upload an app to a public storage and point dashboards at it')
        .option('-s, --storage <id>', 'Storage of the app (created public if missing)')
        .option(
            '--to <destination>',
            'Dashboard to point (repeatable): dashboard:<id>, device:<id>, product:<id>, asset_type:<id>, asset_group:<id>, project:<id>',
            collect,
        )
        .option('--entry <page>', 'Page the destinations open (default index.html)')
        .option('--route <route>', 'Initial route of the destinations')
        .option('--name <name>', 'Name of a collection dashboard')
        .option('--prune', 'Delete files of the storage that are not in this upload')
        .option('--no-prune', "Keep the storage's other files (overrides the manifest)")
        .option('--bump', 'Make consoles that have the app open reload it at once')
        .option(
            '--preview [hours]',
            'Also print standalone preview links (read-only, 1 h by default)',
        )
        .option('--no-point', 'Upload without pointing the destinations (preview links only)')
        .option('--config <file>', `Manifest (default ${manifestName()})`)
        .option('-j, --json', 'Output as JSON')
        .action(async (dir, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: 'Publishing...',
                fn: async () => {
                    const manifest = readManifest(opts.config);
                    const folder = dir || manifest?.dir;
                    const to = opts.to ? flagDestinations(opts) : manifest?.to || [];
                    const prune = opts.prune ?? manifest?.prune;
                    const preview =
                        opts.preview === undefined
                            ? false
                            : opts.preview === true
                              ? true
                              : Number(opts.preview);
                    return publishApp({
                        storage: opts.storage || manifest?.storage,
                        files: folder ? collectFiles(folder) : undefined,
                        prune: !!prune,
                        to,
                        preview,
                        point: opts.point,
                        bump: !!opts.bump,
                        user,
                        dir: folder,
                    });
                },
                success: (r) => `Published ${r.storage}`,
                failure: 'Failed to publish',
                onSuccess: (result) => {
                    if (isJsonMode()) printOk(result);
                    else console.log(publishSummary(result, { point: opts.point }));
                },
            });
        });

    return dashboard;
}
