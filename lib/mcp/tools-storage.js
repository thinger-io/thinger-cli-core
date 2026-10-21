// @ts-check
import fs from 'node:fs';
import nodePath from 'node:path';
import api from '../api.js';
import { collectFiles, uploadFiles } from '../dashboard.js';
import { apiError, inputError } from '../errors.js';
import { v1 } from '../paths.js';
import { deleteStorageFile, readStorageFile, writeStorageFile } from '../storage.js';
import { textResult } from './helpers.js';

/** Files of a storage (the storages themselves are the catalog type "storage"). */

const text = textResult;
const userParam = { type: 'string', description: 'Account to act on (admin only).' };
const storageParam = { type: 'string', description: 'Storage id.' };

function required(args, ...names) {
    for (const name of names) {
        if (args[name] === undefined || args[name] === '') throw inputError(`${name} is required`);
    }
}

/** A path inside the storage, without leading slashes (they would double up in the URL). */
const clean = (p) => String(p).replace(/^\/+/, '');

async function toolList(args) {
    required(args, 'storage');
    const params = args.path ? { path: clean(args.path) } : undefined;
    try {
        const res = await api.get(
            `${v1(args.user)}/storages/${encodeURIComponent(args.storage)}/files`,
            { params },
        );
        const files = Array.isArray(res.data) ? res.data : [];
        return text(
            files.length ? files.map((f) => JSON.stringify(f)).join('\n') : 'No files.',
            files,
        );
    } catch (e) {
        // The server keeps files on disk and creates a storage's folder with
        // its first file: an empty storage answers 404 too.
        if (e.response?.status === 404) {
            return text(
                `No files${args.path ? ` under ${clean(args.path)}` : ''} (or no storage ${args.storage}).`,
                [],
            );
        }
        throw apiError(e);
    }
}

async function toolRead(args) {
    required(args, 'storage', 'path');
    return text(await readStorageFile(args.storage, clean(args.path), args.user));
}

/** Largest single local file uploaded at once. */
const MAX_FILE = 50 * 1024 * 1024;
/** Largest local folder uploaded in one call. */
const MAX_FOLDER = 200 * 1024 * 1024;

/** Upload a local file (to `path`, default its name) or folder (under `path`). */
async function uploadLocal(args) {
    if (args.content !== undefined) throw inputError('pass content or local, not both');
    const local = nodePath.resolve(String(args.local));
    if (!fs.existsSync(local)) throw inputError(`No such local file or folder: ${args.local}`);
    /** @type {Record<string, Buffer>} */
    let files;
    if (fs.statSync(local).isDirectory()) {
        const prefix = args.path ? `${clean(args.path).replace(/\/+$/, '')}/` : '';
        files = Object.fromEntries(
            Object.entries(
                collectFiles(local, {
                    skip: new Set(['.git']),
                    maxBytes: MAX_FOLDER,
                    tooLarge: 'upload its subfolders or files in separate calls',
                }),
            ).map(([f, c]) => [prefix + f, c]),
        );
        if (!Object.keys(files).length) throw inputError(`${args.local} has no files`);
    } else {
        if (fs.statSync(local).size > MAX_FILE) {
            throw inputError(`${args.local} is larger than ${MAX_FILE / 1024 / 1024} MB`);
        }
        files = {
            [args.path ? clean(args.path) : nodePath.basename(local)]: fs.readFileSync(local),
        };
    }
    await uploadFiles(args.storage, files, args.user);
    const names = Object.keys(files);
    const bytes = Object.values(files).reduce((n, c) => n + c.length, 0);
    const shown =
        names.slice(0, 20).join(', ') + (names.length > 20 ? `… (+${names.length - 20})` : '');
    return text(
        `Uploaded ${names.length} file(s), ${bytes} bytes, to storage ${args.storage}: ${shown}.`,
        { storage: args.storage, files: names, bytes },
    );
}

async function toolWrite(args) {
    required(args, 'storage');
    if (args.local !== undefined) return uploadLocal(args);
    required(args, 'path');
    if (typeof args.content !== 'string') throw inputError('content must be a string');
    await writeStorageFile(args.storage, clean(args.path), args.content, args.user);
    return text(
        `Wrote ${clean(args.path)} (${Buffer.byteLength(args.content)} bytes) to storage ${args.storage}.`,
        {
            storage: args.storage,
            files: [clean(args.path)],
            bytes: Buffer.byteLength(args.content),
        },
    );
}

async function toolDelete(args) {
    required(args, 'storage', 'path');
    const deleted = await deleteStorageFile(args.storage, clean(args.path), args.user);
    return text(deleted ? `Deleted ${clean(args.path)}.` : `No such file: ${clean(args.path)}.`, {
        path: clean(args.path),
        deleted,
    });
}

const pathParam = {
    type: 'string',
    description: 'File path inside the storage, e.g. "web/index.html".',
};

export const tools = [
    {
        name: 'storage_file_list',
        description:
            'List the files of a storage (path, size, modification time), optionally only under a folder.',
        inputSchema: {
            type: 'object',
            properties: {
                storage: storageParam,
                path: { type: 'string', description: 'Folder to list.' },
                user: userParam,
            },
            required: ['storage'],
        },
        handler: toolList,
    },
    {
        name: 'storage_file_read',
        description: 'Read a text file of a storage.',
        inputSchema: {
            type: 'object',
            properties: { storage: storageParam, path: pathParam, user: userParam },
            required: ['storage', 'path'],
        },
        handler: toolRead,
    },
    {
        name: 'storage_file_write',
        description:
            'Create or overwrite files in a storage; folders on the path are created. Either `content` (text) at `path`, or `local`: a file or folder on this machine, uploaded as is (binary too) to `path` (a file defaults to its own name; a folder goes under `path`, or the root). Use `local` for anything big: CSV to import, images, product code with its node_modules.',
        inputSchema: {
            type: 'object',
            properties: {
                storage: storageParam,
                path: pathParam,
                content: { type: 'string', description: 'Text content of the file at `path`.' },
                local: {
                    type: 'string',
                    description:
                        'Local file or folder to upload instead of `content` (up to 50 MB per file and 200 MB per call).',
                },
                user: userParam,
            },
            required: ['storage'],
        },
        handler: toolWrite,
    },
    {
        name: 'storage_file_delete',
        description: 'Delete a file of a storage. Permanent: confirm with the user first.',
        inputSchema: {
            type: 'object',
            properties: { storage: storageParam, path: pathParam, user: userParam },
            required: ['storage', 'path'],
        },
        handler: toolDelete,
    },
];
