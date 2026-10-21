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
import { named, runTool } from './resources.js';
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
    readJsonArgument,
} from './_shared.js';

/**
 * Commands over the MCP tools that are not CRUD (write a bucket, upload
 * files, send device data, call a plugin…), run by the same handlers, plus
 * `product apply`. They go into the groups written by hand, or create the
 * group the generic resource commands then complete (storage, plugin).
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
 * The subcommand `name` of `program`, made with `description` when missing;
 * a detached one when the CLI has a command of that name without
 * subcommands (its own leaf).
 */
function groupOf(program, name, description) {
    const found = program.commands.find((c) => named(c, name));
    if (found) return found.commands.length ? found : new Command(name);
    return program.command(name).helpGroup('Resources:').description(description);
}

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

/**
 * @param {import('commander').Command} program
 * @param {{ device: import('commander').Command, product: import('commander').Command, bucket: import('commander').Command }} groups
 */
export function registerToolCommands(program, groups) {
    const json = (cmd) => cmd.option('-j, --json', 'Output as JSON');

    // ── bucket write ────────────────────────────────────────────────────
    json(
        bodyOptions(
            sub(groups.bucket, 'write <bucket>').description(
                'Write samples: one JSON object, an array of them with their ts (unix ms), or NDJSON',
            ),
        ).option('--ts <ms>', 'Timestamp of a single sample (unix ms)', parseNonNegativeInt('ts')),
    ).action(async (bucket, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts, { lines: true });
            if (data === undefined) throw inputError('give the samples with --from or --set');
            await runTool(handlers.bucket_data_write, {
                ...base,
                bucket,
                data,
                ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
            });
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(groups.bucket, 'export <bucket>')
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
            .option('--keep', 'Keep the export file on the server (listed by bucket-export list)'),
    ).action(async (bucket, opts, cmd) => {
        const { user } = start(opts, cmd);
        try {
            if (isJsonMode() && !opts.output)
                throw inputError('with --json, give the file with -o');
            const { file, data } = await exportBucket({
                bucket,
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
                printOk({ bucket, export: file, file: opts.output, bytes: data.length });
            else process.stderr.write(`Saved ${bucket} to ${opts.output}\n`);
        } catch (error) {
            fail(error);
        }
    });

    // ── device send ─────────────────────────────────────────────────────
    json(
        bodyOptions(
            sub(groups.device, 'send <device>')
                .helpGroup('State & resources:')
                .description(
                    "Send data as an HTTP device would: the server runs the device's callback",
                ),
        ),
    ).action(async (device, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts);
            if (data === undefined) throw inputError('give the data with --from or --set');
            await runTool(handlers.device_data_send, { ...base, device, data });
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(groups.device, 'overview')
            .helpGroup('Discovery:')
            .description('Usage of all the devices over the last 30 days, per day')
            .option('--locations', 'Also the last known position of each connected device'),
    ).action(async (opts, cmd) => {
        const base = start(opts, cmd);
        await runTool(handlers.device_overview, { ...base, locations: !!opts.locations });
    });

    // ── product resource / apply ────────────────────────────────────────
    json(
        bodyOptions(
            sub(groups.product, 'resource <product> <resource>')
                .helpGroup('Records:')
                .description(
                    'Call a product API resource for the whole product (needs its device_id_resolver)',
                ),
        ),
    ).action(async (product, resource, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const data = await bodyFromOptions(opts);
            await runTool(handlers.product_resource_call, {
                ...base,
                product,
                resource,
                ...(data !== undefined ? { data } : {}),
            });
        } catch (error) {
            fail(error);
        }
    });

    json(
        sub(groups.product, 'apply <file>')
            .helpGroup('Records:')
            .description(
                'Create or update a product from a JSON file as `product export` writes it (profile and properties included); - reads stdin',
            ),
    ).action(async (file, opts, cmd) => {
        const { user } = start(opts, cmd);
        try {
            const result = await applyProduct(await readJsonArgument(file), user);
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

    // ── storage files ───────────────────────────────────────────────────
    const storage = groupOf(program, 'storage', 'File storages and their files');

    json(
        sub(storage, 'files <storage> [folder]')
            .helpGroup('Files:')
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
        sub(storage, 'upload <storage> <local>')
            .helpGroup('Files:')
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
        sub(storage, 'download <storage> <path>')
            .helpGroup('Files:')
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
        sub(storage, 'rm <storage> <path>')
            .helpGroup('Files:')
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
    const plugin = groupOf(program, 'plugin', 'Plugins installed on the account');
    json(
        bodyOptions(
            sub(plugin, 'call <plugin> [path]')
                .helpGroup('Actions:')
                .description('Call the API a plugin serves, at its own path')
                .option(
                    '-X, --method <method>',
                    'get, post, put, patch or delete (default: get, or post with a body)',
                )
                .option(
                    '-q, --query <key=value>',
                    'Query parameter (repeatable)',
                    collectKeyString,
                ),
        ),
    ).action(async (id, path, opts, cmd) => {
        const base = start(opts, cmd);
        try {
            const body = await bodyFromOptions(opts);
            await runTool(handlers.plugin_call, {
                ...base,
                plugin: id,
                ...(path ? { path } : {}),
                method: (opts.method || (body !== undefined ? 'post' : 'get')).toLowerCase(),
                ...(body !== undefined ? { body } : {}),
                ...(opts.query ? { query: opts.query } : {}),
            });
        } catch (error) {
            fail(error);
        }
    });
}
