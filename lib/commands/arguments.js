// @ts-check

/**
 * Help for the positional arguments of the commands written by hand, kept
 * in one table instead of spread over every `.command('x <id>')`. A command
 * path ('dashboard init') wins over the argument name alone; a CLI adds its
 * own tables (runCli's `argumentHelp`).
 */
const BY_COMMAND = {
    api: { path: 'API path, e.g. /v1/users/{user}/devices ({user}: your account)' },
    'device set-product': { product: 'Product ID ("" removes the device from its product)' },
    'device resource call': { resource: 'Resource of the device to call' },
    'product profile api call': { api: 'API resource of the product profile' },
    'dashboard init': { dir: 'New or empty folder for the app' },
    'dashboard dev': {
        url: 'Address of the app on its dev server (default: dev.url of the manifest)',
    },
    'dashboard publish': { dir: 'Folder to upload (default: dir of the manifest)' },
    'storage file list': { folder: 'Folder of the storage to list (default: all the files)' },
    'storage file upload': { local: 'Local file or folder' },
    'storage file download': { path: 'Path of the file in the storage' },
    'storage file delete': { path: 'Path of the file in the storage' },
    'plugin call': { path: 'Path in the API of the plugin, e.g. /api/status' },
    'profile add': { name: 'Profile name (asked when missing)' },
};

const BY_NAME = {
    device: 'Device ID',
    product: 'Product ID',
    bucket: 'Data Bucket ID',
    property: 'Property ID',
    value: 'Value, parsed as JSON (text when it is not JSON)',
    storage: 'File storage ID',
    plugin: 'Plugin ID',
    name: 'Profile name',
};

/**
 * Describe the arguments that have no description yet, in the whole tree.
 *
 * @param {import('commander').Command} program
 * @param {{ byCommand?: Record<string, Record<string, string>>, byName?: Record<string, string> }} [extra]
 *   A CLI's own tables, read before the core's.
 */
export function describeArguments(program, { byCommand = {}, byName = {} } = {}) {
    const walk = (cmd, path) => {
        for (const arg of cmd.registeredArguments) {
            if (arg.description) continue;
            const name = arg.name();
            arg.description =
                byCommand[path]?.[name] ??
                BY_COMMAND[path]?.[name] ??
                byName[name] ??
                BY_NAME[name] ??
                '';
        }
        for (const sub of cmd.commands) walk(sub, path ? `${path} ${sub.name()}` : sub.name());
    };
    walk(program, '');
}
