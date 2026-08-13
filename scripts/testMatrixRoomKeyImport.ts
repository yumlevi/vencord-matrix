/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, pbkdf2Sync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

import { convergeImportedRoomKeys } from "../src/plugins/matrixBridge/keyImportConvergence";
import {
    importEncryptedMegolmKeyExport,
    MAX_MEGOLM_KEY_EXPORT_BYTES,
    MegolmKeyImportError,
    MIN_MEGOLM_KEY_EXPORT_ROUNDS
} from "../src/plugins/matrixBridge/megolmKeyImport";
import { matrixMessageOrderNeedsReindex } from "../src/plugins/matrixBridge/roomMessageOrder";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

const knownSession = [{
    algorithm: "m.megolm.v1.aes-sha2",
    forwarding_curve25519_key_chain: [],
    room_id: "!fixture:invalid.test",
    sender_key: "fixture-sender-key",
    sender_claimed_keys: { ed25519: "fixture-claimed-key" },
    session_id: "fixture-session",
    session_key: "fixture-session-key",
}];

async function encryptedFixture(json: string, passphrase: string, rounds = MIN_MEGOLM_KEY_EXPORT_ROUNDS) {
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const iv = Uint8Array.from({ length: 16 }, (_, index) => 31 - index);
    iv[8] &= 0x7f;
    const password = encoder.encode(passphrase);
    const material = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const derived = new Uint8Array(await subtle.deriveBits({
        name: "PBKDF2",
        hash: "SHA-512",
        salt,
        iterations: rounds,
    }, material, 512));
    const plaintext = encoder.encode(json);
    const aesKey = await subtle.importKey("raw", derived.slice(0, 32), "AES-CTR", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await subtle.encrypt(
        { name: "AES-CTR", counter: iv, length: 64 },
        aesKey,
        plaintext
    ));
    const authenticated = new Uint8Array(1 + 16 + 16 + 4 + ciphertext.length);
    authenticated[0] = 1;
    authenticated.set(salt, 1);
    authenticated.set(iv, 17);
    new DataView(authenticated.buffer).setUint32(33, rounds, false);
    authenticated.set(ciphertext, 37);
    const macKey = await subtle.importKey(
        "raw",
        derived.slice(32),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const mac = new Uint8Array(await subtle.sign("HMAC", macKey, authenticated));
    const binary = new Uint8Array(authenticated.length + mac.length);
    binary.set(authenticated);
    binary.set(mac, authenticated.length);
    const base64 = Buffer.from(binary).toString("base64").match(/.{1,64}/gu)!.join("\n");
    password.fill(0);
    derived.fill(0);
    plaintext.fill(0);
    authenticated.fill(0);
    mac.fill(0);
    binary.fill(0);
    return encoder.encode(`-----BEGIN MEGOLM SESSION DATA-----\n${base64}\n-----END MEGOLM SESSION DATA-----\n`);
}

function independentFixture(json: string, passphrase: string): Uint8Array {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, index) => 0xa0 + index));
    const iv = Buffer.from(Array.from({ length: 16 }, (_, index) => 0x70 + index));
    iv[8] &= 0x7f;
    const derived = pbkdf2Sync(passphrase, salt, MIN_MEGOLM_KEY_EXPORT_ROUNDS, 64, "sha512");
    const cipher = createCipheriv("aes-256-ctr", derived.subarray(0, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(json, "utf8")), cipher.final()]);
    const authenticated = Buffer.alloc(37 + ciphertext.length);
    authenticated[0] = 1;
    salt.copy(authenticated, 1);
    iv.copy(authenticated, 17);
    authenticated.writeUInt32BE(MIN_MEGOLM_KEY_EXPORT_ROUNDS, 33);
    ciphertext.copy(authenticated, 37);
    const mac = createHmac("sha256", derived.subarray(32)).update(authenticated).digest();
    const binary = Buffer.concat([authenticated, mac]);
    const base64 = binary.toString("base64").match(/.{1,64}/gu)!.join("\r\n");
    const armored = Buffer.from(
        `-----BEGIN MEGOLM SESSION DATA-----\r\n${base64}\r\n-----END MEGOLM SESSION DATA-----\r\n`,
        "utf8"
    );
    salt.fill(0);
    iv.fill(0);
    derived.fill(0);
    ciphertext.fill(0);
    authenticated.fill(0);
    mac.fill(0);
    binary.fill(0);
    return new Uint8Array(armored);
}

