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

"use strict";

const { constants, createHash, createPublicKey, randomUUID, verify } = require("crypto");
const { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } = require("fs");
const { join } = require("path");

const MANIFEST_NAME = "disorder-manifest.json";
const SIGNATURE_NAME = "disorder-manifest.sig";
const STATE_NAME = "release-state.json";
const RELEASE_ID = /^r[1-9][0-9]{0,15}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UPDATE_PUBLIC_KEY = Object.freeze({
    kty: "RSA",
    n: "__DISORDER_UPDATE_RSA_MODULUS__",
    e: "__DISORDER_UPDATE_RSA_EXPONENT__",
    alg: "RS256",
    use: "sig"
});
const RUNTIME_FILES = Object.freeze([
    "LICENSE",
    "fflate.LICENSE",
    "matrix-js-sdk.LICENSE",
    "matrixBridgePreload.js",
    "matrixBridgeWorker.js",
    "matrixBridgeWorker.js.LEGAL.txt",
    "matrixSecureView.css",
    "matrixSecureView.js",
    "matrixSecureViewPreload.js",
    "matrix_sdk_crypto_wasm.LICENSE",
    "matrix_sdk_crypto_wasm_bg.wasm",
    "package.json",
    "patcher.js",
    "patcher.js.LEGAL.txt",
    "preload.js",
    "renderer.css",
    "renderer.js",
    "renderer.js.LEGAL.txt",
]);
const RELEASE_FILES = new Set([MANIFEST_NAME, SIGNATURE_NAME, ...RUNTIME_FILES]);
const DIST_DIR = __dirname;
const RELEASES_DIR = join(DIST_DIR, "releases");
const STATE_PATH = join(DIST_DIR, STATE_NAME);
const INSTALL_LOCK_PATH = join(DIST_DIR, "..", "disorder-install.lock");
const INSTALL_LOCK_MAX_BYTES = 256;
const INSTALL_LOCK_RETRY_MS = 50;
const INSTALL_LOCK_TIMEOUT_MS = 2_000;
const INSTALL_LOCK_INVALID_STALE_MS = 30_000;

function fail(code) {
    const error = new Error(`Disorder release bootstrap refused to load (${code}).`);
    error.code = `DISORDER_BOOTSTRAP_${code}`;
    throw error;
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value).sort();
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => allowed.has(key))
        && keys.length >= required.length;
}

function readBoundedFile(path, maximum, code) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
        fail(code);
    const bytes = readFileSync(path);
    if (bytes.length !== stat.size) fail(code);
    return bytes;
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function decodeBase64Url(value, code) {
    if (typeof value !== "string" || !BASE64URL.test(value)) fail(code);
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const bytes = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) fail(code);
    return bytes;
}

function parseInstallLockOwner(contents) {
    if (!Buffer.isBuffer(contents) || contents.length === 0 || contents.length > INSTALL_LOCK_MAX_BYTES)
        return undefined;
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
    } catch {
        return undefined;
    }
    if (!isRecord(value)
        || Object.keys(value).sort().join("\0") !== "createdAt\0nonce\0pid\0schema"
        || value.schema !== 1
        || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffff_ffff
        || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) {
        return undefined;
    }
    return value;
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== "ESRCH";
    }
}

function sameFile(left, right) {
    return left.isFile() && right.isFile() && !right.isSymbolicLink()
        && left.dev === right.dev && left.ino === right.ino;
}

function recoverStaleInstallLock() {
    try {
        const entry = lstatSync(INSTALL_LOCK_PATH);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > INSTALL_LOCK_MAX_BYTES)
            return false;
        const contents = readFileSync(INSTALL_LOCK_PATH);
        if (contents.length !== entry.size) return false;
        const owner = parseInstallLockOwner(contents);
        if (owner !== undefined
            ? processIsAlive(owner.pid)
            : Date.now() - entry.mtimeMs < INSTALL_LOCK_INVALID_STALE_MS) {
            return false;
        }

        const confirmedEntry = lstatSync(INSTALL_LOCK_PATH);
        const confirmedContents = readFileSync(INSTALL_LOCK_PATH);
        if (!sameFile(entry, confirmedEntry) || !confirmedContents.equals(contents)) return false;
        unlinkSync(INSTALL_LOCK_PATH);
        return true;
    } catch (error) {
        return error?.code === "ENOENT";
    }
}

function sleepSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireInstallLock() {
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.pid > 0xffff_ffff)
        fail("INSTALL_LOCK");
    const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
    while (true) {
        let handle;
        try {
            handle = openSync(INSTALL_LOCK_PATH, "wx", 0o600);
        } catch (error) {
            if (!["EACCES", "EEXIST", "EPERM"].includes(error?.code)) fail("INSTALL_LOCK");
            if (recoverStaleInstallLock()) continue;
            if (Date.now() >= deadline) fail("INSTALL_BUSY");
            sleepSync(INSTALL_LOCK_RETRY_MS);
            continue;
        }

        const owner = {
            schema: 1,
            pid: process.pid,
            nonce: randomUUID().replaceAll("-", ""),
            createdAt: Date.now()
        };
        const contents = Buffer.from(JSON.stringify(owner), "utf8");
        let handleInfo;
        try {
            handleInfo = fstatSync(handle);
            if (!Number.isSafeInteger(owner.createdAt) || owner.createdAt < 1
                || contents.length > INSTALL_LOCK_MAX_BYTES) fail("INSTALL_LOCK");
            writeFileSync(handle, contents);
            fsyncSync(handle);
            const pathInfo = lstatSync(INSTALL_LOCK_PATH);
            if (!sameFile(handleInfo, pathInfo)) fail("INSTALL_LOCK");
            return { contents, device: handleInfo.dev, handle, inode: handleInfo.ino };
        } catch (error) {
            try {
                closeSync(handle);
            } catch { }
            try {
                const entry = lstatSync(INSTALL_LOCK_PATH);
                if (handleInfo !== undefined && sameFile(handleInfo, entry)) unlinkSync(INSTALL_LOCK_PATH);
            } catch { }
            if (error?.code?.startsWith?.("DISORDER_BOOTSTRAP_")) throw error;
            fail("INSTALL_LOCK");
        }
    }
}

function releaseInstallLock(lease) {
    try {
        closeSync(lease.handle);
    } catch {
        return;
    }
    try {
        const entry = lstatSync(INSTALL_LOCK_PATH);
        const contents = readFileSync(INSTALL_LOCK_PATH);
        if (entry.isFile() && !entry.isSymbolicLink()
            && entry.dev === lease.device && entry.ino === lease.inode
            && contents.equals(lease.contents)) {
            unlinkSync(INSTALL_LOCK_PATH);
        }
    } catch {
        // A crashed process leaves a recoverable owner record. Cleanup must not
        // replace the result of a completed state transaction.
    }
}

function validatePublicKey() {
    const modulus = decodeBase64Url(UPDATE_PUBLIC_KEY.n, "PUBLIC_KEY");
    decodeBase64Url(UPDATE_PUBLIC_KEY.e, "PUBLIC_KEY");
    if (UPDATE_PUBLIC_KEY.e !== "AQAB" || modulus.length < 384 || modulus.length > 512) fail("PUBLIC_KEY");
    const modulusBits = (modulus.length - 1) * 8 + 32 - Math.clz32(modulus[0]);
    if (modulusBits < 3072) fail("PUBLIC_KEY");
    try {
        return createPublicKey({ key: UPDATE_PUBLIC_KEY, format: "jwk" });
    } catch {
        fail("PUBLIC_KEY");
    }
}

function validateIdentity(identity, code) {
    if (!hasExactKeys(identity, ["id", "sequence", "commit", "manifestSha256"])) fail(code);
    if (!Number.isSafeInteger(identity.sequence) || identity.sequence < 1) fail(code);
    if (typeof identity.id !== "string" || !RELEASE_ID.test(identity.id)) fail(code);
    if (typeof identity.commit !== "string" || !COMMIT.test(identity.commit)) fail(code);
    if (typeof identity.manifestSha256 !== "string" || !SHA256.test(identity.manifestSha256)) fail(code);
    if (identity.id !== `r${identity.sequence}-${identity.commit.slice(0, 12)}`) fail(code);
    return identity;
}

