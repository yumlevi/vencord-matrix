/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MatrixKeyImportConvergenceOptions {
    concurrency: number;
    timeoutMs: number;
    quietMs: number;
    pollMs: number;
}

const DEFAULT_OPTIONS: MatrixKeyImportConvergenceOptions = {
    concurrency: 64,
    timeoutMs: 15_000,
    quietMs: 150,
    pollMs: 50,
};

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function settleBefore(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(() => true, () => true),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), remaining); })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Await SDK-deduplicated retries, then a quiet event interval, under one deadline. */
export async function convergeImportedRoomKeys<T>(
    candidates: readonly T[],
    retry: (candidate: T) => Promise<unknown>,
    activityRevision: () => number,
    options: Partial<MatrixKeyImportConvergenceOptions> = {}
): Promise<{ attempted: number; timedOut: boolean; }> {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const concurrency = Math.max(1, Math.min(128, Math.floor(settings.concurrency)));
    const deadline = Date.now() + Math.max(1, Math.min(60_000, Math.floor(settings.timeoutMs)));
    let cursor = 0;
    let attempted = 0;
    let timedOut = false;
    const runner = async () => {
        while (cursor < candidates.length) {
            if (Date.now() >= deadline) {
                timedOut = true;
                return;
            }
            const candidate = candidates[cursor++];
            attempted++;
            if (!await settleBefore(Promise.resolve().then(() => retry(candidate)), deadline)) {
                timedOut = true;
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, runner));

    let revision = activityRevision();
    let quietSince = Date.now();
    while (Date.now() < deadline) {
        await wait(Math.max(1, Math.min(settings.pollMs, deadline - Date.now())));
        const nextRevision = activityRevision();
        if (nextRevision !== revision) {
            revision = nextRevision;
            quietSince = Date.now();
        } else if (Date.now() - quietSince >= settings.quietMs) {
            return { attempted, timedOut };
        }
    }
    return { attempted, timedOut: true };
}
