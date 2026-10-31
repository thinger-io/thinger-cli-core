// @ts-check
import { v1, v2, v3 } from '../paths.js';
import { inputError } from '../errors.js';

/**
 * The resource catalog: every server collection the generic `resource_*`
 * tools can reach, as data.
 *
 * Each entry says where the collection lives and which operations the
 * tools may run on it, with the server's operationId for each (the tests
 * check every one against the server's OpenAPI document, and
 * `resource_describe` uses them to find the request schemas). A draft of
 * this table comes from `scripts/catalog-draft.js`; the table itself is
 * reviewed by hand and never discovered at run time, so a collection the
 * server adds (an administration one, say) reaches the model only when
 * someone decides it should.
 *
 * Paths are relative to the parent's item path, or to the account
 * (`/v{N}/users/{account}`) for top-level types; `version` applies to the
 * whole path. Verbs map to requests as follows:
 *
 *   list     GET    <collection>
 *   create   POST   <collection>      (PUT <item> when `upsert`)
 *   get      GET    <item>
 *   update   PUT    <item>
 *   patch    PATCH  <item>            (update with `merge: true`)
 *   delete   DELETE <item>
 *   clone    POST   <item>/clone
 *   projects PUT    <item>/projects   (the `projects` field of an update)
 *
 * A type without `id` is a single resource of its parent (get / update on
 * the path itself).
 */

/**
 * @typedef {'list' | 'create' | 'get' | 'update' | 'patch' | 'delete' | 'clone' | 'projects'} Verb
 *
 * @typedef {object} Action
 * @property {string} op        Server operationId.
 * @property {'get' | 'post' | 'put' | 'patch' | 'delete'} method
 * @property {string} path      Appended to the item (or collection) path.
 * @property {'item' | 'collection'} [on]  Default item.
 * @property {'v1' | 'v2' | 'v3'} [version]  When it differs from the type's.
 * @property {Record<string, string>} [query]  Fixed query parameters (the caller's are added).
 * @property {string[]} [bodyFromRecord]  Without a `body`, send these fields of the saved record.
 * @property {string} description
 *
 * @typedef {object} ResourceType
 * @property {string} description  One line, shown in the catalog summary.
 * @property {'v1' | 'v2' | 'v3'} version
 * @property {string} path         Collection path, relative to the parent item or the account.
 * @property {string} [parent]     Type this one hangs off.
 * @property {string | string[]} [id]  Name of the item id (or names, for ids in several segments).
 * @property {string[]} [bodyId]   Body fields `create` copies the id into, when they differ
 *   from the id names; empty when the server generates the id.
 * @property {Partial<Record<Verb, string>>} ops  Allowed verbs → server operationId.
 * @property {boolean} [upsert]    Created with PUT on the item path, so `create` needs the id.
 * @property {string} [notes]      Longer guidance returned by `resource_describe`.
 * @property {'account' | 'server'} [scope]  Server-wide types (users, hosts, domains…)
 *   live under /v{N}/, not under an account; default account.
 * @property {Record<string, string>} [listQuery]  Default query of list (the caller's filter wins).
 * @property {boolean} [listWhole]  The server answers the whole list at once, without
 *   paging or name search: resource_list pages and searches it client-side.
 * @property {string[]} [listFields]  Fields (dot paths) kept per record in lists, for
 *   collections whose records are too big to list whole.
 * @property {{ params: Record<string, string>, minutes: number }} [listCache]  Lists whose
 *   query has these params are kept that long per profile (slow, remote catalogs).
 * @property {Record<string, Action>} [actions]  Operations that are not CRUD, run with
 *   `resource_call`: verify a domain, restart a host, test an alarm rule…
 * @property {boolean} [sdk]       `resource_describe` adds the dashboard SDK reference (from its package, see docs.js).
 */

const PROPERTY_NOTES =
    'Properties hold any JSON `value`. Create with body {property, name?, description?, value}; update replaces the value ({value}), while update with merge: true patches it (JSON merge of objects).';

const PROFILE_NOTES =
    'Product profile entries are keyed by name: create stores the entry under `id` (PUT), replacing what was there; update keeps the fields left out (the saved entry is sent with yours over it).';

/** Where profile listeners (buckets, properties) take their data from. */
const LISTENER_SOURCE =
    'data.source is one of: "resource" (poll a device resource: {resource, update: "interval"|"event", interval, magnitude: "second"|"minute"|"hour"…}), "resource_stream" ({resource_stream}), "product_stream" ({product_stream, product?}), "topic" ({topic}, MQTT), "event" ({event, filter?}). Optional: data.payload_type ("template_payload" with data.payload such as "{{payload}}", "source_payload" to keep the payload as is, "source_event", "none") and data.payload_function (a function of the product code).';

const PROFILE_API_NOTES = `${PROFILE_NOTES} An API resource is a REST endpoint added to every device of the product and dispatched by the server: {enabled, request: {data: {target, payload_type?, payload?, payload_function?, ...}}, response: {data: {payload_type, source?, payload?, payload_function?}}}. request.data.target is one of: "resource" ({resource}: a device resource), "resource_stream" ({resource_stream}; defaults to the API resource name), "product_stream" ({product, product_stream}), "property" ({property}), "function" ({function}: product code), "endpoint_call" ({endpoint}), "plugin_endpoint" ({plugin, path}), "topic" ({topic}), "none". Payload types: "template_payload" (default; data.payload is a template such as "{{payload}}"), "source_payload" (forward the body), "source_event" (the whole event), "none". response.data {payload_type: "none"} is fire-and-forget; "source_payload" returns the target's answer. Example: {"enabled": true, "request": {"data": {"target": "resource_stream", "resource_stream": "backup_complete", "payload_type": "source_payload"}}, "response": {"data": {"payload_type": "none"}}}. Called by device ({tool:device_resource_call} on a device of the product), or for the product as a whole with {tool:product_resource_call}, which needs "device_id_resolver": "<function of the product code>" in the entry to find each payload's device. A resource computed by code (target "function") also needs response {"source": "request_response", "payload_type": "source_payload"} to return the value; this is how Virtual devices get data ({tool:doc_read} id "product-code").`;

