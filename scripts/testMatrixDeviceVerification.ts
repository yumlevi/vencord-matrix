/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");
const protocol = readFileSync("src/plugins/matrixBridge/workerProtocol.ts", "utf8");

function section(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    assert.ok(startIndex >= 0, `missing source section: ${start}`);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.ok(endIndex > startIndex, `missing end of source section: ${start}`);
    return source.slice(startIndex, endIndex);
}

function occurrenceCount(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
}

const activeState = section(
    backend,
    "interface ActiveDeviceVerification {",
    "interface HistoryCursorState {"
);
const workerVerification = section(
    backend,
    "const DEVICE_VERIFICATION_ID_PATTERN",
    "function decodeStorageKey("
);
const currentFlowGuard = section(
    backend,
    "function activeDeviceVerificationIsCurrent(",
    "function validateDeviceVerificationId("
);
const bindingGuard = section(
    backend,
    "function assertDeviceVerificationBinding(",
    "function sanitizedVerificationFailure("
);
const workerCleanup = section(
    backend,
    "function releaseDeviceVerificationSecrets(",
    "function failDeviceVerification("
);
const trustRefresh = section(
    backend,
    "async function refreshedCurrentDeviceTrust(",
    "function deviceVerificationFlowDTO("
);
const reconcile = section(
    backend,
    "async function reconcileDeviceVerification(",
    "async function requestOwnDeviceVerification("
);
const requestFlow = section(
    backend,
    "async function requestOwnDeviceVerification(",
    "function currentDeviceVerificationSas("
);
const confirmFlow = section(
    backend,
    "async function confirmDeviceVerification(",
    "async function mismatchDeviceVerification("
);
const mismatchFlow = section(
    backend,
    "async function mismatchDeviceVerification(",
    "async function cancelDeviceVerification("
);
const cancelFlow = section(
    backend,
    "async function cancelDeviceVerification(",
    "function decodeStorageKey("
);
const disposeClient = section(
    backend,
    "async function disposeClient(",
    "async function suspend("
);
const endSession = section(
    backend,
    "async function endAuthenticatedSession(",
    "function cachedMegolmDecryptionFailures("
);
const nativeStatusValidator = section(
    native,
    "function validateProtocolDeviceVerificationStatus(",
    "function validateProtocolDeviceVerificationSas("
);
const nativeSasValidator = section(
    native,
    "function validateProtocolDeviceVerificationSas(",
    "async function requireStarted("
);
const nativeContextGuard = section(
    native,
    "function deviceVerificationContextCurrent(",
    "function deviceVerificationTerminal("
);
const nativeGet = section(
    native,
    "async function getDeviceVerification(",
    "function deviceVerificationDialogDetail("
);
const nativeDialogDetail = section(
    native,
    "function deviceVerificationDialogDetail(",
    "async function verifyCurrentDevice("
);
const nativeVerify = section(
    native,
    "async function verifyCurrentDevice(",
    "async function cancelDeviceVerification("
);
const nativeCancel = section(
    native,
    "async function cancelDeviceVerification(",
    "function registrationAuthenticationFailure("
);
const nativeVerificationBoundary = [
    nativeStatusValidator,
    nativeSasValidator,
    nativeGet,
    nativeDialogDetail,
    nativeVerify,
    nativeCancel
].join("\n");
const nativeTerminate = section(
    native,
    "function terminateWorker(",
    "function failWorker("
);
const publicFlowTypes = section(
    types,
    "export interface MatrixDeviceVerificationFlowDTO {",
    "export interface MatrixDeviceVerificationEmojiDTO {"
);
const snapshotAndEvents = section(
    types,
    "export interface MatrixSnapshot {",
    "export interface MatrixActionResult {"
);
const ordinaryBridgeTypes = types.slice(types.indexOf("export interface MatrixAccountDTO {"));
const publicExportsMatch = native.match(/export \{\s+acceptInvite,[\s\S]*?\n\};/u);
assert.ok(publicExportsMatch, "missing native public export block");
const publicExports = publicExportsMatch[0];

