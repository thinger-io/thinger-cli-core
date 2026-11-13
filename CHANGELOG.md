# Changelog

## [Unreleased]

### Added

- The browser login without a terminal, in two steps: `login --oauth`
  (implied `--no-wait` when there is no terminal) and `profile add <name>
  --server <s> --oauth` print the link to approve (the code filled in) and
  return; `--profile <name> login --wait [--timeout <s>]` saves the session
  once approved (exit code 2 while not approved yet). Nothing is saved
  before; the login under way is kept with the profiles, started and
  checked by one process at a time, and the server is not asked sooner than
  it allows (`slow_down` honoured). It is not saved over a profile made
  meanwhile, nor as another account than the profile's; deleting the
  profile (or logging out) forgets it. `login` takes `-j`, which only
  starts a browser login.
- MCP `profile` type: `get`, `create` (a profile acting as another account:
  `credentials_from`, `impersonate`, `description`), `update` (the
  description), and the actions `login` (starts the browser sign-in and
  answers the link for the user) and `status` (saves the session once
  approved). They take no password, token or username; a profile being
  signed in for the first time is listed with its link; an existing profile
  is never moved to another server.

### Fixed

- A new profile (added, signed in, or made by an agent) becomes the default
  only when it is the only one: with several and none chosen, choosing is
  left to the user.
- A password login on an account with multi-factor authentication asks for
  the authenticator code (TOTP) or a backup code; an account with a security key only is sent
  to the browser login; a server refusing password sign-in says why and
  offers the browser login, instead of a raw 403.
- A token login reads the account from the token: a token of another
  account than `--username` is refused, `--username` can be left out, and a
  403 is accepted only for a token that says it is of that account.
- `logout` of a profile signed in through the browser says that the server
  keeps that session until it goes unused (the server cannot end a single
  session yet), instead of implying it was revoked.
- A browser login that signs in a profile again revokes the API token a
  password login had minted for it; the device flow uses the server's
  interval and expiry, never overlaps its checks, and a network error does
  not end it.

## [0.5.3] - 2026-11-13

### Added

- Profiles that act as another account with the credentials of an admin
  profile, so an agent picks the account with `--profile` and knows
  nothing of the impersonation:
  `profile add monitoring --credentials-from <profile> --impersonate monitoring`.
  The profile stores only `credentials_from` and `impersonate`; it reaches
  the server with that profile's session, and API paths use its own
  account (`-u, --user` still overrides it). Renewals are saved in the
  profile that holds the credentials and serialized per credentials, so
  the two never spend each other's refresh token. Such a profile is not
  signed in itself (`login` from it says to sign in the profile that holds
  the credentials), and without a session there the error says so. One
  level only. `logout` of one forgets it without revoking the borrowed
  session; `logout` and `profile delete` of a profile whose credentials
  others use are refused while those exist.
  The server sees the admin in every request of such a profile, so only
  what its account could do itself goes through: the paths of that account
  (or of the one asked for with `-u` or the MCP `user`), except changes to
  the account record itself (role, password); the server version and API
  description; `POST /oauth/token` and `/oauth/device/authorize`, sent
  without the session; and thinr's IOTMP relays to the account's devices,
  closing only those the process opened. Everything else (other accounts,
  users, hosts, proxies, plugins, which receive the request's headers,
  server settings…) is refused, pointing to the admin profile.
- A description per profile, saying what it is for:
  `profile add … -d, --description <text>` and `profile update <name> -d`.
  `profile list` and the MCP's `profile` type show it, with `impersonate`
  and `credentials_from` for profiles that impersonate, and the `profile`
  parameter of every tool asks agents to read them before using a profile
  other than the default. A new login keeps the description.

### Fixed

- OAuth sessions no longer end when several processes of the CLI renew
  them at once (agents running commands in parallel). The server spends a
  refresh token on use, so the processes now take turns on a lock file
  next to the config, and one that waited uses the session the other
  saved. A refresh rejected because another process (an older CLI) spent
  the token meanwhile also uses the session that process saved.
- A process stopped (Ctrl+C, SIGTERM, SIGHUP) while renewing the session
  saves the new tokens before it exits: stopping it in between left on
  disk a refresh token the server had already spent.
- A renewal that fails for a reason other than the session itself
  (network, timeout, server error) is reported as such, with its code,
  instead of "Session expired", and the saved session is kept. A rejected
  one gives the server's reason.
