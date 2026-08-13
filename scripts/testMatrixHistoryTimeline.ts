/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EventType, MatrixEvent, RelationType } from "matrix-js-sdk";

import {
    advanceMatrixHistoryToken,
    createMatrixHistoryRequestRegistry,
    createMatrixLiveDecryptionTracker,
    isCurrentMatrixTimelineGeneration,
    isMainMatrixTimelineReset
} from "../src/plugins/matrixBridge/historyTimeline";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");

function functionSlice(source: string, name: string, nextName: string): string {
    const start = source.indexOf(`${name}(`);
    const end = source.indexOf(`${nextName}(`, start + name.length + 1);
    assert.notEqual(start, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${nextName} must follow ${name}`);
    return source.slice(start, end);
}

const mainTimelineSet = {};
const filteredTimelineSet = {};
const threadTimelineSet = {};
const room = { getUnfilteredTimelineSet: () => mainTimelineSet };

assert.equal(isMainMatrixTimelineReset(room, mainTimelineSet), true);
assert.equal(isMainMatrixTimelineReset(room, filteredTimelineSet), false);
assert.equal(isMainMatrixTimelineReset(room, threadTimelineSet), false);

let generation = 7;
const cursors = new Set(["first", "second"]);
for (const emittedTimelineSet of [filteredTimelineSet, threadTimelineSet]) {
    if (isMainMatrixTimelineReset(room, emittedTimelineSet)) {
        generation++;
        cursors.clear();
    }
}
assert.equal(generation, 7);
assert.equal(cursors.size, 2);

if (isMainMatrixTimelineReset(room, mainTimelineSet)) {
    generation++;
    cursors.clear();
}
assert.equal(generation, 8);
assert.equal(cursors.size, 0);
assert.equal(isCurrentMatrixTimelineGeneration(8, generation), true);
assert.equal(isCurrentMatrixTimelineGeneration(7, generation), false);

async function verifyHistoryRequestRegistry(): Promise<void> {
    const requests = createMatrixHistoryRequestRegistry<string>();
    const first = requests.acquire("room", 1);
    const duplicate = requests.acquire("room", 1);
    assert.equal(first.owner, true);
    assert.equal(duplicate.owner, false);
    assert.equal(duplicate.lease, first.lease, "duplicate renderer fetches must share one owner");

    let completed = false;
    void duplicate.lease.completion.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    first.lease.release();
    await duplicate.lease.completion;
    assert.equal(completed, true);

    const stale = requests.acquire("room", 2);
    const replacement = requests.acquire("room", 3);
    assert.equal(replacement.owner, true, "a new bridge generation must replace stale in-flight work");
    await stale.lease.completion;
    assert.equal(stale.lease.isActive(), false);
    assert.equal(replacement.lease.isActive(), true);
    stale.lease.release();
    assert.equal(requests.acquire("room", 3).owner, false, "stale cleanup must not clear its replacement");
    requests.cancel("room");
    await replacement.lease.completion;

    const one = requests.acquire("one", 4);
    const two = requests.acquire("two", 4);
    requests.clear();
    await Promise.all([one.lease.completion, two.lease.completion]);
}

const seenHistoryTokens = new Set(["token-a"]);
assert.equal(advanceMatrixHistoryToken("token-a", "token-b", seenHistoryTokens), "token-b");
assert.equal(advanceMatrixHistoryToken("token-b", "token-a", seenHistoryTokens), null, "token cycles must terminate");
assert.equal(advanceMatrixHistoryToken("token-b", "token-b", seenHistoryTokens), null);
assert.equal(advanceMatrixHistoryToken("token-b", null, seenHistoryTokens), null);

const paginateStart = backend.indexOf("async function paginate(");
const paginateEnd = backend.indexOf("interface ValidatedSearchRequest", paginateStart);
assert.notEqual(paginateStart, -1);
assert.notEqual(paginateEnd, -1);
const paginate = backend.slice(paginateStart, paginateEnd);
assert.match(paginate, /seenTokens[\s\S]*advanceMatrixHistoryToken[\s\S]*token = null;[\s\S]*end = true/u);
assert.match(bridge, /paginationRequestsByRoom\.acquire[\s\S]*await paginationRequest\.lease\.completion/u);
assert.match(bridge, /failedHistoryLoad[\s\S]*completeProjectionHistoryRequest/u);

const tracker = createMatrixLiveDecryptionTracker<object>();
const liveAndIsolated = {};
tracker.mark(liveAndIsolated);
assert.equal(tracker.consume(liveAndIsolated, true), "live", "a live arrival must outrank an isolated fetch");
tracker.markFailure(liveAndIsolated);
assert.equal(tracker.consume(liveAndIsolated, false), "update", "a later key retry must update the live placeholder");
assert.equal(tracker.consumeFailure(liveAndIsolated), true, "a recovered live failure must replay once");
assert.equal(tracker.consumeFailure(liveAndIsolated), false, "a recovered live failure must not replay twice");
const discarded = {};
tracker.mark(discarded);
tracker.markFailure(discarded);
tracker.discard(discarded);
assert.equal(tracker.consume(discarded, false), "update");
assert.equal(tracker.consumeFailure(discarded), false, "discard must prevent a removed failure from replaying");
assert.equal(tracker.consume({}, true), "isolated");
assert.equal(tracker.consume({}, false), "update");
assert.equal(tracker.consumeFailure({}), false, "detached events must not become recovered live failures");

const timelineHandler = functionSlice(backend, "function handleTimelineEvent", "function attachClientListeners");
assert.match(timelineHandler, /removed \|\| event\.status === "cancelled"[\s\S]*liveDecryptionEvents\.discard\(event\)/u);
assert.ok(
    timelineHandler.indexOf("event.getWireType() === EventType.RoomMessageEncrypted")
        < timelineHandler.indexOf("const type = event.getType()"),
    "wire-encrypted live events must be deferred before decrypted type/relation routing"
);
assert.match(timelineHandler, /liveDecryptionEvents\.mark\(event\)/u);
assert.match(timelineHandler, /type === EventType\.Reaction[\s\S]*RelationType\.Annotation/u);
assert.match(timelineHandler, /relation\?\.rel_type === RelationType\.Replace/u);
const normalizer = functionSlice(backend, "function normalizeMessage", "function normalizeMember");
assert.match(normalizer, /event\.isDecryptionFailure\(\)[\s\S]*Unable to decrypt this message\.[\s\S]*message\.decryptionFailure = true/u);

const clientListeners = functionSlice(backend, "function attachClientListeners", "async function disposeClient");
const decryptedListenerStart = clientListeners.indexOf("client.on(MatrixEventEvent.Decrypted");
const decryptedListenerEnd = clientListeners.indexOf("client.on(MatrixEventEvent.Replaced", decryptedListenerStart);
assert.notEqual(decryptedListenerStart, -1, "the decrypted listener must exist");
assert.notEqual(decryptedListenerEnd, -1, "the replaced listener must follow the decrypted listener");
const decryptedListener = clientListeners.slice(decryptedListenerStart, decryptedListenerEnd);
assert.match(decryptedListener, /liveDecryptionEvents\.consume\(event, isolatedDecryptionEvents\.has\(event\)\)/u);
assert.match(
    decryptedListener,
    /disposition === "isolated"[\s\S]*disposition === "live"[\s\S]*isolatedDecryptionEvents\.delete\(event\)[\s\S]*event\.isDecryptionFailure\(\)[\s\S]*liveDecryptionEvents\.markFailure\(event\)[\s\S]*handleTimelineEvent\(event, room\)/u
);
assert.match(
    decryptedListener,
    /const recoveredLiveFailure = !event\.isDecryptionFailure\(\)[\s\S]*liveDecryptionEvents\.consumeFailure\(event\)[\s\S]*if \(recoveredLiveFailure && !message\)[\s\S]*type: "redact"[\s\S]*handleTimelineEvent\(event, room\)/u,
    "a successfully recovered relation must clear its placeholder before full routing"
);
assert.match(
    decryptedListener,
    /if \(disposition === "isolated" && !recoveredLiveFailure\) return;/u,
    "a canonical live failure recovery must outrank a simultaneous isolated fetch"
);
assert.equal(
    decryptedListener.match(/handleTimelineEvent\(event, room\)/gu)?.length,
    2,
    "only an initial live decrypt or a recovered live failure may use full routing"
);
assert.match(decryptedListener, /type: "edit"/u, "all other non-live decryptions must remain update-only");

const convergence = functionSlice(backend, "function convergeReactions", "function handleTimelineEvent");
assert.ok(convergence.indexOf("invalidateReactionMap(room)") < convergence.indexOf("emitReactions(room, eventId)"));
const reaction = functionSlice(backend, "async function react", "async function typing");
assert.match(reaction, /if \(command\.remove\)[\s\S]*await matrixClient!\.redactEvent[\s\S]*convergeReactions\(room, eventId\)/u);
assert.match(reaction, /if \(existingEventId\)[\s\S]*convergeReactions\(room, eventId\)[\s\S]*return \{ eventId: existingEventId \}/u);
assert.match(reaction, /await matrixClient!\.sendEvent[\s\S]*convergeReactions\(room, eventId\)[\s\S]*return \{ eventId: response\.event_id \}/u);

function encryptedEvent(eventId: string): MatrixEvent {
    return new MatrixEvent({
        type: EventType.RoomMessageEncrypted,
        room_id: "!room:example.org",
        event_id: eventId,
        sender: "@friend:example.org",
        origin_server_ts: 1,
        content: {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: "ciphertext",
            device_id: "DEVICE",
            sender_key: "sender-key",
            session_id: "session"
        }
    });
}

async function verifySdkDecryptionOrder(): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const event = encryptedEvent("$message");
    const pending = event.attemptDecryption({
        decryptEvent: async () => {
            await gate;
            return {
                clearEvent: { type: EventType.RoomMessage, content: { msgtype: "m.text", body: "hello" } },
                senderCurve25519Key: null,
                claimedEd25519Key: null,
                forwardingCurve25519KeyChain: []
            };
        }
    } as any);
    assert.equal(event.getWireType(), EventType.RoomMessageEncrypted);
    assert.equal(event.getType(), EventType.RoomMessageEncrypted);
    assert.equal(event.isDecryptionFailure(), false);
    const orderingTracker = createMatrixLiveDecryptionTracker<MatrixEvent>();
    orderingTracker.mark(event);
    release();
    await pending;
    assert.equal(event.getType(), EventType.RoomMessage);
    assert.equal(orderingTracker.consume(event, true), "live");
}

async function verifySdkFailureRecovery(
    eventId: string,
    clearEvent: { type: string; content: Record<string, unknown>; },
    expectedRelationType: RelationType
): Promise<void> {
    const event = encryptedEvent(eventId);
    const recoveryTracker = createMatrixLiveDecryptionTracker<MatrixEvent>();
    recoveryTracker.mark(event);
    let keyAvailable = false;
    const crypto = {
        decryptEvent: async () => {
            if (!keyAvailable) throw new Error("test room key unavailable");
            return {
                clearEvent,
                senderCurve25519Key: null,
                claimedEd25519Key: null,
                forwardingCurve25519KeyChain: []
            };
        }
    };

    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
        await event.attemptDecryption(crypto as any);
    } finally {
        console.warn = previousWarn;
    }
    assert.equal(event.isDecryptionFailure(), true);
    assert.equal(event.getType(), EventType.RoomMessage);
    assert.equal(recoveryTracker.consume(event, false), "live");
    recoveryTracker.markFailure(event);

    keyAvailable = true;
    await event.attemptDecryption(crypto as any);
    assert.equal(event.isDecryptionFailure(), false);
    assert.equal(event.getType(), clearEvent.type);
    const relation = event.getContent<Record<string, unknown>>()["m.relates_to"];
    assert.equal(typeof relation, "object");
    assert.equal((relation as Record<string, unknown>).rel_type, expectedRelationType);

    let recoveredRelationRoutes = 0;
    for (let retry = 0; retry < 2; retry++) {
        assert.equal(recoveryTracker.consume(event, retry === 0), retry === 0 ? "isolated" : "update");
        if (!event.isDecryptionFailure() && recoveryTracker.consumeFailure(event)) recoveredRelationRoutes++;
    }
    assert.equal(recoveredRelationRoutes, 1, `${expectedRelationType} must receive exactly one recovered full route`);
}

async function verifySdkDecryptionBehavior(): Promise<void> {
    await verifyHistoryRequestRegistry();
    await verifySdkDecryptionOrder();
    await verifySdkFailureRecovery("$reaction", {
        type: EventType.Reaction,
        content: {
            "m.relates_to": {
                rel_type: RelationType.Annotation,
                event_id: "$target",
                key: "👍"
            }
        }
    }, RelationType.Annotation);
    await verifySdkFailureRecovery("$replacement", {
        type: EventType.RoomMessage,
        content: {
            msgtype: "m.text",
            body: "* edited",
            "m.new_content": { msgtype: "m.text", body: "edited" },
            "m.relates_to": { rel_type: RelationType.Replace, event_id: "$target" }
        }
    }, RelationType.Replace);
}

verifySdkDecryptionBehavior().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
