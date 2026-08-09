/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { randomUUID } from "crypto";
import {
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm
} from "fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";

import { extractReleaseBundle } from "./releaseBundle";
import { sha256Hex, verifyReleaseSignature } from "./releaseTrust";
import {
    MAX_MANIFEST_BYTES,
    MAX_RUNTIME_FILE_BYTES,
    MAX_SIGNATURE_BYTES,
    parseReleaseManifest,
    parseReleaseState,
    RELEASE_MANIFEST_NAME,
    RELEASE_RUNTIME_FILES,
    RELEASE_SIGNATURE_NAME,
    RELEASE_STATE_SCHEMA,
    ReleasePointer,
    releasePointer,
    ReleaseState,
    ReleaseValidationError
} from "./releaseTypes";

const RELEASES_DIRECTORY = "releases";
const RELEASE_STATE_NAME = "release-state.json";
const INSTALL_LOCK_NAME = "disorder-install.lock";
const INSTALL_LOCK_MAX_BYTES = 256;
const INSTALL_LOCK_RETRY_MS = 50;
const INSTALL_LOCK_TIMEOUT_MS = 2_000;
const INSTALL_LOCK_INVALID_STALE_MS = 30_000;
const MAX_STATE_BYTES = 16 * 1024;
let stateMutation = Promise.resolve<unknown>(undefined);

export interface StagedRelease {
    pointer: ReleasePointer;
    directory: string;
}

interface InstallLockOwner {
    schema: 1;
    pid: number;
    nonce: string;
    createdAt: number;
}

interface InstallLockLease {
    path: string;
    contents: Buffer;
    device: number;
    inode: number;
    handle: Awaited<ReturnType<typeof open>>;
}

function parseInstallLockOwner(contents: Buffer): InstallLockOwner | undefined {
    if (contents.byteLength === 0 || contents.byteLength > INSTALL_LOCK_MAX_BYTES)
        return;
    try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
        if (value == null || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).sort().join("\0") !== "createdAt\0nonce\0pid\0schema"
            || value.schema !== 1
            || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffff_ffff
            || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)
            || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) {
            return;
        }
        return value as InstallLockOwner;
    } catch {
        return;
    }
}

function processIsAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function recoverStaleInstallLock(lockPath: string) {
    try {
        const entry = await lstat(lockPath);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > INSTALL_LOCK_MAX_BYTES)
            return false;
        const contents = await readFile(lockPath);
        if (contents.byteLength !== entry.size)
            return false;
        const owner = parseInstallLockOwner(contents);
        if (owner != null ? processIsAlive(owner.pid) : Date.now() - entry.mtimeMs < INSTALL_LOCK_INVALID_STALE_MS)
            return false;

        const [confirmedEntry, confirmedContents] = await Promise.all([lstat(lockPath), readFile(lockPath)]);
        if (!confirmedEntry.isFile() || confirmedEntry.isSymbolicLink()
            || confirmedEntry.dev !== entry.dev || confirmedEntry.ino !== entry.ino
            || !confirmedContents.equals(contents)) {
            return false;
        }
        await rm(lockPath);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
}

async function acquireInstallLock(releaseRoot: string): Promise<InstallLockLease> {
    const root = safeReleaseRoot(releaseRoot);
    const lockPath = join(dirname(root), INSTALL_LOCK_NAME);
    const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;

    while (true) {
        let handle: Awaited<ReturnType<typeof open>>;
        try {
            handle = await open(lockPath, "wx", 0o600);
        } catch (error) {
            const { code } = error as NodeJS.ErrnoException;
            if (!["EACCES", "EEXIST", "EPERM"].includes(code ?? ""))
                throw new ReleaseValidationError("The release installation lock could not be created.");
            if (await recoverStaleInstallLock(lockPath))
                continue;
            if (Date.now() >= deadline)
                throw new ReleaseValidationError("Another release installation is already in progress.");
            await sleep(INSTALL_LOCK_RETRY_MS);
            continue;
        }

        const owner: InstallLockOwner = {
            schema: 1,
            pid: process.pid,
            nonce: randomUUID().replaceAll("-", ""),
            createdAt: Date.now()
        };
        const contents = Buffer.from(JSON.stringify(owner), "utf8");
        try {
            await handle.writeFile(contents);
            await handle.sync();
            const [handleInfo, pathInfo] = await Promise.all([handle.stat(), lstat(lockPath)]);
            if (!handleInfo.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink()
                || handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) {
                throw new ReleaseValidationError("The release installation lock changed unexpectedly.");
            }
            return {
                path: lockPath,
                contents,
                device: handleInfo.dev,
                inode: handleInfo.ino,
                handle
            };
        } catch (error) {
            await handle.close().catch(() => { });
            await rm(lockPath, { force: true }).catch(() => { });
            if (error instanceof ReleaseValidationError)
                throw error;
            throw new ReleaseValidationError("The release installation lock could not be initialized.");
        }
    }
}