- A server that answers a renewal without a new refresh token keeps the
  stored one instead of removing it.
- A renewal reads and saves the profile that holds the session by name,
  and saves only over the session it renewed: a change of the default
  profile meanwhile no longer writes one profile's session into another,
  and a login saved meanwhile wins over the renewal. A command, and each
  MCP tool call, keeps the default profile it started with.
- Every write of the profiles file takes a lock shared by the CLI's
  processes, so one process no longer undoes another's writes (a renewed
  session put back to its spent refresh token). A profiles file that is not
  valid JSON is reported instead of read as empty, which made the next
  write erase every profile.
- `process.exit` while a session is being renewed (an error printed by
  another request of the same command) waits for the new tokens to be
  saved, up to the renewal's timeout, with the code of the first exit; no
  new request starts meanwhile.
- Deleting or logging out of the default profile no longer makes another
  one the default silently (it could be an admin's): only the one left, if
  just one is; otherwise commands say to pass `--profile` or choose one
  with `profile use`. Refresh locks are kept fresh while held, so a long
  renewal is not taken for a dead one.
- Signals during a renewal no longer get lost: every SIGINT, SIGTERM and
  SIGHUP listener (spinners, prompts) is set aside meanwhile and the signal
  is raised again once the session is saved and its lock released. Lock
  files are taken over atomically when stale and released only by their
  owner.
- A request whose body is a stream is not sent again after its session is
  renewed (the stream is spent, and the retry hung): it fails with
  `session_renewed`, asking to run the command again.
- A password login gives each profile a CLI token of its own
  (`<id>_<random>`) and revokes the one the profile had only after the new
  one is saved: it used to revoke the shared token first, signing out the
  other machines and profiles of the account, and leaving a revoked token
  if the login failed half-way.
- Impersonating profiles take only their link and description from their
  own entry; everything else comes from the profile that holds the
  credentials. Refresh lock names are distinct for profile names that
  differ only in symbols.
- `login` and `profile add` no longer touch the saved profile until the
  sign-in completes: the profile is built in memory and saved at the end.
  A login cancelled, failed or killed half-way (a device code never
  approved, a closed terminal) used to leave the profile with only its
  server, signing out every process that used it.

## [0.5.2] - 2026-10-31

### Added

- The CLI says when a newer release of it is on npm: once a day it asks the
  registry for the latest version of the identity's `npmPackage` (cached in
  the cache folder) and, after a command run in a terminal, prints one line
  with the update command. The MCP server tells the agent instead, in its
  instructions when the cache already knows and otherwise with the first
  answer of the session, so the agent can suggest the update to the user.
  Off in CI, with JSON output, and with `<PREFIX>_NO_UPDATE_CHECK=1` or
  `NO_UPDATE_NOTIFIER=1`.

## [0.5.1] - 2026-10-31

### Fixed

- `host` action `update_settings` says what the server does: it merges the
  body into the host's custom settings (keys left out stay, `null` removes
  one). Its confirmation plan no longer claims it removes the keys left
  out of the body.
- The browser login on a server that does not know the CLI's OAuth client
  (older than Thinger 7.5.0, or the client was removed) says so and offers
  username and password or a token instead of failing.

## [0.5.0] - 2026-10-21

One grammar for every command, noun first:
`<cli> <noun> [<noun>…] <verb> [<parent ids>…] [<id>] [options]`. Nouns
nest under their parent (`device property`, `product profile api`), verbs
come from a closed set, ids are positional and named after their noun,
and the options keep one meaning everywhere. Some commands of 0.4 change
form (see the table below); the old forms are gone, not aliased.

The MCP serves eight tools, `resource_describe|list|get|create|update|
delete|clone|call`, instead of 25: what had a tool of its own (bucket data,
storage files, device resources, the guides, the profiles, dashboard apps,
plugin and product API calls) is a type or an action of them, and every
record is addressed with `ids`, one key per level named as the server's
REST path names it. The old tool names and the `parent`/`id` arguments are
gone, not aliased (see the second table below).

### Added

- MCP: eight tools for everything. Each takes a `type` and `ids`
  (`{"device": "d1", "bucket": "b1"}`); the keys are the server's REST
  placeholders (`type` for an asset type, `group` for an asset group,
  `rule` and `instance` for alarms, `resource` for every product profile
  category), so a body's id field and its `ids` key share a name and
  `create` and `clone` need no mapping. Records answered by `list`, `get`
  and `create` carry their `ids`, ready to pass back. A call with an
  unknown argument is refused listing the ones the tool takes, and points
  a misplaced key to `ids`, `filter` or `body` (an id in an action's body
  too: `{"device": …}` goes in `ids`). An action that refuses its input
  shows one of its examples.


