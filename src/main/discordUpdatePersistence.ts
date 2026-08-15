/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomUUID } from "crypto";
import type { BigIntStats, Stats } from "fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "path";

// Electron patches `fs` so paths ending in app.asar are treated as virtual
// archives. This transaction must operate on the physical host ASAR instead.
// Keep normal Node's `fs` as the test/runtime fallback where original-fs does
// not exist.
const physicalFs: typeof import("fs") = process.versions.electron != null
    ? require("original-fs")
    : require("fs");
const {
    closeSync,
    constants: FsConstants,
    copyFileSync,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync
} = physicalFs;

const PACKAGE_JSON = Buffer.from('{\n\t"name": "discord",\n\t"main": "index.js"\n}', "utf8");
const VERSION_DIRECTORY = /^app-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;
const STAGING_NAME = /^\.disorder-app-asar-staging-[0-9a-f]{32}$/;
const BACKUP_STAGING_NAME = /^\.disorder-app-asar-backup-[0-9a-f]{32}$/;
const LOCK_STAGING_NAME = /^\.disorder-host-repair-lock-[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/;
const JOURNAL_NAME = ".disorder-host-repair.json";
const LOCK_NAME = ".disorder-host-repair.lock";
const MAX_LOADER_BYTES = 64 * 1024;
const MIN_STOCK_ASAR_BYTES = 64 * 1024;
// Persistence repair runs in Discord's main process. Keep its hashing bound
// deliberately small; current Discord host ASARs are only a few MiB. Larger
// files are left for an explicit installer repair rather than blocking startup.
const MAX_STOCK_ASAR_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 4096;
const MAX_LOCK_BYTES = 512;
const STALE_LOCK_MS = 30_000;

export type RepairStep =
    | "lock-candidate-written"
    | "lock-published"
    | "journal-written"
    | "staging-written"
    | "backup-written"
    | "source-revalidated"
    | "loader-committed"
    | "journal-installed";

export interface RepairOptions {
    expectedObservation?: DiscordResourceObservation;
    nonce?: () => string;
    now?: () => number;
    onStep?: (step: RepairStep) => void;
}

export interface RepairResult {
    status: "repaired" | "unchanged" | "busy" | "refused";
    target: string;
    reason?: string;
}

export interface DiscordResourceObservation {
    appDevice: string;
    appInode: string;
    appModifiedNs: string;
    appSha256: string;
    appSize: number;
    resourcesDevice: string;
    resourcesInode: string;
    resourcesPath: string;
    resourcesRealpath: string;
}

interface FileIdentity {
    device: string;
    inode: string;
    modifiedNs: string;
    sha256: string;
    size: number;
}

interface RepairJournal {
    schema: 1;
    product: "disorder-vencord";
    status: "pending" | "installed";
    resourcesPath: string;
    resourcesRealpath: string;
    resourcesDevice: string;
    resourcesInode: string;
    originalDevice: string;
    originalInode: string;
    originalModifiedNs: string;
    originalSize: number;
    originalSha256: string;
    loaderSize: number;
    loaderSha256: string;
    stagingName: string;
    backupStagingName: string;
}

interface LockLease {
    contents: Buffer;
    device: string;
    handle: number;
    inode: string;
    path: string;
}

class PersistenceError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
    }
}

function fail(reason: string): never {
    throw new PersistenceError(reason);
}

function exactKeys(value: object, keys: readonly string[]) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function tryLstat(path: string): Stats | undefined {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
    }
}

function tryLstatBig(path: string): BigIntStats | undefined {
    try {
        return lstatSync(path, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
    }
}

function comparisonPath(path: string) {
    const normalized = resolve(path).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string) {
    return comparisonPath(left) === comparisonPath(right);
}

function isCrossPlatformAbsolute(path: string) {
    return isAbsolute(path) || win32.isAbsolute(path);
}

function canonicalAbsolutePath(path: string) {
    return isAbsolute(path) ? resolve(path) : win32.normalize(path);
}

function assertSafeAbsoluteDirectory(path: string, reason: string) {
    if (!isAbsolute(path) || path.includes("\0")) fail(reason);
    const resolved = resolve(path);
    const info = lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || !pathsEqual(realpathSync(resolved), resolved))
        fail(reason);
    return resolved;
}

interface DirectoryIdentity {
    device: string;
    inode: string;
    path: string;
    realpath: string;
}

function readDirectoryIdentity(path: string, reason: string): DirectoryIdentity {
    const canonicalPath = assertSafeAbsoluteDirectory(path, reason);
    const info = lstatSync(canonicalPath, { bigint: true });
    return {
        device: info.dev.toString(),
        inode: info.ino.toString(),
        path: canonicalPath,
        realpath: realpathSync(canonicalPath)
    };
}

function assertDirectoryIdentity(expected: DirectoryIdentity, reason: string) {
    const actual = readDirectoryIdentity(expected.path, reason);
    if (actual.device !== expected.device || actual.inode !== expected.inode
        || !pathsEqual(actual.realpath, expected.realpath)) fail(reason);
    return actual;
}

function assertDirectChild(parent: string, child: string, reason: string) {
    if (!pathsEqual(dirname(child), parent)) fail(reason);
}

