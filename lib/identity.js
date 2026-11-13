// @ts-check

/**
 * Who the CLI is.
 *
 * The core knows nothing about any particular product: every name that
 * reaches the user or the disk (binary name, config folder, environment
 * variables, the API token minted by the password login, the OAuth client,
 * the MCP server and its tool names) comes from the identity the CLI
 * defines once at startup, before it touches anything else.
 *
 * One process runs one CLI, so a module-level identity is enough; the
 * getter throws if a module reaches for it before the entry point has
 * defined it, which turns a missing `defineIdentity()` into a loud error
 * instead of a config file written under the wrong folder.
 */

/**
 * @typedef {object} CliIdentity
 * @property {string} name          Binary name, used in hints ("Run `<name> login`").
 * @property {string} displayName   Human name of the platform ("Thinger.io").
 * @property {string} description   One-line description for `--help`.
 * @property {string} configDir     Folder under ~/.config holding the profiles.
 * @property {string} envPrefix     Prefix of the environment variables (<PREFIX>_PROFILE, <PREFIX>_INSECURE).
 * @property {{ id: string, name: string }} token
 *   Permanent API token the username/password login creates on the account.
 *   The id must match the server's `^[a-zA-Z0-9_]{1,50}$`.
 * @property {{ clientId: string | null }} oauth
 *   OAuth device-flow client registered on the server, or null when the
 *   platform has none by default (the login then asks for one).
 * @property {string | null} defaultServer  Server suggested by the login prompt.
 * @property {{ serverName: string, toolPrefix: string }} mcp
 *   MCP server name and the prefix every tool name gets (`<prefix>_devices`).
 * @property {string} [npmPackage]  npm package of the CLI, run with npx by the CI workflow
 *   `dashboard init --ci` writes (default: the package of its entry point).
 * @property {ProductTemplate} [productTemplate]
 *   Defaults for products created through the CLI or MCP, for platforms
 *   whose products need a given shape (a type, a bucket every device feeds).
 */

/**
 * @typedef {object} ProductTemplate
 * @property {string} [description]  Description when the caller gives none.
 * @property {object} [config]       Product `config`; the caller's keys win.
 * @property {object} [profile]      Product `profile` when the caller gives none.
 */

/** @type {Readonly<CliIdentity> | null} */
let current = null;

const TOKEN_ID_RE = /^[a-zA-Z0-9_]{1,50}$/;
const TOOL_PREFIX_RE = /^[a-z][a-z0-9]*$/;

/**
 * Define the identity of this CLI. Call it from the entry point before
 * importing anything that reads configuration or talks to the API.
 *
 * @param {CliIdentity} identity
 * @returns {Readonly<CliIdentity>}
 */
export function defineIdentity(identity) {
    const missing = ['name', 'displayName', 'configDir', 'envPrefix'].filter((k) => !identity?.[k]);
    if (missing.length) throw new Error(`CLI identity is missing: ${missing.join(', ')}`);
    if (!TOKEN_ID_RE.test(identity.token?.id || '')) {
        throw new Error(`CLI identity: token id must match ${TOKEN_ID_RE}`);
    }
    if (!TOOL_PREFIX_RE.test(identity.mcp?.toolPrefix || '')) {
        throw new Error(`CLI identity: MCP tool prefix must match ${TOOL_PREFIX_RE}`);
    }
    current = Object.freeze({
        ...identity,
        token: Object.freeze({ ...identity.token }),
        oauth: Object.freeze({ clientId: identity.oauth?.clientId || null }),
        defaultServer: identity.defaultServer || null,
        mcp: Object.freeze({ ...identity.mcp }),
        productTemplate: deepFreeze(structuredClone(identity.productTemplate || {})),
    });
    return current;
}

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
    }
    return value;
}

/** @returns {Readonly<CliIdentity>} */
export function identity() {
    if (!current) throw new Error('CLI identity not defined: call defineIdentity() first');
    return current;
}

/** Value of `<PREFIX>_<suffix>` in the environment. */
export function env(suffix) {
    return process.env[`${identity().envPrefix}_${suffix}`];
}

/**
 * Hint telling the user how to (re)authenticate: in `profile` when given
 * (a profile other than the active one holds the credentials).
 *
 * @param {string | null} [profile]
 */
export function loginHint(profile) {
    const where = profile ? ` --profile ${profile}` : '';
    return `Run \`${identity().name}${where} login\` to sign in.`;
}