async function releaseInstallLock(lease: InstallLockLease) {
    try {
        await lease.handle.close();
    } catch {
        return;
    }
    try {
        const [entry, contents] = await Promise.all([lstat(lease.path), readFile(lease.path)]);
        if (entry.isFile() && !entry.isSymbolicLink()
            && entry.dev === lease.device && entry.ino === lease.inode
            && contents.equals(lease.contents)) {
            await rm(lease.path);
        }
    } catch {
        // A crashed process leaves a recoverable owner record. Cleanup must not
        // replace the result of a completed state transaction.
    }
}

async function withInstallLock<T>(releaseRoot: string, callback: () => Promise<T>) {
    const lease = await acquireInstallLock(releaseRoot);

    try {
        return await callback();
    } finally {
        await releaseInstallLock(lease);
    }
}

function mutateState<T>(releaseRoot: string, callback: () => Promise<T>): Promise<T> {
    const current = stateMutation.then(
        () => withInstallLock(releaseRoot, callback),
        () => withInstallLock(releaseRoot, callback)
    );
    stateMutation = current.then(() => undefined, () => undefined);
    return current;
}

function safeReleaseRoot(value: string) {
    if (!isAbsolute(value) || value.includes("\0"))
        throw new ReleaseValidationError("The release root is invalid.");
    return resolve(value);
}

export function getReleaseRoot() {
    const value = process.env.VENCORD_RELEASE_ROOT;
    if (value == null || value.length === 0)
        throw new ReleaseValidationError("This installation does not have a trusted release root.");
    return safeReleaseRoot(value);
}

function statePath(releaseRoot: string) {
    return join(safeReleaseRoot(releaseRoot), RELEASE_STATE_NAME);
}

function releasesPath(releaseRoot: string) {
    return join(safeReleaseRoot(releaseRoot), RELEASES_DIRECTORY);
}

function releaseDirectory(releaseRoot: string, id: string) {
    const parent = releasesPath(releaseRoot);
    const path = resolve(parent, id);
    if (dirname(path) !== parent || basename(path) !== id)
        throw new ReleaseValidationError("The release directory is invalid.");
    return path;
}

async function readBoundedRegularFile(path: string, maximumBytes: number) {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size < 0 || file.size > maximumBytes)
        throw new ReleaseValidationError("A local release file has an invalid type or size.");
    const contents = await readFile(path);
    if (contents.byteLength !== file.size)
        throw new ReleaseValidationError("A local release file changed while it was being verified.");
    return contents;
}

async function writeDurableExclusive(path: string, contents: Uint8Array) {
    const file = await open(path, "wx", 0o600);
    try {
        await file.writeFile(contents);
        await file.sync();
    } finally {
        await file.close();
    }
}

async function removeStagingDirectory(releaseRoot: string, staging: string) {
    const parent = releasesPath(releaseRoot);
    const resolved = resolve(staging);
    if (dirname(resolved) !== parent || !basename(resolved).startsWith(".staging-"))
        throw new ReleaseValidationError("Refusing to remove an unsafe staging path.");
    await rm(resolved, { recursive: true, force: true, maxRetries: 2 });
}

export async function readReleaseState(releaseRoot = getReleaseRoot()) {
    const raw = await readBoundedRegularFile(statePath(releaseRoot), MAX_STATE_BYTES);
    try {
        return parseReleaseState(JSON.parse(raw.toString("utf8")));
    } catch (error) {
        if (error instanceof ReleaseValidationError)
            throw error;
        throw new ReleaseValidationError("The local release state is not valid JSON.");
    }
}

