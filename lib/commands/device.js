// @ts-check
import {
    CREDENTIAL_DEVICE_TYPES,
    DEVICE_TYPES,
    createDevice,
    deleteDevice,
    generateDeviceCredentials,
    getDevice,
    getDevices,
} from '../devices.js';
import {
    formatDeviceProperties,
    formatDeviceProperty,
    getDeviceProperties,
    getDeviceProperty,
    setDeviceProperty,
} from '../property.js';
import {
    callDeviceResource,
    formatDeviceResourcesWithSchemas,
    listDeviceResourcesWithSchemas,
} from '../resource.js';
import { setDeviceProduct } from '../product.js';
import { hint, info, label, success, warning } from '../format.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import {
    applyJsonFlag,
    collectKeyValue,
    confirmDestructive,
    ensureConfigured,
    extractField,
    getGlobalUser,
    parseJsonValue,
    runCommand,
} from './_shared.js';

/**
 * `<cli> device <action> <deviceId> …` — device records, their properties
 * and the resources they expose.
 */
export function registerDeviceCommands(program) {
    const device = program
        .command('device')
        .helpGroup('Operations:')
        .description('Devices: list, inspect, create, delete, properties and resources');

    device
        .command('list [pattern]')
        .helpGroup('Discovery:')
        .description(
            'List devices, optionally filtered by name/id pattern (case-insensitive regex)',
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (pattern, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const filter = pattern ? { name: pattern } : {};
            await runCommand({
                start: pattern
                    ? `Searching devices matching "${pattern}"...`
                    : 'Fetching devices...',
                fn: () => getDevices(filter, user),
                success: (devices) => `Found ${devices.length} device(s)`,
                failure: 'Failed to list devices',
                onSuccess: (devices) => {
                    if (isJsonMode()) {
                        printOk(devices);
                        return;
                    }
                    // Pad the id column so trailing names line up even when
                    // ids have very different widths. A record without an id
                    // can exist (a broken document on the server): show it
                    // rather than fail the whole listing.
                    const idOf = (d) => d.device ?? '(no id)';
                    const idWidth = devices.reduce((w, d) => Math.max(w, idOf(d).length), 0);
                    for (const d of devices) {
                        const online = d.connection?.active ? success('online ') : hint('offline');
                        const id = label(idOf(d).padEnd(idWidth));
                        const extras = [
                            d.name ? hint(`(${d.name})`) : '',
                            d.type && d.type !== 'Generic' ? hint(`<${d.type}>`) : '',
                            d.product ? info(`[${d.product}]`) : '',
                        ].filter(Boolean);
                        console.log(
                            `  ${online}  ${id}${extras.length ? '  ' + extras.join(' ') : ''}`,
                        );
                    }
                },
            });
        });

    device
        .command('info <deviceId>')
        .helpGroup('Discovery:')
        .description('Show the server record of a device (type, product, connection…)')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: `Fetching ${deviceId}...`,
                fn: () => getDevice(deviceId, user),
                success: null,
                failure: 'Failed to read device',
                onSuccess: (record) => {
                    if (isJsonMode()) printOk(record);
                    else console.log(JSON.stringify(record, null, 2));
                },
            });
        });

    device
        .command('create <deviceId>')
        .helpGroup('Records:')
        .description('Register a device; Generic/MQTT ones get random credentials unless given')
        .option('-t, --type <type>', `Device type: ${DEVICE_TYPES.join(', ')}`, 'Generic')
        .option('-c, --credentials <credentials>', 'Device credentials (6+ characters)')
        .option('-n, --name <name>', 'Display name')
        .option('-d, --description <text>', 'Description')
        .option('-p, --product <productId>', 'Assign to a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (!DEVICE_TYPES.includes(opts.type)) {
                printErr(`--type must be one of ${DEVICE_TYPES.join(', ')}`, {
                    code: 'input_error',
                });
                return;
            }
            const needsCredentials = CREDENTIAL_DEVICE_TYPES.has(opts.type);
            if (!needsCredentials && opts.credentials) {
                printErr(`${opts.type} devices do not take credentials`, { code: 'input_error' });
                return;
            }
            if (opts.credentials && opts.credentials.length < 6) {
                printErr('credentials must be at least 6 characters', { code: 'input_error' });
                return;
            }
            const credentials = needsCredentials
                ? opts.credentials || generateDeviceCredentials()
                : undefined;
            await runCommand({
                start: `Creating ${deviceId}...`,
                fn: () =>
                    createDevice(
                        {
                            device: deviceId,
                            type: opts.type,
                            name: opts.name,
                            description: opts.description,
                            credentials,
                            product: opts.product,
                        },
                        user,
                    ),
                success: `Created ${opts.type} device ${deviceId}`,
                failure: 'Failed to create device',
                onSuccess: (sent) => {
                    if (isJsonMode()) {
                        printOk(sent);
                        return;
                    }
                    if (credentials) {
                        console.log(`  credentials: ${label(credentials)}`);
                        console.log(
                            hint(
                                '  Stored hashed on the server: this is the only time they are shown.',
                            ),
                        );
                    }
                },
            });
        });

    device
        .command('delete <deviceId>')
        .helpGroup('Records:')
        .description('Delete a device record from the platform (irreversible)')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (
                !(await confirmDestructive(
                    opts,
                    `Delete device ${deviceId}? This cannot be undone.`,
                ))
            ) {
                console.log(hint('Cancelled.'));
                return;
            }
            try {
                const removed = await deleteDevice(deviceId, user);
                if (isJsonMode()) {
                    printOk({ device: deviceId, removed });
                    return;
                }
                console.log(
                    removed
                        ? `Deleted ${info(deviceId)}`
                        : `Device ${info(deviceId)} did not exist`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    device
        .command('set-product <deviceId> <productId>')
        .helpGroup('Records:')
        .description('Assign a device to a product ("" to unassign)')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: `Assigning ${deviceId}...`,
                fn: () => setDeviceProduct(deviceId, productId, user),
                success: productId
                    ? `Assigned ${deviceId} → ${productId}`
                    : `Unassigned ${deviceId}`,
                failure: 'Failed to assign product',
                onSuccess: () => {
                    if (isJsonMode()) printOk({ device: deviceId, product: productId || null });
                },
            });
        });

    device
        .command('property <deviceId> [propertyId]')
        .helpGroup('State & resources:')
        .description('List device properties, or read one by ID')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field (dot path, e.g. data.value)')
        .action(async (deviceId, propertyId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (!propertyId) {
                await runCommand({
                    start: `Getting properties for ${deviceId}...`,
                    fn: () => getDeviceProperties(deviceId, user),
                    success: null,
                    failure: 'Property retrieval failed',
                    onSuccess: (result) => {
                        if (isJsonMode()) printOk(result);
                        else console.log(formatDeviceProperties(deviceId, result));
                    },
                });
                return;
            }
            await runCommand({
                start: `Retrieving property for ${deviceId}...`,
                fn: () => getDeviceProperty(deviceId, propertyId, user),
                success: null,
                failure: 'Property retrieval failed',
                onSuccess: (property) => {
                    const value = extractField(property, opts.field);
                    if (isJsonMode()) printOk(value);
                    else if (opts.field) console.log(value);
                    else console.log(formatDeviceProperty(deviceId, propertyId, property));
                },
            });
        });

    device
        .command('property-set <deviceId> <propertyId> <value>')
        .helpGroup('State & resources:')
        .description('Create or overwrite a device property (value parsed as JSON)')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, propertyId, value, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const parsed = parseJsonValue(value);
            await runCommand({
                start: `Saving ${propertyId} on ${deviceId}...`,
                fn: () => setDeviceProperty(deviceId, propertyId, parsed, user),
                success: `Saved ${propertyId} on ${deviceId}`,
                failure: 'Failed to save property',
                onSuccess: () => {
                    if (isJsonMode())
                        printOk({ device: deviceId, property: propertyId, value: parsed });
                },
            });
        });

    device
        .command('resource <deviceId> [resource]')
        .helpGroup('State & resources:')
        .description('List device resources, or call one by name (the device must be online)')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from the result (dot path)')
        .option(
            '-i, --input <key=value>',
            'Resource input, value parsed as JSON (repeatable)',
            collectKeyValue,
        )
        .action(async (deviceId, resource, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (!resource) {
                await runCommand({
                    start: `Getting resources for ${deviceId}...`,
                    fn: () => listDeviceResourcesWithSchemas(deviceId, { user }),
                    success: null,
                    failure: 'Resource retrieval failed',
                    onSuccess: (entries) => {
                        if (isJsonMode()) printOk(entries);
                        else console.log(formatDeviceResourcesWithSchemas(deviceId, entries));
                    },
                });
                return;
            }
            await runCommand({
                start: `Calling resource ${resource} for ${deviceId}...`,
                fn: () => callDeviceResource(deviceId, resource, opts.input, { user }),
                success: null,
                failure: 'Resource call failed',
                onSuccess: (result) => {
                    const value = extractField(result, opts.field);
                    if (isJsonMode()) printOk(value);
                    else if (value === undefined || value === '')
                        console.log(warning('(no output)'));
                    else
                        console.log(
                            typeof value === 'string' ? value : JSON.stringify(value, null, 2),
                        );
                },
            });
        });

    return device;
}