const PROFILE_BUCKET_NOTES = `${PROFILE_NOTES} A profile bucket stores, for each device of the product, the samples of a data source; the bucket itself is created on the first sample. Shape: {enabled, name, description, backend: "mongodb" (default) or "influxdb", data: {source, ...}, retention?: {period, unit: "minutes"|"hours"|"days"|"months"|"years"}, tags?: []}. ${LISTENER_SOURCE} Unless the bucket name has "{{device}}", samples get "device" and "group" tags, so one bucket holds the whole fleet. Sampling a resource needs data {"source": "resource", "resource", "update": "interval", "interval", "magnitude", "payload": "{{payload}}"} (or "payload_type": "source_payload"), which stores the value as it comes; the default template payload with no "payload" writes nothing. Deleting the entry stops recording but keeps the bucket and its data. Example: {"enabled": true, "name": "backups", "backend": "mongodb", "data": {"source": "resource_stream", "resource_stream": "backup_complete", "payload_type": "source_payload"}, "retention": {"period": 1, "unit": "years"}}.`;

const PROFILE_PROPERTY_NOTES = `${PROFILE_NOTES} A profile property writes a data source into a property of each device of the product (not to be confused with product_property, a value stored on the product itself). Shape: {enabled, name, description, data: {source, ..., patch?: true to merge into the existing value}}. ${LISTENER_SOURCE}`;

