/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const protocol = readFileSync("src/plugins/matrixBridge/workerProtocol.ts", "utf8");

const publicError = backend.slice(
    backend.indexOf("function publicError("),
    backend.indexOf("function throwAuthenticationError(")
);
assert.match(publicError, /case "M_UNKNOWN_TOKEN":[\s\S]*soft_logout === true[\s\S]*MATRIX_REAUTH_REQUIRED[\s\S]*MATRIX_SESSION_RESET_REQUIRED/u,
    "same-device reauthentication must require an explicit soft_logout=true response");
assert.match(publicError, /case "M_MISSING_TOKEN":[\s\S]*MATRIX_SESSION_RESET_REQUIRED/u,
    "a missing or unverified session must require a fresh device");

const backendReauth = backend.slice(
    backend.indexOf("async function reauthenticate("),
    backend.indexOf("interface RegistrationAuthData")
);
assert.match(backendReauth, /device_id: input\.deviceId/u,
    "password reauthentication must request the existing Matrix device");
assert.match(backendReauth, /const response = await client\.whoami\(\)/u,
    "access-token reauthentication must authenticate its claimed identity");
assert.match(backendReauth, /credentials\.userId !== input\.userId \|\| credentials\.deviceId !== input\.deviceId/u,
    "the returned session must match the existing encrypted device exactly");
assert.match(protocol, /\{ type: "reauthenticate"; reauthentication: MatrixReauthenticationRequest; \}/u);
assert.match(backend, /command\.type === "login" \|\| command\.type === "reauthenticate"/u,
    "reauthentication must drain ordinary worker operations as a lifecycle transition");
assert.match(backend, /case "reauthenticate":[\s\S]*reauthentication\.password = ""[\s\S]*reauthentication\.accessToken = ""/u,
    "the worker must erase its cloned reauthentication secret");

const nativeReauth = native.slice(
    native.indexOf("async function reauthenticate("),
    native.indexOf("async function register(")
);
assert.match(nativeReauth, /startupFailure\?\.error\.code !== "MATRIX_REAUTH_REQUIRED"/u,
    "native must independently gate reauthentication on the verified soft-logout latch");
assert.match(native, /function latchActiveSessionFailure\([\s\S]*activeWorkerBinding[\s\S]*startupFailureLatch =/u,
    "a live soft/hard session failure must be bound and latched before its worker is destroyed");
assert.match(native, /event\.type === "status"[\s\S]*isSessionRecoveryError\(event\.status\.error\)[\s\S]*latchActiveSessionFailure/u,
    "an asynchronous sync auth failure must enable the same safe recovery path as startup");
assert.match(nativeReauth, /terminateWorker\([\s\S]*clearEventStream\(\)[\s\S]*callWorker\(\{ type: "reauthenticate"/u,
    "the expired client must be destroyed before credentials are replaced");
const persist = nativeReauth.indexOf("writeStoredAccount(replacement)");
const clearLatch = nativeReauth.indexOf("clearStartupFailure(binding)");
const restart = nativeReauth.indexOf("startInternal(replacement)");
assert.ok(persist >= 0 && clearLatch > persist && restart > clearLatch,
    "replacement credentials must persist atomically before the latch is cleared and sync restarts");
assert.match(nativeReauth, /!credentialsCommitted && recoveryFailure[\s\S]*updateStatus\("error", \{ userId: accountUserId! \}, recoveryFailure\)/u,
    "a rejected replacement secret must preserve the verified reauthentication UI state");
assert.match(nativeReauth, /const replacement = validateStoredAccount\(\{[\s\S]*\.\.\.existing,[\s\S]*accessToken: credentials\.accessToken/u,
    "reauthentication must preserve the existing schema and crypto storage key");
assert.match(native, /\breauthenticate,[\s\S]*\breconcileSpaceChildCreate,/u,
    "the renderer-facing native contract must expose explicit reauthentication");
