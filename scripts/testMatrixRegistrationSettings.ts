/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");

assert.match(settings, /const operationBusy = useRef\(false\);/u,
    "account mutations need a synchronous single-flight guard");
assert.match(settings, /if \(operationBusy\.current\) return;[\s\S]*operationBusy\.current = true;/u,
    "rapid double clicks must not queue two registrations");
assert.match(settings, /finally \{[\s\S]*setBusy\(false\);[\s\S]*operationBusy\.current = false;/u,
    "the account-operation lock must be released after UI cleanup");
assert.match(settings, /const trimmedRegistrationToken = registrationToken\.trim\(\);/u,
    "copy/paste whitespace must be removed from spec-bounded registration tokens");
assert.match(settings, /registrationToken: trimmedRegistrationToken/u,
    "only the trimmed registration token may cross the native boundary");
assert.match(settings, /async function finishAuthentication[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*finally \{[\s\S]*clearSecrets\(\);/u,
    "passwords and tokens must be cleared after both success and failure");
assert.match(settings, /className="vc-matrix-auth-error" role="alert"/u,
    "registration failures must remain visible beside the form");
assert.match(settings, /"Creating account\.\.\."/u,
    "the registration button must expose its in-flight state");

console.log("Matrix registration settings fixtures passed.");
