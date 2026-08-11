/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");

const publicError = backend.slice(
    backend.indexOf("function publicError("),
    backend.indexOf("function throwAuthenticationError(")
);
assert.match(publicError, /httpStatus >= 100 && candidate\.httpStatus <= 599/u);
assert.match(publicError, /if \(matrixServerUnavailableHttpStatus\(httpStatus\)\)[\s\S]*MATRIX_SERVER_UNAVAILABLE/u,
    "HTTP 500-599 responses must become one content-free transient server code");
assert.ok(publicError.indexOf("matrixServerUnavailableHttpStatus(httpStatus)")
    < publicError.indexOf("if (errcode) return", publicError.indexOf("default:")),
"an incidental unknown errcode on a 5xx response must not hide server unavailability");

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
assert.ok(refreshCallback.indexOf("startupRefreshAttempted = true")
    < refreshCallback.indexOf("await refreshClient.refreshToken(refreshToken)"),
"a potentially rotating refresh must become ambiguous before it is dispatched");
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
assert.match(startAuthenticated, /!sessionIdentityValidated && startupRefreshAttempted[\s\S]*MATRIX_NETWORK_ERROR[\s\S]*MATRIX_REQUEST_TIMEOUT[\s\S]*MATRIX_SERVER_UNAVAILABLE[\s\S]*MATRIX_STARTUP_REFRESH_AMBIGUOUS/u,
    "a transient-looking failure after a refresh attempt must latch as an ambiguous credential mutation");
assert.ok(startAuthenticated.indexOf("await disposeClient(false)")
    < startAuthenticated.indexOf("MATRIX_STARTUP_REFRESH_AMBIGUOUS"),
"startup failure must close the existing sync/crypto handles without clearing their stores");