- The core's types and actions, served by the same tools: `bucket_data`
  (list reads, create writes), `storage_file` (`ids.file` is the path;
  `body.local` uploads files and folders of this machine), `device_resource`
  (list, and its `call` action), `doc` (the guides), `profile`; actions
  `device.send`, `device.overview`, `product_profile_api.call`,
  `plugin.call` and `dashboard.init|dev|publish`. A CLI adds its own the
  same way (`resourceTypes`, `resourceActions`).
- `resource_describe`: without a type, the catalog with each type's ids and
  ready-to-send examples; with one, its ids, actions, the permission each
  verb needs, its schemas and examples (the tests check every example
  against the tools). A `describe` resource hook adds to it, and hooks
  get `ids` and `merge` (an update that patches) in their context.
- Actions that change a lot at once answer a plan and run with
  `confirm: true`: `replace_all` of the product profile categories (a diff
  of what it adds, changes and removes), a host's `update_settings` (a diff
  of the settings) and `restart`, `plugin.remove|kill`, alarm rules'
  `test_notification`, and `dashboard.publish` with `prune`. MCP clients
  that support elicitation are asked instead. The CLI asks unless `-y`.
- `mcp --read-only` (or `<PREFIX>_MCP_READ_ONLY=1`): only describe, list,
  get and the read-only actions are served.
- Tool annotations (read-only, destructive, idempotent) on the eight tools.
- `doc list` and `doc get <doc>`: the guides from the command line.
- `api <path>`: any request to the profile's server, as `gh api` does for
  GitHub. `{user}` stands for the account (`--user` for another), `-X`
  picks the method (GET, or POST with a body), `--from <file|->` and
  `-s key=value` (dots nest) build the body, `-q key=value` the query, and
  `-o <file>` saves the answer (binary answers are only written to a file
  or a pipe). Only paths of the profile's server: a full URL is refused.
