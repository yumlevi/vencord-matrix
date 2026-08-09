/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    type MatrixSpaceSearchGraphRoom,
    searchMatrixSpaceGraph
} from "../src/plugins/matrixBridge/spaceSearchGraph";

const rooms: MatrixSpaceSearchGraphRoom[] = [
    { roomId: "!root:test", space: true, declaredChildIds: ["!category:test"], parentIds: [] },
    { roomId: "!category:test", space: true, declaredChildIds: ["!a:test", "!root:test"], parentIds: ["!root:test"] },
    { roomId: "!c:test", space: false, declaredChildIds: [], parentIds: ["!category:test"] },
    { roomId: "!b:test", space: false, declaredChildIds: [], parentIds: ["!root:test"] },
    { roomId: "!a:test", space: false, declaredChildIds: [], parentIds: [] }
];

assert.deepEqual(
    searchMatrixSpaceGraph("!root:test", rooms, 200, 200, 16),
    { roomIds: ["!b:test", "!a:test", "!c:test"], limited: false }
);
assert.deepEqual(
    searchMatrixSpaceGraph("!root:test", [...rooms].reverse(), 200, 200, 16),
    { roomIds: ["!b:test", "!a:test", "!c:test"], limited: false }
);
assert.deepEqual(
    searchMatrixSpaceGraph("!root:test", rooms, 200, 200, 1),
    { roomIds: ["!b:test"], limited: true }
);
assert.deepEqual(
    searchMatrixSpaceGraph("!root:test", rooms, 2, 200, 16),
    { roomIds: ["!b:test", "!a:test"], limited: true }
);

const wideSpaceIds = Array.from({ length: 250 }, (_, index) => `!wide-space-${index}:test`);
const wideRoomIds = Array.from({ length: 250 }, (_, index) => `!wide-room-${index}:test`);
const wideRooms: MatrixSpaceSearchGraphRoom[] = [
    { roomId: "!wide-root:test", space: true, declaredChildIds: wideSpaceIds, parentIds: [] },
    ...wideSpaceIds.map((roomId, index) => ({
        roomId,
        space: true,
        declaredChildIds: [wideRoomIds[index]],
        parentIds: ["!wide-root:test"]
    })),
    ...wideRoomIds.map((roomId, index) => ({
        roomId,
        space: false,
        declaredChildIds: [],
        parentIds: [wideSpaceIds[index]]
    }))
];
assert.deepEqual(
    searchMatrixSpaceGraph("!wide-root:test", wideRooms, 200, 20, 16),
    { roomIds: wideRoomIds.slice(0, 19), limited: true }
);
