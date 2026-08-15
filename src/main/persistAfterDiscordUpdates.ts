/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import type { FSWatcher } from "fs";
import { watch } from "original-fs";
import { dirname } from "path";

import {
    createCanonicalDiscordLoaderAsar,
    type DiscordResourceObservation,
    discordResourceObservationIsQuiescent,
    discordResourceObservationsEqual,
    discoverWindowsUpdateResources,
    observeDiscordResourceCandidate,
    repairDiscordResources,
    type RepairResult,
    resolveTrustedPatcherPath,
    resourcesDirectoryFromInjectorPath
} from "./discordUpdatePersistence";

const POLL_INTERVAL_MS = 15_000;
const WATCH_DEBOUNCE_MS = 1_000;
const SOURCE_QUIESCENCE_MS = 1_000;

interface ObservedCandidate {
    firstSeenAt: bigint;
    observation: DiscordResourceObservation;
}

let started = false;

function reportResult(result: RepairResult, previouslyReported: Map<string, string>) {
    if (result.status === "repaired") {
        previouslyReported.delete(result.target);
        console.info(`[Vencord] Repaired Discord host injection at ${result.target}`);
        return;
    }
    if (result.status !== "refused" || result.reason === "source-not-quiescent") return;
    if (previouslyReported.get(result.target) === result.reason) return;
    previouslyReported.set(result.target, result.reason ?? "repair-failed");
    console.warn(`[Vencord] Refused to repair Discord host injection at ${result.target}: ${result.reason}`);
}

export function startDiscordUpdatePersistence(injectorPath: string) {
    if (started || process.platform !== "win32" || process.env.DISABLE_UPDATER_AUTO_PATCHING) return;
    started = true;

    const resourcesDirectory = resourcesDirectoryFromInjectorPath(injectorPath);
    if (resourcesDirectory == null) {
        console.warn("[Vencord] Host update persistence is unavailable: injector path is invalid");
        return;
    }
    const patcherPath = resolveTrustedPatcherPath(resourcesDirectory);
    if (patcherPath == null) {
        console.warn("[Vencord] Host update persistence is unavailable: trusted patcher path is invalid");
        return;
    }

    let loaderAsar: Buffer;
    try {
        loaderAsar = createCanonicalDiscordLoaderAsar(patcherPath);
    } catch {
        console.warn("[Vencord] Host update persistence is unavailable: loader generation failed");
        return;
    }

    const previouslyReported = new Map<string, string>();
    const observations = new Map<string, ObservedCandidate>();
    const settledTargets = new Set<string>();
    const watchers: FSWatcher[] = [];
    let debounce: NodeJS.Timeout | undefined;
    let scanning = false;
    let stopped = false;

    const scan = () => {
        if (stopped || scanning) return;
        scanning = true;
        try {
            const targets = discoverWindowsUpdateResources(process.execPath);
            const liveTargets = new Set(targets);
            for (const target of observations.keys()) {
                if (!liveTargets.has(target)) observations.delete(target);
            }
            for (const target of settledTargets) {
                if (!liveTargets.has(target)) settledTargets.delete(target);
            }

            let confirmationDelayMs: number | undefined;
            for (const target of targets) {
                if (settledTargets.has(target)) continue;
                const observation = observeDiscordResourceCandidate(target);
                if (observation == null) {
                    observations.delete(target);
                    const result = repairDiscordResources(target, loaderAsar);
                    reportResult(result, previouslyReported);
                    if (result.status === "unchanged" || result.status === "repaired") settledTargets.add(target);
                    continue;
                }

                const now = process.hrtime.bigint();
                const previous = observations.get(target);
                if (previous == null || !discordResourceObservationsEqual(previous.observation, observation)) {
                    observations.set(target, { firstSeenAt: now, observation });
                    confirmationDelayMs = Math.min(confirmationDelayMs ?? Infinity, SOURCE_QUIESCENCE_MS);
                    continue;
                }
                const elapsedMs = Number(now - previous.firstSeenAt) / 1_000_000;
                if (!discordResourceObservationIsQuiescent(
                    previous.observation,
                    observation,
                    elapsedMs,
                    SOURCE_QUIESCENCE_MS
                )) {
                    previous.observation = observation;
                    const remainingMs = Math.max(1, Math.ceil(SOURCE_QUIESCENCE_MS - elapsedMs));
                    confirmationDelayMs = Math.min(confirmationDelayMs ?? Infinity, remainingMs);
                    continue;
                }

                const result = repairDiscordResources(target, loaderAsar, { expectedObservation: observation });
                reportResult(result, previouslyReported);
                if (result.status === "repaired" || result.status === "unchanged") {
                    observations.delete(target);
                    settledTargets.add(target);
                }
            }
            if (confirmationDelayMs != null) scheduleScan(false, confirmationDelayMs);
        } catch (error) {
            console.error("[Vencord] Failed to scan for a Discord host update", error);
        } finally {
            scanning = false;
        }
    };

    const scheduleScan = (invalidate = true, delayMs = WATCH_DEBOUNCE_MS) => {
        if (stopped) return;
        if (invalidate) {
            observations.clear();
            settledTargets.clear();
        }
        if (debounce != null) clearTimeout(debounce);
        debounce = setTimeout(scan, delayMs);
        debounce.unref();
    };

    const addWatcher = (path: string) => {
        try {
            const watcher = watch(path, { persistent: false }, () => scheduleScan(true, WATCH_DEBOUNCE_MS));
            watcher.on("error", error => {
                console.warn(`[Vencord] Discord host update watcher stopped for ${path}`, error);
                watcher.close();
            });
            watchers.push(watcher);
        } catch (error) {
            console.warn(`[Vencord] Could not watch Discord host updates at ${path}`, error);
        }
    };

    // First observe an update that was staged before this process. A delayed
    // second scan must see the same inode, size and content hash before repair.
    scan();
    addWatcher(dirname(dirname(process.execPath)));

    const poll = setInterval(scan, POLL_INTERVAL_MS);
    poll.unref();

    // This is now only the final fallback rather than the sole repair point.
    app.on("before-quit", scan);
    app.once("will-quit", () => {
        stopped = true;
        clearInterval(poll);
        if (debounce != null) clearTimeout(debounce);
        for (const watcher of watchers) watcher.close();
    });
}
