/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMatrixGuildReadStateInvalidator } from "../src/plugins/matrixBridge/guildUnread";
import { parseFxTwitterStatus, validXPreviewMediaCache } from "../src/plugins/matrixBridge/xPreview";

const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");

function section(source: string, startMarker: string, endMarker: string) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `${startMarker} must exist`);
    assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
    return source.slice(start, end);
}

interface RuntimeMessage {
    id: string;
    content: string;
}

interface ViewState {
    selected: boolean;
    visible: boolean;
    focused: boolean;
    rowPresent: boolean;
}

function isActivelyViewingMessage(view: ViewState) {
    return view.selected && view.visible && view.focused && view.rowPresent;
}

const MATRIX_DISPLAY_SOCIAL_HOSTS = new Set([
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
]);

function expectedMatrixDisplayUrl(candidate: string): string {
    try {
        const url = new URL(candidate);
        if (!MATRIX_DISPLAY_SOCIAL_HOSTS.has(url.hostname.toLowerCase())
            || (url.protocol !== "http:" && url.protocol !== "https:")
            || url.username || url.password) {
            return candidate;
        }

        const authorityStart = candidate.indexOf("://") + 3;
        const authorityTail = candidate.slice(authorityStart);
        const separator = authorityTail.search(/[/?#]/u);
        const authorityEnd = separator === -1 ? candidate.length : authorityStart + separator;
        const rawAuthority = candidate.slice(authorityStart, authorityEnd);
        const hostname = url.hostname.toLowerCase();
        const allowedAuthorities = url.protocol === "https:"
            ? [hostname, `${hostname}:443`]
            : [hostname, `${hostname}:80`];
        if (!allowedAuthorities.includes(rawAuthority.toLowerCase())) return candidate;
        return `https://girlcockx.com${candidate.slice(authorityEnd)}`;
    } catch {
        return candidate;
    }
}

function expectedMatrixDisplayText(body: string) {
    return body.replace(/https?:\/\/[^\s<>"']+/giu, candidate => expectedMatrixDisplayUrl(candidate));
}

interface OpaquePreviewMedia {
    name: string;
    mimeType: string;
    width: number;
    height: number;
    downloadable: true;
    downloadIndex: 0 | 1;
}

interface OpaquePreview {
    url: string;
    title?: string;
    description?: string;
    provider: { name: "X"; };
    image?: OpaquePreviewMedia;
    video?: OpaquePreviewMedia;
}

interface WorkerPreviewCache {
    sourceUrl: string;
    imageUrl?: string;
    videoUrl?: string;
    preview: OpaquePreview;
}

function expectedFxTwitterPreview(
    value: unknown,
    sourceUrl: string,
    requestedId: string
): WorkerPreviewCache | undefined {
    const parsed = parseFxTwitterStatus(value, requestedId);
    if (!parsed) return undefined;
    const preview: OpaquePreview = {
        url: sourceUrl,
        provider: { name: "X" },
        title: parsed.title,
        description: parsed.description,
    };
    if (parsed.image) {
        preview.image = {
            name: `x-preview.${parsed.image.mimeType === "image/jpeg" ? "jpg" : parsed.image.mimeType.split("/")[1]}`,
            mimeType: parsed.image.mimeType,
            width: parsed.image.width,
            height: parsed.image.height,
            downloadable: true,
            downloadIndex: 0,
        };
    }
    if (parsed.video) {
        preview.video = {
            name: "x-preview.mp4",
            mimeType: "video/mp4",
            width: parsed.video.width,
            height: parsed.video.height,
            downloadable: true,
            downloadIndex: 1,
        };
    }
    return { sourceUrl, imageUrl: parsed.image?.url, videoUrl: parsed.video?.url, preview };
}

/**
 * Minimal reducer model audited against Discord build 591071
 * (`web.32122d16bd4cd7f0.js`). It intentionally models only the contracts the
 * Matrix projection relies on; it is not a substitute for Discord's stores.
 */
class DiscordPrivateChannelRuntime {
    channelCreated = false;
    messageStoreReady = false;
    rows: RuntimeMessage[] = [];
    privateSortLastMessageId: string | null = null;
    notifications = 0;
    unreadCount = 0;
    mentionCount = 0;

    channelCreate() {
        this.channelCreated = true;
    }

    messageCreate(message: RuntimeMessage, view: ViewState) {
        assert.equal(this.channelCreated, true, "CHANNEL_CREATE must precede MESSAGE_CREATE");

        // PrivateChannelSortStore, notification reducers, and ReadStateStore all
        // see the gateway event even when MessageStore cannot accept its row.
        this.privateSortLastMessageId = message.id;
        this.notifications++;
        if (!isActivelyViewingMessage(view)) {
            this.unreadCount++;
            // Discord treats every unread DM/GROUP_DM message as a Home badge.
            this.mentionCount++;
        }

        if (!this.messageStoreReady || this.rows.some(row => row.id === message.id)) return false;
        const insertionIndex = this.rows.findIndex(row => BigInt(row.id) > BigInt(message.id));
        if (insertionIndex === -1) this.rows.push(message);
        else this.rows.splice(insertionIndex, 0, message);
        return true;
    }

    fullLoadMessages(newestFirst: RuntimeMessage[]) {
        for (let index = 1; index < newestFirst.length; index++) {
            assert.ok(
                BigInt(newestFirst[index - 1].id) > BigInt(newestFirst[index].id),
                "LOAD_MESSAGES_SUCCESS must receive a strictly newest-first Matrix projection"
            );
        }

        // ChannelMessages.loadComplete reverses the API/gateway page into its
        // oldest-first display representation. A non-incremental load resets it.
        this.rows = [...newestFirst].reverse();
        this.messageStoreReady = true;
    }
}

interface AuthoritativeUnread {
    unreadCount: number;
    highlightCount: number;
    lastMessageId: string | null;
}

class EffectiveUnreadProjection {
    private unreadFloor = 0;
    private highlightFloor = 0;
    private lastMessageId: string | null = null;
    private acknowledgedThroughId: string | null = null;

    applyLive(rowId: string) {
        // The Matrix SDK's unread counters are authoritative. A row can arrive
        // before or after its UnreadNotifications delta, so projecting it must
        // never add a second local credit.
        if (this.lastMessageId == null || BigInt(rowId) > BigInt(this.lastMessageId)) this.lastMessageId = rowId;
    }

    applyReaction(_rowId: string) {
        // Updating an existing projected row is never a new unread event.
    }

    applySnapshot(next: AuthoritativeUnread) {
        const snapshotIsAlreadyAcknowledged = next.lastMessageId != null
            && this.acknowledgedThroughId != null
            && BigInt(next.lastMessageId) <= BigInt(this.acknowledgedThroughId);
        if (!snapshotIsAlreadyAcknowledged) {
            this.unreadFloor = Math.max(this.unreadFloor, next.unreadCount);
            this.highlightFloor = Math.max(this.highlightFloor, next.highlightCount);
        }
        if (next.lastMessageId != null
            && (this.lastMessageId == null || BigInt(next.lastMessageId) > BigInt(this.lastMessageId))) {
            this.lastMessageId = next.lastMessageId;
        }
    }

    acknowledgeNewest(rowId: string, view: ViewState, receiptSucceeded = true) {
        if (!receiptSucceeded || !isActivelyViewingMessage(view) || rowId !== this.lastMessageId) return false;
        this.unreadFloor = 0;
        this.highlightFloor = 0;
        this.acknowledgedThroughId = rowId;
        return true;
    }

    effective(groupDm: boolean) {
        const unreadCount = Math.min(1_000_000, this.unreadFloor);
        return {
            unreadCount,
            mentionCount: groupDm ? unreadCount : this.highlightFloor,
            lastMessageId: this.lastMessageId,
        };
    }
}

const scheduledGuildUnreadTasks: Array<() => void> = [];
let guildReadStateRecomputes = 0;
const invalidateGuildReadState = createMatrixGuildReadStateInvalidator(
    task => scheduledGuildUnreadTasks.push(task),
    () => guildReadStateRecomputes++,
);
invalidateGuildReadState();
invalidateGuildReadState();
assert.equal(scheduledGuildUnreadTasks.length, 1,
    "multiple authoritative unread changes in one Matrix batch must coalesce");
assert.equal(guildReadStateRecomputes, 0,
    "guild read state must not dispatch recursively inside the current Flux action");
scheduledGuildUnreadTasks.shift()!();
assert.equal(guildReadStateRecomputes, 1);
invalidateGuildReadState();
assert.equal(scheduledGuildUnreadTasks.length, 1,
    "a completed native recomputation must allow the next unread transition through");
scheduledGuildUnreadTasks.shift()!();
assert.equal(guildReadStateRecomputes, 2);

const recursivelyScheduledGuildUnreadTasks: Array<() => void> = [];
let recursiveGuildReadStateRecomputes = 0;
let invalidateGuildReadStateRecursively!: () => void;
invalidateGuildReadStateRecursively = createMatrixGuildReadStateInvalidator(
    task => recursivelyScheduledGuildUnreadTasks.push(task),
    () => {
        recursiveGuildReadStateRecomputes++;
        invalidateGuildReadStateRecursively();
    },
);
invalidateGuildReadStateRecursively();
recursivelyScheduledGuildUnreadTasks.shift()!();
assert.equal(recursiveGuildReadStateRecomputes, 1);
assert.equal(recursivelyScheduledGuildUnreadTasks.length, 0,
    "native guild-state recomputation must not recursively enqueue itself");

const oldest = { id: "100", content: "oldest" };
const middle = { id: "200", content: "middle" };
const newest = { id: "300", content: "newest" };
const bootMessage = { id: "400", content: "arrived during CONNECTION_OPEN" };

const runtime = new DiscordPrivateChannelRuntime();
runtime.channelCreate();
runtime.fullLoadMessages([newest, middle, oldest]);
assert.deepEqual(runtime.rows.map(message => message.id), ["100", "200", "300"]);
assert.throws(
    () => runtime.fullLoadMessages([oldest, middle, newest]),
    /strictly newest-first/u,
    "an oldest-first LOAD would be reversed into a broken Discord timeline"
);

runtime.messageStoreReady = false;
assert.equal(runtime.messageCreate(bootMessage, {
    selected: false,
    visible: true,
    focused: true,
    rowPresent: false,
}), false, "MessageStore must drop MESSAGE_CREATE while the channel is not ready");
assert.equal(runtime.notifications, 1);
assert.equal(runtime.privateSortLastMessageId, bootMessage.id);
assert.equal(runtime.unreadCount, 1);
assert.equal(runtime.mentionCount, 1, "GROUP_DM unread must badge Discord Home");
assert.equal(runtime.rows.some(message => message.id === bootMessage.id), false);

runtime.fullLoadMessages([bootMessage, newest, middle, oldest]);
assert.deepEqual(runtime.rows.map(message => message.id), ["100", "200", "300", "400"]);
assert.equal(runtime.notifications, 1, "LOAD repair must not dispatch a duplicate notification");
assert.equal(runtime.unreadCount, 1, "LOAD repair must not increment read state twice");
assert.equal(runtime.mentionCount, 1, "LOAD repair must not increment the Home badge twice");

const focusedRuntime = new DiscordPrivateChannelRuntime();
focusedRuntime.channelCreate();
focusedRuntime.fullLoadMessages([]);
focusedRuntime.messageCreate(oldest, {
    selected: true,
    visible: true,
    focused: true,
    rowPresent: true,
});
assert.equal(focusedRuntime.unreadCount, 0);
assert.equal(focusedRuntime.mentionCount, 0);
for (const inactiveView of [
    { selected: true, visible: false, focused: true, rowPresent: true },
    { selected: true, visible: true, focused: false, rowPresent: true },
    { selected: true, visible: true, focused: true, rowPresent: false },
]) {
    const inactiveRuntime = new DiscordPrivateChannelRuntime();
    inactiveRuntime.channelCreate();
    inactiveRuntime.fullLoadMessages([]);
    inactiveRuntime.messageCreate(oldest, inactiveView);
    assert.equal(inactiveRuntime.unreadCount, 1, "selection alone must not clear a Matrix unread");
}

const unread = new EffectiveUnreadProjection();
unread.applySnapshot({ unreadCount: 0, highlightCount: 0, lastMessageId: newest.id });
unread.applyLive(bootMessage.id);
assert.deepEqual(unread.effective(true), {
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: bootMessage.id,
}, "a live row arriving before the SDK unread delta must not invent a local credit");
unread.applySnapshot(
    { unreadCount: 1, highlightCount: 0, lastMessageId: bootMessage.id }
);
assert.equal(unread.effective(true).unreadCount, 1,
    "the later authoritative unread delta must raise the floor exactly once");
unread.applySnapshot(
    { unreadCount: 0, highlightCount: 0, lastMessageId: newest.id }
);
assert.equal(unread.effective(true).unreadCount, 1, "a stale snapshot must not lower the SDK floor");
unread.applyLive(bootMessage.id);
unread.applyReaction(bootMessage.id);
assert.equal(unread.effective(true).unreadCount, 1,
    "duplicate message and reaction updates must not double-count the SDK unread floor");

const unreadBeforeLive = new EffectiveUnreadProjection();
unreadBeforeLive.applySnapshot({ unreadCount: 1, highlightCount: 0, lastMessageId: newest.id });
unreadBeforeLive.applyLive(bootMessage.id);
unreadBeforeLive.applyLive(bootMessage.id);
assert.deepEqual(unreadBeforeLive.effective(true), {
    unreadCount: 1,
    mentionCount: 1,
    lastMessageId: bootMessage.id,
}, "an SDK unread delta arriving before decryption/live projection must not be counted again");
const activeView = { selected: true, visible: true, focused: true, rowPresent: true };
assert.equal(unread.acknowledgeNewest(newest.id, activeView), false,
    "a receipt for an older row must not clear unread state");
for (const inactiveView of [
    { selected: false, visible: true, focused: true, rowPresent: true },
    { selected: true, visible: false, focused: true, rowPresent: true },
    { selected: true, visible: true, focused: false, rowPresent: true },
    { selected: true, visible: true, focused: true, rowPresent: false },
]) {
    assert.equal(unread.acknowledgeNewest(bootMessage.id, inactiveView), false,
        "selection, focus, visibility, and the exact row are all required to acknowledge");
}
assert.equal(unread.acknowledgeNewest(bootMessage.id, activeView, false), false,
    "a failed Matrix receipt must preserve unread state");
assert.equal(unread.acknowledgeNewest(bootMessage.id, activeView), true);
assert.equal(unread.effective(true).unreadCount, 0);
unread.applySnapshot({ unreadCount: 1, highlightCount: 0, lastMessageId: bootMessage.id });
assert.equal(unread.effective(true).unreadCount, 0,
    "a snapshot at or behind an acknowledged receipt must not resurrect unread state");

for (const [source, projected] of [
    ["https://x.com/alice/status/1234567890", "https://girlcockx.com/alice/status/1234567890"],
    ["https://www.twitter.com/i/web/status/1234567890?lang=en#media", "https://girlcockx.com/i/web/status/1234567890?lang=en#media"],
    ["http://mobile.x.com:80/i/status/12/", "https://girlcockx.com/i/status/12/"],
    ["https://X.COM/alice", "https://girlcockx.com/alice"],
    ["https://twitter.com:443/search?q=matrix#latest", "https://girlcockx.com/search?q=matrix#latest"],
    ["https://x.com/alice/status/1", "https://girlcockx.com/alice/status/1"],
] as const) {
    assert.equal(expectedMatrixDisplayUrl(source), projected);
}
for (const untouched of [
    "https://x.com.evil.example/alice/status/1234567890",
    "https://x.com:444/alice/status/1234567890",
    "https://alice@example.org@x.com/alice/status/1234567890",
    "https://api.fxtwitter.com/2/status/1234567890",
    "ftp://x.com/alice/status/1234567890",
]) {
    assert.equal(expectedMatrixDisplayUrl(untouched), untouched, `${untouched} must remain canonical`);
}

const canonicalXUrl = "https://x.com/alice/status/1234567890";
const commonStatus = {
    type: "status",
    id: "1234567890",
    provider: "twitter",
    author: { type: "profile", screen_name: "alice", name: "Alice" },
    text: "A bounded public post",
};
const textPreview = expectedFxTwitterPreview({
    code: 200,
    status: { ...commonStatus, embed_card: "tweet", media: {} },
}, canonicalXUrl, commonStatus.id);
assert.ok(textPreview);
assert.equal(textPreview.sourceUrl, canonicalXUrl);
assert.equal(textPreview.preview.url, canonicalXUrl);
assert.equal(textPreview.preview.image, undefined);
assert.equal(textPreview.preview.video, undefined);

const photoPreview = expectedFxTwitterPreview({
    code: 200,
    status: {
        ...commonStatus,
        embed_card: "summary_large_image",
        media: {
            photos: [{
                type: "photo",
                url: "https://pbs.twimg.com/media/HE-_ijrXYAA_Wiq.jpg?name=orig",
                width: 5_568,
                height: 3_712,
            }],
        },
    },
}, canonicalXUrl, commonStatus.id);
assert.ok(photoPreview?.preview.image);
assert.equal(photoPreview.preview.video, undefined);
assert.equal(photoPreview.imageUrl, "https://pbs.twimg.com/media/HE-_ijrXYAA_Wiq.jpg?name=orig");
assert.doesNotMatch(JSON.stringify(photoPreview.preview), /(?:fxtwitter|twimg)\.com/u,
    "provider media origins must stay in the worker cache, outside the renderer DTO");

const videoPreview = expectedFxTwitterPreview({
    code: 200,
    status: {
        ...commonStatus,
        embed_card: "player",
        media: {
            videos: [{
                type: "video",
                format: "video/mp4",
                url: "https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/video.mp4?tag=14",
                thumbnail_url: "https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/poster.jpg",
                width: 720,
                height: 1_280,
            }],
        },
    },
}, canonicalXUrl, commonStatus.id);
assert.ok(videoPreview?.preview.image);
assert.ok(videoPreview?.preview.video);
assert.doesNotMatch(JSON.stringify(videoPreview.preview), /(?:fxtwitter|twimg)\.com/u);

const animatedGifPreview = expectedFxTwitterPreview({
    code: 200,
    status: {
        ...commonStatus,
        embed_card: "player",
        media: {
            videos: [{
                type: "gif",
                format: "video/mp4",
                url: "https://video.twimg.com/tweet_video/animated.mp4",
                thumbnail_url: "https://pbs.twimg.com/tweet_video_thumb/animated.jpg",
                width: 640,
                height: 360,
            }],
        },
    },
}, canonicalXUrl, commonStatus.id);
assert.ok(animatedGifPreview?.preview.image);
assert.ok(animatedGifPreview?.preview.video,
    "FxTwitter's gif media type is an MP4 player and must use the bounded video path");

for (const preview of [textPreview, photoPreview, videoPreview, animatedGifPreview]) {
    assert.ok(preview);
    assert.equal(validXPreviewMediaCache({
        imageUrl: preview.imageUrl,
        videoUrl: preview.videoUrl,
        hasImage: preview.preview.image != null,
        hasVideo: preview.preview.video != null,
    }), true, "text, photo, and video worker caches must each validate exactly");
    assert.equal(expectedMatrixDisplayText(`see ${preview.sourceUrl}`),
        "see https://girlcockx.com/alice/status/1234567890");
    assert.equal(expectedMatrixDisplayUrl(preview.preview.url),
        "https://girlcockx.com/alice/status/1234567890");
    assert.equal(preview.sourceUrl, canonicalXUrl, "renderer projection must not mutate provider cache identity");
}
assert.equal(validXPreviewMediaCache({
    imageUrl: photoPreview?.imageUrl,
    hasImage: false,
    hasVideo: false,
}), false, "a worker media URL without its opaque DTO handle must invalidate the cache");

assert.equal(expectedFxTwitterPreview({
    code: 200,
    status: { ...commonStatus, embed_card: "unknown", media: {} },
}, canonicalXUrl, commonStatus.id), undefined);
assert.equal(expectedFxTwitterPreview({
    code: 200,
    status: {
        ...commonStatus,
        author: { screen_name: "alice", name: "Alice" },
        embed_card: "tweet",
        media: {},
    },
}, canonicalXUrl, commonStatus.id), undefined,
"FxTwitter authors must identify themselves as exact profile records");
assert.equal(expectedFxTwitterPreview({
    code: 200,
    status: { ...commonStatus, embed_card: "tweet", media: { photos: new Array(5).fill({}) } },
}, canonicalXUrl, commonStatus.id), undefined);
assert.equal(expectedFxTwitterPreview({
    code: 200,
    status: { ...commonStatus, embed_card: "player", media: { videos: new Array(17).fill({}) } },
}, canonicalXUrl, commonStatus.id), undefined);
const invalidPhotoFallsBackToText = expectedFxTwitterPreview({
    code: 200,
    status: {
        ...commonStatus,
        embed_card: "summary_large_image",
        media: { photos: [{ type: "photo", url: "https://evil.example/image.jpg", width: 100, height: 100 }] },
    },
}, canonicalXUrl, commonStatus.id);
assert.ok(invalidPhotoFallsBackToText);
assert.equal(invalidPhotoFallsBackToText.preview.image, undefined);

const newestFirstProjection = section(
    bridge,
    "function newestFirstRawMessages(",
    "/**\n * LOAD_MESSAGES_SUCCESS intentionally preserves Discord's optimistic rows."
);
assert.match(
    newestFirstProjection,
    /\[\.\.\.messages\]\.reverse\(\)\.map/u,
    "Matrix's oldest-first timeline must be projected as Discord's newest-first LOAD payload"
);
assert.match(newestFirstProjection, /BigInt\(raw\[index - 1\]\.id\) <= BigInt\(id\)/u,
    "the renderer boundary must reject duplicate or non-descending LOAD rows");
const fullTimelineLoad = section(bridge, "function injectRoomTimeline(", "function reinjectRoomTimelines(");
assert.match(fullTimelineLoad, /const rawMessages = newestFirstRawMessages\(projectedMessages, injected\)/u);
assert.match(fullTimelineLoad, /messages: rawMessages/u);
const incrementalTimelineLoad = section(bridge, "function loadProjectionMessages(", "function snapshotRoom(");
assert.match(incrementalTimelineLoad, /const rawMessages = newestFirstRawMessages\(projectedMessages, injected\)/u);
assert.match(incrementalTimelineLoad, /messages: rawMessages/u,
    "incremental Matrix pages must use Discord's validated newest-first LOAD payload");

const xStatusApi = section(backend, "function xStatusApiUrl(", "function xVideoUrl(");
assert.match(xStatusApi, /https:\/\/api\.fxtwitter\.com\/2\/status/u);

const displayHosts = section(bridge, "const PROJECTED_X_HOSTS", "const createChannelRecordFromServer");
assert.deepEqual(
    [...displayHosts.matchAll(/"([^"]+)"/gu)].map(match => match[1]),
    ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]
);
const displayUrlProjection = section(
    bridge,
    "export function projectMatrixDisplayUrl(",
    "export function projectMatrixDisplayText("
);
for (const contract of [
    /PROJECTED_X_HOSTS\.has\(hostname\)/u,
    /url\.username \|\| url\.password/u,
    /\[hostname, `\$\{hostname\}:443`\]/u,
    /\[hostname, `\$\{hostname\}:80`\]/u,
    /`https:\/\/girlcockx\.com\$\{candidate\.slice\(authorityEnd\)\}`/u,
]) {
    assert.match(displayUrlProjection, contract);
}
assert.doesNotMatch(displayUrlProjection, /\/status\//u,
    "renderer projection must cover every exact X/Twitter URL, not only statuses");
const displayTextProjection = section(bridge, "export function projectMatrixDisplayText(", "function previewMediaKey(");
assert.match(displayTextProjection, /body\.replace\([\s\S]*projectMatrixDisplayUrl\(candidate\)/u);
const previewEmbedProjection = section(bridge, "function rawPreviewEmbeds(", "const STICKER_IMAGE_TYPES");
assert.match(previewEmbedProjection,
    /const canonicalSourceUrl = preview \? safePreviewEmbedUrl\(preview\.url\)[\s\S]*projectMatrixDisplayUrl\(canonicalSourceUrl\)/u,
    "the Discord card URL must use the same renderer-only projection as message content");
const rawMessageProjection = section(bridge, "function rawMessage(", "function toRawMessage(");
assert.match(rawMessageProjection, /projectMatrixDisplayText\(projectedMentions\.body\)/u);
const stickerProjection = section(bridge, "function stickerBodyFallback(", "function rawStickerEmbeds(");
assert.match(stickerProjection, /projectMatrixDisplayText\(body\)/u);
const outboundMessage = section(bridge, "export async function sendMatrixMessage(", "export async function sendMatrixSticker(");
assert.doesNotMatch(outboundMessage, /projectMatrixDisplay/u,
    "girlcockx projection must never alter the canonical Matrix message body");
assert.match(outboundMessage, /Native\.sendText\([\s\S]*projected\.body/u);

const xWorkerProjection = section(backend, "async function xUrlPreview(", "async function tenorUrlPreview(");
assert.match(xWorkerProjection, /const parsed = parseFxTwitterStatus\(response, request\.statusId\)/u);
assert.match(xWorkerProjection, /url: sourceUrl/u);
assert.match(xWorkerProjection, /imageUrl: parsed\.image\?\.url/u);
assert.match(xWorkerProjection, /videoUrl: parsed\.video\?\.url/u);
const previewDto = section(types, "export interface MatrixUrlPreviewDTO", "export interface MatrixReactionDTO");
assert.doesNotMatch(previewDto, /fxtwitter|twimg|imageUrl|videoUrl/iu,
    "provider media URLs must remain worker-private and cross IPC only as opaque handles");

const privateChannelProjection = section(bridge, "function privateChannel(", "function guildChannel(");
assert.match(privateChannelProjection, /type: directMember \? ChannelType\.DM : ChannelType\.GROUP_DM/u,
    "standalone Matrix groups must project as Discord GROUP_DM rows under Home");
assert.doesNotMatch(privateChannelProjection, /guild_id/u);

const unreadSync = section(bridge, "function syncProjectionUnread(", "function removeInjectedChannel(");
assert.match(unreadSync, /BigInt\(latest\.messageId\) <= BigInt\(floor\.acknowledgedMessageId\)/u,
    "a snapshot at or behind a successful receipt must not resurrect unread state");
assert.match(unreadSync, /Math\.max\(floor\.unreadCount, safeUnreadCount\(room\.unreadCount\)\)/u,
    "snapshots may raise but never roll back the live unread floor");
assert.match(unreadSync, /highlightCount: guildId \? floor\.highlightCount : floor\.unreadCount/u,
    "DM and GROUP_DM unread rows must badge Discord Home like native private messages");
assert.match(unreadSync, /publishMatrixUnreadChange\(Boolean\(guildId\)\)/u,
    "authoritative Matrix unread publication must invalidate Discord's native guild-read cache");
const unreadPublisher = section(bridge, "function publishMatrixUnreadChange(", "function syncProjectionUnread(");
assert.match(unreadPublisher, /ReadStateStore as any\)\.emitChange\?\.\(\)/u);
assert.match(unreadPublisher, /if \(recomputeGuildReadState\) invalidateMatrixGuildReadState\(\)/u,
    "ReadStateStore and GuildReadStateStore must be invalidated together");
const deltaUnread = section(bridge, "function applyDeltaUnread(", "function applyMessageDelta(");
assert.match(deltaUnread, /projectionHasMessage\(current\.channelId, lastMessageId\)/u,
    "unread publication must wait until the exact Discord row exists");
assert.match(deltaUnread, /syncProjectionUnread\(current\.channelId, current\.room, current\.guildId\)/u);
assert.doesNotMatch(deltaUnread, /(?:unreadCount|highlightCount)\s*(?:\+\+|\+=)/u,
    "message projection must not double-count the Matrix SDK's authoritative unread counters");
assert.match(bridge,
    /function applyReactionDelta[\s\S]*?applyMessageDelta\(roomId, \{ \.\.\.message, reactions \}, false\);/u,
    "reaction-only updates must remain explicitly update-only");
assert.doesNotMatch(bridge, /anchoredMessageDeltasByRoom|drainAnchoredMessageDeltas/u,
    "timeline recovery must not retain an unbounded renderer-side pending delta buffer");
const historyMerge = section(bridge, "function mergeRoomHistory(", "function roomWithHistory(");
assert.match(historyMerge, /externalNextAnchor[\s\S]*externalPreviousAnchor/u);
assert.match(historyMerge, /merged\.splice\(Math\.max\(0, anchorIndex\), 0, \.\.\.segment\)/u,
    "a later-decrypted older Matrix row must insert before its already-projected next anchor");
const oldestUnread = section(bridge, "function oldestProjectedUnreadMessageId(", "export function installReadStateProjection(");
assert.match(oldestUnread, /projectedTimelineMessages\(roomMessages\(injected\.room\), injected\)/u,
    "oldest unread must index projected Discord rows rather than raw Matrix events");

const liveMessageDelta = section(bridge, "function applyMessageDelta(", "function applyRedactionDelta(");
const primaryCreateStart = liveMessageDelta.indexOf("} else if (!wasProjected && next.channelId === primary?.channelId)");
const primaryCreateEnd = liveMessageDelta.indexOf("} else {", primaryCreateStart);
assert.notEqual(primaryCreateStart, -1);
assert.notEqual(primaryCreateEnd, -1);
const primaryCreate = liveMessageDelta.slice(primaryCreateStart, primaryCreateEnd);
assert.equal(primaryCreate.match(/type: "MESSAGE_CREATE"/gu)?.length, 1,
    "the real gateway-style message action must be emitted exactly once");
assert.match(primaryCreate, /scheduleMessageStoreConvergence\(next, projected\.messageId\)/u,
    "convergence must repair the row after notification reducers saw MESSAGE_CREATE");
assert.ok(
    liveMessageDelta.indexOf('type: "CHANNEL_CREATE"', primaryCreateStart - 200) < liveMessageDelta.indexOf('type: "MESSAGE_CREATE"', primaryCreateStart),
    "CHANNEL_CREATE must seed PrivateChannelSort before MESSAGE_CREATE"
);
const messageStoreConvergence = section(bridge, "function convergeMessageStore(", "function snapshotRoom(");
assert.doesNotMatch(messageStoreConvergence, /MESSAGE_CREATE["']/u,
    "convergence must never replay the gateway-style create action");
assert.match(messageStoreConvergence, /if \(ready\)[\s\S]*injectRoomTimeline\(/u,
    "a dropped already-dispatched CREATE must be repaired by a full LOAD, not another CREATE");

const receiptFlush = section(bridge, "async function flushMatrixReceipt(", "function receiptPosition(");
assert.ok(receiptFlush.indexOf("await Native.read") < receiptFlush.indexOf("floor.unreadCount = 0"),
    "the monotonic unread floor may clear only after Matrix accepts the exact receipt");
assert.match(receiptFlush, /currentPosition\.index !== currentPosition\.latestIndex/u);
assert.match(receiptFlush, /publishMatrixUnreadChange\(guildReadStateChanged\)/u,
    "a successful newest-event Matrix receipt must clear the native server-rail badge");
const receiptVisibility = section(bridge, "function canAcknowledgeProjectedMessage(", "function requestedJumpMessageId(");
assert.match(receiptVisibility, /SelectedChannelStore\.getChannelId\(\) === channelId/u);
assert.match(receiptVisibility, /document\.visibilityState === "visible"/u);
assert.match(receiptVisibility, /document\.hasFocus\(\)/u);
assert.match(receiptVisibility, /MessageStore\.getMessage\(channelId, messageId\)/u);

const eventPoll = section(bridge, "async function pollEvents(", "async function connectBridge(");
const firstEventHandler = eventPoll.indexOf('if (event.type === "snapshot"');
const finalCursorCommit = eventPoll.lastIndexOf("eventCursor = Math.max(eventCursor, nextCursor)");
assert.notEqual(firstEventHandler, -1);
assert.notEqual(finalCursorCommit, -1);
assert.doesNotMatch(eventPoll.slice(0, firstEventHandler), /eventCursor\s*=/u,
    "polling must not advance the cursor before renderer application begins");
for (const handler of ["applySnapshot(", "applyRoomDelta(", "applyMessageDelta(", "applyRedactionDelta(", "applyReactionDelta(", "updateTypingUsers("]) {
    const position = eventPoll.indexOf(handler, firstEventHandler);
    assert.ok(position !== -1 && position < finalCursorCommit,
        `${handler} must complete before the event cursor commits`);
}
assert.match(eventPoll,
    /WORKER_RECOVERY_ERRORS[\s\S]*eventCursor = Math\.max\(eventCursor, nextCursor\);[\s\S]*scheduleBridgeReconnect/u,
    "an intentionally consumed recovery status must commit before returning");
assert.match(eventPoll, /event\.type === "receipt"[\s\S]*eventCursor = Math\.max\(eventCursor, nextCursor\)/u,
    "intentionally consumed receipt events must reach the common cursor commit");

let throwingApplyCursor = 0;
const applyThenCommit = (seq: number, apply: () => void) => {
    apply();
    throwingApplyCursor = Math.max(throwingApplyCursor, seq);
};
assert.throws(() => applyThenCommit(7, () => { throw new Error("projection failed"); }));
assert.equal(throwingApplyCursor, 0, "a throwing renderer apply must leave the event replayable");
applyThenCommit(7, () => undefined);
assert.equal(throwingApplyCursor, 7, "the replayed event commits only after successful application");

const bridgeConnect = section(bridge, "async function connectBridge(", "export async function startBridge(");
assert.ok(bridgeConnect.indexOf("applySnapshot(snapshot")
    < bridgeConnect.indexOf("eventCursor = Math.max(eventCursor, snapshotSequence)"),
"startup snapshots must project successfully before their sequence commits");
