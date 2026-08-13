/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Detects anchors which are no longer in canonical order, or a newly-visible
 * run which no longer fits between immutable synthetic Discord snowflakes.
 * Prefix/suffix runs remain expandable.
 */
export function matrixMessageOrderNeedsReindex(
    ordered: ReadonlyMap<string, string>,
    eventIds: readonly string[]
): boolean {
    let previousAnchor: bigint | undefined;
    for (const eventId of eventIds) {
        const id = ordered.get(eventId);
        if (id == null) continue;
        const anchor = BigInt(id);
        if (previousAnchor != null && anchor <= previousAnchor) return true;
        previousAnchor = anchor;
    }

    for (let cursor = 0; cursor < eventIds.length;) {
        if (ordered.has(eventIds[cursor])) {
            cursor++;
            continue;
        }
        const start = cursor;
        while (cursor < eventIds.length && !ordered.has(eventIds[cursor])) cursor++;
        if (start === 0 || cursor === eventIds.length) continue;
        const left = BigInt(ordered.get(eventIds[start - 1])!);
        const right = BigInt(ordered.get(eventIds[cursor])!);
        if (right <= left || right - left - 1n < BigInt(cursor - start)) return true;
    }
    return false;
}