/** @type {Record<string, ResourceType>} */
export const CATALOG = {
    // ─── Account resources ──────────────────────────────────────────
    device: {
        description: 'Devices of the account (IOTMP, MQTT, HTTP, virtual).',
        version: 'v1',
        path: 'devices',
        id: 'device',
        ops: {
            list: 'Device_List',
            create: 'Device_Create',
            get: 'Device_ReadStatus',
            update: 'Device_Update',
            delete: 'Device_Delete',
            clone: 'Device_Clone',
            projects: 'Device_UpdateProjects',
        },
        notes: '`type` defaults to Generic (IOTMP). Generic and MQTT devices authenticate with `credentials`: when creating one without them, credentials are generated and returned once (the server stores them hashed). HTTP devices send data through {tool:device_data_send}; assign a product with update {product} ("" unassigns). Virtual devices have no hardware: every resource comes from their product\'s API (product code can compute it), and they need a `location` property ({lat, lon}) to appear on maps, or they are placed by their IP. Native geofences (Thinger 7.4 and later): a `geofences` property on the device, or inherited from its asset type, group or product, holds a GeoJSON FeatureCollection ([lon, lat]; Polygon, or Point with properties.radius in meters; properties.onEnter / onExit name an endpoint or ""). Every change of the device `location` emits device_geofence_event (with geofence_id, geofence_properties, product, asset_type, asset_group): store it with a product profile bucket or flow whose source is that event. See the Geofences section of {tool:doc_read} id "concepts". A new Virtual device shows disconnected in the create answer and connects a moment later.',
        actions: {
            stats: {
                op: 'Device_ReadStatistics',
                method: 'get',
                path: 'stats',
                version: 'v3',
                description:
                    'Usage over the last 30 days, per day: traffic and calls (empty when the server does not record usage).',
            },
        },
    },
    product: {
        description:
            'Products: shared configuration and profile (APIs, buckets, properties…) for a fleet of devices.',
        version: 'v1',
        path: 'products',
        id: 'product',
        ops: {
            list: 'Product_List',
            create: 'Product_Create',
            get: 'Product_ReadConfig',
            update: 'Product_Update',
            delete: 'Product_Delete',
            clone: 'Product_Clone',
            projects: 'Product_UpdateProjects',
        },
        notes: 'The profile can be sent whole in create or update, or edited entry by entry through the product_profile_* types.',
        actions: {
            export: {
                op: 'Product_Export',
                method: 'get',
                path: 'export',
                description:
                    'The product with what it depends on, as one JSON document, to back it up or recreate it.',
            },
        },
    },
    bucket: {
        description:
            'Data buckets (time series). Data is read and written with {tool:bucket_data_read} / {tool:bucket_data_write}.',
        version: 'v1',
        path: 'buckets',
        id: 'bucket',
        ops: {
            list: 'Bucket_List',
            create: 'Bucket_Create',
            get: 'Bucket_ReadConfig',
            update: 'Bucket_Update',
            delete: 'Bucket_Delete',
            clone: 'Bucket_Clone',
            projects: 'Bucket_UpdateProjects',
        },
        actions: {
            import: {
                op: 'Bucket_CreateImport',
                method: 'post',
                path: 'imports',
                description:
                    'Load records from a .csv already in a file storage (upload it with {tool:storage_file_write}) into an existing bucket: body {source: "storage", storage, file}. Header row; ";" separated if the header has one, "," otherwise. The time column (ts, date or timestamp) takes unix MILLISECONDS (seconds are misread as ms) or ISO 8601, always taken as UTC. Other cells become numbers when they parse, text otherwise; empty and "null" are left out. Columns named like a bucket tag (config.tags) are stored as that tag: a device column in a bucket tagged `device` (product buckets are) makes the records readable per device. Writes straight to the backend (MongoDB or InfluxDB, not DynamoDB), with no rate limit and no bucket_write events; answers {"progress": N}, a percentage (100 when done; only the last line is shown). The way to load history in bulk: {tool:bucket_data_write} is one sample per call and rate limited.',
            },
        },
    },
    dashboard: {
        description:
            'Dashboards: HTML apps on the dashboard SDK, published with {tool:dashboard_publish} (widget layouts are legacy).',
        version: 'v1',
        path: 'dashboards',
        id: 'dashboard',
        sdk: true,
        notes: 'Build dashboards as HTML apps that use the dashboard SDK (source "url", the page at `url`): {tool:dashboard_publish} uploads the app and points the dashboard at it. Start it with {tool:dashboard_init} (a TypeScript project on the npm package @thinger-io/dashboard-sdk), develop it on its own dev server with {tool:dashboard_dev} (a link that opens the local app against this server, in the context you pick), and publish it once it works. Widget layouts (source "widgets") are legacy, made in the console editor: read them, do not create new ones. The SDK reference is under `sdk`; its types come with the package (node_modules/@thinger-io/dashboard-sdk). A per-device, product, asset type, asset group or project dashboard is the "dashboard" property of that resource instead ({tool:dashboard_publish} with `to: [{type, id}]`).',
        ops: {
            list: 'Dashboard_List',
            create: 'Dashboard_Create',
            get: 'Dashboard_ReadConfig',
            update: 'Dashboard_Update',
            delete: 'Dashboard_Delete',
            clone: 'Dashboard_Clone',
            projects: 'Dashboard_UpdateProjects',
        },
    },
    endpoint: {
        description:
            'Endpoints: outgoing HTTP calls, emails, notifications (run one with its `call` action).',
        version: 'v1',
        path: 'endpoints',
        id: 'endpoint',
        ops: {
            list: 'Endpoint_List',
            create: 'Endpoint_Create',
            get: 'Endpoint_ReadConfig',
            update: 'Endpoint_Update',
            delete: 'Endpoint_Delete',
            clone: 'Endpoint_Clone',
            projects: 'Endpoint_UpdateProjects',
        },
        actions: {
            call: {
                op: 'Endpoint_Call',
                method: 'post',
                path: 'call',
                description:
                    'Run the endpoint with `body` as its payload (its templates see it as {{payload}}); returns what it answered.',
            },
        },
        notes: 'Every endpoint needs `config`, even type "virtual" (a no-op receiver for tests and alarm notifications): {"endpoint": "…", "name": "…", "type": "virtual", "config": {}}.',
    },
    storage: {
        description: 'File storages (their files are handled with the storage_file_* tools).',
        version: 'v1',
        path: 'storages',
        id: 'storage',
        ops: {
            list: 'Storage_List',
            create: 'Storage_Create',
            get: 'Storage_ReadConfig',
            update: 'Storage_Update',
            delete: 'Storage_Delete',
            clone: 'Storage_Clone',
            projects: 'Storage_UpdateProjects',
        },
    },
    asset_type: {
        description: 'Asset types: a category of device (e.g. "boiler"), with its own properties.',
        version: 'v1',
        path: 'types',
        id: 'type',
        ops: {
            list: 'Type_List',
            create: 'Type_Create',
            get: 'Type_ReadConfig',
            update: 'Type_Update',
            delete: 'Type_Delete',
            clone: 'Type_Clone',
            projects: 'Type_UpdateProjects',
        },
    },
    asset_group: {
        description: 'Asset groups: a set of devices (e.g. a site), with its own properties.',
        version: 'v1',
        path: 'groups',
        id: 'group',
        ops: {
            list: 'Group_List',
            create: 'Group_Create',
            get: 'Group_ReadConfig',
            update: 'Group_Update',
            delete: 'Group_Delete',
            clone: 'Group_Clone',
            projects: 'Group_UpdateProjects',
        },
    },
    project: {
        description: 'Projects: group resources of any type to share them or show them together.',
        version: 'v1',
        path: 'projects',
        id: 'project',
        ops: {
            list: 'Project_List',
            create: 'Project_Create',
            get: 'Project_ReadConfig',
            update: 'Project_Update',
            delete: 'Project_Delete',
            clone: 'Project_Clone',
        },
        notes: 'The project\'s own id is the short one ("plant_a"); resources name it "<owner>@<project>" ("alice@plant_a"). They join it when created with projects in the body, or through their own update: {projects: ["alice@plant_a"]}; the list replaces the previous one. List the resources of a project with filter {project: "<project>"}. Share it with other accounts through project_member (and project_role for their permissions). New projects limit bucket data to their own devices (config.limit_bucket_access, default true for new projects since Thinger 7.4): reads and tag lists of a bucket through the project return only its devices\' records, so such buckets need a device tag. Turn it on for older projects with update {config: {limit_bucket_access: true}} before sharing them with members or project-scoped tokens.',
    },
    token: {
        description: 'Access tokens of the account, with their permission tree.',
        version: 'v1',
        path: 'tokens',
        id: 'token',
        ops: {
            list: 'Token_List',
            create: 'Token_Create',
            get: 'Token_ReadConfig',
            update: 'Token_Update',
            delete: 'Token_Delete',
            clone: 'Token_Clone',
            projects: 'Token_UpdateProjects',
        },
        notes: 'Permissions: `allow` (and optional `deny`) is {ResourceType: {id or "*": [actions] or "*"}}, e.g. {"Device": {"*": "*"}} or {"Device": {"sensor_1": ["ReadDeviceStatus", "AccessDeviceResources"]}}; {"*": {"*": "*"}} is full access. {tool:resource_describe} of any type lists its ResourceType and actions under `permissions`. The JWT (`access_token`) is returned by create and get, never by list. `expire` (unix ms) makes a token expire: it is signed into the JWT, so it cannot be changed on update (delete the token and create it again), and the server deletes the token afterwards. Without it a token does not expire: delete it to revoke it. Servers before Thinger 7.4 ignore `expire`.',
    },
    alarm_rule: {
        description: 'Alarm rules: conditions on device or bucket data that raise alarm instances.',
        version: 'v1',
        path: 'alarms/rules',
        id: 'rule',
        ops: {
            list: 'Alarm_ListRules',
            create: 'Alarm_CreateRule',
            get: 'Alarm_ReadRuleConfig',
            update: 'Alarm_UpdateRule',
            delete: 'Alarm_DeleteRule',
            clone: 'Alarm_CloneRule',
            projects: 'Alarm_UpdateRuleProjects',
        },
        notes: 'Condition values are strings ("30", not 30: a number never matches) and only enabled devices are evaluated. A device_property source projects fields of the property document, so its fields are `value.<field>` (fields ["value.level"], condition field "battery.value.level"; "level" alone yields null and every device is skipped). The document also has `modified` and `created` (unix ms, UTC): fields ["modified"] with condition field `ts() - battery.modified` above "3600000" flags a property not updated for an hour. A condition value can name a field of another source of the same device ("limits.value.max_depth_m"): per-device thresholds, inherited from asset type, group or product; sources, conditions and confirmations are in {tool:doc_read} id "concepts" (Alarms). Try a rule before saving it with its test_rule / test_source / test_notification actions ({tool:resource_call}).',
        actions: {
            test_rule: {
                op: 'Alarm_TestRuleTest-rule',
                method: 'post',
                path: 'test-rule',
                bodyFromRecord: ['name', 'description', 'enabled', 'config'],
                description:
                    'Evaluate a whole rule without raising alarms or notifying: `body` is the rule as it would be saved ({name, enabled, config}), and the rule id may not exist yet. Without `body`, it tests the saved rule.',
            },
            test_source: {
                op: 'Alarm_TestRuleSourceTest-source',
                method: 'post',
                path: 'test-source',
                description:
                    'Read one data source as the rule would (the rule id need not exist; the source comes in the body): `body` is {name, source: "bucket" | "device_property" | "device_status", <source>: {…}}, e.g. {name: "loc", source: "device_property", device_property: {device: "d1", property: "location"}}. A bucket source without aggregation reads the window of `check_interval` (as in config.check_interval; default the saved rule\'s, or 1 minute).',
            },
            test_notification: {
                op: 'Alarm_TestRuleNotificationTest-notification',
                method: 'post',
                path: 'test-notification',
                description:
                    'Send the rule notification for real, through its endpoints, with `body` as the event data: people get it. Confirm with the user first.',
            },
        },
    },
    alarm_instance: {
        description:
            'Alarm instances raised by the rules; update them to acknowledge, shelve or clear.',
        version: 'v1',
        path: 'alarms/instances',
        id: 'instance',
        ops: {
            list: 'Alarm_ListInstances',
            get: 'Alarm_ReadInstanceConfig',
            update: 'Alarm_UpdateInstance',
            delete: 'Alarm_DeleteInstance',
            projects: 'Alarm_UpdateInstanceProjects',
        },
        actions: {
            stats: {
                op: 'Alarm_ReadInstanceStats',
                method: 'get',
                path: 'stats',
                on: 'collection',
                description:
                    'How many instances there are in each state: the health of the account at a glance, without listing them.',
            },
        },
        notes: 'States: 0 none, 1 active, 2 acknowledged, 3 latched, 4 shelved, 5 cleared; severities: 0 none, 1 low, 2 medium, 3 high, 4 critical. Acknowledge with update {state: 2, annotation?}; shelve with {state: 4, reactivation: {type: "timespan", timespan: {value, magnitude: "minute"|"hour"|"day"…}}}; clear with {state: 5} (a cleared alarm cannot be reactivated). Prefer clearing to deleting: delete removes the history. List filters: state and severity (arrays allowed), name, sort, order, and exact values of nested fields with dots: {"alarm.rule": "<rule id>"}, {"origin.id": "<device>"}, or both (servers before this filter ignore it and list every instance: check the records). `search` matches the instance id and the rule\'s name, not the rule id. A record: {instance, name, description, state, severity, alarm: {rule: <rule id>, group, type}, origin: {source: "device", id: <device>, name}, asset_type, asset_group, activation: {initiated, completed, detections}, normalization: {…}, evaluation: {last_values: {<source>: {<field>: value}}, last_completed}, notification: {last_type, total_completed, total_failed}, project}; times in unix ms.',
    },
    claim: {
        description: 'Device claims: codes that let end users take ownership of a device.',
        version: 'v1',
        path: 'claims',
        id: 'claim',
        ops: {
            list: 'Claim_List',
            create: 'Claim_Create',
            get: 'Claim_ReadConfig',
            update: 'Claim_Update',
            delete: 'Claim_Delete',
            clone: 'Claim_Clone',
            projects: 'Claim_UpdateProjects',
        },
    },
    property: {
        description: 'Account properties: JSON values stored on the account.',
        version: 'v1',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Property_ListProperties',
            create: 'Property_Create',
            get: 'Property_Read',
            update: 'Property_Update',
            patch: 'Property_Patch',
            delete: 'Property_Delete',
            clone: 'Property_Clone',
        },
        notes: PROPERTY_NOTES,
    },
    role: {
        description: 'Roles: named permission sets for project members.',
        version: 'v1',
        path: 'roles',
        id: 'role',
        notes: 'Account roles: named permission sets ({allow, deny} trees as in tokens) that project members get through `global_roles`.',
        ops: {
            list: 'Role_List',
            create: 'Role_Create',
            get: 'Role_ReadConfig',
            update: 'Role_Update',
            delete: 'Role_Delete',
            clone: 'Role_Clone',
        },
    },
    sync: {
        description:
            'Syncs: shared semaphores with a number of slots that devices or scripts take (locks) to coordinate.',
        version: 'v1',
        path: 'syncs',
        id: 'sync',
        notes: 'config: {available: slots, timeout: default lock lifetime in seconds (0 = until released)}. Take slots by creating a sync_lock, release them by deleting it. E.g. {available: 1} lets one controller at a time use a pump.',
        ops: {
            list: 'Sync_List',
            create: 'Sync_Create',
            get: 'Sync_ReadConfig',
            update: 'Sync_Update',
            delete: 'Sync_Delete',
            clone: 'Sync_Clone',
            projects: 'Sync_UpdateProjects',
        },
    },

    plugin: {
        description:
            'Plugins installed on the account: containers that add features (integrations, apps); their API is reached with {tool:plugin_call}.',
        version: 'v1',
        path: 'plugins',
        id: 'plugin',
        ops: { list: 'Plugin_List', get: 'Plugin_ReadInfo' },
        listQuery: { filter: 'installed' },
        listWhole: true,
        listCache: { params: { filter: 'available' }, minutes: 15 },
        listFields: [
            'name',
            'plugin',
            'version',
            'description',
            'author',
            'deprecated',
            'metadata.name',
            'metadata.description',
            'metadata.category',
            'metadata.vendor',
            'state',
            'status',
            'enabled',
        ],
        notes: 'resource_list shows the installed plugins; with filter {filter: "available"} it lists the catalog of plugins that can be installed, summarised and paged (it is long; kept 15 minutes, so search it freely): `search` matches words against name, description, category and vendor ("lorawan milesight"). Install, upgrade, start, stop… with {tool:resource_call} actions. A plugin is usually configured through its properties (type plugin_property). Its logs and terminal are only available in the console. Install and upgrade leave the container created but stopped: run the start action afterwards. resource_get of a plugin that is not installed answers with its catalog manifest, without `state`: its resources.products[].profile are complete product profiles for real hardware (api, buckets, properties, flows, autoprovisions, code) to learn from or reuse. The manifest comes without the source of the code and the console dashboard (_resources), which are large: pass full: true to resource_get to include them (the decoder of a LoRaWAN product, for instance); remove also deletes its files, volumes and properties.',
        actions: {
            install: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'create' },
                description:
                    'Install the plugin `id` (its name in the plugin catalog); `body` holds its settings, query {version} picks one (default main). The container is created stopped: start it next.',
            },
            upgrade: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'upgrade' },
                description:
                    'Upgrade the plugin to query {version} (default master); `body` holds its settings. The container is recreated stopped (volumes kept): start it next.',
            },
            remove: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'remove' },
                description:
                    'Uninstall the plugin: removes its container, files, volumes (its data) and properties. Confirm with the user first.',
            },
            start: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'start' },
                description: 'Start the plugin container.',
            },
            stop: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'stop' },
                description: 'Stop the plugin container.',
            },
            restart: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'restart' },
                description: 'Restart the plugin container.',
            },
            pause: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'pause' },
                description: 'Pause the plugin container.',
            },
            unpause: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'unpause' },
                description: 'Resume a paused plugin container.',
            },
            kill: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'kill' },
                description: 'Kill the plugin container. Confirm with the user first.',
            },
            public: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'public' },
                description: "Make the plugin's web interface reachable without signing in.",
            },
            private: {
                op: 'Plugin_ManageState',
                method: 'post',
                path: '',
                query: { action: 'private' },
                description: "Make the plugin's web interface require signing in again.",
            },
        },
    },
    // ─── Server administration ──────────────────────────────────────
    // Server-wide (not under an account): only server administrators may
    // use them, and the server says so when the token may not.
    user: {
        description: 'User accounts of the server.',
        version: 'v1',
        scope: 'server',
        path: 'users',
        id: 'user',
        ops: {
            list: 'User_List',
            create: 'User_Create',
            get: 'User_ReadConfig',
            update: 'User_Update',
            delete: 'User_Delete',
        },
        notes: 'Creating a user sets its password: ask the user for it, never invent one. Deleting a user deletes everything the account owns.',
    },
    host: {
        description: 'Hosts of the server cluster.',
        version: 'v1',
        scope: 'server',
        path: 'hosts',
        id: 'host',
        ops: {
            list: 'Host_List',
            create: 'Host_Create',
            get: 'Host_ReadConfig',
            update: 'Host_Update',
            delete: 'Host_Delete',
        },
        notes: 'update_settings is a JSON merge over the host\'s custom settings and only takes effect after the restart action, which drops every connection: plan both with the user. Ports are strings. Read {tool:doc_read} id "server-admin" first. read_settings leaves out some keys (limits of accounts, brands, domains and members, database, plugins, rate limiter); {tool:resource_get} of the host shows the effective ones in current_settings. On cloud instances (license "cloud" in /v1/server/version) the subscription manages those limits, database, plugins, rate limiter and http_server.hosts: changing them answers 403 naming the path; tell the user it depends on their plan.',
        actions: {
            logs: {
                op: 'Host_ReadLogs',
                method: 'get',
                path: 'logs',
                description:
                    'The last lines of the host log, as text. query: {lines: 200, timestamps: true, since: …}. Reads the server container named in deployment.container_name (default "thinger"): not found means it has another name.',
            },
            restart: {
                op: 'Host_UpdateStateRestart',
                method: 'post',
                path: 'restart',
                description:
                    'Restart the host: its devices and users lose the connection meanwhile. Confirm with the user first.',
            },
            read_settings: {
                op: 'Host_ReadSettings',
                method: 'get',
                path: 'settings',
                description: 'Read the host settings.',
            },
            update_settings: {
                op: 'Host_UpdateSettings',
                method: 'put',
                path: 'settings',
                description:
                    'Replace the host settings with `body`; read them first. Confirm with the user first.',
            },
        },
    },
    domain: {
        description: 'Custom domains the server answers on.',
        version: 'v1',
        scope: 'server',
        path: 'domains',
        id: 'domain',
        ops: {
            list: 'Domain_List',
            create: 'Domain_Create',
            get: 'Domain_ReadConfig',
            update: 'Domain_Update',
            delete: 'Domain_Delete',
        },
        actions: {
            verify: {
                op: 'Domain_Verify',
                method: 'post',
                path: 'verify',
                description:
                    'Check that the domain resolves to this server (after the user configures its DNS).',
            },
        },
        notes: 'A domain is usable once it resolves to this server (an A/AAAA record with its IP, or a CNAME to its current hostname) with port 80 reachable, and the verify action succeeds (it gets the certificate; a failure says why: DNS, invalid suffix…). Ask the user to set up the DNS record, then verify. A brand with the same domain then gives it its look: {tool:doc_read} id "server-admin" has the whole flow.',
    },
    brand: {
        description: 'Brands: the look (and email) of the console on a domain.',
        version: 'v1',
        scope: 'server',
        path: 'brands',
        id: 'brand',
        notes: 'Change a brand with {tool:resource_update} and merge: true (JSON merge of config and email; null removes a key; logos are kept). Without merge the whole brand is replaced and logos missing from it are deleted: only send complete objects. Logos and images go as data URLs (png or webp); to keep one in a full update, send back its /brand/images/… URL. The email settings are the brand\'s `email` field; test them with the test_email action (sent to the admin calling). For the whole domain + brand setup read {tool:doc_read} id "server-admin". Reading a brand that does not exist returns defaults (only config.accounts), not an error: a real brand has the `brand` field.',
        ops: {
            list: 'Brand_List',
            create: 'Brand_Create',
            get: 'Brand_ReadConfig',
            update: 'Brand_Update',
            patch: 'Brand_Patch',
            delete: 'Brand_Delete',
        },
        actions: {
            test_email: {
                op: 'Brand_TestEmail',
                method: 'post',
                path: 'email/test',
                description: "Send a test email with the brand's email settings.",
            },
        },
    },
    oauth_client: {
        description: 'OAuth clients: applications allowed to sign users in against this server.',
        version: 'v1',
        scope: 'server',
        path: 'oauth_clients',
        id: 'oauth_client',
        notes: 'Its `secret` is a credential: choose a random one when creating it, and do not repeat it in answers; get returns it.',
        ops: {
            list: 'OauthClient_List',
            create: 'OauthClient_Create',
            get: 'OauthClient_ReadConfig',
            update: 'OauthClient_Update',
            delete: 'OauthClient_Delete',
        },
    },
    identity_provider: {
        description:
            'Identity providers: external sign-in (OpenID Connect, OAuth) for the console.',
        version: 'v1',
        scope: 'server',
        path: 'identity_providers',
        id: 'identity_provider',
        ops: {
            list: 'IdentityProvider_List',
            create: 'IdentityProvider_Create',
            get: 'IdentityProvider_ReadConfig',
            update: 'IdentityProvider_Update',
            delete: 'IdentityProvider_Delete',
        },
        notes: 'Client secrets belong to the user: ask for them, never invent or echo them back. The server allows them only when accounts.limits.identity_providers.max_count is raised (host settings, then restart). See {tool:doc_read} id "server-admin".',
    },
    proxy: {
        description: 'Proxies: services the server exposes through its own address.',
        version: 'v1',
        scope: 'server',
        path: 'proxies',
        id: 'proxy',
        ops: {
            list: 'Proxy_ListProxies',
            create: 'Proxy_Create',
            get: 'Proxy_ReadConfig',
            update: 'Proxy_Update',
            delete: 'Proxy_Delete',
        },
    },

    sync_lock: {
        description: 'Locks of a sync: slots currently taken.',
        version: 'v1',
        parent: 'sync',
        path: 'locks',
        id: 'lock',
        ops: {
            list: 'Sync_ListLocks',
            create: 'Sync_CreateLock',
            get: 'Sync_ReadLockConfig',
            update: 'Sync_UpdateLock',
            delete: 'Sync_DeleteLock',
        },
        notes: 'Create takes `slots` (default 1) and fails when not enough are free; `timeout` (seconds) overrides the sync default; without an id a random one is assigned. Delete the lock to release its slots.',
    },

    // ─── Device children ────────────────────────────────────────────
    device_property: {
        description: 'Properties of a device: its structured state (configuration, calibration…).',
        version: 'v3',
        parent: 'device',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Device_ListProperties',
            create: 'Device_CreateProperty',
            get: 'Device_ReadProperty',
            update: 'Device_UpdateProperty',
            patch: 'Device_PatchProperty',
            delete: 'Device_DeleteProperty',
            clone: 'Device_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    device_token: {
        description: 'Tokens scoped to one device and some of its resources.',
        version: 'v1',
        parent: 'device',
        path: 'tokens',
        id: 'token',
        bodyId: [],
        ops: {
            list: 'Device_ListTokens',
            create: 'Device_CreateToken',
            delete: 'Device_DeleteToken',
        },
        notes: 'Create with {token_name, token_resources?: [resource names] (all when omitted), token_expiration?: unix seconds or a duration such as "30d"}.',
    },
    device_bucket: {
        description: 'Buckets that hold data of a device (read-only listing).',
        version: 'v3',
        parent: 'device',
        path: 'buckets',
        id: 'bucket',
        ops: { list: 'Device_ListBuckets' },
    },
    device_bucket_tag: {
        description: 'Tags of a device bucket (parent: "<device>/<bucket>").',
        version: 'v3',
        parent: 'device_bucket',
        path: 'tags',
        id: 'tag',
        ops: { list: 'Device_ListBucketTags', get: 'Device_ReadBucketTag' },
    },
    device_service: {
        description: 'Services a device exposes (web, VNC…).',
        version: 'v3',
        parent: 'device',
        path: 'services',
        id: 'service',
        ops: { list: 'Device_ListServices', get: 'Device_ReadService' },
    },
    device_callback: {
        description:
            'HTTP callback settings of a device: what the server does with the data it receives.',
        version: 'v3',
        parent: 'device',
        path: 'callback',
        ops: { get: 'Device_ReadCallbackConfig', update: 'Device_UpdateCallback' },
    },

    // ─── Product children ───────────────────────────────────────────
    product_property: {
        description: 'Properties of a product.',
        version: 'v1',
        parent: 'product',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Product_ListProperties',
            create: 'Product_CreateProperty',
            get: 'Product_ReadProperty',
            update: 'Product_UpdateProperty',
            patch: 'Product_PatchProperty',
            delete: 'Product_DeleteProperty',
            clone: 'Product_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    product_profile_api: {
        description:
            'API resources a product adds to its devices (calls to device resources, endpoints, scripts).',
        version: 'v1',
        parent: 'product',
        path: 'profile/api',
        id: 'resource',
        upsert: true,
        ops: {
            list: 'Product_ReadProfile',
            create: 'Product_UpdateProductProfileResource',
            get: 'Product_ReadProductProfileResource',
            update: 'Product_UpdateProductProfileResource',
            delete: 'Product_DeleteProductProfileResource',
        },
        notes: PROFILE_API_NOTES,
        actions: {
            replace_all: {
                op: 'Product_UpdateProfile',
                method: 'put',
                path: '',
                on: 'collection',
                description:
                    'Replace every entry of this profile category at once with `body` ({id: entry, …}). The only way to use ids with placeholders such as {{device}}_data, which the per-entry path does not accept.',
            },
        },
    },
    product_profile_bucket: {
        description: 'Buckets a product keeps for each of its devices.',
        version: 'v1',
        parent: 'product',
        path: 'profile/buckets',
        id: 'resource',
        upsert: true,
        ops: {
            list: 'Product_ReadProfile',
            create: 'Product_UpdateProductProfileResource',
            get: 'Product_ReadProductProfileResource',
            update: 'Product_UpdateProductProfileResource',
            delete: 'Product_DeleteProductProfileResource',
        },
        notes: PROFILE_BUCKET_NOTES,
        actions: {
            replace_all: {
                op: 'Product_UpdateProfile',
                method: 'put',
                path: '',
                on: 'collection',
                description:
                    'Replace every entry of this profile category at once with `body` ({id: entry, …}). The only way to use ids with placeholders such as {{device}}_data, which the per-entry path does not accept.',
            },
        },
    },
    product_profile_property: {
        description: 'Properties a product creates on each of its devices.',
        version: 'v1',
        parent: 'product',
        path: 'profile/properties',
        id: 'resource',
        upsert: true,
        ops: {
            list: 'Product_ReadProfile',
            create: 'Product_UpdateProductProfileResource',
            get: 'Product_ReadProductProfileResource',
            update: 'Product_UpdateProductProfileResource',
            delete: 'Product_DeleteProductProfileResource',
        },
        notes: PROFILE_PROPERTY_NOTES,
        actions: {
            replace_all: {
                op: 'Product_UpdateProfile',
                method: 'put',
                path: '',
                on: 'collection',
                description:
                    'Replace every entry of this profile category at once with `body` ({id: entry, …}). The only way to use ids with placeholders such as {{device}}_data, which the per-entry path does not accept.',
            },
        },
    },
    product_profile_autoprovision: {
        description: 'Autoprovisioning rules: which connecting devices join the product.',
        version: 'v1',
        parent: 'product',
        path: 'profile/autoprovisions',
        id: 'resource',
        upsert: true,
        ops: {
            list: 'Product_ReadProfile',
            create: 'Product_UpdateProductProfileResource',
            get: 'Product_ReadProductProfileResource',
            update: 'Product_UpdateProductProfileResource',
            delete: 'Product_DeleteProductProfileResource',
        },
        notes: PROFILE_NOTES,
        actions: {
            replace_all: {
                op: 'Product_UpdateProfile',
                method: 'put',
                path: '',
                on: 'collection',
                description:
                    'Replace every entry of this profile category at once with `body` ({id: entry, …}). The only way to use ids with placeholders such as {{device}}_data, which the per-entry path does not accept.',
            },
        },
    },
    product_profile_flow: {
        description: 'Data flows of a product: periodic reads of device resources.',
        version: 'v1',
        parent: 'product',
        path: 'profile/flows',
        id: 'resource',
        upsert: true,
        ops: {
            list: 'Product_ReadProfile',
            create: 'Product_UpdateProductProfileResource',
            get: 'Product_ReadProductProfileResource',
            update: 'Product_UpdateProductProfileResource',
            delete: 'Product_DeleteProductProfileResource',
        },
        notes: PROFILE_NOTES,
        actions: {
            replace_all: {
                op: 'Product_UpdateProfile',
                method: 'put',
                path: '',
                on: 'collection',
                description:
                    'Replace every entry of this profile category at once with `body` ({id: entry, …}). The only way to use ids with placeholders such as {{device}}_data, which the per-entry path does not accept.',
            },
        },
    },
    product_profile_code: {
        description: 'Script code of a product (JavaScript run by the server for its devices).',
        version: 'v1',
        parent: 'product',
        path: 'profile/code',
        ops: { get: 'Product_ReadProfileCode', update: 'Product_UpdateProfileCode' },
        notes: 'Update with {code: "<JavaScript>", storage: ""}, or {storage: "<id>"} to load <storage>/index.js, or {storage, path: "<folder>"} to load <storage>/<folder>/index.js, with that folder\'s node_modules (one storage can hold the dashboard in app/ and each product\'s code in code/<product>/). Update again after editing the file. Functions are synchronous globals (`function name(arg) {…}`) that the profile calls by name: API targets, payload_function, device_id_resolver. `Date` runs in UTC: for local hours use Intl.DateTimeFormat with a timeZone (it follows daylight saving). Read {tool:doc_read} id "product-code" before writing it.',
    },
    product_service: {
        description: 'Services a product exposes on its devices.',
        version: 'v1',
        parent: 'product',
        path: 'services',
        id: 'service',
        upsert: true,
        ops: {
            list: 'Product_ReadServices',
            create: 'Product_UpdateServices',
            get: 'Product_ReadServices',
            update: 'Product_UpdateServices',
            delete: 'Product_DeleteServices',
        },
    },

    // ─── Bucket children ────────────────────────────────────────────
    bucket_tag: {
        description: 'Tags of a bucket and their values.',
        version: 'v1',
        parent: 'bucket',
        path: 'tags',
        id: 'tag',
        ops: { list: 'Bucket_ListTags', get: 'Bucket_ReadTag' },
    },
    bucket_export: {
        description: 'Exports of a bucket (files generated from its data).',
        version: 'v1',
        parent: 'bucket',
        path: 'exports',
        id: 'file',
        bodyId: [],
        ops: {
            list: 'Bucket_ListExports',
            create: 'Bucket_CreateExport',
            delete: 'Bucket_DeleteExport',
        },
    },

    plugin_property: {
        description: 'Properties of a plugin, usually its configuration.',
        version: 'v1',
        parent: 'plugin',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Plugin_ListProperties',
            create: 'Plugin_CreateProperty',
            get: 'Plugin_ReadProperty',
            update: 'Plugin_UpdateProperty',
            patch: 'Plugin_PatchProperty',
            delete: 'Plugin_DeleteProperty',
            clone: 'Plugin_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    // ─── Asset and project children ─────────────────────────────────
    asset_type_property: {
        description: 'Properties of an asset type.',
        version: 'v1',
        parent: 'asset_type',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Type_ListProperties',
            create: 'Type_CreateProperty',
            get: 'Type_ReadProperty',
            update: 'Type_UpdateProperty',
            patch: 'Type_PatchProperty',
            delete: 'Type_DeleteProperty',
            clone: 'Type_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    asset_group_property: {
        description: 'Properties of an asset group.',
        version: 'v1',
        parent: 'asset_group',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Group_ListProperties',
            create: 'Group_CreateProperty',
            get: 'Group_ReadProperty',
            update: 'Group_UpdateProperty',
            patch: 'Group_PatchProperty',
            delete: 'Group_DeleteProperty',
            clone: 'Group_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    project_property: {
        description: 'Properties of a project.',
        version: 'v1',
        parent: 'project',
        path: 'properties',
        id: 'property',
        ops: {
            list: 'Project_ListProperties',
            create: 'Project_CreateProperty',
            get: 'Project_ReadProperty',
            update: 'Project_UpdateProperty',
            patch: 'Project_PatchProperty',
            delete: 'Project_DeleteProperty',
            clone: 'Project_CloneProperty',
        },
        notes: PROPERTY_NOTES,
    },
    project_member: {
        description: 'Members a project is shared with, and their roles.',
        version: 'v1',
        parent: 'project',
        path: 'members',
        id: 'member',
        notes: 'A member is an existing account, by username (`member`), given access to the project: `roles` (project roles), `global_roles` (account roles) and/or its own `allow` / `deny`; `groups` restricts it to asset groups. With `account: {email, password}` the server creates that account first (verified, role member, this project as its default). Removing a member also deletes what it created inside the project. Resources join the project through their own update ({projects: ["<owner>@<project>"]}).',
        ops: {
            list: 'Project_ListMembers',
            create: 'Project_CreateMember',
            get: 'Project_ReadMemberConfig',
            update: 'Project_UpdateMember',
            delete: 'Project_DeleteMember',
        },
    },
    project_role: {
        description: 'Roles defined inside a project.',
        version: 'v1',
        parent: 'project',
        path: 'roles',
        id: 'role',
        notes: 'Roles inside a project ({role, enabled, allow, deny}) to give to its members through `roles`. resource_describe of any type lists the actions its permissions accept.',
        ops: {
            list: 'Project_ListRoles',
            create: 'Project_CreateRole',
            get: 'Project_ReadRoleConfig',
            update: 'Project_UpdateRole',
            delete: 'Project_DeleteRole',
            clone: 'Project_CloneRole',
        },
    },
};

