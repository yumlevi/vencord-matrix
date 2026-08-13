/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const secureView = readFileSync("src/plugins/matrixBridge/secureView.ts", "utf8");
const preload = readFileSync("src/plugins/matrixBridge/secureViewPreload.ts", "utf8");
const styles = readFileSync("src/plugins/matrixBridge/secureView.css", "utf8");

function section(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(from, -1, `missing section start: ${start}`);
    assert.notEqual(to, -1, `missing section end: ${end}`);
    return source.slice(from, to);
}

const scrub = section(secureView, "function scrubAuthSecrets()", "function restoreAuthIdentity(");
for (const field of ["password", "confirmPassword", "registrationToken", "accessToken"]) {
    assert.match(scrub, new RegExp(`authForm\\.${field} = ""`, "u"), `${field} must be scrubbed`);
}
assert.doesNotMatch(scrub, /authForm\.(?:homeserver|username)\s*=/u,
    "secret scrubbing must not erase the retained public identity fields");

const restore = section(secureView, "function restoreAuthIdentity(", "function clearSensitiveUiState(");
assert.match(restore, /authForm\.homeserver = identity\.homeserver/u);
assert.match(restore, /authForm\.username = identity\.username/u);
assert.match(restore, /scrubAuthSecrets\(\)/u);
assert.doesNotMatch(restore, /identity\.(?:password|confirmPassword|registrationToken|accessToken)/u,
    "failure recovery may retain only homeserver and username");

const auth = section(secureView, "function renderAuth()", "function renderCreateSpaceOverlay(");
assert.doesNotMatch(auth, /requestSubmit\(/u,
    "the auth button must not combine requestSubmit with native submit behavior");
assert.equal((auth.match(/form\.addEventListener\("submit"/gu) ?? []).length, 1,
    "the auth form must have exactly one submit path");
assert.match(auth, /textElement\(\s*"button",\s*"matrix-button matrix-button-primary"/u);
assert.match(auth, /submit\.type = "submit"/u);

const inlineError = auth.indexOf('textElement("p", "matrix-auth-error", authError)');
const alertRole = auth.indexOf('error.setAttribute("role", "alert")', inlineError);
const appendError = auth.indexOf("form.append(error)", alertRole);
const appendSubmit = auth.indexOf("form.append(submit)", appendError);
assert.ok(inlineError >= 0 && alertRole > inlineError && appendError > alertRole && appendSubmit > appendError,
    "the persistent role=alert must be immediately adjacent to the submit control");
assert.match(styles, /\.matrix-auth-error\s*\{[\s\S]*color:\s*var\(--matrix-danger\)/u);

const retained = section(auth, "const retainedIdentity = {", "const server =");
assert.match(retained, /homeserver: authForm\.homeserver/u);
assert.match(retained, /username: authForm\.username/u);
assert.doesNotMatch(retained, /password|confirmPassword|registrationToken|accessToken/u);
assert.match(auth, /const registrationToken = authForm\.registrationToken\.trim\(\)/u,
    "registration tokens must be normalized before crossing the private boundary");

const failure = section(auth, ".catch(async error => {", ".finally(() => {");
assert.match(failure, /const message = errorText\(error\)/u);
assert.match(failure, /await requestTransitionBootstrap\(transition\)/u);
assert.doesNotMatch(failure, /if\s*\(await requestTransitionBootstrap/u,
    "a bootstrap false result must not suppress the current operation error");
assert.match(failure, /restoreAuthIdentity\(retainedIdentity\)[\s\S]*authError = message/u);
assert.doesNotMatch(failure, /showToast\(/u,
    "authentication failures need persistent inline feedback, not an expiring toast");

const clone = section(preload, "function cloneAuthenticationRequest(", "function scrubClonedAuthenticationRequest(");
assert.match(clone, /case "login":[\s\S]*login: \{ \.\.\.request\.login \}/u);
assert.match(clone, /case "register":[\s\S]*registration: \{ \.\.\.request\.registration \}/u);
const preloadScrub = section(preload, "function scrubClonedAuthenticationRequest(", "const host:");
assert.match(preloadScrub, /request\.login\.password = ""/u);
assert.match(preloadScrub, /request\.login\.accessToken = ""/u);
assert.match(preloadScrub, /request\.registration\.password = ""/u);
assert.match(preloadScrub, /request\.registration\.registrationToken = ""/u);
const invoke = section(preload, "request<Type extends MatrixSecureViewRequestType>", "onEvent(callback:");
assert.match(invoke, /const clonedRequest = cloneAuthenticationRequest\(request\)/u);
assert.match(invoke, /request: clonedRequest/u);
assert.match(invoke, /return result\.finally\(\(\) => \{[\s\S]*scrubClonedAuthenticationRequest\(clonedRequest\)/u,
    "the IPC authentication clone must be scrubbed on success and failure");
assert.match(invoke, /scrubClonedAuthenticationRequest\(clonedRequest\)[\s\S]*scrubClonedAuthenticationRequest\(request\)/u,
    "the context-bridge request clone retained by finally must also be scrubbed");
assert.doesNotMatch(preload, /console\.|logger\.|registrationToken\s*\)/u,
    "the preload must never log or interpolate registration secrets");

console.log("Matrix registration UX/privacy contracts passed.");
