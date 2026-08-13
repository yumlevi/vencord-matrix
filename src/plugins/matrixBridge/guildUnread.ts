/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type ScheduleGuildReadStateTask = (task: () => void) => void;

/**
 * Coalesces native guild-read-state recomputations onto the next task.
 *
 * Discord derives its server-rail unread state in GuildReadStateStore. Merely
 * emitting a ReadStateStore change cannot update that separate cached store,
 * and dispatching while another Flux action is reducing is unsafe. Scheduling
 * once after the current action solves both constraints.
 */
export function createMatrixGuildReadStateInvalidator(
    schedule: ScheduleGuildReadStateTask,
    recompute: () => void,
) {
    let queued = false;
    return () => {
        if (queued) return;
        queued = true;
        schedule(() => {
            try {
                recompute();
            } finally {
                // Keep recursive invalidations coalesced while Discord is
                // rebuilding GuildReadStateStore, but never wedge the gate if
                // a native reducer throws.
                queued = false;
            }
        });
    };
}