- Commands for every resource type, generated from the MCP catalog:
  `list|get|create|update|delete|clone|describe` and the type's actions,
  for its 47 types. A child type nests under its parent's command and takes
  its ids first (`device bucket tag get <device> <bucket> <tag>`); the
  product profile categories go under `product profile` (`api`, `bucket`,
  `property`, `autoprovision`, `flow`, `code`), alarms under `alarm`
  (`alarm rule`, `alarm instance`) and assets under `asset` (`asset type`,
  `asset group`); server types go under
  `admin` (`admin host restart <host>`). They run the handlers of the
  `resource_*` tools, hooks included (generated device credentials, token
  expiries such as "30d"). Bodies come from `--from <file|->` and
  `-s key=value` (JSON values, dots nest); create, update and clone take
  `-n/--name` and `-d/--description` on the types that have them, `update
  --merge` patches, `--projects` sets the projects; `list` takes
  `--search`, `--filter`, `--count` and `--index` and returns every record
  unless `--count`; `get` takes `-f <dot.path>` (one field) and
  `-o <file>`; actions take `-f`, `-o` and `-q`; `delete`,
  `replace-all`, `plugin uninstall` and `admin host restart` ask unless
  `-y`. With `-j` they print `{ ok, data }`. What they print speaks of
  commands, not tools: types by their command (`device property`, not
  `device_property`), `--index` for the next page, and `describe` lists
  the type's commands and actions where the MCP lists the tools that run
  them, its ids as the command takes them, the create, update and clone
  bodies as tables of fields (nested ones by their dot path, one table per
  alternative) with their examples pretty-printed, and the permission each
  verb needs (`-j` keeps the MCP's text).
- `set <parents…> <property> <value>` on every property type (device,
  product, plugin, asset type, asset group, project and account
  properties): the value, parsed as JSON, created when missing.
- Commands over the MCP tools that are not CRUD: `bucket write` (a JSON
  sample, an array or NDJSON), `bucket export` (create the export, wait for
  it, download it, delete it from the server unless `--keep`), `storage
  file list|upload|download|delete` (folders and binary files), `device
  send` (data of an HTTP device), `device overview`, `device resource
  list|call`, `product profile api call` (a product API resource for the
  whole product), `product apply --from <file|->` (create or update a
  product from the JSON of `product export`: record, each profile
  category, services and product properties) and `plugin call`.
- `device list`, `product list` and `bucket list` take the list options
  too, keeping their tables; `device create` and `product create` take
  `--from`, `-s` and `--projects`, and their id may come from the body
  (when the record is created but its projects cannot be set, the error
  says so).
- `buildProgram(opts)`: the command tree `runCli` runs, for tests; and
  `checkGrammar(program, { exceptions })` (`commands/grammar`), which checks
  a tree against the grammar (names, verbs, positionals, options, help
  groups, the catalog's commands) for the tests of every CLI.
- `runCli({ argumentHelp })`: help of the positional arguments of the CLI's
  own commands. Every positional argument has a description in the help.
- The help groups commands the same way at every level: Resources,
  Administration, Configuration, Integration and Operations at the root;
  Records, Data, Actions and Subresources inside a noun.
- MCP tool results carry their structured data for these commands (under
  a symbol: MCP clients see the same text as before).

### Changed (breaking)

| 0.4                                          | 0.5                                                          |
| -------------------------------------------- | ------------------------------------------------------------ |
| `device list <pattern>`                      | `device list --search <text>` (or `--filter name=<regex>`)   |
| `device info <device>`                       | `device get <device>`                                        |
| `device property <device>`                   | `device property list <device>`                              |
| `device property <device> <property> [-f p]` | `device property get <device> <property> [-f p]`             |
| `device property-set <device> <prop> <json>` | `device property set <device> <property> <json>`             |
| `device resource <device>`                   | `device resource list <device>`                              |
| `device resource <device> <res> -i k=v`      | `device resource call <device> <resource> -s k=v` (`--from`) |
| `product info <product>`                     | `product get <product>`                                      |
| `product property-list <product>`            | `product property list <product>`                            |
| `product property-get <product> <prop>`      | `product property get <product> <property>`                  |
| `product property-set <product> <prop> <v>`  | `product property set <product> <property> <value>`          |
| `product property-delete <product> <prop>`   | `product property delete <product> <property> -y`            |

- The outputs change with the commands: `device get` and `product get`
  print the record as JSON (as `info` did); `device property get` and
  `product property get` print the property record, with its value under
  `value`, so `-f` paths start there (`-f value.setpoint` where 0.4 took
  `-f setpoint`); `device property list` and
  `product property list` print the property records (with `-j`, the
  records instead of `{ product, properties: [names] }`); `product property
  delete` asks unless `-y`. `device resource call` has no `-i/--input`: its
  input comes from `--from` and `-s`, like every command that sends data.
- `register(program, groups)`'s groups are Resources at the root (they were
  Operations), and `registerToolCommands(program)` is now
  `registerDataCommands(program)` (`commands/data`) and no longer takes
  them.
- The MCP tools (the CLI commands keep their forms and `-j` outputs; only
  the help of some positionals is renamed: `asset type get <type>`,
  `asset group get <group>`, `alarm rule get <rule>`, `alarm instance get
  <instance>`, `product profile <category> get <product> <resource>`):

| 0.4 tool                                 | 0.5 call                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `resource_* parent "d1" id "b1"`          | `resource_* ids {"device": "d1", "bucket": "b1"}`                              |
| `bucket_data_read bucket`                | `resource_list type "bucket_data" ids {bucket}` (`filter` for the query)       |
| `bucket_data_write bucket data`          | `resource_create type "bucket_data" ids {bucket} body <sample or samples>`     |
| `storage_file_list storage path`         | `resource_list type "storage_file" ids {storage} filter {path}`                |
| `storage_file_read storage path`         | `resource_get type "storage_file" ids {storage, file}`                         |
| `storage_file_write storage path …`      | `resource_create type "storage_file" ids {storage, file} body {content\|local}` |
| `storage_file_delete storage path`       | `resource_delete type "storage_file" ids {storage, file}`                      |
| `device_resource_list device`            | `resource_list type "device_resource" ids {device}`                            |
| `device_resource_call device resource`   | `resource_call type "device_resource" action "call" ids {device, resource}`    |
| `device_data_send device data`           | `resource_call type "device" action "send" ids {device} body <data>`           |
| `device_overview`                        | `resource_call type "device" action "overview"`                                |
| `product_resource_call product resource` | `resource_call type "product_profile_api" action "call" ids {product, resource}` |
| `plugin_call plugin path`                | `resource_call type "plugin" action "call" ids {plugin} body {path, method}`   |
| `doc_read id`                            | `resource_get type "doc" ids {doc}` (`resource_list type "doc"` lists them)    |
| `profile_list`                           | `resource_list type "profile"`                                                 |
| `dashboard_init` / `_dev` / `_publish`   | `resource_call type "dashboard" action "init"` / `"dev"` / `"publish"`         |

- `runCli({ mcpTools })` is gone, with `mcp/registry`'s `genericTools` and
  `mcpTools`: a CLI adds types and actions (`resourceTypes`,
  `resourceActions`) instead of tools, and `buildTools(opts)` builds the
  eight. Texts refer to operations as `{op:<type>.<verb|action>}`.
- `lib/mcp/tools-*.js` moved to `lib/mcp/types/` (as types and actions) and
  `lib/commands/tools.js` to `lib/commands/data.js`.

### Fixed

- Account tokens created with an expiry as a duration ("30d") through
  `resource_create` (and `createToken`) got it in seconds: the server takes
  unix milliseconds and refused it. A timestamp too small to be
  milliseconds is still read as seconds. Device tokens keep seconds.
- Ids `.` and `..` are refused (`resource_*` tools too): the URL resolved
  them to the parent, so deleting the property `..` of a device reached
  the device.
- The storage helpers (storage files, thinr's product scripts)
  escape each segment of a file path and refuse empty, `.` and `..`
  segments: `a#b` reached the file `a`, `..` the storage. The plugin
  `call` action also refuses `%2e%2e`.
- Listing a storage folder answered each file's path relative to that
  folder: it is now the whole path, the one its `ids.file` reads.
- The help of `bucket read` and `device resource` printed some defaults

  twice ("(default: 10) (default: 10)", "(default: {})").

## [0.4.2] - 2026-10-17

### Fixed

- The dashboard SDK ships with Thinger 7.4, not 7.5: the platform guides
  mark as "since Thinger 7.4" what older servers lack, and the catalog
  notes name Thinger 7.4 instead of develop builds (7.3.4-…). The SDK's
  own base server keeps coming from its `compat.json`.

## [0.4.1] - 2026-10-16

### Fixed

- The SDK compatibility note no longer says an app "will not work" on a
  server older than the SDK's base (develop builds report 7.3.4-… until
  7.5 is tagged): the app runs and the SDK only warns, so the note is a
  warning. What does not work is named per call, from the functions in the
  package's `compat.json` that need a newer server.

## [0.4.0] - 2026-10-16

### Added

- `dashboard init <dir>` and MCP tool `dashboard_init`: a new dashboard app
  from a template that `@thinger-io/dashboard-sdk` ships (`--template`,
  React by default), downloaded from npm (latest release, integrity
  checked, extracted without a `tar` binary) or, offline, taken from the
  copy cli-core depends on; `--from` takes a version or tag, or a local
  folder or .tgz of the package. The app gets the SDK as a dependency, the
  manifest (storage `app_<folder>_<random>`), an AGENTS.md (and CLAUDE.md
  pointing at it) with the rules of the console's frame and how to review
  the layout, and with `--ci` a GitHub workflow that publishes it
  (`npmPackage` in the identity names the CLI it runs).
- `dashboard dev [url]` and MCP tool `dashboard_dev`: develop a dashboard
  app on its own dev server (ng serve, Vite…) against a real server. It
  returns a link to the local app that opens it as a standalone page with
  the server (`thinger_api`), a temporary full-access token
  (`dashboard_dev[_<project>]`, 8 h by default, replaced by the next link)
  and the context of a destination in its fragment. The url must be on
  this machine unless `--allow-remote` (`allow_remote`); it says when
  nothing answers there.
- `dashboard publish [dir]`: the command for `publishApp`, with
  destinations as `device:<id>`, `dashboard:<id>`…
- An app's manifest (`<cli>.json`, section `dashboard`: `dir`, `storage`,
  `prune`, `to`, `dev.url`, `dev.context`, `dev.route`, `dev.hours`) gives
  these commands their defaults; `dir` must stay inside the manifest's
  folder and the fields are type-checked.
