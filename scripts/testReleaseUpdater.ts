/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { zipSync } from "fflate";

import { extractReleaseBundle } from "../src/main/updater/releaseBundle";
import {
    activateRelease,
    isInstalledRelease,
    markCurrentReleaseHealthy,
    observeReleasePointer,
    readReleaseState,
    stageRelease,
    verifyReleaseDirectory,
    writeReleaseState
} from "../src/main/updater/releaseState";
import { sha256Hex, verifyReleaseSignatureWithKey } from "../src/main/updater/releaseTrust";
import {
    parseReleaseManifest,
    parseReleaseState,
    releasePointer,
    RELEASE_RUNTIME_FILES,
    ReleaseValidationError
} from "../src/main/updater/releaseTypes";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicJwk = publicKey.export({ format: "jwk" });
assert.equal(typeof publicJwk.n, "string");
assert.equal(publicJwk.e, "AQAB");
Reflect.set(globalThis, "UPDATE_RSA_MODULUS", publicJwk.n);
Reflect.set(globalThis, "UPDATE_RSA_EXPONENT", publicJwk.e);

function signedRelease(sequence: number, commitCharacter: string) {
    const files = RELEASE_RUNTIME_FILES.map(path => {
        const contents = Buffer.from(
            path === "patcher.js" ? `if(process.env.DISORDER_TEST_DATA_DIR_OUTPUT)require("fs").writeFileSync(process.env.DISORDER_TEST_DATA_DIR_OUTPUT,process.env.VENCORD_USER_DATA_DIR??"");module.exports = ${sequence};\n`
                : path === "package.json" ? "{\"type\":\"commonjs\"}\n"
                    : `release-${sequence}:${path}`,
            "utf8"
        );
        return { path, contents, size: contents.byteLength, sha256: sha256Hex(contents) };
    });
    const zipEntries = Object.fromEntries(files.map(file => [file.path, new Uint8Array(file.contents)]));
    const bundle = Buffer.from(zipSync(zipEntries, { level: 6 }));
    const manifestValue = {
        schema: 1,
        product: "disorder-vencord",
        channel: "stable",
        sequence,
        version: `test-r${sequence}`,
        commit: commitCharacter.repeat(40),
        publishedAt: "2026-08-09T00:00:00.000Z",
        bundle: {
            name: "disorder-runtime.zip",
            size: bundle.byteLength,
            sha256: sha256Hex(bundle)
        },
        files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        changes: []
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`, "utf8");
    const signatureBytes = Buffer.from(sign("RSA-SHA256", manifestBytes, privateKey).toString("base64"), "ascii");
    const manifest = parseReleaseManifest(manifestBytes);
    const pointer = releasePointer(manifest, sha256Hex(manifestBytes));
    return { bundle, manifest, manifestBytes, pointer, signatureBytes };
}

const first = signedRelease(1, "1");
const second = signedRelease(2, "2");
const third = signedRelease(3, "3");
verifyReleaseSignatureWithKey(first.manifestBytes, first.signatureBytes, publicJwk.n!, publicJwk.e!);
assert.throws(
    () => verifyReleaseSignatureWithKey(
        Buffer.concat([first.manifestBytes, Buffer.from(" ")]),
        first.signatureBytes,
        publicJwk.n!,
        publicJwk.e!
    ),
    ReleaseValidationError
);
assert.throws(
    () => verifyReleaseSignatureWithKey(
        first.manifestBytes,
        Buffer.concat([first.signatureBytes, Buffer.from("\n")]),
        publicJwk.n!,
        publicJwk.e!
    ),
    ReleaseValidationError
);

const extracted = extractReleaseBundle(first.bundle, first.manifest);
assert.deepEqual([...extracted.keys()], [...RELEASE_RUNTIME_FILES]);
const extraBundle = Buffer.from(zipSync({
    ...Object.fromEntries([...extracted].map(([path, bytes]) => [path, new Uint8Array(bytes)])),
    "unexpected.js": new Uint8Array([1])
}));
const extraManifest = parseReleaseManifest(Buffer.from(JSON.stringify({
    ...first.manifest,
    bundle: {
        name: "disorder-runtime.zip",
        size: extraBundle.byteLength,
        sha256: sha256Hex(extraBundle)
    }
})));
assert.throws(() => extractReleaseBundle(extraBundle, extraManifest), ReleaseValidationError);

assert.throws(() => parseReleaseState({
    schema: 1,
    current: first.pointer,
    previous: second.pointer,
    highestSeenSequence: second.pointer.sequence,
    highestSeenManifestSha256: second.pointer.manifestSha256,
    pendingBoot: false,
    bootAttempts: 0
}), ReleaseValidationError);

async function testWindowsInstallLock(base: string, whileInstallerLocked: () => Promise<unknown>) {
    if (process.platform !== "win32") return;

    const lockPath = join(base, "disorder-install.lock");
    const environment = { ...process.env, DISORDER_LOCK_TEST_PATH: lockPath };
    const holdCommand = [
        "$ErrorActionPreference='Stop'",
        "$lock=[IO.File]::Open($env:DISORDER_LOCK_TEST_PATH,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
        "try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$lock.Dispose();Remove-Item -LiteralPath $env:DISORDER_LOCK_TEST_PATH -Force -ErrorAction SilentlyContinue}"
    ].join(";");
    const holder = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", holdCommand], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("PowerShell lock fixture did not become ready.")), 10_000);
            holder.once("error", reject);
            holder.once("exit", code => reject(new Error(`PowerShell lock fixture exited early (${code}).`)));
            holder.stdout.once("data", chunk => {
                clearTimeout(timeout);
                if (chunk.toString("ascii").trim() !== "LOCKED")
                    reject(new Error("PowerShell lock fixture returned an unexpected response."));
                else resolve();
            });
        });
        await assert.rejects(whileInstallerLocked, ReleaseValidationError);
    } finally {
        holder.stdin.end("\n");
        if (holder.exitCode == null) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    holder.kill();
                    reject(new Error("PowerShell lock fixture did not exit."));
                }, 10_000);
                holder.once("exit", code => {
                    clearTimeout(timeout);
                    if (code === 0) resolve();
                    else reject(new Error(`PowerShell lock fixture failed (${code}).`));
                });
            });
        } else {
            assert.equal(holder.exitCode, 0);
        }
    }

    const nodeHolderScript = [
        "const fs=require('fs'),crypto=require('crypto')",
        "const path=process.env.DISORDER_LOCK_TEST_PATH",
        "const handle=fs.openSync(path,'wx',0o600)",
        "const owner=JSON.stringify({schema:1,pid:process.pid,nonce:crypto.randomBytes(16).toString('hex'),createdAt:Date.now()})",
        "fs.writeFileSync(handle,owner);fs.fsyncSync(handle);console.log('LOCKED')",
        "process.stdin.once('data',()=>{fs.closeSync(handle);try{fs.unlinkSync(path)}catch{};process.exit(0)});process.stdin.resume()"
    ].join(";");
    const nodeHolder = spawn(process.execPath, ["-e", nodeHolderScript], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Node lock fixture did not become ready.")), 10_000);
            nodeHolder.once("error", reject);
            nodeHolder.once("exit", code => reject(new Error(`Node lock fixture exited early (${code}).`)));
            nodeHolder.stdout.once("data", chunk => {
                clearTimeout(timeout);
                if (chunk.toString("ascii").trim() !== "LOCKED")
                    reject(new Error("Node lock fixture returned an unexpected response."));
                else resolve();
            });
        });
        await assert.rejects(whileInstallerLocked, ReleaseValidationError);
        const exclusiveCommand = [
            "$ErrorActionPreference='Stop'",
            "try{$lock=[IO.File]::Open($env:DISORDER_LOCK_TEST_PATH,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$lock.Dispose();exit 0}catch{exit 3}"
        ].join(";");
        const blocked = spawnSync(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", exclusiveCommand],
            { env: environment, timeout: 10_000, windowsHide: true }
        );
        assert.equal(blocked.status, 3, "Node lock handle must exclude the PowerShell installer");
    } finally {
        nodeHolder.stdin.end("\n");
        if (nodeHolder.exitCode == null) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    nodeHolder.kill();
                    reject(new Error("Node lock fixture did not exit."));
                }, 10_000);
                nodeHolder.once("exit", code => {
                    clearTimeout(timeout);
                    if (code === 0) resolve();
                    else reject(new Error(`Node lock fixture failed (${code}).`));
                });
            });
        } else {
            assert.equal(nodeHolder.exitCode, 0);
        }
    }

    const deadOwner = spawnSync(
        process.execPath,
        ["-e", [
            "const fs=require('fs'),crypto=require('crypto')",
            "const path=process.env.DISORDER_LOCK_TEST_PATH",
            "const handle=fs.openSync(path,'wx',0o600)",
            "fs.writeFileSync(handle,JSON.stringify({schema:1,pid:process.pid,nonce:crypto.randomBytes(16).toString('hex'),createdAt:Date.now()}))",
            "fs.fsyncSync(handle);fs.closeSync(handle)"
        ].join(";")],
        { env: environment, timeout: 10_000, windowsHide: true }
    );
    assert.equal(deadOwner.status, 0, "the dead-owner fixture must create a valid stale lease");
    await whileInstallerLocked();
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
}

async function testStablePatcherRollback(releaseRoot: string) {
    let source = await readFile(join(process.cwd(), "scripts/release/stablePatcher.cjs"), "utf8");
    source = source
        .replace("__DISORDER_UPDATE_RSA_MODULUS__", publicJwk.n!)
        .replace("__DISORDER_UPDATE_RSA_EXPONENT__", publicJwk.e!);
    assert.ok(!source.includes("__DISORDER_"));
    const stablePatcher = join(releaseRoot, "stablePatcher.cjs");
    const dataDirOutput = join(releaseRoot, "stable-data-dir.txt");
    await writeFile(stablePatcher, source, { encoding: "utf8", flag: "wx" });

    for (let attempt = 0; attempt < 3; attempt++) {
        const launched = spawnSync(process.execPath, [stablePatcher], {
            encoding: "utf8",
            env: { ...process.env, DISORDER_TEST_DATA_DIR_OUTPUT: dataDirOutput },
            timeout: 20_000,
            windowsHide: true
        });
        assert.equal(launched.status, 0, `stable patcher boot ${attempt + 1} must complete`);
    }
    assert.equal(
        await realpath(await readFile(dataDirOutput, "utf8")),
        await realpath(join(releaseRoot, ".."))
    );

    const state = await readReleaseState(releaseRoot);
    assert.equal(state.current.id, second.pointer.id);
    assert.equal(state.previous, undefined);
    assert.equal(state.failed?.id, third.pointer.id);
    assert.equal(state.highestSeenSequence, third.pointer.sequence);
    assert.equal(state.highestSeenManifestSha256, third.pointer.manifestSha256);
    assert.equal(state.pendingBoot, false);
    assert.equal(state.bootAttempts, 0);

    const signaturePath = join(releaseRoot, "releases", second.pointer.id, "disorder-manifest.sig");
    const signature = await readFile(signaturePath);
    const nonAsciiSignature = Buffer.from(signature);
    nonAsciiSignature[0] |= 0x80;
    try {
        await writeFile(signaturePath, nonAsciiSignature);
        const refused = spawnSync(process.execPath, [stablePatcher], {
            encoding: "utf8",
            timeout: 20_000,
            windowsHide: true
        });
        assert.notEqual(refused.status, 0, "stable patcher must reject non-ASCII signature bytes");
    } finally {
        await writeFile(signaturePath, signature);
    }
}

async function main() {
    const temporaryBase = await mkdtemp(join(tmpdir(), "disorder-release-test-"));
    assert.ok(temporaryBase.startsWith(`${tmpdir()}${sep}`));
    const temporaryRoot = join(temporaryBase, "dist");
    await mkdir(temporaryRoot);
    try {
        await writeReleaseState(temporaryRoot, {
        schema: 1,
        current: first.pointer,
        highestSeenSequence: first.pointer.sequence,
        highestSeenManifestSha256: first.pointer.manifestSha256,
        pendingBoot: false,
        bootAttempts: 0
    });
        await testWindowsInstallLock(
            temporaryBase,
            () => observeReleasePointer(temporaryRoot, first.pointer)
        );
        await stageRelease(temporaryRoot, first.manifestBytes, first.signatureBytes, first.bundle);
        await verifyReleaseDirectory(temporaryRoot, first.pointer);

        await stageRelease(temporaryRoot, second.manifestBytes, second.signatureBytes, second.bundle);
        await activateRelease(temporaryRoot, second.pointer);
        let state = await readReleaseState(temporaryRoot);
        assert.equal(state.current.id, second.pointer.id);
        assert.equal(state.previous?.id, first.pointer.id);
        assert.equal(state.pendingBoot, true);

        process.env.VENCORD_RELEASE_ROOT = temporaryRoot;
        process.env.VENCORD_RELEASE_ID = second.pointer.id;
        process.env.VENCORD_RELEASE_SEQUENCE = String(second.pointer.sequence);
        assert.equal(await markCurrentReleaseHealthy(), true);
        state = await readReleaseState(temporaryRoot);
        assert.equal(state.pendingBoot, false);
        assert.equal(state.highestSeenSequence, 2);

        await stageRelease(temporaryRoot, third.manifestBytes, third.signatureBytes, third.bundle);
        await activateRelease(temporaryRoot, third.pointer);
        await testStablePatcherRollback(temporaryRoot);
        state = await readReleaseState(temporaryRoot);
        assert.equal(isInstalledRelease(state, third.pointer), true);

        await assert.rejects(observeReleasePointer(temporaryRoot, first.pointer), ReleaseValidationError);
        const equivocation = signedRelease(3, "4");
        await assert.rejects(observeReleasePointer(temporaryRoot, equivocation.pointer), ReleaseValidationError);
    } finally {
        delete process.env.VENCORD_RELEASE_ROOT;
        delete process.env.VENCORD_RELEASE_ID;
        delete process.env.VENCORD_RELEASE_SEQUENCE;
        await rm(temporaryBase, { recursive: true, force: true });
    }

    console.log("Release updater signature, archive, lock, staging, health, and rollback fixtures passed.");
}

void main();
