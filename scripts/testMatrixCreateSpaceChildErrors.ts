/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { ConnectionError, HTTPError, MatrixError } from "matrix-js-sdk";

import { isDefinitiveCreateRoomRejection } from "../src/plugins/matrixBridge/createSpaceChildError";

const definitive = [
    new MatrixError({ errcode: "M_FORBIDDEN", error: "denied" }, 403),
    { httpStatus: 400, data: { errcode: "M_BAD_JSON" } },
    { httpStatus: 403, data: { errcode: "M_FORBIDDEN" } },
    { httpStatus: 404 },
    { httpStatus: 429, data: { errcode: "M_LIMIT_EXCEEDED" } }
];
const ambiguous = [
    new ConnectionError("connection reset"),
    new HTTPError("server failed", 503),
    { name: "ConnectionError" },
    Object.assign(new Error("timed out"), { name: "AbortError" }),
    { httpStatus: 500 },
    { httpStatus: 503, data: { errcode: "M_UNKNOWN" } },
    { httpStatus: "403" },
    null
];

for (const error of definitive) assert.equal(isDefinitiveCreateRoomRejection(error), true);
for (const error of ambiguous) assert.equal(isDefinitiveCreateRoomRejection(error), false);