- SDK compatibility: publish and dev read the SDK the app is built with
  (`node_modules/@thinger-io/dashboard-sdk`, from the build or project
  folder up) and its `compat.json`, and warn when the console gives it no
  token (SDK before 0.3.0), when the profile's server
  (`/v1/server/version`) is older than the SDK or some of its calls need,
  when npm has a newer SDK, or when the page loads the deprecated script
  build.
- `<PREFIX>_TOKEN` and `<PREFIX>_SERVER` stand for a profile (CI) unless a
  profile is named; the token never goes to the identity's default server,
  and `logout` says so instead of logging out of nothing.

### Changed

- Documentation no longer comes from the server (which stops serving
  `/sdk/`), with the same ids: the platform's guides (`concepts`,
  `product-code`, `server-admin`) ship in cli-core (`docs/`), marking what
  needs a given server version ("since Thinger 7.5"); the dashboard SDK's
  (`dashboard-sdk`, the reference, and `dashboard-sdk-types`) come from its
  package: the version installed in the project of the working folder,
  else the CLI's own (cli-core depends on `@thinger-io/dashboard-sdk`).
  `doc_read`, the MCP resources and `resource_describe` read them without
  a request.
- Preview and dev links refuse a route with `&` or `#`, which could add
  parameters of its own to the fragment.

