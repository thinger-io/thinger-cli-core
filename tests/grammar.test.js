// @ts-check
import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from '../lib/cli.js';
import { checkGrammar } from '../lib/commands/grammar.js';
import { NAMED_FIELDS, commandPath } from '../lib/commands/resources.js';
import { CATALOG, templateFor } from '../lib/mcp/catalog.js';
import { bundledSpec, findOperation, resolveRefs } from '../lib/openapi.js';

/** Every visible command of a tree, as paths. */
function paths(cmd, at = []) {
    return cmd.commands
        .filter((c) => !c._hidden)
        .flatMap((c) => [[...at, c.name()].join(' '), ...paths(c, [...at, c.name()])]);
}

/** A CLI with a command of its own, registered as `register` does. */
const build = (register) => buildProgram({ version: '0.0.0', strict: true, register });

describe('command grammar', () => {
    it('the core follows it', () => {
        assert.deepEqual(checkGrammar(build()), []);
    });

    it('has the commands of the grammar and none of the old forms', () => {
        const all = new Set(paths(build()));
        for (const p of [
            'device property set',
            'device bucket tag get',
            'device resource call',
            'product profile api call',
            'product profile api replace-all',
            'product property set',
            'bucket export-file list',
            'storage file delete',
            'alarm rule test',
            'alarm instance stats',
            'asset type property set',
            'asset group list',
            'admin host get-settings',
            'plugin uninstall',
            'sync lock list',
            'property set',
        ]) {
            assert.ok(all.has(p), `missing ${p}`);
        }
        for (const p of [
            'device info',
            'device property-set',
            'product info',
            'product property-list',
            'product resource',
            'device-property',
            'product-profile-api',
            'bucket-export',
            'storage files',
            'storage rm',
            'alarm-rule',
            'asset-type',
            'admin host read-settings',
            'plugin remove',
            'sync-lock',
        ]) {
            assert.ok(!all.has(p), `still there: ${p}`);
        }
    });

    it('finds what breaks it', () => {
        const program = build((p) => {
            const device = p.commands.find((c) => c.name() === 'device');
            device
                ?.command('property-set <deviceId> <propertyId> <value>')
                .helpGroup('Records:')
                .option('-j, --json');
            device?.command('show <device>').helpGroup('Records:').option('-f, --force');
            p.command('fleet').helpGroup('Operations:').command('upgrade').option('-j, --json');
        });
        const problems = checkGrammar(program).join('\n');
        assert.match(problems, /device property-set: not a verb/);
        assert.match(problems, /argument <deviceId> is not kebab case/);
        assert.match(problems, /argument <propertyId> has no description|not kebab/);
        assert.match(problems, /device show: -f is --force, not --field/);
        assert.match(problems, /fleet: not a command of the root/);
    });

    it('takes the exceptions a CLI states', () => {
        const program = build((p) => {
            const device = p.commands.find((c) => c.name() === 'device');
            device
                ?.command('exec <device>')
                .helpGroup('Execution:')
                .option('-f, --follow')
                .option('-j, --json');
        });
        assert.match(checkGrammar(program).join('\n'), /device exec: not a verb/);
        assert.deepEqual(
            checkGrammar(program, {
                exceptions: { verbs: ['exec'], shorts: { 'device exec': { '-f': '--follow' } } },
            }),
            [],
        );
    });

    it('wants a command written in the place of a generated one to take what it takes', () => {
        const program = build((p) => {
            const endpoint = p.command('endpoint').helpGroup('Resources:');
            endpoint
                .command('get <id>')
                .helpGroup('Records:')
                .option('-j, --json')
                .description('x');
        });
        const problems = checkGrammar(program).join('\n');
        assert.match(
            problems,
            /endpoint get: takes <id> where the generated command takes <endpoint>/,
        );
        assert.match(problems, /endpoint get: lacks --field, --output/);
    });

    it('refuses a CLI leaf where the catalog needs a group (strict)', () => {
        assert.throws(
            () =>
                build((p) => {
                    p.commands
                        .find((c) => c.name() === 'device')
                        ?.command('property <device>')
                        .action(() => {});
                }),
            /device property: a command of the CLI takes the place/,
        );
    });
});

describe('-n and -d', () => {
    it('go to the types whose create or update take a name and a description', () => {
        const doc = bundledSpec();
        const fields = (schema) => {
            const out = new Set(Object.keys(schema?.properties || {}));
            for (const k of ['allOf', 'oneOf', 'anyOf'])
                for (const s of schema?.[k] || []) for (const f of fields(s)) out.add(f);
            return out;
        };
        for (const [type, spec] of Object.entries(CATALOG)) {
            const verbs = ['create', 'update'].filter((v) => v in spec.ops);
            const named =
                verbs.length > 0 &&
                verbs.every((verb) => {
                    const { method, path } = templateFor(type, /** @type {any} */ (verb));
                    const op = findOperation(doc, method, path)?.operation;
                    const schema = op?.requestBody?.content?.['application/json']?.schema;
                    const f = fields(schema && resolveRefs(doc, schema));
                    return f.has('name') && f.has('description');
                });
            assert.equal(NAMED_FIELDS.has(type), named, `${type} (${commandPath(type).join(' ')})`);
        }
    });
});