// This feature verifies an existing cross-signing identity. It must never create,
// reset, or directly force trust in one.
const forbiddenCalls = [
    "bootstrapCrossSigning",
    "resetEncryption",
    "setDeviceVerified",
    "crossSignDevice"
] as const;
for (const [name, source] of Object.entries({ backend, native, settings, types, protocol })) {
    for (const forbidden of forbiddenCalls) {
        assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\s*\\(`, "u"),
            `${name} must not invoke the forbidden ${forbidden} trust mutation`);
    }
}
assert.doesNotMatch(backend, /\bisCrossSigningReady\s*\(/u,
    "verification must not require this new device to already have private cross-signing readiness");

// SDK configuration and every method negotiation are SAS-only.
assert.match(backend, /verificationMethods:\s*\[VerificationMethod\.Sas\]/u,
    "the Matrix SDK client must advertise only SAS verification");
assert.equal(occurrenceCount(backend, /verificationMethods:/gu), 1,
    "there must be one authoritative SDK verification-method configuration");
assert.doesNotMatch(backend, /VerificationMethod\.(?:Reciprocate|ScanQrCode|ShowQrCode)/u,
    "QR/reciprocation verification must not be enabled implicitly");
assert.match(bindingGuard, /flow\.request\.chosenMethod !== null[\s\S]*VerificationMethod\.Sas/u,
    "a peer-selected non-SAS method must invalidate the flow");
assert.match(reconcile, /otherPartySupportsMethod\(VerificationMethod\.Sas\)/u);
assert.match(reconcile, /startVerification\(VerificationMethod\.Sas\)/u);

// Raw SDK transaction, verifier, and callback-capability objects stay inside the worker.
for (const workerOnlyType of [
    "VerificationRequest",
    "Verifier",
    "ShowSasCallbacks",
    "VerificationRequestEvent",
    "VerifierEvent"
]) {
    assert.match(backend, new RegExp(`\\b${workerOnlyType}\\b`, "u"),
        `${workerOnlyType} must anchor the isolated worker implementation`);
    for (const [name, source] of Object.entries({ native, settings, types, protocol })) {
        assert.doesNotMatch(source, new RegExp(`\\b${workerOnlyType}\\b`, "u"),
            `${workerOnlyType} must not cross into ${name}`);
    }
}
assert.match(activeState, /readonly request: VerificationRequest;/u);
assert.match(activeState, /verifier\?: Verifier;/u);
assert.match(activeState, /sasCallbacks\?: ShowSasCallbacks;/u);
assert.doesNotMatch(publicFlowTypes, /\b(?:emoji|decimal)\b|MatrixDeviceVerificationSasDTO/u,
    "ordinary verification status must not carry SAS material");
assert.doesNotMatch(snapshotAndEvents, /MatrixDeviceVerification|MatrixDeviceVerificationSasDTO|\b(?:emoji|decimal)\b/u,
    "snapshots and MatrixBridgeEvent must never carry device verification or SAS material");
assert.doesNotMatch(ordinaryBridgeTypes, /MatrixDeviceVerification/u,
    "ordinary bridge DTOs must not indirectly make verification state event/snapshot reachable");
assert.doesNotMatch(settings,
    /MatrixDeviceVerificationSasDTO|deviceVerificationSas|ShowSasCallbacks|(?:verification|deviceVerification)(?:\?|\.)?\.(?:emoji|decimal|sas|sasCallbacks)/u,
    "the Discord settings renderer must not request, read, or render SAS material");
assert.match(protocol, /\| \{ type: "deviceVerificationSas"; verificationId: string; \}/u,
    "SAS must require an explicit, flow-bound worker request");
assert.match(protocol, /\| MatrixDeviceVerificationSasDTO/u,
    "the sanitized SAS DTO belongs only to the private worker response channel");
assert.doesNotMatch(publicExports, /Sas|currentDeviceVerificationSas/u,
    "no native API exposed to the ordinary renderer may return SAS material directly");
for (const publicFunction of [nativeGet, nativeVerify, nativeCancel]) {
    assert.match(publicFunction, /Promise<MatrixDeviceVerificationStatusDTO>/u,
        "every public native verification operation must return status only");
}
assert.match(nativeGet, /callWorker\(\{ type: "deviceVerificationStatus" \}\)/u);
assert.doesNotMatch(nativeGet, /deviceVerificationSas/u,
    "the public status getter must never fetch SAS material");

// The OS-owned dialog has a safe default/cancel action and only the explicit
// affirmative button can reach the worker confirmation command.
assert.match(nativeVerify, /dialog\.showMessageBox\(owner, \{/u,
    "SAS must be displayed in a main-owned dialog bound to the invoking window");
const dialogContract = nativeVerify.match(
    /buttons:\s*(\[[^\r\n]+\]),\s*defaultId:\s*(\d+),\s*cancelId:\s*(\d+),\s*noLink:\s*true/u
);
assert.ok(dialogContract, "missing native verification dialog button contract");
const buttons = JSON.parse(dialogContract[1]) as string[];
const defaultId = Number(dialogContract[2]);
const cancelId = Number(dialogContract[3]);
assert.deepEqual(buttons.map(label => label.replaceAll("’", "'")), [
    "Cancel",
    "They don't match",
    "They match"
]);
assert.equal(defaultId, 0, "dialog default must be Cancel");
assert.equal(cancelId, 0, "Escape/window close must be Cancel");

const actionContract = nativeVerify.match(
    /const command: MatrixWorkerCommand = response === (\d+)\s*\? \{ type: "([^"]+)"[^}]*\}\s*:\s*response === (\d+)\s*\? \{ type: "([^"]+)"[^}]*\}\s*:\s*\{ type: "([^"]+)"[^}]*\}/u
);
assert.ok(actionContract, "missing explicit native-dialog action mapping");
const firstButton = Number(actionContract[1]);
const firstCommand = actionContract[2];
const secondButton = Number(actionContract[3]);
const secondCommand = actionContract[4];
const fallbackCommand = actionContract[5];
const actionForResponse = (response: number) => response === firstButton
    ? firstCommand
    : response === secondButton
        ? secondCommand
        : fallbackCommand;
assert.equal(actionForResponse(2), "confirmDeviceVerification");
assert.equal(actionForResponse(1), "mismatchDeviceVerification");
assert.equal(actionForResponse(0), "cancelDeviceVerification");
assert.equal(actionForResponse(-1), "cancelDeviceVerification",
    "unexpected native responses must fail closed to cancellation");
assert.equal(actionForResponse(defaultId), "cancelDeviceVerification");
assert.equal(actionForResponse(cancelId), "cancelDeviceVerification");
assert.equal(buttons.indexOf("They match"), firstButton,
    "the only confirming response must be the explicitly labelled match button");

const afterDialog = nativeVerify.slice(nativeVerify.indexOf("// A lifecycle transition"));
const afterDialogAnchors = [
    "requireDeviceVerificationContext(attempt);",
    "await callWorker({ type: \"deviceVerificationStatus\" })",
    "status.verification?.verificationId !== verificationId",
    "if (deviceVerificationTerminal(status)) return status;",
    "if (status.verification.phase !== \"sas\") continue;",
    "const command: MatrixWorkerCommand"
];
let previousAnchor = -1;
for (const anchor of afterDialogAnchors) {
    const index = afterDialog.indexOf(anchor);
    assert.ok(index > previousAnchor, `post-dialog stale-flow check is missing or out of order: ${anchor}`);
    previousAnchor = index;
}

// Every capability is bound to the exact worker/client generation, account,
// Matrix transaction, peer device, and opaque local verification ID.
for (const field of [
    "readonly verificationId: string;",
    "readonly generation: number;",
    "readonly client: MatrixClient;",
    "readonly userId: string;",
    "readonly deviceId: string;",
    "readonly transactionId: string;",
    "readonly request: VerificationRequest;",
    "startingSas: boolean;",
    "verifyStarted: boolean;",
    "confirming: boolean;",
    "cancellationRequestedByMe: boolean;",
    "disposed: boolean;"
]) {
    assert.ok(activeState.includes(field), `missing worker verification state anchor: ${field}`);
}
assert.match(currentFlowGuard,
    /!flow\.disposed[\s\S]*activeDeviceVerification === flow[\s\S]*matrixClient === flow\.client[\s\S]*clientGeneration === flow\.generation[\s\S]*activeCredentials\?\.userId === flow\.userId[\s\S]*activeCredentials\.deviceId === flow\.deviceId/u,
    "active-flow checks must bind the exact SDK client generation and account/device");
for (const invariant of [
    "flow.request.transactionId !== flow.transactionId",
    "flow.request.roomId !== undefined",
    "!flow.request.isSelfVerification",
    "flow.request.otherUserId !== flow.userId",
    "otherDeviceId === flow.deviceId",
    "flow.otherDeviceId !== undefined && flow.otherDeviceId !== otherDeviceId"
]) {
    assert.ok(bindingGuard.includes(invariant), `missing Matrix transaction binding invariant: ${invariant}`);
}
assert.match(requestFlow, /request = await context\.cryptoApi\.requestOwnUserVerification\(\)/u);
assert.match(requestFlow,
    /const (?:transactionId = request\.transactionId|\{\s*transactionId(?:,\s*timeout)?\s*\} = request);/u,
    "the SDK transaction ID must be captured as immutable flow identity");
assert.match(requestFlow, /validVerificationTransactionId\(transactionId\)/u,
    "the captured SDK transaction ID must be validated before use");
assert.match(requestFlow, /verificationId: globalThis\.crypto\.randomUUID\(\)/u,
    "the renderer/main capability must not expose the Matrix transaction ID");
assert.match(requestFlow, /request\.on\(VerificationRequestEvent\.Change, (?:onRequestChange|flow\.onRequestChange)\)/u);
assert.match(workerCleanup, /request\.off\(VerificationRequestEvent\.Change, flow\.onRequestChange\)/u);
assert.match(workerVerification, /verifier\.on\(VerifierEvent\.ShowSas, onShowSas\)/u);
assert.match(workerVerification, /verifier\.getShowSasCallbacks\(\)/u,
    "synchronous ShowSas delivery must not be missed");
assert.match(workerVerification, /if \(!flow\.verifyStarted\)[\s\S]*flow\.verifyStarted = true[\s\S]*verifier\.verify\(\)/u,
    "the verifier must start at most once");

// Existing public cross-signing identity is a prerequisite, but this client
// neither bootstraps it nor treats SAS completion itself as proof of trust.
assert.match(trustRefresh, /cryptoApi\.getDeviceVerificationStatus\(before\.userId, before\.deviceId\)/u);
assert.match(trustRefresh, /cryptoApi\.userHasCrossSigningKeys\(before\.userId, true\)/u);
assert.ok(requestFlow.indexOf("if (!initialTrust.crossSigningAvailable)")
    < requestFlow.indexOf("requestOwnUserVerification()"),
"cross-signing availability must be checked before sending a verification request");
const doneCase = reconcile.indexOf("case VerificationPhase.Done:");
const refreshedTrust = reconcile.indexOf("await refreshedCurrentDeviceTrust(false)", doneCase);
const trustDecision = reconcile.indexOf("if (trust.verified)", refreshedTrust);
const doneAssignment = reconcile.indexOf('flow.phase = "done"', trustDecision);
assert.ok(doneCase >= 0 && refreshedTrust > doneCase && trustDecision > refreshedTrust && doneAssignment > trustDecision,
    "Done must follow a fresh SDK trust read, never the SAS phase alone");
assert.match(nativeStatusValidator, /phase === "done" && raw\.verified !== true/u,
    "main must reject a worker claiming Done without refreshed trust");

// Explicit confirmation is the sole path to the callback capability.
assert.equal(occurrenceCount(workerVerification, /sasCallbacks\.confirm\(/gu), 1,
    "SAS confirmation must have exactly one explicit worker call site");
assert.match(confirmFlow, /flow\.phase !== "sas" \|\| !flow\.sasCallbacks \|\| flow\.confirming/u);
assert.match(confirmFlow, /flow\.confirming = true;[\s\S]*flow\.phase = "confirming";[\s\S]*await flow\.sasCallbacks\.confirm\(\)/u);
assert.doesNotMatch(reconcile, /sasCallbacks\.confirm\(/u,
    "SDK phase changes must never auto-confirm SAS");
assert.match(mismatchFlow, /flow\.phase !== "sas"[\s\S]*flow\.sasCallbacks\.mismatch\(\)/u);
assert.match(cancelFlow, /await flow\.request\.cancel\(\)/u);
assert.match(reconcile, /flow\.cancelledByMe = flow\.cancellationRequestedByMe \? true : undefined/u,
    "self-verification must attribute cancellation from the local action, not the shared user ID");
assert.doesNotMatch(reconcile, /cancellingUserId === flow\.userId/u,
    "both devices share a user ID, so it cannot prove which device cancelled");
assert.match(mismatchFlow, /flow\.cancellationRequestedByMe = true;/u);
assert.match(cancelFlow, /flow\.cancellationRequestedByMe = true;/u);

// Sign-out, logout, suspension, worker replacement, and renderer destruction
// all invalidate the flow and release listener/callback capabilities.
assert.match(workerCleanup, /activeDeviceVerification = undefined;[\s\S]*flow\.disposed = true;[\s\S]*releaseDeviceVerificationListeners\(flow\);[\s\S]*flow\.verifier = undefined;/u);
assert.match(workerCleanup, /flow\.verifier\.off\(VerifierEvent\.ShowSas, flow\.onShowSas\)/u);
assert.match(workerCleanup, /flow\.onShowSas = undefined;[\s\S]*flow\.sasCallbacks = undefined;/u);
assert.match(disposeClient, /clientGeneration\+\+;\s*disposeActiveDeviceVerification\(\);/u,
    "client teardown must invalidate and dispose verification before other state");
assert.match(endSession, /await disposeClient\(clearStores\)/u);
assert.match(endSession, /async function signOut[\s\S]*await disposeClient\(false\)/u);
assert.match(endSession, /async function logout[\s\S]*await endAuthenticatedSession\(true\)/u);
for (const guard of [
    "activeDeviceVerification === attempt",
    "accountLifecycleTransitions === 0",
    "accountLifecycleRevision === attempt.lifecycleRevision",
    "workerWindow === attempt.worker",
    "!attempt.worker.isDestroyed()",
    "!attempt.owner.isDestroyed()",
    "!attempt.ownerContents.isDestroyed()",
    "sameAccountBinding(activeWorkerBinding, attempt.binding)"
]) {
    assert.ok(nativeContextGuard.includes(guard), `missing native lifecycle guard: ${guard}`);
}
assert.match(nativeTerminate, /if \(changed\) markAccountLifecycleChange\(\);/u,
    "worker termination must make any open dialog result stale");
assert.match(nativeVerify, /finally \{\s*if \(activeDeviceVerification === attempt\) activeDeviceVerification = null;\s*\}/u);
assert.match(nativeCancel, /attempt\.ownerContents !== event\.sender/u,
    "one renderer must not cancel another renderer's verification attempt");

// SAS data and callback capabilities are memory-only and are never logged.
for (const [name, source] of Object.entries({ workerVerification, nativeVerificationBoundary })) {
    assert.doesNotMatch(source, /\b(?:safeStorage|localStorage|sessionStorage|writeFile|appendFile)\b/u,
        `${name} must not persist verification material`);
    assert.doesNotMatch(source, /\b(?:console|logger)\s*\./u,
        `${name} must not log verification material`);
}

// All flow-changing worker commands are explicit and verification-ID bound.
for (const command of [
    "deviceVerificationSas",
    "confirmDeviceVerification",
    "mismatchDeviceVerification",
    "cancelDeviceVerification"
]) {
    assert.match(protocol, new RegExp(`type: "${command}"; verificationId: string;`, "u"),
        `${command} must carry the opaque verification capability`);
    assert.match(backend, new RegExp(`case "${command}"`, "u"),
        `${command} must have an isolated-worker handler`);
}
assert.match(protocol, /\| \{ type: "deviceVerificationStatus"; \}/u);
assert.match(protocol, /\| \{ type: "requestOwnDeviceVerification"; \}/u);

console.log("Matrix current-device verification security contract passed.");
