// @ts-check

/**
 * Help for the positional arguments of the commands written by hand, kept
 * in one table instead of spread over every `.command('x <id>')`. A command
 * path ('dashboard init') wins over the argument name alone.
 */
const BY_COMMAND = {
    api: { path: 'API path, e.g. /v1/users/{user}/devices ({user}: your account)' },
    'device list': { pattern: 'Regular expression on the ID and the name (case-insensitive)' },
    'device set-product': { productId: 'Product ID ("" removes the device from its product)' },
    'device resource': { resource: 'Device resource to call; without it, lists them' },
    'product resource': { resource: 'API resource of the product profile' },
    'product apply': { file: 'JSON file as `product export` writes it (- reads stdin)' },
    'dashboard init': { dir: 'New or empty folder for the app' },
    'dashboard dev': {
        url: 'Address of the app on its dev server (default: dev.url of the manifest)',
    },
    'dashboard publish': { dir: 'Folder to upload (default: dir of the manifest)' },
    'storage files': { folder: 'Folder of the storage to list (default: all the files)' },
    'storage upload': { local: 'Local file or folder' },
    'storage download': { path: 'Path of the file in the storage' },
    'storage rm': { path: 'Path of the file in the storage' },
    'plugin call': { path: 'Path in the API of the plugin, e.g. /api/status' },
    'profile add': { name: 'Profile name (asked when missing)' },
};

const BY_NAME = {
    deviceId: 'Device ID',
    device: 'Device ID',
    productId: 'Product ID',
    product: 'Product ID',
    bucketId: 'Data Bucket ID',
    bucket: 'Data Bucket ID',
    propertyId: 'Property ID',
    value: 'Value, parsed as JSON (text when it is not JSON)',
    storage: 'File storage ID',
    plugin: 'Plugin ID',
    name: 'Profile name',
};

/**
 * Describe the arguments that have no description yet, in the whole tree.
 *
 * @param {import('commander').Command} program
 */
export function describeArguments(program) {
    const walk = (cmd, path) => {
        for (const arg of cmd.registeredArguments) {
            if (arg.description) continue;
            arg.description = BY_COMMAND[path]?.[arg.name()] ?? BY_NAME[arg.name()] ?? '';
        }
        for (const sub of cmd.commands) walk(sub, path ? `${path} ${sub.name()}` : sub.name());
    };
    walk(program, '');
}
