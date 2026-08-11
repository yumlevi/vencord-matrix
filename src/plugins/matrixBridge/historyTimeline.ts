/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface MatrixMainTimelineSource {
    getUnfilteredTimelineSet(): object;
}

export type MatrixDecryptionDeltaDisposition = "live" | "isolated" | "update";

/**
 * Distinguish a newly-arrived encrypted event from detached history/search
 * decryption. A live marker is stronger than a simultaneous isolated marker:
 * the former proves the event owns a canonical live-timeline slot.
 */
export function createMatrixLiveDecryptionTracker<Event extends object>() {
    const pending = new WeakSet<Event>();
    const failures = new WeakSet<Event>();

    return {
        mark(event: Event): void {
            pending.add(event);
        },
        markFailure(event: Event): void {
            failures.add(event);
        },
        discard(event: Event): void {
            pending.delete(event);
            failures.delete(event);
        },
        consume(event: Event, isolated: boolean): MatrixDecryptionDeltaDisposition {
            if (pending.delete(event)) return "live";
            return isolated ? "isolated" : "update";
        },
        consumeFailure(event: Event): boolean {
            return failures.delete(event);
        }
    };
}

/** Only the room's exact unfiltered TimelineSet owns its renderer generation. */
export function isMainMatrixTimelineReset(room: MatrixMainTimelineSource, timelineSet: object): boolean {
    return timelineSet === room.getUnfilteredTimelineSet();
}

/** Compare a captured pagination generation with the current room generation. */
export function isCurrentMatrixTimelineGeneration(captured: number, current: number): boolean {
    return captured === current;
}
