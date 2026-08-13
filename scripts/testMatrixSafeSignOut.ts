/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    matrixUserLocalpart,
    preserveSignedOutDevice,
    restorePreservedDevice
} from "../src/plugins/matrixBridge/accountState";
import type { MatrixStoredAccount } from "../src/plugins/matrixBridge/workerProtocol";

const active: MatrixStoredAccount = {
    schema: 1,
    homeserver: "https://matrix.example",
    userId: "@alice:example",
    deviceId: "DISORDER-DEVICE",
    accessToken: "active-access-secret",
    refreshToken: "active-refresh-secret",
    storageKey: Buffer.alloc(32, 7).toString("base64")
};
const original = structuredClone(active);
const preserved = preserveSignedOutDevice(active);
assert.deepEqual(active, original, "ordinary sign-out must not mutate a live credential object in place");
assert.deepEqual(Object.keys(preserved).sort(), ["deviceId", "homeserver", "schema", "storageKey", "userId"]);
assert.equal(preserved.schema, 2);
assert.equal(preserved.storageKey, active.storageKey);
assert.equal(preserved.deviceId, active.deviceId);
assert.doesNotMatch(JSON.stringify(preserved), /access|refresh|active-access-secret|active-refresh-secret/iu,
    "the durable signed-out record must contain no reusable session secret");

const restored = restorePreservedDevice(preserved, {
    homeserver: active.homeserver,
    userId: active.userId,
    deviceId: active.deviceId,
    accessToken: "replacement-access",
    refreshToken: "replacement-refresh"
});
assert.ok(restored);
assert.equal(restored.storageKey, active.storageKey);
assert.equal(restored.deviceId, active.deviceId);
assert.equal(restored.accessToken, "replacement-access");
for (const mismatch of [
    { homeserver: "https://other.example", userId: active.userId, deviceId: active.deviceId },
    { homeserver: active.homeserver, userId: "@mallory:example", deviceId: active.deviceId },
    { homeserver: active.homeserver, userId: active.userId, deviceId: "OTHER-DEVICE" }
]) {
    assert.equal(restorePreservedDevice(preserved, { ...mismatch, accessToken: "foreign-secret" }), undefined,
        "a different homeserver, account, or device must fail closed without replacing preserved state");
}
assert.equal(matrixUserLocalpart(active.userId), "alice");
assert.equal(matrixUserLocalpart("invalid"), undefined);

