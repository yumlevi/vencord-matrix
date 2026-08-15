/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
    compareDiscordVersions,
    createCanonicalDiscordLoaderAsar,
    discordResourceObservationIsQuiescent,
    discordResourceObservationsEqual,
    discoverWindowsUpdateResources,
    extractCanonicalPatcherPath,
    observeDiscordResourceCandidate,
    parseDiscordVersionDirectory,
    repairDiscordResources,
    type RepairStep,
    resourcesDirectoryFromInjectorPath,
    resolveTrustedPatcherPath
} from "../src/main/discordUpdatePersistence";

const STOCK_ASAR = Buffer.alloc(64 * 1024, 0x41);
const OTHER_ASAR = Buffer.from("unrelated-existing-app-asar\n", "utf8");
const NONCE = "0123456789abcdef0123456789abcdef";

function sha256(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
}

function ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true });
    return path;
}

function ensureParent(path: string) {
    ensureDirectory(resolve(path, ".."));
    return path;
}

function write(path: string, contents: Uint8Array | string) {
    writeFileSync(ensureParent(path), contents, { flag: "wx" });
    return path;
}

function snapshotRegularFiles(root: string) {
    const snapshot = new Map<string, { bytes: Buffer; mode: number; mtimeMs: number; }>();

    function visit(directory: string) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const info = lstatSync(path);
            assert.equal(info.isSymbolicLink(), false, "settings fixtures must not contain links");
            if (info.isDirectory()) {
                visit(path);
            } else {
                assert.equal(info.isFile(), true);
                snapshot.set(relative(root, path), {
                    bytes: readFileSync(path),
                    mode: info.mode,
                    mtimeMs: info.mtimeMs
                });
            }
        }
    }

    visit(root);
    return snapshot;
}

function makeSettingsSentinels(base: string) {
    write(join(base, "settings", "settings.json"), JSON.stringify({
        plugins: { MatrixBridge: { enabled: true } }
    }));
    write(join(base, "settings", "native-settings.json"), JSON.stringify({ plugins: {} }));
    write(join(base, "settings", "quickCss.css"), ".sentinel { color: red; }\n");
    write(join(base, "themes", "sentinel.css"), "/* keep */\n");
    write(join(base, "matrixBridge", "account.enc"), Buffer.from([0, 1, 2, 3, 4, 5]));
    write(join(base, "matrixBridge", "space-child-creates.enc"), Buffer.from([6, 7, 8]));
    write(join(base, "matrixBridge", "group-chat-creates.enc"), Buffer.from([9, 10, 11]));
    return snapshotRegularFiles(base);
}

interface RepairFixture {
    dataRoot: string;
    loader: Buffer;
    patcherPath: string;
    resources: string;
}

function makeRepairFixture(root: string, name: string): RepairFixture {
    const dataRoot = ensureDirectory(join(root, `${name}-data`, "Vencord"));
    const patcherPath = write(join(dataRoot, "dist", "patcher.js"), "module.exports = 'fixture';\n");
    const resources = ensureDirectory(join(root, name, "resources"));
    write(join(resources, "app.asar"), STOCK_ASAR);
    return {
        dataRoot,
        loader: createCanonicalDiscordLoaderAsar(patcherPath),
        patcherPath,
        resources
    };
}

function stableObservation(resources: string) {
    const first = observeDiscordResourceCandidate(resources);
    const second = observeDiscordResourceCandidate(resources);
    assert.ok(first, "the first stock observation must succeed");
    assert.ok(second, "the confirming stock observation must succeed");
    assert.equal(discordResourceObservationsEqual(first, second), true);
    return second;
}

function repairFresh(resources: string, loader: Uint8Array, onStep?: (step: RepairStep) => void) {
    return repairDiscordResources(resources, loader, {
        expectedObservation: stableObservation(resources),
        nonce: () => NONCE,
        onStep
    });
}