/** HTTP method of each verb, and what it appends to the item path. */
export const VERBS = /** @type {const} */ ({
    list: { method: 'get', on: 'collection' },
    create: { method: 'post', on: 'collection' },
    get: { method: 'get', on: 'item' },
    update: { method: 'put', on: 'item' },
    patch: { method: 'patch', on: 'item' },
    delete: { method: 'delete', on: 'item' },
    clone: { method: 'post', on: 'item', suffix: 'clone' },
    projects: { method: 'put', on: 'item', suffix: 'projects' },
});

/**
 * Names of the types served, optionally only those supporting `verb`.
 *
 * @param {{ verb?: Verb }} [opts]
 */
export function typeNames({ verb } = {}) {
    return Object.entries(CATALOG)
        .filter(([, t]) => !verb || verb in t.ops)
        .map(([name]) => name);
}

/** Parents of a type, outermost first: `device_bucket_tag` → [device, device_bucket]. */
export function ancestry(name) {
    const chain = [];
    for (let t = CATALOG[name]?.parent; t; t = CATALOG[t].parent) chain.unshift(t);
    return chain;
}

/** Id names of a type, as an array (empty for single resources). */
export function idNames(type) {
    return type.id === undefined ? [] : [type.id].flat();
}

/** How a type's ids are written: `<device>`. */
export function idHint(name) {
    return idNames(CATALOG[name])
        .map((n) => `<${n}>`)
        .join('/');
}

