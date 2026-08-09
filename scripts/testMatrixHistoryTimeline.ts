/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    isCurrentMatrixTimelineGeneration,
    isMainMatrixTimelineReset
} from "../src/plugins/matrixBridge/historyTimeline";

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
