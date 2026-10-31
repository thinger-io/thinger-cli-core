// @ts-check
import api from '../../api.js';
import { TIMEOUTS } from '../../constants.js';
import { getBucketData } from '../../bucket.js';
import { apiError, inputError } from '../../errors.js';
import { v1 } from '../../paths.js';

/**
 * The time series of a bucket, as a type of the resource tools: `list`
 * reads it with the server's own query (not paged by the tool), `create`
 * writes samples.
 *
 * @type {import('../tools-resource.js').LocalType}
 */
export const bucketData = {
    description: 'The time series of a bucket: list reads it, create writes samples.',
    parent: 'bucket',
    paged: false,
    ops: { list: ['Bucket_ReadData', 'Device_ReadBucketData'], create: 'Bucket_WriteData' },
    filter: {
        type: 'object',
        additionalProperties: false,
        properties: {
            device: {
                type: 'string',
                description:
                    'Device id, to read only its records: the bucket needs the `device` tag (product buckets have it).',
            },
            items: {
                type: 'number',
                description: 'Samples to return (default 10, at most 1000; `count` sets it too).',
            },
            minutes: { type: 'number', description: 'Last N minutes (instead of min_ts/max_ts).' },
            min_ts: { type: 'number', description: 'From (unix ms).' },
            max_ts: { type: 'number', description: 'To (unix ms, 0 = now).' },
            sort: { type: 'string', enum: ['desc', 'asc'], description: 'By time (default desc).' },
            agg: { type: 'string', description: 'Aggregation window: "5m", "1h", "1d"…' },
            agg_type: {
                type: 'string',
                enum: [
                    'mean',
                    'max',
                    'min',
                    'sum',
                    'count',
                    'first',
                    'last',
                    'mode',
                    'median',
                    'spread',
                    'stddev',
                ],
                description: 'Reducer of each aggregation window.',
            },
            tz: {
                type: 'string',
                description:
                    'IANA time zone for the aggregation windows, e.g. "Europe/Madrid": "1d" then cuts at local midnight (default UTC).',
            },
            fields: {
                type: ['string', 'array'],
                items: { type: 'string' },
                description:
                    'Fields to return: comma-separated or an array. Without fields, an aggregation covers numeric fields only (those of the latest record in the range); name string fields explicitly to read them with last, first, mode or count.',
            },
            group_by: { type: 'string', description: 'Group key, e.g. "device".' },
        },
    },
    schema: {
        type: ['object', 'array'],
        description:
            'One sample ({"temperature": 21.5}), stored now or at its `ts` (unix ms), or an array of samples each with its numeric `ts` (MongoDB and InfluxDB buckets).',
    },
    notes: 'Without filter.device a list reads the whole bucket: a bucket declared in a product profile holds every device of the product interleaved, and filter {"group_by": "device"} gives one row per device when samples carry that tag. With filter.device, the series the bucket keeps for that device. Writes need a bucket whose data source accepts API writes; servers limit how often a bucket can be written (429 when exceeded): for long histories, import a CSV ({op:bucket.import}).',
    examples: [
        {
            tool: 'resource_list',
            arguments: {
                type: 'bucket_data',
                ids: { bucket: 'temps' },
                filter: {
                    min_ts: 1793314800000,
                    max_ts: 1793401199999,
                    agg: '1h',
                    agg_type: 'mean',
                    tz: 'Europe/Madrid',
                    fields: ['temperature'],
                    items: 1000,
                    sort: 'asc',
                },
            },
            does: "Hourly mean of temperature over one local day: min_ts and max_ts are that day's start and end in Europe/Madrid, as unix ms.",
        },
        {
            tool: 'resource_list',
            arguments: {
                type: 'bucket_data',
                ids: { bucket: 'temps' },
                filter: { device: 'boiler', items: 10 },
            },
            does: 'The last 10 samples of one device in a product bucket.',
        },
        {
            tool: 'resource_create',
            arguments: {
                type: 'bucket_data',
                ids: { bucket: 'temps' },
                body: [
                    { ts: 1793314800000, temperature: 21.5 },
                    { ts: 1793318400000, temperature: 22 },
                ],
            },
            does: 'Write two samples, each at its own time.',
        },
    ],
    list(ctx) {
        const filter = ctx.filter || {};
        return getBucketData({
            bucket: String(ctx.parent),
            ...filter,
            items: filter.items ?? ctx.count ?? 10,
            sort: filter.sort ?? 'desc',
            fields: Array.isArray(filter.fields) ? filter.fields.join(',') : filter.fields,
            user: ctx.user,
        });
    },
    async create(body, ctx) {
        if (!body || typeof body !== 'object') {
            throw inputError('body must be a JSON object (one sample) or an array of them');
        }
        // One sample's ts goes in the query, where the server reads it.
        let data = body;
        let params;
        if (!Array.isArray(body) && body.ts !== undefined) {
            const { ts, ...rest } = body;
            data = rest;
            params = { ts };
        }
        const samples = Array.isArray(body) ? body.length : 1;
        try {
            await api.post(
                `${v1(ctx.user)}/buckets/${encodeURIComponent(String(ctx.parent))}/data`,
                data,
                { params, timeout: TIMEOUTS.API_LONG_MS },
            );
        } catch (e) {
            throw apiError(e, { notFound: `Bucket not found: ${ctx.parent}` });
        }
        return { bucket: ctx.parent, samples };
    },
};
