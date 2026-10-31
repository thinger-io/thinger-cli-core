// @ts-check
import {
    DASHBOARD_TARGETS,
    checkDestination,
    collectFiles,
    destinationContext,
    manifestName,
    defaultStorage,
    listFiles,
    publishApp,
    publishSummary,
} from '../../dashboard.js';
import { devLink } from '../../dashboard-dev.js';
import { DEFAULT_TEMPLATE, initApp } from '../../dashboard-init.js';
import { inputError } from '../../errors.js';
import { opRef } from '../naming.js';

/**
 * Dashboard apps on the dashboard SDK: actions of the catalog type
 * dashboard that run on this machine (start a project, link its dev
 * server to the server) or upload its build (publish).
 */

async function toolInit(args) {
    args = args ?? {};
    if (args.to) checkDestination(args.to);
    const r = await initApp({
        dir: args.dir,
        template: args.template,
        to: args.to,
        storage: args.storage,
        from: args.from,
        ci: args.ci,
        install: args.install,
    });
    return {
        content: [
            {
                type: 'text',
                text: [
                    `Created ${r.dir}: ${r.template} app on @thinger-io/dashboard-sdk ${r.dependency}, with ${manifestName()} (publishes ${r.build} to storage ${r.storage}${args.to ? '' : '; add destinations under dashboard.to'}) and AGENTS.md (how to develop it and the rules of the console's frame: read it).`,
                    `Next: ${r.installed ? '' : 'npm install, then '}${r.devCommand} in the background (it serves ${r.devUrl}), ${opRef('dashboard', 'dev')} with url ${r.devUrl}${Object.keys(r.context).length ? '' : ' and a context'} and dir ${r.dir}, open the link with browser tools; when it works, npm run build and ${opRef('dashboard', 'publish')} with dir ${r.dir}/${r.build}.`,
                ].join('\n'),
            },
        ],
        isError: false,
    };
}

async function toolDev(args, ctx) {
    args = args ?? {};
    if (!args.url) throw inputError("pass url: the app's dev server, e.g. http://localhost:4200/");
    if (args.to && args.context) throw inputError('pass to or context, not both');
    if (args.to) checkDestination(args.to);
    const dev = await devLink({
        url: args.url,
        context: args.to ? destinationContext(args.to) : args.context,
        route: args.route ?? args.to?.route,
        hours: args.hours,
        user: ctx.user,
        dir: args.dir || process.cwd(),
        allowRemote: args.allow_remote === true,
    });
    const shown = Object.entries(dev.context).map(([k, v]) => `${k} ${v}`);
    const until = new Date(dev.expire).toISOString().slice(0, 16).replace('T', ' ');
    return {
        content: [
            {
                type: 'text',
                text: [
                    `Open this link in a browser: ${dev.link}`,
                    `It opens ${dev.app} as a standalone page against ${dev.server} as ${dev.user}${shown.length ? `, context ${shown.join(', ')}` : ''}
, with a temporary token (${dev.token}, full access, until ${until} UTC; a new link replaces it). Calls reach the real server: writes are real.`,
                    ...dev.notes.map((n) => `Check: ${n}`),
                    "The app's dev server reloads it on every change; its errors are in the browser console. Unlike in the console's sandboxed iframe, localStorage, cookies and a <base> tag work here, so do not rely on them.",
                    `When it works, build it and publish the build once with ${opRef('dashboard', 'publish')}.`,
                ].join('\n'),
            },
        ],
        isError: false,
    };
}

