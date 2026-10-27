# @thinger-io/cli-core

The shared core of the CLIs built on Thinger.io servers — `thinger`
([@thinger-io/cli](https://github.com/thinger-io/thinger-cli)) and
ThinRemote's `thinr` — and of the MCP servers they expose.

It holds everything that is not specific to a product:

- **API client** (`api`) — axios with the active profile's server and token on
  every request, refresh on 401, self-signed TLS for localhost.
- **Auth** (`auth`) — username/password (mints a permanent API token),
  pasted token, OAuth device flow; interactive or fully non-interactive.
- **Profiles** (`config`) — several servers per CLI, selected by `--profile`,
  `<PREFIX>_PROFILE` or the saved default, and scoped per call
  (`withActiveProfile`) so concurrent MCP calls don't mix servers. In CI,
  `<PREFIX>_SERVER` and `<PREFIX>_TOKEN` stand for a profile without any
  file.
- **REST helpers** — `devices`, `property`, `resource`, `bucket`, `product`,
  `profile` (product profiles), `tokens`, `alarms`, `storage`, with every
  account path built in `paths`.
- **Generic commands** (`cli`, `commands/*`) — login, logout, profile, device,
  product, bucket, dashboard, mcp; `api` for any request to the server; and,
  generated from the same catalog the MCP serves, the commands of every
  resource type (`list`, `get`, `create`, `update`, `delete`, `clone`,
  `describe`, `set` on properties, and its actions), run by the handlers and
  hooks of the `resource_*` tools, so a type added to the catalog reaches the
  CLI and the MCP at once. Commands over the other tools complete them:
  `bucket write` and `export`, `storage file list|upload|download|delete`,
  `device send`, `overview` and `resource list|call`, `product apply`,
  `product profile api call`, `plugin call`. A command the CLI registers
  itself keeps its name. They all follow one grammar (below).
- **Dashboard apps** (`dashboard`, `dashboard-init`, `dashboard-dev`,
  `dashboard-sdk`) — create an app from a template of
  `@thinger-io/dashboard-sdk`, develop it on its own dev server (a link with
  a temporary token opens the local app against the server), and publish
  its build to a public storage that dashboards point at, with a warning
  when its SDK needs a newer server or is not the latest.
- **Documentation** (`docs`, `docs/`) — the guides for agents: the
  platform's concepts, product code and server administration (shipped
  here, marking what needs a given server version), the dashboard SDK's
  reference and types (from its package: the project's version, else the
  CLI's), and the CLI's own.
- **MCP** (`mcp/*`) — the stdio server and 25 generic tools: eight
  `resource_*` tools over a catalog of the server's resource types, and the
  operations that are not CRUD (bucket data, device resources, storage
  files, dashboard development and publishing, the documentation…), plus that
  documentation as MCP resources.
- **OpenAPI** (`openapi`) — the server's own API description, cached per
  server and version, with a bundled copy as fallback.

## Identity

The core knows nothing about the product it runs for. A CLI defines its
identity once, before anything else, and runs:

```js
import { defineIdentity } from '@thinger-io/cli-core/identity';
import { runCli } from '@thinger-io/cli-core/cli';

defineIdentity({
    name: 'acme', // binary name, used in hints
    displayName: 'Acme IoT',
    description: 'CLI for Acme IoT servers',
    configDir: 'acme-cli', // ~/.config/acme-cli/config.json
    envPrefix: 'ACME', // ACME_PROFILE, ACME_INSECURE, ACME_SERVER + ACME_TOKEN
    token: { id: 'acme_cli', name: 'Acme CLI' }, // minted by the password login
    oauth: { clientId: null }, // OAuth device-flow client, if the platform ships one
    defaultServer: null, // suggested by the login prompt
    mcp: { serverName: 'acme', toolPrefix: 'acme' }, // tools become acme_resource_list, …
    productTemplate: {}, // optional defaults for new products
});

await runCli({ version: '1.0.0' });
```

Each CLI keeps its own profiles, environment variables and MCP tool names,
so two of them can run side by side without one operating on the other's
servers.

## Extending

`runCli` takes:

- `register(program, { device, product, bucket, dashboard })` — add top-level commands,
  or subcommands inside the generic groups.
- `onNoCommand(program)` — what to do when called without arguments
  (default: help).
- `mcpTools` — the CLI's own MCP tools, declared with bare names
  (`name: 'device_exec'`) and referring to others in descriptions as
  `{tool:resource_list}` or `{family:storage_file}`. Unknown references fail
  at startup. A tool flagged `replaces: true` swaps out the generic tool of
  the same name.
- `resourceHooks` — the CLI's hooks on catalog types (`{ product: {
afterDelete } }`), run after the core's: see `mcp/resource-hooks.js`.
- `resourceTypes` — resource types of the CLI's own platform, served by the
  same `resource_*` tools as the server's: instead of a REST path each has
  functions for the verbs it supports (`list`, `get`, `create`, `update`,
  `delete`), its `parent` and `id`, a `schema` and `notes` for
  `resource_describe`, and `actions` for `resource_call` (`on: 'item'`,
  `'collection'` or `'either'`). The core checks the parent and id, and
  searches and pages what `list` returns. See `LocalType` in
  `mcp/tools-resource.js`.
- `resourceActions` — actions the CLI adds to the server's types
  (`{ device: { reboot: { description, run } } }`), run with
  `resource_call` like the server's. A type or action that clashes with the
  catalog fails at startup.
- `mcpInstructions` — server-level guidance sent to MCP clients.
- `argumentHelp` — `{ byCommand, byName }`: help of the positional
  arguments of the CLI's own commands (`{ 'device logs': { unit: '…' } }`).

`buildProgram(opts)` builds the same command tree without running it, for
tests.

## Command grammar

Every CLI on the core reads the same way:

```
<cli> <noun> [<noun>…] <verb> [<parent ids>…] [<id>] [<extra>] [options]
```

- **Nouns** are singular, kebab case, nested under their parent:
  `device property`, `device bucket tag`, `product profile api`, at most
  three deep; server types go under `admin`. Groups run nothing themselves.
- **Verbs** form a closed set: for records, `list`, `get`, `create`,
  `update`, `delete`, `clone`, `describe` and `set` (the value of a
  property); for data, `read`, `write`, `send`, `export`, `import`,
  `overview`, `call`, `upload` and `download`; the catalog's actions in
  kebab case (`test-source`, `replace-all`); and the local `init`, `dev`,
  `publish`, `login`, `logout`, `use`, `current` and `add`.
- **Positionals** are ids, outermost parent first, named after their noun:
  `device property get <device> <property>`.
- **Options** keep one meaning: `-j --json`, `-o --output`, `-y --yes`,
  `-s --set`, `-q --query`, `-X --method`, `-f --field`; `-n` and `-d` are
  name and description on create and update. Bodies come from
  `--from <file|->` and `-s key=value`; lists take `--search`, `--filter`,
  `--count` and `--index`; deletes ask unless `-y`.

`checkGrammar(program, { exceptions })` (`commands/grammar`) checks a whole
tree and returns what breaks it; each CLI's tests run it over its
`buildProgram`, stating what it adds (`root`, `verbs`), its short options
with another meaning (`shorts`) and the rules a command does not follow
(`skip`).

## MCP tools

Tool names follow `<object>[_<subobject>]_<verb>`, with the verbs list, get,
describe, create, update, delete, clone, call, read, write, send.

The server's collections are reached through eight generic tools —
`resource_describe`, `resource_list`, `resource_get`, `resource_create`,
`resource_update`, `resource_delete`, `resource_clone`, `resource_call`
(actions that are not CRUD) — that take a `type`
from the catalog (`lib/mcp/catalog.js`), a `parent` for child types and an
`id`. The catalog is a reviewed table, never discovered at run time: each
type has its path, API version, parent, id and the verbs it allows, with the
server's operationId for each (the tests check them against the bundled
OpenAPI document). `resource_describe` reads the request schemas and
examples from the OpenAPI document of the server the profile points at.

To draft catalog entries after an API change:

```bash
curl -s https://<server>/v1/server/swagger.json -o openapi/swagger.json
node scripts/catalog-draft.js
```

Modules are imported by path: `@thinger-io/cli-core/api`,
`@thinger-io/cli-core/mcp/registry`, …

## Development

```bash
npm install
npm test           # under a made-up "acme" identity
npm run lint
npm run typecheck
```

## License

MIT
