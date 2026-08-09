/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { ChannelType, MessageReferenceType, MessageType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findByProps } from "@webpack";
import { ChannelStore, closeModal, FluxDispatcher, GuildStore, MessageActions, MessageStore, NavigationRouter, PermissionsBits, ReadStateStore, RestAPI, SelectedChannelStore, SelectedGuildStore, showToast, Toasts, UserStore } from "@webpack/common";

import { matrixErrorCode } from "./errorCode";
import type {
    MatrixSecureViewBounds,
    MatrixSecureViewControlState,
    MatrixSecureViewRoute,
} from "./secureViewProtocol";
import type {
    MatrixAttachmentGroupDTO,
    MatrixHistoryPageDTO,
    MatrixMessageContextDTO,
    MatrixMessageSearchRequest,
    MatrixMessageSearchResponse,
    MatrixMessageSearchResultDTO,
    MatrixMessageSearchScope,
} from "./types";

const Native = VencordNative.pluginHelpers.MatrixBridge as PluginNative<typeof import("./native")>;
const logger = new Logger("MatrixBridge", "#0dbd8b");

const DISCORD_EPOCH = 1_420_070_400_000n;
const SYNTHETIC_ID_BASE = Date.UTC(2020, 0, 1);
const SYNTHETIC_JOINED_AT = new Date(SYNTHETIC_ID_BASE).toISOString();
const LOW_SNOWFLAKE_BITS = (1n << 22n) - 1n;
const MAX_DISCORD_SNOWFLAKE_TIMESTAMP = Number(DISCORD_EPOCH + (1n << 42n) - 1n);
const MAX_HYDRATED_MEDIA = 24;
const MAX_ACTIVE_MEDIA_DOWNLOADS = 3;
const MAX_LOADED_ROOM_MESSAGES = 10_000;
const MAX_MESSAGE_ID_CACHE = 50_000;
const MAX_RESERVED_REPLY_IDS = 10_000;
const MAX_PROJECTED_GUILD_MEMBERS = 2_000;
const MATRIX_ROUTE_KEY = "MatrixBridge_lastRoute";
// Preview videos are independently capped at 96 MiB by the native boundary.
// Keep enough aggregate headroom for one maximum-sized video and its poster;
// older lower-priority blobs are still evicted before this limit is crossed.
const MAX_HYDRATED_MEDIA_ITEM_BYTES = 96 * 1024 * 1024;
const MAX_HYDRATED_MEDIA_BYTES = 128 * 1024 * 1024;
const PROJECTED_SOCIAL_HOSTS = new Set([
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
]);

const createChannelRecordFromServer = findByCodeLazy(".GUILD_TEXT]", "fromServer)");

export interface MatrixMemberDto {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    membership?: string;
    powerLevel?: number;
}

export interface MatrixReactionDto {
    key: string;
    count?: number;
    senders?: string[];
    reactedByMe?: boolean;
    me?: boolean;
}

export interface MatrixAttachmentDto {
    id?: string;
    name?: string;
    fileName?: string;
    url?: string;
    proxyUrl?: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    animated?: boolean;
    flags?: number;
    downloadable?: boolean;
    encrypted?: boolean;
    thumbnailUrl?: string;
}

interface MatrixMediaDownloadDto {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    width?: number;
    height?: number;
    animated?: boolean;
}

interface MatrixUrlPreviewMediaDto extends MatrixAttachmentDto {
    downloadable: true;
    downloadIndex: 0 | 1;
}

interface MatrixUrlPreviewDto {
    url: string;
    title?: string;
    description?: string;
    provider?: { name: string; };
    image?: MatrixUrlPreviewMediaDto;
    video?: MatrixUrlPreviewMediaDto;
}

export interface MatrixStickerDescriptor {
    id: string;
    name: string;
    formatType: 1 | 2 | 4;
}

export interface MatrixAttachmentDescriptor {
    name: string;
    txnId: string;
    declaredMimeType?: string;
    bytes: Uint8Array<ArrayBuffer>;
    caption?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    attachmentGroup?: MatrixAttachmentGroupDTO;
}

export interface MatrixMessageDto {
    eventId: string;
    roomId: string;
    senderId: string;
    senderName?: string;
    timestamp: number;
    body: string;
    sticker?: true;
    edited?: boolean;
    editedAt?: number;
    replyToEventId?: string;
    attachments?: MatrixAttachmentDto[];
    attachmentGroup?: MatrixAttachmentGroupDTO;
    reactions?: MatrixReactionDto[];
    decryptionFailure?: boolean;
    pending?: boolean;
    failed?: boolean;
    transactionId?: string;
}

export interface MatrixRoomDto {
    roomId: string;
    timelineGeneration?: number;
    name?: string;
    membership?: "join" | "invite";
    kind?: "space" | "room" | "dm";
    roomType?: string;
    joinRule?: "public" | "invite" | "knock" | "restricted" | "knock_restricted" | "private";
    directUserId?: string;
    inviterId?: string;
    parentIds?: string[];
    childIds?: string[];
    spaceChildren?: Array<{
        roomId: string;
        order?: string;
        suggested?: boolean;
    }>;
    canManageSpaceChildren?: boolean;
    accessRequestCount?: number;
    accessRequestCountComplete?: boolean;
    canApproveAccessRequests?: boolean;
    canDenyAccessRequests?: boolean;
    topic?: string;
    avatarUrl?: string;
    encrypted?: boolean;
    members?: MatrixMemberDto[];
    messages?: MatrixMessageDto[];
    timeline?: MatrixMessageDto[];
    prevToken?: string;
    unreadCount?: number;
    highlightCount?: number;
}

export interface MatrixSnapshotDto {
    seq?: number;
    status?: { state?: string; error?: unknown; };
    account?: { userId?: string; };
    userId?: string;
    rooms?: MatrixRoomDto[];
}

interface InjectedRoom {
    room: MatrixRoomDto;
    channelId: string;
    guildId?: string;
    parentId?: string;
    parentSpaceId?: string;
    channelPosition?: number;
    selfMatrixId?: string;
    messageIds: Map<string, string>;
    eventIds: Map<string, string>;
    messageTargets: Map<string, ProjectedMessageTarget>;
    projectedMessagesByEventId: Map<string, ProjectedTimelineMessage>;
    isolatedContext?: boolean;
    contextTargetMessageId?: string;
}

interface ProjectedMessageTarget {
    /** Every underlying Matrix event represented by this Discord row, in attachment order. */
    eventIds: string[];
    /** Index zero is the stable reply/reaction anchor for the lifetime of the row. */
    actionEventId: string;
    /** The highest present index owns the caption and therefore edit routing. */
    editEventId: string;
    /** Do not mutate a partially local/pending group through its projected row. */
    blocked: boolean;
    missingAnchor: boolean;
    hasAttachments: boolean;
}

interface ProjectedAttachmentSource {
    message: MatrixMessageDto;
    attachment: MatrixAttachmentDto;
    index: number;
}

interface ProjectedTimelineMessage {
    message: MatrixMessageDto;
    messageId: string;
    target: ProjectedMessageTarget;
    attachmentSources: ProjectedAttachmentSource[];
}

interface RoomHistoryState {
    messages: MatrixMessageDto[];
    timelineGeneration: number;
    beforeCursor?: string;
    end: boolean;
    capped: boolean;
}

type MediaCacheState = "queued" | "loading" | "ready" | "unavailable" | "failed" | "discarded";

interface HydratedMedia {
    attachment: MatrixAttachmentDto;
    objectUrl: string;
    byteLength: number;
}

interface MediaCacheEntry {
    state: MediaCacheState;
    priority: number;
    attachment?: MatrixAttachmentDto;
    objectUrl?: string;
    byteLength?: number;
    preview?: MatrixUrlPreviewDto;
}

interface MediaJob {
    key: string;
    generation: number;
    load: (onPreview: (preview: MatrixUrlPreviewDto) => void) => Promise<HydratedMedia | undefined>;
}

interface MediaCandidate {
    key: string;
    priority: number;
    load: (onPreview: (preview: MatrixUrlPreviewDto) => void) => Promise<HydratedMedia | undefined>;
}

let activeMatrixChannelId: string | undefined;
let latestSnapshot: MatrixSnapshotDto | undefined;
let pollGeneration = 0;
let eventCursor = 0;
let bridgeActive = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const roomsByChannel = new Map<string, InjectedRoom>();
const injectedChannelIds = new Set<string>();
const injectedGuildIds = new Set<string>();
const syntheticChannelIds = new Set<string>();
const syntheticGuildIds = new Set<string>();
const spaceIdsByGuildId = new Map<string, string>();
const guildIdsBySpaceId = new Map<string, Set<string>>();
const projectedRoomIdsByGuildId = new Map<string, Set<string>>();
const leavingMatrixSpaceSessions = new Set<string>();
const leavingMatrixGroupSessions = new Set<string>();
const accessRequestProjectionListeners = new Set<(contexts: readonly MatrixAccessRequestContext[]) => void>();
const spaceCreateContextsByCategoryId = new Map<string, {
    guildId: string;
    parentSpaceId: string;
    parentLabel: string;
}>();
const guildProjectionSignatures = new Map<string, string>();
const matrixUserIdsBySyntheticId = new Map<string, string>();
const spaceIdsBySyntheticUserId = new Map<string, Set<string>>();
const protectedSyntheticIds = new Set<string>();
const messageIdsByEventId = new Map<string, string>();
const reservedReplyEventIds = new Set<string>();
const reservedReplyTargets = new Map<string, { roomId: string; eventId: string; }>();
const eventIdsByTransaction = new Map<string, string>();
const roomHistoryById = new Map<string, RoomHistoryState>();
const paginationRequestsByRoom = new Map<string, number>();
const matrixSearchModalKeys = new Set<string>();
const mediaFocusEventIdsByRoom = new Map<string, string[]>();
const typingUsersByRoom = new Map<string, Set<string>>();
const lastOutgoingTyping = new Map<string, number>();
const pendingReceiptsByRoom = new Map<string, {
    eventId: string;
    timer: ReturnType<typeof setTimeout>;
}>();
const lastReceiptEventByRoom = new Map<string, string>();
const originalRestMethods = new Map<string, Function>();
const originalHighLevelRestMethods = new Map<string, Function>();
const originalReadStateMethods = new Map<string, Function>();
let guardedRestApi: Record<string, Function> | undefined;
let highLevelRestGuardInstalled = false;
const matrixUnreadByChannel = new Map<string, {
    unreadCount: number;
    highlightCount: number;
    lastMessageId: string | null;
}>();
let matrixUnreadRevision = 0;
const mediaCache = new Map<string, MediaCacheEntry>();
let wantedMediaKeys = new Set<string>();
let mediaQueue: MediaJob[] = [];
let activeMediaJobs = 0;
let mediaGeneration = 0;
let hydratedMediaBytes = 0;
let scheduledMediaRefreshGeneration: number | undefined;
let lastPersistedRoute = "";
let clearedLoggedOutRoute = false;
let routeStorageTail: Promise<void> = Promise.resolve();
let secureViewControlTail: Promise<unknown> = Promise.resolve();

interface MatrixRoutePreference {
    accountId: string;
    roomId: string;
    channelId: string;
}

function hash64(value: string) {
    let hash = 14_695_981_039_346_656_037n;
    for (let index = 0; index < value.length; index++) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
    }
    return hash;
}

function stableSyntheticId(namespace: string, value: string) {
    const hash = hash64(`${namespace}\0${value}`);
    const timestampOffset = Number((hash >> 22n) & 0xffff_ffffn);
    const timestamp = BigInt(SYNTHETIC_ID_BASE + timestampOffset);
    return (((timestamp - DISCORD_EPOCH) << 22n) | (hash & LOW_SNOWFLAKE_BITS)).toString();
}

function reserveReplyEventId(eventId: string) {
    reservedReplyEventIds.delete(eventId);
    reservedReplyEventIds.add(eventId);
    while (reservedReplyEventIds.size > MAX_RESERVED_REPLY_IDS) {
        reservedReplyEventIds.delete(reservedReplyEventIds.values().next().value!);
    }
}

function trimMessageIdCache() {
    if (messageIdsByEventId.size <= MAX_MESSAGE_ID_CACHE) return;
    for (const eventId of messageIdsByEventId.keys()) {
        if (reservedReplyEventIds.has(eventId)) continue;
        messageIdsByEventId.delete(eventId);
        if (messageIdsByEventId.size <= MAX_MESSAGE_ID_CACHE) return;
    }
    while (messageIdsByEventId.size > MAX_MESSAGE_ID_CACHE) {
        const eventId = messageIdsByEventId.keys().next().value!;
        messageIdsByEventId.delete(eventId);
        reservedReplyEventIds.delete(eventId);
    }
}

function messageSyntheticId(eventId: string, timestamp: number, reserveReply = false) {
    if (reserveReply) reserveReplyEventId(eventId);
    const existing = messageIdsByEventId.get(eventId);
    if (existing) {
        messageIdsByEventId.delete(eventId);
        messageIdsByEventId.set(eventId, existing);
        return existing;
    }
    const hash = hash64(`event\0${eventId}`);
    const safeTimestamp = Number.isFinite(timestamp)
        && timestamp > Number(DISCORD_EPOCH)
        && timestamp <= MAX_DISCORD_SNOWFLAKE_TIMESTAMP
        ? Math.floor(timestamp)
        : SYNTHETIC_ID_BASE + Number((hash >> 22n) & 0xffff_ffffn);
    const id = ((BigInt(safeTimestamp) - DISCORD_EPOCH) << 22n | (hash & LOW_SNOWFLAKE_BITS)).toString();
    messageIdsByEventId.set(eventId, id);
    trimMessageIdCache();
    return id;
}

function rememberReservedReplyTarget(channelId: string, messageId: string, roomId: string, eventId: string) {
    const key = `${channelId}\0${messageId}`;
    reservedReplyTargets.delete(key);
    while (reservedReplyTargets.size >= MAX_RESERVED_REPLY_IDS) {
        reservedReplyTargets.delete(reservedReplyTargets.keys().next().value!);
    }
    reservedReplyTargets.set(key, { roomId, eventId });
}

function messageTimestampIso(timestamp: number, fallback = SYNTHETIC_ID_BASE) {
    const safeFallback = Number.isFinite(fallback)
        && fallback >= -8_640_000_000_000_000
        && fallback <= 8_640_000_000_000_000
        ? fallback
        : SYNTHETIC_ID_BASE;
    const safeTimestamp = Number.isFinite(timestamp)
        && timestamp >= -8_640_000_000_000_000
        && timestamp <= 8_640_000_000_000_000
        ? timestamp
        : safeFallback;
    return new Date(safeTimestamp).toISOString();
}

function rawCurrentUser() {
    const user: any = UserStore.getCurrentUser();
    return {
        id: user.id,
        username: user.username,
        global_name: user.globalName ?? null,
        display_name: user.globalName ?? user.username,
        discriminator: user.discriminator ?? "0",
        avatar: user.avatar ?? null,
        bot: false,
        system: false,
        public_flags: user.publicFlags ?? 0,
        flags: user.flags ?? 0,
    };
}

