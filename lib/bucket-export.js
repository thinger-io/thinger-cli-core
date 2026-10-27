// @ts-check
import { setTimeout as sleep } from 'node:timers/promises';
import api from './api.js';
import { TIMEOUTS } from './constants.js';
import { apiError, inputError } from './errors.js';
import { v1 } from './paths.js';
import { rawApiCall } from './raw-api.js';

/** States of an export record (buckets.cpp). */
const READY = 1;
const FAILED = 2;

/**
 * Export a bucket's data to a file and download it: the server writes the
 * file in the background and lists it among the bucket's exports when
 * ready. The export is deleted from the server afterwards unless `keep`.
 *
 * @param {{
 *   bucket: string,
 *   user?: string | null,
 *   format?: 'csv' | 'json' | 'arff',
 *   timestamps?: 'iso' | 'seconds' | 'milliseconds',
 *   minTs?: number,
 *   maxTs?: number,
 *   keep?: boolean,
 *   pollMs?: number,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ file: string, data: Buffer | string }>}
 */
export async function exportBucket({
    bucket,
    user,
    format = 'csv',
    timestamps = 'iso',
    minTs,
    maxTs,
    keep = false,
    pollMs = 1000,
    timeoutMs = TIMEOUTS.API_LONG_MS,
}) {
    if (!['csv', 'json', 'arff'].includes(format)) throw inputError('format: csv, json or arff');
    if (!['iso', 'seconds', 'milliseconds'].includes(timestamps)) {
        throw inputError('timestamps: iso, seconds or milliseconds');
    }
    const base = `${v1(user)}/buckets/${encodeURIComponent(bucket)}/exports`;
    let file;
    try {
        const res = await api.post(base, {
            data_type: format,
            timestamp_format: timestamps,
            ...(minTs !== undefined ? { min_ts: minTs } : {}),
            ...(maxTs !== undefined ? { max_ts: maxTs } : {}),
        });
        file = res.data?.file;
    } catch (e) {
        throw apiError(e, { notFound: `Bucket not found: ${bucket}` });
    }
    if (!file) throw new Error('the server did not name the export file');

    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let state;
        try {
            const res = await api.get(base);
            state = (Array.isArray(res.data) ? res.data : []).find((e) => e.file === file)?.state;
        } catch (e) {
            throw apiError(e);
        }
        if (state === READY) break;
        if (state === FAILED) throw new Error(`the server could not export ${bucket}`);
        if (Date.now() > deadline) {
            throw new Error(
                `the export ${file} is not ready yet: find it later with bucket export-file list`,
            );
        }
        await sleep(pollMs);
    }

    const res = await rawApiCall({ path: `${base}/${encodeURIComponent(file)}` });
    // The bytes as the server wrote them: parsing would round numbers.
    const data = res.raw;
    if (!keep) {
        try {
            await api.delete(`${base}/${encodeURIComponent(file)}`);
        } catch {
            // The data is downloaded: a leftover file on the server is no failure.
        }
    }
    return { file, data };
}
