// @ts-check
import api from '../../api.js';
import { apiError } from '../../errors.js';
import { v1 } from '../../paths.js';
import { callDeviceResource, listDeviceResourcesWithSchemas } from '../../resource.js';
import { textResult } from '../helpers.js';

/** What a resource takes and gives, by its `fn`. */
const KIND = { 1: 'no params', 2: 'input', 3: 'output', 4: 'input/output' };

/**
 * The resources of a connected device (its firmware's API plus the API
 * resources its product adds), as a type of the resource tools: list
 * them, and run one with the `call` action. There is no get: reading a
 * resource without input runs it.
 *
 * @type {import('../tools-resource.js').LocalType}
 */
export const deviceResource = {
    description:
        "Resources of a connected device: its firmware's API (a sensor to read, an output to switch) plus the API resources its product adds. Not server resources. The device must be online.",
    parent: 'device',
    id: 'resource',
    recordId: 'name',

    ops: { list: 'Device_AccessResources' },
    notes: 'list gives each resource with its kind and its input and output shapes. Run one with the call action: with a body it runs with that input; without, it reads its output (a resource without input runs anyway).',
    async list(ctx) {
        const entries = await listDeviceResourcesWithSchemas(String(ctx.parent), {
            user: ctx.user,
        });
        return entries.map((e) => ({ ...e, kind: KIND[e.fn] ?? 'unknown' }));
    },
    actions: {
        call: {
            description:
                "Run a resource of a connected device with `body` as its input, and return its output; without a body it reads the output (a resource without input runs). Its input and output shapes are in the list of the device's resources.",
            op: ['Device_AccessInputResources', 'Device_AccessOutputResources'],
            examples: [
                {
                    tool: 'resource_call',
                    arguments: {
                        type: 'device_resource',
                        action: 'call',
                        ids: { device: 'boiler', resource: 'led' },
                        body: true,
                    },
                    does: 'Switch the resource led on (its input is a boolean).',
                },
                {
                    tool: 'resource_call',
                    arguments: {
                        type: 'device_resource',
                        action: 'call',
                        ids: { device: 'boiler', resource: 'temperature' },
                    },
                    does: 'Read the current output of the resource temperature.',
                },
            ],
            async run(body, ctx) {
                const data = await callDeviceResource(String(ctx.parent), String(ctx.id), body, {
                    user: ctx.user,
                });
                return textResult(
                    data === undefined || data === null || data === ''
                        ? '(no output)'
                        : typeof data === 'string'
                          ? data
                          : JSON.stringify(data, null, 2),
                    data ?? null,
                );
            },
        },
    },
};

/**
 * Usage of every device of the account, and their positions: an action on
 * the collection of devices.
 *
 * @type {import('../tools-resource.js').LocalAction}
 */
export const overview = {
    description:
        'Usage of all the devices of the account over the last 30 days, per day; with body {locations: true}, also the last known position of each connected device.',
    on: 'collection',
    readOnly: true,
    op: ['Device_ReadDevicesStatistics', 'User_ListDeviceLocations'],
    body: {
        type: 'object',
        additionalProperties: false,
        properties: {
            locations: {
                type: 'boolean',
                description: 'Also the last known position of each connected device.',
            },
        },
    },
    examples: [
        {
            tool: 'resource_call',
            arguments: { type: 'device', action: 'overview', body: { locations: true } },
            does: 'Usage of every device, and where the connected ones are.',
        },
    ],
    async run(body, ctx) {
        try {
            const [stats, locations] = await Promise.all([
                api.get(`${v1(ctx.user)}/info/devices/stats`),
                body?.locations ? api.get(`${v1(ctx.user)}/info/devices/locations`) : null,
            ]);
            return locations ? { stats: stats.data, locations: locations.data } : stats.data;
        } catch (e) {
            throw apiError(e);
        }
    },
};