function safeUsername(userId: string) {
    const localpart = userId.split(":", 1)[0].replace(/^@/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return localpart || "matrix_user";
}

function rawMatrixUser(member: MatrixMemberDto) {
    // Never create a second synthetic identity for the authenticated Matrix
    // account. Match only the exact account ID; display names are not unique
    // and must never be treated as an identity link.
    const selfMatrixId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    if (selfMatrixId && member.userId === selfMatrixId) return rawCurrentUser();

    const displayName = member.displayName?.trim() || member.userId;
    const id = protectSyntheticId(stableSyntheticId("user", member.userId));
    matrixUserIdsBySyntheticId.set(id, member.userId);
    return {
        id,
        username: safeUsername(member.userId),
        global_name: displayName,
        display_name: displayName,
        discriminator: "0",
        avatar: null,
        bot: false,
        system: false,
        public_flags: 0,
        flags: 0,
    };
}

function protectSyntheticId(id: string) {
    protectedSyntheticIds.add(id);
    return id;
}

function rememberSyntheticChannelId(id: string) {
    syntheticChannelIds.add(id);
    return protectSyntheticId(id);
}

function rememberSyntheticGuildId(id: string) {
    syntheticGuildIds.add(id);
    return protectSyntheticId(id);
}

function roomMessages(room: MatrixRoomDto) {
    return [...(room.messages ?? room.timeline ?? [])];
}

const ATTACHMENT_GROUP_ID_PATTERN = /^vcgrp_[0-9a-f]{64}$/u;

function validAttachmentGroup(message: MatrixMessageDto) {
    const group = message.attachmentGroup;
    return group
        && ATTACHMENT_GROUP_ID_PATTERN.test(group.id)
        && Number.isSafeInteger(group.index)
        && Number.isSafeInteger(group.total)
        && group.total >= 2
        && group.total <= 10
        && group.index >= 0
        && group.index < group.total
        && message.attachments?.length === 1
        ? group
        : undefined;
}

function messageEchoIdentity(message: MatrixMessageDto) {
    const group = validAttachmentGroup(message);
    if (group) return `attachment-group\0${message.senderId}\0${group.id}\0${group.total}\0${group.index}`;
    if (message.transactionId
        && message.transactionId.length <= 128
        && /^[A-Za-z0-9._~-]+$/u.test(message.transactionId)) {
        return `txn\0${message.transactionId}`;
    }
    return undefined;
}

function preserveLocalEchoMessageId(localEventId: string, remote: MatrixMessageDto) {
    const pendingMessageId = messageIdsByEventId.get(localEventId);
    if (!pendingMessageId) return false;
    messageIdsByEventId.set(remote.eventId, pendingMessageId);
    messageIdsByEventId.delete(localEventId);
    return true;
}

function rememberTransactionEvent(message: MatrixMessageDto) {
    if (!message.transactionId) return;
    eventIdsByTransaction.set(`${message.roomId}\0${message.transactionId}`, message.eventId);
    if (eventIdsByTransaction.size > MAX_LOADED_ROOM_MESSAGES) {
        eventIdsByTransaction.delete(eventIdsByTransaction.keys().next().value!);
    }
}

function singleProjectedMessage(
    message: MatrixMessageDto,
    previous?: InjectedRoom
): ProjectedTimelineMessage {
    const attachmentGroup = validAttachmentGroup(message);
    const missingAnchor = Boolean(attachmentGroup && attachmentGroup.index !== 0);
    const messageId = previous?.messageIds.get(message.eventId)
        ?? messageSyntheticId(message.eventId, message.timestamp);
    return {
        message,
        messageId,
        target: {
            eventIds: [message.eventId],
            actionEventId: message.eventId,
            editEventId: message.eventId,
            blocked: message.pending || !message.eventId.startsWith("$") || missingAnchor,
            missingAnchor,
            hasAttachments: Boolean(message.attachments?.length),
        },
        attachmentSources: (message.attachments ?? []).map((attachment, index) => ({
            message,
            attachment,
            index,
        })),
    };
}

/**
 * Coalesces only explicitly-marked attachment events. The underlying Matrix
 * events remain intact in history; this is a Discord-store presentation view.
 */
function projectedTimelineMessages(
    messages: MatrixMessageDto[],
    previous?: InjectedRoom
): ProjectedTimelineMessage[] {
    interface AttachmentGroupMember {
        position: number;
        message: MatrixMessageDto;
        group: MatrixAttachmentGroupDTO;
    }

    // Validate the complete visible occurrence set for a marker before
    // coalescing any of it. A group must be physically adjacent, start at
    // index zero, retain one sender/total, and increase monotonically. Gaps are
    // allowed so a redacted member does not split an otherwise safe group.
    const candidates = new Map<string, AttachmentGroupMember[]>();
    for (let position = 0; position < messages.length; position++) {
        const message = messages[position];
        const group = validAttachmentGroup(message);
        if (!group) continue;
        const key = `${message.roomId}\0${group.id}`;
        const members = candidates.get(key) ?? [];
        members.push({ position, message, group });
        candidates.set(key, members);
    }

    const groupedByFirstPosition = new Map<number, MatrixMessageDto[]>();
    const groupedPositions = new Set<number>();
    for (const members of candidates.values()) {
        const first = members[0];
        const valid = first.group.index === 0
            && members.every((member, index) =>
                member.position === first.position + index
                && member.message.senderId === first.message.senderId
                && member.group.total === first.group.total
                && (index === 0 || member.group.index > members[index - 1].group.index));
        if (!valid) continue;
        groupedByFirstPosition.set(first.position, members.map(member => member.message));
        for (const member of members) groupedPositions.add(member.position);
    }

    const result: ProjectedTimelineMessage[] = [];
    for (let position = 0; position < messages.length; position++) {
        const members = groupedByFirstPosition.get(position);
        if (!members) {
            if (!groupedPositions.has(position)) {
                result.push(singleProjectedMessage(messages[position], previous));
            }
            continue;
        }
        const base = members[0];
        const action = members.at(-1)!;
        const attachmentSources = members.flatMap(message =>
            (message.attachments ?? []).map((attachment, index) => ({ message, attachment, index })));
        const eventIds = members.map(message => message.eventId);
        // Only index zero may supply the aggregate row identity. Reusing a
        // suffix member's temporary row would make pagination/search produce
        // a different Discord ID than a clean restart with the full group.
        const existingMessageId = previous?.messageIds.get(base.eventId)
            ?? messageIdsByEventId.get(base.eventId);
        const messageId = existingMessageId ?? messageSyntheticId(base.eventId, base.timestamp);
        result.push({
            message: {
                ...action,
                // The first event owns the stable Discord row; the highest
                // present index owns the user-visible caption/action state.
                eventId: base.eventId,
                timestamp: base.timestamp,
                attachments: attachmentSources.map(source => source.attachment),
                pending: members.some(message => message.pending) || undefined,
                failed: members.some(message => message.failed) || undefined,
                decryptionFailure: members.some(message => message.decryptionFailure) || undefined,
                transactionId: base.transactionId ?? action.transactionId,
                // Reactions are routed to the stable index-zero anchor. Keep
                // its aggregate on the displayed row while caption/reply/edit
                // fields continue to come from the highest present member.
                reactions: base.reactions,
            },
            messageId,
            target: {
                eventIds,
                actionEventId: base.eventId,
                editEventId: action.eventId,
                blocked: members.some(message => message.pending || !message.eventId.startsWith("$")),
                missingAnchor: false,
                hasAttachments: true,
            },
            attachmentSources,
        });
    }
    const usedMessageIds = new Set<string>();
    for (const item of result) {
        if (usedMessageIds.has(item.messageId)) {
            item.messageId = messageSyntheticId(item.message.eventId, item.message.timestamp);
        }
        usedMessageIds.add(item.messageId);
    }
    return result;
}

function setProjectionIndexes(injected: InjectedRoom, projected: ProjectedTimelineMessage[]) {
    injected.messageIds.clear();
    injected.eventIds.clear();
    injected.messageTargets.clear();
    injected.projectedMessagesByEventId.clear();
    for (const item of projected) {
        for (const eventId of item.target.eventIds) {
            injected.messageIds.set(eventId, item.messageId);
            injected.projectedMessagesByEventId.set(eventId, item);
        }
        injected.eventIds.set(item.messageId, item.target.actionEventId);
        injected.messageTargets.set(item.messageId, item.target);
    }
}

function insertAnchoredLocalMessages(
    messages: MatrixMessageDto[],
    previousMessages: MatrixMessageDto[],
    completedRemoteEchoEventIds?: Set<string>
) {
    const merged = [...messages];
    const retainedIds = new Set(merged.map(message => message.eventId));
    const remoteEchoes = new Map<string, MatrixMessageDto | null>();
    for (const message of messages) {
        if (!message.eventId.startsWith("$")) continue;
        const identity = messageEchoIdentity(message);
        if (!identity) continue;
        remoteEchoes.set(identity, remoteEchoes.has(identity) ? null : message);
    }
    const localEchoes = new Map<string, MatrixMessageDto | null>();
    for (const message of previousMessages) {
        if (message.eventId.startsWith("$")) continue;
        const identity = messageEchoIdentity(message);
        if (!identity) continue;
        localEchoes.set(identity, localEchoes.has(identity) ? null : message);
    }
    let unanchoredPrefixLength = 0;
    for (let oldIndex = 0; oldIndex < previousMessages.length; oldIndex++) {
        const message = previousMessages[oldIndex];
        if (message.eventId.startsWith("$") || retainedIds.has(message.eventId)) continue;
        const identity = messageEchoIdentity(message);
        const remoteEcho = identity && localEchoes.get(identity) === message
            ? remoteEchoes.get(identity)
            : undefined;
        if (remoteEcho && remoteEcho.senderId === message.senderId) {
            const preserved = preserveLocalEchoMessageId(message.eventId, remoteEcho);
            rememberTransactionEvent(remoteEcho);
            const exactTransactionEcho = remoteEcho.transactionId != null
                && message.eventId === `~${message.roomId}:${remoteEcho.transactionId}`;
            const exactGroupedEcho = validAttachmentGroup(message) != null
                && validAttachmentGroup(remoteEcho) != null;
            if (preserved
                && message.eventId.startsWith(`~${message.roomId}:`)
                && (exactTransactionEcho || exactGroupedEcho)
                && remoteEcho.eventId.startsWith("$")
                && !remoteEcho.pending
                && !remoteEcho.failed) {
                completedRemoteEchoEventIds?.add(remoteEcho.eventId);
            }
            continue;
        }
        const nextAnchor = previousMessages.slice(oldIndex + 1).find(candidate => retainedIds.has(candidate.eventId));
        const previousAnchor = [...previousMessages.slice(0, oldIndex)].reverse()
            .find(candidate => retainedIds.has(candidate.eventId));
        if (nextAnchor) {
            const anchorIndex = merged.findIndex(candidate => candidate.eventId === nextAnchor.eventId);
            merged.splice(anchorIndex, 0, message);
        } else if (previousAnchor) {
            const anchorIndex = merged.findIndex(candidate => candidate.eventId === previousAnchor.eventId);
            merged.splice(anchorIndex + 1, 0, message);
        } else {
            // `messages` is an authoritative newest suffix/reset page. A stale
            // local echo with no shared neighbour belongs before that suffix,
            // not after its newest event. Preserve multiple locals' old order.
            merged.splice(unanchoredPrefixLength++, 0, message);
        }
        retainedIds.add(message.eventId);
    }
    return merged;
}

function mergeRoomHistory(
    roomId: string,
    messages: MatrixMessageDto[],
    options: {
        beforeCursor?: string;
        end?: boolean;
        placement?: "before" | "after" | "auto";
        timelineGeneration?: number;
        completedRemoteEchoEventIds?: Set<string>;
    } = {}
) {
    const current = roomHistoryById.get(roomId);
    const timelineGeneration = options.timelineGeneration ?? current?.timelineGeneration ?? 0;
    const generationChanged = current != null && current.timelineGeneration !== timelineGeneration;
    const preservedLocalMessages = generationChanged
        ? current.messages.filter(message => !message.eventId.startsWith("$"))
        : [];
    const incoming: MatrixMessageDto[] = [];
    const incomingById = new Map<string, MatrixMessageDto>();
    for (const message of messages) {
        if (!incomingById.has(message.eventId)) incoming.push(message);
        incomingById.set(message.eventId, message);
    }

    // Preserve Matrix's canonical timeline sequence and update overlapping DTOs
    // in place. Unknown contiguous segments are positioned by their nearest
    // known anchor; explicit history pages prepend and live deltas append.
    let merged = (generationChanged ? [] : current?.messages ?? [])
        .map(message => incomingById.get(message.eventId) ?? message);
    const retainedIds = new Set(merged.map(message => message.eventId));
    for (let index = 0; index < incoming.length;) {
        if (retainedIds.has(incoming[index].eventId)) {
            index++;
            continue;
        }
        let end = index + 1;
        while (end < incoming.length && !retainedIds.has(incoming[end].eventId)) end++;
        const segment = incoming.slice(index, end);
        const nextAnchor = end < incoming.length ? incoming[end].eventId : undefined;
        let previousAnchor: string | undefined;
        for (let previous = index - 1; previous >= 0; previous--) {
            if (retainedIds.has(incoming[previous].eventId)) {
                previousAnchor = incoming[previous].eventId;
                break;
            }
        }
        if (nextAnchor) {
            const anchorIndex = merged.findIndex(message => message.eventId === nextAnchor);
            merged.splice(Math.max(0, anchorIndex), 0, ...segment);
        } else if (previousAnchor) {
            const anchorIndex = merged.findIndex(message => message.eventId === previousAnchor);
            merged.splice(anchorIndex + 1, 0, ...segment);
        } else if (options.placement === "before") {
            merged.unshift(...segment);
        } else {
            merged.push(...segment);
        }
        for (const message of segment) retainedIds.add(message.eventId);
        index = end;
    }
    if (preservedLocalMessages.length) {
        merged = insertAnchoredLocalMessages(
            merged,
            current!.messages,
            options.completedRemoteEchoEventIds
        );
    }
    const capped = (!generationChanged && (current?.capped ?? false)) || merged.length > MAX_LOADED_ROOM_MESSAGES;
    if (merged.length > MAX_LOADED_ROOM_MESSAGES) merged = merged.slice(-MAX_LOADED_ROOM_MESSAGES);
    const state: RoomHistoryState = {
        messages: merged,
        timelineGeneration,
        beforeCursor: generationChanged
            ? options.beforeCursor
            : Object.prototype.hasOwnProperty.call(options, "beforeCursor")
            ? options.beforeCursor
            : current?.beforeCursor,
        end: capped || options.end === true || (!generationChanged && options.end == null && current?.end === true),
        capped,
    };
    roomHistoryById.set(roomId, state);
    return state;
}

function roomWithHistory(room: MatrixRoomDto, completedRemoteEchoEventIds?: Set<string>): MatrixRoomDto {
    const current = roomHistoryById.get(room.roomId);
    const timelineGeneration = room.timelineGeneration ?? 0;
    const generationChanged = current != null && current.timelineGeneration !== timelineGeneration;
    const state = mergeRoomHistory(room.roomId, roomMessages(room), {
        beforeCursor: generationChanged ? undefined : current?.beforeCursor,
        // A snapshot is a bounded view of a larger in-memory SDK timeline. Even
        // without a server token, one probe is required to drain omitted loaded
        // events before declaring the beginning of history.
        end: !generationChanged && current && !room.prevToken ? current.end : false,
        timelineGeneration,
        completedRemoteEchoEventIds,
    });
    return {
        ...room,
        messages: state.messages,
        timeline: undefined,
        prevToken: state.beforeCursor,
    };
}

function updateLatestSnapshotRoom(room: MatrixRoomDto) {
    if (!latestSnapshot) return;
    const rooms = latestSnapshot.rooms ?? [];
    const index = rooms.findIndex(candidate => candidate.roomId === room.roomId);
    const nextRooms = index === -1
        ? [...rooms, room]
        : rooms.map((candidate, candidateIndex) => candidateIndex === index ? room : candidate);
    latestSnapshot = { ...latestSnapshot, rooms: nextRooms };
}

function isJoinedRoom(room: MatrixRoomDto) {
    return room.membership === "join";
}

function isSpaceRoom(room: MatrixRoomDto) {
    return room.roomType === "m.space" || room.kind === "space";
}

interface MatrixSpaceGraph {
    roomsById: Map<string, MatrixRoomDto>;
    spacesById: Map<string, MatrixRoomDto>;
    childrenBySpaceId: Map<string, string[]>;
    parentsByRoomId: Map<string, Set<string>>;
    roots: MatrixRoomDto[];
}

function matrixSpaceGraph(joined: MatrixRoomDto[]): MatrixSpaceGraph {
    const roomsById = new Map(joined.map(room => [room.roomId, room]));
    const spaces = joined.filter(isSpaceRoom);
    const spacesById = new Map(spaces.map(space => [space.roomId, space]));
    const childrenBySpaceId = new Map(spaces.map(space => [space.roomId, [] as string[]]));
    const parentsByRoomId = new Map<string, Set<string>>();
    const addRelation = (parentSpaceId: string, childRoomId: string) => {
        if (!spacesById.has(parentSpaceId) || !roomsById.has(childRoomId)) return;
        const children = childrenBySpaceId.get(parentSpaceId)!;
        if (!children.includes(childRoomId)) children.push(childRoomId);
        let parents = parentsByRoomId.get(childRoomId);
        if (!parents) parentsByRoomId.set(childRoomId, parents = new Set());
        parents.add(parentSpaceId);
    };

    // Preserve the parent's declared child order first. `childIds` is retained
    // for older snapshots; `parentIds` then fills one-sided Matrix links.
    for (const space of spaces) {
        for (const child of space.spaceChildren ?? []) addRelation(space.roomId, child.roomId);
        for (const childId of space.childIds ?? []) addRelation(space.roomId, childId);
    }
    for (const room of [...joined].sort((left, right) => left.roomId.localeCompare(right.roomId))) {
        for (const parentId of room.parentIds ?? []) addRelation(parentId, room.roomId);
    }

    const roots = spaces.filter(space => !(parentsByRoomId.get(space.roomId)?.size));
    const reachable = new Set<string>();
    const markReachable = (rootId: string) => {
        const pending = [rootId];
        while (pending.length) {
            const spaceId = pending.shift()!;
            if (reachable.has(spaceId)) continue;
            reachable.add(spaceId);
            for (const childId of childrenBySpaceId.get(spaceId) ?? []) {
                if (spacesById.has(childId)) pending.push(childId);
            }
        }
    };
    for (const root of roots) markReachable(root.roomId);

    // A pure cycle has no parentless root. Pick deterministic fallback roots
    // only for otherwise-invisible components, then flatten their descendants.
    for (const space of [...spaces].sort((left, right) => left.roomId.localeCompare(right.roomId))) {
        if (reachable.has(space.roomId)) continue;
        roots.push(space);
        markReachable(space.roomId);
    }
    return { roomsById, spacesById, childrenBySpaceId, parentsByRoomId, roots };
}

function reachableSpaces(rootId: string, graph: MatrixSpaceGraph) {
    const result: MatrixRoomDto[] = [];
    const visited = new Set<string>();
    const pending = [rootId];
    while (pending.length) {
        const spaceId = pending.shift()!;
        if (visited.has(spaceId)) continue;
        visited.add(spaceId);
        const space = graph.spacesById.get(spaceId);
        if (!space) continue;
        result.push(space);
        for (const childId of graph.childrenBySpaceId.get(spaceId) ?? []) {
            if (graph.spacesById.has(childId)) pending.push(childId);
        }
    }
    return result;
}

function cleanDisplayText(value: string | undefined, fallback: string, maximum: number) {
    const clean = value
        ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum)
        .trim();
    return clean || fallback;
}

function guildChannelName(room: MatrixRoomDto) {
    const clean = cleanDisplayText(room.name, "matrix-room", 100)
        .toLocaleLowerCase()
        .replace(/\s+/gu, "-")
        .replace(/-{2,}/gu, "-");
    return clean || "matrix-room";
}

function rawGuildMember(user: ReturnType<typeof rawCurrentUser>, nick?: string) {
    return {
        user,
        nick: nick?.trim() || null,
        avatar: null,
        roles: [],
        joined_at: SYNTHETIC_JOINED_AT,
        premium_since: null,
        deaf: false,
        mute: false,
        pending: false,
        flags: 0,
        communication_disabled_until: null,
    };
}

function matrixGuildPermissions() {
    return [
        PermissionsBits.VIEW_CHANNEL,
        PermissionsBits.SEND_MESSAGES,
        PermissionsBits.READ_MESSAGE_HISTORY,
        PermissionsBits.ADD_REACTIONS,
        PermissionsBits.ATTACH_FILES,
        PermissionsBits.EMBED_LINKS,
        PermissionsBits.USE_EXTERNAL_EMOJIS,
        PermissionsBits.USE_EXTERNAL_STICKERS,
    ].reduce((permissions, permission) => permissions | (permission ?? 0n), 0n).toString();
}

function accountUserId(snapshot: MatrixSnapshotDto) {
    return snapshot.account?.userId ?? snapshot.userId;
}

function findMember(room: MatrixRoomDto, userId: string, fallbackName?: string): MatrixMemberDto {
    return room.members?.find(member => member.userId === userId) ?? {
        userId,
        displayName: fallbackName || userId,
        membership: "join",
    };
}

function discordAttachmentFilename(attachment: MatrixAttachmentDto) {
    const filename = attachment.fileName ?? attachment.name ?? "Matrix attachment";
    // Discord classifies message media from the filename rather than only
    // content_type. Matrix clients are allowed to send a generic body/name.
    const mimeType = attachment.mimeType?.toLowerCase();
    const extension = mimeType === "image/png" ? ".png"
        : mimeType === "image/jpeg" ? ".jpg"
            : mimeType === "image/webp" ? ".webp"
                : mimeType === "image/gif" ? ".gif"
                    : undefined;
    const hasExpectedExtension = mimeType === "image/jpeg"
        ? /\.jpe?g$/iu.test(filename)
        : extension ? filename.toLowerCase().endsWith(extension) : true;
    return extension && !hasExpectedExtension ? `${filename}${extension}` : filename;
}

