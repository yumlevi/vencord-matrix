/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");

function section(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source section: ${start}`);
    return source.slice(startIndex, endIndex);
}

const backendTokenValidator = section(
    backend,
    "function validateRegistrationToken(",
    "function validateRoomId("
);
const nativeTokenValidator = section(
    native,
    "function validateRegistrationToken(",
    "function validateRoomId("
);
for (const validator of [backendTokenValidator, nativeTokenValidator]) {
    assert.match(validator, /typeof value !== "string" \|\| value\.length > 256/u,
        "each trust boundary must bound the untrimmed token input");
    assert.match(validator, /const token = value\.trim\(\);/u,
        "each trust boundary must trim the token independently");
    assert.match(validator, /!token \|\| token\.length > 64 \|\| !\/\^\[A-Za-z0-9\._~-\]\+\$\/\.test\(token\)/u,
        "each trust boundary must validate the trimmed token against the Matrix grammar and limit");
}

const registrationRuntime = section(
    backend,
    "interface RegistrationAuthData",
    "async function registerAccount("
);
const errorPolicy = section(
    backend,
    "function publicRegistrationError(",
    "async function registerWithToken("
);
const nativeRegistrationErrorPolicy = section(
    native,
    "function definitiveRegistrationWorkerErrorCode(",
    "function interruptedAccessMutationError("
);
const nativeRegistrationAuthenticationFailure = section(
    native,
    "function registrationAuthenticationFailure(",
    "async function authenticate("
);
const nativeAuthenticate = section(
    native,
    "async function authenticate(",
    "async function authenticatePreservedDevice("
);
const nativeRegister = section(
    native,
    "async function register(",
    "async function signOut("
);
assert.doesNotMatch(errorPolicy, /safeError\.message|serverMessage|candidate\?\.message/u,
    "registration errors must never reuse arbitrary remote or internal text");
assert.match(errorPolicy, /MATRIX_REGISTRATION_TOKEN_REJECTED/u);
assert.match(errorPolicy, /MATRIX_ACCOUNT_CREATED_AWAITING_APPROVAL/u);
assert.match(errorPolicy, /MATRIX_REGISTRATION_AMBIGUOUS/u);
assert.match(errorPolicy, /registrationHttpStatus\(error\)[\s\S]*>= 500/u,
    "every post-dispatch 5xx response must be treated as ambiguous");
assert.doesNotMatch(errorPolicy, /registrationServerErrcode/u,
    "unknown homeserver errcodes must not be treated as definitive registration failures");

const harness = `
class PublicWorkerError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}
function fail(code: string, message: string): never {
    throw new PublicWorkerError(code, message);
}
function validateString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
        fail("MATRIX_INVALID_ARGUMENT", label + " is invalid.");
    }
    return value;
}
function publicError(error: any) {
    if (error instanceof PublicWorkerError) return { code: error.code, message: error.message };
    if (error && typeof error.errcode === "string") {
        return { code: error.errcode, message: typeof error.error === "string" ? error.error : "" };
    }
    if (error?.name === "AbortError") return { code: "MATRIX_REQUEST_TIMEOUT", message: "timed out" };
    return { code: typeof error?.code === "string" ? error.code : "MATRIX_BACKEND_ERROR", message: "failed" };
}
${backendTokenValidator}
${registrationRuntime}
${nativeRegistrationErrorPolicy}
${nativeRegistrationAuthenticationFailure}
(globalThis as any).__registrationHooks = {
    validateRegistrationToken,
    publicRegistrationError,
    registerWithToken,
    definitiveRegistrationWorkerErrorCode,
    registrationAuthenticationFailure
};
`;
const runtime = transpileModule(harness, {
    compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
}).outputText;
const context: Record<string, unknown> = {};
runInNewContext(runtime, context);
const hooks = context.__registrationHooks as {
    validateRegistrationToken(value: unknown): string;
    publicRegistrationError(error: unknown, dispatched: boolean, accountCreated?: boolean): { code: string; message: string; };
    definitiveRegistrationWorkerErrorCode(code: string): boolean;
    registrationAuthenticationFailure(accountWasCreated: boolean): { code: string; message: string; } | undefined;
    registerWithToken(
        client: { registerRequest(body: Record<string, unknown>): Promise<Record<string, unknown>>; },
        username: string,
        password: string,
        token: string,
        mutationDispatched: () => void
    ): Promise<Record<string, unknown>>;
};

assert.equal(hooks.validateRegistrationToken("  token._~-  "), "token._~-");
for (const invalidToken of ["   ", "a".repeat(65), "not allowed", "a".repeat(257)]) {
    assert.throws(
        () => hooks.validateRegistrationToken(invalidToken),
        (error: any) => error?.code === "MATRIX_INVALID_REGISTRATION_TOKEN"
    );
}

function uia(data: Record<string, unknown>) {
    return { httpStatus: 401, data };
}

async function testRegistrationFlow(): Promise<void> {
const stableStage = "m.login.registration_token";
const dummyStage = "m.login.dummy";
const stableCalls: Array<Record<string, any>> = [];
let stableDispatches = 0;
const stableResult = await hooks.registerWithToken({
    async registerRequest(body) {
        stableCalls.push(body);
        if (stableCalls.length === 1) {
            throw uia({
                session: "registration-session",
                completed: [],
                flows: [{ stages: [stableStage, dummyStage] }]
            });
        }
        if (stableCalls.length === 2) {
            throw uia({
                session: "registration-session",
                completed: [stableStage],
                flows: [{ stages: [stableStage, dummyStage] }]
            });
        }
        return { access_token: "access", device_id: "device", user_id: "@alice:example.test" };
    }
}, "alice", "password", "trimmed-token", () => stableDispatches++);
assert.equal(stableResult.access_token, "access");
assert.equal(stableDispatches, 1, "the registration mutation boundary must be reported exactly once");
assert.equal(stableCalls[0].auth, undefined);
assert.deepEqual({ ...stableCalls[1].auth }, {
    type: stableStage,
    session: "registration-session",
    token: "trimmed-token"
});
assert.deepEqual({ ...stableCalls[2].auth }, { type: dummyStage, session: "registration-session" });

const unstableStage = "org.matrix.msc3231.login.registration_token";
const unstableCalls: Array<Record<string, any>> = [];
await hooks.registerWithToken({
    async registerRequest(body) {
        unstableCalls.push(body);
        if (unstableCalls.length === 1) {
            throw uia({ session: "unstable-session", completed: [], flows: [{ stages: [unstableStage] }] });
        }
        return { access_token: "access", device_id: "device", user_id: "@alice:example.test" };
    }
}, "alice", "password", "unstable-token", () => undefined);
assert.deepEqual({ ...unstableCalls[1].auth }, {
    type: unstableStage,
    session: "unstable-session",
    token: "unstable-token"
});

let rejectedTokenCalls = 0;
await assert.rejects(hooks.registerWithToken({
    async registerRequest() {
        rejectedTokenCalls++;
        if (rejectedTokenCalls === 1) {
            throw uia({ session: "rejected-session", completed: [], flows: [{ stages: [stableStage] }] });
        }
        throw uia({
            session: "rejected-session",
            completed: [],
            flows: [{ stages: [stableStage] }],
            errcode: "M_FORBIDDEN",
            error: "private homeserver detail"
        });
    }
}, "alice", "password", "rejected-token", () => undefined),
(error: any) => error?.code === "MATRIX_REGISTRATION_TOKEN_REJECTED"
    && error?.message === "The registration token was rejected or has expired.");

const sensitiveServerText = "do not expose this server detail";
const rejected = hooks.publicRegistrationError({
    errcode: "M_FORBIDDEN",
    error: sensitiveServerText
}, true);
assert.equal(rejected.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(rejected.message, /Sign in with that username/u);
assert.ok(!rejected.message.includes(sensitiveServerText));

const rejectedTokenStage = hooks.publicRegistrationError({
    code: "MATRIX_REGISTRATION_TOKEN_REJECTED",
    message: sensitiveServerText
}, true);
assert.equal(rejectedTokenStage.code, "MATRIX_REGISTRATION_TOKEN_REJECTED");
assert.equal(rejectedTokenStage.message, "The registration token was rejected or has expired.");

const genericPostDispatch = hooks.publicRegistrationError({
    code: "MATRIX_REGISTRATION_FAILED",
    message: sensitiveServerText
}, true);
assert.equal(genericPostDispatch.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(genericPostDispatch.message, /Sign in with that username/u);

const unknownRemote = hooks.publicRegistrationError({
    errcode: "M_VENDOR_PRIVATE_FAILURE",
    error: sensitiveServerText
}, true);
assert.equal(unknownRemote.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(unknownRemote.message, /Sign in with that username/u);

for (const serverFailure of [
    { httpStatus: 500, errcode: "M_USER_IN_USE", error: sensitiveServerText },
    { httpStatus: 503, errcode: "M_UNKNOWN", error: sensitiveServerText },
    { httpStatus: 502, error: sensitiveServerText }
]) {
    const ambiguous = hooks.publicRegistrationError(serverFailure, true);
    assert.equal(ambiguous.code, "MATRIX_REGISTRATION_AMBIGUOUS");
    assert.match(ambiguous.message, /Sign in with that username/u);
    assert.ok(!ambiguous.message.includes(sensitiveServerText));
}

const knownClientRejection = hooks.publicRegistrationError({
    httpStatus: 400,
    errcode: "M_USER_IN_USE",
    error: sensitiveServerText
}, true);
assert.equal(knownClientRejection.code, "M_USER_IN_USE");
assert.equal(knownClientRejection.message, "That username is already taken.");

let completedCalls = 0;
let completedOutcome: { code: string; message: string; } | undefined;
try {
    await hooks.registerWithToken({
        async registerRequest() {
            completedCalls++;
            throw uia({
                session: "completed-session",
                completed: completedCalls === 1 ? [] : [stableStage],
                flows: [{ stages: [stableStage] }]
            });
        }
    }, "alice", "password", "token", () => undefined);
} catch (error) {
    completedOutcome = hooks.publicRegistrationError(error, true);
}
assert.equal(completedCalls, 2);
assert.equal(completedOutcome?.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(completedOutcome?.message ?? "", /Sign in with that username/u);

let exhaustedCalls = 0;
let exhaustedOutcome: { code: string; message: string; } | undefined;
try {
    await hooks.registerWithToken({
        async registerRequest() {
            exhaustedCalls++;
            throw uia({
                session: "exhausted-session",
                completed: [],
                flows: [{ stages: [stableStage] }]
            });
        }
    }, "alice", "password", "token", () => undefined);
} catch (error) {
    exhaustedOutcome = hooks.publicRegistrationError(error, true);
}
assert.equal(exhaustedCalls, 6);
assert.equal(exhaustedOutcome?.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(exhaustedOutcome?.message ?? "", /Sign in with that username/u);

const timedOut = hooks.publicRegistrationError({
    name: "AbortError",
    message: sensitiveServerText
}, true);
assert.equal(timedOut.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(timedOut.message, /Sign in with that username/u);
assert.ok(!timedOut.message.includes(sensitiveServerText));

for (const malformedData of [null, "malformed"]) {
    const malformedRemote = hooks.publicRegistrationError({
        data: malformedData,
        message: sensitiveServerText
    }, true);
    assert.equal(malformedRemote.code, "MATRIX_REGISTRATION_AMBIGUOUS");
    assert.match(malformedRemote.message, /Sign in with that username/u);
    assert.ok(!malformedRemote.message.includes(sensitiveServerText));
}

const preDispatch = hooks.publicRegistrationError(new Error(sensitiveServerText), false);
assert.equal(preDispatch.code, "MATRIX_REGISTRATION_FAILED");
assert.equal(preDispatch.message, "Account registration could not be started.");

const createdWithoutSession = hooks.publicRegistrationError(new Error(sensitiveServerText), true, true);
assert.equal(createdWithoutSession.code, "MATRIX_REGISTRATION_LOGIN_MISSING");
assert.match(createdWithoutSession.message, /^The account was created/u);

const registerWithTokenSource = section(
    backend,
    "async function registerWithToken(",
    "async function registerAccount("
);
assert.ok(
    registerWithTokenSource.indexOf("mutationDispatched();")
        < registerWithTokenSource.indexOf("client.registerRequest("),
    "the mutation boundary must be emitted before the first registration request"
);
assert.match(registerWithTokenSource, /for \(let attempt = 0; attempt < 6; attempt\+\+\)/u);
assert.match(registerWithTokenSource, /nextSession !== session/u,
    "the UIA session must stay pinned across stages");
assert.match(registerWithTokenSource, /some\(value => !nextCompleted\.has\(value\)\)/u,
    "the UIA completed-stage set must remain monotonic");

assert.match(backend, /case "register": return await registerAccount\(command, mutationDispatched\);/u);
assert.match(backend, /function mutationSignalCommand\([\s\S]*command\.type === "register"/u);
assert.match(native, /case "register":[\s\S]*MATRIX_REGISTRATION_AMBIGUOUS[\s\S]*Sign in with that username/u);
for (const code of [
    "MATRIX_REGISTRATION_TOKEN_REJECTED",
    "M_USER_IN_USE",
    "MATRIX_REGISTRATION_AMBIGUOUS"
]) {
    assert.equal(hooks.definitiveRegistrationWorkerErrorCode(code), true);
}
for (const code of ["MATRIX_REGISTRATION_FAILED", "M_UNKNOWN", "M_VENDOR_PRIVATE_FAILURE", "MATRIX_BACKEND_ERROR"]) {
    assert.equal(hooks.definitiveRegistrationWorkerErrorCode(code), false);
}
assert.equal(hooks.registrationAuthenticationFailure(false), undefined);
const invalidCreatedSession = hooks.registrationAuthenticationFailure(true);
assert.equal(invalidCreatedSession?.code, "MATRIX_REGISTRATION_AMBIGUOUS");
assert.match(invalidCreatedSession?.message ?? "", /Sign in with that username/u);
assert.match(native, /pending\.commandType === "register" && pending\.mutationDispatched[\s\S]*!definitiveRegistrationWorkerErrorCode\(message\.error\.code\)[\s\S]*MATRIX_REGISTRATION_AMBIGUOUS/u,
    "native must override unknown worker failures after registration dispatch");
assert.equal(
    nativeAuthenticate.match(/registrationAuthenticationFailure\(accountWasCreated\)/gu)?.length,
    2,
    "invalid or mismatched post-registration credentials must both become sign-in-first failures"
);
assert.match(nativeAuthenticate, /const workerCommand = command\(storageKey\);[\s\S]*callWorker\(workerCommand\)[\s\S]*finally \{[\s\S]*scrubCommand\?\.\(workerCommand\);/u,
    "native must scrub the exact worker-command clone as soon as authentication settles");
assert.match(nativeRegister, /const registration = validateRegistration\(input\);[\s\S]*input\.password = "";[\s\S]*input\.registrationToken = "";[\s\S]*try \{[\s\S]*registration: \{ \.\.\.registration \}[\s\S]*command => \{[\s\S]*command\.registration\.password = "";[\s\S]*command\.registration\.registrationToken = "";[\s\S]*\} finally \{[\s\S]*registration\.password = "";[\s\S]*registration\.registrationToken = "";/u,
    "register must promptly scrub its IPC input and exact command clone, with unconditional preflight cleanup of the validated clone");
assert.match(native, /function mutationSignalCommandType\([\s\S]*commandType === "register"/u);
assert.match(native, /function accessMutationRequiresDispatchSignal\([\s\S]*commandType === "register"/u);
assert.match(native, /pending\.mutationDispatched = true;[\s\S]*commandTimer\(pending\.commandType, false, true\)/u,
    "the native timeout must switch to the post-dispatch ambiguity policy");
assert.match(native, /case "register":[\s\S]*request\.registration\.password = "";[\s\S]*request\.registration\.registrationToken = "";/u,
    "native must also erase its private IPC registration request clone");
assert.match(backend, /case "register":[\s\S]*command\.registration\.password = "";[\s\S]*command\.registration\.registrationToken = "";/u,
    "the worker must erase its registration command clone");
}

await testRegistrationFlow();
console.log("Matrix registration hardening tests passed.");