function readState() {
    const bytes = readBoundedFile(STATE_PATH, 16 * 1024, "STATE");
    let state;
    try {
        state = JSON.parse(bytes.toString("utf8"));
    } catch {
        fail("STATE");
    }
    if (!hasExactKeys(state, [
        "schema",
        "current",
        "highestSeenSequence",
        "highestSeenManifestSha256",
        "pendingBoot",
        "bootAttempts"
    ], ["previous", "failed"])) fail("STATE");
    if (state.schema !== 1 || typeof state.pendingBoot !== "boolean") fail("STATE");
    if (!Number.isInteger(state.bootAttempts) || state.bootAttempts < 0 || state.bootAttempts > 2) fail("STATE");
    if (!state.pendingBoot && state.bootAttempts !== 0) fail("STATE");
    if (!Number.isSafeInteger(state.highestSeenSequence) || state.highestSeenSequence < 1) fail("STATE");
    if (typeof state.highestSeenManifestSha256 !== "string" || !SHA256.test(state.highestSeenManifestSha256)) fail("STATE");
    validateIdentity(state.current, "STATE");
    if (state.previous !== undefined) validateIdentity(state.previous, "STATE");
    if (state.failed !== undefined) validateIdentity(state.failed, "STATE");
    const pointers = [state.current, state.previous, state.failed].filter(Boolean);
    if (new Set(pointers.map(identity => identity.id)).size !== pointers.length
        || new Set(pointers.map(identity => identity.sequence)).size !== pointers.length)
        fail("STATE");
    if (state.previous !== undefined && state.previous.sequence >= state.current.sequence) fail("STATE");
    for (const identity of pointers) {
        if (identity === undefined) continue;
        if (identity.sequence > state.highestSeenSequence) fail("STATE");
        if (identity.sequence === state.highestSeenSequence
            && identity.manifestSha256 !== state.highestSeenManifestSha256)
            fail("STATE");
    }
    return state;
}

function validateManifest(manifest, identity) {
    if (!hasExactKeys(manifest, [
        "schema", "product", "channel", "sequence", "version", "commit", "publishedAt", "bundle", "files", "changes"
    ])) fail("MANIFEST");
    if (manifest.schema !== 1 || manifest.product !== "disorder-vencord" || manifest.channel !== "stable") fail("MANIFEST");
    if (manifest.sequence !== identity.sequence || manifest.commit !== identity.commit)
        fail("MANIFEST_IDENTITY");
    if (typeof manifest.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.version))
        fail("MANIFEST");
    if (typeof manifest.publishedAt !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.publishedAt)
        || new Date(manifest.publishedAt).toISOString() !== manifest.publishedAt)
        fail("MANIFEST");
    if (!hasExactKeys(manifest.bundle, ["name", "size", "sha256"])
        || manifest.bundle.name !== "disorder-runtime.zip"
        || !Number.isSafeInteger(manifest.bundle.size) || manifest.bundle.size < 1 || manifest.bundle.size > 64 * 1024 * 1024
        || typeof manifest.bundle.sha256 !== "string" || !SHA256.test(manifest.bundle.sha256))
        fail("MANIFEST");
    if (!Array.isArray(manifest.changes) || manifest.changes.length !== 0) fail("MANIFEST_PRIVACY");
    if (!Array.isArray(manifest.files) || manifest.files.length !== RUNTIME_FILES.length) fail("MANIFEST_FILES");
    let totalSize = 0;
    for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index];
        if (!hasExactKeys(file, ["path", "size", "sha256"]) || file.path !== RUNTIME_FILES[index]) fail("MANIFEST_FILES");
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) fail("MANIFEST_FILES");
        if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) fail("MANIFEST_FILES");
        totalSize += file.size;
    }
    if (!Number.isSafeInteger(totalSize) || totalSize > 64 * 1024 * 1024) fail("MANIFEST_FILES");
}