function attachmentFallbackFilename(attachment: MatrixAttachmentDto) {
    return discordAttachmentFilename(attachment)
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/([\\`*_{}[\]()<>#+.!|~-])/gu, "\\$1")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 300) || "Matrix attachment";
}

function discordAttachmentFlags(attachment: MatrixAttachmentDto) {
    // Discord's current AttachmentFlags.IS_ANIMATED bit. Matrix media URLs do
    // not normally retain a .gif suffix, so URL-based detection cannot help.
    return attachment.flags ?? (attachment.animated || attachment.mimeType?.toLowerCase() === "image/gif" ? 32 : 0);
}

function attachmentMediaKey(message: MatrixMessageDto, attachment: MatrixAttachmentDto, index: number) {
    return [
        "attachment",
        message.roomId,
        message.eventId,
        index,
        attachment.name ?? attachment.fileName ?? "",
        attachment.mimeType ?? "",
        attachment.size ?? "",
        attachment.width ?? "",
        attachment.height ?? "",
        attachment.animated ? 1 : 0,
        attachment.encrypted ? 1 : 0,
        attachment.url ?? "",
    ].join("\0");
}

function previewUrlToken(body: string) {
    return body.match(/https?:\/\/[^\s<>"']+/iu)?.[0];
}

function projectSocialUrl(candidate: string) {
    try {
        const url = new URL(candidate);
        if (!PROJECTED_SOCIAL_HOSTS.has(url.hostname.toLowerCase())
            || (url.protocol !== "http:" && url.protocol !== "https:")
            || url.username || url.password) {
            return candidate;
        }

        const authorityStart = candidate.indexOf("://") + 3;
        const authorityTail = candidate.slice(authorityStart);
        const separator = authorityTail.search(/[/?#]/u);
        const authorityEnd = separator === -1 ? candidate.length : authorityStart + separator;
        const rawAuthority = candidate.slice(authorityStart, authorityEnd);
        // Comparing the raw authority also rejects credentials and explicit
        // non-default ports which URL parsing may otherwise normalize away.
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

function projectMatrixContent(body: string) {
    return body.replace(/https?:\/\/[^\s<>"']+/giu, candidate => projectSocialUrl(candidate));
}

function safePreviewEmbedUrl(candidate: string) {
    if (!candidate || candidate.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(candidate)) return undefined;
    try {
        const url = new URL(candidate);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
        return candidate;
    } catch {
        return undefined;
    }
}

function previewMediaKey(message: MatrixMessageDto) {
    const sourceUrl = previewUrlToken(message.body);
    return sourceUrl ? ["preview", message.roomId, message.eventId, sourceUrl].join("\0") : undefined;
}

function previewAssetKey(previewKey: string, kind: "image" | "video", media: MatrixUrlPreviewMediaDto) {
    return [
        previewKey,
        kind,
        media.downloadIndex,
        media.name ?? media.fileName ?? "",
        media.mimeType ?? "",
        media.size ?? "",
        media.width ?? "",
        media.height ?? "",
        media.animated ? 1 : 0,
    ].join("\0");
}

function rawEmbedMedia(media: MatrixAttachmentDto) {
    return {
        url: media.url,
        proxy_url: media.proxyUrl ?? media.url,
        width: media.width,
        height: media.height,
        content_type: media.mimeType,
        flags: discordAttachmentFlags(media),
    };
}

async function materializeMedia(
    attachment: MatrixAttachmentDto,
    result: MatrixMediaDownloadDto
): Promise<HydratedMedia> {
    const buffer = new ArrayBuffer(result.bytes.byteLength);
    new Uint8Array(buffer).set(result.bytes);
    const blob = new Blob([buffer], { type: result.mimeType });
    let width = result.width ?? attachment.width;
    let height = result.height ?? attachment.height;

    if ((!width || !height) && result.mimeType.startsWith("image/") && typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(blob);
            width ||= bitmap.width;
            height ||= bitmap.height;
            bitmap.close();
        } catch {
            // Discord can still render non-image attachments without dimensions.
        }
    }

    const objectUrl = URL.createObjectURL(blob);
    // Discord's image loader appends resize/format query parameters to every
    // non-CDN URL. A query changes a Blob URL's resource key and fails to load;
    // putting Discord's generated query after a fragment keeps the Blob URL
    // itself intact. Discord uses the same convention for local uploads.
    // A fragment does not change the Blob resource key, but Discord's
    // LazyImage animation detector still inspects it as a filename hint.
    // Mark sniffed GIF bytes so the stock GIF path, controls, and animation
    // state are used even though object URLs have no real extension.
    const renderUrl = `${objectUrl}${result.mimeType.toLowerCase() === "image/gif" ? "#.gif" : "#"}`;
    return {
        attachment: {
            ...attachment,
            name: result.name || attachment.name,
            fileName: result.name || attachment.fileName,
            url: renderUrl,
            proxyUrl: renderUrl,
            mimeType: result.mimeType,
            size: result.bytes.byteLength,
            width,
            height,
            animated: result.animated ?? attachment.animated,
        },
        objectUrl,
        byteLength: result.bytes.byteLength,
    };
}

function releaseMediaEntry(entry: MediaCacheEntry) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    hydratedMediaBytes = Math.max(0, hydratedMediaBytes - (entry.byteLength ?? 0));
    entry.objectUrl = undefined;
    entry.attachment = undefined;
    entry.byteLength = undefined;
}

function discardHydratedMedia(media: HydratedMedia) {
    URL.revokeObjectURL(media.objectUrl);
}

function makeRoomForHydratedMedia(byteLength: number, priority: number) {
    if (byteLength > MAX_HYDRATED_MEDIA_ITEM_BYTES) return false;
    let evicted = false;
    const olderEntries = [...mediaCache.values()]
        .filter(entry => entry.state === "ready" && entry.priority > priority)
        .sort((left, right) => right.priority - left.priority);

    while (hydratedMediaBytes + byteLength > MAX_HYDRATED_MEDIA_BYTES && olderEntries.length) {
        const entry = olderEntries.shift()!;
        releaseMediaEntry(entry);
        entry.state = "discarded";
        evicted = true;
    }
    if (evicted) scheduleMediaSnapshotRefresh();
    return hydratedMediaBytes + byteLength <= MAX_HYDRATED_MEDIA_BYTES;
}

function scheduleMediaSnapshotRefresh() {
    const generation = mediaGeneration;
    if (scheduledMediaRefreshGeneration === generation) return;
    scheduledMediaRefreshGeneration = generation;
    void Promise.resolve().then(() => {
        if (scheduledMediaRefreshGeneration !== generation) return;
        scheduledMediaRefreshGeneration = undefined;
        if (generation === mediaGeneration && activeMatrixChannelId) {
            const activeRoom = roomsByChannel.get(activeMatrixChannelId)?.room;
            if (activeRoom) {
                // URL previews are discovered in two phases: the first job
                // stores metadata, then that metadata defines the authenticated
                // image/video download jobs. Rebuilding only the Discord rows
                // here leaves those second-phase jobs undiscovered until an
                // unrelated room event happens.
                prepareRoomMedia(activeRoom);
                reinjectRoomTimelines(activeRoom.roomId);
            }
        }
    });
}

async function runMediaJob(job: MediaJob, entry: MediaCacheEntry) {
    let media: HydratedMedia | undefined;
    try {
        media = await job.load(preview => {
            if (job.generation !== mediaGeneration || !wantedMediaKeys.has(job.key) || mediaCache.get(job.key) !== entry) {
                return;
            }
            const url = safePreviewEmbedUrl(preview.url);
            if (!url) return;
            entry.preview = { ...preview, url };
            scheduleMediaSnapshotRefresh();
        });
    } catch (error) {
        if (job.generation === mediaGeneration && wantedMediaKeys.has(job.key) && mediaCache.get(job.key) === entry) {
            entry.state = "failed";
            logger.warn("Matrix media hydration failed", error);
        }
        return;
    }

    if (job.generation !== mediaGeneration || !wantedMediaKeys.has(job.key) || mediaCache.get(job.key) !== entry) {
        if (media) discardHydratedMedia(media);
        return;
    }
    if (!media) {
        entry.state = "unavailable";
        return;
    }
    if (!makeRoomForHydratedMedia(media.byteLength, entry.priority)) {
        discardHydratedMedia(media);
        entry.state = "discarded";
        return;
    }

    entry.state = "ready";
    entry.attachment = media.attachment;
    entry.objectUrl = media.objectUrl;
    entry.byteLength = media.byteLength;
    hydratedMediaBytes += media.byteLength;
    scheduleMediaSnapshotRefresh();
}

function pumpMediaQueue() {
    while (activeMediaJobs < MAX_ACTIVE_MEDIA_DOWNLOADS && mediaQueue.length) {
        const job = mediaQueue.shift()!;
        const entry = mediaCache.get(job.key);
        if (job.generation !== mediaGeneration || !wantedMediaKeys.has(job.key) || entry?.state !== "queued") continue;
        entry.state = "loading";
        activeMediaJobs++;
        void runMediaJob(job, entry).finally(() => {
            activeMediaJobs--;
            pumpMediaQueue();
        });
    }
}

function mediaCandidates(room: MatrixRoomDto): MediaCandidate[] {
    const candidates: MediaCandidate[] = [];
    const chronological = roomMessages(room);
    const messagesById = new Map(chronological.map(message => [message.eventId, message]));
    const focusedMessages = (mediaFocusEventIdsByRoom.get(room.roomId) ?? [])
        .map(eventId => messagesById.get(eventId))
        .filter((message): message is MatrixMessageDto => Boolean(message));
    const focusedIds = new Set(focusedMessages.map(message => message.eventId));
    const messages = [
        ...focusedMessages,
        ...chronological.reverse().filter(message => !focusedIds.has(message.eventId)),
    ];
    const addCandidate = (key: string, load: MediaCandidate["load"]) => {
        if (candidates.length >= MAX_HYDRATED_MEDIA) return false;
        candidates.push({ key, priority: candidates.length, load });
        return true;
    };

    for (const message of messages) {
        const attachment = message.attachments?.[0];
        if (attachment?.downloadable) {
            const key = attachmentMediaKey(message, attachment, 0);
            addCandidate(key, async () => materializeMedia(
                attachment,
                await Native.downloadMedia(message.roomId, message.eventId, 0) as MatrixMediaDownloadDto
            ));
        } else if (!message.attachments?.length) {
            const key = previewMediaKey(message);
            if (key) {
                addCandidate(key, async onPreview => {
                    const preview = await Native.urlPreview(message.roomId, message.eventId) as MatrixUrlPreviewDto | undefined;
                    if (preview) onPreview(preview);
                    return undefined;
                });

                const preview = mediaCache.get(key)?.preview;
                const image = preview?.image?.downloadable && preview.image.downloadIndex === 0
                    ? preview.image
                    : undefined;
                const video = image && preview?.video?.downloadable && preview.video.downloadIndex === 1
                    ? preview.video
                    : undefined;

                if (image) {
                    const imageKey = previewAssetKey(key, "image", image);
                    addCandidate(imageKey, async () => {
                        const media = await materializeMedia(
                            image,
                            await Native.downloadMedia(message.roomId, message.eventId, image.downloadIndex) as MatrixMediaDownloadDto
                        );
                        const hydrated = media.attachment;
                        if (!hydrated.mimeType?.startsWith("image/") || !hydrated.width || !hydrated.height) {
                            discardHydratedMedia(media);
                            return undefined;
                        }
                        return media;
                    });
                }

                if (video) {
                    const videoKey = previewAssetKey(key, "video", video);
                    addCandidate(videoKey, async () => {
                        const media = await materializeMedia(
                            video,
                            await Native.downloadMedia(message.roomId, message.eventId, video.downloadIndex) as MatrixMediaDownloadDto
                        );
                        const hydrated = media.attachment;
                        if (hydrated.mimeType?.toLowerCase() !== "video/mp4" || !hydrated.width || !hydrated.height) {
                            discardHydratedMedia(media);
                            return undefined;
                        }
                        return media;
                    });
                }
            }
        }
        if (candidates.length >= MAX_HYDRATED_MEDIA) break;
    }
    return candidates;
}

function focusRoomMedia(roomId: string, eventIds: string[]) {
    mediaFocusEventIdsByRoom.set(roomId, [...new Set(eventIds)].slice(0, 100));
    const active = activeMatrixChannelId ? roomsByChannel.get(activeMatrixChannelId) : undefined;
    if (active?.room.roomId === roomId) prepareRoomMedia(active.room);
}

function prepareRoomMedia(room: MatrixRoomDto | undefined) {
    const candidates = room ? mediaCandidates(room) : [];
    wantedMediaKeys = new Set(candidates.map(candidate => candidate.key));
    mediaQueue = mediaQueue.filter(job => wantedMediaKeys.has(job.key));

    for (const [key, entry] of mediaCache) {
        if (wantedMediaKeys.has(key)) continue;
        releaseMediaEntry(entry);
        mediaCache.delete(key);
    }

    for (const candidate of candidates) {
        const current = mediaCache.get(candidate.key);
        if (current) {
            current.priority = candidate.priority;
            continue;
        }
        mediaCache.set(candidate.key, { state: "queued", priority: candidate.priority });
        mediaQueue.push({ key: candidate.key, generation: mediaGeneration, load: candidate.load });
    }
    pumpMediaQueue();
}

function clearMediaHydration() {
    mediaGeneration++;
    wantedMediaKeys.clear();
    mediaQueue = [];
    scheduledMediaRefreshGeneration = undefined;
    for (const entry of mediaCache.values()) releaseMediaEntry(entry);
    mediaCache.clear();
    hydratedMediaBytes = 0;
}

function resolvedAttachment(message: MatrixMessageDto, attachment: MatrixAttachmentDto, index: number) {
    const entry = mediaCache.get(attachmentMediaKey(message, attachment, index));
    return entry?.state === "ready" && entry.attachment ? entry.attachment : attachment;
}

function rawPreviewEmbeds(message: MatrixMessageDto) {
    const key = previewMediaKey(message);
    const entry = key ? mediaCache.get(key) : undefined;
    const preview = entry?.preview;
    const sourceUrl = preview ? safePreviewEmbedUrl(preview.url) : undefined;
    const imageEntry = key && preview?.image
        ? mediaCache.get(previewAssetKey(key, "image", preview.image))
        : undefined;
    const videoEntry = key && preview?.video
        ? mediaCache.get(previewAssetKey(key, "video", preview.video))
        : undefined;
    const image = imageEntry?.state === "ready" ? imageEntry.attachment : undefined;
    const video = videoEntry?.state === "ready" ? videoEntry.attachment : undefined;
    const displayImage = image?.url && image.width && image.height && image.mimeType?.startsWith("image/")
        ? image
        : undefined;
    const displayVideo = displayImage && video?.url && video.width && video.height && video.mimeType?.toLowerCase() === "video/mp4"
        ? video
        : undefined;
    if (!sourceUrl || (!preview?.title && !preview?.description && !preview?.provider?.name && !displayImage)) return [];

    // A GIF preview should never flash link-card chrome while its bytes are
    // hydrating. Once the worker has sniffed the media, project only Discord's
    // bare image unfurl. Video previews deliberately keep their native card.
    const bareGif = !preview?.video
        && preview?.image?.mimeType?.toLowerCase() === "image/gif";
    if (bareGif && !displayImage) return [];
    if (bareGif && displayImage?.mimeType?.toLowerCase() === "image/gif" && displayImage.animated === true) {
        return [{
            type: "image",
            url: sourceUrl,
            image: rawEmbedMedia(displayImage),
        }];
    }

    const embed: any = {
        type: preview?.title || preview?.description || preview?.provider?.name || displayVideo ? "link" : "image",
        url: sourceUrl,
    };
    if (preview?.title) embed.title = preview.title;
    if (preview?.description) embed.description = preview.description;
    if (preview?.provider?.name) embed.provider = { name: preview.provider.name };
    if (displayImage && displayVideo) {
        // Discord's native video renderer requires both an explicit thumbnail
        // and an embed URL. Supplying a local proxy URL makes it use the native
        // HTML5 player instead of opening a provider iframe.
        embed.thumbnail = rawEmbedMedia(displayImage);
        embed.video = rawEmbedMedia(displayVideo);
    } else if (displayImage) {
        embed.image = rawEmbedMedia(displayImage);
    }
    return [embed];
}

const STICKER_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const STICKER_LAYOUT_MAX = 160;
const STICKER_BODY_FALLBACK_MAX = 512;

function rawStickerImage(image: MatrixAttachmentDto) {
    const sourceWidth = image.width!;
    const sourceHeight = image.height!;
    const scale = Math.min(1, STICKER_LAYOUT_MAX / Math.max(sourceWidth, sourceHeight));
    return {
        ...rawEmbedMedia(image),
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
    };
}

function stickerBodyFallback(body: string) {
    return projectMatrixContent(body)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
        .trim()
        .slice(0, STICKER_BODY_FALLBACK_MAX)
        .trim();
}

function rawStickerEmbeds(message: MatrixMessageDto) {
    if (!message.sticker) return [];
    const source = message.attachments?.[0];
    if (!source) return [];
    const entry = mediaCache.get(attachmentMediaKey(message, source, 0));
    const image = entry?.state === "ready" ? entry.attachment : undefined;
    const mimeType = image?.mimeType?.toLowerCase();
    if (!image?.url || !image.width || !image.height || !mimeType || !STICKER_IMAGE_TYPES.has(mimeType)) return [];
    return [{
        type: "image",
        image: rawStickerImage(image),
    }];
}

function rawMessage(projected: ProjectedTimelineMessage, injected: InjectedRoom, includeReferencedMessage = true): any {
    const { message, messageId } = projected;
    const self = message.senderId === injected.selfMatrixId;
    const author = self
        ? rawCurrentUser()
        : rawMatrixUser(findMember(injected.room, message.senderId, message.senderName));
    let replyMessageId = message.replyToEventId
        ? injected.messageIds.get(message.replyToEventId)
        : undefined;
    if (!replyMessageId && message.replyToEventId) {
        replyMessageId = messageSyntheticId(message.replyToEventId, message.timestamp - 1, true);
        rememberReservedReplyTarget(
            injected.channelId,
            replyMessageId,
            injected.room.roomId,
            message.replyToEventId
        );
    }

    const referencedMessage = includeReferencedMessage && message.replyToEventId
        ? injected.projectedMessagesByEventId.get(message.replyToEventId)
        : undefined;
    const embeds = message.sticker ? rawStickerEmbeds(message) : rawPreviewEmbeds(message);
    const resolvedAttachments = (message.sticker ? [] : projected.attachmentSources)
        .map(source => ({
            ...source,
            resolved: resolvedAttachment(source.message, source.attachment, source.index),
        }));
    const hasRenderableAttachment = resolvedAttachments.some(({ resolved }) =>
        resolved.url && /^(?:https?:|blob:|data:)/.test(resolved.url));
    const actionAttachments = projected.attachmentSources
        .filter(source => source.message.eventId === projected.target.editEventId)
        .map(source => source.attachment);
    const filenameOnlyBody = !message.sticker
        && actionAttachments.some(attachment =>
            message.body === (attachment.fileName ?? attachment.name));
    const projectedBody = projectMatrixContent(message.body ?? "");
    const visibleBody = filenameOnlyBody ? "" : projectedBody;
    const attachmentFallback = (message.attachments ?? [])
        .slice(0, 10)
        .map(attachmentFallbackFilename)
        .join("\n")
        .slice(0, 2_000);
    const content = message.sticker
        ? embeds.length ? "" : stickerBodyFallback(message.body ?? "")
        : hasRenderableAttachment
            ? visibleBody
            : attachmentFallback
                ? visibleBody && visibleBody !== attachmentFallback
                    ? `${visibleBody}\n${attachmentFallback}`.slice(0, 4_000)
                    : visibleBody || attachmentFallback
                : visibleBody;

    return {
        id: messageId,
        channel_id: injected.channelId,
        guild_id: injected.guildId,
        author,
        // A Discord guild message renders member.nick ahead of the author
        // profile. Matrix's display name is useful for remote users, but using
        // it for self would hide the current Discord profile in Space chats.
        member: injected.guildId ? rawGuildMember(author, self ? undefined : message.senderName) : undefined,
        content,
        timestamp: messageTimestampIso(message.timestamp),
        edited_timestamp: message.edited
            ? messageTimestampIso(message.editedAt ?? message.timestamp, message.timestamp)
            : null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: resolvedAttachments
            .filter(({ resolved }) => resolved.url && /^(?:https?:|blob:|data:)/.test(resolved.url))
            .map(({ message: sourceMessage, index, resolved }) => ({
                id: resolved.id ?? stableSyntheticId(
                    "attachment",
                    `${sourceMessage.eventId}:${index}:${resolved.name ?? "file"}`
                ),
                filename: discordAttachmentFilename(resolved),
                url: resolved.url,
                proxy_url: resolved.proxyUrl ?? resolved.url,
                content_type: resolved.mimeType,
                size: resolved.size ?? 0,
                width: resolved.width,
                height: resolved.height,
                flags: discordAttachmentFlags(resolved),
            })),
        embeds,
        reactions: (message.reactions ?? []).map(reaction => ({
            emoji: { id: null, name: reaction.key },
            count: reaction.count ?? reaction.senders?.length ?? 1,
            count_details: { burst: 0, normal: reaction.count ?? reaction.senders?.length ?? 1 },
            me: (reaction as any).me ?? reaction.reactedByMe ?? reaction.senders?.includes(injected.selfMatrixId ?? "") ?? false,
            me_burst: false,
            burst_me: false,
            burst_colors: [],
        })),
        nonce: message.transactionId ?? null,
        pinned: false,
        // Discord only renders message_reference/referenced_message through its
        // native reply row when the outer message uses MessageType.REPLY. The
        // nested message_reference.type below is a different enum.
        type: message.replyToEventId ? MessageType.REPLY : MessageType.DEFAULT,
        flags: 0,
        components: [],
        state: message.failed ? "SEND_FAILED" : message.pending ? "SENDING" : "SENT",
        message_reference: replyMessageId ? {
            channel_id: injected.channelId,
            guild_id: injected.guildId,
            message_id: replyMessageId,
            type: MessageReferenceType.DEFAULT,
        } : null,
        // Discord interprets an explicit null as DELETED and disables the
        // native lazy-fetch/jump path. Omitting the field leaves the reference
        // NOT_LOADED, so clicking an older Matrix reply reaches our bounded
        // context loader and is upgraded to LOADED when the target arrives.
        ...(referencedMessage ? {
            referenced_message: rawMessage(referencedMessage, injected, false),
        } : {}),
    };
}

function toRawMessage(message: ProjectedTimelineMessage, injected: InjectedRoom) {
    // LOAD_MESSAGES_SUCCESS performs Discord's raw-message conversion itself.
    // Pre-converting here makes the store parse the record a second time, which
    // drops parsed embed fields such as rawTitle, proxyURL, and contentType.
    return rawMessage(message, injected);
}

/**
 * LOAD_MESSAGES_SUCCESS intentionally preserves Discord's optimistic rows.
 * Complete only exact Matrix echoes collected while replacing a local event;
 * arbitrary SENT rows from a snapshot must never be treated as local sends.
 */
function completeProjectedEchoRows(completedEchoesByRoom: ReadonlyMap<string, ReadonlySet<string>>) {
    const completedRows = new Set<string>();
    for (const [roomId, remoteEventIds] of completedEchoesByRoom) {
        if (!remoteEventIds.size) continue;
        for (const injected of [...roomsByChannel.values()].filter(candidate => candidate.room.roomId === roomId)) {
            for (const remoteEventId of remoteEventIds) {
                const projected = injected.projectedMessagesByEventId.get(remoteEventId);
                if (!projected
                    || projected.message.pending
                    || projected.message.failed
                    || projected.target.eventIds.some(eventId => !eventId.startsWith("$"))) continue;
                const rowKey = `${injected.channelId}\0${projected.messageId}`;
                if (completedRows.has(rowKey)) continue;
                const existing: any = MessageStore.getMessage(injected.channelId, projected.messageId);
                if (existing?.state !== "SENDING" && existing?.state !== "SEND_FAILED") continue;
                completedRows.add(rowKey);
                FluxDispatcher.dispatch({
                    type: "MESSAGE_CREATE",
                    channelId: injected.channelId,
                    message: toRawMessage(projected, injected),
                    optimistic: false,
                });
            }
        }
    }
}

function purgeInvalidOptimisticProjectionRows(projections: Iterable<InjectedRoom>) {
    const removedRows = new Set<string>();
    for (const injected of projections) {
        for (const messageId of injected.eventIds.keys()) {
            const rowKey = `${injected.channelId}\0${messageId}`;
            if (removedRows.has(rowKey)) continue;
            const existing: any = MessageStore.getMessage(injected.channelId, messageId);
            if (existing?.state !== "SENDING" && existing?.state !== "SEND_FAILED") continue;
            removedRows.add(rowKey);
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId: injected.channelId,
                id: messageId,
            });
        }
    }
}

function safeUnreadCount(value: number | undefined) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, 1_000_000)
        : 0;
}

function syncProjectionUnread(channelId: string, room: MatrixRoomDto) {
    const messages = roomMessages(room);
    const latest = projectedTimelineMessages(messages).at(-1);
    const next = {
        unreadCount: safeUnreadCount(room.unreadCount),
        highlightCount: safeUnreadCount(room.highlightCount),
        lastMessageId: latest?.messageId ?? null,
    };
    const previous = matrixUnreadByChannel.get(channelId);
    if (previous?.unreadCount === next.unreadCount
        && previous.highlightCount === next.highlightCount
        && previous.lastMessageId === next.lastMessageId) return;
    matrixUnreadByChannel.set(channelId, next);
    matrixUnreadRevision++;
    (ReadStateStore as any).emitChange?.();
}

function removeInjectedChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (channel) {
        FluxDispatcher.dispatch({ type: "CHANNEL_DELETE", channel });
    }
    injectedChannelIds.delete(channelId);
    spaceCreateContextsByCategoryId.delete(channelId);
    roomsByChannel.delete(channelId);
    for (const key of reservedReplyTargets.keys()) {
        if (key.startsWith(`${channelId}\0`)) reservedReplyTargets.delete(key);
    }
    if (matrixUnreadByChannel.delete(channelId)) {
        matrixUnreadRevision++;
        (ReadStateStore as any).emitChange?.();
    }
}

function removeInjectedGuild(guildId: string) {
    if (injectedGuildIds.has(guildId)) {
        FluxDispatcher.dispatch({
            type: "GUILD_DELETE",
            guild: { id: guildId, unavailable: false },
        });
    }
    injectedGuildIds.delete(guildId);
    spaceIdsByGuildId.delete(guildId);
    projectedRoomIdsByGuildId.delete(guildId);
    for (const [spaceId, guildIds] of guildIdsBySpaceId) {
        guildIds.delete(guildId);
        if (!guildIds.size) guildIdsBySpaceId.delete(spaceId);
    }
    guildProjectionSignatures.delete(guildId);
}

function privateChannel(room: MatrixRoomDto, snapshot: MatrixSnapshotDto, channelId: string) {
    const selfMatrixId = accountUserId(snapshot);
    const messages = roomMessages(room);
    const latest = projectedTimelineMessages(messages).at(-1);
    const directMember = room.directUserId && room.directUserId !== selfMatrixId
        ? findMember(room, room.directUserId)
        : undefined;
    const recipients = directMember
        ? [rawMatrixUser(directMember)]
        : (room.members ?? [])
            .filter(member => member.membership !== "leave" && member.userId !== selfMatrixId)
            .map(rawMatrixUser);

    if (!recipients.length) {
        recipients.push(rawMatrixUser({
            userId: "@matrix:local",
            displayName: "Matrix",
            membership: "join",
        }));
    }

    return createChannelRecordFromServer({
        id: channelId,
        type: directMember ? ChannelType.DM : ChannelType.GROUP_DM,
        name: directMember ? undefined : cleanDisplayText(room.name, "Matrix group", 100),
        icon: directMember ? undefined : null,
        owner_id: directMember ? undefined : rawCurrentUser().id,
        recipients,
        last_message_id: latest?.messageId ?? null,
        last_pin_timestamp: null,
        flags: 0,
        is_spam: false,
    });
}

function guildChannel(
    room: MatrixRoomDto,
    guildId: string,
    channelId: string,
    position: number,
    parentId?: string
) {
    const messages = roomMessages(room);
    const latest = projectedTimelineMessages(messages).at(-1);
    return createChannelRecordFromServer({
        id: channelId,
        guild_id: guildId,
        type: ChannelType.GUILD_TEXT,
        name: guildChannelName(room),
        topic: room.topic?.slice(0, 1_024) ?? null,
        position,
        parent_id: parentId ?? null,
        permission_overwrites: [],
        rate_limit_per_user: 0,
        nsfw: false,
        last_message_id: latest?.messageId ?? null,
        flags: 0,
    });
}

function guildCategory(space: MatrixRoomDto, guildId: string, channelId: string, position: number) {
    return createChannelRecordFromServer({
        id: channelId,
        guild_id: guildId,
        type: ChannelType.GUILD_CATEGORY,
        name: cleanDisplayText(space.name, "Matrix category", 100),
        position,
        permission_overwrites: [],
        flags: 0,
    });
}

function projectedGuildMemberRecords(space: MatrixRoomDto, rooms: MatrixRoomDto[]) {
    const members = new Map<string, MatrixMemberDto>();
    roomLoop: for (const room of [space, ...rooms]) {
        const roomMembers = [...(room.members ?? [])].sort((left, right) => left.userId.localeCompare(right.userId));
        for (const member of roomMembers) {
            if (member.membership !== "join") continue;
            const previous = members.get(member.userId);
            if (!previous && members.size >= MAX_PROJECTED_GUILD_MEMBERS - 1) break roomLoop;
            if (!previous?.displayName || member.displayName) members.set(member.userId, member);
        }
    }
    return [...members.values()];
}

interface ProjectedGuildOwner {
    member?: MatrixMemberDto;
    user: ReturnType<typeof rawCurrentUser>;
}

function fallbackGuildOwner(space: MatrixRoomDto): ProjectedGuildOwner {
    // An incomplete member snapshot must still give Discord a resolvable owner
    // member, but must not falsely grant the local Discord account owner UI.
    const id = protectSyntheticId(stableSyntheticId("space-owner", space.roomId));
    return {
        user: {
            id,
            username: "matrix_owner",
            global_name: "Matrix",
            display_name: "Matrix",
            discriminator: "0",
            avatar: null,
            bot: false,
            system: false,
            public_flags: 0,
            flags: 0,
        },
    };
}

function projectedGuildOwner(space: MatrixRoomDto, snapshot: MatrixSnapshotDto): ProjectedGuildOwner {
    const selfMatrixId = accountUserId(snapshot);
    const joined = (space.members ?? []).filter(member => member.membership === "join");
    if (!joined.length) return fallbackGuildOwner(space);

    const highestPowerLevel = Math.max(...joined.map(member => member.powerLevel ?? 0));
    const highest = joined
        .filter(member => (member.powerLevel ?? 0) === highestPowerLevel)
        .sort((left, right) => left.userId.localeCompare(right.userId));
    // Tied administrators are equally authoritative in Matrix. Prefer self so
    // the local projection uses the real Discord profile when that is valid.
    const member = highest.find(candidate => candidate.userId === selfMatrixId) ?? highest[0];
    return {
        member,
        user: member.userId === selfMatrixId ? rawCurrentUser() : rawMatrixUser(member),
    };
}

function rememberSpaceMember(userId: string, spaceId: string) {
    let spaces = spaceIdsBySyntheticUserId.get(userId);
    if (!spaces) spaceIdsBySyntheticUserId.set(userId, spaces = new Set());
    spaces.add(spaceId);
}

function guildMembers(
    space: MatrixRoomDto,
    rooms: MatrixRoomDto[],
    snapshot: MatrixSnapshotDto,
    owner: ProjectedGuildOwner
) {
    const selfMatrixId = accountUserId(snapshot);
    const joinedSpaceMemberIds = new Set(
        (space.members ?? [])
            .filter(member => member.membership === "join")
            .map(member => member.userId)
    );

    const result = [rawGuildMember(rawCurrentUser())];
    const includedMatrixUserIds = new Set(selfMatrixId ? [selfMatrixId] : []);
    if (owner.member && owner.member.userId !== selfMatrixId) {
        result.push(rawGuildMember(owner.user, owner.member.displayName));
        includedMatrixUserIds.add(owner.member.userId);
        rememberSpaceMember(owner.user.id, space.roomId);
    } else if (!owner.member && owner.user.id !== result[0].user.id) {
        result.push(rawGuildMember(owner.user));
    }

    for (const member of projectedGuildMemberRecords(space, rooms)) {
        if (includedMatrixUserIds.has(member.userId) || result.length >= MAX_PROJECTED_GUILD_MEMBERS) continue;
        const user = rawMatrixUser(member);
        if (joinedSpaceMemberIds.has(member.userId)) {
            rememberSpaceMember(user.id, space.roomId);
        }
        result.push(rawGuildMember(user, member.displayName));
        includedMatrixUserIds.add(member.userId);
    }
    return result;
}

function rawGuild(
    space: MatrixRoomDto,
    rooms: MatrixRoomDto[],
    channels: any[],
    snapshot: MatrixSnapshotDto,
    guildId: string
) {
    const owner = projectedGuildOwner(space, snapshot);
    const members = guildMembers(space, rooms, snapshot, owner);
    return {
        id: guildId,
        properties: {
            id: guildId,
            name: cleanDisplayText(space.name, "Matrix space", 100),
            description: space.topic?.slice(0, 1_024) ?? null,
            icon: null,
            splash: null,
            banner: null,
            features: [],
            preferred_locale: "en-US",
            owner_id: owner.user.id,
            afk_channel_id: null,
            afk_timeout: 300,
            system_channel_id: null,
            verification_level: 0,
            explicit_content_filter: 0,
            default_message_notifications: 0,
            mfa_level: 0,
            vanity_url_code: null,
            premium_tier: 0,
            premium_progress_bar_enabled: false,
            system_channel_flags: 0,
            discovery_splash: null,
            rules_channel_id: null,
            public_updates_channel_id: null,
            max_members: 1_000_000,
            max_video_channel_users: 0,
            max_stage_video_channel_users: 0,
            nsfw_level: 0,
        },
        joined_at: SYNTHETIC_JOINED_AT,
        premium_subscription_count: 0,
        large: false,
        unavailable: false,
        member_count: members.length,
        channels: { op: "full_sync", items: channels },
        roles: {
            op: "full_sync",
            items: [{
                id: guildId,
                name: "@everyone",
                permissions: matrixGuildPermissions(),
                position: 0,
                color: 0,
                hoist: false,
                managed: false,
                mentionable: false,
                flags: 0,
            }],
        },
        emojis: { op: "full_sync", items: [] },
        stickers: { op: "full_sync", items: [] },
        members,
        presences: [],
        voice_states: [],
        threads: [],
        stage_instances: [],
        guild_scheduled_events: [],
    };
}

function guildProjectionSignature(space: MatrixRoomDto, rooms: MatrixRoomDto[], channels: any[]) {
    return JSON.stringify({
        name: space.name,
        topic: space.topic,
        // Force a full virtual-guild member refresh after a Discord account
        // switch even when Matrix membership itself did not change.
        currentDiscordUserId: UserStore.getCurrentUser()?.id,
        rooms: rooms.map(room => [room.roomId, room.name, room.topic]),
        channels: channels.map(channel => [
            channel.id,
            channel.type,
            channel.name,
            channel.parent_id ?? null,
            channel.position,
        ]),
        members: projectedGuildMemberRecords(space, rooms).map(member => [
            member.userId,
            member.displayName,
            member.membership,
            member.powerLevel,
        ]),
        spacePowerLevels: (space.members ?? []).map(member => [
            member.userId,
            member.membership,
            member.powerLevel,
        ]),
    });
}

function injectRoomTimeline(
    room: MatrixRoomDto,
    snapshot: MatrixSnapshotDto,
    channelId: string,
    previous: InjectedRoom | undefined,
    guildId?: string,
    parentId?: string,
    parentSpaceId?: string,
    channelPosition?: number
) {
    const messages = roomMessages(room);
    const projectedMessages = projectedTimelineMessages(messages, previous);

    const injected: InjectedRoom = {
        room,
        channelId,
        guildId,
        parentId: parentId ?? previous?.parentId,
        parentSpaceId: parentSpaceId ?? previous?.parentSpaceId,
        channelPosition: channelPosition ?? previous?.channelPosition,
        selfMatrixId: accountUserId(snapshot),
        messageIds: new Map(),
        eventIds: new Map(),
        messageTargets: new Map(),
        projectedMessagesByEventId: new Map(),
        isolatedContext: previous?.isolatedContext,
        contextTargetMessageId: previous?.contextTargetMessageId,
    };
    setProjectionIndexes(injected, projectedMessages);

    const nextMessageIds = new Set(injected.eventIds.keys());
    for (const oldMessageId of previous?.eventIds.keys() ?? []) {
        if (!nextMessageIds.has(oldMessageId)) {
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId,
                id: oldMessageId,
            });
        }
    }

    roomsByChannel.set(channelId, injected);
    injectedChannelIds.add(channelId);

    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId,
        // Discord's gateway/API payload is newest-first; its store reverses
        // this list into display order. Matrix timelines are oldest-first.
        messages: [...projectedMessages].reverse().map(message => toRawMessage(message, injected)),
        isBefore: false,
        isAfter: false,
        jump: injected.isolatedContext ? injected.contextTargetMessageId ?? null : null,
        hasMoreBefore: injected.isolatedContext ? false : !roomHistoryById.get(room.roomId)?.end,
        hasMoreAfter: false,
        isStale: false,
        truncate: false,
        avoidInitialScroll: Boolean(injected.isolatedContext),
    });
}

function reinjectRoomTimelines(roomId: string) {
    if (!latestSnapshot) return;
    const projections = [...roomsByChannel.values()].filter(injected => injected.room.roomId === roomId);
    for (const injected of projections) {
        injectRoomTimeline(
            injected.room,
            latestSnapshot,
            injected.channelId,
            injected,
            injected.guildId
        );
    }
}

function clearIsolatedSearchContext(roomId: string) {
    if (!latestSnapshot) return;
    const room = snapshotRoom(roomId);
    const history = roomHistoryById.get(roomId);
    if (!room || !history) return;
    const timelineRoom = projectedRoom(room, history.messages);
    for (const projection of [...roomsByChannel.values()].filter(candidate =>
        candidate.room.roomId === roomId && candidate.isolatedContext)) {
        injectRoomTimeline(timelineRoom, latestSnapshot, projection.channelId, {
            ...projection,
            isolatedContext: undefined,
            contextTargetMessageId: undefined,
        }, projection.guildId);
    }
    mediaFocusEventIdsByRoom.delete(roomId);
}

export function applySnapshot(
    snapshot: MatrixSnapshotDto,
    timelineRoomIds?: ReadonlySet<string>,
    resetRemoteHistory = false,
    preserveLocalEchoes = true
) {
    if (!bridgeActive) return;
    const completedEchoesByRoom = new Map<string, Set<string>>();
    const completedEchoesForRoom = (roomId: string) => {
        let completed = completedEchoesByRoom.get(roomId);
        if (!completed) completedEchoesByRoom.set(roomId, completed = new Set());
        return completed;
    };
    const collectCompletedEchoes = !resetRemoteHistory || preserveLocalEchoes;
    if (accountUserId(snapshot)) {
        clearedLoggedOutRoute = false;
    } else if (snapshot.status?.state === "logged_out" && !clearedLoggedOutRoute) {
        clearedLoggedOutRoute = true;
        void clearMatrixRoutePreference().catch(error => logger.warn("Matrix route cleanup failed", error));
    }
    const previousAccountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    const nextAccountId = accountUserId(snapshot);
    if (previousAccountId && nextAccountId && previousAccountId !== nextAccountId) {
        roomHistoryById.clear();
        mediaFocusEventIdsByRoom.clear();
        messageIdsByEventId.clear();
        reservedReplyEventIds.clear();
        reservedReplyTargets.clear();
        eventIdsByTransaction.clear();
        matrixUserIdsBySyntheticId.clear();
    }
    if (resetRemoteHistory) {
        const previousHistories = new Map(roomHistoryById);
        roomHistoryById.clear();
        mediaFocusEventIdsByRoom.clear();
        for (const room of (snapshot.rooms ?? []).filter(isJoinedRoom)) {
            const timelineGeneration = room.timelineGeneration ?? 0;
            mergeRoomHistory(room.roomId, roomMessages(room), {
                beforeCursor: undefined,
                end: false,
                placement: "after",
                timelineGeneration,
            });
            const previousHistory = previousHistories.get(room.roomId);
            const resetHistory = roomHistoryById.get(room.roomId);
            if (preserveLocalEchoes && previousHistory && resetHistory) {
                resetHistory.messages = insertAnchoredLocalMessages(
                    resetHistory.messages,
                    previousHistory.messages,
                    completedEchoesForRoom(room.roomId)
                )
                    .slice(-MAX_LOADED_ROOM_MESSAGES);
            }
        }
    }
    latestSnapshot = snapshot;
    spaceIdsBySyntheticUserId.clear();

    const previousRooms = new Map(roomsByChannel);
    if (resetRemoteHistory && !preserveLocalEchoes) {
        // A fresh worker cannot restore chronological SDK local echoes. Remove
        // Discord's optimistic rows before the authoritative LOAD so a stable
        // ID retained by an already-confirmed group member cannot cause the
        // stale SENDING record to win the merge again.
        purgeInvalidOptimisticProjectionRows(previousRooms.values());
    }
    const joined = (snapshot.rooms ?? []).filter(isJoinedRoom).map(room => roomWithHistory(
        room,
        collectCompletedEchoes ? completedEchoesForRoom(room.roomId) : undefined
    ));
    const joinedRoomIds = new Set(joined.map(room => room.roomId));
    for (const roomId of roomHistoryById.keys()) {
        if (!joinedRoomIds.has(roomId)) {
            roomHistoryById.delete(roomId);
            mediaFocusEventIdsByRoom.delete(roomId);
            const pendingReceipt = pendingReceiptsByRoom.get(roomId);
            if (pendingReceipt) clearTimeout(pendingReceipt.timer);
            pendingReceiptsByRoom.delete(roomId);
            lastReceiptEventByRoom.delete(roomId);
            paginationRequestsByRoom.delete(roomId);
        }
    }
    const spaceGraph = matrixSpaceGraph(joined);
    const claimedRoomIds = new Set<string>();
    const keepChannels = new Set<string>();
    const keepGuilds = new Set<string>();
    const projections: Array<{
        room: MatrixRoomDto;
        channelId: string;
        guildId?: string;
        parentId?: string;
        parentSpaceId?: string;
        channelPosition?: number;
        channel: any;
    }> = [];
    spaceIdsByGuildId.clear();
    guildIdsBySpaceId.clear();
    projectedRoomIdsByGuildId.clear();
    spaceCreateContextsByCategoryId.clear();

    for (const rootSpace of spaceGraph.roots) {
        const guildId = rememberSyntheticGuildId(stableSyntheticId("space", rootSpace.roomId));
        keepGuilds.add(guildId);
        spaceIdsByGuildId.set(guildId, rootSpace.roomId);
        const projectedSpaces = reachableSpaces(rootSpace.roomId, spaceGraph);
        for (const space of projectedSpaces) {
            let guildIds = guildIdsBySpaceId.get(space.roomId);
            if (!guildIds) guildIdsBySpaceId.set(space.roomId, guildIds = new Set());
            guildIds.add(guildId);
        }

        const channels: any[] = [];
        const categoryIds = new Map<string, string>();
        for (const [position, nestedSpace] of projectedSpaces.slice(1).entries()) {
            const categoryId = rememberSyntheticChannelId(stableSyntheticId(
                "space-category",
                `${rootSpace.roomId}\0${nestedSpace.roomId}`
            ));
            categoryIds.set(nestedSpace.roomId, categoryId);
            keepChannels.add(categoryId);
            injectedChannelIds.add(categoryId);
            spaceCreateContextsByCategoryId.set(categoryId, {
                guildId,
                parentSpaceId: nestedSpace.roomId,
                parentLabel: cleanDisplayText(nestedSpace.name, "Matrix category", 100),
            });
            channels.push(guildCategory(nestedSpace, guildId, categoryId, position));
        }

        const memberRooms = new Map<string, MatrixRoomDto>(
            projectedSpaces.slice(1).map(space => [space.roomId, space])
        );
        const projectedRoomIds = new Set<string>();
        projectedRoomIdsByGuildId.set(guildId, projectedRoomIds);
        for (const parentSpace of projectedSpaces) {
            let channelPosition = 0;
            for (const childId of spaceGraph.childrenBySpaceId.get(parentSpace.roomId) ?? []) {
                const room = spaceGraph.roomsById.get(childId);
                if (!room || isSpaceRoom(room)) continue;
                claimedRoomIds.add(room.roomId);
                projectedRoomIds.add(room.roomId);
                memberRooms.set(room.roomId, room);
                const parentId = parentSpace.roomId === rootSpace.roomId
                    ? undefined
                    : categoryIds.get(parentSpace.roomId);
                const channelId = rememberSyntheticChannelId(stableSyntheticId(
                    "space-room",
                    parentId
                        ? `${rootSpace.roomId}\0${parentSpace.roomId}\0${room.roomId}`
                        : `${rootSpace.roomId}\0${room.roomId}`
                ));
                keepChannels.add(channelId);
                const channel = guildChannel(room, guildId, channelId, channelPosition, parentId);
                projections.push({
                    room,
                    channelId,
                    guildId,
                    parentId,
                    parentSpaceId: parentSpace.roomId,
                    channelPosition,
                    channel,
                });
                channels.push(channel);
                channelPosition++;
            }
        }

        const guildRooms = [...memberRooms.values()];
        const guild = rawGuild(rootSpace, guildRooms, channels, snapshot, guildId);
        const signature = guildProjectionSignature(rootSpace, guildRooms, channels);
        const existingGuild = injectedGuildIds.has(guildId) && Boolean(GuildStore.getGuild(guildId));
        injectedGuildIds.add(guildId);
        if (!existingGuild || guildProjectionSignatures.get(guildId) !== signature) {
            FluxDispatcher.dispatch({ type: "GUILD_CREATE", guild });
            guildProjectionSignatures.set(guildId, signature);
        } else {
            for (const channel of channels) FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel });
        }
    }

    for (const room of joined) {
        if (isSpaceRoom(room) || claimedRoomIds.has(room.roomId)) continue;
        const channelId = rememberSyntheticChannelId(stableSyntheticId("room", room.roomId));
        keepChannels.add(channelId);
        const channel = privateChannel(room, snapshot, channelId);
        projections.push({ room, channelId, channel });
        FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel });
    }

    const selectedChannelId = SelectedChannelStore.getChannelId();
    activeMatrixChannelId = projections.some(projection => projection.channelId === selectedChannelId)
        ? selectedChannelId
        : undefined;
    const activeProjection = projections.find(projection => projection.channelId === activeMatrixChannelId);
    if (!timelineRoomIds || !activeProjection || timelineRoomIds.has(activeProjection.room.roomId)) {
        prepareRoomMedia(activeProjection?.room);
    }

    for (const projection of projections) {
        syncProjectionUnread(projection.channelId, projection.room);
        const previous = previousRooms.get(projection.channelId);
        const projectedTimelineRoom = previous?.isolatedContext
            ? projectedRoom(projection.room, roomMessages(previous.room))
            : projection.room;
        if (!previous || !timelineRoomIds || timelineRoomIds.has(projection.room.roomId)) {
            injectRoomTimeline(
                projectedTimelineRoom,
                snapshot,
                projection.channelId,
                previous,
                projection.guildId,
                projection.parentId,
                projection.parentSpaceId,
                projection.channelPosition
            );
        } else {
            roomsByChannel.set(projection.channelId, {
                ...previous,
                room: projectedTimelineRoom,
                guildId: projection.guildId,
                parentId: projection.parentId,
                parentSpaceId: projection.parentSpaceId,
                channelPosition: projection.channelPosition,
                selfMatrixId: accountUserId(snapshot),
            });
            injectedChannelIds.add(projection.channelId);
        }
    }

    for (const guildId of [...injectedGuildIds]) {
        if (!keepGuilds.has(guildId)) removeInjectedGuild(guildId);
    }
    for (const channelId of [...injectedChannelIds]) {
        if (!keepChannels.has(channelId)) removeInjectedChannel(channelId);
    }
    completeProjectedEchoRows(completedEchoesByRoom);
    publishMatrixAccessRequestProjection();
}

function projectionChannelRecord(injected: InjectedRoom, snapshot: MatrixSnapshotDto) {
    const snapshotBase = injected.isolatedContext
        ? snapshot.rooms?.find(room => room.roomId === injected.room.roomId)
        : undefined;
    const projection = snapshotBase
        ? {
            ...injected,
            room: projectedRoom(
                snapshotBase,
                roomHistoryById.get(snapshotBase.roomId)?.messages ?? roomMessages(snapshotBase)
            ),
        }
        : injected;
    if (!projection.guildId) return privateChannel(projection.room, snapshot, projection.channelId);
    const position = projection.channelPosition
        ?? ChannelStore.getChannel(injected.channelId)?.position
        ?? 0;
    return guildChannel(projection.room, projection.guildId, projection.channelId, position, projection.parentId);
}

function updateProjectionRoom(injected: InjectedRoom, room: MatrixRoomDto) {
    const next: InjectedRoom = {
        ...injected,
        room,
        messageIds: new Map(injected.messageIds),
        eventIds: new Map(injected.eventIds),
        messageTargets: new Map(injected.messageTargets),
        projectedMessagesByEventId: new Map(injected.projectedMessagesByEventId),
    };
    setProjectionIndexes(next, projectedTimelineMessages(roomMessages(room), injected));
    for (const previousMessageId of injected.eventIds.keys()) {
        if (!next.eventIds.has(previousMessageId)) {
            FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: injected.channelId, id: previousMessageId });
        }
    }
    roomsByChannel.set(next.channelId, next);
    return next;
}

function loadProjectionMessages(
    injected: InjectedRoom,
    messages: MatrixMessageDto[],
    {
        isBefore = false,
        isAfter = false,
        jump = null,
        hasMoreBefore = !roomHistoryById.get(injected.room.roomId)?.end,
        hasMoreAfter = false,
    }: {
        isBefore?: boolean;
        isAfter?: boolean;
        jump?: string | null;
        hasMoreBefore?: boolean;
        hasMoreAfter?: boolean;
    } = {}
) {
    const pageEventIds = new Set(messages.map(message => message.eventId));
    const projectedRoomMessages = projectedTimelineMessages(roomMessages(injected.room), injected);
    setProjectionIndexes(injected, projectedRoomMessages);
    const projectedMessages = projectedRoomMessages.filter(message =>
        message.target.eventIds.some(eventId => pageEventIds.has(eventId)));
    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId: injected.channelId,
        messages: [...projectedMessages].reverse().map(message => toRawMessage(message, injected)),
        isBefore,
        isAfter,
        jump,
        hasMoreBefore,
        hasMoreAfter,
        isStale: false,
        truncate: false,
        avoidInitialScroll: isBefore,
    });
}

function snapshotRoom(roomId: string) {
    return latestSnapshot?.rooms?.find(room => room.roomId === roomId);
}

function projectedRoom(room: MatrixRoomDto, messages: MatrixMessageDto[]): MatrixRoomDto {
    return { ...room, messages, timeline: undefined };
}

function applyDeltaUnread(
    projections: InjectedRoom[],
    message: MatrixMessageDto,
    wasProjected: boolean,
    lastMessageId: string
) {
    if (wasProjected) return;
    const selectedChannelId = SelectedChannelStore.getChannelId();
    const shouldMarkUnread = message.senderId !== accountUserId(latestSnapshot!)
        && !message.pending
        && !projections.some(projection => projection.channelId === selectedChannelId);
    for (const projection of projections) {
        const current = matrixUnreadByChannel.get(projection.channelId) ?? {
            unreadCount: 0,
            highlightCount: 0,
            lastMessageId: null,
        };
        matrixUnreadByChannel.set(projection.channelId, {
            ...current,
            unreadCount: current.unreadCount + (shouldMarkUnread ? 1 : 0),
            lastMessageId,
        });
    }
    matrixUnreadRevision++;
    (ReadStateStore as any).emitChange?.();
}

function applyMessageDelta(roomId: string, message: MatrixMessageDto, allowInsert = true) {
    const room = snapshotRoom(roomId);
    if (!room || message.roomId !== roomId) return;
    const projections = [...roomsByChannel.values()].filter(injected => injected.room.roomId === roomId);
    const transactionKey = message.transactionId ? `${roomId}\0${message.transactionId}` : undefined;
    const echoIdentity = messageEchoIdentity(message);
    const retainedMessages = roomHistoryById.get(roomId)?.messages ?? [];
    const matchingLocalEchoes = echoIdentity
        ? retainedMessages.filter(candidate =>
            !candidate.eventId.startsWith("$") && messageEchoIdentity(candidate) === echoIdentity)
        : [];
    const matchingRemoteEchoes = echoIdentity
        ? retainedMessages.filter(candidate =>
            candidate.eventId.startsWith("$") && messageEchoIdentity(candidate) === echoIdentity)
        : [];
    // Event streams are normally local-before-remote, but recovery replay can
    // invert them. Never let a late local echo replace an already-authoritative
    // remote event carrying the same exact transaction/group identity.
    if (!message.eventId.startsWith("$") && matchingRemoteEchoes.length === 1) return;
    const replacedEventId = (transactionKey ? eventIdsByTransaction.get(transactionKey) : undefined)
        ?? (matchingLocalEchoes.length === 1 ? matchingLocalEchoes[0].eventId : undefined);
    const completedLocalEcho = Boolean(
        replacedEventId?.startsWith(`~${roomId}:`)
        && message.eventId.startsWith("$")
        && !message.pending
        && !message.failed
    );
    const matchesMessage = (candidate: MatrixMessageDto) => candidate.eventId === message.eventId
        || Boolean(replacedEventId && candidate.eventId === replacedEventId);
    const historyKnown = roomHistoryById.get(roomId)?.messages.some(matchesMessage) ?? false;
    const normalProjectionKnown = projections.some(injected => !injected.isolatedContext
        && (injected.messageIds.has(message.eventId)
            || Boolean(replacedEventId && injected.messageIds.has(replacedEventId))));
    if (!allowInsert && !historyKnown && !normalProjectionKnown) {
        // Detached search/reply context is not proof of contiguous room history.
        // Update its visible row in place without merging an old event into the
        // ordinary backward-pagination sequence.
        for (const projection of projections.filter(injected => injected.isolatedContext
            && (injected.messageIds.has(message.eventId)
                || Boolean(replacedEventId && injected.messageIds.has(replacedEventId))))) {
            const projectionMessages = roomMessages(projection.room).map(candidate =>
                matchesMessage(candidate) ? message : candidate);
            const next = updateProjectionRoom(projection, projectedRoom(projection.room, projectionMessages));
            const projected = next.projectedMessagesByEventId.get(message.eventId);
            if (!projected) continue;
            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId: next.channelId,
                message: toRawMessage(projected, next),
            });
        }
        return;
    }
    if (replacedEventId && replacedEventId !== message.eventId) {
        preserveLocalEchoMessageId(replacedEventId, message);
        const currentHistory = roomHistoryById.get(roomId);
        if (currentHistory) {
            roomHistoryById.set(roomId, {
                ...currentHistory,
                // Preserve the local echo's canonical slot when the remote echo
                // arrives after unrelated live messages.
                messages: currentHistory.messages.map(candidate =>
                    candidate.eventId === replacedEventId ? message : candidate),
            });
        }
    }
    if (transactionKey) rememberTransactionEvent(message);
    const messageId = messageSyntheticId(message.eventId, message.timestamp);
    const primary = projections.find(injected => injected.channelId === activeMatrixChannelId)
        ?? projections.find(injected => injected.guildId === SelectedGuildStore.getGuildId())
        ?? projections[0];
    const eventWasProjected = projections.some(injected =>
        injected.messageIds.has(message.eventId)
        || Boolean(replacedEventId && injected.messageIds.has(replacedEventId)));
    const snapshotMessages = roomMessages(room);
    const snapshotIndex = snapshotMessages.findIndex(candidate => candidate.eventId === message.eventId);
    const replacedSnapshotIndex = replacedEventId
        ? snapshotMessages.findIndex(candidate => candidate.eventId === replacedEventId)
        : -1;
    if (snapshotIndex !== -1) snapshotMessages[snapshotIndex] = message;
    else if (replacedSnapshotIndex !== -1) snapshotMessages[replacedSnapshotIndex] = message;
    else snapshotMessages.push(message);
    const nextRoom = { ...room, messages: snapshotMessages.slice(-5_000), timeline: undefined };
    updateLatestSnapshotRoom(nextRoom);
    const history = mergeRoomHistory(roomId, [message], { placement: "after" });
    const nextProjectedRoom = projectedRoom(nextRoom, history.messages);
    if (validAttachmentGroup(message)) {
        const groupUpdates = projections.map(projection => {
            const projectionRoom = projection.isolatedContext
                ? projectedRoom(nextRoom, roomMessages(projection.room)
                    .filter(candidate => candidate.eventId !== replacedEventId)
                    .map(candidate => candidate.eventId === message.eventId ? message : candidate))
                : nextProjectedRoom;
            injectRoomTimeline(
                projectionRoom,
                latestSnapshot!,
                projection.channelId,
                projection,
                projection.guildId
            );
            const next = roomsByChannel.get(projection.channelId)!;
            const projected = next.projectedMessagesByEventId.get(message.eventId);
            if (!projected) return undefined;
            FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel: projectionChannelRecord(next, latestSnapshot!) });
            return { projected };
        }).filter((update): update is NonNullable<typeof update> => Boolean(update));
        if (completedLocalEcho) {
            completeProjectedEchoRows(new Map([[roomId, new Set([message.eventId])]]));
        }
        applyDeltaUnread(
            projections,
            message,
            eventWasProjected,
            groupUpdates[0]?.projected.messageId
                ?? projectedTimelineMessages(history.messages)
                    .find(projected => projected.target.eventIds.includes(message.eventId))?.messageId
                ?? messageId
        );
        focusRoomMedia(roomId, [
            message.eventId,
            ...(mediaFocusEventIdsByRoom.get(roomId) ?? []),
        ]);
        return;
    }

    const projectionUpdates = projections.map(projection => {
        const previousMessageIds = new Set(projection.eventIds.keys());
        const projectionRoom = projection.isolatedContext
            ? projectedRoom(nextRoom, roomMessages(projection.room)
                .filter(candidate => candidate.eventId !== replacedEventId)
                .map(candidate => candidate.eventId === message.eventId ? message : candidate))
            : nextProjectedRoom;
        const next = updateProjectionRoom(projection, projectionRoom);
        const projected = next.projectedMessagesByEventId.get(message.eventId);
        if (!projected) return undefined;
        const hadRow = previousMessageIds.has(projected.messageId);
        return { next, projected, hadRow };
    }).filter((update): update is NonNullable<typeof update> => Boolean(update));
    const wasProjected = projectionUpdates.some(update => update.hadRow);

    for (const { next, projected, hadRow } of projectionUpdates) {
        FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel: projectionChannelRecord(next, latestSnapshot!) });
        const raw = toRawMessage(projected, next);
        if (hadRow) {
            if (completedLocalEcho) {
                // CONNECTION_OPEN temporarily makes Discord's message store
                // reject MESSAGE_CREATE. Reestablish the complete bounded
                // timeline in that state (a one-row incremental load would
                // truncate the channel), then complete the optimistic row.
                if (!(MessageStore as any).isReady?.(next.channelId)) {
                    injectRoomTimeline(next.room, latestSnapshot!, next.channelId, next, next.guildId);
                }
            } else {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_UPDATE",
                    channelId: next.channelId,
                    message: raw,
                });
            }
        } else if (!wasProjected && next.channelId === primary?.channelId) {
            FluxDispatcher.dispatch({
                type: "MESSAGE_CREATE",
                channelId: next.channelId,
                message: raw,
                optimistic: Boolean(projected.message.pending),
            });
        } else {
            loadProjectionMessages(next, [message], { isAfter: true });
        }
    }
    if (completedLocalEcho) {
        completeProjectedEchoRows(new Map([[roomId, new Set([message.eventId])]]));
    }

    applyDeltaUnread(
        projections,
        message,
        wasProjected,
        projectionUpdates[0]?.projected.messageId ?? messageId
    );

    if (message.attachments?.length || message.sticker) {
        focusRoomMedia(roomId, [
            message.eventId,
            ...(mediaFocusEventIdsByRoom.get(roomId) ?? []),
        ]);
    } else if (primary?.channelId === activeMatrixChannelId) {
        prepareRoomMedia(roomsByChannel.get(activeMatrixChannelId)?.room ?? nextProjectedRoom);
    }
}

function applyRedactionDelta(roomId: string, eventId: string) {
    const room = snapshotRoom(roomId);
    if (!room) return;
    const nextRoom = {
        ...room,
        messages: roomMessages(room).filter(message => message.eventId !== eventId),
        timeline: undefined,
    };
    updateLatestSnapshotRoom(nextRoom);
    const currentHistory = roomHistoryById.get(roomId);
    if (currentHistory) {
        roomHistoryById.set(roomId, {
            ...currentHistory,
            messages: currentHistory.messages.filter(message => message.eventId !== eventId),
        });
    }
    const nextProjectedRoom = projectedRoom(nextRoom, roomHistoryById.get(roomId)?.messages ?? nextRoom.messages);
    for (const projection of [...roomsByChannel.values()].filter(injected => injected.room.roomId === roomId)) {
        const previousMessageId = projection.messageIds.get(eventId) ?? messageIdsByEventId.get(eventId);
        const previousTarget = previousMessageId
            ? projection.messageTargets.get(previousMessageId)
            : undefined;
        const projectionRoom = projection.isolatedContext
            ? projectedRoom(nextRoom, roomMessages(projection.room).filter(message => message.eventId !== eventId))
            : nextProjectedRoom;
        if (previousTarget && previousTarget.eventIds.length > 1) {
            // Removing a member can shrink or dissolve an aggregate and also
            // changes aliases used by replies elsewhere in the window. A full
            // bounded reinjection keeps all affected reply previews coherent.
            injectRoomTimeline(
                projectionRoom,
                latestSnapshot!,
                projection.channelId,
                projection,
                projection.guildId
            );
            const refreshed = roomsByChannel.get(projection.channelId)!;
            FluxDispatcher.dispatch({
                type: "CHANNEL_CREATE",
                channel: projectionChannelRecord(refreshed, latestSnapshot!),
            });
            continue;
        }
        const next = updateProjectionRoom(projection, projectionRoom);
        if (!previousMessageId) continue;
        FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel: projectionChannelRecord(next, latestSnapshot!) });
    }
    mediaFocusEventIdsByRoom.set(
        roomId,
        (mediaFocusEventIdsByRoom.get(roomId) ?? []).filter(candidate => candidate !== eventId)
    );
    const active = activeMatrixChannelId ? roomsByChannel.get(activeMatrixChannelId) : undefined;
    if (active?.room.roomId === roomId) prepareRoomMedia(active.room);
}

function applyReactionDelta(roomId: string, eventId: string, reactions: MatrixReactionDto[]) {
    const room = snapshotRoom(roomId);
    const message = roomHistoryById.get(roomId)?.messages.find(candidate => candidate.eventId === eventId)
        ?? roomMessages(room ?? { roomId }).find(candidate => candidate.eventId === eventId);
    if (message) applyMessageDelta(roomId, { ...message, reactions });
}

function applyRoomDelta(room: MatrixRoomDto) {
    const previous = snapshotRoom(room.roomId);
    const existed = Boolean(previous);
    const timelineReset = previous != null
        && (previous.timelineGeneration ?? 0) !== (room.timelineGeneration ?? 0);
    updateLatestSnapshotRoom(room);
    if (latestSnapshot) {
        applySnapshot(latestSnapshot, !existed || timelineReset ? new Set([room.roomId]) : new Set());
    }
}

export async function refreshSnapshot(expectedGeneration = pollGeneration) {
    const snapshot = await Native.snapshot() as MatrixSnapshotDto;
    if (!bridgeActive || expectedGeneration !== pollGeneration) return snapshot;
    const snapshotSequence = Number(snapshot.seq);
    if (Number.isSafeInteger(snapshotSequence) && snapshotSequence >= 0) {
        // Native stamps the snapshot with the event watermark captured before
        // requesting it. If the poller has already applied a newer delta, this
        // snapshot is an older view and must not roll that delta back while
        // retaining the newer cursor.
        if (snapshotSequence < eventCursor) return snapshot;
        // Do not advance the event poll from a bounded snapshot. Replaying
        // already-represented deltas is idempotent; skipping a message omitted
        // by the snapshot's per-room/global budget is not recoverable.
    }
    // Worker snapshots and the native event watermark are not an atomic cut:
    // the bounded snapshot may observe messages whose deltas are assigned later
    // sequence numbers. Apply metadata only and let the ordered event poll own
    // timeline insertion; otherwise those earlier deltas can replay after the
    // snapshot's newest suffix.
    applySnapshot({
        ...snapshot,
        rooms: (snapshot.rooms ?? []).map(room => ({
            ...room,
            // A queued TimelineReset room delta owns this transition; consuming
            // its generation here would leave stale Discord MessageStore rows.
            timelineGeneration: snapshotRoom(room.roomId)?.timelineGeneration
                ?? room.timelineGeneration,
            messages: [],
            timeline: undefined,
        })),
    }, new Set());
    return snapshot;
}

function updateTypingUsers(roomId: string, userIds: string[]) {
    const projections = [...roomsByChannel.values()].filter(candidate => candidate.room.roomId === roomId);
    const injected = projections[0];
    if (!injected) return;

    const previous = typingUsersByRoom.get(roomId) ?? new Set<string>();
    const next = new Set(userIds.filter(userId => userId !== injected.selfMatrixId));
    for (const userId of new Set([...previous, ...next])) {
        if (previous.has(userId) === next.has(userId)) continue;
        for (const projection of projections) {
            FluxDispatcher.dispatch({
                type: next.has(userId) ? "TYPING_START" : "TYPING_STOP",
                channelId: projection.channelId,
                userId: protectSyntheticId(stableSyntheticId("user", userId)),
            });
        }
    }
    typingUsersByRoom.set(roomId, next);
}

function reconnectDelay(): number {
    return Math.min(30_000, 1_500 * (2 ** Math.min(reconnectAttempt, 4)));
}

function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
}

const WORKER_RECOVERY_ERRORS = new Set([
    "MATRIX_WORKER_CRASHED",
    "MATRIX_WORKER_CLOSED",
    "MATRIX_WORKER_TIMEOUT",
    "MATRIX_WORKER_UNAVAILABLE",
    "MATRIX_COMMAND_TIMEOUT",
    "MATRIX_COMMAND_QUEUE_TIMEOUT",
    "MATRIX_CREATE_SPACE_AMBIGUOUS",
    "MATRIX_PROTOCOL_ERROR",
]);

function retryableStartFailure(error: unknown): boolean {
    const code = matrixErrorCode(error);
    return code == null || ![
        "MATRIX_ACCOUNT_MISSING",
        "MATRIX_ACCOUNT_CORRUPT",
        "MATRIX_PLUGIN_SUSPENDED",
        "MATRIX_SECURE_STORAGE_UNAVAILABLE",
        "MATRIX_STORAGE_CLEANUP_FAILED",
        "MATRIX_INVALID_ARGUMENT",
    ].includes(code);
}

function scheduleBridgeReconnect(
    generation: number,
    selectedAtStart?: string,
    routePreference?: Promise<MatrixRoutePreference | undefined>
) {
    if (!bridgeActive || generation !== pollGeneration || reconnectTimer) return;
    const delay = reconnectDelay();
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (!bridgeActive || generation !== pollGeneration) return;
        void connectBridge(generation, true, selectedAtStart, routePreference);
    }, delay);
}

async function pollEvents(generation: number) {
    while (generation === pollGeneration) {
        try {
            const event: any = await Native.nextEvent(eventCursor);
            if (generation !== pollGeneration) return;
            if (!event) continue;
            const previousCursor = eventCursor;
            const nextCursor = Number(event.seq ?? eventCursor);
            eventCursor = Math.max(eventCursor, nextCursor);
            if (event.type === "snapshot" && event.snapshot) {
                applySnapshot(event.snapshot, undefined, Number.isSafeInteger(nextCursor) && nextCursor > previousCursor + 1);
            }
            else if (event.type === "room" && event.room) applyRoomDelta(event.room);
            else if (event.type === "message" && event.message) applyMessageDelta(event.roomId, event.message);
            else if (event.type === "edit" && event.message) applyMessageDelta(event.roomId, event.message, false);
            else if (event.type === "edit") continue;
            else if (event.type === "redact") applyRedactionDelta(event.roomId, event.eventId);
            else if (event.type === "reaction") applyReactionDelta(event.roomId, event.eventId, event.reactions ?? []);
            else if (event.type === "typing") updateTypingUsers(event.roomId, event.userIds ?? []);
            else if (event.type === "status") {
                if (event.status?.state === "ready") reconnectAttempt = 0;
                const statusErrorCode = matrixErrorCode(event.status?.error);
                if ((event.status?.state === "error" && statusErrorCode != null
                    && WORKER_RECOVERY_ERRORS.has(statusErrorCode))
                    || (event.status?.state === "stopped" && event.status?.account)) {
                    scheduleBridgeReconnect(generation);
                    return;
                }
                continue;
            }
            else if (event.type === "receipt") continue;
            else await refreshSnapshot();
        } catch (error) {
            if (generation !== pollGeneration) return;
            logger.warn("Matrix event poll failed", error);
            scheduleBridgeReconnect(generation);
            return;
        }
    }
}

async function connectBridge(
    generation: number,
    recovering: boolean,
    selectedAtStart?: string,
    routePreference?: Promise<MatrixRoutePreference | undefined>
) {
    try {
        const snapshot = await Native.start() as MatrixSnapshotDto;
        if (!bridgeActive || generation !== pollGeneration) return;
        const startupErrorCode = snapshot.status?.state === "error"
            ? matrixErrorCode(snapshot.status.error)
            : undefined;
        if (startupErrorCode) logger.warn("Matrix startup failed", startupErrorCode);
        clearReconnectTimer();
        if (snapshot.status?.state === "ready") reconnectAttempt = 0;
        const snapshotSequence = Number(snapshot.seq);
        if (Number.isSafeInteger(snapshotSequence) && snapshotSequence >= 0) {
            eventCursor = Math.max(eventCursor, snapshotSequence);
        }
        // Chronological SDK local echoes are process-local and are not restored
        // by a fresh worker. Keeping them across a worker restart creates an
        // undismissable sending/failed ghost. A queue-gap reset uses the same
        // worker and still preserves its valid local echoes.
        applySnapshot(snapshot, undefined, recovering, !recovering);
        if (routePreference) {
            const preference = await routePreference;
            if (!bridgeActive || generation !== pollGeneration) return;
            const selectedNow = SelectedChannelStore.getChannelId();
            if (preference
                && preference.accountId === accountUserId(snapshot)
                && selectedNow === selectedAtStart
                && (selectedAtStart == null || selectedAtStart === preference.channelId)) {
                const projection = roomsByChannel.get(preference.channelId) ?? roomProjection(preference.roomId);
                if (projection) navigateToProjection(projection);
            }
        }
        void pollEvents(generation);
    } catch (error) {
        logger.info("Matrix is not configured yet", error);
        if (bridgeActive && generation === pollGeneration && retryableStartFailure(error)) {
            scheduleBridgeReconnect(generation, selectedAtStart, routePreference);
        }
    }
}

export async function startBridge() {
    bridgeActive = true;
    const generation = ++pollGeneration;
    clearReconnectTimer();
    reconnectAttempt = 0;
    const selectedAtStart = SelectedChannelStore.getChannelId();
    const routePreference = DataStore.get<MatrixRoutePreference>(MATRIX_ROUTE_KEY).catch(() => undefined);
    await connectBridge(generation, false, selectedAtStart, routePreference);
}

export function stopBridge() {
    bridgeActive = false;
    pollGeneration++;
    clearReconnectTimer();
    reconnectAttempt = 0;
    latestSnapshot = undefined;
    for (const modalKey of [...matrixSearchModalKeys]) closeModal(modalKey);
    matrixSearchModalKeys.clear();
    clearMediaHydration();
    for (const [roomId] of typingUsersByRoom) updateTypingUsers(roomId, []);
    typingUsersByRoom.clear();
    lastOutgoingTyping.clear();
    for (const pending of pendingReceiptsByRoom.values()) clearTimeout(pending.timer);
    pendingReceiptsByRoom.clear();
    lastReceiptEventByRoom.clear();
    matrixUserIdsBySyntheticId.clear();
    spaceIdsBySyntheticUserId.clear();
    roomHistoryById.clear();
    mediaFocusEventIdsByRoom.clear();
    messageIdsByEventId.clear();
    reservedReplyEventIds.clear();
    reservedReplyTargets.clear();
    eventIdsByTransaction.clear();
    paginationRequestsByRoom.clear();
    for (const guildId of [...injectedGuildIds]) removeInjectedGuild(guildId);
    for (const channelId of [...injectedChannelIds]) removeInjectedChannel(channelId);
    spaceIdsByGuildId.clear();
    guildIdsBySpaceId.clear();
    projectedRoomIdsByGuildId.clear();
    leavingMatrixSpaceSessions.clear();
    leavingMatrixGroupSessions.clear();
    spaceCreateContextsByCategoryId.clear();
    activeMatrixChannelId = undefined;
    lastPersistedRoute = "";
    publishMatrixAccessRequestProjection();
}

export async function suspendBridge() {
    stopBridge();
    try {
        await Native.suspend();
    } catch (error) {
        logger.warn("Matrix backend suspension failed", error);
    }
}

export async function restartBridge(resetNative = true) {
    // Only an already-active plugin may reconnect itself. Delayed Discord flux
    // callbacks or settings promises must not resurrect Matrix after disable.
    if (!bridgeActive) return;
    stopBridge();
    const restartGeneration = pollGeneration;
    if (resetNative) {
        try {
            // An explicit reconnect is also the recovery affordance for a latched
            // native startup failure. Suspending closes any surviving worker and
            // clears that latch without deleting the stored account or crypto DB.
            await Native.suspend();
        } catch (error) {
            logger.warn("Matrix backend restart suspension failed", error);
        }
    }
    // Plugin disable or a newer start/restart may have won while the native
    // lifecycle queue was settling. Never resurrect or supersede that owner.
    if (bridgeActive || pollGeneration !== restartGeneration) return;
    await startBridge();
}

export async function selectRoom(roomId: string | undefined) {
    if (roomId) openMatrixRoom(roomId);
}

export function getSelectedRoomId() {
    const channelId = SelectedChannelStore.getChannelId();
    return roomsByChannel.get(channelId)?.room.roomId;
}

export function getLatestSnapshot() {
    return latestSnapshot;
}

/** Opaque binding for a multi-await composer send; changes on account/worker lifecycle changes. */
export function getMatrixSendSessionToken(channelId: string) {
    const injected = roomsByChannel.get(channelId);
    const accountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    return bridgeActive && injected && accountId
        ? `${pollGeneration}\0${accountId}\0${injected.room.roomId}`
        : undefined;
}

export function registerMatrixSearchModal(modalKey: string) {
    matrixSearchModalKeys.add(modalKey);
}

export function unregisterMatrixSearchModal(modalKey: string) {
    matrixSearchModalKeys.delete(modalKey);
}

export async function clearMatrixRoutePreference() {
    lastPersistedRoute = "";
    const deletion = routeStorageTail.then(
        () => DataStore.del(MATRIX_ROUTE_KEY),
        () => DataStore.del(MATRIX_ROUTE_KEY),
    );
    routeStorageTail = deletion.then(() => undefined, () => undefined);
    await deletion;
}

export function getAvailableRooms() {
    return (latestSnapshot?.rooms ?? []).filter(room => isJoinedRoom(room) && !isSpaceRoom(room));
}

export function isMatrixChannelId(channelOrId: any) {
    const id = typeof channelOrId === "string"
        ? channelOrId
        : channelOrId?.id ?? channelOrId?.channelId;
    return typeof id === "string" && syntheticChannelIds.has(id);
}

export function isMatrixGuildId(guildOrId: any) {
    const id = typeof guildOrId === "string"
        ? guildOrId
        : guildOrId?.id ?? guildOrId?.guildId ?? guildOrId?.guild_id;
    return typeof id === "string" && syntheticGuildIds.has(id);
}

export function getMatrixSecureRoute(channelId: string | undefined): MatrixSecureViewRoute | undefined {
    const room = channelId ? roomsByChannel.get(channelId)?.room : undefined;
    if (!room) return undefined;
    const kind = isSpaceRoom(room)
        ? "space"
        : room.kind === "dm" ? "dm" : "room";
    return { kind, roomId: room.roomId };
}

export function activateMatrixChannel(channelId: string | undefined) {
    const injected = channelId ? roomsByChannel.get(channelId) : undefined;
    const nextChannelId = injected?.channelId;
    if (activeMatrixChannelId === nextChannelId) return;
    const previousRoomId = activeMatrixChannelId
        ? roomsByChannel.get(activeMatrixChannelId)?.room.roomId
        : undefined;
    if (previousRoomId && previousRoomId !== injected?.room.roomId) {
        clearIsolatedSearchContext(previousRoomId);
        void flushMatrixReceipt(previousRoomId);
    }
    activeMatrixChannelId = nextChannelId;
    prepareRoomMedia(injected?.room);
    if (injected) persistMatrixRoute(injected);
}

export function isMatrixMediaUrl(value: unknown) {
    if (typeof value !== "string") return false;
    for (const entry of mediaCache.values()) {
        if (entry.state !== "ready" || !entry.attachment) continue;
        if (entry.attachment.url === value || entry.attachment.proxyUrl === value) return true;
    }
    return false;
}

function containsSyntheticId(value: unknown, depth = 0): boolean {
    if (!protectedSyntheticIds.size) return false;
    if (depth > 5 || value == null) return false;
    if (typeof value === "string") {
        if (protectedSyntheticIds.has(value)) return true;
        return value.match(/\d{15,22}/gu)?.some(id => protectedSyntheticIds.has(id)) ?? false;
    }
    if (Array.isArray(value)) return value.some(item => containsSyntheticId(item, depth + 1));
    if (typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some(item => containsSyntheticId(item, depth + 1));
    }
    return false;
}

function oldestProjectedUnreadMessageId(channelId: string, unreadCount: number) {
    const injected = roomsByChannel.get(channelId);
    if (!injected || !unreadCount) return null;
    const messages = roomMessages(injected.room);
    const message = messages[Math.max(0, messages.length - unreadCount)];
    return message ? messageSyntheticId(message.eventId, message.timestamp) : null;
}

export function installReadStateProjection() {
    if (originalReadStateMethods.size) return;
    const store = ReadStateStore as any;
    const wrap = (name: string, replacement: (original: Function, self: any, args: any[]) => any) => {
        const original = store[name];
        if (typeof original !== "function") return;
        originalReadStateMethods.set(name, original);
        store[name] = function (...args: any[]) {
            return replacement(original, this, args);
        };
    };

    wrap("getUnreadCount", (original, self, args) =>
        matrixUnreadByChannel.get(args[0])?.unreadCount ?? original.apply(self, args));
    wrap("getMentionCount", (original, self, args) =>
        matrixUnreadByChannel.get(args[0])?.highlightCount ?? original.apply(self, args));
    wrap("hasUnread", (original, self, args) => {
        const state = matrixUnreadByChannel.get(args[0]);
        return state ? state.unreadCount > 0 : original.apply(self, args);
    });
    wrap("hasUnreadOrMentions", (original, self, args) => {
        const state = matrixUnreadByChannel.get(args[0]);
        return state ? state.unreadCount > 0 || state.highlightCount > 0 : original.apply(self, args);
    });
    wrap("hasTrackedUnread", (original, self, args) =>
        matrixUnreadByChannel.has(args[0]) || original.apply(self, args));
    wrap("isEstimated", (original, self, args) => {
        const state = matrixUnreadByChannel.get(args[0]);
        if (!state) return original.apply(self, args);
        return state.unreadCount > roomMessages(roomsByChannel.get(args[0])?.room ?? { roomId: "" }).length;
    });
    wrap("lastMessageId", (original, self, args) =>
        matrixUnreadByChannel.get(args[0])?.lastMessageId ?? original.apply(self, args));
    wrap("getOldestUnreadMessageId", (original, self, args) => {
        const state = matrixUnreadByChannel.get(args[0]);
        return state
            ? oldestProjectedUnreadMessageId(args[0], state.unreadCount)
            : original.apply(self, args);
    });
    wrap("getMentionChannelIds", (original, self, args) => {
        const ids = new Set(original.apply(self, args) as string[]);
        for (const [channelId, state] of matrixUnreadByChannel) {
            if (state.highlightCount > 0) ids.add(channelId);
        }
        return [...ids];
    });
    wrap("getGuildChannelUnreadState", (original, self, args) => {
        const state = matrixUnreadByChannel.get(args[0]?.id);
        return state ? {
            mentionCount: state.highlightCount,
            unread: state.unreadCount > 0,
            isMentionLowImportance: false,
        } : original.apply(self, args);
    });
    wrap("getGuildUnreadsSentinel", (original, self, args) => {
        if (!syntheticGuildIds.has(args[0])) return original.apply(self, args);
        return [...roomsByChannel.values()].some(injected => {
            const state = matrixUnreadByChannel.get(injected.channelId);
            return injected.guildId === args[0] && Boolean(state && (state.unreadCount > 0 || state.highlightCount > 0));
        })
            ? matrixUnreadRevision
            : 0;
    });
    wrap("getSnapshot", (original, self, args) => {
        const channelId = args[0];
        const state = matrixUnreadByChannel.get(channelId);
        if (!state) return original.apply(self, args);
        const guild = Boolean(roomsByChannel.get(channelId)?.guildId);
        return {
            unread: state.unreadCount > 0,
            mentionCount: state.highlightCount,
            guildUnread: guild ? state.unreadCount > 0 : null,
            guildMentionCount: guild ? state.highlightCount : null,
            takenAt: Date.now(),
        };
    });
}

export function removeReadStateProjection() {
    const store = ReadStateStore as any;
    for (const [name, original] of originalReadStateMethods) store[name] = original;
    originalReadStateMethods.clear();
    matrixUnreadByChannel.clear();
    matrixUnreadRevision++;
    store.emitChange?.();
}

function localSyntheticRestBody(method: string, request: unknown): unknown | undefined {
    if (!request || typeof request !== "object" || !containsSyntheticId(request)) return undefined;
    const { url } = request as { url?: unknown; };
    if (typeof url !== "string") return undefined;
    const pathname = url.split("?", 1)[0];

    if (method === "post" && /^\/guilds\/\d{15,22}\/migrate-command-scope$/u.test(pathname)) {
        return { integration_ids_with_app_commands: [] };
    }
    if (
        method === "get"
        && (
            /^\/guilds\/\d{15,22}\/(?:entitlements|integrations|powerups)$/u.test(pathname)
            || pathname === "/store/published-listings/skus"
        )
    ) {
        return [];
    }
    if (method === "patch" && /^\/channels\/\d{15,22}\/explicit-media$/u.test(pathname)) {
        return {};
    }
    return undefined;
}

function localRestSuccess(body: unknown) {
    return {
        ok: true,
        status: 200,
        body,
        text: "",
        headers: {},
    };
}

export function installRestGuard() {
    if (guardedRestApi || highLevelRestGuardInstalled) return;
    // Resolve Discord's browser SuperAgent export specifically. A generic
    // get/post/put/patch/del lookup also matches higher-level promise APIs,
    // whose return contract is different from this chainable request builder.
    const restApi = findByProps(
        "Request",
        "getXHR",
        "Response",
        "agent",
        "get",
        "post",
        "put",
        "patch",
        "del"
    ) as Record<string, Function> | undefined;
    if (!restApi) throw new Error("MatrixBridge could not install its Discord REST guard");

    // Most Discord REST calls go through this typed Promise API. Neutralize
    // the routine compatibility probes that Discord automatically performs for a
    // virtual guild/channel; rejecting them causes retry and unhandled-promise
    // floods even though the final request is correctly blocked.
    const highLevelRestApi = RestAPI as unknown as Record<string, Function>;
    for (const method of ["get", "post", "put", "patch", "del"]) {
        const original = highLevelRestApi[method];
        if (typeof original !== "function") continue;
        originalHighLevelRestMethods.set(method, original);
        highLevelRestApi[method] = function (request: unknown, ...args: unknown[]) {
            const localBody = localSyntheticRestBody(method, request);
            if (localBody !== undefined) return Promise.resolve(localRestSuccess(localBody));
            if (containsSyntheticId(request) || args.some(argument => containsSyntheticId(argument))) {
                return Promise.reject(new Error("MatrixBridge blocked an unsupported synthetic REST request"));
            }
            return original.call(this, request, ...args);
        };
    }
    highLevelRestGuardInstalled = true;

    guardedRestApi = restApi;
    for (const method of ["get", "post", "put", "patch", "del"]) {
        const original = restApi[method];
        if (typeof original !== "function") continue;
        originalRestMethods.set(method, original);
        restApi[method] = function (request: unknown, ...args: unknown[]) {
            if (containsSyntheticId(request) || args.some(argument => containsSyntheticId(argument))) {
                // This module is SuperAgent: get/post/etc. return a chainable
                // Request, not a Promise. Returning Promise.reject breaks
                // callers that immediately use .query(), .send(), or .set().
                // Build an inert request with no private identifier in its URL,
                // abort it before it can create an XHR, and preserve the native
                // builder/thenable contract for the caller.
                const blocked = original.call(this, "about:blank");
                if (!blocked || typeof blocked.abort !== "function") {
                    throw new Error("MatrixBridge could not safely block a synthetic REST request");
                }
                blocked.abort();
                return blocked;
            }
            return original.call(this, request, ...args);
        };
    }
}

export function removeRestGuard() {
    if (guardedRestApi) {
        for (const [method, original] of originalRestMethods) guardedRestApi[method] = original;
    }
    originalRestMethods.clear();
    guardedRestApi = undefined;
    if (highLevelRestGuardInstalled) {
        const highLevelRestApi = RestAPI as unknown as Record<string, Function>;
        for (const [method, original] of originalHighLevelRestMethods) highLevelRestApi[method] = original;
    }
    originalHighLevelRestMethods.clear();
    highLevelRestGuardInstalled = false;
}

export function getActiveChannelId() {
    const selectedChannelId = SelectedChannelStore.getChannelId();
    return roomsByChannel.has(selectedChannelId)
        ? selectedChannelId
        : activeMatrixChannelId;
}

function roomProjection(roomId: string | undefined) {
    if (!roomId) return undefined;
    const projections = [...roomsByChannel.values()].filter(injected => injected.room.roomId === roomId);
    const selectedGuildId = SelectedGuildStore.getGuildId();
    return projections.find(injected => injected.channelId === activeMatrixChannelId)
        ?? projections.find(injected => !injected.guildId)
        ?? projections.find(injected => injected.guildId === selectedGuildId)
        ?? projections[0];
}

function persistMatrixRoute(injected: InjectedRoom) {
    const accountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    if (!accountId) return;
    const preference: MatrixRoutePreference = {
        accountId,
        roomId: injected.room.roomId,
        channelId: injected.channelId,
    };
    const serialized = JSON.stringify(preference);
    if (serialized === lastPersistedRoute) return;
    lastPersistedRoute = serialized;
    const write = routeStorageTail.then(
        () => DataStore.set(MATRIX_ROUTE_KEY, preference),
        () => DataStore.set(MATRIX_ROUTE_KEY, preference),
    );
    routeStorageTail = write.then(() => undefined, () => undefined);
    void write.catch(error => logger.warn("Matrix route persistence failed", error));
}

function navigateToProjection(injected: InjectedRoom) {
    if (!ChannelStore.hasChannel(injected.channelId)) return false;
    const previousRoomId = activeMatrixChannelId
        ? roomsByChannel.get(activeMatrixChannelId)?.room.roomId
        : undefined;
    if (previousRoomId && previousRoomId !== injected.room.roomId) {
        clearIsolatedSearchContext(previousRoomId);
        void flushMatrixReceipt(previousRoomId);
    }
    activeMatrixChannelId = injected.channelId;
    prepareRoomMedia(injected.room);
    persistMatrixRoute(injected);
    NavigationRouter.transitionToGuild(injected.guildId ?? "@me", injected.channelId);
    return true;
}

export function openMatrixRoom(roomId?: string) {
    const fallback = getActiveChannelId();
    const injected = roomProjection(roomId)
        ?? (fallback ? roomsByChannel.get(fallback) : undefined)
        ?? [...roomsByChannel.values()].find(candidate => !candidate.guildId)
        ?? roomsByChannel.values().next().value;
    return injected ? navigateToProjection(injected) : false;
}

export function openMatrixSpace(spaceId: string) {
    const guildIds = guildIdsBySpaceId.get(spaceId);
    if (!guildIds?.size) return false;
    const selectedGuildId = SelectedGuildStore.getGuildId();
    const guildId = selectedGuildId && guildIds.has(selectedGuildId)
        ? selectedGuildId
        : [...guildIds].sort()[0];
    const firstChannel = [...roomsByChannel.values()].find(injected =>
        injected.guildId === guildId && injected.parentSpaceId === spaceId)
        ?? [...roomsByChannel.values()].find(injected => injected.guildId === guildId);
    if (firstChannel) return navigateToProjection(firstChannel);
    NavigationRouter.transitionToGuild(guildId);
    return true;
}

export interface MatrixSpaceCreateContext {
    parentSpaceId: string;
    parentLabel: string;
    canManageSpaceChildren: boolean;
}

export interface MatrixAccessRequestContext {
    guildId: string;
    spaceId: string;
    label: string;
    expectedAccountId: string;
    generation: number;
    count: number;
    countComplete: boolean;
    canApprove: boolean;
    canDeny: boolean;
}

export interface MatrixAccessRequest {
    userId: string;
    displayName: string;
    /** Validated but deliberately not rendered directly; it is still external media. */
    avatarUrl?: string;
    canApprove: boolean;
    canDeny: boolean;
}

export interface MatrixAccessRequestList {
    spaceId: string;
    requests: MatrixAccessRequest[];
    truncated: boolean;
    canApprove: boolean;
    canDeny: boolean;
}

export type MatrixAccessRequestDecision = "approve" | "deny";

function boundedAccessRequestCount(value: unknown) {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 200
        ? value as number
        : 0;
}

function sameAccessRequestBinding(
    left: MatrixAccessRequestContext,
    right: MatrixAccessRequestContext | undefined
) {
    return Boolean(right)
        && left.guildId === right!.guildId
        && left.spaceId === right!.spaceId
        && left.expectedAccountId === right!.expectedAccountId
        && left.generation === right!.generation;
}

export function getMatrixAccessRequestContext(guildId: string): MatrixAccessRequestContext | undefined {
    if (!bridgeActive || !injectedGuildIds.has(guildId) || !GuildStore.getGuild(guildId)) return undefined;
    const spaceId = spaceIdsByGuildId.get(guildId);
    const expectedAccountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    if (!spaceId || !expectedAccountId) return undefined;
    const space = joinedSpace(spaceId);
    if (!space) return undefined;
    return {
        guildId,
        spaceId,
        label: cleanDisplayText(
            space.name?.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ""),
            "Server",
            100
        ),
        expectedAccountId,
        generation: pollGeneration,
        count: boundedAccessRequestCount(space.accessRequestCount),
        countComplete: space.accessRequestCountComplete === true,
        canApprove: space.canApproveAccessRequests === true,
        canDeny: space.canDenyAccessRequests === true,
    };
}

export function getMatrixAccessRequestContexts() {
    return [...injectedGuildIds]
        .sort()
        .map(getMatrixAccessRequestContext)
        .filter((context): context is MatrixAccessRequestContext => Boolean(context));
}

export function isMatrixAccessRequestContextCurrent(context: MatrixAccessRequestContext) {
    return sameAccessRequestBinding(context, getMatrixAccessRequestContext(context.guildId));
}

export function subscribeMatrixAccessRequestProjection(
    listener: (contexts: readonly MatrixAccessRequestContext[]) => void
) {
    accessRequestProjectionListeners.add(listener);
    try {
        listener(getMatrixAccessRequestContexts());
    } catch (error) {
        logger.warn("Access request projection listener failed", error);
    }
    return () => accessRequestProjectionListeners.delete(listener);
}

function publishMatrixAccessRequestProjection() {
    const contexts = getMatrixAccessRequestContexts();
    for (const listener of accessRequestProjectionListeners) {
        try {
            listener(contexts);
        } catch (error) {
            logger.warn("Access request projection listener failed", error);
        }
    }
}

function currentAccessRequestContext(
    expected: MatrixAccessRequestContext,
    decision?: MatrixAccessRequestDecision
) {
    const current = getMatrixAccessRequestContext(expected.guildId);
    if (!sameAccessRequestBinding(expected, current)) return undefined;
    if (decision === "approve" && !current!.canApprove) return undefined;
    if (decision === "deny" && !current!.canDeny) return undefined;
    return current;
}

function normalizedAccessRequestUserId(value: unknown) {
    if (typeof value !== "string" || value.length < 4 || value.length > 512
        || !/^@[^\s:\u0000-\u001f\u007f]+:[^\s\u0000-\u001f\u007f]+$/u.test(value)) {
        throw new Error("The access request response was invalid.");
    }
    return value;
}

function normalizedAccessRequestDisplayName(value: unknown, userId: string) {
    if (value == null) return userId;
    if (typeof value !== "string") throw new Error("The access request response was invalid.");
    return cleanDisplayText(
        value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ""),
        userId,
        100
    );
}

function normalizedAccessRequestAvatarUrl(value: unknown) {
    if (value == null) return undefined;
    if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error("The access request response was invalid.");
    }
    try {
        const url = new URL(value);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
            throw new Error("The access request response was invalid.");
        }
    } catch {
        throw new Error("The access request response was invalid.");
    }
    return value;
}

function normalizeAccessRequestList(value: unknown, context: MatrixAccessRequestContext): MatrixAccessRequestList {
    const response = value as Record<string, unknown> | null;
    if (!response || typeof response !== "object"
        || response.spaceId !== context.spaceId
        || !Array.isArray(response.requests)
        || response.requests.length > 200
        || typeof response.truncated !== "boolean"
        || typeof response.canApproveAccessRequests !== "boolean"
        || typeof response.canDenyAccessRequests !== "boolean") {
        throw new Error("The access request response was invalid.");
    }
    const seen = new Set<string>();
    const requests = response.requests.map(value => {
        const request = value as Record<string, unknown> | null;
        if (!request || typeof request !== "object"
            || typeof request.canApprove !== "boolean"
            || typeof request.canDeny !== "boolean") {
            throw new Error("The access request response was invalid.");
        }
        const userId = normalizedAccessRequestUserId(request.userId);
        if (seen.has(userId)) throw new Error("The access request response was invalid.");
        seen.add(userId);
        return {
            userId,
            displayName: normalizedAccessRequestDisplayName(request.displayName, userId),
            avatarUrl: normalizedAccessRequestAvatarUrl(request.avatarUrl),
            canApprove: request.canApprove,
            canDeny: request.canDeny,
        };
    });
    return {
        spaceId: context.spaceId,
        requests,
        truncated: response.truncated,
        canApprove: response.canApproveAccessRequests,
        canDeny: response.canDenyAccessRequests,
    };
}

export async function getMatrixSpaceAccessRequests(context: MatrixAccessRequestContext) {
    const current = currentAccessRequestContext(context);
    if (!current || !current.canApprove && !current.canDeny) {
        throw new Error("The access request context is no longer current.");
    }
    const result = await Native.getSpaceAccessRequests(context.spaceId, context.expectedAccountId) as unknown;
    const after = currentAccessRequestContext(context);
    if (!after || !after.canApprove && !after.canDeny) {
        throw new Error("The access request context is no longer current.");
    }
    return normalizeAccessRequestList(result, context);
}

function updateProjectedAccessRequestCount(context: MatrixAccessRequestContext, count: number) {
    if (!latestSnapshot || !currentAccessRequestContext(context)) return;
    let changed = false;
    const rooms = (latestSnapshot.rooms ?? []).map(room => {
        if (room.roomId !== context.spaceId || room.accessRequestCount === count) return room;
        changed = true;
        return { ...room, accessRequestCount: count };
    });
    if (!changed) return;
    latestSnapshot = { ...latestSnapshot, rooms };
    publishMatrixAccessRequestProjection();
}

export async function resolveMatrixSpaceAccessRequest(
    context: MatrixAccessRequestContext,
    userIdValue: string,
    decision: MatrixAccessRequestDecision
) {
    const userId = normalizedAccessRequestUserId(userIdValue);
    if (!currentAccessRequestContext(context, decision)) {
        throw new Error("The access request context is no longer current.");
    }
    let value: unknown;
    try {
        value = await Native.resolveSpaceAccessRequest({
            spaceId: context.spaceId,
            userId,
            decision,
        }, context.expectedAccountId) as unknown;
    } catch (error) {
        if (matrixErrorCode(error) === "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS"
            && currentAccessRequestContext(context, decision)) {
            try {
                await refreshSnapshot(context.generation);
            } catch (refreshError) {
                logger.warn("Ambiguous access request resolution refresh failed", refreshError);
            }
        }
        throw error;
    }
    if (!currentAccessRequestContext(context, decision)) {
        throw new Error("The access request context is no longer current.");
    }
    const result = value as Record<string, unknown> | null;
    const count = result ? boundedAccessRequestCount(result.accessRequestCount) : -1;
    const membershipValid = decision === "approve"
        ? result?.membership === "invite" || result?.membership === "join"
        : result?.membership === "leave";
    if (!result || typeof result !== "object"
        || result.spaceId !== context.spaceId
        || result.userId !== userId
        || result.decision !== decision
        || !membershipValid
        || count !== result.accessRequestCount) {
        throw new Error("The access request response was invalid.");
    }
    updateProjectedAccessRequestCount(context, count);
    if (!currentAccessRequestContext(context, decision)) {
        throw new Error("The access request context is no longer current.");
    }
    try {
        await refreshSnapshot(context.generation);
    } catch (error) {
        if (!currentAccessRequestContext(context, decision)) {
            throw new Error("The access request context is no longer current.");
        }
        logger.warn("Access request projection refresh failed", error);
    }
    if (!currentAccessRequestContext(context, decision)) {
        throw new Error("The access request context is no longer current.");
    }
    return {
        userId,
        decision,
        membership: result.membership as "invite" | "join" | "leave",
        accessRequestCount: count
    };
}

function joinedSpace(spaceId: string) {
    return latestSnapshot?.rooms?.find(room =>
        room.roomId === spaceId && isJoinedRoom(room) && isSpaceRoom(room));
}

export function canManageMatrixSpaceChildren(spaceId: string) {
    return bridgeActive && joinedSpace(spaceId)?.canManageSpaceChildren === true;
}

export function getMatrixSpaceCreateContext(guildId: string): MatrixSpaceCreateContext | undefined {
    if (!bridgeActive || !injectedGuildIds.has(guildId) || !GuildStore.getGuild(guildId)) return undefined;
    const parentSpaceId = spaceIdsByGuildId.get(guildId);
    if (!parentSpaceId) return undefined;
    const space = joinedSpace(parentSpaceId);
    if (!space) return undefined;
    return {
        parentSpaceId,
        parentLabel: cleanDisplayText(space.name, "Matrix space", 100),
        canManageSpaceChildren: space.canManageSpaceChildren === true,
    };
}

export function getMatrixCategoryCreateContext(channelId: string): MatrixSpaceCreateContext | undefined {
    if (!bridgeActive || !injectedChannelIds.has(channelId)) return undefined;
    const context = spaceCreateContextsByCategoryId.get(channelId);
    const channel = ChannelStore.getChannel(channelId);
    if (!context
        || !channel
        || channel.type !== ChannelType.GUILD_CATEGORY
        || channel.guild_id !== context.guildId
        || !guildIdsBySpaceId.get(context.parentSpaceId)?.has(context.guildId)
        || !joinedSpace(context.parentSpaceId)) return undefined;
    return {
        parentSpaceId: context.parentSpaceId,
        parentLabel: context.parentLabel,
        canManageSpaceChildren: canManageMatrixSpaceChildren(context.parentSpaceId),
    };
}

export async function leaveMatrixGuild(guildId: string) {
    const context = getMatrixSpaceCreateContext(guildId);
    const accountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    if (!context || !accountId) {
        showToast("That Matrix server is no longer available.", Toasts.Type.FAILURE);
        return false;
    }

    const generation = pollGeneration;
    const sessionKey = `${generation}\0${accountId}\0${context.parentSpaceId}`;
    if (leavingMatrixSpaceSessions.has(sessionKey)) {
        showToast("That Matrix server is already being left.", Toasts.Type.MESSAGE);
        return false;
    }
    const sessionIsCurrent = () => bridgeActive
        && pollGeneration === generation
        && Boolean(latestSnapshot)
        && accountUserId(latestSnapshot!) === accountId;

    leavingMatrixSpaceSessions.add(sessionKey);
    try {
        await Native.leaveRoom(context.parentSpaceId, accountId);
        if (!sessionIsCurrent()) return false;
        if (SelectedGuildStore.getGuildId() === guildId) NavigationRouter.transitionToGuild("@me");
        try {
            await refreshSnapshot(generation);
        } catch (error) {
            // The successful worker mutation already emits an authoritative
            // snapshot. Keep the success durable and let the ordered event
            // poll converge if this best-effort refresh races a reconnect.
            logger.warn("Matrix server leave refresh failed", error);
        }
        if (!sessionIsCurrent()) return false;
        showToast(`Left ${context.parentLabel}.`, Toasts.Type.SUCCESS);
        return true;
    } catch (error) {
        if (sessionIsCurrent()) reportFailure("server leave", error);
        return false;
    } finally {
        leavingMatrixSpaceSessions.delete(sessionKey);
    }
}

export interface MatrixGroupLeaveContext {
    channelId: string;
    label: string;
}

export function getMatrixGroupLeaveContext(channelId: string): MatrixGroupLeaveContext | undefined {
    if (!bridgeActive || !injectedChannelIds.has(channelId)) return undefined;
    const injected = roomsByChannel.get(channelId);
    const channel = ChannelStore.getChannel(channelId);
    if (!injected
        || injected.guildId
        || !isJoinedRoom(injected.room)
        || channel?.type !== ChannelType.GROUP_DM) return undefined;
    return {
        channelId,
        label: cleanDisplayText(injected.room.name, "Matrix group", 100),
    };
}

export async function leaveMatrixGroup(channelId: string) {
    const context = getMatrixGroupLeaveContext(channelId);
    const injected = context ? roomsByChannel.get(channelId) : undefined;
    const accountId = latestSnapshot ? accountUserId(latestSnapshot) : undefined;
    if (!context || !injected || !accountId) {
        showToast("That Matrix group is no longer available.", Toasts.Type.FAILURE);
        return false;
    }

    const generation = pollGeneration;
    const { roomId } = injected.room;
    const sessionKey = `${generation}\0${accountId}\0${roomId}`;
    if (leavingMatrixGroupSessions.has(sessionKey)) {
        showToast("That Matrix group is already being left.", Toasts.Type.MESSAGE);
        return false;
    }
    const sessionIsCurrent = () => bridgeActive
        && pollGeneration === generation
        && Boolean(latestSnapshot)
        && accountUserId(latestSnapshot!) === accountId;

    leavingMatrixGroupSessions.add(sessionKey);
    try {
        await Native.leaveRoom(roomId, accountId);
        if (!sessionIsCurrent()) return false;
        if (SelectedChannelStore.getChannelId() === channelId) NavigationRouter.transitionToGuild("@me");
        try {
            await refreshSnapshot(generation);
        } catch (error) {
            // The successful mutation emits an authoritative snapshot. Let the
            // ordered poll converge if this best-effort refresh races it.
            logger.warn("Matrix group leave refresh failed", error);
        }
        if (!sessionIsCurrent()) return false;
        showToast(`Left ${context.label}.`, Toasts.Type.SUCCESS);
        return true;
    } catch (error) {
        if (sessionIsCurrent()) reportFailure("group leave", error);
        return false;
    } finally {
        leavingMatrixGroupSessions.delete(sessionKey);
    }
}

export interface MatrixSearchContext {
    channelId: string;
    label: string;
    scope: MatrixMessageSearchScope;
    includesEncryptedRooms: boolean;
}

export function getMatrixSearchContext(channelId = getActiveChannelId()): MatrixSearchContext | undefined {
    const injected = channelId ? roomsByChannel.get(channelId) : undefined;
    if (!injected) return undefined;
    if (!injected.guildId) {
        return {
            channelId: injected.channelId,
            label: cleanDisplayText(injected.room.name, "this chat", 100),
            scope: { kind: "room", roomId: injected.room.roomId },
            includesEncryptedRooms: Boolean(injected.room.encrypted),
        };
    }

    const spaceId = spaceIdsByGuildId.get(injected.guildId);
    const space = latestSnapshot?.rooms?.find(room => room.roomId === spaceId && isJoinedRoom(room) && isSpaceRoom(room));
    if (!spaceId || !space) return undefined;
    const projectedRoomIds = projectedRoomIdsByGuildId.get(injected.guildId) ?? new Set<string>();
    return {
        channelId: injected.channelId,
        label: cleanDisplayText(space.name, "this space", 100),
        scope: { kind: "space", spaceId },
        includesEncryptedRooms: (latestSnapshot?.rooms ?? []).some(room =>
            projectedRoomIds.has(room.roomId) && isJoinedRoom(room) && Boolean(room.encrypted)),
    };
}

export async function searchMatrixMessages(
    channelId: string,
    query: string,
    cursor?: string
): Promise<MatrixMessageSearchResponse> {
    const context = getMatrixSearchContext(channelId);
    if (!context) throw new Error("This Matrix search scope is no longer available.");
    const request: MatrixMessageSearchRequest = {
        query,
        scope: context.scope,
        limit: 25,
        cursor,
    };
    return await Native.searchMessages(request);
}

export function openMatrixSearchResult(result: MatrixMessageSearchResultDTO) {
    const room = snapshotRoom(result.roomId);
    if (!room || !isJoinedRoom(room) || isSpaceRoom(room) || result.message.roomId !== result.roomId) return false;
    const projections = [...roomsByChannel.values()].filter(injected => injected.room.roomId === result.roomId);
    if (!projections.length || !latestSnapshot) return false;
    // Search can find decrypted events retained outside the bounded snapshot.
    // Only merge a result into normal history when a live projection already
    // proves that event belongs to its contiguous timeline; all other hits use
    // an explicitly isolated context and cannot manufacture a middle gap.
    const useIsolatedContext = !roomHistoryById.get(result.roomId)?.messages.some(message =>
        message.eventId === result.message.eventId)
        && !projections.some(projection => !projection.isolatedContext
            && projection.messageIds.has(result.message.eventId));
    const contextMessages = [...result.before, result.message, ...result.after] as MatrixMessageDto[];
    const history = useIsolatedContext ? undefined : mergeRoomHistory(result.roomId, contextMessages);
    const roomWithContext = projectedRoom(room, history?.messages ?? contextMessages);
    focusRoomMedia(result.roomId, [
        result.message.eventId,
        ...result.before.map(message => message.eventId),
        ...result.after.map(message => message.eventId),
    ]);
    let messageId = messageSyntheticId(result.message.eventId, result.message.timestamp);
    for (const projection of projections) {
        if (!useIsolatedContext) {
            injectRoomTimeline(roomWithContext, latestSnapshot, projection.channelId, {
                ...projection,
                isolatedContext: undefined,
                contextTargetMessageId: undefined,
            }, projection.guildId);
            messageId = roomsByChannel.get(projection.channelId)?.messageIds.get(result.message.eventId) ?? messageId;
            continue;
        }
        const next = updateProjectionRoom(projection, roomWithContext);
        next.isolatedContext = true;
        messageId = next.messageIds.get(result.message.eventId) ?? messageId;
        next.contextTargetMessageId = messageId;
        loadProjectionMessages(next, contextMessages, {
            jump: messageId,
            hasMoreBefore: false,
            hasMoreAfter: false,
        });
    }
    const target = roomProjection(result.roomId);
    if (!target || !navigateToProjection(target)) return false;
    prepareRoomMedia(roomWithContext);
    setTimeout(() => MessageActions.jumpToMessage({
        channelId: target.channelId,
        messageId,
        flash: true,
        jumpType: "INSTANT",
    }));
    return true;
}

function eligibleSyntheticUser(spaceId: string, matrixUserId: string) {
    for (const [syntheticUserId, candidateUserId] of matrixUserIdsBySyntheticId) {
        if (candidateUserId === matrixUserId && spaceIdsBySyntheticUserId.get(syntheticUserId)?.has(spaceId)) {
            return syntheticUserId;
        }
    }
    return undefined;
}

export async function openMatrixDirect(spaceId: string, userId: string) {
    const generation = pollGeneration;
    if (!bridgeActive) return false;
    const space = latestSnapshot?.rooms?.find(room => room.roomId === spaceId && isJoinedRoom(room) && isSpaceRoom(room));
    if (!space || !eligibleSyntheticUser(spaceId, userId)) return false;
    try {
        const result = await Native.openDirectMessage(spaceId, userId);
        if (!bridgeActive || generation !== pollGeneration || !result || typeof result.roomId !== "string") return false;
        if (openMatrixRoom(result.roomId)) return true;
        showToast(
            result.created ? "Matrix DM created. Waiting for it to sync..." : "Waiting for the Matrix DM to sync...",
            Toasts.Type.MESSAGE
        );
        for (let attempt = 0; attempt < 40 && generation === pollGeneration; attempt++) {
            try {
                await refreshSnapshot(generation);
                if (!bridgeActive || generation !== pollGeneration) return false;
            } catch {
                if (!bridgeActive || generation !== pollGeneration) return false;
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            if (openMatrixRoom(result.roomId)) {
                showToast("Matrix DM is ready.", Toasts.Type.SUCCESS);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!bridgeActive || generation !== pollGeneration) return false;
        showToast(
            result.created
                ? "The Matrix DM was created but has not appeared in sync yet."
                : "The Matrix DM has not appeared in sync yet.",
            Toasts.Type.FAILURE
        );
        return false;
    } catch (error) {
        reportFailure("direct message", error);
        return false;
    }
}

export function hasMatrixRecipients(recipientIds: unknown) {
    return Array.isArray(recipientIds)
        && recipientIds.some(userId => typeof userId === "string" && matrixUserIdsBySyntheticId.has(userId));
}

export async function openMatrixPrivateChannel(options: any) {
    const recipientIds = Array.isArray(options?.recipientIds) ? options.recipientIds : [];
    const syntheticRecipients = recipientIds.filter((userId: unknown): userId is string =>
        typeof userId === "string" && matrixUserIdsBySyntheticId.has(userId));
    if (syntheticRecipients.length !== 1 || recipientIds.length !== 1) {
        showToast("Matrix group DM creation is not supported here.", Toasts.Type.FAILURE);
        return undefined;
    }

    const syntheticUserId = syntheticRecipients[0];
    const cachedChannelId = ChannelStore.getDMFromUserId(syntheticUserId);
    const cached = cachedChannelId ? roomsByChannel.get(cachedChannelId) : undefined;
    if (cached) {
        options?.onBeforeTransition?.();
        navigateToProjection(cached);
        return cached.channelId;
    }

    const userId = matrixUserIdsBySyntheticId.get(syntheticUserId)!;
    const eligibleSpaces = spaceIdsBySyntheticUserId.get(syntheticUserId);
    const selectedGuildId = SelectedGuildStore.getGuildId();
    const selectedSpaceId = selectedGuildId ? spaceIdsByGuildId.get(selectedGuildId) : undefined;
    const spaceId = selectedSpaceId && eligibleSpaces?.has(selectedSpaceId)
        ? selectedSpaceId
        : eligibleSpaces?.values().next().value;
    if (!spaceId || !await openMatrixDirect(spaceId, userId)) return undefined;
    options?.onBeforeTransition?.();
    return getActiveChannelId();
}

function injectedMessage(channelId: string, messageId: string) {
    const injected = roomsByChannel.get(channelId);
    const target = injected?.messageTargets.get(messageId);
    const eventId = target?.actionEventId;
    return injected && target && eventId
        ? { injected, eventId, target }
        : undefined;
}

function validRemoteEventId(eventId: string | undefined): eventId is string {
    return Boolean(eventId?.startsWith("$") && eventId.length <= 2_048 && !/\s/u.test(eventId));
}

function replyEventId(injected: InjectedRoom, replyMessageId: string | undefined) {
    if (!replyMessageId) return undefined;
    const target = injected.messageTargets.get(replyMessageId);
    if (!target) {
        showToast("That Matrix reply target is no longer available.", Toasts.Type.FAILURE);
        return null;
    }
    if (target.blocked) {
        showToast(
            target.missingAnchor
                ? "Load the first attachment in this Matrix group before replying to it."
                : "Wait for the Matrix message to finish sending before replying to it.",
            Toasts.Type.FAILURE
        );
        return null;
    }
    return validRemoteEventId(target.actionEventId) ? target.actionEventId : null;
}

function reportFailure(action: string, error: unknown) {
    logger.error(`${action} failed`, error);
    showToast(`Matrix: ${action} failed`, Toasts.Type.FAILURE);
}

export async function sendMatrixMessage(channelId: string, body: string, replyMessageId?: string) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return false;
    const targetReplyEventId = replyEventId(injected, replyMessageId);
    if (targetReplyEventId === null) return false;
    try {
        await Native.sendText(injected.room.roomId, body, targetReplyEventId);
        return true;
    } catch (error) {
        reportFailure("send", error);
        return false;
    }
}

export async function sendMatrixSticker(
    channelId: string,
    sticker: MatrixStickerDescriptor,
    replyMessageId?: string
) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return false;
    const targetReplyEventId = replyEventId(injected, replyMessageId);
    if (targetReplyEventId === null) return false;
    try {
        await Native.sendSticker(injected.room.roomId, { ...sticker, replyEventId: targetReplyEventId });
        return true;
    } catch (error) {
        reportFailure("sticker send", error);
        return false;
    }
}

export async function sendMatrixAttachment(
    channelId: string,
    attachment: MatrixAttachmentDescriptor,
    replyMessageId?: string
) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return false;
    const targetReplyEventId = replyEventId(injected, replyMessageId);
    if (targetReplyEventId === null) return false;
    try {
        await Native.sendAttachment(injected.room.roomId, { ...attachment, replyEventId: targetReplyEventId });
        return true;
    } catch (error) {
        reportFailure("attachment send", error);
        return false;
    }
}

export async function editMatrixMessage(channelId: string, messageId: string, body: string) {
    const target = injectedMessage(channelId, messageId);
    if (!target) return false;
    if (target.target.blocked) {
        showToast(
            target.target.missingAnchor
                ? "Load the first attachment in this Matrix group before editing it."
                : "Wait for the Matrix message to finish sending before editing it.",
            Toasts.Type.FAILURE
        );
        return false;
    }
    if (target.target.hasAttachments) {
        showToast("Matrix attachment captions cannot be edited yet.", Toasts.Type.FAILURE);
        return false;
    }
    if (!validRemoteEventId(target.target.editEventId)) return false;
    try {
        await Native.edit(target.injected.room.roomId, target.target.editEventId, body);
        return true;
    } catch (error) {
        reportFailure("edit", error);
        return false;
    }
}

export async function deleteMatrixMessage(channelId: string, messageId: string) {
    const injected = roomsByChannel.get(channelId);
    const target = injected?.messageTargets.get(messageId);
    if (!injected || !target) return;
    const localPrefix = `~${injected.room.roomId}:`;
    let completed = 0;
    let lastError: unknown;
    // Work newest-to-oldest so the index-zero anchor remains stable until the
    // final operation. Matrix redactions are non-atomic; authoritative deltas
    // shrink the row after each successful member mutation.
    for (const eventId of [...target.eventIds].reverse()) {
        try {
            if (eventId.startsWith(localPrefix)) {
                const transactionId = eventId.slice(localPrefix.length);
                if (!transactionId
                    || transactionId.length > 128
                    || !/^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
                    throw new Error("Invalid local Matrix transaction identity.");
                }
                await Native.cancelPending(injected.room.roomId, transactionId);
            } else if (validRemoteEventId(eventId)) {
                await Native.redact(injected.room.roomId, eventId);
            } else {
                throw new Error("Invalid Matrix event identity.");
            }
            completed++;
        } catch (error) {
            lastError = error;
        }
    }
    if (completed !== target.eventIds.length) {
        logger.error("Matrix delete partially failed", lastError);
        showToast(
            completed
                ? `Matrix deleted ${completed} of ${target.eventIds.length} grouped items.`
                : "Matrix: delete failed",
            Toasts.Type.FAILURE
        );
    }
}

function emojiKey(emoji: any) {
    return typeof emoji === "string" ? emoji : emoji?.name ?? emoji?.id ?? "";
}

export async function addMatrixReaction(channelId: string, messageId: string, emoji: any) {
    const target = injectedMessage(channelId, messageId);
    if (!target) return;
    if (target.target.blocked) {
        showToast(
            target.target.missingAnchor
                ? "Load the first attachment in this Matrix group before reacting to it."
                : "Wait for the Matrix message to finish sending before reacting to it.",
            Toasts.Type.FAILURE
        );
        return;
    }
    if (!validRemoteEventId(target.eventId)) return;
    try {
        await Native.react(target.injected.room.roomId, target.eventId, emojiKey(emoji), false);
    } catch (error) {
        reportFailure("reaction", error);
    }
}

export async function removeMatrixReaction(channelId: string, messageId: string, emoji: any) {
    const target = injectedMessage(channelId, messageId);
    if (!target) return;
    if (target.target.blocked) {
        showToast(
            target.target.missingAnchor
                ? "Load the first attachment in this Matrix group before changing its reactions."
                : "Wait for the Matrix message to finish sending before changing its reactions.",
            Toasts.Type.FAILURE
        );
        return;
    }
    if (!validRemoteEventId(target.eventId)) return;
    try {
        await Native.react(target.injected.room.roomId, target.eventId, emojiKey(emoji), true);
    } catch (error) {
        reportFailure("reaction removal", error);
    }
}

export async function matrixTyping(channelId: string, typing: boolean) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return;
    const now = Date.now();
    if (typing && now - (lastOutgoingTyping.get(channelId) ?? 0) < 5_000) return;
    if (typing) lastOutgoingTyping.set(channelId, now);
    else lastOutgoingTyping.delete(channelId);
    try {
        await Native.typing(injected.room.roomId, typing, typing ? 15_000 : undefined);
    } catch (error) {
        logger.warn("Typing update failed", error);
    }
}

async function flushMatrixReceipt(roomId: string) {
    const pending = pendingReceiptsByRoom.get(roomId);
    if (!pending) return;
    pendingReceiptsByRoom.delete(roomId);
    clearTimeout(pending.timer);
    const position = receiptPosition(roomId, pending.eventId);
    if (!position) return;
    const previousEventId = lastReceiptEventByRoom.get(roomId);
    const previousPosition = previousEventId ? receiptPosition(roomId, previousEventId) : undefined;
    if (previousEventId === pending.eventId
        || previousPosition && position.index <= previousPosition.index) return;
    try {
        await Native.read(roomId, pending.eventId);
        lastReceiptEventByRoom.set(roomId, pending.eventId);
        // A search/history jump may acknowledge an older event. Never erase the
        // room's unread badges unless this receipt still targets the newest
        // visible remote message after the async homeserver call completes.
        const currentPosition = receiptPosition(roomId, pending.eventId);
        if (!currentPosition || currentPosition.index !== currentPosition.latestIndex) return;
        let changed = false;
        for (const injected of roomsByChannel.values()) {
            if (injected.room.roomId !== roomId) continue;
            const current = matrixUnreadByChannel.get(injected.channelId);
            if (!current || current.unreadCount === 0 && current.highlightCount === 0) continue;
            matrixUnreadByChannel.set(injected.channelId, {
                ...current,
                unreadCount: 0,
                highlightCount: 0,
            });
            injected.room = { ...injected.room, unreadCount: 0, highlightCount: 0 };
            changed = true;
        }
        const room = snapshotRoom(roomId);
        if (room) updateLatestSnapshotRoom({ ...room, unreadCount: 0, highlightCount: 0 });
        if (changed) {
            matrixUnreadRevision++;
            (ReadStateStore as any).emitChange?.();
        }
    } catch (error) {
        logger.warn("Read receipt failed", error);
    }
}

function receiptPosition(roomId: string, eventId: string): { index: number; latestIndex: number; } | undefined {
    const messages = roomHistoryById.get(roomId)?.messages;
    if (!messages) return undefined;
    const index = messages.findIndex(message => message.eventId === eventId);
    if (index < 0) return undefined;
    for (let latestIndex = messages.length - 1; latestIndex >= 0; latestIndex--) {
        if (messages[latestIndex].eventId.startsWith("$")) return { index, latestIndex };
    }
    return undefined;
}

export async function matrixReceipt(channelId: string, messageId: string) {
    const injected = roomsByChannel.get(channelId);
    const target = injected?.messageTargets.get(messageId);
    if (!injected || !target) return;
    const eventId = [...target.eventIds].reverse().find(validRemoteEventId);
    if (!eventId) return;
    const { roomId } = injected.room;
    const position = receiptPosition(roomId, eventId);
    if (!position) return;
    const lastEventId = lastReceiptEventByRoom.get(roomId);
    const lastPosition = lastEventId ? receiptPosition(roomId, lastEventId) : undefined;
    if (lastEventId === eventId || lastPosition && position.index <= lastPosition.index) return;
    const previous = pendingReceiptsByRoom.get(roomId);
    if (previous) {
        const previousPosition = receiptPosition(roomId, previous.eventId);
        if (previousPosition && position.index <= previousPosition.index) return;
        clearTimeout(previous.timer);
    }
    pendingReceiptsByRoom.set(roomId, {
        eventId,
        timer: setTimeout(() => void flushMatrixReceipt(roomId), 750),
    });
}

function requestedJumpMessageId(request: any): string | null | undefined {
    const jump = request?.jump;
    const candidate = typeof request?.messageId === "string"
        ? request.messageId
        : typeof jump === "string"
            ? jump
            : typeof jump?.messageId === "string"
                ? jump.messageId
                : typeof jump?.message_id === "string"
                    ? jump.message_id
                    : undefined;
    if (candidate === undefined) return undefined;
    return /^\d{15,22}$/u.test(candidate) ? candidate : null;
}

function localMessageContext(injected: InjectedRoom, eventId: string): MatrixMessageContextDTO | undefined {
    const projectedMessages = roomMessages(injected.room);
    const historyMessages = roomHistoryById.get(injected.room.roomId)?.messages ?? [];
    const messages = projectedMessages.some(message => message.eventId === eventId)
        ? projectedMessages
        : historyMessages;
    const targetIndex = messages.findIndex(message => message.eventId === eventId);
    if (targetIndex < 0) return undefined;
    return {
        roomId: injected.room.roomId,
        message: messages[targetIndex],
        before: messages.slice(Math.max(0, targetIndex - 2), targetIndex),
        after: messages.slice(targetIndex + 1, targetIndex + 3),
        isolated: true,
    } as MatrixMessageContextDTO;
}

function loadMatrixMessageContext(
    channelId: string,
    requestedMessageId: string,
    context: MatrixMessageContextDTO
) {
    const injected = roomsByChannel.get(channelId);
    if (!injected || !latestSnapshot || context.roomId !== injected.room.roomId
        || context.message.roomId !== injected.room.roomId) return false;

    const contextMessages = [...context.before, context.message, ...context.after] as MatrixMessageDto[];
    const room = snapshotRoom(injected.room.roomId) ?? injected.room;
    const roomWithContext = projectedRoom(room, contextMessages);
    const targetMessageId = messageSyntheticId(context.message.eventId, context.message.timestamp, true);
    // The reserved snowflake is the capability binding between the native
    // Discord reply row and this exact Matrix event. Never substitute another
    // ID returned through a generic fetch request.
    if (targetMessageId !== requestedMessageId) return false;

    const next = updateProjectionRoom(injected, roomWithContext);
    const projectedTarget = next.projectedMessagesByEventId.get(context.message.eventId);
    if (!projectedTarget) return false;
    next.isolatedContext = true;
    next.contextTargetMessageId = projectedTarget.messageId;
    loadProjectionMessages(next, contextMessages, {
        jump: projectedTarget.messageId,
        hasMoreBefore: false,
        hasMoreAfter: false,
    });
    focusRoomMedia(injected.room.roomId, contextMessages.map(message => message.eventId));
    return true;
}

async function fetchMatrixMessageContext(channelId: string, requestedMessageId: string) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return;
    const { roomId } = injected.room;
    const mappedTarget = injected.messageTargets.get(requestedMessageId);
    const reservedTarget = reservedReplyTargets.get(`${channelId}\0${requestedMessageId}`);
    if (reservedTarget && reservedTarget.roomId !== roomId) return;
    if (mappedTarget && reservedTarget && !mappedTarget.eventIds.includes(reservedTarget.eventId)) return;
    const eventId = reservedTarget?.eventId ?? mappedTarget?.actionEventId;
    if (!eventId?.startsWith("$") || eventId.length > 2_048 || /\s/u.test(eventId)) return;

    const generation = pollGeneration;
    try {
        const context = localMessageContext(injected, eventId)
            ?? await Native.messageContext(roomId, eventId) as MatrixMessageContextDTO;
        if (generation !== pollGeneration) return;
        const current = roomsByChannel.get(channelId);
        if (!current || current.room.roomId !== roomId) return;
        if (!loadMatrixMessageContext(channelId, requestedMessageId, context)) {
            throw new Error("The Matrix reply target no longer matches this channel.");
        }
    } catch (error) {
        if (generation === pollGeneration && roomsByChannel.get(channelId)?.room.roomId === roomId) {
            reportFailure("message jump", error);
        }
    }
}

export async function fetchMatrixMessages(channelId: string, request: any) {
    const injected = roomsByChannel.get(channelId);
    if (!injected) return;
    const requestedMessageId = requestedJumpMessageId(request);
    if (requestedMessageId !== undefined) {
        // A malformed or unknown ID is intentionally swallowed: synthetic
        // Matrix channels must never fall through to Discord's REST fetch.
        if (!requestedMessageId) return;
        if (MessageStore.getMessage(channelId, requestedMessageId)) {
            const requestJump = request?.jump;
            FluxDispatcher.dispatch({
                type: "LOAD_MESSAGES_SUCCESS_CACHED",
                channelId,
                jump: requestJump && typeof requestJump === "object"
                    ? { ...requestJump, messageId: requestedMessageId }
                    : {
                        messageId: requestedMessageId,
                        flash: request?.flash,
                        offset: request?.offset,
                        returnMessageId: request?.returnMessageId,
                        jumpType: request?.jumpType,
                        onJumpComplete: request?.onJumpComplete,
                    },
            });
            return;
        }
        await fetchMatrixMessageContext(channelId, requestedMessageId);
        return;
    }
    const { roomId } = injected.room;
    const history = roomHistoryById.get(roomId);
    if (history?.end) return;
    const generation = pollGeneration;
    if (paginationRequestsByRoom.has(roomId)) return;
    paginationRequestsByRoom.set(roomId, generation);
    let discardedHistoryLoad = false;
    const requestedBeforeEventId = request?.before ? injected.eventIds.get(request.before) : undefined;
    const oldestRemoteEventId = history?.messages.find(message => message.eventId.startsWith("$"))?.eventId;
    const limit = request?.limit ?? 50;
    const currentTimelineGeneration = () => {
        const currentHistory = roomHistoryById.get(roomId);
        const currentRoom = snapshotRoom(roomId);
        if (!currentHistory || !currentRoom) return undefined;
        const snapshotGeneration = currentRoom.timelineGeneration ?? 0;
        return currentHistory.timelineGeneration === snapshotGeneration
            ? snapshotGeneration
            : undefined;
    };
    const paginateCurrentGeneration = async (
        fromEventId?: string,
        cursor?: string
    ): Promise<MatrixHistoryPageDTO | undefined> => {
        const requestedGeneration = currentTimelineGeneration();
        if (requestedGeneration == null) {
            discardedHistoryLoad = true;
            return undefined;
        }
        const page = await Native.paginate(roomId, limit, fromEventId, cursor) as MatrixHistoryPageDTO;
        // A TimelineReset can arrive while IPC or /messages is in flight. The
        // page is valid only for the exact renderer cut that requested it and
        // the exact room cut still current after it returns. A later snapshot
        // clears the old cursor; never splice this detached page into it.
        if (page.timelineGeneration !== requestedGeneration
            || currentTimelineGeneration() !== requestedGeneration) {
            discardedHistoryLoad = true;
            return undefined;
        }
        return page;
    };
    try {
        let page: MatrixHistoryPageDTO;
        let resetHistory = false;
        let previousMessagesForReset: MatrixMessageDto[] = [];
        let resetHistoryCut: RoomHistoryState | undefined;
        const completedRemoteEchoEventIds = new Set<string>();
        const resetRemoteHistory = () => {
            const current = roomHistoryById.get(roomId);
            if (!current) return false;
            // Clearing the unusable cursor also creates an identity cut. If a
            // local echo, remote delta, or snapshot replaces this state while
            // the fresh page is in flight, that newer canonical state wins and
            // the detached reset page is discarded below.
            resetHistoryCut = { ...current, beforeCursor: undefined };
            roomHistoryById.set(roomId, resetHistoryCut);
            previousMessagesForReset = resetHistoryCut.messages;
            resetHistory = true;
            return true;
        };
        try {
            const initialPage = await paginateCurrentGeneration(requestedBeforeEventId, history?.beforeCursor);
            if (!initialPage) return;
            page = initialPage;
        } catch (error) {
            if (generation !== pollGeneration) return;
            if (matrixErrorCode(error) !== "MATRIX_STALE_CURSOR") throw error;
            if (history?.beforeCursor && oldestRemoteEventId) {
                const current = roomHistoryById.get(roomId);
                if (!current || current.beforeCursor !== history.beforeCursor) {
                    discardedHistoryLoad = true;
                    return;
                }
                roomHistoryById.set(roomId, { ...current, beforeCursor: undefined });
                try {
                    const anchoredPage = await paginateCurrentGeneration(oldestRemoteEventId);
                    if (!anchoredPage) return;
                    page = anchoredPage;
                } catch (retryError) {
                    if (generation !== pollGeneration) return;
                    if (matrixErrorCode(retryError) !== "MATRIX_STALE_CURSOR") throw retryError;
                    if (!resetRemoteHistory()) return;
                    const resetPage = await paginateCurrentGeneration();
                    if (!resetPage) return;
                    page = resetPage;
                }
            } else {
                // The SDK can replace a live timeline independently of our
                // retained renderer window. If its old anchor is gone, recover
                // from the new live timeline instead of retrying that anchor on
                // every scroll forever.
                if (!resetRemoteHistory()) return;
                const resetPage = await paginateCurrentGeneration();
                if (!resetPage) return;
                page = resetPage;
            }
        }
        if (generation !== pollGeneration || ![...roomsByChannel.values()].some(candidate => candidate.room.roomId === roomId)) return;
        // Recheck at the actual commit point. The helper validated after its
        // native await, but another queued room reset can run before this
        // continuation resumes. Never merge a page across that boundary.
        if (currentTimelineGeneration() !== page.timelineGeneration) {
            discardedHistoryLoad = true;
            return;
        }
        if (resetHistory) {
            if (roomHistoryById.get(roomId) !== resetHistoryCut) {
                discardedHistoryLoad = true;
                return;
            }
            roomHistoryById.delete(roomId);
            mediaFocusEventIdsByRoom.delete(roomId);
        }
        const pageMessages = page.messages as MatrixMessageDto[];
        const nextHistory = mergeRoomHistory(roomId, resetHistory
            ? insertAnchoredLocalMessages(
                pageMessages,
                previousMessagesForReset,
                completedRemoteEchoEventIds
            )
            : pageMessages, {
            beforeCursor: page.beforeCursor,
            end: page.end || !page.progressed,
            placement: resetHistory ? "after" : "before",
            timelineGeneration: page.timelineGeneration,
        });
        const retainedIds = new Set(nextHistory.messages.map(message => message.eventId));
        const retainedPage = (page.messages as MatrixMessageDto[]).filter(message => retainedIds.has(message.eventId));
        if (!retainedPage.length && page.messages.length) {
            nextHistory.end = true;
            nextHistory.capped = true;
        }
        const room = snapshotRoom(roomId) ?? injected.room;
        const roomWithPage = projectedRoom(room, nextHistory.messages);
        const pageIds = retainedPage.map(message => message.eventId);
        focusRoomMedia(roomId, pageIds);
        for (const projection of [...roomsByChannel.values()].filter(candidate =>
            candidate.room.roomId === roomId)) {
            if (resetHistory && latestSnapshot) {
                injectRoomTimeline(roomWithPage, latestSnapshot, projection.channelId, {
                    ...projection,
                    isolatedContext: undefined,
                    contextTargetMessageId: undefined,
                }, projection.guildId);
                continue;
            }
            const prospectiveMessages = projectedTimelineMessages(roomMessages(roomWithPage), projection);
            const prospectiveIds = new Map<string, string>();
            for (const projected of prospectiveMessages) {
                for (const eventId of projected.target.eventIds) {
                    prospectiveIds.set(eventId, projected.messageId);
                }
            }
            const aliasesChanged = [...projection.messageIds].some(([eventId, previousMessageId]) => {
                const nextMessageId = prospectiveIds.get(eventId);
                return nextMessageId != null && nextMessageId !== previousMessageId;
            });
            if (aliasesChanged && latestSnapshot) {
                // Forming/dissolving a group changes the message_reference ID
                // of every row replying to any member, not only this history
                // page. Reinject the bounded window so those previews/jumps
                // cannot retain a deleted suffix ID.
                injectRoomTimeline(roomWithPage, latestSnapshot, projection.channelId, projection, projection.guildId);
                continue;
            }
            const next = updateProjectionRoom(projection, roomWithPage);
            // Even an advancing page can normalize to zero visible messages
            // (state events, redactions, unsupported event types). Completing
            // the empty load clears Discord's fetch spinner and publishes the
            // updated hasMoreBefore/cursor state.
            loadProjectionMessages(next, retainedPage, { isBefore: true });
        }
        if (completedRemoteEchoEventIds.size) {
            completeProjectedEchoRows(new Map([[roomId, completedRemoteEchoEventIds]]));
        }
    } catch (error) {
        if (generation === pollGeneration) reportFailure("history load", error);
    } finally {
        if (paginationRequestsByRoom.get(roomId) === generation) paginationRequestsByRoom.delete(roomId);
        if (discardedHistoryLoad && generation === pollGeneration) {
            // A live delta or timeline reset won the race. Complete Discord's
            // pending history request against that newer state without merging
            // the detached page, otherwise its scroll loader can remain stuck.
            for (const projection of [...roomsByChannel.values()].filter(candidate =>
                candidate.room.roomId === roomId && !candidate.isolatedContext)) {
                loadProjectionMessages(projection, [], { isBefore: true });
            }
        }
    }
}

export function showMatrixSecureView(
    route: MatrixSecureViewRoute,
    bounds: MatrixSecureViewBounds
): Promise<MatrixSecureViewControlState> {
    return queueSecureViewControl(() => Native.secureViewShow({ route, bounds })) as Promise<MatrixSecureViewControlState>;
}

export function setMatrixSecureViewRoute(route: MatrixSecureViewRoute) {
    return queueSecureViewControl(() => Native.secureViewSetRoute(route));
}

export function updateMatrixSecureViewBounds(bounds: MatrixSecureViewBounds) {
    return queueSecureViewControl(() => Native.secureViewUpdateBounds(bounds));
}

export function hideMatrixSecureView() {
    return queueSecureViewControl(() => Native.secureViewHide());
}

export function focusMatrixSecureView() {
    return queueSecureViewControl(() => Native.secureViewFocus());
}

export function disposeMatrixSecureView() {
    return queueSecureViewControl(() => Native.secureViewDispose());
}

function queueSecureViewControl<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = secureViewControlTail.then(operation, operation);
    secureViewControlTail = result.then(() => undefined, () => undefined);
    return result;
}

export function openMatrixSecureSearch(channelId = getActiveChannelId()) {
    const route = getMatrixSecureRoute(channelId);
    if (!route) return false;
    void queueSecureViewControl(async () => {
        await Native.secureViewSetRoute(route);
        await Native.secureViewCommand({ type: "openSearch" });
        return await Native.secureViewFocus();
    })
        .catch(error => logger.warn("Matrix secure search failed", error));
    return true;
}

export { Native };
