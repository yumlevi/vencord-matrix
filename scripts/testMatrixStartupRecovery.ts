/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");

const startAuthenticated = backend.slice(
    backend.indexOf("async function startAuthenticated("),
    backend.indexOf("async function login(")
);
const orderedBackendMarkers = [
    'progress("store")',
    'progress("session")',
    'progress("crypto-module")',
    'progress("client")'
];
let previous = -1;
for (const marker of orderedBackendMarkers) {
    const index = startAuthenticated.indexOf(marker);
    assert.ok(index > previous, `${marker} must follow the prior completed startup stage`);
    previous = index;
}
const cryptoMarkers = [
    'progress("crypto-wasm")',
    'progress("crypto-store")',
    'progress("crypto-machine")'
];
const startupLogger = backend.slice(
    backend.indexOf("function startupProgressLogger("),
    backend.indexOf("let matrixClient:")
);
previous = -1;
for (const marker of cryptoMarkers) {
    const index = startupLogger.indexOf(marker);
    assert.ok(index > previous, `${marker} must be a forward-only allowlisted crypto milestone`);
    previous = index;
}

const refreshClientOptions = startAuthenticated.slice(
    startAuthenticated.indexOf("const refreshClient = createClient({"),
    startAuthenticated.indexOf("const refreshTokens =", startAuthenticated.indexOf("const refreshClient = createClient({"))
);
assert.match(refreshClientOptions, /baseUrl: account\.homeserver/u);
assert.match(refreshClientOptions, /localTimeoutMs: 30_000/u);
assert.doesNotMatch(refreshClientOptions, /accessToken|refreshToken|tokenRefreshFunction/u,
    "the refresh-only client must not inherit the stale bearer or recurse through TokenRefresher");
const refreshCallback = startAuthenticated.slice(
    startAuthenticated.indexOf("const refreshTokens ="),
    startAuthenticated.indexOf("const client = createClient({")
);
assert.match(refreshCallback, /await refreshClient\.refreshToken\(refreshToken\)/u);
assert.doesNotMatch(refreshCallback, /await client\.refreshToken\(refreshToken\)/u,
    "the authenticated client's TokenRefresher must not await itself");
assert.match(refreshCallback, /result\?\.refresh_token == null[\s\S]*\? refreshToken/u,
    "an omitted rotated refresh token must preserve the reusable input token");
assert.match(refreshCallback, /expiresInMs == null \? \{\} : \{ expiry:/u,
    "an omitted or invalid expiry must not construct an Invalid Date");
assert.match(refreshCallback, /if \(sessionIdentityValidated\)[\s\S]*saveCredentials\(credentials\)[\s\S]*else[\s\S]*pendingRefreshedCredentials = credentials/u,
    "a startup refresh must remain staged until its replacement identity is authenticated");

const sessionProgress = startAuthenticated.indexOf('progress("session")');
const versionsPreflight = startAuthenticated.indexOf("await client.getVersions()", sessionProgress);
const identityPreflight = startAuthenticated.indexOf("await client.whoami()", versionsPreflight);
const cryptoProgress = startAuthenticated.indexOf('progress("crypto-module")', identityPreflight);
assert.ok(sessionProgress >= 0 && versionsPreflight > sessionProgress
    && identityPreflight > versionsPreflight && cryptoProgress > identityPreflight,
"the authenticated session and exact device identity must be validated before opening Rust crypto");
assert.match(startAuthenticated, /if \(pendingRefreshedCredentials\)[\s\S]*saveCredentials\(pendingRefreshedCredentials\)[\s\S]*sessionIdentityValidated = true;[\s\S]*progress\("crypto-module"\)/u,
    "staged refresh credentials must persist only after exact whoami validation and before crypto startup");

assert.match(native, /const STARTUP_OVERALL_TIMEOUT_MS = 10 \* 60_000;/u);
assert.match(native, /session: 3 \* 60_000/u);
assert.match(native, /pending\.startupCryptoDeadline = Math\.min\([\s\S]*pending\.startupDeadline,[\s\S]*Date\.now\(\) \+ STARTUP_STAGE_TIMEOUT_MS\[message\.stage\]/u);
assert.match(native, /Math\.min\([\s\S]*STARTUP_STAGE_TIMEOUT_MS\[stage\],[\s\S]*overallRemaining,[\s\S]*cryptoRemaining/u);
assert.match(native, /const monotonic = currentIndex < 0[\s\S]*nextIndex === 0[\s\S]*nextIndex > currentIndex;/u);

const startFunction = native.slice(
    native.indexOf("async function start(_: IpcMainInvokeEvent)"),
    native.indexOf("async function suspend(_: IpcMainInvokeEvent)")
);
const latchCheck = startFunction.indexOf("startupFailureForAccount(account)");
const emptySnapshot = startFunction.indexOf("return emptySnapshot();", latchCheck);
const workerStart = startFunction.indexOf("startInternal(account)");
assert.ok(latchCheck >= 0 && emptySnapshot > latchCheck && workerStart > emptySnapshot,
    "a latched account must return its error snapshot before creating another worker");

assert.match(native, /if \(startupFailureLatch && !sameAccountBinding[\s\S]*startupFailureLatch = null;/u);
assert.match(native, /pending\.commandType === "start"[\s\S]*clearStartupFailure\(pending\.startupBinding\);/u);
assert.match(native, /async function logout[\s\S]*clearStartupFailure\(\);/u);
assert.match(native, /async function suspend[\s\S]*clearStartupFailure\(\);/u);