### Removed

- `FALLBACK_DOCS` and `validDoc` (docs.js): no document is read from the
  server.
- The layout check link of preview links (`layoutUrl`, `LAYOUT_SIZES`):
  the server retires `/sdk/preview.html`. The AGENTS.md of `dashboard init`
  says how to review the layout instead.

### Fixed

- The catalog note on dashboards named `target` where `dashboard_publish`
  takes `to`.
- `defineCliDocs` files given as `URL` resolve on Windows too.

## [0.3.0] - 2026-10-14

### Added

- `runCli({ resourceTypes, resourceActions })`: a CLI adds its platform's
  own resource types (functions instead of a REST path) and actions on the
  server's types, served by the same `resource_*` tools: listed in
  `resource_describe`, searched and paged by `resource_list`, their parent
  and id checked like the server's. Clashes with the catalog fail at
  startup. ThinRemote serves its files, scripts, metrics, log sources and
  playbooks this way.
- `alarm_instance` action `stats`: how many instances there are in each
  state.

### Fixed

- `resource_list` pages lists answered whole from any `index`, not only
  when they are longer than a page.
- `resource_describe` says which server actions take no id.

## [0.2.1] - 2026-10-12

### Changed

- Repository renamed to `thinger-io/thinger-cli-core` (the package keeps its
  name). README: 23 MCP tools.

## [0.2.0] - 2026-10-10

Incompatible change of the MCP tools: from 48 tools, one per type and
operation, to 23, less than half the size in `tools/list` (about 23,200
characters instead of 51,400, roughly 6,400 tokens instead of 14,300).

### Added

- Seven generic tools over a catalog of the server's resource types:
  `resource_describe`, `resource_list`, `resource_get`, `resource_create`,
  `resource_update` (`merge: true` patches property values; `projects` in
  the body sets the resource's projects), `resource_delete`,
  `resource_clone`. The catalog (`mcp/catalog.js`) covers devices,
  products, buckets, dashboards, endpoints, storages, asset types and
  groups, projects, tokens, alarm rules and instances, claims, account
  properties and their children (device properties, tokens, buckets, bucket
  tags, services and HTTP callback; product properties, profile entries,
  code and services; bucket tags and exports; asset type, asset group and
  project properties; roles, project members and roles, syncs) and the
  server's administration (users, hosts, domains, brands, OAuth clients,
  identity providers, proxies, under /v1 rather than an account). Each tool
  offers only the types that support its verb; permissions are the
  server's to enforce.
- `resource_describe` reads the request schemas and examples from the
  server's own OpenAPI document (`/v1/server/swagger.json`), cached per
  server and version in `~/.config/<cli>/cache`; servers that do not publish
  it fall back to the bundled copy (`openapi/swagger.json`, the server's
  develop as of 2026-10-10). It also lists, for each verb, the permission action a token
  needs (`permissions`: `Device` / `ReadDeviceStatus`…), taken from the same
  document.
- Resource hooks: generated device credentials, the identity's product
  template, device token expiries as durations ("30d") and permission tree
  checks.
  CLIs add theirs with `runCli({ resourceHooks })`.