function sameFile(left: BigIntStats, right: BigIntStats) {
    return left.isFile() && right.isFile() && !right.isSymbolicLink()
        && left.dev === right.dev && left.ino === right.ino;
}

function sha256(contents: Uint8Array) {
    return createHash("sha256").update(contents).digest("hex");
}

function goJsonString(value: string) {
    // Match encoding/json.Marshal, which is what Vencord Installer uses when
    // it writes the loader ASAR.
    return JSON.stringify(value)
        .replaceAll("<", "\\u003c")
        .replaceAll(">", "\\u003e")
        .replaceAll("&", "\\u0026")
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029");
}

function readRegularIdentity(path: string, minimum: number, maximum: number): FileIdentity {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
        || before.size < BigInt(minimum) || before.size > BigInt(maximum))
        fail("invalid-file-type");
    const size = Number(before.size);

    const handle = openSync(path, "r");
    try {
        const opened = fstatSync(handle, { bigint: true });
        if (!sameFile(opened, before) || opened.size !== before.size) fail("file-changed");
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
        let offset = 0;
        while (offset < size) {
            const count = readSync(handle, buffer, 0, Math.min(buffer.length, size - offset), offset);
            if (count <= 0) fail("file-changed");
            digest.update(buffer.subarray(0, count));
            offset += count;
        }
        const after = fstatSync(handle, { bigint: true });
        const atPath = lstatSync(path, { bigint: true });
        if (!sameFile(after, atPath) || after.size !== before.size || after.mtimeNs !== before.mtimeNs)
            fail("file-changed");
        return {
            device: after.dev.toString(),
            inode: after.ino.toString(),
            modifiedNs: after.mtimeNs.toString(),
            sha256: digest.digest("hex"),
            size
        };
    } finally {
        closeSync(handle);
    }
}

function identitiesEqual(left: FileIdentity, right: FileIdentity) {
    return left.device === right.device && left.inode === right.inode
        && left.modifiedNs === right.modifiedNs && left.size === right.size
        && left.sha256 === right.sha256;
}

function observationFileIdentity(observation: DiscordResourceObservation): FileIdentity {
    return {
        device: observation.appDevice,
        inode: observation.appInode,
        modifiedNs: observation.appModifiedNs,
        sha256: observation.appSha256,
        size: observation.appSize
    };
}

function journalFileIdentity(journal: RepairJournal): FileIdentity {
    return {
        device: journal.originalDevice,
        inode: journal.originalInode,
        modifiedNs: journal.originalModifiedNs,
        sha256: journal.originalSha256,
        size: journal.originalSize
    };
}

function fileHasIdentity(path: string, expected: FileIdentity) {
    try {
        return identitiesEqual(readRegularIdentity(path, expected.size, expected.size), expected);
    } catch {
        return false;
    }
}

function fileMatches(path: string, identity: Pick<FileIdentity, "sha256" | "size">) {
    try {
        const actual = readRegularIdentity(path, identity.size, identity.size);
        return actual.size === identity.size && actual.sha256 === identity.sha256;
    } catch {
        return false;
    }
}

function fileEquals(path: string, expected: Uint8Array) {
    try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.byteLength)
            return false;
        const contents = readFileSync(path);
        return contents.byteLength === expected.byteLength && contents.equals(Buffer.from(expected));
    } catch {
        return false;
    }
}

function fileIsExpectedPrefix(path: string, expected: Uint8Array) {
    try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > expected.byteLength)
            return false;
        const contents = readFileSync(path);
        return contents.byteLength === info.size && Buffer.from(expected).subarray(0, contents.byteLength).equals(contents);
    } catch {
        return false;
    }
}

function fileIsExpectedSourcePrefix(path: string, sourcePath: string, source: FileIdentity) {
    let candidateHandle: number | undefined;
    let sourceHandle: number | undefined;
    try {
        const candidateBefore = lstatSync(path, { bigint: true });
        const sourceBefore = lstatSync(sourcePath, { bigint: true });
        if (!candidateBefore.isFile() || candidateBefore.isSymbolicLink()
            || candidateBefore.size > BigInt(source.size) || !sourceBefore.isFile() || sourceBefore.isSymbolicLink()
            || sourceBefore.dev.toString() !== source.device || sourceBefore.ino.toString() !== source.inode
            || sourceBefore.size !== BigInt(source.size) || sourceBefore.mtimeNs.toString() !== source.modifiedNs) return false;

        candidateHandle = openSync(path, "r");
        sourceHandle = openSync(sourcePath, "r");
        const candidateOpened = fstatSync(candidateHandle, { bigint: true });
        const sourceOpened = fstatSync(sourceHandle, { bigint: true });
        if (!sameFile(candidateOpened, candidateBefore) || !sameFile(sourceOpened, sourceBefore)) return false;

        const candidateBuffer = Buffer.allocUnsafe(1024 * 1024);
        const sourceBuffer = Buffer.allocUnsafe(1024 * 1024);
        const candidateSize = Number(candidateBefore.size);
        let offset = 0;
        while (offset < candidateSize) {
            const length = Math.min(candidateBuffer.length, candidateSize - offset);
            const candidateCount = readSync(candidateHandle, candidateBuffer, 0, length, offset);
            const sourceCount = readSync(sourceHandle, sourceBuffer, 0, length, offset);
            if (candidateCount !== length || sourceCount !== length
                || !candidateBuffer.subarray(0, length).equals(sourceBuffer.subarray(0, length))) return false;
            offset += length;
        }

        const candidateAfter = fstatSync(candidateHandle, { bigint: true });
        const sourceAfter = fstatSync(sourceHandle, { bigint: true });
        const candidateAtPath = lstatSync(path, { bigint: true });
        const sourceAtPath = lstatSync(sourcePath, { bigint: true });
        return sameFile(candidateAfter, candidateAtPath) && candidateAfter.size === candidateBefore.size
            && candidateAfter.mtimeNs === candidateBefore.mtimeNs
            && sameFile(sourceAfter, sourceAtPath) && sourceAfter.dev.toString() === source.device
            && sourceAfter.ino.toString() === source.inode && sourceAfter.size === BigInt(source.size)
            && sourceAfter.mtimeNs.toString() === source.modifiedNs;
    } catch {
        return false;
    } finally {
        if (candidateHandle != null) closeSync(candidateHandle);
        if (sourceHandle != null) closeSync(sourceHandle);
    }
}

