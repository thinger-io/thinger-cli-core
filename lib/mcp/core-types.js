// @ts-check
import { bucketData } from './types/bucket-data.js';
import { dashboardActions } from './types/dashboard-apps.js';
import { deviceResource, overview } from './types/device-resource.js';
import { doc } from './types/doc.js';
import { pluginCall } from './types/plugin-call.js';
import { apiCall } from './types/product-api.js';
import { profile } from './types/profile.js';
import { storageFile } from './types/storage-file.js';

/**
 * What every CLI on the core serves next to the catalog, through the same
 * `resource_*` tools: data and files as types (a bucket's time series, a
 * storage's files, a connected device's resources), the guides and the
 * profiles, and the actions on catalog types that are more than one
 * request (or run on this machine). They take the shape of the types and
 * actions a CLI adds (tools-resource.js), with the server operations each
 * runs (`ops`, `op`), or `local` when it runs here.
 */

/** @type {Record<string, import('./tools-resource.js').LocalType>} */
export const CORE_TYPES = {
    bucket_data: bucketData,
    storage_file: storageFile,
    device_resource: deviceResource,
    doc,
    profile,
};

/** @type {Record<string, Record<string, import('./tools-resource.js').LocalAction>>} */
export const CORE_ACTIONS = {
    device: { overview },
    product_profile_api: { call: apiCall },
    plugin: { call: pluginCall },
    dashboard: dashboardActions,
};