function verifyRelease(identity, publicKey) {
    const releaseDir = join(RELEASES_DIR, identity.id);
    const dirStat = lstatSync(releaseDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("RELEASE_DIR");
    const entries = readdirSync(releaseDir, { withFileTypes: true });
    if (entries.length !== RELEASE_FILES.size) fail("RELEASE_FILES");
    const names = new Set();
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !RELEASE_FILES.has(entry.name) || names.has(entry.name))
            fail("RELEASE_FILES");
        names.add(entry.name);
    }
    if (names.size !== RELEASE_FILES.size) fail("RELEASE_FILES");

    const manifestBytes = readBoundedFile(join(releaseDir, MANIFEST_NAME), 128 * 1024, "MANIFEST");
    if (sha256(manifestBytes) !== identity.manifestSha256) fail("MANIFEST_IDENTITY");
    const signatureFile = readBoundedFile(join(releaseDir, SIGNATURE_NAME), 2048, "SIGNATURE");
    if (signatureFile.some(byte => byte > 0x7f)) fail("SIGNATURE");
    const signatureText = signatureFile.toString("ascii");
    if (!BASE64.test(signatureText)) fail("SIGNATURE");
    const signature = Buffer.from(signatureText, "base64");
    if (signature.length < 384 || signature.length > 512 || signature.toString("base64") !== signatureText)
        fail("SIGNATURE");
    if (!verify("RSA-SHA256", manifestBytes, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature))
        fail("SIGNATURE");

    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
        fail("MANIFEST");
    }
    validateManifest(manifest, identity);
    const files = new Map(manifest.files.map(file => [file.path, file]));
    for (const path of RUNTIME_FILES) {
        const expected = files.get(path);
        const bytes = readBoundedFile(join(releaseDir, path), 16 * 1024 * 1024, "PAYLOAD");
        if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) fail("PAYLOAD");
    }
    return join(releaseDir, "patcher.js");
}

function writeState(state) {
    const temporary = join(DIST_DIR, `.release-state-${process.pid}-${Date.now()}.tmp`);
    try {
        writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        renameSync(temporary, STATE_PATH);
    } finally {
        try {
            unlinkSync(temporary);
        } catch { }
    }
}

function selectRelease() {
    const publicKey = validatePublicKey();
    const state = readState();
    const rollback = () => {
        if (state.previous === undefined) fail("ROLLBACK_UNAVAILABLE");
        const patcherPath = verifyRelease(state.previous, publicKey);
        writeState({
            schema: 1,
            current: state.previous,
            failed: state.current,
            highestSeenSequence: state.highestSeenSequence,
            highestSeenManifestSha256: state.highestSeenManifestSha256,
            pendingBoot: false,
            bootAttempts: 0
        });
        return { identity: state.previous, patcherPath };
    };
    if (state.pendingBoot && state.bootAttempts >= 2) {
        return rollback();
    }

    let patcherPath;
    try {
        patcherPath = verifyRelease(state.current, publicKey);
    } catch (error) {
        if (!state.pendingBoot) throw error;
        return rollback();
    }
    if (state.pendingBoot) {
        writeState({ ...state, bootAttempts: state.bootAttempts + 1 });
    }
    return { identity: state.current, patcherPath };
}

const installLock = acquireInstallLock();

try {
    let selected;
    try {
        selected = selectRelease();
    } catch (error) {
        if (error?.code?.startsWith?.("DISORDER_BOOTSTRAP_")) throw error;
        fail("INVALID_STATE");
    }

    process.env.VENCORD_RELEASE_ROOT = DIST_DIR;
    process.env.VENCORD_RELEASE_ID = selected.identity.id;
    process.env.VENCORD_RELEASE_SEQUENCE = String(selected.identity.sequence);
    module.exports = require(selected.patcherPath);
} finally {
    releaseInstallLock(installLock);
}
