/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { matrixErrorCode } from "../src/plugins/matrixBridge/errorCode";

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