function fsyncDirectoryBestEffort(path: string) {
    let handle: number | undefined;
    try {
        handle = openSync(path, "r");
        fsyncSync(handle);
    } catch {
        // Directory fsync is not supported by all Windows filesystems.
    } finally {
        if (handle != null) {
            try {
                closeSync(handle);
            } catch { }
        }
    }
}

function writeExclusiveSynced(path: string, contents: Uint8Array) {
    const handle = openSync(path, "wx", 0o600);
    try {
        writeFileSync(handle, contents);
        fsyncSync(handle);
    } finally {
        closeSync(handle);
    }
}

function safeNonce(factory: (() => string) | undefined) {
    const nonce = factory?.() ?? randomUUID().replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/.test(nonce)) fail("invalid-nonce");
    return nonce;
}

function parseJournal(path: string, resourcesPath: string, loader: Uint8Array): RepairJournal | undefined {
    const info = tryLstat(path);
    if (info == null) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_JOURNAL_BYTES)
        fail("invalid-journal");

    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        fail("invalid-journal");
    }
    const keys = [
        "schema", "product", "status", "resourcesPath", "resourcesRealpath", "resourcesDevice",
        "resourcesInode", "originalDevice", "originalInode", "originalModifiedNs", "originalSize",
        "originalSha256", "loaderSize", "loaderSha256", "stagingName", "backupStagingName"
    ];
    if (value == null || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, keys))
        fail("invalid-journal");
    const journal = value as Record<string, unknown>;
    if (journal.schema !== 1 || journal.product !== "disorder-vencord"
        || (journal.status !== "pending" && journal.status !== "installed")
        || typeof journal.resourcesPath !== "string" || !pathsEqual(journal.resourcesPath, resourcesPath)
        || typeof journal.resourcesRealpath !== "string" || !pathsEqual(journal.resourcesRealpath, resourcesPath)
        || typeof journal.resourcesDevice !== "string" || !DECIMAL_IDENTITY.test(journal.resourcesDevice)
        || typeof journal.resourcesInode !== "string" || !DECIMAL_IDENTITY.test(journal.resourcesInode)
        || typeof journal.originalDevice !== "string" || !DECIMAL_IDENTITY.test(journal.originalDevice)
        || typeof journal.originalInode !== "string" || !DECIMAL_IDENTITY.test(journal.originalInode)
        || typeof journal.originalModifiedNs !== "string" || !DECIMAL_IDENTITY.test(journal.originalModifiedNs)
        || !Number.isSafeInteger(journal.originalSize) || (journal.originalSize as number) < MIN_STOCK_ASAR_BYTES
        || (journal.originalSize as number) > MAX_STOCK_ASAR_BYTES
        || typeof journal.originalSha256 !== "string" || !SHA256.test(journal.originalSha256)
        || journal.loaderSize !== loader.byteLength || journal.loaderSha256 !== sha256(loader)
        || typeof journal.stagingName !== "string" || !STAGING_NAME.test(journal.stagingName)
        || typeof journal.backupStagingName !== "string"
        || !BACKUP_STAGING_NAME.test(journal.backupStagingName)) {
        fail("invalid-journal");
    }
    return journal as unknown as RepairJournal;
}

function writeJournal(path: string, journal: RepairJournal, nonceFactory?: () => string) {
    const contents = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
    if (contents.byteLength > MAX_JOURNAL_BYTES) fail("invalid-journal");
    const temporary = join(dirname(path), `.disorder-host-repair-journal-${safeNonce(nonceFactory)}`);
    assertDirectChild(dirname(path), temporary, "unsafe-journal-path");
    try {
        writeExclusiveSynced(temporary, contents);
        const current = tryLstat(path);
        if (current == null) {
            linkSync(temporary, path);
        } else {
            if (!current.isFile() || current.isSymbolicLink() || current.size < 1 || current.size > MAX_JOURNAL_BYTES)
                fail("invalid-journal");
            renameSync(temporary, path);
        }
        fsyncDirectoryBestEffort(dirname(path));
    } finally {
        try {
            if (fileEquals(temporary, contents)) unlinkSync(temporary);
        } catch { }
    }
}

function processIsAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
    }
}

function removeExactLockFile(path: string, identity: BigIntStats, contents: Uint8Array) {
    try {
        const current = lstatSync(path, { bigint: true });
        if (!sameFile(identity, current) || !readFileSync(path).equals(Buffer.from(contents))) return false;
        unlinkSync(path);
        fsyncDirectoryBestEffort(dirname(path));
        return true;
    } catch {
        return false;
    }
}

function recoverStaleLock(path: string, nowFactory?: () => number) {
    const info = tryLstat(path);
    if (info == null) return true;
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_LOCK_BYTES)
        return false;
    const exactInfo = lstatSync(path, { bigint: true });
    if (!exactInfo.isFile() || exactInfo.isSymbolicLink() || exactInfo.size !== BigInt(info.size)) return false;
    const contents = readFileSync(path);
    if (contents.byteLength !== info.size) return false;

    let owner: unknown;
    try {
        owner = JSON.parse(contents.toString("utf8"));
    } catch {
        return false;
    }
    if (owner == null || typeof owner !== "object" || Array.isArray(owner)
        || !exactKeys(owner, ["schema", "pid", "createdAt", "nonce"])) return false;
    const record = owner as Record<string, unknown>;
    const now = nowFactory?.() ?? Date.now();
    if (record.schema !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
        || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 1
        || typeof record.nonce !== "string" || !/^[0-9a-f]{32}$/.test(record.nonce)
        || !Number.isSafeInteger(now) || now < 1 || processIsAlive(record.pid as number)
        || now - (record.createdAt as number) < STALE_LOCK_MS) {
        return false;
    }

    const confirmed = lstatSync(path, { bigint: true });
    const confirmedContents = readFileSync(path);
    if (!sameFile(confirmed, exactInfo)
        || !confirmedContents.equals(contents)) return false;

    const staging = join(dirname(path), `.disorder-host-repair-lock-${record.nonce}`);
    assertDirectChild(dirname(path), staging, "unsafe-lock-staging-path");
    if (!LOCK_STAGING_NAME.test(basename(staging))) return false;
    const stagingInfo = tryLstatBig(staging);
    if (stagingInfo != null && sameFile(exactInfo, stagingInfo))
        removeExactLockFile(staging, stagingInfo, contents);
    return removeExactLockFile(path, exactInfo, contents);
}

