/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const styles = readFileSync("src/plugins/matrixBridge/style.css", "utf8");

const connectedAccount = settings.indexOf("<Heading tag=\"h4\">Connected account</Heading>");
const verificationCard = settings.indexOf("{renderDeviceVerification()}", connectedAccount);
const reconnectCard = settings.indexOf("{reauthenticationRequired && (", connectedAccount);

assert.ok(connectedAccount >= 0 && verificationCard > connectedAccount && reconnectCard > verificationCard,
    "device verification belongs directly after the connected-account card");
assert.match(settings, /await Native\.getDeviceVerification\(\)/u,
    "the durable verification status must be refreshed independently of the long-running action");
assert.match(settings, /await Native\.verifyCurrentDevice\(\)/u,
    "the start button must use the bounded native verification operation");
assert.match(settings, /await Native\.cancelDeviceVerification\(\)/u,
    "an in-progress verification must remain cancellable");
assert.match(settings, /role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/u,
    "phase changes need one persistent accessible live status");
assert.match(settings, /className="vc-matrix-device-verification-error" role="alert"/u,
    "verification failures must remain visible as an alert");
assert.match(settings, /Security codes are handled only by a native Matrix comparison dialog and are never rendered here\./u,
    "the Discord renderer must disclose the native comparison boundary");
assert.doesNotMatch(settings, /deviceVerification(?:\?|\.)\.(?:emoji|decimal|sas)|verification(?:\?|\.)\.(?:emoji|decimal|sas)/u,
    "the renderer must never read or render SAS material");
assert.match(settings, /nextVerification\.deviceId !== expectedDeviceId/u,
    "refreshed trust must remain bound to the displayed device");
assert.match(settings, /result\.deviceId !== expectedDeviceId/u,
    "mutation results must remain bound to the displayed device");
assert.match(styles, /\.vc-matrix-device-verification-card[\s\S]*display: grid/u);
assert.match(styles, /\.vc-matrix-device-verification-status[\s\S]*display: grid/u);
assert.match(styles, /\.vc-matrix-device-verification-identity code,[\s\S]*unicode-bidi: isolate/u,
    "opaque device IDs need an isolated left-to-right presentation");

console.log("Matrix device verification renderer UI fixtures passed.");
