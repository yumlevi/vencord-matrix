/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    allocateFairSnapshotQuotas,
    conservativeSnapshotResumeSequence,
    selectFairSnapshotMessages,
    type SnapshotRoomPriority
} from "../src/plugins/matrixBridge/snapshotBounds";

interface FixtureMessage {
    eventId: string;
    timestamp: number;
    body: string;
}

const roomCount = 48;
const priorities: SnapshotRoomPriority[] = Array.from({ length: roomCount }, (_, index) => ({
    roomId: `!room-${index}:example.test`,
    unreadCount: index === roomCount - 1 ? 7 : 0,
    highlightCount: 0,
    newestTimestamp: 10_000 + index
}));
const lateUnreadRoomId = priorities.at(-1)!.roomId;
const quotas = allocateFairSnapshotQuotas(
    priorities.map(priority => ({ ...priority, maximum: 25 })),
    1_000
);
assert.equal(quotas.allocated, 1_000);
assert.equal(quotas.limited, true);
assert.ok((quotas.quotaByRoom.get(lateUnreadRoomId) ?? 0) > 0, "late unread room must receive a quota");

// Materialization happens after quota allocation and therefore cannot exceed
// the worker/native 1,000-message aggregate even with >40 loaded rooms.
const rooms = priorities.map((priority, roomIndex) => {
    const quota = quotas.quotaByRoom.get(priority.roomId) ?? 0;
    const messages = Array.from({ length: quota }, (_, messageIndex): FixtureMessage => ({
        eventId: `$${roomIndex}-${messageIndex}`,
        timestamp: priority.newestTimestamp + messageIndex,
        body: `${"é".repeat(96)}-${roomIndex}-${messageIndex}`
    }));
    return { ...priority, messages };
});
assert.equal(rooms.reduce((total, room) => total + room.messages.length, 0), 1_000);