async function rejectsImport(bytes: Uint8Array, passphrase: string): Promise<void> {
    await assert.rejects(
        importEncryptedMegolmKeyExport(bytes, passphrase, async () => undefined),
        MegolmKeyImportError
    );
}

async function testEncryptedExport(): Promise<void> {
    const passphrase = "generated fixture passphrase";
    const fixture = await encryptedFixture(JSON.stringify(knownSession), passphrase);
    let imported = "";
    const result = await importEncryptedMegolmKeyExport(fixture, passphrase, async (json, count) => {
        assert.equal(count, 1);
        imported = json;
        return "accepted";
    });
    assert.equal(result.sessionCount, 1);
    assert.equal(result.value, "accepted");
    assert.deepEqual(JSON.parse(imported), knownSession);
    imported = "";

    const independent = independentFixture(JSON.stringify(knownSession), "independent fixture passphrase");
    assert.equal(
        createHash("sha256").update(independent).digest("hex"),
        "7c7275de41300b5dc55e4341d59fdc7e9090ad510b6a28ad97b2ec7ade3f0310",
        "the independent Node crypto fixture must remain a fixed padded multiline CRLF vector"
    );
    const independentResult = await importEncryptedMegolmKeyExport(
        independent,
        "independent fixture passphrase",
        async json => JSON.parse(json)
    );
    assert.deepEqual(independentResult.value, knownSession);
    independent.fill(0);

    await rejectsImport(fixture, "wrong passphrase");
    const damaged = fixture.slice();
    const payloadIndex = damaged.findIndex((value, index) => index > 40 && value === "A".charCodeAt(0));
    assert.notEqual(payloadIndex, -1);
    damaged[payloadIndex] = "B".charCodeAt(0);
    await rejectsImport(damaged, passphrase);
    await rejectsImport(await encryptedFixture("{}", passphrase), passphrase);
    await rejectsImport(await encryptedFixture(JSON.stringify([{ algorithm: "m.megolm.v1.aes-sha2" }]), passphrase), passphrase);
    await rejectsImport(await encryptedFixture(JSON.stringify(knownSession), passphrase, MIN_MEGOLM_KEY_EXPORT_ROUNDS - 1), passphrase);
    await rejectsImport(new Uint8Array(MAX_MEGOLM_KEY_EXPORT_BYTES + 1), passphrase);
    fixture.fill(0);
    damaged.fill(0);
}

async function testDelayedConvergence(): Promise<void> {
    let revision = 0;
    const started = Date.now();
    const result = await convergeImportedRoomKeys(
        ["delayed", "fast"],
        async value => {
            await new Promise(resolve => setTimeout(resolve, value === "delayed" ? 220 : 5));
            revision++;
        },
        () => revision,
        { concurrency: 2, timeoutMs: 1_000, quietMs: 25, pollMs: 5 }
    );
    assert.equal(result.attempted, 2);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started >= 220, "a delayed first Decrypted event must settle before convergence");

    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on("unhandledRejection", onUnhandled);
    try {
        const timedOut = await convergeImportedRoomKeys(
            ["late rejection"],
            async () => {
                await new Promise((_, reject) => setTimeout(() => reject(new Error("fixture rejection")), 80));
            },
            () => 0,
            { concurrency: 1, timeoutMs: 20, quietMs: 5, pollMs: 2 }
        );
        assert.equal(timedOut.timedOut, true);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(unhandled, false, "a post-timeout retry rejection must stay handled");
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
}

