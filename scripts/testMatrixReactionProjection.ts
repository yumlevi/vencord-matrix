/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    MATRIX_EDITED_REACTION_UPDATE_PATCH,
    MATRIX_PARTIAL_REACTION_UPDATE_PATCH,
    patchEditedMatrixReactionUpdate,
    patchPartialMatrixReactionUpdate,
    selectProjectedMessageReactions,
} from "../src/plugins/matrixBridge/reactionProjection";
import {
    EDITED_MESSAGE_TRANSFORM_PATCH,
    patchEditedMessageTransform,
} from "../src/plugins/messageLogger/messageUpdatePatch";
import { canonicalizeMatch } from "../src/utils/patches";

const empty: unknown[] = [];
const one = [{ emoji: { id: null, name: "👍" }, count: 1, me: false }];

// Discord's current unedited MESSAGE_UPDATE merge selects the initialized
// existing [] and silently loses the incoming aggregate.
assert.strictEqual(empty ?? one, empty);

// Matrix aggregates replace for additions and removals, in both the edited
// fast path and the ordinary partial-update path.
assert.strictEqual(selectProjectedMessageReactions(true, empty, one), one);
assert.strictEqual(selectProjectedMessageReactions(true, one, empty), empty);
assert.strictEqual(selectProjectedMessageReactions(true, one, undefined), one);

// Ordinary Discord messages retain the stock existing ?? incoming behavior.
assert.strictEqual(selectProjectedMessageReactions(false, one, empty), one);
assert.strictEqual(selectProjectedMessageReactions(false, undefined, one), one);

const index = readFileSync(new URL("../src/plugins/matrixBridge/index.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/plugins/matrixBridge/bridge.ts", import.meta.url), "utf8");
assert.match(index, /find: "premiumGroupInviteId:"/u);
const currentDiscordConverter = "function O(e,t){if(null!=t.edited_timestamp)return N(t,{reactions:e.reactions,interactionData:e.interactionData});"
    + "let n=e;null!=t.reactions&&(n=n.set(\"reactions\",D(e.reactions??t.reactions)));return n}";
const editedPatch = canonicalizeMatch(MATRIX_EDITED_REACTION_UPDATE_PATCH);
const partialPatch = canonicalizeMatch(MATRIX_PARTIAL_REACTION_UPDATE_PATCH);
const messageLoggerPatch = canonicalizeMatch(EDITED_MESSAGE_TRANSFORM_PATCH);
assert.equal((currentDiscordConverter.match(editedPatch) ?? []).length > 0, true);
assert.equal((currentDiscordConverter.match(partialPatch) ?? []).length > 0, true);
assert.equal((currentDiscordConverter.match(messageLoggerPatch) ?? []).length > 0, true);
const applyMatrixPatch = (source: string) => source
    .replace(editedPatch, patchEditedMatrixReactionUpdate)
    .replace(partialPatch, patchPartialMatrixReactionUpdate);
const applyMessageLoggerPatch = (source: string) => source
    .replace(messageLoggerPatch, patchEditedMessageTransform);
for (const patchedDiscordConverter of [
    applyMessageLoggerPatch(applyMatrixPatch(currentDiscordConverter)),
    applyMatrixPatch(applyMessageLoggerPatch(currentDiscordConverter)),
]) {
    assert.equal((patchedDiscordConverter.match(/\$self\.matrixMessageUpdateReactions/g) ?? []).length, 2);
    assert.equal((patchedDiscordConverter.match(/Object\.assign/g) ?? []).length, 1);
    assert.doesNotMatch(patchedDiscordConverter, /reactions:e\.reactions,interactionData/u);
    assert.doesNotMatch(patchedDiscordConverter, /D\(e\.reactions\?\?t\.reactions\)/u);
    assert.match(patchedDiscordConverter, /deleted:e\.deleted, editHistory:e\.editHistory/u);
}
assert.match(
    bridge,
    /function applyReactionDelta[\s\S]+applyMessageDelta\(roomId, \{ \.\.\.message, reactions \}, false\)/u,
    "reaction-only projection updates must not be treated as new live messages"
);

console.log("Matrix Discord reaction projection fixtures passed.");
