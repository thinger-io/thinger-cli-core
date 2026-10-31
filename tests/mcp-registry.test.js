import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../lib/mcp/registry.js';
import { expandToolRefs } from '../lib/mcp/naming.js';

const tools = buildTools();
const byName = (list, base) => list.find((t) => t.name === `acme_${base}`);

/** The eight tools, in the order they are listed. */
const EIGHT = [
    'resource_describe',
    'resource_list',
    'resource_get',
    'resource_create',
    'resource_update',
    'resource_delete',
    'resource_clone',
    'resource_call',
];

describe('mcp registry', () => {
    it('serves the eight resource tools, and nothing else', () => {
        assert.deepEqual(
            tools.map((t) => t.name),
            EIGHT.map((n) => `acme_${n}`),
        );
    });

    it('every tool has name, description, inputSchema, annotations and handler', () => {
        for (const t of tools) {
            assert.equal(typeof t.name, 'string', `missing name on ${JSON.stringify(t)}`);
            assert.equal(typeof t.description, 'string', `missing description on ${t.name}`);
            assert.equal(typeof t.inputSchema, 'object', `missing inputSchema on ${t.name}`);
            assert.equal(typeof t.annotations?.title, 'string', `missing annotations on ${t.name}`);
            assert.equal(typeof t.handler, 'function', `missing handler on ${t.name}`);
        }
    });

    it('every required field is declared in properties', () => {
        for (const t of tools) {
            const required = t.inputSchema.required || [];
            const properties = t.inputSchema.properties || {};
            for (const field of required) {
                assert.ok(
                    field in properties,
                    `${t.name}.required lists "${field}" but it's missing from properties`,
                );
            }
        }
        assert.deepEqual(byName(tools, 'resource_clone').inputSchema.required, [
            'type',
            'ids',
            'body',
        ]);
        assert.deepEqual(byName(tools, 'resource_call').inputSchema.required, ['type', 'action']);
    });

    it('every tool has the injected `profile` option, and ids instead of parent and id', () => {
        for (const t of tools) {
            const props = t.inputSchema.properties;
            assert.ok(props.profile, `${t.name} is missing the injected profile param`);
            assert.ok(!('parent' in props) && !('id' in props), t.name);
            if (t.name !== 'acme_resource_describe') {
                assert.equal(props.ids.type, 'object', t.name);
                assert.deepEqual(props.ids.additionalProperties, { type: 'string' });
            }
        }
    });

    it('annotates what each tool does', () => {
        const a = (base) => byName(tools, base).annotations;
        for (const base of ['resource_describe', 'resource_list', 'resource_get']) {
            assert.equal(a(base).readOnlyHint, true, base);
        }
        assert.equal(a('resource_delete').destructiveHint, true);
        assert.equal(a('resource_create').destructiveHint, false);
        assert.equal(a('resource_update').idempotentHint, true);
        assert.deepEqual(a('resource_call'), {
            title: 'Run a resource action',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        });
    });

    it("resource_call's action enum is every action, sorted", () => {
        const call = byName(tools, 'resource_call').inputSchema.properties;
        const actions = call.action.enum;
        assert.deepEqual(actions, [...new Set(actions)].sort());
        for (const a of ['call', 'send', 'overview', 'publish', 'replace_all', 'verify']) {
            assert.ok(actions.includes(a), a);
        }
        for (const t of ['device', 'device_resource', 'dashboard', 'plugin']) {
            assert.ok(call.type.enum.includes(t), t);
        }
    });

    it('serves only reads in read-only mode', () => {
        const ro = buildTools({ readOnly: true });
        assert.deepEqual(
            ro.map((t) => t.name),
            ['resource_describe', 'resource_list', 'resource_get', 'resource_call'].map(
                (n) => `acme_${n}`,
            ),
        );
        const call = byName(ro, 'resource_call');
        assert.equal(call.annotations.readOnlyHint, true);
        const actions = call.inputSchema.properties.action.enum;
        for (const a of ['overview', 'stats', 'export', 'test_rule', 'logs', 'read_settings']) {
            assert.ok(actions.includes(a), a);
        }
        for (const a of ['call', 'send', 'restart', 'publish', 'replace_all']) {
            assert.ok(!actions.includes(a), a);
        }
        assert.ok(!call.inputSchema.properties.type.enum.includes('device_resource'));
    });

    // Descriptions are what the model reads: a leftover placeholder or a
    // reference to another CLI's tools sends it after tools it doesn't have.
    it('descriptions are fully expanded and name only this CLI', () => {
        const text = JSON.stringify(tools.map(({ handler: _h, explain: _e, ...t }) => t));
        assert.doesNotMatch(text, /\{(tool|family|op):/);
        assert.doesNotMatch(text, /thinr|ThinRemote|thinger_/i);
    });

    it('builds the same list twice', () => {
        assert.deepEqual(
            buildTools().map((t) => t.name),
            tools.map((t) => t.name),
        );
    });

    it('keeps the list small', () => {
        const size = JSON.stringify(tools.map(({ handler: _h, explain: _e, ...t }) => t)).length;
        assert.ok(size < 20_000, `${size} characters`);
    });
});

describe('tool references', () => {
    const known = new Set(['devices', 'token_list', 'token_get']);

    it('expand tools and families', () => {
        assert.equal(expandToolRefs('use {tool:devices}', known, 'x'), 'use acme_devices');
        assert.equal(
            expandToolRefs('the {family:token} tools', known, 'x'),
            'the acme_token_* tools',
        );
    });

    it('fail loudly on unknown tools', () => {
        assert.throws(
            () => expandToolRefs('{tool:monitoring}', known, 'x'),
            /unknown tool "monitoring"/,
        );
        assert.throws(() => expandToolRefs('{family:playbook}', known, 'x'), /unknown tool family/);
    });

    it('leave platform templates such as {{payload}} alone', () => {
        assert.equal(expandToolRefs('"{{payload}}"', known, 'x'), '"{{payload}}"');
    });
});
