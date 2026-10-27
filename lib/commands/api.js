// @ts-check
import { writeFile } from 'node:fs/promises';
import { rawApiCall } from '../raw-api.js';
import { inputError } from '../errors.js';
import { classifyError, isJsonMode, printErr, printOk } from '../output.js';
import {
    applyJsonFlag,
    collectKeyString,
    ensureConfigured,
    getGlobalUser,
    bodyFromOptions,
    bodyOptions,
} from './_shared.js';

/** `<cli> api <path>` — any request to the server, as `gh api` does for GitHub. */
export function registerApiCommand(program) {
    bodyOptions(
        program
            .command('api <path>')
            .helpGroup('Integration:')
            .description('Send a request to the server API (anything the commands do not cover)')
            .option(
                '-X, --method <method>',
                'GET, POST, PUT, PATCH or DELETE (default: GET, or POST with a body)',
            ),
    )
        .option('-q, --query <key=value>', 'Query parameter (repeatable)', collectKeyString)
        .option('-o, --output <file>', 'Write the answer to a file (downloads, binary answers)')
        .option('-j, --json', 'Output as JSON ({ ok, data })')
        .addHelpText(
            'after',
            `
The path is relative to the profile's server; {user} stands for the account
(the profile's, or --user). The answer is printed as it comes: JSON pretty
printed, text as is.

Examples:
  $ <cli> api /v1/users/{user}/endpoints
  $ <cli> api /v1/users/{user}/buckets -s bucket=temps -s name=Temperatures -s source=write
  $ <cli> api -X PUT /v1/users/{user}/devices/sensor1 --from device.json
  $ <cli> api /v1/users/{user}/buckets/temps/data -q items=100 -q sort=desc
  $ <cli> api /v2/users/{user}/storages/web/files/index.html -o index.html`.replaceAll(
                '<cli>',
                program.name(),
            ),
        )
        .action(async (path, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            try {
                const body = await bodyFromOptions(opts);
                if (
                    body !== undefined &&
                    ['GET', 'DELETE'].includes(String(opts.method).toUpperCase())
                ) {
                    throw inputError(
                        `${opts.method.toUpperCase()} takes no body: pass query parameters with -q`,
                    );
                }
                const res = await rawApiCall({
                    method: opts.method,
                    path,
                    query: opts.query,
                    body,
                    user: getGlobalUser(cmd),
                });
                if (opts.output) {
                    await writeFile(opts.output, res.raw);
                    if (isJsonMode()) printOk({ status: res.status, file: opts.output });
                    else process.stderr.write(`Saved to ${opts.output}\n`);
                    return;
                }
                if (res.kind === 'binary') {
                    if (isJsonMode() || process.stdout.isTTY) {
                        throw inputError(
                            `the answer is binary (${res.contentType || 'unknown type'}, ${res.body.length} bytes): save it with -o <file>`,
                        );
                    }
                    process.stdout.write(res.body);
                    return;
                }
                if (isJsonMode()) printOk(res.body);
                else if (res.kind === 'json') console.log(JSON.stringify(res.body, null, 2));
                else if (res.kind === 'text') process.stdout.write(res.raw);
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