/** How the parent of a type is written: `<device>/<bucket>`. */
export function parentHint(name) {
    return ancestry(name).map(idHint).join('/');
}

/**
 * Split a `a/b` reference into exactly `count` non-empty segments.
 *
 * @param {unknown} value
 * @param {number} count
 * @param {string} what  Argument name and expected shape, for the error.
 */
function segments(value, count, what) {
    if (count === 0) return [];
    const parts = value === undefined || value === null ? [] : String(value).split('/');
    if (parts.length !== count || parts.some((p) => !p)) {
        throw inputError(`${what} is required`);
    }
    // `.` and `..` survive escaping and the URL resolves them: an id `..`
    // would point at the parent (a device instead of its property).
    if (parts.some((p) => p === '.' || p === '..'))
        throw inputError(`${what}: invalid id "${value}"`);
    return parts;
}

/**
 * The path of a type's collection or item, from the outermost ancestor
 * down: the real URL (ids escaped, the account from lib/paths.js), or the
 * OpenAPI template the tests and `resource_describe` match (ids as `{}`).
 *
 * @param {string} name
 * @param {{ on: 'collection' | 'item', suffix?: string, version?: string }} at
 * @param {{ parent?: string, id?: string, user?: string | null }} args
 * @param {boolean} template
 */
