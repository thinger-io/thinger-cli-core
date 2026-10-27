// @ts-check
import { getBucketData, getBuckets } from '../bucket.js';
import { hint, info, label, success } from '../format.js';
import { isJsonMode, printOk } from '../output.js';
import { hasListOptions, listOptions, listRecords } from './resources.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
    runCommand,
} from './_shared.js';

/**
 * `<cli> bucket list|read` — data buckets as a table and their time
 * series; the rest of the group (write, export, records, tags…) comes from
 * the tool and resource commands.
 */
export function registerBucketCommands(program) {
    const bucket = program
        .command('bucket')
        .helpGroup('Resources:')
        .description('Data buckets: records, time series, exports and tags');

    listOptions(
        bucket
            .command('list')
            .helpGroup('Records:')
            .description('List the data buckets of the account')
            .option('-j, --json', 'Output as JSON'),
    ).action(async (opts, cmd) => {
        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(cmd);
        await runCommand({
            start: 'Fetching buckets...',
            fn: () => (hasListOptions(opts) ? listRecords('bucket', opts, user) : getBuckets(user)),
            success: (buckets) => `Found ${buckets.length} bucket(s)`,
            failure: 'Failed to list buckets',
            onSuccess: (buckets) => {
                if (isJsonMode()) {
                    printOk(buckets);
                    return;
                }
                const idWidth = buckets.reduce(
                    (w, b) => Math.max(w, String(b.bucket ?? '').length),
                    0,
                );
                for (const b of buckets) {
                    const flag = b.enabled === false ? hint('disabled') : success('enabled ');
                    const extras = [
                        b.name && b.name !== b.bucket ? hint(`(${b.name})`) : '',
                        b.product ? info(`[${b.product}]`) : '',
                        b.config?.source ? hint(`source: ${b.config.source}`) : '',
                    ].filter(Boolean);
                    console.log(
                        `  ${flag}  ${label(String(b.bucket ?? '(no id)').padEnd(idWidth))}${extras.length ? '  ' + extras.join('  ') : ''}`,
                    );
                }
            },
        });
    });

    bucket
        .command('read <bucket>')
        .helpGroup('Data:')
        .description('Read samples from a bucket (latest first by default)')
        .option('-d, --device <device>', 'Series a product bucket keeps for this device')
        .option('-n, --items <n>', 'Number of samples', parsePositiveInt('items'), 10)
        .option('-m, --minutes <n>', 'Only the last N minutes', parsePositiveInt('minutes'))
        .option('--sort <order>', 'asc or desc', 'desc')
        .option('--agg <window>', 'Aggregation window, e.g. 5m, 1h')
        .option('--agg-type <reducer>', 'Reducer: mean, max, min, sum, count, first, last…')
        .option('--fields <list>', 'Comma-separated fields to return')
        .option('--group-by <key>', 'Group key, e.g. device')
        .option('-j, --json', 'Output as JSON')
        .action(async (id, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: `Reading ${id}...`,
                fn: () =>
                    getBucketData({
                        bucket: id,
                        device: opts.device,
                        user,
                        items: opts.items,
                        sort: opts.sort,
                        minutes: opts.minutes,
                        agg: opts.agg,
                        agg_type: opts.aggType,
                        fields: opts.fields,
                        group_by: opts.groupBy,
                    }),
                success: null,
                failure: 'Failed to read bucket',
                onSuccess: (data) => {
                    if (isJsonMode()) printOk(data);
                    else console.log(JSON.stringify(data, null, 2));
                },
            });
        });

    return bucket;
}
