// @ts-check
import {
    CREDENTIAL_DEVICE_TYPES,
    DEVICE_TYPES,
    createDevice,
    deleteDevice,
    generateDeviceCredentials,
    getDevices,
} from '../devices.js';
import { setDeviceProduct } from '../product.js';
import { inputError } from '../errors.js';
import { hint, info, label, success } from '../format.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import {
    hasListOptions,
    listOptions,
    listRecords,
    projectsOption,
    setProjects,
} from './resources.js';
import {
    applyJsonFlag,
    bodyFromOptions,
    bodyOptions,
    confirmDestructive,
    ensureConfigured,
    getGlobalUser,
    runCommand,
} from './_shared.js';

/**
 * `<cli> device <verb> <device> …` — the device records written by hand
 * (list as a table, create with generated credentials, delete, set-product);
 * the rest of the group (get, update, property, resource, send…) comes from
 * the tool and resource commands.
 */
export function registerDeviceCommands(program) {
    const device = program
        .command('device')
        .helpGroup('Resources:')
        .description('Devices: records, properties, resources, data and their children');

    listOptions(
        device
            .command('list')
            .helpGroup('Records:')
            .description('List devices: online state, id, name, type and product')
            .option('-j, --json', 'Output as JSON'),
    ).action(async (opts, cmd) => {
        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(cmd);
        await runCommand({
            start: 'Fetching devices...',
            fn: () =>
                hasListOptions(opts) ? listRecords('device', opts, user) : getDevices({}, user),
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

    projectsOption(
        bodyOptions(
            device
                .command('create [device]')
                .helpGroup('Records:')
                .description(
                    'Register a device; Generic/MQTT ones get random credentials unless given',
                )
                .option(
                    '-t, --type <type>',
                    `Device type: ${DEVICE_TYPES.join(', ')} (default: Generic)`,
                )
                .option('-c, --credentials <credentials>', 'Device credentials (6+ characters)')
                .option('-n, --name <name>', 'Display name')
                .option('-d, --description <text>', 'Description')
                .option('-p, --product <product>', 'Assign to a product'),
        ),
    )
        .option('-j, --json', 'Output as JSON')
        .action(async (id, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            let body;
            try {
                // The flags go over what --from and --set give.
                body = (await bodyFromOptions(opts)) ?? {};
                if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                    throw inputError('create takes a JSON object');
                }
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }
            const deviceId = id ?? body.device;
            const type = opts.type ?? body.type ?? 'Generic';
            if (!deviceId) {
                printErr('give the device id: <device>, or the body field "device"', {
                    code: 'input_error',
                });
                return;
            }
            if (!DEVICE_TYPES.includes(type)) {
                printErr(`--type must be one of ${DEVICE_TYPES.join(', ')}`, {
                    code: 'input_error',
                });
                return;
            }
            const needsCredentials = CREDENTIAL_DEVICE_TYPES.has(type);
            if (!needsCredentials && opts.credentials) {
                printErr(`${type} devices do not take credentials`, { code: 'input_error' });
                return;
            }
            const given = opts.credentials ?? body.credentials;
            if (given && given.length < 6) {
                printErr('credentials must be at least 6 characters', { code: 'input_error' });
                return;
            }
            const credentials = needsCredentials ? given || generateDeviceCredentials() : undefined;
            await runCommand({
                start: `Creating ${deviceId}...`,
                fn: async () => {
                    const sent = await createDevice(
                        {
                            ...body,
                            device: deviceId,
                            type,
                            name: opts.name ?? body.name,
                            description: opts.description ?? body.description,
                            credentials,
                            product: opts.product ?? body.product,
                        },
                        user,
                    );
                    if (opts.projects) await setProjects('device', deviceId, opts.projects, user);
                    return sent;
                },
                success: `Created ${type} device ${deviceId}`,
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
        .command('delete <device>')
        .helpGroup('Records:')
        .description('Delete a device record from the platform (irreversible)')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (id, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (!(await confirmDestructive(opts, `Delete device ${id}? This cannot be undone.`))) {
                console.log(hint('Cancelled.'));
                return;
            }
            try {
                const removed = await deleteDevice(id, user);
                if (isJsonMode()) {
                    printOk({ device: id, removed });
                    return;
                }
                console.log(removed ? `Deleted ${info(id)}` : `Device ${info(id)} did not exist`);
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    device
        .command('set-product <device> <product>')
        .helpGroup('Actions:')
        .description('Assign a device to a product ("" to unassign)')
        .option('-j, --json', 'Output as JSON')
        .action(async (id, productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            await runCommand({
                start: `Assigning ${id}...`,
                fn: () => setDeviceProduct(id, productId, user),
                success: productId ? `Assigned ${id} → ${productId}` : `Unassigned ${id}`,
                failure: 'Failed to assign product',
                onSuccess: () => {
                    if (isJsonMode()) printOk({ device: id, product: productId || null });
                },
            });
        });

    return device;
}
