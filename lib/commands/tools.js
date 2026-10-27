// @ts-check
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { tools as bucketTools } from '../mcp/tools-buckets.js';
import { tools as deviceTools } from '../mcp/tools-devices.js';
import { tools as pluginTools } from '../mcp/tools-plugins.js';
import { tools as productTools } from '../mcp/tools-products.js';
import { tools as storageTools } from '../mcp/tools-storage.js';
import { applyProduct } from '../product-apply.js';
import { exportBucket } from '../bucket-export.js';
import { rawApiCall } from '../raw-api.js';
import { storageFilePath } from '../storage.js';
import { inputError } from '../errors.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import { formatDeviceResourcesWithSchemas } from '../resource.js';
import { groupAt, named, runTool } from './resources.js';
import { DATA } from '../mcp/helpers.js';
import {
    applyJsonFlag,
    bodyFromOptions,
    bodyOptions,
    collectKeyString,
    confirmDestructive,
    ensureConfigured,
    getGlobalUser,
    parseNonNegativeInt,
} from './_shared.js';

/**
 * Commands over the MCP tools that are not CRUD (write a bucket, upload
 * files, send device data, call a device resource or a plugin…), run by
 * the same handlers, plus `product apply`. They go into the groups written
 * by hand, or create the groups the generic resource commands then
 * complete (`storage file`, `product profile api`).
 */

const handlers = Object.fromEntries(
    [...bucketTools, ...deviceTools, ...pluginTools, ...productTools, ...storageTools].map((t) => [
        t.name,
        t.handler,
    ]),
);

/** Report a failure the way every command does. */
function fail(error) {
    const { message, code } = classifyError(error);
    printErr(message, { code });
}

/** Prepare a command's run: --json, a profile, the --user of the root. */
function start(opts, cmd) {
    applyJsonFlag(opts);
    ensureConfigured();
    const user = getGlobalUser(cmd);
    return user ? { user } : {};
}

/**
 * The group at `path` (see groupAt), or a detached one (never shown or
 * run) when the CLI has a command without subcommands on the way: its own
 * leaf.
 *
 * @param {Command} program
 * @param {string[]} path
 */
const groupOf = (program, path) => groupAt(program, path) ?? new Command(path.at(-1));

/**
 * A new subcommand of `group`, or a detached one (never shown or run) when
 * the group already has one of that name: the CLI's own commands win.
 *
 * @param {Command} group
 * @param {string} usage
 */
function sub(group, usage) {
    const name = usage.split(' ')[0];
    if (group.commands.some((c) => named(c, name))) return new Command(name);
    return group.command(usage);
}

