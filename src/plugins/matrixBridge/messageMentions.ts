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

interface MatrixFormattedMentionProjection {
    body: string;
    projectedUserIds: Set<string>;
}

const MATRIX_MENTION_PLACEHOLDER_PREFIX = "\ue000matrix-mention:";
const MATRIX_MENTION_PLACEHOLDER_SUFFIX = "\ue001";
const MATRIX_MENTION_PLACEHOLDER_PATTERN = /\ue000matrix-mention:\d{1,3}\ue001/u;
const MATRIX_FORMATTED_MENTION_PLACEHOLDER_PREFIX = "\ue002matrix-formatted-mention:";
const MATRIX_FORMATTED_MENTION_PLACEHOLDER_SUFFIX = "\ue003";

function mentionPlaceholder(index: number): string {
    return `${MATRIX_MENTION_PLACEHOLDER_PREFIX}${index}${MATRIX_MENTION_PLACEHOLDER_SUFFIX}`;
}

function formattedMentionPlaceholder(index: number): string {
    return `${MATRIX_FORMATTED_MENTION_PLACEHOLDER_PREFIX}${index}${MATRIX_FORMATTED_MENTION_PLACEHOLDER_SUFFIX}`;
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

function decodeHtmlEntities(value: string): string {
    return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|apos|gt|lt|nbsp|quot));/giu,
        (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
            if (named) {
                return named.toLowerCase() === "amp" ? "&"
                    : named.toLowerCase() === "apos" ? "'"
                        : named.toLowerCase() === "gt" ? ">"
                            : named.toLowerCase() === "lt" ? "<"
                                : named.toLowerCase() === "nbsp" ? "\u00a0"
                                    : '"';
            }
            const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
            return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
                && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
                ? String.fromCodePoint(codePoint)
                : entity;
        });
}

function matrixMentionUserIdFromHref(rawHref: string): string | undefined {
    const href = decodeHtmlEntities(rawHref).trim();
    try {
        if (/^https:\/\/matrix\.to\//iu.test(href)) {
            const url = new URL(href);
            if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "matrix.to" || url.port) return undefined;
            const fragment = decodeURIComponent(url.hash.slice(1)).replace(/^\/+/, "");
            const userId = fragment.split("?", 1)[0];
            return userId.startsWith("@") ? userId : undefined;
        }
        if (/^matrix:/iu.test(href)) {
            const path = href.slice("matrix:".length).replace(/^\/+/, "").split("?", 1)[0];
            if (!/^u\//iu.test(path)) return undefined;
            const userId = `@${decodeURIComponent(path.slice(2))}`;
            return userId.length > 1 ? userId : undefined;
        }
    } catch { }
    return undefined;
}