function acquireLock(resourcesPath: string, options: RepairOptions): LockLease | undefined {
    const path = join(resourcesPath, LOCK_NAME);
    assertDirectChild(resourcesPath, path, "unsafe-lock-path");
    for (let attempt = 0; attempt < 3; attempt++) {
        if (tryLstat(path) != null && !recoverStaleLock(path, options.now)) return undefined;

        const nonce = safeNonce(options.nonce);
        const staging = join(resourcesPath, `.disorder-host-repair-lock-${nonce}`);
        assertDirectChild(resourcesPath, staging, "unsafe-lock-staging-path");
        if (!LOCK_STAGING_NAME.test(basename(staging))) fail("unsafe-lock-staging-path");
        const createdAt = options.now?.() ?? Date.now();
        if (!Number.isSafeInteger(createdAt) || createdAt < 1) fail("invalid-lock-time");
        const owner = { schema: 1, pid: process.pid, createdAt, nonce };
        const contents = Buffer.from(JSON.stringify(owner), "utf8");
        if (contents.byteLength > MAX_LOCK_BYTES) fail("invalid-lock");

        let stagingInfo: BigIntStats | undefined;
        let handle: number | undefined;
        try {
            writeExclusiveSynced(staging, contents);
            stagingInfo = lstatSync(staging, { bigint: true });
            if (!stagingInfo.isFile() || stagingInfo.isSymbolicLink()
                || stagingInfo.size !== BigInt(contents.byteLength)) fail("invalid-lock-staging");
            invokeStep(options, "lock-candidate-written");

            try {
                linkSync(staging, path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
                removeExactLockFile(staging, stagingInfo, contents);
                if (!recoverStaleLock(path, options.now)) return undefined;
                continue;
            }
            fsyncDirectoryBestEffort(resourcesPath);
            invokeStep(options, "lock-published");

            const published = lstatSync(path, { bigint: true });
            if (!sameFile(stagingInfo, published) || !readFileSync(path).equals(contents))
                fail("invalid-lock");
            handle = openSync(path, "r");
            const opened = fstatSync(handle, { bigint: true });
            if (!sameFile(opened, published) || !removeExactLockFile(staging, stagingInfo, contents))
                fail("invalid-lock");
            return {
                contents,
                device: opened.dev.toString(),
                handle,
                inode: opened.ino.toString(),
                path
            };
        } catch (error) {
            if (handle != null) {
                try {
                    closeSync(handle);
                } catch { }
            }
            if (stagingInfo != null) {
                removeExactLockFile(path, stagingInfo, contents);
                removeExactLockFile(staging, stagingInfo, contents);
            }
            throw error;
        }
    }
    return undefined;
}

function releaseLock(lease: LockLease) {
    try {
        closeSync(lease.handle);
    } catch {
        return;
    }
    try {
        const atPath = lstatSync(lease.path, { bigint: true });
        const contents = readFileSync(lease.path);
        if (atPath.isFile() && !atPath.isSymbolicLink() && atPath.dev.toString() === lease.device
            && atPath.ino.toString() === lease.inode && contents.equals(lease.contents)) {
            unlinkSync(lease.path);
        }
    } catch { }
}

function ensureStaging(path: string, loader: Uint8Array) {
    const existing = tryLstat(path);
    if (existing != null) {
        if (fileEquals(path, loader)) return;
        if (!fileIsExpectedPrefix(path, loader)) fail("invalid-staging");
        unlinkSync(path);
    }
    writeExclusiveSynced(path, loader);
    if (!fileEquals(path, loader)) fail("invalid-staging");
    fsyncDirectoryBestEffort(dirname(path));
}

function removeVerifiedBackupStaging(path: string, backupPath: string, original: FileIdentity) {
    const stagingInfo = tryLstat(path);
    if (stagingInfo == null) return;
    const backupInfo = tryLstat(backupPath);
    const isCommittedLink = backupInfo != null
        && sameFile(lstatSync(path, { bigint: true }), lstatSync(backupPath, { bigint: true }));
    if (!isCommittedLink && !fileMatches(path, original)) fail("invalid-backup-staging");
    unlinkSync(path);
    fsyncDirectoryBestEffort(dirname(path));
}

function ensureBackup(
    appPath: string,
    backupPath: string,
    stagingPath: string,
    original: FileIdentity,
    resources: DirectoryIdentity
) {
    const existingBackup = tryLstat(backupPath);
    if (existingBackup != null) {
        if (!fileMatches(backupPath, original)) fail("backup-mismatch");
        removeVerifiedBackupStaging(stagingPath, backupPath, original);
        return false;
    }

    const existingStaging = tryLstat(stagingPath);
    if (existingStaging != null && !fileMatches(stagingPath, original)) {
        if (!fileHasIdentity(appPath, original)
            || !fileIsExpectedSourcePrefix(stagingPath, appPath, original)) fail("invalid-backup-staging");
        unlinkSync(stagingPath);
        fsyncDirectoryBestEffort(resources.path);
    }

    if (tryLstat(stagingPath) == null) {
        assertDirectoryIdentity(resources, "resources-directory-changed");
        if (!fileHasIdentity(appPath, original)) fail("source-mismatch");
        copyFileSync(appPath, stagingPath, FsConstants.COPYFILE_EXCL);
        const stagingHandle = openSync(stagingPath, "r+");
        try {
            fsyncSync(stagingHandle);
        } finally {
            closeSync(stagingHandle);
        }
        fsyncDirectoryBestEffort(resources.path);
    }

    assertDirectoryIdentity(resources, "resources-directory-changed");
    if (!fileHasIdentity(appPath, original)) fail("source-mismatch");
    if (!fileMatches(stagingPath, original)) fail("backup-staging-mismatch");

    // A hard link makes the final backup name visible atomically and fails if
    // anything already occupies it. A crash can therefore leave only the
    // journal-named temporary, never a partial _app.asar.
    try {
        linkSync(stagingPath, backupPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") fail("backup-commit-raced");
        throw error;
    }
    fsyncDirectoryBestEffort(resources.path);
    if (!fileMatches(backupPath, original)) fail("backup-mismatch");
    removeVerifiedBackupStaging(stagingPath, backupPath, original);
    return true;
}

function invokeStep(options: RepairOptions, step: RepairStep) {
    options.onStep?.(step);
}

export function createCanonicalDiscordLoaderAsar(patcherPath: string) {
    if (!isCrossPlatformAbsolute(patcherPath) || patcherPath.includes("\0")) fail("invalid-patcher-path");
    const canonicalPatcher = canonicalAbsolutePath(patcherPath);
    const indexJs = Buffer.from(`require(${goJsonString(canonicalPatcher)})`, "utf8");
    const header = Buffer.from(
        `{"files":{"index.js":{"size":${indexJs.byteLength},"offset":"0"},`
        + `"package.json":{"size":${PACKAGE_JSON.byteLength},"offset":"${indexJs.byteLength}"}}}`,
        "utf8"
    );
    const alignedSize = (header.byteLength + 3) & ~3;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(alignedSize + 8, 4);
    prefix.writeUInt32LE(alignedSize + 4, 8);
    prefix.writeUInt32LE(header.byteLength, 12);
    const padding = Buffer.alloc(alignedSize - header.byteLength, "0");
    const result = Buffer.concat([prefix, header, padding, indexJs, PACKAGE_JSON]);
    if (result.byteLength > MAX_LOADER_BYTES) fail("loader-too-large");
    return result;
}

export function extractCanonicalPatcherPath(loader: Uint8Array) {
    const contents = Buffer.from(loader);
    if (contents.byteLength < 16 + PACKAGE_JSON.byteLength || contents.byteLength > MAX_LOADER_BYTES)
        return undefined;
    const dataSize = contents.readUInt32LE(0);
    const headerSize = contents.readUInt32LE(4);
    const headerObjectSize = contents.readUInt32LE(8);
    const headerStringSize = contents.readUInt32LE(12);
    if (dataSize !== 4 || headerSize < 8 || headerObjectSize + 4 !== headerSize
        || headerStringSize > headerObjectSize - 4) return undefined;
    const contentOffset = 8 + headerSize;
    if (contentOffset < 16 || contentOffset + PACKAGE_JSON.byteLength >= contents.byteLength
        || !contents.subarray(contents.byteLength - PACKAGE_JSON.byteLength).equals(PACKAGE_JSON)) return undefined;
    const indexJs = contents.subarray(contentOffset, contents.byteLength - PACKAGE_JSON.byteLength).toString("utf8");
    if (!indexJs.startsWith("require(") || !indexJs.endsWith(")")) return undefined;
    let patcherPath: unknown;
    try {
        patcherPath = JSON.parse(indexJs.slice("require(".length, -1));
    } catch {
        return undefined;
    }
    if (typeof patcherPath !== "string" || !isCrossPlatformAbsolute(patcherPath) || patcherPath.includes("\0"))
        return undefined;
    try {
        return createCanonicalDiscordLoaderAsar(patcherPath).equals(contents)
            ? canonicalAbsolutePath(patcherPath)
            : undefined;
    } catch {
        return undefined;
    }
}

export function parseDiscordVersionDirectory(name: string) {
    const match = VERSION_DIRECTORY.exec(name);
    if (match == null) return undefined;
    const parts = match[1].split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function compareDiscordVersions(left: readonly number[], right: readonly number[]) {
    if (left.length !== 3 || right.length !== 3) fail("invalid-version");
    for (let index = 0; index < 3; index++) {
        if (!Number.isSafeInteger(left[index]) || left[index] < 0
            || !Number.isSafeInteger(right[index]) || right[index] < 0) fail("invalid-version");
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

export function resourcesDirectoryFromInjectorPath(injectorPath: string) {
    if (!isAbsolute(injectorPath) || injectorPath.includes("\0")) return undefined;
    const container = dirname(resolve(injectorPath));
    if (basename(container) !== "app.asar" && basename(container) !== "app") return undefined;
    const resources = dirname(container);
    return basename(resources).toLowerCase() === "resources" ? resources : undefined;
}

function regularCanonicalFile(path: string) {
    try {
        const info = lstatSync(path);
        return info.isFile() && !info.isSymbolicLink() && pathsEqual(realpathSync(path), path);
    } catch {
        return false;
    }
}

export function resolveTrustedPatcherPath(
    resourcesDirectory: string,
    environment: NodeJS.ProcessEnv = process.env
) {
    try {
        const resources = assertSafeAbsoluteDirectory(resourcesDirectory, "unsafe-resources-path");
        const releaseRootValue = environment.VENCORD_RELEASE_ROOT;
        if (releaseRootValue != null && releaseRootValue !== "") {
            const releaseRoot = assertSafeAbsoluteDirectory(releaseRootValue, "unsafe-release-root");
            const dataRoot = environment.VENCORD_USER_DATA_DIR;
            if (basename(releaseRoot) !== "dist" || dataRoot == null || dataRoot === ""
                || !isAbsolute(dataRoot) || dataRoot.includes("\0")
                || !pathsEqual(join(resolve(dataRoot), "dist"), releaseRoot))
                return undefined;
            const patcher = join(releaseRoot, "patcher.js");
            return regularCanonicalFile(patcher) ? resolve(patcher) : undefined;
        }

        const dataRoot = environment.VENCORD_USER_DATA_DIR;
        if (dataRoot != null && dataRoot !== "" && isAbsolute(dataRoot) && !dataRoot.includes("\0")) {
            const patcher = join(resolve(dataRoot), "dist", "patcher.js");
            if (regularCanonicalFile(patcher)) return resolve(patcher);
        }

        const loaderPath = join(resources, "app.asar");
        const loaderInfo = lstatSync(loaderPath);
        if (!loaderInfo.isFile() || loaderInfo.isSymbolicLink() || loaderInfo.size < 1 || loaderInfo.size > MAX_LOADER_BYTES)
            return undefined;
        const patcher = extractCanonicalPatcherPath(readFileSync(loaderPath));
        return patcher != null && basename(patcher) === "patcher.js" && basename(dirname(patcher)) === "dist"
            && regularCanonicalFile(patcher)
            ? patcher
            : undefined;
    } catch {
        return undefined;
    }
}

export function discoverWindowsUpdateResources(execPath: string) {
    const targets: string[] = [];
    try {
        if (!isAbsolute(execPath) || execPath.includes("\0")) return targets;
        const currentExecutable = resolve(execPath);
        const currentDirectory = dirname(currentExecutable);
        const currentVersion = parseDiscordVersionDirectory(basename(currentDirectory));
        if (currentVersion == null || !regularCanonicalFile(currentExecutable)) return targets;
        const root = assertSafeAbsoluteDirectory(dirname(currentDirectory), "unsafe-discord-root");
        assertDirectChild(root, currentDirectory, "unsafe-current-version");
        if (!pathsEqual(realpathSync(currentDirectory), currentDirectory)) return targets;

        for (const entry of readdirSync(root, { withFileTypes: true })) {
            const version = parseDiscordVersionDirectory(entry.name);
            if (version == null || compareDiscordVersions(version, currentVersion) <= 0 || !entry.isDirectory()
                || entry.isSymbolicLink()) continue;
            const versionDirectory = join(root, entry.name);
            assertDirectChild(root, versionDirectory, "unsafe-version-directory");
            const versionInfo = lstatSync(versionDirectory);
            if (!versionInfo.isDirectory() || versionInfo.isSymbolicLink()
                || !pathsEqual(realpathSync(versionDirectory), versionDirectory)) continue;
            const executable = join(versionDirectory, basename(currentExecutable));
            if (!regularCanonicalFile(executable)) continue;
            const resources = join(versionDirectory, "resources");
            if (!tryLstat(resources)?.isDirectory() || !pathsEqual(realpathSync(resources), resources)) continue;
            targets.push(resources);
        }
    } catch {
        return [];
    }
    return targets.sort((left, right) => {
        const leftVersion = parseDiscordVersionDirectory(basename(dirname(left)))!;
        const rightVersion = parseDiscordVersionDirectory(basename(dirname(right)))!;
        return compareDiscordVersions(leftVersion, rightVersion);
    });
}

export function observeDiscordResourceCandidate(resourcesDirectory: string): DiscordResourceObservation | undefined {
    try {
        const resources = readDirectoryIdentity(resourcesDirectory, "unsafe-resources-path");
        const appAsar = join(resources.path, "app.asar");
        assertDirectChild(resources.path, appAsar, "unsafe-target-path");
        const app = readRegularIdentity(appAsar, MIN_STOCK_ASAR_BYTES, MAX_STOCK_ASAR_BYTES);
        assertDirectoryIdentity(resources, "resources-directory-changed");
        return {
            appDevice: app.device,
            appInode: app.inode,
            appModifiedNs: app.modifiedNs,
            appSha256: app.sha256,
            appSize: app.size,
            resourcesDevice: resources.device,
            resourcesInode: resources.inode,
            resourcesPath: resources.path,
            resourcesRealpath: resources.realpath
        };
    } catch {
        return undefined;
    }
}

export function discordResourceObservationsEqual(
    left: DiscordResourceObservation,
    right: DiscordResourceObservation
) {
    return left.appDevice === right.appDevice && left.appInode === right.appInode
        && left.appModifiedNs === right.appModifiedNs && left.appSize === right.appSize
        && left.appSha256 === right.appSha256 && left.resourcesDevice === right.resourcesDevice
        && left.resourcesInode === right.resourcesInode && pathsEqual(left.resourcesPath, right.resourcesPath)
        && pathsEqual(left.resourcesRealpath, right.resourcesRealpath);
}

export function discordResourceObservationIsQuiescent(
    first: DiscordResourceObservation,
    second: DiscordResourceObservation,
    elapsedMs: number,
    minimumElapsedMs = 1_000
) {
    return Number.isFinite(elapsedMs) && Number.isFinite(minimumElapsedMs)
        && elapsedMs >= minimumElapsedMs && minimumElapsedMs >= 0
        && discordResourceObservationsEqual(first, second);
}

function validateExpectedObservation(
    expected: DiscordResourceObservation,
    resources: DirectoryIdentity,
    appPath: string
) {
    if (!pathsEqual(expected.resourcesPath, resources.path)
        || !pathsEqual(expected.resourcesRealpath, resources.realpath)
        || expected.resourcesDevice !== resources.device || expected.resourcesInode !== resources.inode
        || typeof expected.appDevice !== "string" || !DECIMAL_IDENTITY.test(expected.appDevice)
        || typeof expected.appInode !== "string" || !DECIMAL_IDENTITY.test(expected.appInode)
        || !Number.isSafeInteger(expected.appSize) || expected.appSize < MIN_STOCK_ASAR_BYTES
        || expected.appSize > MAX_STOCK_ASAR_BYTES
        || typeof expected.appModifiedNs !== "string" || !DECIMAL_IDENTITY.test(expected.appModifiedNs)
        || typeof expected.appSha256 !== "string" || !SHA256.test(expected.appSha256)) {
        fail("invalid-observation");
    }
    const identity = observationFileIdentity(expected);
    if (!fileHasIdentity(appPath, identity)) fail("source-observation-changed");
    assertDirectoryIdentity(resources, "resources-directory-changed");
    return identity;
}

export function repairDiscordResources(
    resourcesDirectory: string,
    loaderAsar: Uint8Array,
    options: RepairOptions = {}
): RepairResult {
    let target = resourcesDirectory;
    let lease: LockLease | undefined;
    try {
        const resources = readDirectoryIdentity(resourcesDirectory, "unsafe-resources-path");
        target = resources.path;
        const loader = Buffer.from(loaderAsar);
        const patcherPath = extractCanonicalPatcherPath(loader);
        if (patcherPath == null || loader.byteLength > MAX_LOADER_BYTES || !regularCanonicalFile(patcherPath))
            fail("invalid-loader");

        const appAsar = join(target, "app.asar");
        const backupAsar = join(target, "_app.asar");
        const unpackedApp = join(target, "app");
        const journalPath = join(target, JOURNAL_NAME);
        for (const path of [appAsar, backupAsar, unpackedApp, journalPath])
            assertDirectChild(target, path, "unsafe-target-path");
        if (tryLstat(unpackedApp) != null) fail("unpacked-app-present");

        lease = acquireLock(target, options);
        if (lease == null) return { status: "busy", target, reason: "repair-busy" };
        assertDirectoryIdentity(resources, "resources-directory-changed");

        let journal = parseJournal(journalPath, target, loader);
        if (journal != null && (journal.resourcesDevice !== resources.device
            || journal.resourcesInode !== resources.inode
            || !pathsEqual(journal.resourcesRealpath, resources.realpath))) {
            fail("journal-resources-mismatch");
        }
        const appInfo = tryLstat(appAsar);
        const backupInfo = tryLstat(backupAsar);
        const appIsOurs = appInfo != null && fileEquals(appAsar, loader);

        if (appIsOurs) {
            if (backupInfo == null || !backupInfo.isFile() || backupInfo.isSymbolicLink())
                fail("missing-or-invalid-backup");
            if (journal == null) {
                readRegularIdentity(backupAsar, MIN_STOCK_ASAR_BYTES, MAX_STOCK_ASAR_BYTES);
            } else {
                const original = journalFileIdentity(journal);
                if (!fileMatches(backupAsar, original)) fail("backup-mismatch");
                const staging = join(target, journal.stagingName);
                const backupStaging = join(target, journal.backupStagingName);
                assertDirectChild(target, staging, "unsafe-staging-path");
                assertDirectChild(target, backupStaging, "unsafe-backup-staging-path");
                if (tryLstat(staging) != null) {
                    if (!fileEquals(staging, loader)) fail("invalid-staging");
                    unlinkSync(staging);
                    fsyncDirectoryBestEffort(target);
                }
                removeVerifiedBackupStaging(backupStaging, backupAsar, original);
                if (journal.status !== "installed") {
                    assertDirectoryIdentity(resources, "resources-directory-changed");
                    if (!fileEquals(appAsar, loader) || !fileMatches(backupAsar, original))
                        fail("commit-verification-failed");
                    journal = { ...journal, status: "installed" };
                    writeJournal(journalPath, journal, options.nonce);
                    invokeStep(options, "journal-installed");
                }
            }
            return { status: "unchanged", target };
        }

        if (appInfo == null) {
            fail("missing-app-asar");
        } else if (!appInfo.isFile() || appInfo.isSymbolicLink()) {
            fail("invalid-app-asar");
        }

        let original: FileIdentity;
        if (journal == null) {
            if (backupInfo != null) fail("ambiguous-existing-backup");
            if (appInfo == null || appInfo.size < MIN_STOCK_ASAR_BYTES || appInfo.size > MAX_STOCK_ASAR_BYTES)
                fail("invalid-stock-asar");
            if (options.expectedObservation == null) fail("source-not-quiescent");
            original = validateExpectedObservation(options.expectedObservation, resources, appAsar);
            const nonce = safeNonce(options.nonce);
            journal = {
                schema: 1,
                product: "disorder-vencord",
                status: "pending",
                resourcesPath: target,
                resourcesRealpath: resources.realpath,
                resourcesDevice: resources.device,
                resourcesInode: resources.inode,
                originalDevice: original.device,
                originalInode: original.inode,
                originalModifiedNs: original.modifiedNs,
                originalSize: original.size,
                originalSha256: original.sha256,
                loaderSize: loader.byteLength,
                loaderSha256: sha256(loader),
                stagingName: `.disorder-app-asar-staging-${nonce}`,
                backupStagingName: `.disorder-app-asar-backup-${nonce}`
            };
            writeJournal(journalPath, journal, options.nonce);
            invokeStep(options, "journal-written");
        } else if (journal.status !== "pending") {
            fail("installed-journal-without-loader");
        } else {
            original = journalFileIdentity(journal);
            if (!fileHasIdentity(appAsar, original)) fail("source-mismatch");
        }

        const staging = join(target, journal.stagingName);
        const backupStaging = join(target, journal.backupStagingName);
        assertDirectChild(target, staging, "unsafe-staging-path");
        assertDirectChild(target, backupStaging, "unsafe-backup-staging-path");
        ensureStaging(staging, loader);
        invokeStep(options, "staging-written");

        if (ensureBackup(appAsar, backupAsar, backupStaging, original, resources)) {
            invokeStep(options, "backup-written");
        }
        if (!fileMatches(backupAsar, original)) fail("backup-mismatch");

        assertDirectoryIdentity(resources, "resources-directory-changed");
        if (!fileHasIdentity(appAsar, original)) fail("source-mismatch");
        invokeStep(options, "source-revalidated");
        renameSync(staging, appAsar);
        fsyncDirectoryBestEffort(target);
        invokeStep(options, "loader-committed");
        if (!fileEquals(appAsar, loader) || !fileMatches(backupAsar, original))
            fail("commit-verification-failed");

        journal = { ...journal, status: "installed" };
        writeJournal(journalPath, journal, options.nonce);
        invokeStep(options, "journal-installed");
        return { status: "repaired", target };
    } catch (error) {
        return {
            status: "refused",
            target,
            reason: error instanceof PersistenceError ? error.reason : "repair-failed"
        };
    } finally {
        if (lease != null) releaseLock(lease);
    }
}
