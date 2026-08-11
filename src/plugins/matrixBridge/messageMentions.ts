/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_MATRIX_MESSAGE_MENTIONS = 100;

const DISCORD_USER_MENTION_PATTERN = /<@!?(\d{1,20})>/gu;

export interface MatrixOutboundMentionProjection {
    body: string;
    userIds: string[];
}

export interface MatrixInboundMentionIdentity {
    matrixUserId: string;
    localUserId: string;
    displayText?: string;
}

export interface MatrixInboundMentionProjection {
    body: string;
    matrixUserIds: string[];
    localUserIds: string[];
}

const MATRIX_MENTION_PLACEHOLDER_PREFIX = "\ue000matrix-mention:";
const MATRIX_MENTION_PLACEHOLDER_SUFFIX = "\ue001";
const MATRIX_MENTION_PLACEHOLDER_PATTERN = /\ue000matrix-mention:\d{1,3}\ue001/u;

function mentionPlaceholder(index: number): string {
    return `${MATRIX_MENTION_PLACEHOLDER_PREFIX}${index}${MATRIX_MENTION_PLACEHOLDER_SUFFIX}`;
}

function inertMentionText(identity: MatrixInboundMentionIdentity): string {
    const text = (identity.displayText ?? identity.matrixUserId)
        .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/^@/u, "")
        .slice(0, 100)
        .trim();
    return `@${text || "Matrix user"}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function portableUriSpans(body: string): Array<{ start: number; end: number; }> {
    const spans: Array<{ start: number; end: number; }> = [];
    // Protect complete scheme-based URIs before rewriting portable Matrix IDs.
    // The prefix exclusion prevents the server portion of an ordinary MXID
    // from being mistaken for a URI scheme.
    const pattern = /(^|[^@A-Za-z0-9._=+/-])([A-Za-z][A-Za-z0-9+.-]*:[^\s<>"']+)/gu;
    for (const match of body.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[1].length;
        spans.push({ start, end: start + match[2].length });
    }
    return spans;
}

function replaceExactMatrixUserId(body: string, matrixUserId: string, replacement: string): string {
    const pattern = new RegExp(
        `(^|[^A-Za-z0-9._=\\-/+@])${escapeRegExp(matrixUserId)}(?=$|[^A-Za-z0-9._:\\-\\[\\]])`,
        "gu"
    );
    const spans = portableUriSpans(body);
    let spanIndex = 0;
    return body.replace(pattern, (match, prefix: string, offset: number) => {
        const userIdStart = offset + prefix.length;
        while (spanIndex < spans.length && spans[spanIndex].end <= userIdStart) spanIndex++;
        const span = spans[spanIndex];
        return span && span.start <= userIdStart && userIdStart < span.end
            ? match
            : `${prefix}${replacement}`;
    });
}

/**
 * Convert only renderer-known Discord identities into portable Matrix IDs.
 * Unknown Discord-shaped tokens are made inert so remote Matrix text cannot
 * accidentally target an unrelated local Discord account.
 */
export function projectOutboundMatrixMentions(
    body: string,
    resolveSyntheticUserId: (syntheticUserId: string) => string | undefined
): MatrixOutboundMentionProjection {
    const userIds: string[] = [];
    const seen = new Set<string>();
    const projectedBody = body.replace(DISCORD_USER_MENTION_PATTERN, (_token, syntheticUserId: string) => {
        const matrixUserId = resolveSyntheticUserId(syntheticUserId);
        if (!matrixUserId) return `@${syntheticUserId}`;
        let index = userIds.indexOf(matrixUserId);
        if (!seen.has(matrixUserId)) {
            if (seen.size >= MAX_MATRIX_MESSAGE_MENTIONS) return `@${syntheticUserId}`;
            seen.add(matrixUserId);
            userIds.push(matrixUserId);
            index = userIds.length - 1;
        }
        return mentionPlaceholder(index);
    });
    return { body: projectedBody, userIds };
}

/** Validate and materialize renderer-only placeholders before Matrix send. */
export function materializeOutboundMatrixMentions(body: string, userIds: readonly string[]): string | undefined {
    let materialized = body;
    for (let index = 0; index < userIds.length; index++) {
        const placeholder = mentionPlaceholder(index);
        if (!materialized.includes(placeholder)) return undefined;
        materialized = materialized.replaceAll(placeholder, userIds[index]);
    }
    return MATRIX_MENTION_PLACEHOLDER_PATTERN.test(materialized) ? undefined : materialized;
}

export function introducedMatrixMentionUserIds(
    previousUserIds: readonly string[],
    nextUserIds: readonly string[]
): string[] {
    const previous = new Set(previousUserIds);
    return [...new Set(nextUserIds)].filter(userId => !previous.has(userId));
}

/**
 * Resolve Matrix mention authority into identities local to this Discord
 * installation. Legacy bridge tokens are accepted only through the supplied
 * room-scoped resolver; arbitrary numeric tokens are rendered inert.
 */
export function projectInboundMatrixMentions(
    body: string,
    mentionedUserIds: readonly string[],
    resolveMatrixUserId: (matrixUserId: string) => MatrixInboundMentionIdentity | undefined,
    resolveLegacySyntheticUserId: (syntheticUserId: string) => MatrixInboundMentionIdentity | undefined
): MatrixInboundMentionProjection {
    const identities = new Map<string, MatrixInboundMentionIdentity>();
    const intentionalUserIds = new Set(mentionedUserIds.slice(0, MAX_MATRIX_MESSAGE_MENTIONS));
    let projectedBody = body.replace(DISCORD_USER_MENTION_PATTERN, (_token, syntheticUserId: string) => {
        const identity = resolveLegacySyntheticUserId(syntheticUserId);
        if (!identity) return `@${syntheticUserId}`;
        if (!intentionalUserIds.has(identity.matrixUserId)) return inertMentionText(identity);
        identities.set(identity.matrixUserId, identity);
        return `<@${identity.localUserId}>`;
    });

    const intentionalIdentities = [...new Set(mentionedUserIds)]
        .slice(0, MAX_MATRIX_MESSAGE_MENTIONS)
        .map(resolveMatrixUserId)
        .filter((identity): identity is MatrixInboundMentionIdentity => Boolean(identity))
        // Replace longer Matrix IDs first so a valid prefix cannot consume a
        // more specific identity which follows it.
        .sort((left, right) => right.matrixUserId.length - left.matrixUserId.length);
    for (const identity of intentionalIdentities) {
        identities.set(identity.matrixUserId, identity);
        projectedBody = replaceExactMatrixUserId(
            projectedBody,
            identity.matrixUserId,
            `<@${identity.localUserId}>`
        );
    }

    return {
        body: projectedBody,
        matrixUserIds: [...identities.keys()],
        localUserIds: [...identities.values()].map(identity => identity.localUserId),
    };
}
