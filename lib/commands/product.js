// @ts-check
import {
    createProduct,
    deleteProduct,
    getProductApi,
    getProducts,
    productExists,
} from '../product.js';
import { runPool } from '../concurrency.js';
import { alreadyExistsError, inputError } from '../errors.js';
import { hint, info, label, success } from '../format.js';
import { classifyError, createSpinner, isJsonMode, printErr, printOk } from '../output.js';
import {
    hasListOptions,
    listOptions,
    listRecords,
    projectsOption,
    setProjects,
} from './resources.js';
import {
    applyJsonFlag,
    bodyFromOptions,
    bodyOptions,
    confirmDestructive,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
    runCommand,
} from './_shared.js';

/**
 * `<cli> product <verb> <product> …` — the product records written by hand
 * (list as a table with API counts, create from the CLI's template,
 * delete); the rest of the group (get, update, property, profile, export,
 * apply…) comes from the tool and resource commands.
 */
export function registerProductCommands(program) {
    const product = program
        .command('product')
        .helpGroup('Resources:')
        .description('Products: records, properties, profile and their export');

    listOptions(
        product
            .command('list')
            .helpGroup('Records:')
            .description('List the products of the account, with their API resources')
            .option('-j, --json', 'Output as JSON')
            .option(
                '-c, --concurrency <n>',
                'Max parallel API-resource lookups (default: 10)',
                parsePositiveInt('concurrency'),
                10,
            ),
    ).action(async (opts, cmd) => {
        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(cmd);

        const spinner = createSpinner('Fetching products...').start();
        let products;
        try {
            products = hasListOptions(opts)
                ? await listRecords('product', opts, user)
                : await getProducts(user);
        } catch (error) {
            spinner.fail('Failed to fetch products');
            const { message, code } = classifyError(error);
            printErr(message, { code });
            return;
        }

        // API-resource counts come from each product's profile.
        // Parallelise so a large catalogue doesn't crawl serially.
        const apiResults = await runPool(products, opts.concurrency, async (p) => {
            const apis = await getProductApi(p.product, user);
            return Object.keys(apis || {}).length;
        });
        const rows = products.map((p, i) => ({
            product: p.product,
            name: p.name && p.name !== p.product ? p.name : null,
            enabled: !!p.enabled,
            api_resources: apiResults[i]?.ok ? apiResults[i].value : null,
        }));

        spinner.succeed(`Found ${rows.length} product(s)`);

        if (isJsonMode()) {
            printOk({ products: rows });
            return;
        }

        const idWidth = rows.reduce((w, r) => Math.max(w, String(r.product ?? '').length), 0);
        for (const r of rows) {
            const flag = r.enabled ? success('enabled ') : hint('disabled');
            const id = label(String(r.product ?? '(no id)').padEnd(idWidth));
            const name = r.name ? hint(`(${r.name})`) : '';
            const apis = r.api_resources ? hint(`${r.api_resources} API resource(s)`) : '';
            const extras = [name, apis].filter(Boolean).join('  ');
            console.log(`  ${flag}  ${id}${extras ? '  ' + extras : ''}`);
        }
    });

    projectsOption(
        bodyOptions(
            product
                .command('create [product]')
                .helpGroup('Records:')
                .description(
                    'Create a product, bare or from a JSON document (config + profile); the CLI template fills in the rest',
                )
                .option('-n, --name <name>', 'Display name')
                .option('-d, --description <text>', 'Description'),
        ),
    )
        .option('-j, --json', 'Output as JSON')
        .action(async (id, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            let productId = id;
            await runCommand({
                start: `Creating ${id ?? 'product'}...`,
                fn: async () => {
                    const doc = (await bodyFromOptions(opts)) ?? {};
                    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
                        throw inputError('create takes a JSON object');
                    }
                    productId ??= doc.product;
                    if (!productId) {
                        throw inputError(
                            'give the product id: <product>, or the body field "product"',
                        );
                    }
                    if (await productExists(productId, user)) {
                        throw alreadyExistsError(`Product "${productId}" already exists`);
                    }
                    await createProduct(productId, user, {
                        name: opts.name || doc.name,
                        description: opts.description || doc.description,
                        enabled: doc.enabled ?? true,
                        config: doc.config,
                        profile: doc.profile,
                    });
                    if (opts.projects) await setProjects('product', productId, opts.projects, user);
                },
                success: () => `Created product ${productId}`,
                failure: 'Failed to create product',
                onSuccess: () => {
                    if (isJsonMode()) printOk({ product: productId });
                },
            });
        });

    product
        .command('delete <product>')
        .helpGroup('Records:')
        .description('Delete a product (its devices stay, unassigned)')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (id, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (!(await confirmDestructive(opts, `Delete product ${id}? This cannot be undone.`))) {
                console.log(hint('Cancelled.'));
                return;
            }
            try {
                const removed = await deleteProduct(id, user);
                if (isJsonMode()) {
                    printOk({ product: id, removed });
                    return;
                }
                console.log(removed ? `Deleted ${info(id)}` : `Product ${info(id)} did not exist`);
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    return product;
}