function locate(name, at, { parent, id, user } = {}, template = false) {
    const type = CATALOG[name];
    const version = at.version || type.version;
    const chain = ancestry(name);
    const parentIds = template
        ? []
        : segments(
              parent,
              chain.reduce((n, t) => n + idNames(CATALOG[t]).length, 0),
              `parent (${parentHint(name)})`,
          );
    const seg = (value) => (template ? '{}' : encodeURIComponent(value));

    let path = '';
    for (const t of chain) {
        path += `/${CATALOG[t].path}`;
        for (const _ of idNames(CATALOG[t])) path += `/${seg(parentIds.shift())}`;
    }
    path += `/${type.path}`;
    if (at.on === 'item' && idNames(type).length) {
        const ids = template
            ? idNames(type).map(() => '{}')
            : segments(id, idNames(type).length, `id (${idHint(name)})`);
        path += ids.map((i) => `/${template ? i : encodeURIComponent(i)}`).join('');
    }
    if (at.suffix) path += `/${at.suffix}`;

    // Server-wide types (users, hosts, domains…) hang off /v{N}, not off an account.
    if (type.scope === 'server') return `/${version}${path}`;
    if (template) return `/${version}/users/{}${path}`;
    return `${{ v1, v2, v3 }[version](user)}${path}`;
}

