// @ts-check
import fs from 'node:fs';
import nodePath from 'node:path';
import api from '../../api.js';
import { collectFiles, uploadFiles } from '../../dashboard.js';
import { apiError, inputError } from '../../errors.js';
import { identity } from '../../identity.js';
import { v1, v2 } from '../../paths.js';
import { decodeBody } from '../../raw-api.js';
import { deleteStorageFile, storageFilePath, writeStorageFile } from '../../storage.js';

/** Files of a storage (the storages themselves are the catalog type "storage"). */

/** A path inside the storage, without leading slashes (they would double up in the URL). */
const clean = (p) => String(p).replace(/^\/+/, '');

/** Largest single local file uploaded at once. */
const MAX_FILE = 50 * 1024 * 1024;
/** Largest local folder uploaded in one call. */
const MAX_FOLDER = 200 * 1024 * 1024;

/** Upload a local file (to `path`, default its name) or folder (under `path`). */
async function uploadLocal(body, ctx) {
    if (body.content !== undefined) throw inputError('pass body.content or body.local, not both');
    const local = nodePath.resolve(String(body.local));
    if (!fs.existsSync(local)) throw inputError(`No such local file or folder: ${body.local}`);
    const path = ctx.id;
    /** @type {Record<string, Buffer>} */
    let files;
    if (fs.statSync(local).isDirectory()) {
        const prefix = path ? `${clean(path).replace(/\/+$/, '')}/` : '';
        files = Object.fromEntries(
            Object.entries(
                collectFiles(local, {
                    skip: new Set(['.git']),
                    maxBytes: MAX_FOLDER,
                    tooLarge: 'upload its subfolders or files in separate calls',
                }),
            ).map(([f, c]) => [prefix + f, c]),
        );
        if (!Object.keys(files).length) throw inputError(`${body.local} has no files`);
    } else {
        if (fs.statSync(local).size > MAX_FILE) {
            throw inputError(`${body.local} is larger than ${MAX_FILE / 1024 / 1024} MB`);
        }
        files = { [path ? clean(path) : nodePath.basename(local)]: fs.readFileSync(local) };
    }
    await uploadFiles(String(ctx.parent), files, ctx.user);
    const names = Object.keys(files);
    const bytes = Object.values(files).reduce((n, c) => n + c.length, 0);
    return { storage: ctx.parent, files: names, bytes };
}

/** Write `content` (text) at the path, or upload `local`. */
async function write(body, ctx) {
    if (body.local !== undefined) return uploadLocal(body, ctx);
    if (!ctx.id) throw inputError('missing file: the path to write (or body.local)');
    if (typeof body.content !== 'string') {
        throw inputError('body.content (text) or body.local (a local file or folder) is required');
    }
    const path = clean(ctx.id);
    await writeStorageFile(String(ctx.parent), path, body.content, ctx.user);
    return { storage: ctx.parent, files: [path], bytes: Buffer.byteLength(body.content) };
}

/** @type {import('../tools-resource.js').LocalType} */
export const storageFile = {
    description:
        'Files of a file storage: list a folder, read, write (text, or files and folders of this machine) and delete.',
    parent: 'storage',
    id: 'file',
    recordId: 'path',

    optionalId: ['create', 'update'],
    ops: {
        list: 'Storage_ListFiles',
        get: 'Storage_ReadFilesFiles(?<file>.*$)',
        create: 'Storage_UpdateFilesFiles(?<file>.*$)',
        update: 'Storage_UpdateFilesFiles(?<file>.*$)',
        delete: 'Storage_DeleteFilesFiles(?<file>.*$)',
    },
    filter: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: 'Folder to list.' } },
    },
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            content: { type: 'string', description: 'Text of the file at ids.file.' },
            local: {
                type: 'string',
                description:
                    'Or a file or folder of the machine running this CLI, uploaded as is (binary too; up to 50 MB per file and 200 MB per call): a file goes to ids.file (default its own name), a folder under ids.file (default the root).',
            },
        },
    },
    notes: 'ids.file is the path inside the storage ("web/index.html"). create and update both write the file whether it exists or not, creating the folders on the path. body.local runs on the machine of this CLI: use it for anything big or binary (CSV to import, images, product code with its node_modules). A get of a binary file says how to download it instead of returning it.',
    examples: [
        {
            tool: 'resource_create',
            arguments: {
                type: 'storage_file',
                ids: { storage: 'web_app' },
                body: { local: './site' },
            },
            does: 'Upload the local folder ./site (binary files too) to the root of the storage.',
        },
        {
            tool: 'resource_get',
            arguments: {
                type: 'storage_file',
                ids: { storage: 'web_app', file: 'web/index.html' },
            },
            does: 'Read a text file.',
        },
    ],
    async list(ctx) {
        const path = ctx.filter?.path;
        try {
            const res = await api.get(
                `${v1(ctx.user)}/storages/${encodeURIComponent(String(ctx.parent))}/files`,
                { params: path ? { path: clean(path) } : undefined },
            );
            if (!Array.isArray(res.data)) return [];
            // The server answers paths relative to the folder listed: make
            // them whole, so a record's ids.file reads and writes that file.
            const folder = path ? clean(path).replace(/\/+$/, '') : '';
            if (!folder) return res.data;
            return res.data.map((f) =>
                typeof f?.path === 'string' && !f.path.startsWith(`${folder}/`)
                    ? { ...f, path: `${folder}/${f.path.replace(/^\/+/, '')}` }
                    : f,
            );
        } catch (e) {
            // The server keeps files on disk and creates a storage's folder
            // with its first file: an empty storage answers 404 too.
            if (e.response?.status === 404) return [];
            throw apiError(e);
        }
    },
    async get(ctx) {
        const path = clean(String(ctx.id));
        try {
            const res = await api.get(
                `${v2(ctx.user)}/storages/${encodeURIComponent(String(ctx.parent))}/files/${storageFilePath(path)}`,
                { responseType: 'arraybuffer', transformResponse: [(x) => x] },
            );
            const raw = Buffer.from(res.data ?? []);
            const type = String(res.headers?.['content-type'] || '');
            const { kind } = decodeBody(raw, type);
            if (kind === 'binary') {
                return `Binary file of ${raw.length} bytes (${type || 'unknown type'}): download it with \`${identity().name} storage file download ${ctx.parent} ${path} -o <file>\`.`;
            }
            return raw.toString('utf8');
        } catch (e) {
            throw apiError(e, { notFound: `File not found in storage "${ctx.parent}": ${path}` });
        }
    },
    create: write,
    update: write,
    async delete(ctx) {
        const path = clean(String(ctx.id));
        if (!(await deleteStorageFile(String(ctx.parent), path, ctx.user))) {
            throw Object.assign(inputError(`No such file: ${path}`), { code: 'not_found' });
        }
        return { path, deleted: true };
    },
};