function repairRecovery(resources: string, loader: Uint8Array, onStep?: (step: RepairStep) => void) {
    return repairDiscordResources(resources, loader, {
        nonce: () => NONCE,
        onStep
    });
}

function assertRepaired(resources: string, loader: Uint8Array, original = STOCK_ASAR) {
    assert.deepEqual(readFileSync(join(resources, "app.asar")), Buffer.from(loader));
    assert.deepEqual(readFileSync(join(resources, "_app.asar")), original);
    assert.deepEqual(readdirSync(resources).sort(), [
        ".disorder-host-repair.json",
        "_app.asar",
        "app.asar"
    ]);
    const journal = JSON.parse(readFileSync(join(resources, ".disorder-host-repair.json"), "utf8"));
    assert.equal(journal.status, "installed");
    assert.equal(journal.resourcesPath, resolve(resources));
    assert.equal(journal.originalSize, original.byteLength);
    assert.equal(journal.originalSha256, sha256(original));
    assert.equal(journal.loaderSize, loader.byteLength);
    assert.equal(journal.loaderSha256, sha256(loader));
}

function testCanonicalLoaderGolden() {
    const patcherPath = process.platform === "win32"
        ? "C:\\Users\\Test User<&>\u2028\\Vencord\\dist\\patcher.js"
        : "/fixtures/Test User<&>\u2028/Vencord/dist/patcher.js";
    const loader = createCanonicalDiscordLoaderAsar(patcherPath);

    assert.equal(loader.length, process.platform === "win32" ? 229 : 225);
    assert.equal(
        sha256(loader),
        process.platform === "win32"
            ? "97da7a93e217c12fa640afc10ac2e5a60621c6d3ffe0e5d69c8b905b9f879e1a"
            : "dafc7d184b9011c193d4918265004e67b6e644bfcb7097b9aa0e799e5f7be36b"
    );
    assert.equal(extractCanonicalPatcherPath(loader), patcherPath);

    const corrupted = Buffer.from(loader);
    corrupted[16] ^= 1;
    assert.equal(extractCanonicalPatcherPath(corrupted), undefined);
}

function testStrictVersions() {
    assert.deepEqual(parseDiscordVersionDirectory("app-1.0.9253"), [1, 0, 9253]);
    assert.ok(compareDiscordVersions([1, 0, 9253], [1, 0, 9252]) > 0);
    assert.equal(compareDiscordVersions([1, 0, 9253], [1, 0, 9253]), 0);
    assert.throws(() => compareDiscordVersions([1, 0, 9253, 1], [1, 0, 9253]), /invalid-version/u);

    for (const invalid of [
        "app-01.0.9253",
        "app-1.00.9253",
        "app-1.0",
        "app-1.0.9253.1",
        "app-1.0.9253.",
        "app-1..9253",
        "app-1.0.-1",
        "app-1.0.9253-old",
        "app-1e0.0.9253",
        "app-1.0.9007199254740992",
        "app-\uff11.0.9253",
        "APP-1.0.9253",
        "app-1.0.9253/resources"
    ]) {
        assert.equal(parseDiscordVersionDirectory(invalid), undefined, `${invalid} must be rejected`);
    }
}