/**
 * Where a verb points: collection or item, the method, and the item suffix.
 *
 * @returns {{ method: string, at: { on: 'item' | 'collection', suffix?: string } }}
 */
function verbTarget(type, verb) {
    const spec = VERBS[verb];
    const upsertCreate = verb === 'create' && type.upsert;
    return {
        method: upsertCreate ? 'put' : spec.method,
        at: {
            on: /** @type {'item' | 'collection'} */ (
                spec.on === 'item' || upsertCreate ? 'item' : 'collection'
            ),
            suffix: 'suffix' in spec ? spec.suffix : undefined,
        },
    };
}

/**
 * Resolve the request a verb maps to.
 *
 * @param {string} name  Catalog type.
 * @param {Verb} verb
 * @param {{ parent?: string, id?: string, user?: string | null }} [args]
 * @returns {{ method: string, url: string }}
 */
export function requestFor(name, verb, args = {}) {
    const type = CATALOG[name];
    if (!type) throw inputError(`Unknown type "${name}"`);
    if (!(verb in type.ops)) throw inputError(`Type "${name}" does not support ${verb}`);
    const { method, at } = verbTarget(type, verb);
    return { method, url: locate(name, at, args) };
}

/**
 * The OpenAPI path template and method a verb maps to, account part
 * included (`/v1/users/{}/devices/{}`).
 *
 * @param {string} name
 * @param {Verb} verb
 */
export function templateFor(name, verb) {
    const { method, at } = verbTarget(CATALOG[name], verb);
    return { method, path: locate(name, at, {}, true) };
}

/**
 * Resolve the request of a type's action (verify a domain, restart a host…).
 *
 * @param {string} name
 * @param {string} action
 * @param {{ parent?: string, id?: string, user?: string | null }} [args]
 */
export function actionRequest(name, action, args = {}) {
    const type = CATALOG[name];
    if (!type) throw inputError(`Unknown type "${name}"`);
    const spec = type.actions?.[action];
    if (!spec) {
        const known = Object.keys(type.actions || {});
        throw inputError(
            `Type "${name}" has no action "${action}"${known.length ? ` (it has: ${known.join(', ')})` : ''}`,
        );
    }
    return { method: spec.method, url: locate(name, actionAt(spec), args), query: spec.query };
}

/** OpenAPI template of an action, like templateFor. */
export function actionTemplate(name, action) {
    const spec = CATALOG[name].actions[action];
    return { method: spec.method, path: locate(name, actionAt(spec), {}, true) };
}

const actionAt = (spec) => ({
    on: spec.on || 'item',
    suffix: spec.path || undefined,
    version: spec.version,
});
