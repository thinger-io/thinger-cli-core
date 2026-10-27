// @ts-check
import api from '../api.js';
import { apiError, inputError } from '../errors.js';
import { device, v1 } from '../paths.js';
import { callDeviceResource, listDeviceResourcesWithSchemas } from '../resource.js';
import { textResult } from './helpers.js';

const text = textResult;
const json = (data) =>
    text(
        data === undefined || data === null || data === ''
            ? '(no output)'
            : typeof data === 'string'
              ? data
              : JSON.stringify(data, null, 2),
        data ?? null,
    );

function requireDevice(args) {
    if (!args.device) throw inputError('device is required');
    return args.device;
}

async function toolResourceList(args) {
    const entries = await listDeviceResourcesWithSchemas(requireDevice(args), {
        user: args.user,
    });
    const kind = (f) =>
        ({ 1: 'no params', 2: 'input', 3: 'output', 4: 'input/output' })[f] || 'unknown';
    const lines = entries.map((e) => {
        const parts = [`${e.name} [${kind(e.fn)}]`];
        if (e.in !== undefined) parts.push(`  in:  ${JSON.stringify(e.in)}`);
        if (e.out !== undefined) parts.push(`  out: ${JSON.stringify(e.out)}`);
        return parts.join('\n');
    });
    return text(lines.length ? lines.join('\n\n') : '(no resources)', entries);
}

async function toolResourceCall(args) {
    if (!args.resource) throw inputError('resource is required');
    return json(
        await callDeviceResource(requireDevice(args), args.resource, args.inputs, {
            user: args.user,
        }),
    );
}

async function toolDataSend(args) {
    const id = requireDevice(args);
    if (args.data === undefined) throw inputError('data is required');
    try {
        const res = await api.post(`${device(args.user, id)}/callback/data`, args.data);
        const answer = res.data;
        const shown =
            answer !== undefined &&
            answer !== '' &&
            (typeof answer !== 'object' || (answer && Object.keys(answer).length));
        return text(`Sent data to ${id}.${shown ? `\nAnswer: ${JSON.stringify(answer)}` : ''}`, {
            device: id,
            ...(shown ? { answer } : {}),
        });
    } catch (e) {
        throw apiError(e, { notFound: `Device not found: ${id}` });
    }
}

async function toolOverview(args) {
    try {
        const [stats, locations] = await Promise.all([
            api.get(`${v1(args.user)}/info/devices/stats`),
            args.locations ? api.get(`${v1(args.user)}/info/devices/locations`) : null,
        ]);
        return json(locations ? { stats: stats.data, locations: locations.data } : stats.data);
    } catch (e) {
        throw apiError(e);
    }
}

const deviceParam = { type: 'string', description: 'Device id.' };
const userParam = { type: 'string', description: 'Account to act on (admin only).' };

export const tools = [
    {
        name: 'device_resource_list',
        description:
            "List the resources a connected device exposes, with their input/output shapes: the device's own API, declared by its firmware (a sensor to read, an output to switch), plus the API resources its product adds. Not to be confused with server resources ({family:resource}). The device must be online.",
        inputSchema: {
            type: 'object',
            properties: { device: deviceParam, user: userParam },
            required: ['device'],
        },
        handler: toolResourceList,
    },
    {
        name: 'device_resource_call',
        description:
            'Call a resource of a connected device and return its output. With `inputs` it runs the resource; without them it only reads its output. See {tool:device_resource_list} for names and inputs.',
        inputSchema: {
            type: 'object',
            properties: {
                device: deviceParam,
                resource: { type: 'string', description: 'Resource name.' },
                inputs: { description: 'Input value or object the resource declares.' },
                user: userParam,
            },
            required: ['device', 'resource'],
        },
        handler: toolResourceCall,
    },
    {
        name: 'device_data_send',
        description:
            'Send data to the server on behalf of an HTTP device, as the device itself would: the server runs the callback configured for it (write a bucket, set a property, call an endpoint; see type device_callback).',
        inputSchema: {
            type: 'object',
            properties: {
                device: deviceParam,
                data: { description: 'JSON payload, e.g. {"temperature": 21.5}.' },
                user: userParam,
            },
            required: ['device', 'data'],
        },
        handler: toolDataSend,
    },
    {
        name: 'device_overview',
        description:
            'Usage of all the devices of the account over the last 30 days, per day; with `locations`, also the last known position of each connected device.',
        inputSchema: {
            type: 'object',
            properties: {
                locations: { type: 'boolean', description: 'Include device locations.' },
                user: userParam,
            },
            required: [],
        },
        handler: toolOverview,
    },
];