function testAnchorRecovery(): void {
    assert.equal(matrixMessageOrderNeedsReindex(
        new Map([["first", "100"], ["last", "102"]]),
        ["first", "new-a", "new-b", "last"]
    ), true, "two newly visible rows cannot fit in one integer slot");
    assert.equal(matrixMessageOrderNeedsReindex(
        new Map([["first", "100"], ["last", "104"]]),
        ["first", "new-a", "new-b", "last"]
    ), false);
    assert.equal(matrixMessageOrderNeedsReindex(new Map([["last", "100"]]), ["prefix", "last"]), false);
    assert.equal(matrixMessageOrderNeedsReindex(new Map([["first", "100"]]), ["first", "suffix"]), false);
    assert.equal(matrixMessageOrderNeedsReindex(
        new Map([["first", "104"], ["last", "100"]]),
        ["first", "last"]
    ), true, "already-visible anchors must be replanned when canonical order changes");
    assert.equal(matrixMessageOrderNeedsReindex(
        new Map([["first", "100"], ["last", "100"]]),
        ["first", "last"]
    ), true, "two canonical rows cannot share one Discord snowflake");
    assert.equal(matrixMessageOrderNeedsReindex(
        new Map([["first", "100"], ["last", "101"]]),
        ["first", "last"]
    ), false);

    const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
    const reindexStart = bridge.indexOf("function reindexRoomMessageIds");
    const reindexEnd = bridge.indexOf("function ensureRoomMessageIds", reindexStart);
    const reindex = bridge.slice(reindexStart, reindexEnd);
    assert.ok(reindex.indexOf("const values") < reindex.indexOf("ordered.clear()"), "reindex planning must precede commit");
    assert.match(reindex, /reclaimableOwners[\s\S]*range-check the full plan[\s\S]*ordered\.clear\(\)/u);
    assert.doesNotMatch(bridge, /order anchors exhausted for/u);
    assert.match(bridge, /function updateProjectionRoom[\s\S]*messageOrderGeneration[\s\S]*reinjectRoomTimelines/u);
    assert.match(bridge, /function loadProjectionMessages[\s\S]*messageOrderGeneration[\s\S]*reinjectRoomTimelines/u);
    assert.match(bridge, /function injectRoomTimeline[\s\S]*messageOrderGeneration[\s\S]*LOAD_MESSAGES_SUCCESS[\s\S]*MESSAGE_DELETE/u);
    assert.match(
        bridge,
        /function reinjectRoomTimelines[\s\S]*pass < 4[\s\S]*for \(const injected of projections\)[\s\S]*injectRoomTimeline[\s\S]*settledProjections\.every[\s\S]*clearRoomMessageOrder/u,
        "every projection of a reindexed room must receive the full reload"
    );
    assert.match(bridge, /function setProjectionIndexes[\s\S]*messageIds\.clear[\s\S]*eventIds\.clear[\s\S]*messageTargets\.clear/u);
    assert.match(bridge, /aliasesChanged[\s\S]*injectRoomTimeline/u, "partial pagination must fully reload changed aliases");
}

function testWiring(): void {
    const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
    const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
    const preload = readFileSync("src/plugins/matrixBridge/secureViewPreload.ts", "utf8");
    assert.match(backend, /importRoomKeysAsJson\(json\)[\s\S]*cachedMegolmDecryptionFailures[\s\S]*convergeImportedRoomKeys/u);
    assert.match(backend, /scannedTimelines > 20_000[\s\S]*scannedEvents > 100_000[\s\S]*failures\.length >= 50_000/u);
    assert.match(backend, /Parameters<MatrixEvent\["attemptDecryption"\]>\[0\]/u);
    assert.match(native, /showOpenDialog[\s\S]*readBoundedRoomKeyExport[\s\S]*bytes\.fill\(0\)/u);
    assert.match(native, /MAX_MEGOLM_KEY_EXPORT_BYTES/u);
    assert.match(preload, /request\.type === "importRoomKeys"[\s\S]*request\.passphrase = ""/u);
}

async function main(): Promise<void> {
    await testEncryptedExport();
    await testDelayedConvergence();
    testAnchorRecovery();
    testWiring();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