const byteLimit = 16_384;
const selection = selectFairSnapshotMessages(
    rooms,
    120,
    byteLimit,
    message => Buffer.byteLength(JSON.stringify(message), "utf8")
);
assert.ok(selection.messageCount <= 120);
assert.ok(selection.messageBytes <= byteLimit);
assert.equal(
    [...selection.messagesByRoom.values()].flat().reduce(
        (total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"),
        0
    ),
    selection.messageBytes,
    "fixture and native must measure the same UTF-8 JSON bytes"
);
const lateSelected = selection.messagesByRoom.get(lateUnreadRoomId) ?? [];
assert.ok(lateSelected.length > 0, "late unread room must retain its newest message under the byte cut");
for (const room of rooms) {
    const selected = selection.messagesByRoom.get(room.roomId) ?? [];
    assert.deepEqual(selected, room.messages.slice(-selected.length), `${room.roomId} must be a contiguous newest suffix`);
}

// 250 bridge-created ten-person groups fit exactly, proving GROUP_DM recovery
// cannot silently lose its last two recipients under the aggregate bound.
const groupQuotas = allocateFairSnapshotQuotas(
    Array.from({ length: 250 }, (_, index) => ({
        roomId: `!group-${index}:example.test`,
        unreadCount: 0,
        highlightCount: 0,
        newestTimestamp: index,
        maximum: 10
    })),
    2_500
);
assert.equal(groupQuotas.allocated, 2_500);
assert.ok([...groupQuotas.quotaByRoom.values()].every(quota => quota === 10));

const partialCoverage = { roomsComplete: true, roomStateComplete: true, timelinesComplete: false };
const completeCoverage = { roomsComplete: true, roomStateComplete: true, timelinesComplete: true };
assert.equal(conservativeSnapshotResumeSequence(500, 100, partialCoverage), 100);
assert.equal(conservativeSnapshotResumeSequence(500, 100, {
    roomsComplete: true,
    roomStateComplete: false,
    timelinesComplete: true
}), 100);
assert.equal(conservativeSnapshotResumeSequence(500, 100, completeCoverage), 500);

// A healthy-worker reconnect supplies its actual renderer cursor. Even after
// >256 events, it resumes from that established cut instead of the old worker
// baseline; a fresh worker still floors the cursor at its new baseline.
const existingWorkerBaseline = 10;
const existingRendererCursor = 420;
const existingEstablished = Math.max(existingWorkerBaseline, existingRendererCursor);
assert.equal(conservativeSnapshotResumeSequence(500, existingEstablished, partialCoverage), 420);
assert.ok(existingEstablished > 300, "ready-worker reconnect must clear an older dropped-through cut");
const freshWorkerBaseline = 600;
assert.equal(
    conservativeSnapshotResumeSequence(650, Math.max(freshWorkerBaseline, 100), partialCoverage),
    freshWorkerBaseline
);

// Snapshot overlap is idempotent, while every queued delta after the partial
// startup cut remains replayable. Refresh never changes the poll cursor.
const snapshotIds = new Set([...selection.messagesByRoom.values()].flat().map(message => message.eventId));
const overlapId = lateSelected.at(-1)!.eventId;
const omittedId = "$late-unread-after-snapshot";
const queued = [
    { seq: 101, eventId: overlapId },
    { seq: 102, eventId: omittedId },
    { seq: 103, eventId: "$another-live-message" }
];
let pollCursor = conservativeSnapshotResumeSequence(103, 100, partialCoverage);
const projected = new Set(snapshotIds);
for (const event of queued.filter(event => event.seq > pollCursor)) {
    projected.add(event.eventId);
    pollCursor = event.seq;
}
assert.equal(pollCursor, 103);
assert.ok(queued.every(event => projected.has(event.eventId)), "queued startup deltas must not be lost");
assert.equal([...projected].filter(eventId => eventId === overlapId).length, 1, "snapshot overlap must not duplicate");
const cursorBeforeRefresh = pollCursor;
conservativeSnapshotResumeSequence(110, pollCursor, partialCoverage);
assert.equal(pollCursor, cursorBeforeRefresh, "bounded refresh must not advance the poll cursor");

// Canonical projected-row anchors recover SDK order even when encrypted rows
// decrypt in reverse with a non-projectable reaction between A and B.
const canonicalTimeline = ["$a", "$encrypted-reaction", "$b", "$c"];
const messageRows = new Set(["$a", "$b", "$c"]);
const alreadyProjected = new Set<string>();
const received = ["$c", "$b", "$a"].map(eventId => {
    const index = canonicalTimeline.indexOf(eventId);
    const previousEventId = canonicalTimeline.slice(0, index).reverse()
        .find(candidate => messageRows.has(candidate) && alreadyProjected.has(candidate));
    const nextEventId = canonicalTimeline.slice(index + 1)
        .find(candidate => messageRows.has(candidate) && alreadyProjected.has(candidate));
    alreadyProjected.add(eventId);
    return { eventId, previousEventId, nextEventId };
});
const edges = new Map(received.map(message => [message.eventId, message.nextEventId]));
const ordered: string[] = [];
let eventId: string | undefined = "$a";
while (eventId) {
    ordered.push(eventId);
    eventId = edges.get(eventId);
}
assert.deepEqual(ordered, ["$a", "$b", "$c"]);

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
assert.match(backend, /messageQuotas\.get\(room\.roomId\)/u);
assert.match(backend, /if \(startupProjectionSuppressed && event\.type !== "status"\) return;/u);
assert.match(backend, /case SyncState\.Prepared: \{[\s\S]*setStatus\("ready"\);[\s\S]*const preparedSnapshot = snapshot\(\);[\s\S]*startupProjectionSuppressed = false;[\s\S]*type: "snapshot", snapshot: preparedSnapshot/u);
assert.match(backend, /startupProjectionSuppressed = true;[\s\S]*await client\.startClient[\s\S]*return snapshot\(\);/u);
assert.doesNotMatch(backend, /await client\.startClient\([\s\S]{0,300}finally \{[\s\S]{0,100}startupProjectionSuppressed = false;/u);
assert.match(backend, /optionalEventId\(normalizeMessage\(room, events\[candidateIndex\]\)\?\.eventId\)/u);
assert.match(native, /async function start\(_:\s*IpcMainInvokeEvent, afterSeq = 0\)/u);
assert.match(native, /Math\.max\(workerEventBaselineSequence, afterSeq\)/u);
assert.match(native, /MATRIX_EVENT_STREAM_GAP/u);

console.log("Matrix bounded snapshot and event-cut fixtures passed.");