function testStagedWindowsRepair(root: string) {
    const discordRoot = ensureDirectory(join(root, "windows-staged", "Discord"));
    const dataRoot = ensureDirectory(join(root, "windows-staged", "Vencord"));
    const patcherPath = write(join(dataRoot, "dist", "patcher.js"), "module.exports = 'stable';\n");
    const loader = createCanonicalDiscordLoaderAsar(patcherPath);
    const currentResources = ensureDirectory(join(discordRoot, "app-1.0.9252", "resources"));
    const stagedResources = ensureDirectory(join(discordRoot, "app-1.0.9253", "resources"));
    const olderResources = ensureDirectory(join(discordRoot, "app-1.0.9251", "resources"));
    const currentExecutable = write(join(discordRoot, "app-1.0.9252", "Discord.exe"), "fixture");

    write(join(discordRoot, "app-1.0.9253", "Discord.exe"), "fixture");
    write(join(discordRoot, "app-1.0.9251", "Discord.exe"), "fixture");
    write(join(currentResources, "app.asar"), loader);
    write(join(currentResources, "_app.asar"), Buffer.from("current-stock"));
    write(join(stagedResources, "app.asar"), STOCK_ASAR);
    write(join(olderResources, "app.asar"), OTHER_ASAR);

    assert.equal(
        resourcesDirectoryFromInjectorPath(join(currentResources, "app.asar", "index.js")),
        currentResources
    );
    assert.equal(
        resolveTrustedPatcherPath(currentResources, { VENCORD_USER_DATA_DIR: dataRoot }),
        patcherPath
    );
    assert.deepEqual(discoverWindowsUpdateResources(currentExecutable), [stagedResources]);

    const beforeCurrent = snapshotRegularFiles(currentResources);
    const beforeOlder = snapshotRegularFiles(olderResources);
    const repairSteps: RepairStep[] = [];
    const stagedRepair = repairFresh(stagedResources, loader, step => repairSteps.push(step));
    assert.equal(
        stagedRepair.status,
        "repaired",
        `${stagedRepair.reason}: ${repairSteps.join(", ")}; ${readdirSync(stagedResources).join(", ")}`
    );
    assertRepaired(stagedResources, loader);
    assert.deepEqual(snapshotRegularFiles(currentResources), beforeCurrent);
    assert.deepEqual(snapshotRegularFiles(olderResources), beforeOlder);

    assert.equal(repairRecovery(stagedResources, loader).status, "unchanged");
    assertRepaired(stagedResources, loader);
}

function testAmbiguousStatesRefuse(root: string) {
    const backup = makeRepairFixture(root, "ambiguous-backup");
    write(join(backup.resources, "_app.asar"), OTHER_ASAR);
    const backupBefore = snapshotRegularFiles(backup.resources);
    const backupResult = repairFresh(backup.resources, backup.loader);
    assert.equal(backupResult.status, "refused");
    assert.equal(backupResult.reason, "ambiguous-existing-backup");
    assert.deepEqual(snapshotRegularFiles(backup.resources), backupBefore);

    const unpacked = makeRepairFixture(root, "ambiguous-unpacked");
    ensureDirectory(join(unpacked.resources, "app"));
    write(join(unpacked.resources, "app", "index.js"), "module.exports = {};\n");
    const unpackedApp = readFileSync(join(unpacked.resources, "app.asar"));
    const unpackedResult = repairFresh(unpacked.resources, unpacked.loader);
    assert.equal(unpackedResult.status, "refused");
    assert.equal(unpackedResult.reason, "unpacked-app-present");
    assert.deepEqual(readFileSync(join(unpacked.resources, "app.asar")), unpackedApp);
    assert.equal(readdirSync(unpacked.resources).includes("_app.asar"), false);

    const outside = makeRepairFixture(root, "symlink-outside");
    const linkedResources = join(root, "linked-resources");
    symlinkSync(outside.resources, linkedResources, process.platform === "win32" ? "junction" : "dir");
    const outsideBefore = snapshotRegularFiles(outside.resources);
    const linkedResult = repairRecovery(linkedResources, outside.loader);
    assert.equal(linkedResult.status, "refused");
    assert.equal(linkedResult.reason, "unsafe-resources-path");
    assert.deepEqual(snapshotRegularFiles(outside.resources), outsideBefore);
}

