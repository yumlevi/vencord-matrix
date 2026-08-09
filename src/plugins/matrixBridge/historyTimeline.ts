/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface MatrixMainTimelineSource {
    getUnfilteredTimelineSet(): object;
}

/** Only the room's exact unfiltered TimelineSet owns its renderer generation. */
export function isMainMatrixTimelineReset(room: MatrixMainTimelineSource, timelineSet: object): boolean {
    return timelineSet === room.getUnfilteredTimelineSet();
}

/** Compare a captured pagination generation with the current room generation. */
export function isCurrentMatrixTimelineGeneration(captured: number, current: number): boolean {
    return captured === current;
}