/** @param {import('commander').Command} program */
export function registerToolCommands(program) {
    const json = (cmd) => cmd.option('-j, --json', 'Output as JSON');
    const device = groupOf(program, ['device']);
    const product = groupOf(program, ['product']);
    const bucket = groupOf(program, ['bucket']);

    // ── bucket write / export ───────────────────────────────────────────
    json(
        bodyOptions(
            sub(bucket, 'write <bucket>')
                .helpGroup('Data:')
                .description(
                    'Write samples: one JSON object, an array of them with their ts (unix ms), or NDJSON',
                ),
        ).option('--ts <ms>', 'Timestamp of a single sample (unix ms)', parseNonNegativeInt('ts')),
    ).action(async (id, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts, { lines: true });
            if (data === undefined) throw inputError('give the samples with --from or --set');
            await runTool(handlers.bucket_data_write, {
                ...base,
                bucket: id,
                data,
                ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
            });
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(bucket, 'export <bucket>')
            .helpGroup('Data:')
            .description('Export the data of a bucket to a file (or stdout) and download it')
            .option('-o, --output <file>', 'Write it to this file')
            .option('--format <format>', 'csv, json or arff', 'csv')
            .option('--timestamps <format>', 'iso, seconds or milliseconds', 'iso')
            .option(
                '--min-ts <ms>',
                'From (unix ms; default: the first sample)',
                parseNonNegativeInt('min-ts'),
            )
            .option(
                '--max-ts <ms>',
                'To (unix ms; default: the last sample)',
                parseNonNegativeInt('max-ts'),
            )
            .option(
                '--keep',
                'Keep the export file on the server (listed by bucket export-file list)',
            ),
    ).action(async (id, opts, cmd) => {
        const { user } = start(opts, cmd);
        try {
            if (isJsonMode() && !opts.output)
                throw inputError('with --json, give the file with -o');
            const { file, data } = await exportBucket({
                bucket: id,
                user,
                format: opts.format,
                timestamps: opts.timestamps,
                minTs: opts.minTs,
                maxTs: opts.maxTs,
                keep: !!opts.keep,
            });
            if (!opts.output) return void process.stdout.write(data);
            await writeFile(opts.output, data);
            if (isJsonMode())
                printOk({ bucket: id, export: file, file: opts.output, bytes: data.length });
            else process.stderr.write(`Saved ${id} to ${opts.output}\n`);
        } catch (error) {
            fail(error);
        }
    });

    // ── device send / overview ──────────────────────────────────────────
    json(
        bodyOptions(
            sub(device, 'send <device>')
                .helpGroup('Data:')
                .description(
                    "Send data as an HTTP device would: the server runs the device's callback",
                ),
        ),
    ).action(async (id, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts);
            if (data === undefined) throw inputError('give the data with --from or --set');
            await runTool(handlers.device_data_send, { ...base, device: id, data });
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(device, 'overview')
            .helpGroup('Data:')
            .description('Usage of all the devices over the last 30 days, per day')
            .option('--locations', 'Also the last known position of each connected device'),
    ).action(async (opts, cmd) => {
        const base = start(opts, cmd);
        await runTool(handlers.device_overview, { ...base, locations: !!opts.locations });
    });

    // ── device resource list / call ─────────────────────────────────────
    const resource = groupOf(program, ['device', 'resource']);

    json(
        sub(resource, 'list <device>')
            .helpGroup('Records:')
            .description(
                'List the resources a connected device exposes, with their inputs and outputs',
            ),
    ).action(async (id, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const result = await handlers.device_resource_list({ ...base, device: id });
            if (isJsonMode()) printOk(result[DATA]);
            else console.log(formatDeviceResourcesWithSchemas(id, result[DATA]));
        } catch (error) {
            fail(error);
        }
    });

    json(
        bodyOptions(
            sub(resource, 'call <device> <resource>')
                .helpGroup('Data:')
                .description(
                    'Call a resource of a connected device: with --from or --set it runs it with that input; without, it reads its output',
                )
                .option('-f, --field <path>', 'Print only this field of the answer (dot path)')
                .option('-o, --output <file>', 'Write the answer to a file'),
        ),
    ).action(async (id, name, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const inputs = await bodyFromOptions(opts);
            await runTool(
                handlers.device_resource_call,
                {
                    ...base,
                    device: id,
                    resource: name,
                    ...(inputs !== undefined ? { inputs } : {}),
                },
                { output: opts.output, field: opts.field },
            );
        } catch (error) {
            fail(error);
        }
    });

    // ── product apply / profile api call ────────────────────────────────
    json(
        bodyOptions(
            sub(product, 'apply')
                .helpGroup('Actions:')
                .description(
                    'Create or update a product from the JSON `product export` writes (profile and properties included)',
                ),
        ),
    ).action(async (opts, cmd) => {
        const { user } = start(opts, cmd);
        try {
            const doc = await bodyFromOptions(opts);
            if (doc === undefined) throw inputError('give the product with --from <file|->');
            const result = await applyProduct(doc, user);
            if (isJsonMode()) return printOk(result);
            const props = [
                result.properties.created.length && `${result.properties.created.length} created`,
                result.properties.updated.length && `${result.properties.updated.length} updated`,
            ].filter(Boolean);
            console.log(
                `${result.created ? 'Created' : 'Updated'} product ${result.product}${props.length ? `; properties: ${props.join(', ')}` : ''}.`,
            );
            if (result.ignored) console.log(`Left as they are: ${result.ignored.join(', ')}.`);
        } catch (error) {
            fail(error);
        }
    });

    json(
        bodyOptions(
            sub(groupOf(program, ['product', 'profile', 'api']), 'call <product> <api>')
                .helpGroup('Data:')
                .description(
                    'Call a product API resource for the whole product (needs its device_id_resolver)',
                )
                .option('-f, --field <path>', 'Print only this field of the answer (dot path)')
                .option('-o, --output <file>', 'Write the answer to a file'),
        ),
    ).action(async (id, api, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts);
            await runTool(
                handlers.product_resource_call,
                { ...base, product: id, resource: api, ...(data !== undefined ? { data } : {}) },
                { output: opts.output, field: opts.field },
            );
        } catch (error) {
            fail(error);
        }
    });

    // ── storage file list / upload / download / delete ──────────────────
    const file = groupOf(program, ['storage', 'file']);

    json(
        sub(file, 'list <storage> [folder]')
            .helpGroup('Records:')
            .description('List the files of a storage, or of a folder in it'),
    ).action(async (id, folder, opts, cmd) => {
        const base = start(opts, cmd);
        await runTool(handlers.storage_file_list, {
            ...base,
            storage: id,
            ...(folder ? { path: folder } : {}),
        });
    });

    json(
        sub(file, 'upload <storage> <local>')
            .helpGroup('Data:')
            .description(
                'Upload a local file or folder (binary too), overwriting what is there; folders on the way are created',
            )
            .option('--to <path>', 'Where in the storage: a file path, or the folder for a folder'),
    ).action(async (id, local, opts, cmd) => {
        const base = start(opts, cmd);
        await runTool(handlers.storage_file_write, {
            ...base,
            storage: id,
            local,
            ...(opts.to ? { path: opts.to } : {}),
        });
    });

    json(
        sub(file, 'download <storage> <path>')
            .helpGroup('Data:')
            .description('Download a file: to -o, or printed (text) / piped (binary)')
            .option('-o, --output <file>', 'Write it to this file'),
    ).action(async (id, path, opts, cmd) => {
        const { user } = start(opts, cmd);
        try {
            const clean = String(path).replace(/^\/+/, '');
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw inputError(`invalid storage id: "${id}"`);
            const res = await rawApiCall({
                path: `/v2/users/{user}/storages/${id}/files/${storageFilePath(clean)}`,
                user,
            });
            const bytes = res.raw;
            if (opts.output) {
                await writeFile(opts.output, bytes);
                if (isJsonMode()) printOk({ storage: id, path: clean, file: opts.output });
                else process.stderr.write(`Saved ${clean} to ${opts.output}\n`);
                return;
            }
            if (isJsonMode() || (res.kind === 'binary' && process.stdout.isTTY)) {
                throw inputError(
                    `save it with -o <file>${res.kind === 'binary' ? ': it is binary' : ''}`,
                );
            }
            process.stdout.write(bytes);
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(file, 'delete <storage> <path>')
            .helpGroup('Records:')
            .description('Delete a file of a storage')
            .option('-y, --yes', 'Do not ask for confirmation'),
    ).action(async (id, path, opts, cmd) => {
        const base = start(opts, cmd);
        if (!(await confirmDestructive(opts, `Delete ${path} from storage ${id}?`))) return;
        try {
            const result = await handlers.storage_file_delete({ ...base, storage: id, path });
            // A file that was not there is a failure for a script.
            if (!result[DATA]?.deleted)
                throw Object.assign(new Error(`No such file: ${path}`), { code: 'not_found' });
            if (isJsonMode()) printOk(result[DATA]);
            else console.log(result.content[0].text);
        } catch (error) {
            fail(error);
        }
    });

    // ── plugin call ─────────────────────────────────────────────────────
    json(
        bodyOptions(
            sub(groupOf(program, ['plugin']), 'call <plugin> [path]')
                .helpGroup('Data:')
                .description('Call the API a plugin serves, at its own path')
                .option(
                    '-X, --method <method>',
                    'get, post, put, patch or delete (default: get, or post with a body)',
                )
                .option('-q, --query <key=value>', 'Query parameter (repeatable)', collectKeyString)
                .option('-f, --field <path>', 'Print only this field of the answer (dot path)')
                .option('-o, --output <file>', 'Write the answer to a file'),
        ),
    ).action(async (id, path, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const body = await bodyFromOptions(opts);
            await runTool(
                handlers.plugin_call,
                {
                    ...base,
                    plugin: id,
                    ...(path ? { path } : {}),
                    method: (opts.method || (body !== undefined ? 'post' : 'get')).toLowerCase(),
                    ...(body !== undefined ? { body } : {}),
                    ...(opts.query ? { query: opts.query } : {}),
                },
                { output: opts.output, field: opts.field },
            );
        } catch (error) {
            fail(error);
        }
    });
}
