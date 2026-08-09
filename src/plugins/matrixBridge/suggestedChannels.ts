/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    MatrixJoinSuggestedSpaceChannelsResult,
    MatrixSuggestedSpaceChannelPlanDTO,
} from "./types";

const UNSAFE_CONSENT_TEXT_PATTERN = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SUGGESTED_PLAN_SYNC_TIMEOUT_MS = 12_000;
const SUGGESTED_PLAN_RETRY_INTERVAL_MS = 500;

export async function waitForSuggestedChannelPlan(
    load: () => Promise<MatrixSuggestedSpaceChannelPlanDTO>,
    isCurrent: () => boolean,
    isSyncPending: (error: unknown) => boolean
) {
    const deadline = Date.now() + SUGGESTED_PLAN_SYNC_TIMEOUT_MS;
    while (isCurrent()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return undefined;
        const operation = Promise.resolve().then(load);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                operation,
                new Promise<undefined>(resolve => {
                    timeout = setTimeout(() => resolve(undefined), remaining);
                }),
            ]);
            if (!result) {
                void operation.catch(() => undefined);
                return undefined;
            }
            return result;
        } catch (error) {
            if (!isSyncPending(error)) throw error;
            if (Date.now() >= deadline) return undefined;
            await new Promise(resolve => setTimeout(
                resolve,
                Math.min(SUGGESTED_PLAN_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))
            ));
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }
    return undefined;
}

export function safeSuggestedChannelText(value: string | undefined, fallback: string, maximum = 200) {
    return value
        ?.replace(UNSAFE_CONSENT_TEXT_PATTERN, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum) || fallback;
}

export function suggestedChannelConsentRows(plan: MatrixSuggestedSpaceChannelPlanDTO) {
    const categoryNames = new Map(plan.channels
        .filter(channel => channel.kind === "space")
        .map(channel => [
            channel.roomId,
            safeSuggestedChannelText(channel.name, "Unnamed category", 100),
        ]));
    return plan.channels.map(channel => {
        const kindLabel = channel.kind === "space" ? "Category" : "Channel";
        const name = safeSuggestedChannelText(
            channel.name,
            channel.kind === "space" ? "Unnamed category" : "Unnamed channel",
            100
        );
        const parentLabel = channel.depth === 2
            ? categoryNames.get(channel.parentSpaceId) ?? "Unnamed category"
            : undefined;
        const status = channel.membership === "join"
            ? `Already joined ${kindLabel.toLocaleLowerCase("en-US")} - shown only as context.`
            : channel.kind === "space"
                ? "Category prerequisite - will be joined."
                : "Suggested channel - will be joined.";
        return {
            key: channel.roomId,
            kindLabel,
            name,
            parentLabel,
            status,
            topic: channel.topic
                ? safeSuggestedChannelText(channel.topic, "", 300) || undefined
                : undefined,
            actionable: channel.membership === "leave",
        };
    });
}

function itemCountLabel(channels: number, categories: number) {
    return [
        channels ? `${channels} channel${channels === 1 ? "" : "s"}` : "",
        categories ? `${categories} categor${categories === 1 ? "y" : "ies"}` : "",
    ].filter(Boolean).join(" and ") || "none";
}

export function suggestedChannelJoinSummary(result: MatrixJoinSuggestedSpaceChannelsResult) {
    const counts = new Map<string, { channels: number; categories: number; }>();
    for (const status of ["joined", "already_joined", "rejected", "blocked_by_parent"] as const) {
        counts.set(status, { channels: 0, categories: 0 });
    }
    for (const outcome of result.outcomes) {
        const count = counts.get(outcome.status)!;
        if (outcome.kind === "space") count.categories++;
        else count.channels++;
    }
    const segments: string[] = [];
    const joined = counts.get("joined")!;
    const already = counts.get("already_joined")!;
    const rejected = counts.get("rejected")!;
    const blocked = counts.get("blocked_by_parent")!;
    if (joined.channels || joined.categories) segments.push(`Joined ${itemCountLabel(joined.channels, joined.categories)}.`);
    if (already.channels || already.categories) segments.push(`Already joined: ${itemCountLabel(already.channels, already.categories)}.`);
    if (rejected.channels || rejected.categories) segments.push(`Rejected: ${itemCountLabel(rejected.channels, rejected.categories)}.`);
    if (blocked.channels || blocked.categories) segments.push(`Blocked by a category: ${itemCountLabel(blocked.channels, blocked.categories)}.`);
    if (!segments.length) segments.push("No suggested channels were joined.");
    segments.push("This bounded result is not a complete server channel list.");
    return segments.join(" ");
}

export function suggestedChannelPlanDisclosure(plan: MatrixSuggestedSpaceChannelPlanDTO) {
    return `Only rows marked "will be joined" are included in this action. Already joined categories are context only. Joining makes your signed-in account ID visible to members of those channels. This is a bounded provider suggestion list, not a complete server channel list.${plan.limited ? " More suggestions may exist." : ""}`;
}