function testObservationGate(root: string) {
    const fixture = makeRepairFixture(root, "observation-gate");
    const appAsar = join(fixture.resources, "app.asar");
    const first = observeDiscordResourceCandidate(fixture.resources);
    assert.ok(first);
    const confirming = observeDiscordResourceCandidate(fixture.resources);
    assert.ok(confirming);
    assert.equal(discordResourceObservationIsQuiescent(first, confirming, 999), false);
    assert.equal(discordResourceObservationIsQuiescent(first, confirming, 1_000), true);

    const missingObservation = repairRecovery(fixture.resources, fixture.loader);
    assert.equal(missingObservation.status, "refused");
    assert.equal(missingObservation.reason, "source-not-quiescent");
    assert.deepEqual(readdirSync(fixture.resources), ["app.asar"]);

    const changedStock = Buffer.alloc(STOCK_ASAR.byteLength, 0x42);
    writeFileSync(appAsar, changedStock);
    const second = observeDiscordResourceCandidate(fixture.resources);
    assert.ok(second);
    assert.equal(discordResourceObservationsEqual(first, second), false);

    const staleObservation = repairDiscordResources(fixture.resources, fixture.loader, {
        expectedObservation: first,
        nonce: () => NONCE
    });
    assert.equal(staleObservation.status, "refused");
    assert.equal(staleObservation.reason, "source-observation-changed");
    assert.deepEqual(readFileSync(appAsar), changedStock);
    assert.deepEqual(readdirSync(fixture.resources), ["app.asar"]);

    const retried = repairFresh(fixture.resources, fixture.loader);
    assert.equal(retried.status, "repaired", retried.reason ?? "confirmed retry failed");
    assertRepaired(fixture.resources, fixture.loader, changedStock);
}

function runPublishedLockCrashChild(resources: string, patcherPath: string): never {
    const result = repairDiscordResources(resources, createCanonicalDiscordLoaderAsar(patcherPath), {
        expectedObservation: stableObservation(resources),
        nonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        onStep(step) {
            if (step === "lock-published") process.exit(73);
        }
    });
    console.error(`lock crash child unexpectedly returned: ${result.status}/${result.reason}`);
    process.exit(74);
}

