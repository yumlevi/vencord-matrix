/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { matrixErrorCode, matrixServerUnavailableHttpStatus } from "../src/plugins/matrixBridge/errorCode";

assert.equal(matrixErrorCode(Object.assign(new Error("expired"), { name: "MATRIX_STALE_CURSOR" })), "MATRIX_STALE_CURSOR");
assert.equal(matrixErrorCode({ code: "M_FORBIDDEN" }), "M_FORBIDDEN");
assert.equal(matrixErrorCode(new Error(
    "Error invoking remote method 'VencordPluginNative_MatrixBridge_paginate': MATRIX_STALE_CURSOR: The cursor expired."
)), "MATRIX_STALE_CURSOR");
assert.equal(matrixErrorCode(
    "Error invoking remote method 'x': MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS: Check before retrying."
), "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS");
assert.equal(matrixErrorCode(new Error("A message merely mentions MATRIX_STALE_CURSOR without a code delimiter")), undefined);
assert.equal(matrixErrorCode({ name: "Error", message: "ordinary failure" }), undefined);
assert.equal(matrixErrorCode({ code: "MATRIX_bad" }), undefined);

const maximumCode = `MATRIX_${"A".repeat(121)}`;
const oversizedCode = `${maximumCode}A`;
assert.equal(maximumCode.length, 128);
assert.equal(oversizedCode.length, 129);
assert.equal(matrixErrorCode({ code: maximumCode }), maximumCode);
assert.equal(matrixErrorCode({ code: oversizedCode }), undefined);
assert.equal(matrixErrorCode(new Error(`IPC: ${maximumCode}: bounded`)), maximumCode);
assert.equal(matrixErrorCode(new Error(`IPC: ${oversizedCode}: oversized`)), undefined);

for (const status of [500, 502, 503, 599]) assert.equal(matrixServerUnavailableHttpStatus(status), true);
for (const status of [400, 401, 429, 499, 600, NaN, Infinity, "502"]) {
    assert.equal(matrixServerUnavailableHttpStatus(status), false);
}