assert.match(native, /const STARTUP_OVERALL_TIMEOUT_MS = 10 \* 60_000;/u);
assert.match(native, /session: 3 \* 60_000/u);
assert.match(native, /pending\.startupCryptoDeadline = Math\.min\([\s\S]*pending\.startupDeadline,[\s\S]*Date\.now\(\) \+ STARTUP_STAGE_TIMEOUT_MS\[message\.stage\]/u);
assert.match(native, /Math\.min\([\s\S]*STARTUP_STAGE_TIMEOUT_MS\[stage\],[\s\S]*overallRemaining,[\s\S]*cryptoRemaining/u);
assert.match(native, /const monotonic = currentIndex < 0[\s\S]*nextIndex === 0[\s\S]*nextIndex > currentIndex;/u);

assert.match(types, /interface MatrixBridgeError \{[\s\S]*causeCode\?: string;/u);
assert.match(native, /const MATRIX_ERROR_CODE_PATTERN = \/\^\(\?=\.\{1,128\}\$\)/u,
    "native error and cause codes must be bounded before projection");
const statusValidator = native.slice(
    native.indexOf("function validateProtocolStatus("),
    native.indexOf("function validateProtocolSnapshot(")
);
assert.match(statusValidator, /status error cause code/u);
assert.match(statusValidator, /MATRIX_ERROR_CODE_PATTERN\.test\(causeCode\)/u,
    "the worker boundary must validate a cause code independently");
assert.match(native, /function errorDTO\([\s\S]*causeCode[\s\S]*MATRIX_ERROR_CODE_PATTERN\.test\(causeCode\)/u);
const shellStatus = native.slice(
    native.indexOf("function projectShellStatus("),
    native.indexOf("function projectShellRoom(")
);
assert.match(shellStatus, /message: "The Matrix backend reported an error\."[\s\S]*causeCode/u,
    "the isolated shell may receive the code but never an underlying error message");

const nativeRetrySet = native.slice(
    native.indexOf("const RETRYABLE_PRE_CRYPTO_SESSION_FAILURES"),
    native.indexOf("function retryablePreCryptoSessionFailure(")
);
const nativeRetryCodes = [...nativeRetrySet.matchAll(/"((?:MATRIX_|M_|ORG[._])[A-Z0-9._]+)"/gu)]
    .map(match => match[1]);
assert.deepEqual(nativeRetryCodes, [
    "MATRIX_NETWORK_ERROR",
    "MATRIX_REQUEST_TIMEOUT",
    "MATRIX_SERVER_UNAVAILABLE"
]);
const nativeRetryClassifier = native.slice(
    native.indexOf("function retryablePreCryptoSessionFailure("),
    native.indexOf("function latchActiveSessionFailure(")
);
assert.match(nativeRetryClassifier, /pending\.startupStage === "session" && RETRYABLE_PRE_CRYPTO_SESSION_FAILURES\.has\(error\.code\)/u);
for (const forbidden of [
    "MATRIX_CREDENTIAL_MISMATCH",
    "MATRIX_REAUTH_REQUIRED",
    "MATRIX_SESSION_RESET_REQUIRED",
    "MATRIX_STARTUP_REFRESH_AMBIGUOUS",
    "MATRIX_STARTUP_SESSION_TIMEOUT",
    "M_LIMIT_EXCEEDED",
    "M_FORBIDDEN",
    "MATRIX_BACKEND_ERROR"
]) {
    assert.ok(!nativeRetryCodes.includes(forbidden), `${forbidden} must remain latched`);
}

const stagedFailure = native.slice(
    native.indexOf("if (pending.commandType === \"start\" && pending.startupStage && pending.startupBinding)"),
    native.indexOf("const error = bridgeError(message.error.code", native.indexOf("if (pending.commandType === \"start\" && pending.startupStage && pending.startupBinding)"))
);
assert.match(stagedFailure, /startupStageFailureError\(pending\.startupStage, message\.error\.code\)/u,
    "the generic startup stage error must retain only its sanitized underlying code");
const retryDecision = stagedFailure.indexOf("retryablePreCryptoSessionFailure");
const conditionalLatch = stagedFailure.indexOf("if (!retryableSessionFailure) latchStartupFailure");
const failWorker = stagedFailure.indexOf("failWorker(error)");
assert.ok(retryDecision >= 0 && conditionalLatch > retryDecision && failWorker > conditionalLatch,
    "only an exact transient session failure may skip the latch, and its worker must still be destroyed");

const bridgeRetrySet = bridge.slice(
    bridge.indexOf("const RETRYABLE_STARTUP_SESSION_CAUSES"),
    bridge.indexOf("function retryableStartFailure(")
);
const bridgeRetryCodes = [...bridgeRetrySet.matchAll(/"((?:MATRIX_|M_|ORG[._])[A-Z0-9._]+)"/gu)]
    .map(match => match[1]);
assert.deepEqual(bridgeRetryCodes, nativeRetryCodes,
    "native latch release and renderer backoff must use the same exact cause allowlist");
const bridgeRetryClassifier = bridge.slice(
    bridge.indexOf("function retryableStartFailure("),
    bridge.indexOf("function logStartupFailure(")
);
assert.match(bridgeRetryClassifier, /return statusCode === "MATRIX_STARTUP_SESSION_FAILED"[\s\S]*RETRYABLE_STARTUP_SESSION_CAUSES\.has\(causeCode\)/u);
assert.doesNotMatch(bridgeRetryClassifier, /WORKER_RECOVERY_ERRORS|code == null/u,
    "startup retry must have no broad or infrastructure-error fallback");
assert.match(bridge, /const startupError = statusError \?\? error;[\s\S]*retryableStartFailure\(startupError\)/u,
    "the renderer must prefer the validated status cause and use a direct error only when it preserves that DTO");
assert.match(settings, /matrixErrorCode\(\{ code: status\.error\?\.causeCode \}\)[\s\S]*`cause \$\{causeCode\}`/u);
const bridgeStartupLogger = bridge.slice(
    bridge.indexOf("function logStartupFailure("),
    bridge.indexOf("function scheduleBridgeReconnect(")
);
assert.match(bridgeStartupLogger, /matrixErrorCode\(error\)[\s\S]*matrixErrorCauseCode\(error\)[\s\S]*`cause \$\{causeCode\}`/u);
assert.doesNotMatch(bridgeStartupLogger, /\.message|JSON\.stringify|logger\.warn\([^)]*error[,)]/u,
    "startup diagnostics must log validated codes only");

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