function testPublishedLockCrashRecovery(root: string) {
    const fixture = makeRepairFixture(root, "published-lock-crash");
    const child = spawnSync(process.execPath, [
        "--import",
        "tsx",
        resolve("scripts/testDiscordUpdatePersistence.ts"),
        "--published-lock-crash-child",
        fixture.resources,
        fixture.patcherPath
    ], {
        encoding: "utf8",
        timeout: 30_000
    });
    assert.equal(child.status, 73, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);

    const lockPath = join(fixture.resources, ".disorder-host-repair.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["createdAt", "nonce", "pid", "schema"]);
    assert.equal(lock.schema, 1);
    assert.equal(lock.nonce, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.ok(Number.isSafeInteger(lock.createdAt));

    const recovered = repairDiscordResources(fixture.resources, fixture.loader, {
        expectedObservation: stableObservation(fixture.resources),
        nonce: () => NONCE,
        now: () => lock.createdAt + 60_000
    });
    assert.equal(recovered.status, "repaired", recovered.reason ?? "stale published lock was not recovered");
    assertRepaired(fixture.resources, fixture.loader);
}

function testExactFileIdentity(root: string) {
    const fixture = makeRepairFixture(root, "windows-bigint-identity");
    const observation = stableObservation(fixture.resources);
    if (process.platform === "win32") {
        const appInfo = lstatSync(join(fixture.resources, "app.asar"), { bigint: true });
        const resourcesInfo = lstatSync(fixture.resources, { bigint: true });

        assert.equal(observation.appDevice, appInfo.dev.toString());
        assert.equal(observation.appInode, appInfo.ino.toString());
        assert.equal(observation.appModifiedNs, appInfo.mtimeNs.toString());
        assert.equal(observation.resourcesDevice, resourcesInfo.dev.toString());
        assert.equal(observation.resourcesInode, resourcesInfo.ino.toString());
    }
    for (const identity of [
        observation.appDevice,
        observation.appInode,
        observation.appModifiedNs,
        observation.resourcesDevice,
        observation.resourcesInode
    ]) {
        assert.match(identity, /^(?:0|[1-9][0-9]*)$/u);
    }

    const unsafeIdentity = { ...observation, appInode: "9007199254740992" };
    const adjacentUnsafeIdentity = { ...observation, appInode: "9007199254740993" };
    assert.equal(Number(unsafeIdentity.appInode), Number(adjacentUnsafeIdentity.appInode));
    assert.equal(discordResourceObservationsEqual(unsafeIdentity, adjacentUnsafeIdentity), false);
}

function testBackupStagingRecovery(root: string) {
    const fixture = makeRepairFixture(root, "backup-staging-recovery");
    let stoppedAfterStaging = false;
    const interrupted = repairFresh(fixture.resources, fixture.loader, step => {
        if (step === "staging-written") {
            stoppedAfterStaging = true;
            throw new Error("simulated process exit before backup commit");
        }
    });
    assert.equal(stoppedAfterStaging, true);
    assert.equal(interrupted.status, "refused");

    const journalPath = join(fixture.resources, ".disorder-host-repair.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.status, "pending");
    assert.match(journal.backupStagingName, /^\.disorder-app-asar-backup-[0-9a-f]{32}$/u);
    const backupStaging = join(fixture.resources, journal.backupStagingName);
    write(backupStaging, STOCK_ASAR);

    const recovered = repairRecovery(fixture.resources, fixture.loader);
    assert.equal(recovered.status, "repaired", recovered.reason ?? "backup recovery failed");
    assertRepaired(fixture.resources, fixture.loader);
}

function testInstalledJournalWithStockRefuses(root: string) {
    const fixture = makeRepairFixture(root, "installed-journal-stock");
    const installed = repairFresh(fixture.resources, fixture.loader);
    assert.equal(installed.status, "repaired", installed.reason ?? "initial repair failed");
    assertRepaired(fixture.resources, fixture.loader);

    writeFileSync(join(fixture.resources, "app.asar"), STOCK_ASAR);
    const before = snapshotRegularFiles(fixture.resources);
    const refused = repairDiscordResources(fixture.resources, fixture.loader, {
        expectedObservation: stableObservation(fixture.resources),
        nonce: () => NONCE
    });
    assert.equal(refused.status, "refused");
    assert.equal(refused.reason, "installed-journal-without-loader");
    assert.deepEqual(snapshotRegularFiles(fixture.resources), before);
}

function testFaultRecoveryAndSettings(root: string) {
    const steps: RepairStep[] = [
        "journal-written",
        "staging-written",
        "backup-written",
        "source-revalidated",
        "loader-committed",
        "journal-installed"
    ];

    for (const stepToFail of steps) {
        const fixture = makeRepairFixture(root, `fault-${stepToFail}`);
        const settingsBefore = makeSettingsSentinels(fixture.dataRoot);
        let observed = false;

        try {
            const result = repairFresh(fixture.resources, fixture.loader, step => {
                if (step === stepToFail) {
                    observed = true;
                    throw new Error(`simulated crash after ${step}`);
                }
            });
            assert.equal(result.status, "refused");
        } catch (error) {
            assert.match(String(error), /simulated crash/u);
        }

        assert.equal(observed, true, `${stepToFail} fault must be reached`);
        const retry = repairRecovery(fixture.resources, fixture.loader);
        assert.ok(retry.status === "repaired" || retry.status === "unchanged");
        assertRepaired(fixture.resources, fixture.loader);
        assert.deepEqual(snapshotRegularFiles(fixture.dataRoot), settingsBefore);
    }
}

function testExplicitInjectorPathIntegration() {
    const patcher = readFileSync(resolve("src/main/patcher.ts"), "utf8");
    const coordinator = readFileSync(resolve("src/main/persistAfterDiscordUpdates.ts"), "utf8");
    const core = readFileSync(resolve("src/main/discordUpdatePersistence.ts"), "utf8");
    const capture = patcher.indexOf("const injectorPath = require.main!.filename;");
    const rewrite = patcher.indexOf("require.main!.filename =");
    const persistenceCall = patcher.indexOf(".startDiscordUpdatePersistence(injectorPath)");

    assert.ok(capture >= 0 && rewrite > capture && persistenceCall > rewrite,
        "the pre-rewrite injector path must be passed explicitly to persistence");
    assert.match(coordinator, /export function startDiscordUpdatePersistence\(injectorPath: string\)/u);
    assert.doesNotMatch(coordinator, /require\.main/u,
        "persistence must not fall back to Discord's rewritten require.main");
    assert.match(coordinator, /process\.hrtime\.bigint\(\)/u,
        "coordinator quiescence must use a monotonic clock");
    assert.match(coordinator, /discordResourceObservationIsQuiescent\(/u,
        "coordinator must enforce the pure elapsed-observation gate");
    assert.equal(
        [...coordinator.matchAll(/startDiscordUpdatePersistence\(/gu)].length,
        1,
        "the coordinator must not auto-start without the captured injector path"
    );

    const fsImports = [...core.matchAll(/import\s+[^;]+from\s+["'](?:node:)?fs["'];/gu)];
    assert.equal(fsImports.length, 1);
    assert.match(fsImports[0][0], /^import type\b/u,
        "the core must not bind Electron's ASAR-patched fs through a value import");
    assert.match(core, /process\.versions\.electron != null\s*\? require\("original-fs"\)\s*:\s*require\("fs"\)/u,
        "Electron must use physical original-fs while plain Node tests use fs");

    const coreUrl = pathToFileURL(resolve("src/main/discordUpdatePersistence.ts")).href;
    const smoke = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "--eval",
        `const Module=require("node:module");`
        + `const fs=require("node:fs");let used=false;const load=Module._load;`
        + `Module._load=function(request,...args){if(request==="original-fs"){used=true;return fs;}`
        + `return load.call(this,request,...args)};`
        + `Object.defineProperty(process.versions,"electron",{value:"test",configurable:true});`
        + `import(${JSON.stringify(coreUrl)}).then(()=>process.exit(used?0:2),error=>{console.error(error);process.exit(3)});`
    ], {
        encoding: "utf8",
        timeout: 30_000
    });
    assert.equal(smoke.status, 0, `${smoke.error ?? ""}\n${smoke.stdout}\n${smoke.stderr}`);
}

function main() {
    testCanonicalLoaderGolden();
    testStrictVersions();
    testExplicitInjectorPathIntegration();

    const temporaryParent = realpathSync(resolve(tmpdir()));
    const temporaryRoot = realpathSync(mkdtempSync(join(temporaryParent, "disorder-persistence-test-")));
    assert.equal(isAbsolute(temporaryRoot), true);
    assert.ok(temporaryRoot.startsWith(`${temporaryParent}${sep}`));
    try {
        testStagedWindowsRepair(temporaryRoot);
        testAmbiguousStatesRefuse(temporaryRoot);
        testObservationGate(temporaryRoot);
        testPublishedLockCrashRecovery(temporaryRoot);
        testExactFileIdentity(temporaryRoot);
        testBackupStagingRecovery(temporaryRoot);
        testInstalledJournalWithStockRefuses(temporaryRoot);
        testFaultRecoveryAndSettings(temporaryRoot);
    } finally {
        assert.ok(temporaryRoot.startsWith(`${temporaryParent}${sep}`));
        rmSync(temporaryRoot, { force: true, recursive: true });
    }

    console.log("Discord update persistence discovery, safety, recovery, and settings fixtures passed.");
}

const childMode = process.argv.indexOf("--published-lock-crash-child");
if (childMode >= 0) {
    runPublishedLockCrashChild(process.argv[childMode + 1], process.argv[childMode + 2]);
} else {
    main();
}
