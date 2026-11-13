// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Lock files shared by the processes of a CLI on one machine: the config
 * lock around every read-modify-write of the profiles, and the refresh
 * lock of each set of credentials.
 *
 * A lock is a file created exclusively, holding its owner's pid and a
 * nonce. One whose owner is gone, or older than `staleMs`, is taken over:
 * renamed aside (only one process can), and put back if what was moved
 * turns out to be a lock taken meanwhile. A lock is released only by its
 * owner. Where no lock file can be made (a read-only folder), the work
 * runs without one.
 */

/** @typedef {{ staleMs: number, waitMs: number }} LockOptions */

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One attempt: the token of the lock when taken, null when held by
 * another, undefined when no lock file can be made here.
 *
 * @param {string} lock
 * @param {number} staleMs
 * @returns {string | null | undefined}
 */
function tryAcquire(lock, staleMs) {
    const token = `${process.pid}:${crypto.randomUUID()}`;
    try {
        fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
        return token;
    } catch (error) {
        if (error.code !== 'EEXIST') return undefined;
    }
    let seen;
    try {
        seen = { content: fs.readFileSync(lock, 'utf8'), mtimeMs: fs.statSync(lock).mtimeMs };
    } catch {
        return null; // Released meanwhile: the next attempt takes it.
    }
    if (!isStale(seen, staleMs)) return null;
    const aside = `${lock}.${token.replace(':', '-')}.stale`;
    try {
        fs.renameSync(lock, aside);
    } catch {
        return null; // Another process took it over first.
    }
    try {
        if (fs.readFileSync(aside, 'utf8') !== seen.content) {
            // A fresh lock taken after we looked: give it back.
            try {
                fs.linkSync(aside, lock);
            } catch {
                // Another one is there already.
            }
        }
    } finally {
        fs.rmSync(aside, { force: true });
    }
    return null;
}

function isStale({ content, mtimeMs }, staleMs) {
    if (Date.now() - mtimeMs > staleMs) return true;
    const pid = Number(content.split(':')[0]);
    // Being written by its owner right now: not stale.
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}

/** Remove the lock if it is still ours. */
function release(lock, token) {
    try {
        if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
    } catch {
        // Already gone.
    }
}

/**
 * Run `fn` holding `lock`, waiting for it asynchronously.
 *
 * @template T
 * @param {string} lock
 * @param {() => Promise<T>} fn
 * @param {LockOptions} options
 * @returns {Promise<T>}
 */
export async function withFileLock(lock, fn, { staleMs, waitMs }) {
    const giveUpAt = Date.now() + waitMs;
    let token = tryAcquire(lock, staleMs);
    while (token === null && Date.now() < giveUpAt) {
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
        token = tryAcquire(lock, staleMs);
    }
    try {
        return await fn();
    } finally {
        if (token) release(lock, token);
    }
}

/**
 * Run `fn` holding `lock`, waiting for it synchronously: for short critical
 * sections in synchronous code.
 *
 * @template T
 * @param {string} lock
 * @param {() => T} fn
 * @param {LockOptions} options
 * @returns {T}
 */
export function withFileLockSync(lock, fn, { staleMs, waitMs }) {
    const giveUpAt = Date.now() + waitMs;
    let token = tryAcquire(lock, staleMs);
    while (token === null && Date.now() < giveUpAt) {
        sleepSync(5 + Math.random() * 10);
        token = tryAcquire(lock, staleMs);
    }
    try {
        return fn();
    } finally {
        if (token) release(lock, token);
    }
}