async function writeReleaseStateUnlocked(releaseRoot: string, state: ReleaseState) {
    const root = safeReleaseRoot(releaseRoot);
    const validated = parseReleaseState(JSON.parse(JSON.stringify(state)));
    const contents = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (contents.byteLength > MAX_STATE_BYTES)
        throw new ReleaseValidationError("The local release state is too large.");

    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `.release-state-${process.pid}-${randomUUID()}.tmp`);
    try {
        await writeDurableExclusive(temporary, contents);
        await rename(temporary, statePath(root));
    } catch (error) {
        try {
            const resolved = resolve(temporary);
            if (dirname(resolved) === root && basename(resolved).startsWith(".release-state-"))
                await rm(resolved, { force: true });
        } catch { }
        throw error;
    }
    return validated;
}

export function writeReleaseState(releaseRoot: string, state: ReleaseState) {
    return mutateState(releaseRoot, () => writeReleaseStateUnlocked(releaseRoot, state));
}

export function observeReleasePointer(releaseRoot: string, pointer: ReleasePointer) {
    return mutateState(releaseRoot, async () => {
        const state = await readReleaseState(releaseRoot);
        if (pointer.sequence < state.highestSeenSequence)
            throw new ReleaseValidationError("The signed release is older than this installation's security watermark.");
        if (pointer.sequence === state.highestSeenSequence) {
            if (pointer.manifestSha256 !== state.highestSeenManifestSha256)
                throw new ReleaseValidationError("The release channel reused a sequence with different signed contents.");
            return state;
        }

        return writeReleaseStateUnlocked(releaseRoot, {
            ...state,
            highestSeenSequence: pointer.sequence,
            highestSeenManifestSha256: pointer.manifestSha256
        });
    });
}

export function isInstalledRelease(state: ReleaseState, pointer: ReleasePointer) {
    return [state.current, state.previous, state.failed].some(known => known != null
        && known.sequence === pointer.sequence
        && known.manifestSha256 === pointer.manifestSha256);
}