function htmlAnchorHref(tag: string): string | undefined {
    const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu.exec(tag);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

const HTML_VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_BLOCK_TAGS = new Set(["blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "pre", "table", "tbody", "td", "th", "thead", "tr", "ul"]);
const HTML_SUPPRESSED_TAGS = new Set(["mx-reply", "script", "style", "template"]);

function appendFormattedText(target: string[], value: string): void {
    if (!value) return;
    // Reserved sentinels are stripped per source chunk so markup cannot join
    // attacker-controlled fragments into one of our trusted placeholders.
    target.push(decodeHtmlEntities(value).replace(/[\ue002\ue003]/gu, ""));
}

function appendFormattedBreak(target: string[]): void {
    if (!target.length || target[target.length - 1].endsWith("\n")) return;
    target.push("\n");
}

/**
 * Convert Matrix custom HTML to inert plain text. The only active Discord
 * syntax introduced here comes from an exact Matrix URI anchor whose MXID is
 * also authorized by m.mentions; anchor labels are never identity evidence.
 */
function projectFormattedMatrixMentions(
    formattedBody: string,
    identities: ReadonlyMap<string, MatrixInboundMentionIdentity>
): MatrixFormattedMentionProjection | undefined {
    if (!formattedBody || formattedBody.length > 131_072 || !identities.size) return undefined;
    const output: string[] = [];
    const projectedUserIds = new Set<string>();
    const projectedIdentities: MatrixInboundMentionIdentity[] = [];
    const projectedIdentityIndexes = new Map<string, number>();
    const stack: Array<{ name: string; suppress: boolean; }> = [];
    let suppressionDepth = 0;
    const suppressed = () => suppressionDepth > 0;
    let cursor = 0;

    while (cursor < formattedBody.length) {
        const tagStart = formattedBody.indexOf("<", cursor);
        if (tagStart === -1) {
            if (!suppressed()) appendFormattedText(output, formattedBody.slice(cursor));
            break;
        }
        if (tagStart > cursor && !suppressed()) {
            appendFormattedText(output, formattedBody.slice(cursor, tagStart));
        }
        if (formattedBody.startsWith("<!--", tagStart)) {
            const commentEnd = formattedBody.indexOf("-->", tagStart + 4);
            cursor = commentEnd === -1 ? formattedBody.length : commentEnd + 3;
            continue;
        }

        let quote = "";
        let tagEnd = tagStart + 1;
        for (; tagEnd < formattedBody.length; tagEnd++) {
            const character = formattedBody[tagEnd];
            if (quote) {
                if (character === quote) quote = "";
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === ">") {
                break;
            }
        }
        if (tagEnd >= formattedBody.length) {
            return undefined;
        }

        const tag = formattedBody.slice(tagStart, tagEnd + 1);
        cursor = tagEnd + 1;
        const parsed = /^<\s*(\/?)\s*([a-z][\w:-]*)/iu.exec(tag);
        if (!parsed) continue;
        const closing = Boolean(parsed[1]);
        const name = parsed[2].toLowerCase();
        if (closing) {
            const entry = stack[stack.length - 1];
            const wasSuppressed = suppressed();
            if (entry?.name === name) {
                stack.pop();
                if (entry.suppress) suppressionDepth--;
                if (!wasSuppressed && HTML_BLOCK_TAGS.has(name)) appendFormattedBreak(output);
            }
            continue;
        }

        const parentSuppressed = suppressed();
        let suppress = parentSuppressed || HTML_SUPPRESSED_TAGS.has(name);
        if (!suppress && name === "a") {
            const href = htmlAnchorHref(tag);
            const matrixUserId = href ? matrixMentionUserIdFromHref(href) : undefined;
            const identity = matrixUserId ? identities.get(matrixUserId) : undefined;
            if (identity) {
                let index = projectedIdentityIndexes.get(identity.matrixUserId);
                if (index == null) {
                    projectedIdentities.push(identity);
                    index = projectedIdentities.length - 1;
                    projectedIdentityIndexes.set(identity.matrixUserId, index);
                }
                output.push(formattedMentionPlaceholder(index));
                projectedUserIds.add(identity.matrixUserId);
                suppress = true;
            }
        }
        if (!parentSuppressed && name === "br") appendFormattedBreak(output);
        const selfClosing = /\/\s*>$/u.test(tag) || HTML_VOID_TAGS.has(name);
        if (!selfClosing) {
            // Standard Matrix custom HTML is shallow. Reject pathological or
            // malformed nesting rather than doing unbounded renderer work.
            if (stack.length >= 256) return undefined;
            stack.push({ name, suppress });
            if (suppress) suppressionDepth++;
        }
    }

    if (stack.length || !projectedUserIds.size) return undefined;
    let body = output.join("")
        .replace(/\r/gu, "")
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim()
        // Neutralize only after all HTML chunks have joined; otherwise inert
        // tags could split an unauthorized Discord token across chunks.
        .replace(DISCORD_USER_MENTION_PATTERN, "@$1");
    for (let index = 0; index < projectedIdentities.length; index++) {
        body = body.replaceAll(
            formattedMentionPlaceholder(index),
            `<@${projectedIdentities[index].localUserId}>`
        );
    }
    body = body.slice(0, 65_536);
    return body ? { body, projectedUserIds } : undefined;
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
    resolveLegacySyntheticUserId: (syntheticUserId: string) => MatrixInboundMentionIdentity | undefined,
    formattedBody?: string
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

    const resolvedIntentionalIdentities = [...new Set(mentionedUserIds)]
        .slice(0, MAX_MATRIX_MESSAGE_MENTIONS)
        .map(resolveMatrixUserId)
        .filter((identity): identity is MatrixInboundMentionIdentity => Boolean(identity))
        // Replace longer Matrix IDs first so a valid prefix cannot consume a
        // more specific identity which follows it.
        .sort((left, right) => right.matrixUserId.length - left.matrixUserId.length);
    const intentionalIdentitiesById = new Map(
        resolvedIntentionalIdentities.map(identity => [identity.matrixUserId, identity])
    );
    const formattedProjection = formattedBody
        ? projectFormattedMatrixMentions(formattedBody, intentionalIdentitiesById)
        : undefined;
    if (formattedProjection) projectedBody = formattedProjection.body;
    for (const identity of resolvedIntentionalIdentities) {
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