- Plugins: type `plugin` (installed by default; the installable catalog
  with filter `available`, summarised) with actions install, upgrade,
  remove, start, stop, restart, pause, unpause, kill, public, private;
  `plugin_property`; and `plugin_call` for the API each plugin serves.
  Lists that ignore count/index are paged client-side, and `resource_list`
  takes a `search`: by id or name on the server (escaped, any case), or
  over every field shown on lists the server answers whole (plugins).
- `resource_call`: actions of a type that are not CRUD, declared in the
  catalog with their operationId (checked against the OpenAPI document):
  verify a domain, restart a host or read/replace its settings, send a
  brand's test email, call an endpoint, export a product, read a device's
  usage, test an alarm rule (rule, source, notification).
- Tools that are not CRUD: `bucket_data_read`, `bucket_data_write`,
  `device_resource_list`, `device_resource_call`, `device_data_send`,
  `device_overview`, `product_resource_call`,
  `storage_file_list` / `_read` / `_write` / `_delete`.
- `dashboard_publish`: publishes HTML apps as url-source dashboards
  (servers with url-source dashboards). Uploads a local folder (a build
  output, subfolders included) or inline files to a public storage, with
  `prune` to delete files a new build no longer has; and/or points
  dashboards at it: dashboards of the collection, or the `dashboard`
  property of a device, product, asset type, asset group or project
  (checked before anything is uploaded), each with its own entry page and
  initial hash route. One storage can serve an app shared by many
  dashboards. Entry urls carry `?v=` against stale caches; scripts and
  styles without a content hash are reported.
- `doc_read`: the documentation the server publishes for agents, listed in
  its index (`/sdk/docs.json`): a guide to the platform's concepts, the
  dashboard SDK reference, its TypeScript declarations… A guide added to the
  index reaches the model without a CLI release. The same documents are MCP
  resources (`<prefix>://<id>`), the concepts guide is appended to
  `resource_describe` without a type, and the SDK reference to
  `resource_describe` of the dashboard type. Only paths on the profile's own
  server are followed. CLIs add the guides they ship with
  `runCli({ docs })`, listed first and readable without a server.
- `scripts/catalog-draft.js`: drafts catalog entries from an OpenAPI
  document.

### Changed

- A 403 no longer says the token may have expired: it says the token or the
  account is not allowed, with the server's reason. The error code is still
  `unauthorized`.
- `profiles` is now `profile_list`; `bucket_read` is `bucket_data_read`;
  `resource_list` / `resource_call` (device resources) are
  `device_resource_list` / `device_resource_call`.
- `buildTools(extraTools, { admin, hooks })`; `genericTools` is now a
  function of the same options.

### Removed

- The per-type tools, replaced by `resource_*` on the matching type:
  `devices`, `device_info`, `device_create`, `device_set_product`,
  `device_delete`, `products`, `product_create`, `product_update`,
  `product_delete`, `product_property_*`, `product_profile_*`,
  `property_get`, `property_set`, `token_*`, `device_token_*`,
  `alarm_rules`, `alarm_rule_*`, `alarm_instances`, `alarm_instance_*`,
  `buckets`.

## [0.1.1] - 2026-10-10

### Fixed

- `repository.url` in the canonical `git+https` form npm expects; first release
  published from GitHub Actions through Trusted Publishing.

## [0.1.0] - 2026-10-10

First version, extracted from the core of `thinr` 1.3.5 and made
independent of the product.

### Added

- CLI identity (`defineIdentity`): name, config folder, environment prefix,
  login token, OAuth client, MCP server name and tool prefix, product
  template.
- `runCli` with the generic commands (login, logout, profile, device, product,
  bucket, mcp) and extension points: `register` with the command groups,
  `onNoCommand`, `mcpTools`, `mcpInstructions`.
- MCP tools declared with bare names and `{tool:x}` / `{family:x}`
  references, expanded and validated when the server starts; CLI tools can
  replace generic ones explicitly (`replaces: true`).
- `device create` / `device_create`, `bucket list` / `buckets`.

### Changed (compared with thinr 1.3.5)

- The API base URL and token come from the profile active for each request,
  and the MCP `profile` argument is scoped per call (AsyncLocalStorage).
- Servers may carry a scheme (`http://localhost:8080`); profiles are named
  after the host.
- `logout` forgets the current profile (or `--all`) and revokes the API token
  the CLI minted, instead of deleting every profile.
- Login works without prompts (`--server --username --token`) and fails with
  a clear message when a prompt has no terminal.
- The config file is written with mode 600.
- Server error messages are kept in the errors shown to the user.