async function toolPublish(args, ctx) {
    args = args ?? {};
    if (args.dir && args.files) throw inputError('pass dir or files, not both');
    if (args.files) {
        if (typeof args.files !== 'object' || Array.isArray(args.files)) {
            throw inputError('files must be an object of { "path": "content" }');
        }
        for (const [file, content] of Object.entries(args.files)) {
            if (typeof content !== 'string') throw inputError(`files["${file}"] must be a string`);
        }
    }
    const files = args.dir ? collectFiles(args.dir) : args.files;
    // Pruning deletes files of the storage: say which before doing it.
    const to = Array.isArray(args.to) ? args.to : [];
    const storage =
        args.storage ||
        (to.length === 1 && (to[0].dashboard || (to[0].type && to[0].id))
            ? defaultStorage(to[0].dashboard, to[0].dashboard ? undefined : to[0])
            : undefined);
    if (args.prune && files && storage && !ctx.confirmed) {
        const gone = (await listFiles(storage, ctx.user)).filter((f) => !(f in files));
        const shown =
            gone.slice(0, 50).join(', ') + (gone.length > 50 ? ` (+${gone.length - 50})` : '');
        return ctx.plan(
            `It would upload ${Object.keys(files).length} file(s) to storage ${storage} and delete the ${gone.length} file(s) of it that are not in this upload${gone.length ? `: ${shown}` : ''}.`,
        );
    }
    const result = await publishApp({
        storage: args.storage,
        files,
        prune: args.prune,
        to: args.to,
        preview: args.preview,
        point: args.point,
        bump: args.bump,
        user: ctx.user,
        dir: args.dir,
    });
    return {
        content: [{ type: 'text', text: publishSummary(result, { point: args.point }) }],
        isError: false,
    };
}