export async function verifyReleaseDirectory(releaseRoot: string, pointer: ReleasePointer) {
    const directory = releaseDirectory(releaseRoot, pointer.id);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new ReleaseValidationError("The installed release directory is invalid.");

    const entries = await readdir(directory, { withFileTypes: true });
    const expectedNames = new Set<string>([
        ...RELEASE_RUNTIME_FILES,
        RELEASE_MANIFEST_NAME,
        RELEASE_SIGNATURE_NAME
    ]);
    if (entries.length !== expectedNames.size
        || entries.some(entry => !expectedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
        || new Set(entries.map(entry => entry.name.toLowerCase())).size !== entries.length) {
        throw new ReleaseValidationError("The installed release contains unexpected files.");
    }

    const manifestBytes = await readBoundedRegularFile(join(directory, RELEASE_MANIFEST_NAME), MAX_MANIFEST_BYTES);
    const signatureBytes = await readBoundedRegularFile(join(directory, RELEASE_SIGNATURE_NAME), MAX_SIGNATURE_BYTES);
    if (sha256Hex(manifestBytes) !== pointer.manifestSha256)
        throw new ReleaseValidationError("The installed release manifest does not match its pointer.");
    verifyReleaseSignature(manifestBytes, signatureBytes);
    const manifest = parseReleaseManifest(manifestBytes);
    const parsedPointer = releasePointer(manifest, pointer.manifestSha256);
    if (parsedPointer.id !== pointer.id || parsedPointer.sequence !== pointer.sequence
        || parsedPointer.commit !== pointer.commit) {
        throw new ReleaseValidationError("The installed release identity does not match its pointer.");
    }

    for (const file of manifest.files) {
        const contents = await readBoundedRegularFile(
            join(directory, file.path),
            Math.min(MAX_RUNTIME_FILE_BYTES, file.size)
        );
        if (contents.byteLength !== file.size || sha256Hex(contents) !== file.sha256)
            throw new ReleaseValidationError("An installed release file failed verification.");
    }

    return manifest;
}

export async function stageRelease(
    releaseRoot: string,
    manifestBytes: Uint8Array,
    signatureBytes: Uint8Array,
    bundleBytes: Uint8Array
): Promise<StagedRelease> {
    const root = safeReleaseRoot(releaseRoot);
    verifyReleaseSignature(manifestBytes, signatureBytes);
    const manifest = parseReleaseManifest(manifestBytes);
    const pointer = releasePointer(manifest, sha256Hex(manifestBytes));
    await observeReleasePointer(root, pointer);
    const extracted = extractReleaseBundle(bundleBytes, manifest);

    await mkdir(releasesPath(root), { recursive: true, mode: 0o700 });
    const finalDirectory = releaseDirectory(root, pointer.id);
    try {
        await verifyReleaseDirectory(root, pointer);
        return { pointer, directory: finalDirectory };
    } catch (error) {
        try {
            await lstat(finalDirectory);
        } catch {
            // The immutable destination does not exist yet; stage it below.
            error = null;
        }
        if (error != null)
            throw error;
    }

    const staging = join(releasesPath(root), `.staging-${pointer.id}-${randomUUID()}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
        await writeDurableExclusive(join(staging, RELEASE_MANIFEST_NAME), manifestBytes);
        await writeDurableExclusive(join(staging, RELEASE_SIGNATURE_NAME), signatureBytes);
        for (const path of RELEASE_RUNTIME_FILES) {
            const contents = extracted.get(path);
            if (contents == null)
                throw new ReleaseValidationError("The verified release is missing a required file.");
            await writeDurableExclusive(join(staging, path), contents);
        }

        await rename(staging, finalDirectory);
    } catch (error) {
        try {
            await verifyReleaseDirectory(root, pointer);
        } catch {
            await removeStagingDirectory(root, staging);
            throw error;
        }
        await removeStagingDirectory(root, staging);
    }

    await verifyReleaseDirectory(root, pointer);
    return { pointer, directory: finalDirectory };
}

export async function activateRelease(releaseRoot: string, pointer: ReleasePointer) {
    const root = safeReleaseRoot(releaseRoot);
    await verifyReleaseDirectory(root, pointer);
    return mutateState(root, async () => {
        const state = await readReleaseState(root);
        if (state.highestSeenSequence !== pointer.sequence
            || state.highestSeenManifestSha256 !== pointer.manifestSha256) {
            throw new ReleaseValidationError("The staged release does not match the security watermark.");
        }
        if (state.current.id === pointer.id && state.current.manifestSha256 === pointer.manifestSha256)
            return true;
        if (state.pendingBoot)
            throw new ReleaseValidationError("The active release has not completed a healthy boot yet.");
        if (pointer.sequence <= state.current.sequence)
            throw new ReleaseValidationError("The staged release is not newer than the active release.");

        await writeReleaseStateUnlocked(root, {
            schema: RELEASE_STATE_SCHEMA,
            current: pointer,
            previous: state.current,
            ...(state.failed == null ? {} : { failed: state.failed }),
            highestSeenSequence: state.highestSeenSequence,
            highestSeenManifestSha256: state.highestSeenManifestSha256,
            pendingBoot: true,
            bootAttempts: 0
        });
        return true;
    });
}

export async function markCurrentReleaseHealthy() {
    const releaseRoot = process.env.VENCORD_RELEASE_ROOT;
    const releaseId = process.env.VENCORD_RELEASE_ID;
    const releaseSequence = process.env.VENCORD_RELEASE_SEQUENCE;
    if (releaseRoot == null || releaseId == null || releaseSequence == null)
        return false;
    if (!/^[1-9][0-9]{0,15}$/.test(releaseSequence))
        return false;

    return mutateState(releaseRoot, async () => {
        const state = await readReleaseState(releaseRoot);
        if (state.current.id !== releaseId || state.current.sequence !== Number(releaseSequence))
            return false;
        await verifyReleaseDirectory(releaseRoot, state.current);
        if (!state.pendingBoot && state.bootAttempts === 0)
            return true;
        await writeReleaseStateUnlocked(releaseRoot, {
            ...state,
            pendingBoot: false,
            bootAttempts: 0
        });
        return true;
    });
}
