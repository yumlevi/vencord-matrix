/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface MatrixMainTimelineSource {
    getUnfilteredTimelineSet(): object;
}

export type MatrixDecryptionDeltaDisposition = "live" | "isolated" | "update";

export interface MatrixHistoryRequestLease {
    readonly generation: number;
    readonly completion: Promise<void>;
    isActive(): boolean;
    release(): void;
}

/**
 * Coalesce Discord's duplicate scroll fetches without allowing an older
 * request to clear a newer room request after a reset/rejoin race.
 */
export function createMatrixHistoryRequestRegistry<Key>() {
    const active = new Map<Key, MatrixHistoryRequestLease>();

    return {
        acquire(key: Key, generation: number): { lease: MatrixHistoryRequestLease; owner: boolean; } {
            const current = active.get(key);
            if (current?.generation === generation) return { lease: current, owner: false };
            current?.release();

            let resolveCompletion!: () => void;
            const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
            let released = false;
            const lease: MatrixHistoryRequestLease = {
                generation,
                completion,
                isActive(): boolean {
                    return !released && active.get(key) === lease;
                },
                release(): void {
                    if (released) return;
                    released = true;
                    if (active.get(key) === lease) active.delete(key);
                    resolveCompletion();
                }
            };
            active.set(key, lease);
            return { lease, owner: true };
        },
        cancel(key: Key): void {
            active.get(key)?.release();
        },
        clear(): void {
            for (const lease of [...active.values()]) lease.release();
        }
    };
}

/**
 * Matrix pagination tokens must advance without cycling. A repeated token is
 * an end boundary for this client; following it would reload the same pages
 * forever while the renderer remains pinned at the top.
 */
export function advanceMatrixHistoryToken(
    current: string,
    next: string | null,
    seen: Set<string>
): string | null {
    if (next == null || next === current || seen.has(next)) return null;
    seen.add(next);
    return next;
}

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
