// @ts-check
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { confirm } from '@inquirer/prompts';
import { InvalidArgumentError } from 'commander';
import { configExists } from '../config.js';
import { loginHint } from '../identity.js';
import {
    setJsonMode,
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../output.js';

export function ensureConfigured() {
    if (!configExists()) {
        printErr(`Not configured. ${loginHint()}`, {
            code: 'not_configured',
        });
    }
}

export function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

// Walks up to the root program so subcommands can read `--user` regardless
// of nesting depth.
export function getGlobalUser(cmd) {
    let root = cmd;
    while (root.parent) root = root.parent;
    return root.opts().user || null;
}

export function parseNonNegativeInt(label) {
    return (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
            throw new InvalidArgumentError(`${label} must be a non-negative integer`);
        }
        return n;
    };
}

export function parsePositiveInt(label) {
    return (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
            throw new InvalidArgumentError(`${label} must be a positive integer`);
        }
        return n;
    };
}

// Collect repeatable `-i key=value` pairs into a single object. Values that
// parse as JSON (numbers, booleans, objects) are sent typed: a resource
// expecting `{ "on": true }` would reject the string "true". Uses Commander's InvalidArgumentError so a bad value prints a
// clean "error: option … argument is invalid" line instead of a stack trace.
export function collectKeyValue(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: parseJsonValue(value.slice(idx + 1)) };
}

// Like collectKeyValue, values kept as written: query parameters, where
// "007" must not become 7.
export function collectKeyString(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

/**
 * Set `value` at a dot path of `target` (`data.source` → target.data.source),
 * creating the objects on the way. Keys that would reach the prototype are
 * refused.
 *
 * @param {Record<string, any>} target
 * @param {string} path
 * @param {any} value
 */
export function setPath(target, path, value) {
    const keys = path.split('.');
    if (keys.some((k) => !k || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
        throw new InvalidArgumentError(`invalid field: ${path}`);
    }
    let node = target;
    for (const k of keys.slice(0, -1)) {
        if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
        node = node[k];
    }
    node[keys[keys.length - 1]] = value;
    return target;
}

// Parse a command-line value as JSON, falling back to the raw string so
// `property set dev name foo` works without shell-escaping quotes.
export function parseJsonValue(raw) {
    if (raw == null) return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// Read a JSON document from a file path, or from stdin when the path is `-`.
// With `lines`, a file of one JSON document per line (NDJSON) is read as
// the array of them.
export async function readJsonArgument(source, { lines = false } = {}) {
    let text;
    if (source === '-') {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        text = Buffer.concat(chunks).toString('utf8');
    } else {
        text = await readFile(source, 'utf8');
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        if (lines) {
            try {
                return text
                    .split('\n')
                    .filter((l) => l.trim())
                    .map((l) => JSON.parse(l));
            } catch {
                // Report the error of the whole document.
            }
        }
        throw new InvalidArgumentError(`${source} is not valid JSON: ${error.message}`);
    }
}

/**
 * The body a command builds from `--from <file|->` and repeatable
 * `--set key=value` (dot paths nest) on top of it. Undefined when neither
 * is given.
 *
 * @param {{ from?: string, set?: Record<string, any> }} opts
 * @param {{ lines?: boolean }} [read]  Passed to readJsonArgument.
 */
export async function bodyFromOptions(opts, read) {
    let body;
    if (opts.from) body = await readJsonArgument(opts.from, read);
    if (opts.set) {
        if (
            body !== undefined &&
            (typeof body !== 'object' || body === null || Array.isArray(body))
        ) {
            throw new InvalidArgumentError('--set needs the --from body to be a JSON object');
        }
        body = body ?? {};
        for (const [k, v] of Object.entries(opts.set)) setPath(body, k, v);
    }
    return body;
}

/** `--from` and `--set`, the options of bodyFromOptions. */
export function bodyOptions(cmd, setFlag = '-s, --set <key=value>') {
    return cmd
        .option('--from <file>', 'JSON body from a file, or - for stdin')
        .option(
            setFlag,
            'Body field (repeatable; values parsed as JSON when they are; dots nest: data.source=resource)',
            collectKeyValue,
        );
}

/**
 * Ask before an irreversible action unless `--yes` was given. Refuses in a
 * non-interactive shell (or JSON mode) without `--yes` rather than
 * guessing. Returns false when the user cancels.
 */
export async function confirmDestructive(opts, message) {
    if (opts.yes) return true;
    if (isJsonMode() || !process.stdin.isTTY) {
        printErr('Refusing to continue without --yes in a non-interactive shell', {
            code: 'needs_confirm',
        });
        return false;
    }
    return confirm({ message, default: false });
}

// Resolve a dot-path against a nested object. Returns `undefined` as soon
// as any intermediate hop is missing — matching the previous inline
// `reduce((o, k) => o && o[k], obj)` behaviour across the CLI.
export function extractField(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * One-shot command skeleton shared by the subcommands
 * (list, property, resource…). Handles the spinner start,
 * try/catch, `classifyError`+`printErr` on failure, and the
 * `isJsonMode() ? printOk : console.log` default for the success path.
 *
 * Shape:
 *   await runCommand({
 *       start: 'Fetching devices…',          // spinner label
 *       fn: () => getDevices(filter),        // async unit of work
 *       success: n => `Found ${n} device(s)`,// string | (result) => string | null
 *       failure: 'Failed to list devices',   // string on failure
 *       onSuccess: (result) => { … },        // optional full render override
 *   });
 *
 * When `success` is `null` the spinner just stops (no checkmark), which
 * matches the idiom used by commands whose output block already speaks
 * for the "found" state. When `onSuccess` is omitted the result is
 * printed verbatim (`printOk` in JSON mode, `console.log` otherwise).
 */
export async function runCommand({ start, fn, success, failure, onSuccess }) {
    const spinner = createSpinner(start).start();
    try {
        const result = await fn();
        if (success === null) {
            spinner.stop();
        } else {
            spinner.succeed(typeof success === 'function' ? success(result) : success);
        }
        if (onSuccess) {
            await onSuccess(result);
        } else if (isJsonMode()) {
            printOk(result);
        } else {
            console.log(result);
        }
    } catch (error) {
        spinner.fail(typeof failure === 'function' ? failure(error) : failure);
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
}