/** @type {Record<string, import('../tools-resource.js').LocalAction>} */
export const dashboardActions = {
    init: {
        on: 'collection',
        local: true,
        description: `Create a dashboard app: a TypeScript project on @thinger-io/dashboard-sdk from one of the templates the SDK package ships (react by default, angular…), with its manifest for its dev and publish actions and an AGENTS.md with the rules of the console's frame. Start every new dashboard app here instead of writing one from scratch.`,
        body: {
            type: 'object',
            additionalProperties: false,
            properties: {
                dir: {
                    type: 'string',
                    description:
                        'New (or empty) folder for the app. Absolute, or relative to the folder this MCP server runs in.',
                },
                template: {
                    type: 'string',
                    description: `Template of the SDK package (default ${DEFAULT_TEMPLATE}).`,
                },
                to: {
                    type: 'object',
                    description:
                        'Where it publishes, as in publish: {type, id}, or {dashboard}. Its context is the one dev uses.',
                    properties: {
                        dashboard: { type: 'string' },
                        type: { type: 'string', enum: DASHBOARD_TARGETS },
                        id: { type: 'string' },
                    },
                },
                storage: {
                    type: 'string',
                    description: 'Storage it publishes to (default app_<folder>_<random>).',
                },
                from: {
                    type: 'string',
                    description:
                        'SDK package to take the template from: a version or tag on npm (default the latest release), or a local folder or .tgz of it.',
                },
                ci: {
                    type: 'boolean',
                    description: 'Add a GitHub workflow that publishes it on push to main.',
                },
                install: { type: 'boolean', description: 'Run npm install.' },
            },
            required: ['dir'],
        },
        examples: [
            {
                tool: 'resource_call',
                arguments: {
                    type: 'dashboard',
                    action: 'init',
                    body: { dir: 'plant-dashboard', to: { type: 'project', id: 'plant_a' } },
                },
                does: 'Start a React dashboard app that publishes as the dashboard of project plant_a.',
            },
        ],
        run: (body) => toolInit(body),
    },
    dev: {
        on: 'collection',
        local: true,
        description: `Develop a dashboard app on its own dev server (ng serve, npm run dev…) against this server, then publish it once with its publish action, instead of publishing to try every change.

Returns a link to the app's local url that opens it as a standalone page: the SDK reads the server, a temporary token and the context from the link and calls the server directly, so the app gets real data, its dev server reloads it on every change and its errors are in the browser console. Start the app's dev server first (the answer says when nothing answers at url). Open the link with the browser tools to see the app and read its console. Each call replaces the previous link's token.`,
        body: {
            type: 'object',
            additionalProperties: false,
            properties: {
                url: {
                    type: 'string',
                    description:
                        'The app on its dev server, e.g. http://localhost:4200/ (a #route in it is kept).',
                },
                to: {
                    type: 'object',
                    description:
                        'Destination whose context the app gets, as in publish: {type, id}, or {dashboard} for a collection dashboard (no context).',
                    properties: {
                        dashboard: { type: 'string' },
                        type: { type: 'string', enum: DASHBOARD_TARGETS },
                        id: { type: 'string' },
                        route: { type: 'string' },
                    },
                },
                context: {
                    type: 'object',
                    description:
                        'Or the SDK context itself: device, product, type, group, project ids.',
                },
                route: { type: 'string', description: 'Initial route, e.g. "/devices".' },
                dir: {
                    type: 'string',
                    description:
                        "The app's project folder, to check its SDK against this server (default: the folder this MCP server runs in).",
                },
                hours: {
                    type: 'number',
                    description: 'Hours the temporary token lasts (default 8, up to 168).',
                },
                allow_remote: {
                    type: 'boolean',
                    description:
                        'Allow a url that is not on this machine. The link carries a full-access token: only for a dev server the user named and trusts.',
                },
            },
            required: ['url'],
        },
        run: (body, ctx) => toolDev(body, ctx),
    },
    publish: {
        on: 'collection',
        local: true,
        confirm: true,
        op: ['Storage_UpdateFilesFiles(?<file>.*$)', 'Dashboard_Create', 'Dashboard_Update'],
        description: `Publish an HTML app to a public storage and point dashboards at it. Upload (dir or files) and point (to) are both optional: upload a new build, point more dashboards at an app already uploaded, or both. Read the dashboard SDK reference first ({op:dashboard.describe}).

Destinations (to): {dashboard} for the dashboards collection (created if missing, empty context), or {type, id} to set the "dashboard" property of a device, product, asset_type, asset_group or project, whose id the page gets in Thinger.context. Each may open its own entry page and an initial hash route.

One app can serve many dashboards: name its storage (e.g. app_<project>) and upload the build output folder with prune: true (hashed file names change between builds). Dashboards point at the storage folder (…/files/, served as the storage's index) or at another entry page by name, without version queries: files are served with no-cache and an ETag, so viewers always get the latest upload. Apps in the iframe: start them with the init action (a TypeScript project on @thinger-io/dashboard-sdk with these rules set up and an AGENTS.md); hash routing, relative asset URLs and no <base> tag, render after Thinger.ready(), and no localStorage or cookies (opaque origin: keep state in properties through the SDK). Publish the build output folder; the answer warns when the app's SDK needs a newer server than this one, is not the latest on npm, or a page loads the deprecated script build (thinger-dashboard.js).`,
        body: {
            type: 'object',
            additionalProperties: false,
            properties: {
                storage: {
                    type: 'string',
                    description:
                        'Public storage of the app (created if missing). Required unless there is one destination.',
                },
                dir: {
                    type: 'string',
                    description:
                        'Local folder to upload, subfolders included (e.g. dist/app/browser).',
                },
                files: {
                    type: 'object',
                    description: 'Or files inline: {"index.html": "<html>…"}.',
                },
                prune: {
                    type: 'boolean',
                    description:
                        'Delete files of the storage that are not in this upload (asks first: see confirm).',
                },
                to: {
                    type: 'array',
                    description: 'Dashboards to point at the app.',
                    items: {
                        type: 'object',
                        properties: {
                            dashboard: { type: 'string', description: 'Collection dashboard id.' },
                            type: { type: 'string', enum: DASHBOARD_TARGETS },
                            id: { type: 'string' },
                            entry: { type: 'string', description: 'Page (default index.html).' },
                            route: {
                                type: 'string',
                                description: 'Initial route, e.g. "/devices".',
                            },
                            name: { type: 'string', description: 'Collection dashboard name.' },
                        },
                    },
                },
                bump: {
                    type: 'boolean',
                    description:
                        'Add ?v=<publish time> to the dashboard urls so consoles that have the app open reload it at once (otherwise they get the new files on their next load).',
                },
                preview: {
                    type: ['boolean', 'number'],
                    description:
                        'Also return standalone links to review or share each destination in a browser (whole page, scrollable, unlike the console iframe). true: valid 1 h; a number: that many hours (up to 720). Each link carries a read-only access token, one per app and project, replaced by the next preview (older links stop working); actions in the app (device resource calls, writes) answer 403 there. With only storage and preview, it links to the app without context.',
                },
                point: {
                    type: 'boolean',
                    description:
                        'false: only build preview links for `to`, without pointing those dashboards again.',
                },
            },
            required: [],
        },
        examples: [
            {
                tool: 'resource_call',
                arguments: {
                    type: 'dashboard',
                    action: 'publish',
                    body: {
                        dir: './dist',
                        storage: 'app_plant',
                        to: [{ dashboard: 'plant_overview' }],
                    },
                },
                does: 'Upload the build in ./dist to storage app_plant and point dashboard plant_overview at it.',
            },
        ],
        run: (body, ctx) => toolPublish(body, ctx),
    },
};
