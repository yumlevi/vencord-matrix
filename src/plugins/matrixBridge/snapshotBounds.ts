/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MatrixSnapshotCoverage } from "./types";

export interface SnapshotRoomPriority {
    roomId: string;
    unreadCount: number;
    highlightCount: number;
    newestTimestamp: number;
}

export interface SnapshotRoomQuota extends SnapshotRoomPriority {
    maximum: number;
}

export interface SnapshotQuotaSelection {
    quotaByRoom: ReadonlyMap<string, number>;
    allocated: number;
    limited: boolean;
}

export interface SnapshotMessageRoom<Message> extends SnapshotRoomPriority {
    /** Chronological (oldest-first) bounded candidate window. */
    messages: readonly Message[];
}

export interface SnapshotMessageSelection<Message> {
    messagesByRoom: ReadonlyMap<string, readonly Message[]>;
    messageCount: number;
    messageBytes: number;
    limited: boolean;
}

interface PriorityState {
    room: SnapshotRoomPriority;
    originalIndex: number;
}

interface SelectionState<Message> extends PriorityState {
    room: SnapshotMessageRoom<Message>;
    nextIndex: number;
    selected: Message[];
    blocked: boolean;
}

function nonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative integer.`);
    }
    return value;
}

function roomPriority(left: PriorityState, right: PriorityState): number {
    const leftHighlight = left.room.highlightCount > 0 ? 1 : 0;
    const rightHighlight = right.room.highlightCount > 0 ? 1 : 0;
    if (leftHighlight !== rightHighlight) return rightHighlight - leftHighlight;

    const leftUnread = left.room.unreadCount > 0 ? 1 : 0;
    const rightUnread = right.room.unreadCount > 0 ? 1 : 0;
    if (leftUnread !== rightUnread) return rightUnread - leftUnread;
    if (left.room.newestTimestamp !== right.room.newestTimestamp) {
        return right.room.newestTimestamp - left.room.newestTimestamp;
    }
    return left.originalIndex - right.originalIndex;
}

/**
 * Allocate a bounded resource one unit per priority-ordered room per pass.
 * This computes cheap per-room quotas before callers materialize large DTOs.
 */
export function allocateFairSnapshotQuotas(
    rooms: readonly SnapshotRoomQuota[],
    maximum: number
): SnapshotQuotaSelection {
    const limit = nonNegativeInteger(maximum, "maximum");
    const states = rooms.map((room, originalIndex) => ({
        room,
        originalIndex,
        maximum: nonNegativeInteger(room.maximum, `maximum for ${room.roomId}`),
        allocated: 0
    })).sort(roomPriority);
    let allocated = 0;

    while (allocated < limit) {
        let progressed = false;
        for (const state of states) {
            if (allocated >= limit) break;
            if (state.allocated >= state.maximum) continue;
            state.allocated++;
            allocated++;
            progressed = true;
        }
        if (!progressed) break;
    }

    const quotaByRoom = new Map<string, number>(
        states
            .sort((left, right) => left.originalIndex - right.originalIndex)
            .map(state => [state.room.roomId, state.allocated])
    );
    return {
        quotaByRoom,
        allocated,
        limited: states.some(state => state.allocated < state.maximum)
    };
}

/**
 * Select contiguous newest suffixes without allowing an early room to consume
 * the aggregate budget. Each priority-ordered room receives at most one item
 * per pass; unread/highlighted and then recently active rooms win only when the
 * global budget cannot cover every room's newest item.
 */
export function selectFairSnapshotMessages<Message>(
    rooms: readonly SnapshotMessageRoom<Message>[],
    maximumMessages: number,
    maximumBytes: number,
    measure: (message: Message) => number
): SnapshotMessageSelection<Message> {
    const messageLimit = nonNegativeInteger(maximumMessages, "maximumMessages");
    const byteLimit = nonNegativeInteger(maximumBytes, "maximumBytes");
    const states: SelectionState<Message>[] = rooms.map((room, originalIndex) => ({
        room,
        originalIndex,
        nextIndex: room.messages.length - 1,
        selected: [],
        blocked: false
    })).sort(roomPriority);
    let messageCount = 0;
    let messageBytes = 0;

    while (messageCount < messageLimit) {
        let progressed = false;
        for (const state of states) {
            if (messageCount >= messageLimit) break;
            if (state.nextIndex < 0 || state.blocked) continue;

            const message = state.room.messages[state.nextIndex];
            let bytes: number;
            try {
                bytes = measure(message);
            } catch {
                state.blocked = true;
                continue;
            }
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > byteLimit - messageBytes) {
                // An older item may not leapfrog this one: doing so would turn a
                // newest suffix into an unrecoverable middle gap.
                state.blocked = true;
                continue;
            }

            state.selected.unshift(message);
            state.nextIndex--;
            messageCount++;
            messageBytes += bytes;
            progressed = true;
        }
        if (!progressed) break;
    }

    const messagesByRoom = new Map<string, readonly Message[]>(
        states
            .sort((left, right) => left.originalIndex - right.originalIndex)
            .map(state => [state.room.roomId, state.selected])
    );
    return {
        messagesByRoom,
        messageCount,
        messageBytes,
        limited: states.some(state => state.blocked || state.nextIndex >= 0)
    };
}

/**
 * A bounded snapshot has an exact worker content revision, but it is not an
 * acknowledgement for omitted rooms or timelines. Only a complete snapshot
 * may move a renderer beyond the sequence it had safely established before
 * the worker began publishing the represented cut.
 */
export function conservativeSnapshotResumeSequence(
    contentSequence: number,
    establishedSequence: number,
    coverage: MatrixSnapshotCoverage
): number {
    const content = nonNegativeInteger(contentSequence, "contentSequence");
    const established = nonNegativeInteger(establishedSequence, "establishedSequence");
    return coverage.roomsComplete && coverage.roomStateComplete && coverage.timelinesComplete
        ? content
        : Math.min(content, established);
}
