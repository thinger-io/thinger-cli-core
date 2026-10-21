import api from './api.js';
import { TIMEOUTS } from './constants.js';
import { apiError, inputError } from './errors.js';
import { v1, v2 } from './paths.js';

/**
 * A file path inside a storage as a URL path: each segment escaped, and
 * none empty, `.` or `..` (the URL would point at another file, or at the
 * storage itself).
 *
 * @param {string} filePath
 */
export function storageFilePath(filePath) {
    const parts = String(filePath ?? '')
        .replace(/^\/+/, '')
        .split('/');
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) {
        throw inputError(`invalid file path: "${filePath}"`);
    }
    return parts.map(encodeURIComponent).join('/');
}

/** A storage id, checked: it is a segment of every URL here. */
function sid(storageId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(storageId ?? ''))) {
        throw inputError(`invalid storage id: "${storageId}"`);
    }
    return storageId;
}

/** `/v2/users/{user}/storages/{storage}/files/{path}`, escaped. */
const fileUrl = (storageId, filePath, user) =>
    `${v2(user)}/storages/${sid(storageId)}/files/${storageFilePath(filePath)}`;

/**
 * Helpers for file storages — independent buckets that the
 * platform exposes alongside products. The product script workflow
 * uses them to host the actual JS files; storages are also useful on
 * their own (config blobs, firmware artefacts, etc.).
 *
 * Functions return raw data and throw `apiError` on failure, except
 * the `*Exists` and `delete*` helpers which use boolean return values
 * so orchestration code can stay branch-light.
 */

export async function getStorage(storageId, user) {
    try {
        const res = await api.get(`${v1(user)}/storages/${sid(storageId)}`);
        return res.data || {};
    } catch (e) {
        throw apiError(e, { notFound: `Storage not found: ${storageId}` });
    }
}

export async function storageExists(storageId, user) {
    try {
        await api.get(`${v1(user)}/storages/${sid(storageId)}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

export async function createStorage(
    storageId,
    user,
    { name, description, public: isPublic = false } = {},
) {
    try {
        await api.post(`${v1(user)}/storages`, {
            storage: storageId,
            name: name || storageId,
            description: description || `Storage for ${storageId}`,
            public: isPublic,
        });
    } catch (e) {
        throw apiError(e);
    }
}

export async function deleteStorage(storageId, user) {
    try {
        await api.delete(`${v1(user)}/storages/${sid(storageId)}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

export async function listStorageFiles(storageId, user) {
    try {
        const res = await api.get(`${v1(user)}/storages/${sid(storageId)}/files`);
        return res.data || [];
    } catch (e) {
        if (e.response?.status === 404) return [];
        throw apiError(e);
    }
}

/**
 * Read a file as raw text (no JSON parsing). The agent stores script
 * bodies as `text/plain` — parsing them as JSON would corrupt them.
 */
export async function readStorageFile(storageId, filePath, user) {
    try {
        const res = await api.get(fileUrl(storageId, filePath, user), {
            transformResponse: [(x) => x],
        });
        return res.data;
    } catch (e) {
        throw apiError(e, { notFound: `File not found in storage "${storageId}": ${filePath}` });
    }
}

export async function storageFileExists(storageId, filePath, user) {
    try {
        await api.get(fileUrl(storageId, filePath, user));
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

export async function writeStorageFile(storageId, filePath, content, user) {
    try {
        await api.put(`${fileUrl(storageId, filePath, user)}?overwrite=true`, content, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: TIMEOUTS.API_LONG_MS,
        });
    } catch (e) {
        throw apiError(e);
    }
}

export async function deleteStorageFile(storageId, filePath, user) {
    try {
        await api.delete(fileUrl(storageId, filePath, user));
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}
