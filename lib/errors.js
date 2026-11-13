/**
 * Normalize an axios / fetch-style error into a single Error with a stable
 * `.code` and `.status`. Replaces the repeated if-response/if-request
 * blocks in status.js / property.js / resource.js / device.js.
 *
 * Pass `messages.notFound` to override the 404 message with something
 * that names the missing entity (e.g. "Device not found: abc").
 */
export function apiError(error, messages = {}) {
    // Errors normalized upstream (the tagged 'unauthorized' from a failed
    // token refresh, inputError, ...) carry a stable string code and no
    // axios envelope: pass them through so the code survives.
    if (
        error &&
        typeof error.code === 'string' &&
        !error.isAxiosError &&
        !error.response &&
        !error.request
    ) {
        return error;
    }
    if (error && error.response) {
        const status = error.response.status;
        if (status === 404) {
            // The caller names what it looked for; the server may say that
            // something else was missing ("file not found" on an import).
            const detail = serverMessage(error.response.data);
            const base = messages.notFound || 'Not found';
            const err = new Error(
                detail && !/^(resource )?not found\.?$/i.test(detail)
                    ? `${base} (server: ${detail})`
                    : base,
            );
            err.code = 'not_found';
            err.status = 404;
            return err;
        }
        if (status === 401 || status === 403) {
            // 401: the token is not valid (expired, revoked). 403: it is,
            // but lacks the permission, or the account the feature: logging
            // in again would not help, so don't suggest it.
            const detail = serverMessage(error.response.data);
            const err = new Error(
                messages.unauthorized ||
                    (status === 401
                        ? 'Unauthorized. Your token may have expired. Please reconfigure.'
                        : `Forbidden: the token or the account is not allowed to do this${detail ? ` (${detail})` : ''}.`),
            );
            err.code = 'unauthorized';
            err.status = status;
            return err;
        }
        // Thinger answers errors as { error: { message } }: keep the reason,
        // it is often the only clue ("bucket backend not available").
        const detail = serverMessage(error.response.data);
        const err = new Error(
            `Server error: ${status} ${error.response.statusText || ''}`.trim() +
                (detail ? ` — ${detail}` : ''),
        );
        err.code = 'server_error';
        err.status = status;
        return err;
    }
    // Axios gave up waiting: the server may still be doing the work.
    if (error?.code === 'ECONNABORTED' && /timeout/i.test(error.message) && error.config) {
        const seconds = Math.round((error.config.timeout || 0) / 1000);
        const err = new Error(
            `No answer from the server within ${seconds} s. It may still be working on the request: check its state before retrying.`,
        );
        err.code = 'timeout';
        return err;
    }
    if (error && error.request) {
        const err = new Error('No response from server. Please check your connection.');
        err.code = 'network_error';
        return err;
    }
    const err = new Error(error?.message || String(error));
    err.code = 'error';
    return err;
}

/** The message a server error body carries, if any: `{ error: { message } }`,
 *  `{ message }`, `{ error: "…" }` (what device resources answer, relayed
 *  as is), or a short plain-text body ("cannot create more products"). */
export function serverMessage(data) {
    if (typeof data === 'string') {
        const text = data.trim().replace(/^"|"$/g, '');
        return text && text.length <= 300 && !text.startsWith('<') ? text : null;
    }
    if (!data || typeof data !== 'object') return null;
    const message =
        typeof data.error === 'string' ? data.error : (data.error?.message ?? data.message);
    return typeof message === 'string' && message ? message : null;
}

/**
 * Pre-tagged error for invalid / missing user input (CLI option,
 * MCP tool argument, …). Picked up by `classifyError` so it surfaces
 * as `code: 'input_error'` in both the CLI JSON envelope and the
 * MCP error metadata, matching the same code the CLI's `printErr`
 * uses for argument validation failures.
 */
export function inputError(message) {
    const err = new Error(message);
    err.code = 'input_error';
    return err;
}

/**
 * Error for a resource that already exists, tagged `already_exists` for
 * `classifyError` (create operations refuse to overwrite).
 */
export function alreadyExistsError(message) {
    const err = new Error(message);
    err.code = 'already_exists';
    return err;
}