const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const protocol = readFileSync("src/plugins/matrixBridge/workerProtocol.ts", "utf8");
const secureProtocol = readFileSync("src/plugins/matrixBridge/secureViewProtocol.ts", "utf8");
const secureView = readFileSync("src/plugins/matrixBridge/secureView.ts", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const sdkClient = readFileSync("node_modules/matrix-js-sdk/src/client.ts", "utf8");

const sdkLogout = sdkClient.slice(
    sdkClient.indexOf("public async logout(stopClient = false)"),
    sdkClient.indexOf("public deactivateAccount(")
);
assert.match(sdkLogout, /authedRequest\(Method\.Post, "\/logout"\)/u);
assert.doesNotMatch(sdkLogout, /clearStores|deleteAllData/u,
    "matrix-js-sdk logout revokes a session but must not be confused with its separate destructive store API");

assert.match(protocol, /interface MatrixStoredSignedOutAccount[\s\S]*schema: 2;[\s\S]*storageKey: string;/u);
assert.match(protocol, /\{ type: "signOut"; credentials\?: MatrixSessionCredentials; \}/u);
const backendEnd = backend.slice(
    backend.indexOf("async function endAuthenticatedSession("),
    backend.indexOf("function cachedMegolmDecryptionFailures(")
);
assert.match(backendEnd, /await client\.logout\(true\)/u);
assert.match(backendEnd, /await disposeClient\(clearStores\)/u);
assert.match(backendEnd, /async function signOut[\s\S]*endAuthenticatedSession\(false\)/u);
assert.match(backendEnd, /async function logout[\s\S]*endAuthenticatedSession\(true\)/u);
assert.match(backend, /databaseName[\s\S]*account\.homeserver[\s\S]*account\.userId[\s\S]*account\.deviceId/u,
    "the retained homeserver/user/device tuple must reopen the same deterministic database prefix");

const nativeSignOut = native.slice(
    native.indexOf("async function signOut(_: IpcMainInvokeEvent)"),
    native.indexOf("async function logout(_: IpcMainInvokeEvent)")
);
const durableWrite = nativeSignOut.indexOf("await writeStoredAccount(preserved)");
const remoteLogout = nativeSignOut.indexOf('type: "signOut"');
assert.ok(durableWrite >= 0 && remoteLogout > durableWrite,
    "the tokenless crash-recovery record must commit before remote/worker teardown");
assert.match(nativeSignOut, /preserveSignedOutDevice\(current\)/u);
assert.match(nativeSignOut, /clearEventStream\(\)[\s\S]*updateStatus\("logged_out"\)/u);
assert.doesNotMatch(nativeSignOut, /deleteStoredAccount|clearWorkerStorage|clearNativeAccountStorage|randomBytes/u,
    "ordinary sign-out must neither delete retained state nor mint a new crypto identity");
assert.match(nativeSignOut, /credentialsToRevoke\.accessToken = ""[\s\S]*credentialsToRevoke\.refreshToken = ""/u);
assert.match(backend, /case "signOut":[\s\S]*command\.credentials\.accessToken = ""[\s\S]*command\.credentials\.refreshToken = ""/u);

const nativeForget = native.slice(
    native.indexOf("async function logout(_: IpcMainInvokeEvent)"),
    native.indexOf("async function start(_: IpcMainInvokeEvent")
);
assert.match(nativeForget, /deleteStoredAccount/u);
assert.match(nativeForget, /callWorker\(\{ type: "logout" \}\)/u);
assert.match(nativeForget, /clearWorkerStorage\(\)[\s\S]*clearNativeAccountStorage\(\)/u,
    "explicit forget must retain the existing complete destructive cleanup");

const crashRecovery = native.slice(
    native.indexOf("async function start(_: IpcMainInvokeEvent"),
    native.indexOf("async function suspend(_: IpcMainInvokeEvent")
);
assert.ok(crashRecovery.indexOf("record?.schema === 2") >= 0
    && crashRecovery.indexOf("record?.schema === 2") < crashRecovery.indexOf("clearWorkerStorage()"),
"restart must recognize a durable signed-out record before orphan-store cleanup");
assert.match(crashRecovery, /record\?\.schema === 2[\s\S]*return emptySnapshot\(\)/u);

const preservedLogin = native.slice(
    native.indexOf("async function authenticatePreservedDevice("),
    native.indexOf("async function login(_: IpcMainInvokeEvent")
);
assert.match(preservedLogin, /loginDetails\.homeserver !== preserved\.homeserver/u);
assert.match(preservedLogin, /loginDetails\.username !== localpart/u);
assert.match(preservedLogin, /type: "reauthenticate"/u);
assert.match(preservedLogin, /restorePreservedDevice\(preserved, result\.credentials\)/u);
assert.match(preservedLogin, /result\.credentials\.accessToken = ""[\s\S]*result\.credentials\.refreshToken = ""/u);
assert.match(preservedLogin, /current\?\.schema !== 2[\s\S]*sameAccountBinding[\s\S]*writeStoredAccount\(validatedReplacement\)/u);
assert.ok(preservedLogin.indexOf("writeStoredAccount(validatedReplacement)")
    < preservedLogin.indexOf("startInternal(validatedReplacement)"),
"replacement tokens must commit atomically before the preserved crypto store is reopened");

const signedOutValidator = native.slice(
    native.indexOf("function isStoredSignedOutAccount("),
    native.indexOf("function validateStoredAccount(")
);
assert.match(signedOutValidator, /!\("accessToken" in account\)/u);
assert.match(signedOutValidator, /!\("refreshToken" in account\)/u);
const secureConfigProjection = native.slice(
    native.indexOf("const config: MatrixSecureViewAccountConfig"),
    native.indexOf("if \(\(state.boundAccount", native.indexOf("const config: MatrixSecureViewAccountConfig"))
);
assert.doesNotMatch(secureConfigProjection, /storageKey|accessToken|refreshToken/u,
    "the isolated page bootstrap must receive metadata only, never retained keys or session tokens");
assert.match(native, /case "login":[\s\S]*request\.login\.password = ""[\s\S]*request\.login\.accessToken = ""/u);
assert.match(backend, /case "reauthenticate":[\s\S]*reauthentication\.password = ""[\s\S]*reauthentication\.accessToken = ""/u);

assert.match(secureProtocol, /signOut: \{ input: \{\}; output: void; \};/u);
assert.match(secureView, /makeButton\("Sign out"[\s\S]*\(\) => void signOut\(\)\)/u);
assert.match(secureView, /makeButton\("Forget account and keys"[\s\S]*\(\) => void logout\(\)\)/u);
assert.match(secureView, /Local encryption keys for \$\{config\?\.userId\} are preserved/u);
assert.match(settings, /Native\.signOut\(\)/u);
assert.match(settings, /Forget account and keys/u);

console.log("Matrix safe sign-out fixtures passed.");
