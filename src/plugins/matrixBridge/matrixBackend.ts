/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    ClientEvent,
    createClient,
    Direction,
    EventStatus,
    EventType,
    GuestAccess,
    HistoryVisibility,
    IndexedDBStore,
    JoinRule,
    type MatrixClient,
    type MatrixEvent,
    MatrixEventEvent,
    MsgType,
    NotificationCountType,
    Preset,
    RelationType,
    RestrictedAllowType,
    type Room,
    RoomEvent,
    RoomMemberEvent,
    RoomType,
    SyncState,
    Visibility
} from "matrix-js-sdk";

import { isDefinitiveCreateRoomRejection } from "./createSpaceChildError";
import { matrixServerUnavailableHttpStatus } from "./errorCode";
import {
    createMatrixLiveDecryptionTracker,
    isCurrentMatrixTimelineGeneration,
    isMainMatrixTimelineReset
} from "./historyTimeline";
import {
    introducedMatrixMentionUserIds,
    materializeOutboundMatrixMentions,
    MAX_MATRIX_MESSAGE_MENTIONS
} from "./messageMentions";
import { searchMatrixSpaceGraph } from "./spaceSearchGraph";
import type {
    MatrixActionResult,
    MatrixAttachmentDTO,
    MatrixAttachmentGroupDTO,
    MatrixAttachmentSendRequest,
    MatrixAttachmentSendResult,
    MatrixBridgeError,
    MatrixBridgeState,
    MatrixBridgeStatus,
    MatrixConfigureSpaceAccessRequest,
    MatrixConfigureSpaceAccessResult,
    MatrixConfigureSpaceAccessStep,
    MatrixCreateGroupChatRequest,
    MatrixCreateGroupChatResult,
    MatrixCreateSpaceChildRequest,
    MatrixCreateSpaceChildResult,
    MatrixCreateSpacePartialResult,
    MatrixCreateSpaceRequest,
    MatrixCreateSpaceResult,
    MatrixDirectMessageResult,
    MatrixGroupChatCandidateDTO,
    MatrixGroupChatCandidateMembership,
    MatrixGroupChatCandidateSearchRequest,
    MatrixGroupChatCandidateSearchResult,
    MatrixGroupChatInvitationDTO,
    MatrixGroupChatInviteCandidateSearchRequest,
    MatrixGroupChatInviteCandidateSearchResult,
    MatrixHistoryPageDTO,
    MatrixInviteUserToGroupChatRequest,
    MatrixInviteUserToGroupChatResult,
    MatrixInviteUserToSpaceRequest,
    MatrixInviteUserToSpaceResult,
    MatrixJoinRoomResult,
    MatrixJoinSuggestedSpaceChannelsRequest,
    MatrixJoinSuggestedSpaceChannelsResult,
    MatrixMediaDownloadResult,
    MatrixMemberDTO,
    MatrixMessageContextDTO,
    MatrixMessageDTO,
    MatrixMessageSearchCoverage,
    MatrixMessageSearchRequest,
    MatrixMessageSearchResponse,
    MatrixMessageSearchResultDTO,
    MatrixPowerLevelPermissionDTO,
    MatrixPublicRoomDirectoryDTO,
    MatrixPublicRoomDTO,
    MatrixReactionDTO,
    MatrixReauthenticationRequest,
    MatrixReconcileGroupChatCreateResult,
    MatrixReconcileGroupChatInviteResult,
    MatrixReconcileSpaceChildCreateResult,
    MatrixRequestSpaceAccessResult,
    MatrixResolveSpaceAccessRequest,
    MatrixResolveSpaceAccessRequestResult,
    MatrixRoomActionResult,
    MatrixRoomDTO,
    MatrixRoomJoinRule,
    MatrixRoomKind,
    MatrixSnapshot,
    MatrixSpaceAccessRequestListDTO,
    MatrixSpaceAccessRequestMemberDTO,
    MatrixSpaceAccessSummaryDTO,
    MatrixSpaceChildDTO,
    MatrixSpaceHierarchyDTO,
    MatrixSpaceHierarchyRoomDTO,
    MatrixSpaceInviteCandidateDTO,
    MatrixSpaceInviteCandidateSearchRequest,
    MatrixSpaceInviteCandidateSearchResult,
    MatrixStickerSendRequest,
    MatrixStickerSendResult,
    MatrixSuggestedSpaceChannelDTO,
    MatrixSuggestedSpaceChannelPlanDTO,
    MatrixUrlPreviewDTO,
    MatrixUrlPreviewMediaDTO
} from "./types";
import type {
    MatrixCredentialUpdate,
    MatrixJoinedRoomIdsResult,
    MatrixSessionCredentials,
    MatrixStoredAccount,
    MatrixWorkerCommand,
    MatrixWorkerEvent,
    MatrixWorkerRequest,
    MatrixWorkerResult,
    MatrixWorkerStartupStage
} from "./workerProtocol";

const MAX_TIMELINE_MESSAGES = 100;
const MAX_SNAPSHOT_ROOMS = 250;
const MAX_ROOM_MEMBERS = 2_000;
const MAX_SPACE_ACCESS_REQUESTS = 200;
const DEFAULT_SPACE_INVITE_DIRECTORY_LIMIT = 25;
const MAX_SPACE_INVITE_DIRECTORY_LIMIT = 100;
const MAX_SPACE_INVITE_DIRECTORY_QUERY_LENGTH = 256;
const SPACE_INVITE_MEMBERSHIP_CONCURRENCY = 6;
const DEFAULT_GROUP_CHAT_DIRECTORY_LIMIT = 25;
const MAX_GROUP_CHAT_DIRECTORY_LIMIT = 100;
const MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH = 256;
const MIN_GROUP_CHAT_INVITEES = 0;
const MAX_GROUP_CHAT_INVITEES = 9;
const MAX_GROUP_CHAT_PARTICIPANTS = 10;
const GROUP_CHAT_INVITE_CONCURRENCY = 3;
const GROUP_CHAT_DIRECTORY_CANDIDATE_TTL_MS = 5 * 60_000;
const MAX_GROUP_CHAT_DIRECTORY_CANDIDATES = 1_000;
const GROUP_CHAT_EXACT_LOOKUP_WINDOW_MS = 60_000;
const MAX_GROUP_CHAT_EXACT_LOOKUPS_PER_WINDOW = 10;
const MAX_GROUP_CHAT_MEMBERSHIP_EVENTS = 1_000;
const BARE_MATRIX_LOCALPART_PATTERN = /^[a-z0-9._=\-/+]{1,255}$/u;
const SUGGESTED_SPACE_CHANNEL_HIERARCHY_LIMIT = 100;
const MAX_SUGGESTED_SPACE_CHANNEL_JOINS = 8;
const MAX_SUGGESTED_SPACE_CHANNEL_PLAN_ROWS = 16;
const MAX_RESOLVED_SPACE_ACCESS_REQUESTS = 1_000;
const MAX_SNAPSHOT_MESSAGES = 1_000;
const MAX_SNAPSHOT_MEMBERS = 2_000;
const MAX_SNAPSHOT_MESSAGE_JSON_CHARS = 2 * 1024 * 1024;
const MAX_MESSAGE_BODY_CHARS = 65_536;
const MAX_EVENT_TIMESTAMP = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z
const MAX_SEARCH_ROOMS = 200;
// Keep several locally decrypted result pages so encrypted-room searches can
// use the same opaque pagination UI as homeserver-backed searches.
const MAX_LOCAL_SEARCH_RESULTS = 125;
// A mixed search can hold an encrypted-room scan plus either a failure-fallback
// scan and 24 pending server hits, or one accepted 100-hit server response.
// Keep either bounded branch whole so advancing next_batch never discards a hit.
const MAX_SEARCH_RESULTS_BUFFER = 300;
const MAX_LOCAL_SEARCH_EVENTS = 10_000;
const MAX_LOCAL_SEARCH_EVENTS_PER_ROOM = 2_000;
const MAX_LOCAL_SEARCH_MS = 10_000;
const MAX_SERVER_SEARCH_BATCHES = 128;
const PUBLIC_DIRECTORY_PAGE_SIZE = 200;
const MAX_PUBLIC_DIRECTORY_ENTRIES = 2_000;
const MAX_PUBLIC_DIRECTORY_PAGES = 20;
const MAX_PUBLIC_DIRECTORY_CRAWL_MS = 45_000;
const MAX_SEARCH_CURSORS = 4;
const MAX_HISTORY_CURSORS = 128;
const MAX_SEARCH_EVENT_CACHE = 256;
const MAX_RAW_EVENT_JSON_CHARS = 128 * 1024;
const MAX_REACTION_TARGETS = 10_000;
const CURSOR_TTL_MS = 5 * 60_000;
const MAX_HISTORY_REQUESTS_PER_PAGE = 8;
const MIN_HISTORY_EVENTS_PER_REQUEST = 25;
const DEFAULT_TYPING_TIMEOUT = 30_000;
const MAX_MEDIA_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
const PREVIEW_VIDEO_DOWNLOAD_TIMEOUT_MS = 80_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 33_554_432;
const MAX_URL_PREVIEW_CACHE = 256;
const MAX_PROVIDER_PREVIEW_DOCUMENT_CHARS = 512 * 1024;
const KLIPY_MEDIA_HOSTS = new Set(["static.klipy.com", "static2.klipy.com"]);
const TENOR_MEDIA_HOSTS = new Set(["media.tenor.com", "media1.tenor.com"]);
const X_POSTER_HOST = "pbs.twimg.com";
// Discord documents a 512 KiB guild-upload limit. Leave bounded headroom for
// larger first-party/legacy assets without sharing the Matrix media limit.
const MAX_DISCORD_STICKER_BYTES = 2 * 1024 * 1024;
const DISCORD_STICKER_DOWNLOAD_TIMEOUT_MS = 15_000;
const MATRIX_STICKER_UPLOAD_TIMEOUT_MS = 45_000;
const MAX_ATTACHMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS = 80_000;
const ATTACHMENT_GROUP_CONTENT_KEY = "dev.vencord.matrix_bridge.attachment_group";
const ATTACHMENT_GROUP_ID_PATTERN = /^vcgrp_[0-9a-f]{64}$/u;
const SPACE_CHILD_CREATION_EVENT_TYPE = "dev.vencord.matrix_bridge.space_child_creation";
const SPACE_CHILD_CREATION_MARKER_PATTERN = /^vccreate_[0-9a-f]{64}$/u;
const GROUP_CHAT_CREATION_EVENT_TYPE = "dev.vencord.matrix_bridge.group_chat_creation";
const GROUP_CHAT_CREATION_CONTENT_KEY = "dev.vencord.matrix_bridge.group_chat_marker";
const GROUP_CHAT_CREATION_MARKER_PATTERN = /^vcgroup_[0-9a-f]{64}$/u;
const SPACE_JOIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SDK_STANDARD_ROOM_VERSIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
const SDK_STANDARD_ROOM_VERSIONS_NEWEST_FIRST = [...SDK_STANDARD_ROOM_VERSIONS].reverse();
const RESTRICTED_ROOM_VERSIONS = new Set<string>(["8", "9", "10", "11", "12"]);

class PublicWorkerError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = "PublicWorkerError";
    }
}

const silentLogger = {
    trace() { },
    debug() { },
    info() { },
    warn() { },
    error() { },
    getChild() { return silentLogger; }
};

function startupProgressLogger(progress: (stage: MatrixWorkerStartupStage) => void) {
    const logger = {
        trace(..._messages: unknown[]) { },
        debug(...messages: unknown[]) {
            if (messages.length !== 1 || typeof messages[0] !== "string") return;
            switch (messages[0]) {
                case "Initialising Rust crypto-sdk WASM artifact":
                    progress("crypto-wasm");
                    break;
                case "Opening Rust CryptoStore":
                    progress("crypto-store");
                    break;
                case "Init OlmMachine":
                    progress("crypto-machine");
                    break;
            }
        },
        info(..._messages: unknown[]) { },
        warn(..._messages: unknown[]) { },
        error(..._messages: unknown[]) { },
        getChild(_namespace: string) { return logger; }
    };
    return logger;
}

let matrixClient: MatrixClient | null = null;
let matrixStore: IndexedDBStore | null = null;
let activeCredentials: MatrixSessionCredentials | null = null;
let cryptoDatabasePrefix: string | null = null;
let workerState: MatrixBridgeState = "logged_out";
let workerError: MatrixBridgeError | undefined;
let lastSyncState: SyncState | null = null;
let clientGeneration = 0;
let schedulerGeneration = 0;
let publicDirectoryRefreshGeneration = 0;

interface HistoryCursorState {
    generation: number;
    expiresAt: number;
    roomId: string;
    /**
     * When present, page the SDK's already-loaded live timeline strictly before
     * this event before touching the homeserver pagination token. This prevents
     * a bounded snapshot from skipping the older part of the initial sync.
     */
    anchorEventId?: string;
    token: string | null;
}

interface SearchCursorState {
    generation: number;
    expiresAt: number;
    fingerprint: string;
    roomIds: string[];
    serverRoomIds: string[];
    coverage: MatrixMessageSearchCoverage;
    searchedRoomCount: number;
    incomplete: boolean;
    serverExhausted: boolean;
    serverResultSeen: boolean;
    nextBatch?: string;
    seenServerBatches: Set<string>;
    results: MatrixMessageSearchResultDTO[];
    seen: Set<string>;
}

interface CachedSearchEvent {
    generation: number;
    expiresAt: number;
    roomId: string;
    event: MatrixEvent;
}

const reactionTargets = new Map<string, { roomId: string; eventId: string; }>();
const publicDirectoryTargets = new Set<string>();
const spaceHierarchyTargets = new Map<string, Map<string, string[]>>();
const spaceHierarchyRelationTargets = new Map<string, Map<string, Map<string, string[]>>>();
const pendingHiddenRooms = new Set<string>();
const resolvedSpaceAccessRequests = new Map<string, { roomId: string; userId: string; }>();
interface SpaceAccessMemberLoad {
    client: MatrixClient;
    generation: number;
    userId: string;
    promise?: Promise<boolean>;
}
const spaceAccessMemberLoads = new Map<Room, SpaceAccessMemberLoad>();
interface CachedUrlPreview {
    sourceUrl: string;
    directProvider?: "klipy" | "tenor" | "x";
    imageMxc?: string;
    imageUrl?: string;
    videoMxc?: string;
    videoUrl?: string;
    preview: MatrixUrlPreviewDTO;
}

const urlPreviewMedia = new Map<string, CachedUrlPreview>();
const observedRooms = new WeakSet<Room>();
const timelineGenerations = new WeakMap<Room, number>();
const historyCursors = new Map<string, HistoryCursorState>();
const searchCursors = new Map<string, SearchCursorState>();
const searchEventCache = new Map<string, CachedSearchEvent>();
const groupChatDirectoryCandidates = new Map<string, number>();
const groupChatExactLookupTimestamps: number[] = [];
const reactionMapCache = new WeakMap<Room, Map<string, MatrixReactionDTO[]>>();
const isolatedDecryptionEvents = new WeakSet<MatrixEvent>();
const liveDecryptionEvents = createMatrixLiveDecryptionTracker<MatrixEvent>();
const activeMediaReadControllers = new Set<AbortController>();
const activeDirectPreviewControllers = new Set<AbortController>();
let directPreviewPolicyAllowed = true;

function resolvedSpaceAccessRequestKey(roomId: string, userId: string): string {
    return `${roomId}\0${userId}`;
}

function isResolvedSpaceAccessRequest(roomId: string, userId: string): boolean {
    return resolvedSpaceAccessRequests.has(resolvedSpaceAccessRequestKey(roomId, userId));
}

function reserveResolvedSpaceAccessRequest(roomId: string, userId: string): void {
    const key = resolvedSpaceAccessRequestKey(roomId, userId);
    if (resolvedSpaceAccessRequests.has(key)) {
        fail("MATRIX_SPACE_ACCESS_REQUEST_NOT_PENDING", "That Matrix Space access request is no longer pending.");
    }
    if (resolvedSpaceAccessRequests.size >= MAX_RESOLVED_SPACE_ACCESS_REQUESTS) {
        fail(
            "MATRIX_SPACE_ACCESS_RESOLUTION_BUSY",
            "Matrix is still confirming too many resolved Space access requests. Try again after the next sync."
        );
    }
    resolvedSpaceAccessRequests.set(key, { roomId, userId });
}

function forgetResolvedSpaceAccessRequest(roomId: string, userId: string): void {
    resolvedSpaceAccessRequests.delete(resolvedSpaceAccessRequestKey(roomId, userId));
}

function forgetResolvedSpaceAccessRequestsForRoom(roomId: string): void {
    for (const [key, request] of resolvedSpaceAccessRequests) {
        if (request.roomId === roomId) resolvedSpaceAccessRequests.delete(key);
    }
}

function trackMediaReadController(controller: AbortController): AbortController {
    activeMediaReadControllers.add(controller);
    return controller;
}

function trackDirectPreviewController(controller: AbortController): AbortController {
    activeDirectPreviewControllers.add(controller);
    return trackMediaReadController(controller);
}

function releaseDirectPreviewController(controller: AbortController): void {
    activeDirectPreviewControllers.delete(controller);
    activeMediaReadControllers.delete(controller);
}

function rememberReactionTarget(reactionEventId: string, roomId: string, eventId: string): void {
    reactionTargets.delete(reactionEventId);
    while (reactionTargets.size >= MAX_REACTION_TARGETS) {
        reactionTargets.delete(reactionTargets.keys().next().value!);
    }
    reactionTargets.set(reactionEventId, { roomId, eventId });
}

function clearReactionTargets(roomId: string): void {
    for (const [reactionEventId, target] of reactionTargets) {
        if (target.roomId === roomId) reactionTargets.delete(reactionEventId);
    }
}

function fail(code: string, message: string): never {
    throw new PublicWorkerError(code, message);
}

function unsupportedCommand(_command: never): never {
    fail("MATRIX_INVALID_COMMAND", "The Matrix backend received an unsupported command.");
}

function validateString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
        fail("MATRIX_INVALID_ARGUMENT", `${label} is invalid.`);
    }
    return value;
}

function opaqueCursor(prefix: "h" | "s"): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateOpaqueCursor(value: unknown, prefix: "h" | "s"): string {
    const cursor = validateString(value, "cursor", 40);
    if (!new RegExp(`^${prefix}_[0-9a-f]{32}$`, "u").test(cursor)) {
        fail("MATRIX_STALE_CURSOR", "The Matrix cursor is invalid or has expired.");
    }
    return cursor;
}

function pruneCursorMap<T extends { expiresAt: number; }>(map: Map<string, T>, maximum: number): void {
    const now = Date.now();
    for (const [cursor, state] of map) {
        if (state.expiresAt <= now) map.delete(cursor);
    }
    while (map.size >= maximum) map.delete(map.keys().next().value!);
}

function validateHomeserver(value: unknown): string {
    const input = validateString(value, "homeserver", 2_048);
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        fail("MATRIX_INVALID_ARGUMENT", "The homeserver URL is invalid.");
    }

    const loopbackHttp = url.protocol === "http:"
        && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (url.protocol !== "https:" && !loopbackHttp) {
        fail("MATRIX_INSECURE_HOMESERVER", "The homeserver must use HTTPS.");
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        fail("MATRIX_INVALID_ARGUMENT", "The homeserver must be an origin URL.");
    }
    return url.origin;
}

function validateUserId(value: unknown): string {
    const userId = validateString(value, "userId", 512);
    if (!userId.startsWith("@") || !userId.includes(":") || /\s/.test(userId)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix user ID is invalid.");
    }
    return userId;
}

function validateUsername(value: unknown): string {
    const username = validateString(value, "username", 255).trim();
    if (!username || /[\s@:]/.test(username)) {
        fail("MATRIX_INVALID_USERNAME", "Enter only the username, without @ or a server name.");
    }
    return username;
}

function validateRegistrationToken(value: unknown): string {
    const token = validateString(value, "registrationToken", 64);
    if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
        fail("MATRIX_INVALID_REGISTRATION_TOKEN", "The registration token has an invalid format.");
    }
    return token;
}

function validateRoomId(value: unknown): string {
    const roomId = validateString(value, "roomId", 1_024);
    if (!roomId.startsWith("!") || /\s/.test(roomId)) fail("MATRIX_INVALID_ARGUMENT", "The room ID is invalid.");
    return roomId;
}

function validateServerName(value: unknown): string {
    const serverName = validateString(value, "server name", 255);
    if (serverName.endsWith(":") || /[\s\u0000-\u001f\u007f/?#@]/u.test(serverName)) {
        fail("MATRIX_INVALID_ROOM_ADDRESS", "The Matrix room address has an invalid server name.");
    }
    try {
        const parsed = new URL(`https://${serverName}/`);
        if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    } catch {
        fail("MATRIX_INVALID_ROOM_ADDRESS", "The Matrix room address has an invalid server name.");
    }
    return serverName;
}

function validateRoomAddress(value: unknown): {
    address: string;
    kind: "alias" | "roomId";
    serverName?: string;
} {
    const address = validateString(value, "room address", 1_024);
    const sigil = address[0];
    const delimiter = address.indexOf(":", 1);
    if (sigil !== "#" && sigil !== "!") {
        fail("MATRIX_INVALID_ROOM_ADDRESS", "Enter a full Matrix room alias or room ID.");
    }
    if (delimiter < 0) {
        if (sigil !== "!" || address.length <= 1 || /[\s\u0000-\u001f\u007f:]/u.test(address.slice(1))) {
            fail("MATRIX_INVALID_ROOM_ADDRESS", "Enter a full Matrix room alias or room ID.");
        }
        // Room v12 IDs are opaque and deliberately have no server-name suffix.
        // They are still submitted only to this configured homeserver.
        return { address, kind: "roomId" };
    }
    if (delimiter <= 1 || /[\s\u0000-\u001f\u007f]/u.test(address.slice(1, delimiter))) {
        fail("MATRIX_INVALID_ROOM_ADDRESS", "Enter a full Matrix room alias or room ID.");
    }
    return {
        address,
        kind: sigil === "#" ? "alias" : "roomId",
        serverName: validateServerName(address.slice(delimiter + 1))
    };
}

function activeServerName(): string {
    if (!activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const userId = validateUserId(activeCredentials.userId);
    return validateServerName(userId.slice(userId.indexOf(":") + 1));
}

function validateEventId(value: unknown): string {
    const eventId = validateString(value, "eventId", 2_048);
    if (!eventId.startsWith("$") || /\s/.test(eventId)) fail("MATRIX_INVALID_ARGUMENT", "The event ID is invalid.");
    return eventId;
}

function validateTimelineEventId(value: unknown, roomId: string): string {
    try {
        return validateEventId(value);
    } catch {
        const eventId = validateString(value, "eventId", 2_048);
        const prefix = `~${roomId}:`;
        const transactionId = eventId.startsWith(prefix) ? eventId.slice(prefix.length) : "";
        if (!transactionId || transactionId.length > 128 || !/^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
            fail("MATRIX_INVALID_ARGUMENT", "The timeline event ID is invalid.");
        }
        return eventId;
    }
}

function validateStickerSendRequest(value: unknown): MatrixStickerSendRequest {
    if (!value || typeof value !== "object") fail("MATRIX_INVALID_STICKER", "The Discord sticker descriptor is invalid.");
    const input = value as Partial<MatrixStickerSendRequest>;
    if (typeof input.id !== "string" || !/^\d{17,20}$/u.test(input.id)) {
        fail("MATRIX_INVALID_STICKER", "The Discord sticker ID is invalid.");
    }
    if (!Number.isSafeInteger(input.formatType) || ![1, 2, 3, 4].includes(input.formatType!)) {
        fail("MATRIX_INVALID_STICKER", "The Discord sticker format is invalid.");
    }
    if (input.formatType === 3) fail("MATRIX_STICKER_LOTTIE_UNSUPPORTED", "Lottie stickers cannot be sent to Matrix yet.");
    const name = validateString(input.name, "sticker name", 100)
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (!name) fail("MATRIX_INVALID_STICKER", "The Discord sticker name is invalid.");
    const replyEventId = input.replyEventId == null ? undefined : validateEventId(input.replyEventId);
    return {
        id: input.id,
        name,
        formatType: input.formatType as MatrixStickerSendRequest["formatType"],
        ...(replyEventId ? { replyEventId } : {})
    };
}

function parsedAttachmentGroup(value: unknown): MatrixAttachmentGroupDTO | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Partial<MatrixAttachmentGroupDTO>;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.every(key => key === "id" || key === "index" || key === "total")
        || typeof input.id !== "string" || !ATTACHMENT_GROUP_ID_PATTERN.test(input.id)
        || !Number.isSafeInteger(input.total) || input.total! < 2 || input.total! > 10
        || !Number.isSafeInteger(input.index) || input.index! < 0 || input.index! >= input.total!) {
        return undefined;
    }
    return { id: input.id, index: input.index, total: input.total } as MatrixAttachmentGroupDTO;
}

function validateAttachmentGroup(value: unknown): MatrixAttachmentGroupDTO {
    const group = parsedAttachmentGroup(value);
    if (!group) fail("MATRIX_INVALID_ATTACHMENT", "The Matrix attachment group is invalid.");
    return group;
}

function validateAttachmentSendRequest(value: unknown): MatrixAttachmentSendRequest {
    if (!value || typeof value !== "object") {
        fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment upload is invalid.");
    }
    const input = value as Partial<MatrixAttachmentSendRequest>;
    const name = validateString(input.name, "attachment name", 255);
    if (/[\u0000-\u001f\u007f\\/]/u.test(name)) {
        fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment filename is invalid.");
    }
    const txnId = validateString(input.txnId, "attachment transaction ID", 128);
    if (!/^[A-Za-z0-9._~-]+$/u.test(txnId)) {
        fail("MATRIX_INVALID_ATTACHMENT", "The Matrix attachment transaction ID is invalid.");
    }
    if (!(input.bytes instanceof Uint8Array) || !(input.bytes.buffer instanceof ArrayBuffer)
        || input.bytes.byteLength < 1
        || input.bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
        fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment is empty or too large to upload.");
    }

    let declaredMimeType: string | undefined;
    if (input.declaredMimeType != null && input.declaredMimeType !== "") {
        declaredMimeType = normalizedMimeType(input.declaredMimeType);
        if (!declaredMimeType) fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment MIME type is invalid.");
    }
    const caption = input.caption == null || input.caption === ""
        ? undefined
        : validateString(input.caption, "attachment caption", 65_536);
    const dimensions = input.width == null && input.height == null
        ? undefined
        : safeImageDimensions(input.width, input.height);
    if ((input.width == null) !== (input.height == null) || (input.width != null && !dimensions)) {
        fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment dimensions are invalid.");
    }
    const durationMs = input.durationMs == null ? undefined : Number(input.durationMs);
    if (durationMs != null && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7 * 24 * 60 * 60_000)) {
        fail("MATRIX_INVALID_ATTACHMENT", "The Discord attachment duration is invalid.");
    }

    return {
        name,
        txnId,
        declaredMimeType,
        // Main-to-worker IPC already gave this isolated renderer its own clone.
        bytes: input.bytes as Uint8Array<ArrayBuffer>,
        caption,
        width: dimensions?.width,
        height: dimensions?.height,
        durationMs,
        replyEventId: input.replyEventId == null ? undefined : validateEventId(input.replyEventId),
        attachmentGroup: input.attachmentGroup == null
            ? undefined
            : validateAttachmentGroup(input.attachmentGroup)
    };
}

function validateCredentials(account: MatrixStoredAccount): MatrixStoredAccount {
    if (!account || account.schema !== 1) fail("MATRIX_ACCOUNT_CORRUPT", "The Matrix account record is invalid.");
    const validated: MatrixStoredAccount = {
        schema: 1,
        homeserver: validateHomeserver(account.homeserver),
        userId: validateUserId(account.userId),
        deviceId: validateString(account.deviceId, "deviceId", 512),
        accessToken: validateString(account.accessToken, "accessToken", 65_536),
        storageKey: validateString(account.storageKey, "storageKey", 128)
    };
    if (account.refreshToken != null) validated.refreshToken = validateString(account.refreshToken, "refreshToken", 65_536);
    decodeStorageKey(validated.storageKey);
    return validated;
}

function validateReauthentication(input: MatrixReauthenticationRequest): MatrixReauthenticationRequest {
    if (!input || typeof input !== "object") {
        fail("MATRIX_INVALID_ARGUMENT", "Matrix reauthentication details are required.");
    }
    const identity = {
        homeserver: validateHomeserver(input.homeserver),
        userId: validateUserId(input.userId),
        deviceId: validateString(input.deviceId, "deviceId", 512)
    };
    if (input.method === "password") {
        return {
            ...identity,
            method: "password",
            password: validateString(input.password, "password", 65_536)
        };
    }
    if (input.method === "access_token") {
        return {
            ...identity,
            method: "access_token",
            accessToken: validateString(input.accessToken, "accessToken", 65_536)
        };
    }
    fail("MATRIX_INVALID_ARGUMENT", "The Matrix reauthentication method is invalid.");
}

function publicError(error: unknown): MatrixBridgeError {
    if (error instanceof PublicWorkerError) return { code: error.code, message: error.message };

    const candidate = typeof error === "object" && error
        ? error as {
            errcode?: unknown;
            error?: unknown;
            data?: { error?: unknown; soft_logout?: unknown; };
            httpStatus?: unknown;
            message?: unknown;
            name?: unknown;
        }
        : undefined;
    const rawErrcode = candidate?.errcode == null ? "" : String(candidate.errcode);
    const errcode = /^[A-Z0-9._]{1,128}$/.test(rawErrcode) ? rawErrcode : "";
    const rawServerMessage = typeof candidate?.error === "string"
        ? candidate.error
        : typeof candidate?.data?.error === "string" ? candidate.data.error : "";
    const serverMessage = rawServerMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    const internalMessage = typeof candidate?.message === "string"
        ? candidate.message
            .replace(/syt_[A-Za-z0-9._~-]+/g, "[redacted token]")
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300)
        : "";
    const httpStatus = typeof candidate?.httpStatus === "number"
        && Number.isSafeInteger(candidate.httpStatus)
        && candidate.httpStatus >= 100 && candidate.httpStatus <= 599
        ? candidate.httpStatus
        : undefined;
    switch (errcode) {
        case "M_FORBIDDEN":
            return { code: errcode, message: serverMessage || "Matrix rejected the credentials or action." };
        case "M_UNKNOWN_TOKEN":
            return candidate?.data?.soft_logout === true
                ? {
                    code: "MATRIX_REAUTH_REQUIRED",
                    message: "The Matrix session expired, but its encrypted device can be reauthenticated."
                }
                : {
                    code: "MATRIX_SESSION_RESET_REQUIRED",
                    message: "The Matrix device session ended and must be disconnected before signing in again."
                };
        case "M_MISSING_TOKEN":
            return {
                code: "MATRIX_SESSION_RESET_REQUIRED",
                message: "The Matrix device session ended and must be disconnected before signing in again."
            };
        case "M_LIMIT_EXCEEDED":
            return { code: errcode, message: "The Matrix homeserver is rate limiting this client." };
        case "M_NOT_FOUND":
            return { code: errcode, message: "The requested Matrix room or event was not found." };
        case "M_USER_IN_USE":
            return { code: errcode, message: "That username is already taken." };
        case "M_INVALID_USERNAME":
            return { code: errcode, message: "The homeserver rejected that username." };
        case "M_EXCLUSIVE":
            return { code: errcode, message: "That username is reserved on this homeserver." };
        case "M_USER_DEACTIVATED":
            return { code: errcode, message: "This Matrix account has been deactivated." };
        case "M_USER_LOCKED":
            return { code: errcode, message: serverMessage || "This Matrix account is locked." };
        case "ORG_MATRIX_EXPIRED_ACCOUNT":
            return { code: errcode, message: serverMessage || "This Matrix account has expired." };
        case "ORG.MATRIX.MSC3866_USER_AWAITING_APPROVAL":
        case "ORG_MATRIX_MSC3866_USER_AWAITING_APPROVAL":
        case "ORG_MATRIX_MSC3866_USER_NOT_APPROVED":
            return { code: errcode, message: serverMessage || "This Matrix account is waiting for administrator approval." };
        case "M_USER_SUSPENDED":
            return { code: errcode, message: serverMessage || "This Matrix account is suspended." };
        case "M_UNRECOGNIZED":
            return { code: errcode, message: "The Matrix homeserver does not support this operation." };
        default:
            if (matrixServerUnavailableHttpStatus(httpStatus)) {
                return {
                    code: "MATRIX_SERVER_UNAVAILABLE",
                    message: "The Matrix homeserver is temporarily unavailable."
                };
            }
            if (errcode) return { code: errcode, message: serverMessage || `Matrix returned ${errcode}.` };
            if (candidate?.name === "AbortError") {
                return { code: "MATRIX_REQUEST_TIMEOUT", message: "The Matrix homeserver request timed out." };
            }
            if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(internalMessage)) {
                return { code: "MATRIX_NETWORK_ERROR", message: "The Matrix homeserver could not be reached." };
            }
            return {
                code: "MATRIX_BACKEND_ERROR",
                message: internalMessage || "The isolated Matrix backend failed before the homeserver returned an error."
            };
    }
}

function throwAuthenticationError(error: unknown, method: "password" | "access_token"): never {
    const safeError = publicError(error);
    if (safeError.code === "M_FORBIDDEN"
        || (method === "access_token" && (safeError.code === "MATRIX_REAUTH_REQUIRED"
            || safeError.code === "MATRIX_SESSION_RESET_REQUIRED"))) {
        fail(
            method === "password" ? "MATRIX_INVALID_CREDENTIALS" : "MATRIX_INVALID_ACCESS_TOKEN",
            method === "password" ? "Invalid username or password." : "The Matrix access token was rejected."
        );
    }
    throw new PublicWorkerError(safeError.code, safeError.message);
}

let workerRevision = 0;

function emit(event: MatrixWorkerEvent): void {
    window.MatrixBridgeWorkerHost.respond({ kind: "event", revision: ++workerRevision, event });
}

function accountDTO() {
    return activeCredentials ? { userId: activeCredentials.userId } : undefined;
}

function statusDTO(): MatrixBridgeStatus {
    return {
        seq: 0,
        state: workerState,
        account: accountDTO(),
        error: workerError
    };
}

function setStatus(state: MatrixBridgeState, error?: MatrixBridgeError): void {
    if (workerState === state && JSON.stringify(workerError) === JSON.stringify(error)) return;
    workerState = state;
    workerError = error;
    emit({ type: "status", status: statusDTO() });
}

function safeListener(callback: () => void): void {
    try {
        callback();
    } catch {
        setStatus("error", { code: "MATRIX_EVENT_ERROR", message: "A Matrix event could not be normalized safely." });
    }
}

function decodeStorageKey(value: string): Uint8Array<ArrayBuffer> {
    let binary: string;
    try {
        binary = atob(value);
    } catch {
        fail("MATRIX_ACCOUNT_CORRUPT", "The Matrix crypto storage key is invalid.");
    }
    if (binary.length !== 32) fail("MATRIX_ACCOUNT_CORRUPT", "The Matrix crypto storage key is invalid.");
    const bytes = new Uint8Array(32);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function databaseName(account: MatrixSessionCredentials): Promise<string> {
    const input = new TextEncoder().encode(`${account.homeserver}\0${account.userId}\0${account.deviceId}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return `vencord-matrix-${Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mediaUrl(mxc: unknown, width?: number, height?: number): string | undefined {
    if (!matrixClient || typeof mxc !== "string" || mxc.length > 4_096 || !mxc.startsWith("mxc://")) return undefined;
    const url = matrixClient.mxcUrlToHttp(mxc, width, height, width && height ? "crop" : undefined, false, false, false);
    return url && url.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(url) ? url : undefined;
}

function authenticatedMediaUrl(mxc: unknown): string | undefined {
    if (!matrixClient || typeof mxc !== "string" || !mxc.startsWith("mxc://")) return undefined;
    return matrixClient.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) || undefined;
}

function attachmentName(content: Record<string, any>): string {
    const candidate = typeof content.filename === "string"
        ? content.filename
        : typeof content.body === "string" ? content.body : "attachment";
    return candidate.replace(/[\u0000-\u001f\u007f\\/]/gu, "_").slice(0, 255) || "attachment";
}

function normalizedMimeType(value: unknown, name?: string): string | undefined {
    if (typeof value === "string") {
        const mimeType = value.split(";", 1)[0].trim().toLowerCase();
        if (mimeType.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) return mimeType;
    }
    if (name?.toLowerCase().endsWith(".gif")) return "image/gif";
    return undefined;
}

function imageDimension(value: unknown): number | undefined {
    return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_IMAGE_DIMENSION
        ? Number(value)
        : undefined;
}

function safeImageDimensions(widthValue: unknown, heightValue: unknown): { width: number; height: number; } | undefined {
    const width = imageDimension(widthValue);
    const height = imageDimension(heightValue);
    return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : undefined;
}

function attachmentFromContent(content: Record<string, any>, eventType: string): MatrixAttachmentDTO[] | undefined {
    const sticker = eventType === EventType.Sticker;
    if (!sticker && ![MsgType.Image, MsgType.File, MsgType.Audio, MsgType.Video].includes(content.msgtype)) return undefined;
    const info = content.info && typeof content.info === "object" ? content.info : {};
    const name = attachmentName(content);
    const mimeType = normalizedMimeType(info.mimetype, name);
    const encryptedFile = content.file && typeof content.file === "object" ? content.file : undefined;
    const sourceMxc = encryptedFile?.url ?? content.url;
    const attachment: MatrixAttachmentDTO = {
        name,
        downloadable: authenticatedMediaUrl(sourceMxc) != null,
        encrypted: encryptedFile != null
    };

    if (mimeType) attachment.mimeType = mimeType;
    if (Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= 1024 ** 4) attachment.size = info.size;
    const dimensions = safeImageDimensions(info.w, info.h);
    if (dimensions) {
        attachment.width = dimensions.width;
        attachment.height = dimensions.height;
    }
    if (mimeType === "image/gif") attachment.animated = true;
    // All message media is materialized through the authenticated worker path.
    // This also prevents an untrusted declared MIME/filename from making active
    // content render directly before the worker has inspected the bytes.
    attachment.thumbnailUrl = mediaUrl(info.thumbnail_url, 320, 320);
    return [attachment];
}

interface EncryptedMediaFile {
    url: string;
    key: {
        alg: string;
        ext: boolean;
        k: string;
        key_ops: string[];
        kty: string;
    };
    iv: string;
    hashes: { sha256: string; };
    v: string;
}

function decodeUnpaddedBase64(value: unknown, urlSafe: boolean, expectedBytes: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.length % 4 === 1) {
        fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");
    }
    const pattern = urlSafe ? /^[A-Za-z0-9_-]+$/u : /^[A-Za-z0-9+/]+$/u;
    if (!pattern.test(value)) fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");

    let binary: string;
    try {
        const base64 = (urlSafe ? value.replace(/-/g, "+").replace(/_/g, "/") : value)
            + "=".repeat((4 - value.length % 4) % 4);
        binary = atob(base64);
    } catch {
        fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");
    }
    if (binary.length !== expectedBytes) fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");
    const bytes = new Uint8Array(expectedBytes);
    for (let index = 0; index < expectedBytes; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function encodeUnpaddedBase64(bytes: Uint8Array, urlSafe: boolean): string {
    let binary = "";
    // This helper only handles fixed-size keys, IVs, and digests. Keeping it
    // byte-wise avoids spreading a potentially large media buffer on the stack.
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary).replace(/=+$/u, "");
    return urlSafe ? base64.replace(/\+/gu, "-").replace(/\//gu, "_") : base64;
}

function validateEncryptedMediaFile(value: unknown): EncryptedMediaFile {
    if (!value || typeof value !== "object") fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");
    const file = value as Record<string, any>;
    const { key } = file;
    if (file.v !== "v2" || !key || typeof key !== "object"
        || key.alg !== "A256CTR" || key.kty !== "oct" || key.ext !== true
        || !Array.isArray(key.key_ops) || !key.key_ops.includes("encrypt") || !key.key_ops.includes("decrypt")
        || typeof file.url !== "string" || !authenticatedMediaUrl(file.url)
        || !file.hashes || typeof file.hashes !== "object") {
        fail("MATRIX_MEDIA_ENCRYPTION_INVALID", "The encrypted media metadata is invalid.");
    }
    // Decode once during validation so malformed metadata fails before network access.
    decodeUnpaddedBase64(key.k, true, 32);
    decodeUnpaddedBase64(file.iv, false, 16);
    decodeUnpaddedBase64(file.hashes.sha256, false, 32);
    return file as EncryptedMediaFile;
}

async function readBoundedMedia(
    response: Response,
    maximumBytes: number,
    preallocate = false
): Promise<Uint8Array<ArrayBuffer>> {
    const contentLength = response.headers.get("Content-Length");
    const declaredLength = contentLength && /^\d+$/u.test(contentLength) && Number.isSafeInteger(Number(contentLength))
        ? Number(contentLength)
        : undefined;
    if (declaredLength != null && declaredLength > maximumBytes) {
        await response.body?.cancel();
        fail("MATRIX_MEDIA_TOO_LARGE", "This Matrix attachment is too large to display.");
    }
    if (!response.body) fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Matrix media response had no body.");

    const reader = response.body.getReader();
    const allocated = preallocate && declaredLength != null ? new Uint8Array(declaredLength) : undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximumBytes) {
                await reader.cancel();
                fail("MATRIX_MEDIA_TOO_LARGE", "This Matrix attachment is too large to display.");
            }
            if (allocated && length > allocated.byteLength) {
                await reader.cancel();
                fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Matrix media response length was invalid.");
            }
            if (allocated) allocated.set(value, length - value.byteLength);
            else chunks.push(new Uint8Array(value));
        }
    } finally {
        reader.releaseLock();
    }

    if (allocated) {
        if (length !== allocated.byteLength) {
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Matrix media response length was invalid.");
        }
        return allocated;
    }

    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function fetchMedia(
    mxc: string,
    maximumBytes = MAX_MEDIA_DOWNLOAD_BYTES
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string; }> {
    if (!matrixClient || !activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    let useAuthentication = true;
    try {
        useAuthentication = await matrixClient.isVersionSupported("v1.11");
    } catch {
        // Prefer the current authenticated endpoint when server capability
        // discovery is unavailable; it fails closed without exposing the token.
    }

    const controller = trackMediaReadController(new AbortController());
    const previewVideo = maximumBytes === MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES;
    const timer = setTimeout(
        () => controller.abort(),
        previewVideo ? PREVIEW_VIDEO_DOWNLOAD_TIMEOUT_MS : MEDIA_DOWNLOAD_TIMEOUT_MS
    );
    const request = async (authenticated: boolean): Promise<Response> => {
        const url = matrixClient!.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, authenticated);
        if (!url) fail("MATRIX_MEDIA_INVALID", "The Matrix media URI is invalid.");
        return await fetch(url, {
            cache: "no-store",
            credentials: "omit",
            headers: authenticated ? { Authorization: `Bearer ${activeCredentials!.accessToken}` } : undefined,
            redirect: "follow",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
    };

    try {
        const response = await request(useAuthentication);
        if (!response.ok) {
            await response.body?.cancel();
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Matrix homeserver could not download this attachment.");
        }
        return {
            bytes: await readBoundedMedia(response, maximumBytes, previewVideo),
            mimeType: normalizedMimeType(response.headers.get("Content-Type"))
        };
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Matrix homeserver could not download this attachment.");
    } finally {
        clearTimeout(timer);
        activeMediaReadControllers.delete(controller);
    }
}

async function fetchPreviewVideo(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string; }> {
    let candidate: URL;
    try {
        candidate = new URL(url);
    } catch {
        fail("MATRIX_MEDIA_INVALID", "The link preview video URI is invalid.");
    }
    if (candidate.protocol !== "https:" || candidate.hostname !== "video.twimg.com"
        || candidate.username || candidate.password || candidate.port || candidate.hash
        || candidate.href !== url || !candidate.pathname.toLowerCase().endsWith(".mp4")) {
        fail("MATRIX_MEDIA_INVALID", "The link preview video URI is invalid.");
    }

    const controller = trackDirectPreviewController(new AbortController());
    const timer = setTimeout(() => controller.abort(), PREVIEW_VIDEO_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(candidate.href, {
            cache: "no-store",
            credentials: "omit",
            headers: { Accept: "video/mp4" },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (!response.ok || response.url !== candidate.href) {
            await response.body?.cancel();
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The link preview video could not be downloaded.");
        }
        return {
            bytes: await readBoundedMedia(response, MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES, true),
            mimeType: normalizedMimeType(response.headers.get("Content-Type"))
        };
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The link preview video could not be downloaded.");
    } finally {
        clearTimeout(timer);
        releaseDirectPreviewController(controller);
    }
}

function klipyMediaUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !KLIPY_MEDIA_HOSTS.has(url.hostname)
            || url.username || url.password || url.port || url.hash || url.href !== value
            || !url.pathname.toLowerCase().endsWith(".gif")) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

async function fetchKlipyGif(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string; }> {
    const candidate = klipyMediaUrl(url);
    if (!candidate) fail("MATRIX_MEDIA_INVALID", "The KLIPY preview media URI is invalid.");

    const controller = trackDirectPreviewController(new AbortController());
    const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(candidate, {
            cache: "no-store",
            credentials: "omit",
            headers: { Accept: "image/gif" },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (!response.ok || response.url !== candidate) {
            await response.body?.cancel();
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The KLIPY preview image could not be downloaded.");
        }
        return {
            bytes: await readBoundedMedia(response, MAX_MEDIA_DOWNLOAD_BYTES),
            mimeType: normalizedMimeType(response.headers.get("Content-Type"))
        };
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The KLIPY preview image could not be downloaded.");
    } finally {
        clearTimeout(timer);
        releaseDirectPreviewController(controller);
    }
}

function xPosterUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== X_POSTER_HOST
            || url.username || url.password || url.port || url.hash || url.href !== value
            || !/^\/(?:media|tweet_video_thumb|ext_tw_video_thumb|amplify_video_thumb)\/[A-Za-z0-9_./-]{1,1024}$/u.test(url.pathname)) {
            return undefined;
        }
        const parameters = Array.from(url.searchParams.entries());
        if (parameters.some(([name, parameter]) =>
            name === "format"
                ? !/^(?:jpe?g|png|webp)$/iu.test(parameter)
                : name === "name"
                    ? !/^[A-Za-z0-9_]{1,32}$/u.test(parameter)
                    : true)
            || new Set(parameters.map(([name]) => name)).size !== parameters.length) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

async function fetchXPoster(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string; }> {
    const candidate = xPosterUrl(url);
    if (!candidate) fail("MATRIX_MEDIA_INVALID", "The X preview poster URI is invalid.");

    const controller = trackDirectPreviewController(new AbortController());
    const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(candidate, {
            cache: "no-store",
            credentials: "omit",
            headers: { Accept: "image/jpeg,image/png,image/webp" },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (!response.ok || response.url !== candidate) {
            await response.body?.cancel();
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The X preview poster could not be downloaded.");
        }
        return {
            bytes: await readBoundedMedia(response, MAX_MEDIA_DOWNLOAD_BYTES),
            mimeType: normalizedMimeType(response.headers.get("Content-Type"))
        };
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The X preview poster could not be downloaded.");
    } finally {
        clearTimeout(timer);
        releaseDirectPreviewController(controller);
    }
}

function tenorMediaUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        const validPath = url.hostname === "media1.tenor.com"
            ? /^\/m\/[A-Za-z0-9_-]{1,256}\/[A-Za-z0-9_.-]{1,256}\.(?:gif|webp|mp4)$/iu.test(url.pathname)
            : /^\/[A-Za-z0-9_-]{1,256}\/[A-Za-z0-9_.-]{1,256}\.(?:gif|webp|mp4)$/iu.test(url.pathname);
        if (url.protocol !== "https:" || !TENOR_MEDIA_HOSTS.has(url.hostname)
            || url.username || url.password || url.port || url.search || url.hash || url.href !== value
            || !validPath) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

async function fetchTenorMedia(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType?: string; }> {
    const candidate = tenorMediaUrl(url);
    if (!candidate) fail("MATRIX_MEDIA_INVALID", "The Tenor preview media URI is invalid.");
    const video = new URL(candidate).pathname.toLowerCase().endsWith(".mp4");
    const maximumBytes = video ? MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES : MAX_MEDIA_DOWNLOAD_BYTES;
    const controller = trackDirectPreviewController(new AbortController());
    const timer = setTimeout(
        () => controller.abort(),
        video ? PREVIEW_VIDEO_DOWNLOAD_TIMEOUT_MS : MEDIA_DOWNLOAD_TIMEOUT_MS
    );
    try {
        const response = await fetch(candidate, {
            cache: "no-store",
            credentials: "omit",
            headers: { Accept: video ? "video/mp4" : "image/gif,image/webp" },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (!response.ok || response.url !== candidate) {
            await response.body?.cancel();
            fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Tenor preview media could not be downloaded.");
        }
        return {
            bytes: await readBoundedMedia(response, maximumBytes, video),
            mimeType: normalizedMimeType(response.headers.get("Content-Type"))
        };
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The Tenor preview media could not be downloaded.");
    } finally {
        clearTimeout(timer);
        releaseDirectPreviewController(controller);
    }
}

function discordStickerCdnUrl(sticker: MatrixStickerSendRequest): string {
    // Discord serves GIF stickers from its media proxy, while PNG/APNG stickers
    // use the CDN. Keep both origins and paths exact so this cannot become a
    // general-purpose authenticated fetch primitive.
    const isGif = sticker.formatType === 4;
    const origin = isGif ? "https://media.discordapp.net" : "https://cdn.discordapp.com";
    const hostname = isGif ? "media.discordapp.net" : "cdn.discordapp.com";
    const extension = isGif ? "gif" : "png";
    const pathname = `/stickers/${sticker.id}.${extension}`;
    const expectedUrl = `${origin}${pathname}`;
    const url = new URL(expectedUrl);
    if (url.protocol !== "https:" || url.hostname !== hostname
        || url.username || url.password || url.port || url.search || url.hash
        || url.pathname !== pathname || url.origin !== origin || url.href !== expectedUrl) {
        fail("MATRIX_INVALID_STICKER", "The Discord sticker media URL is invalid.");
    }
    return url.href;
}

async function downloadDiscordSticker(sticker: MatrixStickerSendRequest): Promise<Uint8Array<ArrayBuffer>> {
    const url = discordStickerCdnUrl(sticker);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_STICKER_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            cache: "no-store",
            credentials: "omit",
            headers: { Accept: sticker.formatType === 4 ? "image/gif" : "image/png" },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal
        });
        if (!response.ok) {
            await response.body?.cancel();
            fail("MATRIX_STICKER_DOWNLOAD_FAILED", "The Discord sticker could not be downloaded.");
        }
        try {
            return await readBoundedMedia(response, MAX_DISCORD_STICKER_BYTES);
        } catch (error) {
            if (error instanceof PublicWorkerError && error.code === "MATRIX_MEDIA_TOO_LARGE") {
                fail("MATRIX_STICKER_TOO_LARGE", "The Discord sticker is too large to send.");
            }
            throw error;
        }
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        fail("MATRIX_STICKER_DOWNLOAD_FAILED", "The Discord sticker could not be downloaded.");
    } finally {
        clearTimeout(timer);
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
    return difference === 0;
}

async function decryptMedia(ciphertext: Uint8Array<ArrayBuffer>, fileInput: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const file = validateEncryptedMediaFile(fileInput);
    const expectedHash = decodeUnpaddedBase64(file.hashes.sha256, false, 32);
    const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
    if (!equalBytes(actualHash, expectedHash)) {
        fail("MATRIX_MEDIA_INTEGRITY_FAILED", "The encrypted Matrix attachment failed its integrity check.");
    }

    const keyBytes = decodeUnpaddedBase64(file.key.k, true, 32);
    const counter = decodeUnpaddedBase64(file.iv, false, 16);
    try {
        const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CTR", false, ["decrypt"]);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, key, ciphertext);
        return new Uint8Array(plaintext);
    } catch {
        fail("MATRIX_MEDIA_DECRYPTION_FAILED", "The encrypted Matrix attachment could not be decrypted.");
    } finally {
        keyBytes.fill(0);
    }
}

async function encryptMedia(plaintext: Uint8Array<ArrayBuffer>): Promise<{
    ciphertext: Uint8Array<ArrayBuffer>;
    file: Omit<EncryptedMediaFile, "url">;
}> {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const counter = crypto.getRandomValues(new Uint8Array(16));
    try {
        const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CTR", false, ["encrypt"]);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, plaintext);
        const ciphertext = new Uint8Array(encrypted);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
        return {
            ciphertext,
            file: {
                key: {
                    alg: "A256CTR",
                    ext: true,
                    k: encodeUnpaddedBase64(keyBytes, true),
                    key_ops: ["encrypt", "decrypt"],
                    kty: "oct"
                },
                iv: encodeUnpaddedBase64(counter, false),
                hashes: { sha256: encodeUnpaddedBase64(digest, false) },
                v: "v2"
            }
        };
    } catch {
        fail("MATRIX_MEDIA_ENCRYPTION_FAILED", "The Matrix attachment could not be encrypted safely.");
    } finally {
        keyBytes.fill(0);
        counter.fill(0);
    }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number; } | undefined {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    const limit = Math.min(bytes.byteLength, 1024 * 1024);
    let offset = 2;
    while (offset + 3 < limit) {
        if (bytes[offset++] !== 0xff) continue;
        while (offset < limit && bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (marker === 0xd9 || marker === 0xda || offset + 1 >= limit) break;
        const length = bytes[offset] << 8 | bytes[offset + 1];
        if (length < 2 || offset + length > limit) break;
        if (startOfFrame.has(marker) && length >= 7) {
            return safeImageDimensions(
                bytes[offset + 5] << 8 | bytes[offset + 6],
                bytes[offset + 3] << 8 | bytes[offset + 4]
            );
        }
        offset += length;
    }
    return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number; animated?: boolean; } | undefined {
    if (bytes.byteLength < 30
        || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return undefined;
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    let width: number | undefined;
    let height: number | undefined;
    let animated: boolean | undefined;
    if (chunk === "VP8X") {
        animated = Boolean(bytes[20] & 0x02) || undefined;
        width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        width = (bytes[26] | bytes[27] << 8) & 0x3fff;
        height = (bytes[28] | bytes[29] << 8) & 0x3fff;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
        width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
        height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    }
    const dimensions = safeImageDimensions(width, height);
    return dimensions ? { ...dimensions, animated } : undefined;
}

function mp3FrameLength(bytes: Uint8Array, offset: number): number | undefined {
    if (offset < 0 || offset + 4 > bytes.byteLength
        || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return undefined;
    const version = bytes[offset + 1] >> 3 & 0x03;
    const layer = bytes[offset + 1] >> 1 & 0x03;
    const bitrateIndex = bytes[offset + 2] >> 4;
    const sampleRateIndex = bytes[offset + 2] >> 2 & 0x03;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;

    const versionOneRates = layer === 3
        ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
        : layer === 2
            ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
            : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const reducedRates = layer === 3
        ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
        : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const bitrate = (version === 3 ? versionOneRates : reducedRates)[bitrateIndex - 1] * 1_000;
    const divisor = version === 3 ? 1 : version === 2 ? 2 : 4;
    const sampleRate = [44_100, 48_000, 32_000][sampleRateIndex] / divisor;
    const padding = bytes[offset + 2] >> 1 & 1;
    const length = layer === 3
        ? Math.floor(12 * bitrate / sampleRate + padding) * 4
        : Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate / sampleRate + padding);
    return length >= 24 && offset + length <= bytes.byteLength ? length : undefined;
}

function isMp3(bytes: Uint8Array): boolean {
    let start = 0;
    if (bytes.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        if (bytes[3] < 2 || bytes[3] > 4 || bytes[4] === 0xff
            || (bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) return false;
        start = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9]);
        if (start >= bytes.byteLength) return false;
    }
    const scanEnd = Math.min(bytes.byteLength - 4, start + 4_096);
    for (let offset = start; offset <= scanEnd; offset++) {
        const firstLength = mp3FrameLength(bytes, offset);
        if (!firstLength) continue;
        const secondOffset = offset + firstLength;
        if (mp3FrameLength(bytes, secondOffset)) return true;
    }
    return false;
}

function isOggAudio(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 28
        || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53
        || bytes[4] !== 0 || (bytes[5] & 0x02) === 0
        || bytes[18] !== 0 || bytes[19] !== 0 || bytes[20] !== 0 || bytes[21] !== 0) return false;
    const segmentCount = bytes[26];
    if (27 + segmentCount > bytes.byteLength) return false;
    let packetLength = 0;
    let packetComplete = false;
    for (let index = 0; index < segmentCount; index++) {
        const length = bytes[27 + index];
        packetLength += length;
        if (length < 255) {
            packetComplete = true;
            break;
        }
    }
    const packetOffset = 27 + segmentCount;
    if (!packetComplete || packetLength < 8 || packetOffset + packetLength > bytes.byteLength) return false;
    const opus = packetLength >= 19
        && String.fromCharCode(...bytes.subarray(packetOffset, packetOffset + 8)) === "OpusHead"
        && bytes[packetOffset + 8] > 0 && bytes[packetOffset + 9] > 0;
    const vorbis = packetLength >= 30 && bytes[packetOffset] === 1
        && String.fromCharCode(...bytes.subarray(packetOffset + 1, packetOffset + 7)) === "vorbis";
    return opus || vorbis;
}

function isWaveAudio(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 44
        || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredEnd = view.getUint32(4, true) + 8;
    if (declaredEnd < 44 || declaredEnd > bytes.byteLength) return false;
    let validFormat = false;
    let hasData = false;
    for (let offset = 12; offset + 8 <= declaredEnd;) {
        const chunkLength = view.getUint32(offset + 4, true);
        const dataOffset = offset + 8;
        if (chunkLength > declaredEnd - dataOffset) return false;
        const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        if (chunk === "fmt " && chunkLength >= 16) {
            const format = view.getUint16(dataOffset, true);
            const channels = view.getUint16(dataOffset + 2, true);
            const sampleRate = view.getUint32(dataOffset + 4, true);
            const blockAlign = view.getUint16(dataOffset + 12, true);
            const bitsPerSample = view.getUint16(dataOffset + 14, true);
            validFormat = (format === 1 || format === 3 || format === 6 || format === 7)
                && channels >= 1 && channels <= 8
                && sampleRate >= 8_000 && sampleRate <= 384_000
                && blockAlign > 0 && bitsPerSample >= 8 && bitsPerSample <= 64;
        } else if (chunk === "data" && chunkLength > 0) {
            hasData = true;
        }
        offset = dataOffset + chunkLength + (chunkLength & 1);
    }
    return validFormat && hasData;
}

function isFlacAudio(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 42
        || String.fromCharCode(...bytes.subarray(0, 4)) !== "fLaC"
        || (bytes[4] & 0x7f) !== 0
        || (bytes[5] << 16 | bytes[6] << 8 | bytes[7]) !== 34) return false;
    const minimumBlockSize = bytes[8] << 8 | bytes[9];
    const maximumBlockSize = bytes[10] << 8 | bytes[11];
    const sampleRate = bytes[18] << 12 | bytes[19] << 4 | bytes[20] >> 4;
    const channels = (bytes[20] >> 1 & 0x07) + 1;
    const bitsPerSample = ((bytes[20] & 1) << 4 | bytes[21] >> 4) + 1;
    const totalSamples = (bytes[21] & 0x0f) * 0x1_0000_0000
        + bytes[22] * 0x100_0000 + bytes[23] * 0x1_0000 + bytes[24] * 0x100 + bytes[25];
    return minimumBlockSize >= 16 && maximumBlockSize >= minimumBlockSize
        && sampleRate >= 1 && sampleRate <= 1_048_575
        && channels >= 1 && channels <= 8 && bitsPerSample >= 4 && bitsPerSample <= 32
        && totalSamples > 0;
}

function sniffedMedia(bytes: Uint8Array, _declared?: string, _server?: string): {
    mimeType: string;
    width?: number;
    height?: number;
    animated?: boolean;
} {
    const gif = bytes.byteLength >= 13
        && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
        && bytes[bytes.byteLength - 1] === 0x3b;
    if (gif) {
        const dimensions = safeImageDimensions(bytes[6] | bytes[7] << 8, bytes[8] | bytes[9] << 8);
        if (dimensions) return { mimeType: "image/gif", ...dimensions, animated: true };
    }

    const png = bytes.byteLength >= 24
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
        && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
    if (png) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dimensions = safeImageDimensions(view.getUint32(16), view.getUint32(20));
        if (dimensions) return { mimeType: "image/png", ...dimensions };
    }

    const jpeg = jpegDimensions(bytes);
    if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
    const webp = webpDimensions(bytes);
    if (webp) return { mimeType: "image/webp", ...webp };

    const declared = normalizedMimeType(_declared);
    const server = normalizedMimeType(_server);
    const mp4Brands = new Set(["avc1", "dash", "iso2", "iso3", "iso4", "iso5", "iso6", "isom", "M4V ", "mp41", "mp42"]);
    const mp4AudioBrands = new Set(["M4A ", "M4B ", "F4A ", "F4B "]);
    if (bytes.byteLength >= 16 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
        const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        if (boxSize >= 16 && boxSize <= Math.min(bytes.byteLength, 4_096) && boxSize % 4 === 0) {
            let audio = false;
            let video = false;
            for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
                if (offset === 12) continue; // minor_version is not a brand
                const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
                audio ||= mp4AudioBrands.has(brand);
                video ||= mp4Brands.has(brand);
            }
            if (audio) return { mimeType: "audio/mp4" };
            if (video) return { mimeType: "video/mp4" };
        }
    }

    const webmHeader = bytes.byteLength >= 16
        && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    if (webmHeader && (declared === "video/webm" || server === "video/webm")) {
        const headerText = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.byteLength, 4_096)));
        if (headerText.includes("webm")) return { mimeType: "video/webm" };
    }

    if (isMp3(bytes)) return { mimeType: "audio/mpeg" };
    if (isOggAudio(bytes)) return { mimeType: "audio/ogg" };
    if (isWaveAudio(bytes)) return { mimeType: "audio/wav" };
    if (isFlacAudio(bytes)) return { mimeType: "audio/flac" };

    // Sender and homeserver MIME metadata is untrusted. Unknown bytes become a
    // passive download instead of an active HTML/SVG document in a Blob URL.
    return { mimeType: "application/octet-stream" };
}

function pngAnimationState(bytes: Uint8Array): boolean | undefined {
    if (bytes.byteLength < 45
        || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
        || bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let firstChunk = true;
    let animated = false;
    let sawAnimationControl = false;
    let sawImageData = false;
    while (offset + 12 <= bytes.byteLength) {
        const length = view.getUint32(offset);
        if (length > bytes.byteLength - offset - 12) return undefined;
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (firstChunk && (type !== "IHDR" || length !== 13)) return undefined;
        firstChunk = false;
        if (type === "acTL") {
            if (sawAnimationControl || sawImageData || length !== 8 || view.getUint32(offset + 8) < 1) return undefined;
            sawAnimationControl = true;
            animated = true;
        } else if (type === "IDAT") {
            sawImageData = true;
        } else if (type === "IEND") {
            return length === 0 && sawImageData ? animated : undefined;
        }
        offset += length + 12;
    }
    return undefined;
}

function sniffDiscordSticker(bytes: Uint8Array, formatType: MatrixStickerSendRequest["formatType"]): {
    mimeType: "image/gif" | "image/png";
    width: number;
    height: number;
    animated: boolean;
} {
    const media = sniffedMedia(bytes);
    if (formatType === 4) {
        if (media.mimeType !== "image/gif" || !media.width || !media.height || media.animated !== true) {
            fail("MATRIX_STICKER_FORMAT_INVALID", "The Discord sticker was not a valid GIF.");
        }
        return { mimeType: "image/gif", width: media.width, height: media.height, animated: true };
    }

    const animated = pngAnimationState(bytes);
    if (media.mimeType !== "image/png" || !media.width || !media.height || animated == null
        || (formatType === 1 && animated) || (formatType === 2 && !animated)) {
        fail(
            "MATRIX_STICKER_FORMAT_INVALID",
            formatType === 2 ? "The Discord sticker was not a valid APNG." : "The Discord sticker was not a valid PNG."
        );
    }
    return { mimeType: "image/png", width: media.width, height: media.height, animated };
}

function safeDownloadedName(name: string, mimeType: string): string {
    if (mimeType === "application/octet-stream") return name;
    const extension = mimeType === "image/gif" ? ".gif"
        : mimeType === "image/png" ? ".png"
            : mimeType === "image/jpeg" ? ".jpg"
                : mimeType === "image/webp" ? ".webp"
                    : mimeType === "video/mp4" ? ".mp4"
                        : mimeType === "video/webm" ? ".webm"
                            : mimeType === "audio/mpeg" ? ".mp3"
                                : mimeType === "audio/ogg" ? ".ogg"
                                    : mimeType === "audio/wav" ? ".wav"
                                        : mimeType === "audio/flac" ? ".flac"
                                            : mimeType === "audio/mp4" ? ".m4a"
                                                : ".bin";
    return name.toLowerCase().endsWith(extension)
        ? name
        : `${name.slice(0, 255 - extension.length)}${extension}`;
}

function relationContent(event: MatrixEvent): Record<string, any> | undefined {
    const original = event.getOriginalContent<Record<string, any>>();
    const relation = original?.["m.relates_to"];
    return relation && typeof relation === "object" ? relation : undefined;
}

function buildReactionMap(room: Room): Map<string, MatrixReactionDTO[]> {
    const cached = reactionMapCache.get(room);
    if (cached) return cached;
    const ownUserId = activeCredentials?.userId;
    const grouped = new Map<string, Map<string, Map<string, string[]>>>();
    for (const event of room.getLiveTimeline().getEvents()) {
        if (event.getType() !== EventType.Reaction || event.isRedacted()) continue;
        const relation = relationContent(event);
        if (relation?.rel_type !== RelationType.Annotation
            || typeof relation.event_id !== "string"
            || typeof relation.key !== "string" || relation.key.length < 1 || relation.key.length > 128
            || /[\u0000-\u001f\u007f]/u.test(relation.key)) continue;

        const eventId = optionalEventId(event.getId());
        const senderId = optionalUserId(event.getSender());
        const targetId = optionalEventId(relation.event_id);
        if (!eventId || !senderId || !targetId) continue;
        rememberReactionTarget(eventId, room.roomId, targetId);
        let reactions = grouped.get(targetId);
        if (!reactions) grouped.set(targetId, reactions = new Map());
        let senders = reactions.get(relation.key);
        if (!senders) reactions.set(relation.key, senders = new Map());
        const eventIds = senders.get(senderId) ?? [];
        eventIds.push(eventId);
        senders.set(senderId, eventIds);
    }

    const result = new Map<string, MatrixReactionDTO[]>();
    for (const [targetId, reactions] of grouped) {
        const bounded = Array.from(reactions, ([key, senders]) => {
            const ownEvents = ownUserId ? senders.get(ownUserId)?.sort() : undefined;
            return {
                key,
                count: senders.size,
                me: Boolean(ownEvents?.length),
                ...(ownEvents?.[0] ? { eventId: ownEvents[0] } : {})
            };
        }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).slice(0, 100);
        result.set(targetId, bounded);
    }
    reactionMapCache.set(room, result);
    return result;
}

function invalidateReactionMap(room: Room): void {
    reactionMapCache.delete(room);
}

function safeMessageBody(value: unknown): string {
    return typeof value === "string"
        ? value
            .slice(0, MAX_MESSAGE_BODY_CHARS)
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
        : "";
}

function normalizedMessageMentionUserIds(room: Room, content: Record<string, any>): string[] | undefined {
    const mentions = content["m.mentions"];
    if (!mentions || typeof mentions !== "object" || Array.isArray(mentions)
        || !Array.isArray(mentions.user_ids) || mentions.user_ids.length < 1) {
        return undefined;
    }
    const userIds: string[] = [];
    const seen = new Set<string>();
    for (const value of mentions.user_ids.slice(0, MAX_MATRIX_MESSAGE_MENTIONS)) {
        const userId = optionalUserId(value);
        const membership = userId ? room.getMember(userId)?.membership : undefined;
        if (!userId || seen.has(userId) || (membership !== "join" && membership !== "invite")) continue;
        seen.add(userId);
        userIds.push(userId);
    }
    return userIds.length ? userIds : undefined;
}

function validateOutgoingMentionContent(
    room: Room,
    value: unknown,
    placeholderBody: string
): { body: string; userIds: string[]; } {
    if (value == null) {
        const body = materializeOutboundMatrixMentions(placeholderBody, []);
        if (body == null) fail("MATRIX_INVALID_ARGUMENT", "The Matrix message mention placeholders are invalid.");
        return { body, userIds: [] };
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MATRIX_MESSAGE_MENTIONS) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix message mentions are invalid.");
    }
    const userIds = value.map(validateUserId);
    if (new Set(userIds).size !== userIds.length) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix message mentions contain duplicates.");
    }
    for (const userId of userIds) {
        const membership = room.getMember(userId)?.membership;
        if (userId === activeCredentials?.userId || (membership !== "join" && membership !== "invite")) {
            fail("MATRIX_INVALID_ARGUMENT", "A Matrix message mention does not match a current room member.");
        }
    }
    const materializedBody = materializeOutboundMatrixMentions(placeholderBody, userIds);
    if (materializedBody == null) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix message mention placeholders are invalid.");
    }
    return { body: validateString(materializedBody, "body", 65_536), userIds };
}

function stripPlainReplyFallback(body: string): string {
    let offset = 0;
    let stripped = false;
    while (offset < body.length) {
        const newline = body.indexOf("\n", offset);
        const lineEnd = newline === -1 ? body.length : newline;
        const contentEnd = lineEnd > offset && body.charCodeAt(lineEnd - 1) === 13
            ? lineEnd - 1
            : lineEnd;
        if (!body.startsWith("> ", offset) || contentEnd < offset + 2) break;
        stripped = true;
        if (newline === -1) return "";
        offset = newline + 1;
    }
    if (!stripped) return body;

    // Historical Matrix reply fallbacks put one empty separator line between
    // the quoted prefix and the actual reply. Remove only that one separator;
    // all remaining whitespace belongs to the sender's message.
    if (body.startsWith("\r\n", offset)) offset += 2;
    else if (body.startsWith("\n", offset)) offset++;
    return body.slice(offset);
}

function normalizedEventTransactionId(event: MatrixEvent, senderId: string): string | undefined {
    // A transaction ID is meaningful only to the sending account. Depending on
    // which Matrix SDK remote-echo path won the race, it can live either on the
    // local MatrixEvent instance or in the server-provided unsigned object.
    if (senderId !== activeCredentials?.userId) return undefined;
    const valid = (value: unknown): string | undefined => typeof value === "string"
        && value.length <= 128 && /^[A-Za-z0-9._~-]+$/u.test(value)
        ? value
        : undefined;
    const local = valid(event.getTxnId());
    const remote = valid(event.getUnsigned().transaction_id);
    // Never let a corrupt/malicious unsigned field reconcile two different
    // local echoes. Omitting the identity is safer than guessing.
    if (local && remote && local !== remote) return undefined;
    return local ?? remote;
}

function normalizeMessage(room: Room, event: MatrixEvent, reactions?: MatrixReactionDTO[]): MatrixMessageDTO | null {
    const roomId = optionalRoomId(room.roomId);
    const senderId = optionalUserId(event.getSender());
    if (!senderId || !roomId || event.isRedacted()) return null;
    const transactionId = normalizedEventTransactionId(event, senderId);
    const remoteEventId = optionalEventId(event.getId());
    const localEventId = event.status != null && transactionId
        && event.getId() === `~${roomId}:${transactionId}`
        ? event.getId()
        : undefined;
    const eventId = remoteEventId ?? localEventId;
    if (!eventId) return null;

    const decryptionFailure = event.isDecryptionFailure();
    const type = event.getType();
    if (!decryptionFailure && type !== EventType.RoomMessage && type !== EventType.Sticker) return null;

    const content = event.getContent<Record<string, any>>();
    const relation = relationContent(event);
    if (relation?.rel_type === RelationType.Replace) return null;

    const replyToEventId = relation?.["m.in_reply_to"] && typeof relation["m.in_reply_to"].event_id === "string"
        ? optionalEventId(relation["m.in_reply_to"].event_id)
        : undefined;
    const member = room.getMember(senderId);
    const rawBody = decryptionFailure
        ? "Unable to decrypt this message."
        : safeMessageBody(content.body);
    const body = replyToEventId && !decryptionFailure
        ? stripPlainReplyFallback(rawBody)
        : rawBody;
    const timestamp = Number.isSafeInteger(event.getTs()) && event.getTs() >= 0 && event.getTs() <= MAX_EVENT_TIMESTAMP
        ? event.getTs()
        : 0;
    const message: MatrixMessageDTO = {
        eventId,
        roomId,
        senderId,
        timestamp,
        body
    };

    const senderName = publicRoomText(member?.name, 256);
    if (senderName) message.senderName = senderName;
    const mentionedUserIds = normalizedMessageMentionUserIds(room, content);
    if (mentionedUserIds) message.mentionedUserIds = mentionedUserIds;
    if (content.format === "org.matrix.custom.html") {
        const formattedBody = safeMessageBody(content.formatted_body);
        if (formattedBody) message.formattedBody = formattedBody;
    }
    if (type === EventType.Sticker) message.sticker = true;
    if (event.replacingEvent()) message.edited = true;
    if (replyToEventId) message.replyToEventId = replyToEventId;
    const attachments = attachmentFromContent(content, type);
    if (attachments) {
        message.attachments = attachments;
        const attachmentGroup = type === EventType.RoomMessage
            ? parsedAttachmentGroup(content[ATTACHMENT_GROUP_CONTENT_KEY])
            : undefined;
        if (attachmentGroup) message.attachmentGroup = attachmentGroup;
        // Matrix uses body as the filename when no separate caption exists.
        // Discord already renders the attachment filename, so do not duplicate
        // it as message text. A distinct body+filename pair is a real caption.
        if (type !== EventType.Sticker
            && (typeof content.filename !== "string" || content.filename === body)) {
            message.body = "";
        }
    }
    if (reactions?.length) message.reactions = reactions.slice(0, 100);
    if (decryptionFailure) message.decryptionFailure = true;
    // SENT means the homeserver accepted the event and assigned its canonical
    // ID. It may still be waiting for /sync, but Discord must not leave the row
    // in SENDING during that potentially unbounded wait.
    if (event.status != null && event.status !== EventStatus.SENT) message.pending = true;
    if (event.status === "not_sent" || event.status === "cancelled") message.failed = true;
    if (transactionId) message.transactionId = transactionId;
    return message;
}

function normalizeMember(member: ReturnType<Room["getMembers"]>[number]): MatrixMemberDTO | null {
    const userId = optionalUserId(member.userId);
    if (!userId) return null;
    const membership = typeof member.membership === "string" && /^[a-z_]{1,32}$/u.test(member.membership)
        ? member.membership
        : "leave";
    const result: MatrixMemberDTO = {
        userId,
        membership
    };
    if (Number.isSafeInteger(member.powerLevel) && member.powerLevel >= -1_000 && member.powerLevel <= 1_000) {
        result.powerLevel = member.powerLevel;
    }
    const displayName = publicRoomText(member.name, 256);
    if (displayName) result.displayName = displayName;
    const avatarUrl = mediaUrl(member.getMxcAvatarUrl(), 96, 96);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    return result;
}

function prioritizedRoomMembers(room: Room): ReturnType<Room["getMembers"]> {
    const selfUserId = activeCredentials?.userId;
    const powerLevel = (member: ReturnType<Room["getMembers"]>[number]) =>
        Number.isSafeInteger(member.powerLevel) ? member.powerLevel : 0;
    const membershipOrder = (member: ReturnType<Room["getMembers"]>[number]) =>
        member.membership === "join" ? 0 : member.membership === "invite" ? 1 : 2;
    return [...room.getMembers()].sort((left, right) => {
        const selfOrder = Number(right.userId === selfUserId) - Number(left.userId === selfUserId);
        return selfOrder
            || membershipOrder(left) - membershipOrder(right)
            || powerLevel(right) - powerLevel(left)
            || left.userId.localeCompare(right.userId);
    });
}

function optionalRoomId(value: unknown): string | undefined {
    try {
        return validateRoomId(value);
    } catch {
        return undefined;
    }
}

function optionalEventId(value: unknown): string | undefined {
    try {
        return validateEventId(value);
    } catch {
        return undefined;
    }
}

function optionalTimelineEventId(room: Room, event: MatrixEvent): string | undefined {
    const remoteEventId = optionalEventId(event.getId());
    if (remoteEventId) return remoteEventId;
    const roomId = optionalRoomId(room.roomId);
    const transactionId = event.getTxnId();
    return roomId && event.status != null
        && typeof transactionId === "string" && transactionId.length <= 128
        && /^[A-Za-z0-9._~-]+$/u.test(transactionId)
        && event.getId() === `~${roomId}:${transactionId}`
        ? event.getId()
        : undefined;
}

function optionalUserId(value: unknown): string | undefined {
    try {
        return validateUserId(value);
    } catch {
        return undefined;
    }
}

function spaceViaServers(value: unknown): string[] | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { via } = value as Record<string, unknown>;
    if (!Array.isArray(via) || via.length < 1 || via.length > 10) return undefined;
    try {
        return [...new Set(via.map(validateServerName))].slice(0, 3);
    } catch {
        return undefined;
    }
}

function validSpaceVia(value: unknown): boolean {
    return spaceViaServers(value) != null;
}

function hierarchyTargetServers(roomId: string): string[] | undefined {
    const servers: string[] = [];
    for (const targets of spaceHierarchyTargets.values()) {
        const targetServers = targets.get(roomId);
        if (!targetServers) continue;
        for (const server of targetServers) {
            if (!servers.includes(server)) servers.push(server);
            if (servers.length === 3) return servers;
        }
    }
    return servers.length ? servers : undefined;
}

function removeHierarchyTarget(roomId: string): void {
    for (const targets of spaceHierarchyTargets.values()) targets.delete(roomId);
    for (const relations of spaceHierarchyRelationTargets.values()) {
        relations.delete(roomId);
        for (const targets of relations.values()) targets.delete(roomId);
    }
}

function normalizeJoinRule(value: unknown): MatrixRoomJoinRule | undefined {
    switch (value) {
        case "public":
        case "invite":
        case "knock":
        case "restricted":
        case "knock_restricted":
        case "private":
            return value;
        default:
            return undefined;
    }
}

interface DirectAccountData {
    content: Record<string, string[]>;
    roomToUser: Map<string, string>;
}

function directAccountData(): DirectAccountData {
    const content = Object.create(null) as Record<string, string[]>;
    const owners = new Map<string, Set<string>>();
    const raw = matrixClient?.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { content, roomToUser: new Map() };

    let totalRooms = 0;
    for (const [rawUserId, rawRoomIds] of Object.entries(raw).slice(0, 2_000)) {
        const userId = optionalUserId(rawUserId);
        if (!userId || !Array.isArray(rawRoomIds)) continue;
        const roomIds: string[] = [];
        for (const rawRoomId of rawRoomIds.slice(0, 100)) {
            if (totalRooms >= 10_000) break;
            const roomId = optionalRoomId(rawRoomId);
            if (!roomId || roomIds.includes(roomId)) continue;
            roomIds.push(roomId);
            totalRooms++;
            let roomOwners = owners.get(roomId);
            if (!roomOwners) owners.set(roomId, roomOwners = new Set());
            roomOwners.add(userId);
        }
        if (roomIds.length) content[userId] = roomIds;
        if (totalRooms >= 10_000) break;
    }

    const roomToUser = new Map<string, string>();
    for (const [roomId, roomOwners] of owners) {
        const owner = roomOwners.values().next().value;
        if (roomOwners.size === 1 && owner && owner !== activeCredentials?.userId) roomToUser.set(roomId, owner);
    }
    return { content, roomToUser };
}

function normalizeSpaceOrder(value: unknown): string | undefined {
    return typeof value === "string" && value.length <= 50 && /^[\u0020-\u007e]*$/u.test(value)
        ? value
        : undefined;
}

interface OrderedSpaceChild extends MatrixSpaceChildDTO {
    timestamp: number;
}

function orderSpaceChildren(children: OrderedSpaceChild[]): MatrixSpaceChildDTO[] {
    children.sort((left, right) => {
        if (left.order != null && right.order == null) return -1;
        if (left.order == null && right.order != null) return 1;
        const leftOrder = left.order ?? "";
        const rightOrder = right.order ?? "";
        const order = leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
        return order || left.timestamp - right.timestamp || left.roomId.localeCompare(right.roomId);
    });
    return children.map(({ roomId, order, suggested }) => ({ roomId, order, suggested }));
}

function localSpaceChildren(room: Room): MatrixSpaceChildDTO[] {
    const events = room.currentState.getStateEvents(EventType.SpaceChild);
    if (!Array.isArray(events)) return [];
    const seen = new Set<string>();
    const children: OrderedSpaceChild[] = [];
    for (const event of events.slice(0, 1_000)) {
        const roomId = optionalRoomId(event.getStateKey());
        const content = event.getContent<Record<string, unknown>>();
        if (!roomId || seen.has(roomId) || !validSpaceVia(content)) continue;
        seen.add(roomId);
        const order = normalizeSpaceOrder(content.order);
        children.push({
            roomId,
            ...(order != null ? { order } : {}),
            ...(typeof content.suggested === "boolean" ? { suggested: content.suggested } : {}),
            timestamp: event.getTs()
        });
    }
    return orderSpaceChildren(children);
}

function localSpaceRoutingServers(room: Room): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const events = room.currentState.getStateEvents(EventType.SpaceChild);
    if (!Array.isArray(events)) return result;
    for (const event of events.slice(0, 1_000)) {
        const roomId = optionalRoomId(event.getStateKey());
        const viaServers = spaceViaServers(event.getContent<Record<string, unknown>>());
        if (roomId && viaServers) result.set(roomId, viaServers);
    }
    return result;
}

function localSpaceParents(room: Room): string[] {
    const events = room.currentState.getStateEvents(EventType.SpaceParent);
    if (!Array.isArray(events)) return [];
    const parents = new Set<string>();
    for (const event of events.slice(0, 1_000)) {
        const roomId = optionalRoomId(event.getStateKey());
        if (roomId && validSpaceVia(event.getContent<Record<string, unknown>>())) parents.add(roomId);
    }
    return [...parents].sort();
}

function roomKind(room: Room, directRooms: Map<string, string>): MatrixRoomKind {
    if (room.isSpaceRoom()) return "space";
    // The creator-signed bridge identity is permanent classification state.
    // Mutable privacy or power-level changes must not let a group collapse
    // into m.direct or be claimed by a unilateral Space link.
    if (groupChatRoomIdentity(room)) return "room";
    if (directRooms.has(room.roomId) || (room.getMyMembership() === "invite" && optionalUserId(room.getDMInviter()))) {
        return "dm";
    }
    return "room";
}

function roomDirectUserId(room: Room, directRooms: Map<string, string>): string | undefined {
    if (groupChatRoomIdentity(room)) return undefined;
    const mapped = directRooms.get(room.roomId);
    if (mapped && mapped !== activeCredentials?.userId) return mapped;
    if (room.getMyMembership() !== "invite") return undefined;
    const inviter = optionalUserId(room.getDMInviter());
    return inviter && inviter !== activeCredentials?.userId ? inviter : undefined;
}

function roomInviterId(room: Room): string | undefined {
    if (room.getMyMembership() !== "invite" || !activeCredentials) return undefined;
    const sender = room.getMember(activeCredentials.userId)?.events.member?.getSender();
    const inviter = optionalUserId(sender) ?? optionalUserId(room.getDMInviter());
    return inviter && inviter !== activeCredentials.userId ? inviter : undefined;
}

function inferredSpaceParents(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const parent of matrixClient?.getRooms() ?? []) {
        const membership = parent.getMyMembership();
        if (pendingHiddenRooms.has(parent.roomId)
            || (membership !== "join" && membership !== "invite")
            || !parent.isSpaceRoom()) continue;
        for (const child of projectableSpaceChildren(parent)) {
            const parents = result.get(child.roomId) ?? [];
            if (!parents.includes(parent.roomId)) parents.push(parent.roomId);
            result.set(child.roomId, parents);
        }
    }
    for (const parents of result.values()) parents.sort();
    return result;
}

function boundedNotificationCount(value: unknown): number {
    return Number.isSafeInteger(value) && Number(value) >= 0
        ? Math.min(Number(value), 1_000_000_000)
        : 0;
}

interface ParsedMatrixPowerLevel {
    valid: boolean;
    value: number;
}

function invalidMatrixPowerLevel(): ParsedMatrixPowerLevel {
    return { valid: false, value: 0 };
}

function parseMatrixPowerLevel(value: unknown, roomVersion: string): ParsedMatrixPowerLevel {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return invalidMatrixPowerLevel();
        // Room version 1 accepted finite JSON numbers and its authorization
        // rules truncated fractional power levels toward zero. Later room
        // versions require integer-valued JSON numbers.
        const normalized = roomVersion === "1" ? Math.trunc(value) : value;
        return Number.isSafeInteger(normalized)
            ? { valid: true, value: normalized }
            : invalidMatrixPowerLevel();
    }
    // Room versions 1-9 accepted integer-valued strings, including the
    // historical whitespace, sign, and leading-zero forms. Modern versions
    // reject strings rather than silently applying an absent-field default.
    if (/^[1-9]$/u.test(roomVersion) && typeof value === "string"
        && /^\s*[+-]?[0-9]+\s*$/u.test(value)) {
        const normalized = Number(value.trim());
        if (Number.isSafeInteger(normalized)) return { valid: true, value: normalized };
    }
    return invalidMatrixPowerLevel();
}

function defaultedMatrixPowerLevel(
    content: Record<string, unknown>,
    key: string,
    fallback: number,
    roomVersion: string
): ParsedMatrixPowerLevel {
    return Object.hasOwn(content, key)
        ? parseMatrixPowerLevel(content[key], roomVersion)
        : { valid: true, value: fallback };
}

function roomPowerLevelContent(room: Room): { valid: boolean; content: Record<string, unknown>; } {
    const event = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    if (!event) return { valid: true, content: {} };
    const content: unknown = event.getContent();
    return content && typeof content === "object" && !Array.isArray(content)
        ? { valid: true, content: content as Record<string, unknown> }
        : { valid: false, content: {} };
}

function userPowerLevel(
    content: Record<string, unknown>,
    userId: string,
    roomVersion: string
): ParsedMatrixPowerLevel {
    const usersDefault = defaultedMatrixPowerLevel(content, "users_default", 0, roomVersion);
    if (!usersDefault.valid) return usersDefault;
    if (!Object.hasOwn(content, "users")) return usersDefault;
    const { users } = content;
    if (!users || typeof users !== "object" || Array.isArray(users)) return invalidMatrixPowerLevel();
    const levels = users as Record<string, unknown>;
    return Object.hasOwn(levels, userId)
        ? parseMatrixPowerLevel(levels[userId], roomVersion)
        : usersDefault;
}

function isHydraRoomVersion(roomVersion: string): boolean {
    // Keep this aligned with matrix-js-sdk's fail-safe room-version policy:
    // the only versions known not to use Hydra creator semantics are 1-11.
    return !/^(?:[1-9]|10|11)$/u.test(roomVersion);
}

function createEventUserPowerLevel(
    room: Room,
    userId: string,
    roomVersion: string
): ParsedMatrixPowerLevel {
    const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
    if (!createEvent) return invalidMatrixPowerLevel();
    const rawContent: unknown = createEvent.getContent();
    if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
        return invalidMatrixPowerLevel();
    }
    const content = rawContent as Record<string, unknown>;
    const rawSender = createEvent.getSender();
    let sender: string;
    try {
        sender = validateUserId(rawSender);
    } catch {
        return invalidMatrixPowerLevel();
    }

    if (!isHydraRoomVersion(roomVersion)) {
        // The authenticated create-event sender is authoritative in every
        // room version. Room v11 removed the redundant content.creator field.
        return { valid: true, value: sender === userId ? 100 : 0 };
    }

    const rawAdditionalCreators = Object.hasOwn(content, "additional_creators")
        ? content.additional_creators
        : [];
    if (!Array.isArray(rawAdditionalCreators) || rawAdditionalCreators.length > 1_000) {
        return invalidMatrixPowerLevel();
    }
    const creators = new Set<string>([sender]);
    try {
        for (const creator of rawAdditionalCreators) creators.add(validateUserId(creator));
    } catch {
        return invalidMatrixPowerLevel();
    }
    return { valid: true, value: creators.has(userId) ? Infinity : 0 };
}

function effectiveUserPowerLevel(
    room: Room,
    content: Record<string, unknown>,
    userId: string,
    roomVersion: string
): ParsedMatrixPowerLevel {
    // Matrix-js-sdk currently leaves member.powerLevel at zero when a room has
    // no m.room.power_levels event. Derive the room-version creator defaults
    // from authenticated creation state instead, and fail closed when that
    // state is missing or malformed.
    if (!room.currentState.getStateEvents(EventType.RoomPowerLevels, "")) {
        return createEventUserPowerLevel(room, userId, roomVersion);
    }
    const memberLevel = room.getMember(userId)?.powerLevel;
    if (memberLevel === Infinity) return { valid: true, value: Infinity };
    return userPowerLevel(content, userId, roomVersion);
}

function stateEventPowerLevel(
    content: Record<string, unknown>,
    eventType: string,
    roomVersion: string
): ParsedMatrixPowerLevel {
    const stateDefault = defaultedMatrixPowerLevel(content, "state_default", 50, roomVersion);
    if (!stateDefault.valid || !Object.hasOwn(content, "events")) return stateDefault;
    const { events } = content;
    if (!events || typeof events !== "object" || Array.isArray(events)) return invalidMatrixPowerLevel();
    const levels = events as Record<string, unknown>;
    return Object.hasOwn(levels, eventType)
        ? parseMatrixPowerLevel(levels[eventType], roomVersion)
        : stateDefault;
}

function powerLevelPermissionDTO(
    current: ParsedMatrixPowerLevel,
    required: ParsedMatrixPowerLevel
): MatrixPowerLevelPermissionDTO {
    const currentDTO: MatrixPowerLevelPermissionDTO["current"] = !current.valid
        ? "unverifiable"
        : current.value === Infinity ? "infinite" : current.value;
    const requiredDTO: MatrixPowerLevelPermissionDTO["required"] = required.valid
        ? required.value
        : "unverifiable";
    return {
        current: currentDTO,
        required: requiredDTO,
        allowed: current.valid && required.valid && current.value >= required.value
    };
}

function roomPowerLevelPermission(
    room: Room,
    requiredLevel: (content: Record<string, unknown>, roomVersion: string) => ParsedMatrixPowerLevel
): MatrixPowerLevelPermissionDTO {
    if (!activeCredentials || room.getMember(activeCredentials.userId)?.membership !== "join") {
        return { current: "unverifiable", required: "unverifiable", allowed: false };
    }
    const roomVersion = room.getVersion();
    const state = roomPowerLevelContent(room);
    if (!state.valid) return { current: "unverifiable", required: "unverifiable", allowed: false };
    return powerLevelPermissionDTO(
        effectiveUserPowerLevel(room, state.content, activeCredentials.userId, roomVersion),
        requiredLevel(state.content, roomVersion)
    );
}

function spaceChildPermission(room: Room): MatrixPowerLevelPermissionDTO {
    return roomPowerLevelPermission(room, (content, roomVersion) =>
        stateEventPowerLevel(content, EventType.SpaceChild, roomVersion));
}

function spaceInvitePermission(room: Room): MatrixPowerLevelPermissionDTO {
    return roomPowerLevelPermission(room, (content, roomVersion) =>
        defaultedMatrixPowerLevel(content, "invite", 0, roomVersion));
}

function permissionIsUnverifiable(permission: MatrixPowerLevelPermissionDTO): boolean {
    return permission.current === "unverifiable" || permission.required === "unverifiable";
}

function spaceAccessPermissions(
    room: Room,
    targetUserId?: string
): { canApprove: boolean; canDeny: boolean; } {
    if (!activeCredentials || room.getMember(activeCredentials.userId)?.membership !== "join") {
        return { canApprove: false, canDeny: false };
    }
    const roomVersion = room.getVersion();
    const powerLevelState = roomPowerLevelContent(room);
    if (!powerLevelState.valid) return { canApprove: false, canDeny: false };
    const powerLevels = powerLevelState.content;
    const senderLevel = effectiveUserPowerLevel(room, powerLevels, activeCredentials.userId, roomVersion);
    const inviteLevel = defaultedMatrixPowerLevel(powerLevels, "invite", 0, roomVersion);
    const kickLevel = defaultedMatrixPowerLevel(powerLevels, "kick", 50, roomVersion);
    const targetLevel = targetUserId == null
        ? undefined
        : effectiveUserPowerLevel(room, powerLevels, targetUserId, roomVersion);
    if (!senderLevel.valid || !inviteLevel.valid || !kickLevel.valid || targetLevel?.valid === false) {
        return { canApprove: false, canDeny: false };
    }
    return {
        canApprove: senderLevel.value >= inviteLevel.value,
        canDeny: senderLevel.value >= kickLevel.value
            && (targetLevel == null || senderLevel.value > targetLevel.value)
    };
}

function canConfigureSpaceAccess(room: Room): boolean {
    if (!activeCredentials) return false;
    const sender = room.getMember(activeCredentials.userId);
    if (sender?.membership !== "join") return false;
    const roomVersion = room.getVersion();
    const powerLevelState = roomPowerLevelContent(room);
    if (!powerLevelState.valid) return false;
    const powerLevels = powerLevelState.content;
    const senderLevel = effectiveUserPowerLevel(room, powerLevels, activeCredentials.userId, roomVersion);
    const stateDefault = defaultedMatrixPowerLevel(powerLevels, "state_default", 50, roomVersion);
    if (!senderLevel.valid || !stateDefault.valid) return false;
    let eventLevels: Record<string, unknown> | undefined;
    if (Object.hasOwn(powerLevels, "events")) {
        const { events } = powerLevels;
        if (!events || typeof events !== "object" || Array.isArray(events)) return false;
        eventLevels = events as Record<string, unknown>;
    }
    return [
        EventType.RoomJoinRules,
        EventType.RoomHistoryVisibility,
        EventType.RoomGuestAccess,
        EventType.RoomCanonicalAlias
    ].every(type => {
        const required = eventLevels && Object.hasOwn(eventLevels, type)
            ? parseMatrixPowerLevel(eventLevels[type], roomVersion)
            : stateDefault;
        return required.valid && senderLevel.value >= required.value;
    });
}

function currentSpaceAccessRequestCount(room: Room): number {
    let count = 0;
    for (const member of room.getMembers()) {
        if (member.membership !== "knock" || isResolvedSpaceAccessRequest(room.roomId, member.userId)) continue;
        count++;
        if (count >= MAX_SPACE_ACCESS_REQUESTS) return MAX_SPACE_ACCESS_REQUESTS;
    }
    return count;
}

function spaceAccessMembersLoading(room: Room): boolean {
    return spaceAccessMemberLoads.has(room);
}

function loadSpaceAccessMembers(room: Room): Promise<boolean> {
    const existing = spaceAccessMemberLoads.get(room)?.promise;
    if (existing) return existing;
    if (!matrixClient || !activeCredentials) {
        return Promise.reject(new PublicWorkerError("MATRIX_NOT_STARTED", "The Matrix backend is not started."));
    }
    const entry: SpaceAccessMemberLoad = {
        client: matrixClient,
        generation: clientGeneration,
        userId: activeCredentials.userId
    };
    spaceAccessMemberLoads.set(room, entry);
    entry.promise = Promise.resolve()
        .then(() => room.loadMembersIfNeeded())
        .finally(() => {
            if (spaceAccessMemberLoads.get(room) !== entry) return;
            spaceAccessMemberLoads.delete(room);
            if (matrixClient === entry.client && clientGeneration === entry.generation
                && activeCredentials?.userId === entry.userId) {
                // Membership/name/power listeners are coalesced while the OOB
                // load runs. Publish one authoritative post-hydration delta,
                // including any live change which arrived during that window.
                safeListener(() => emitRoom(room));
            }
        });
    return entry.promise;
}

function disposeSpaceAccessMemberHydrations(): void {
    spaceAccessMemberLoads.clear();
}

function recentRoomMessages(
    room: Room,
    reactionMap: Map<string, MatrixReactionDTO[]>,
    limit: number
): MatrixMessageDTO[] {
    if (limit <= 0) return [];
    const events = room.getLiveTimeline().getEvents();
    const messages: MatrixMessageDTO[] = [];
    // Relations/state events can be interleaved with messages. Bound the scan
    // independently of an unusually large in-memory timeline.
    const firstIndex = Math.max(0, events.length - Math.max(limit * 10, 1_000));
    for (let index = events.length - 1; index >= firstIndex && messages.length < limit; index--) {
        const event = events[index];
        const eventId = event.getId();
        const message = normalizeMessage(room, event, eventId ? reactionMap.get(eventId) : undefined);
        if (message) messages.push(message);
    }
    // The SDK timeline is authoritative. Homeserver timestamps are metadata,
    // not an ordering key: clock skew and equal timestamps are both legal.
    return messages.reverse();
}

function normalizeRoom(
    room: Room,
    directRooms = directAccountData().roomToUser,
    parentMap = inferredSpaceParents(),
    includeMessages: boolean | number = true,
    memberLimit = MAX_ROOM_MEMBERS
): MatrixRoomDTO {
    const membership = room.getMyMembership();
    if (membership !== "join" && membership !== "invite") {
        fail("MATRIX_ROOM_NOT_VISIBLE", "The Matrix room is neither joined nor invited.");
    }
    const messageLimit = includeMessages === true
        ? MAX_TIMELINE_MESSAGES
        : includeMessages === false ? 0 : Math.max(0, Math.min(MAX_TIMELINE_MESSAGES, includeMessages));
    const reactionMap = membership === "join" && messageLimit > 0
        ? buildReactionMap(room)
        : new Map<string, MatrixReactionDTO[]>();
    const messages = membership === "join" && messageLimit > 0
        ? recentRoomMessages(room, reactionMap, messageLimit)
        : [];
    const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
    const topicContent = topicEvent?.getContent<Record<string, any>>();
    const groupChat = groupChatRoomIdentity(room) != null;
    const spaceChildren = groupChat ? [] : projectableSpaceChildren(room);
    const roomType = publicRoomText(room.getType(), 256);
    const parentIds = groupChat ? [] : [...new Set([...localSpaceParents(room), ...(parentMap.get(room.roomId) ?? [])])]
        .sort()
        .slice(0, 1_000);
    const result: MatrixRoomDTO = {
        roomId: room.roomId,
        timelineGeneration: timelineGenerations.get(room) ?? 0,
        name: publicRoomText(room.name, 256) || publicRoomText(room.getCanonicalAlias(), 256) || room.roomId,
        membership,
        kind: groupChat ? "room" : roomKind(room, directRooms),
        joinRule: normalizeJoinRule(room.getJoinRule()) ?? "invite",
        parentIds,
        childIds: spaceChildren.map(child => child.roomId),
        spaceChildren,
        encrypted: room.hasEncryptionStateEvent(),
        // Bounded snapshots must retain self and the highest-power candidates;
        // otherwise Discord can project the wrong identity or a nonexistent
        // guild owner in large Spaces.
        members: prioritizedRoomMembers(room)
            .slice(0, Math.max(0, Math.min(MAX_ROOM_MEMBERS, memberLimit)))
            .map(normalizeMember)
            .filter((member): member is MatrixMemberDTO => member != null),
        messages,
        unreadCount: boundedNotificationCount(room.getUnreadNotificationCount()),
        highlightCount: boundedNotificationCount(room.getUnreadNotificationCount(NotificationCountType.Highlight))
    };

    if (roomType) result.roomType = roomType;
    if (groupChat) {
        result.groupChat = true;
        if (membership === "join") result.invitePermission = spaceInvitePermission(room);
    }
    const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
    const creatorId = createEvent && !Array.isArray(createEvent) ? optionalUserId(createEvent.getSender()) : undefined;
    if (creatorId) result.creatorId = creatorId;
    if (result.kind === "space") {
        const childPermission = spaceChildPermission(room);
        result.canManageSpaceChildren = childPermission.allowed;
        result.spaceChildPermission = childPermission;
        if (membership === "join") {
            const permissions = spaceAccessPermissions(room);
            const invitePermission = spaceInvitePermission(room);
            result.invitePermission = invitePermission;
            result.canConfigureSpaceAccess = canConfigureSpaceAccess(room);
            result.accessRequestCount = currentSpaceAccessRequestCount(room);
            result.accessRequestCountComplete = room.membersLoaded();
            result.canApproveAccessRequests = permissions.canApprove && invitePermission.allowed;
            result.canDenyAccessRequests = permissions.canDeny;
        }
    }
    const directUserId = roomDirectUserId(room, directRooms);
    if (directUserId) result.directUserId = directUserId;
    const inviterId = roomInviterId(room);
    if (inviterId) result.inviterId = inviterId;
    const avatarUrl = mediaUrl(room.getMxcAvatarUrl(), 96, 96);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    const topic = publicRoomText(topicContent?.topic, 2_048);
    if (topic) result.topic = topic;
    const prevToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
    if (prevToken) result.prevToken = prevToken;
    return result;
}

function publicRoomText(value: unknown, maximum: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
    return text || undefined;
}

function normalizePublicRoom(value: unknown): MatrixPublicRoomDTO {
    if (!value || typeof value !== "object") fail("MATRIX_INVALID_DIRECTORY_ENTRY", "The room directory entry is invalid.");
    const room = value as Record<string, unknown>;
    const roomId = validateRoomId(room.room_id);
    const alias = publicRoomText(room.canonical_alias, 1_024);
    const result: MatrixPublicRoomDTO = {
        roomId,
        name: publicRoomText(room.name, 256) || alias || roomId,
        joinedMembers: Number.isSafeInteger(room.num_joined_members) && Number(room.num_joined_members) >= 0
            ? Number(room.num_joined_members)
            : 0,
        worldReadable: room.world_readable === true,
        guestCanJoin: room.guest_can_join === true
    };
    if (alias && /^#[^\s:]+:[^\s]+$/u.test(alias)) result.alias = alias;
    const topic = publicRoomText(room.topic, 2_048);
    if (topic) result.topic = topic;
    if (room.join_rule === "public" || room.join_rule === "knock") result.joinRule = room.join_rule;
    const roomType = publicRoomText(room.room_type, 256);
    if (roomType) result.roomType = roomType;
    const avatarUrl = mediaUrl(publicRoomText(room.avatar_url, 2_048), 96, 96);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    return result;
}

function visibleRooms(): Room[] {
    return matrixClient?.getRooms().filter(room => {
        const membership = room.getMyMembership();
        return !pendingHiddenRooms.has(room.roomId) && (membership === "join" || membership === "invite");
    }) ?? [];
}

function snapshot(): MatrixSnapshot {
    const directRooms = directAccountData().roomToUser;
    const parentMap = inferredSpaceParents();
    let messagesRemaining = MAX_SNAPSHOT_MESSAGES;
    let membersRemaining = MAX_SNAPSHOT_MEMBERS;
    let messageJsonRemaining = MAX_SNAPSHOT_MESSAGE_JSON_CHARS;
    const rooms = visibleRooms().slice(0, MAX_SNAPSHOT_ROOMS).map(room => {
        const normalized = normalizeRoom(
            room,
            directRooms,
            parentMap,
            messageJsonRemaining > 0 ? Math.min(25, messagesRemaining) : 0,
            Math.min(100, membersRemaining)
        );
        membersRemaining -= normalized.members.length;
        const boundedMessages: MatrixMessageDTO[] = [];
        // Keep one contiguous newest suffix. Skipping a middle event and then
        // including a smaller newer one would create a gap that backward-only
        // pagination can never recover from.
        for (const message of [...normalized.messages].reverse()) {
            let size: number;
            try {
                size = JSON.stringify(message).length;
            } catch {
                break;
            }
            if (size > messageJsonRemaining) break;
            messageJsonRemaining -= size;
            messagesRemaining--;
            boundedMessages.unshift(message);
        }
        normalized.messages = boundedMessages;
        return normalized;
    });
    return {
        seq: 0,
        revision: workerRevision,
        status: statusDTO(),
        account: accountDTO(),
        rooms
    };
}

function getRoom(roomId: string): Room {
    validateRoomId(roomId);
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const room = matrixClient.getRoom(roomId);
    if (!room || room.getMyMembership() !== "join") fail("MATRIX_ROOM_NOT_JOINED", "The Matrix room is not joined.");
    return room;
}

function emitRoom(room: Room): void {
    if (pendingHiddenRooms.has(room.roomId)) return;
    const membership = room.getMyMembership();
    if (membership !== "join" && membership !== "invite") return;
    // Room deltas update metadata. The renderer merges this empty message list
    // into its bounded room history, avoiding repeated serialization of the
    // entire timeline for name/member/unread/state changes.
    emit({ type: "room", room: normalizeRoom(room, undefined, undefined, false) });
}

function observeRoom(room: Room): void {
    if (observedRooms.has(room)) return;
    observedRooms.add(room);
    const client = matrixClient;
    const generation = clientGeneration;
    const guarded = (callback: () => void) => safeListener(() => {
        if (client && matrixClient === client && clientGeneration === generation) callback();
    });
    room.on(RoomEvent.CurrentStateUpdated, () => guarded(() => {
        if (!spaceAccessMembersLoading(room)) emitRoom(room);
    }));
    room.on(RoomEvent.UnreadNotifications, () => guarded(() => emitRoom(room)));
    room.on(RoomEvent.TimelineReset, (_emittedRoom, timelineSet) => guarded(() => {
        if (!isMainMatrixTimelineReset(room, timelineSet)) return;
        invalidateReactionMap(room);
        clearReactionTargets(room.roomId);
        timelineGenerations.set(room, (timelineGenerations.get(room) ?? 0) + 1);
        for (const [cursor, state] of historyCursors) {
            if (state.roomId === room.roomId) historyCursors.delete(cursor);
        }
        // Include the new bounded live window. The renderer keys history by the
        // generation above, replaces stale remote segments, and keeps local
        // pending/failed echoes recoverable.
        emit({ type: "room", room: normalizeRoom(room) });
    }));
}

function emitReactions(room: Room, eventId: string): void {
    const reactions = buildReactionMap(room).get(eventId) ?? [];
    emit({ type: "reaction", roomId: room.roomId, eventId, reactions });
}

function convergeReactions(room: Room, eventId: string): void {
    invalidateReactionMap(room);
    try { emitReactions(room, eventId); } catch { }
}

function handleTimelineEvent(event: MatrixEvent, room: Room | undefined, removed = false): void {
    if (!room || room.getMyMembership() !== "join") {
        liveDecryptionEvents.discard(event);
        return;
    }
    const eventId = optionalTimelineEventId(room, event);
    if (!eventId) {
        liveDecryptionEvents.discard(event);
        return;
    }

    if (removed || event.status === "cancelled") {
        liveDecryptionEvents.discard(event);
        emit({ type: "redact", roomId: room.roomId, eventId });
        return;
    }

    // Event mapping starts decryption asynchronously. Remember the live slot
    // before inspecting its decrypted type/relation so Decrypted can insert it
    // rather than treating it like detached history or an update-only retry.
    if (event.getWireType() === EventType.RoomMessageEncrypted
        && event.getType() === EventType.RoomMessageEncrypted) {
        liveDecryptionEvents.mark(event);
        return;
    }

    const type = event.getType();
    const relation = relationContent(event);
    const relationTargetId = optionalEventId(relation?.event_id);
    if (type === EventType.Reaction && relation?.rel_type === RelationType.Annotation
        && relationTargetId) {
        invalidateReactionMap(room);
        rememberReactionTarget(eventId, room.roomId, relationTargetId);
        emitReactions(room, relationTargetId);
        return;
    }

    if (relation?.rel_type === RelationType.Replace && relationTargetId) {
        const target = room.findEventById(relationTargetId);
        emit({
            type: "edit",
            roomId: room.roomId,
            eventId: relationTargetId,
            message: target ? normalizeMessage(room, target, buildReactionMap(room).get(relationTargetId)) ?? undefined : undefined
        });
        return;
    }

    const message = normalizeMessage(room, event, buildReactionMap(room).get(eventId));
    if (message) emit({ type: "message", roomId: room.roomId, message });
}

function attachClientListeners(client: MatrixClient): void {
    const generation = clientGeneration;
    const guarded = (callback: () => void) => safeListener(() => {
        if (matrixClient === client && clientGeneration === generation) callback();
    });
    client.on(ClientEvent.Sync, (state, _previous, data) => guarded(() => {
        lastSyncState = state;
        switch (state) {
            case SyncState.Prepared:
                setStatus("ready");
                emit({ type: "snapshot", snapshot: snapshot() });
                break;
            case SyncState.Syncing:
                setStatus(workerState === "starting" ? "syncing" : "ready");
                break;
            case SyncState.Catchup:
            case SyncState.Reconnecting:
                setStatus("syncing");
                break;
            case SyncState.Error:
                setStatus("error", publicError(data?.error));
                break;
            case SyncState.Stopped:
                if (activeCredentials) setStatus("stopped");
                break;
        }
    }));

    client.on(ClientEvent.Room, room => guarded(() => {
        observeRoom(room);
        const membership = room.getMyMembership();
        if (membership === "join" || membership === "invite") {
            pendingHiddenRooms.delete(room.roomId);
            emitRoom(room);
        } else {
            emit({ type: "snapshot", snapshot: snapshot() });
        }
    }));
    client.on(ClientEvent.DeleteRoom, roomId => guarded(() => {
        forgetResolvedSpaceAccessRequestsForRoom(roomId);
        emit({ type: "snapshot", snapshot: snapshot() });
    }));
    client.on(ClientEvent.AccountData, event => guarded(() => {
        if (event.getType() === EventType.Direct) emit({ type: "snapshot", snapshot: snapshot() });
    }));
    client.on(RoomEvent.Timeline, (event, room, toStart, removed) => guarded(() => {
        // Historical pages are returned explicitly by paginate(); replaying
        // every inserted old event as a live delta duplicates work and can
        // flood the native queue.
        if (!toStart) handleTimelineEvent(event, room, removed);
    }));
    client.on(RoomEvent.LocalEchoUpdated, (event, room) => guarded(() => handleTimelineEvent(event, room)));
    client.on(MatrixEventEvent.Decrypted, event => guarded(() => {
        const disposition = liveDecryptionEvents.consume(event, isolatedDecryptionEvents.has(event));
        const recoveredLiveFailure = !event.isDecryptionFailure()
            && liveDecryptionEvents.consumeFailure(event);
        if (disposition === "isolated" && !recoveredLiveFailure) return;
        const room = client.getRoom(event.getRoomId());
        if (!room || room.getMyMembership() !== "join") return;
        if (disposition === "live") {
            isolatedDecryptionEvents.delete(event);
            // Re-run the complete live-event path so encrypted reactions and
            // replacements converge alongside ordinary messages/placeholders.
            if (event.isDecryptionFailure()) liveDecryptionEvents.markFailure(event);
            handleTimelineEvent(event, room);
            return;
        }
        const message = normalizeMessage(room, event, buildReactionMap(room).get(event.getId() ?? ""));
        if (recoveredLiveFailure && !message) {
            // A failed live relation temporarily occupied its own message slot.
            // Remove that placeholder, then apply the revealed relation once.
            const eventId = optionalTimelineEventId(room, event);
            if (eventId) emit({ type: "redact", roomId: room.roomId, eventId });
            handleTimelineEvent(event, room);
            return;
        }
        if (!message) return;
        // Decryption changes an existing placeholder. Model it as update-only;
        // an older event discovered by search must never be appended as live.
        emit({ type: "edit", roomId: room.roomId, eventId: message.eventId, message });
    }));
    client.on(MatrixEventEvent.Replaced, event => guarded(() => {
        const room = client.getRoom(event.getRoomId());
        if (!room) return;
        const eventId = optionalEventId(event.getId());
        if (!eventId) return;
        emit({
            type: "edit",
            roomId: room.roomId,
            eventId,
            message: normalizeMessage(room, event, buildReactionMap(room).get(eventId)) ?? undefined
        });
    }));
    client.on(RoomEvent.Redaction, (redaction, room) => guarded(() => {
        invalidateReactionMap(room);
        const redactedId = optionalEventId(redaction.getAssociatedId());
        if (!redactedId) return;
        const rememberedReaction = reactionTargets.get(redactedId);
        const redactedEvent = room.findEventById(redactedId);
        const redactedRelation = redactedEvent ? relationContent(redactedEvent) : undefined;
        const derivedTargetId = redactedEvent?.getType() === EventType.Reaction
            && redactedRelation?.rel_type === RelationType.Annotation
            ? optionalEventId(redactedRelation.event_id)
            : undefined;
        const reactionTargetId = rememberedReaction?.roomId === room.roomId
            ? rememberedReaction.eventId
            : derivedTargetId;
        if (reactionTargetId) {
            reactionTargets.delete(redactedId);
            emitReactions(room, reactionTargetId);
        } else {
            emit({ type: "redact", roomId: room.roomId, eventId: redactedId });
        }
    }));
    client.on(RoomEvent.Name, room => guarded(() => {
        if (!spaceAccessMembersLoading(room)) emitRoom(room);
    }));
    client.on(RoomEvent.MyMembership, room => guarded(() => {
        const membership = room.getMyMembership();
        if (membership === "join" || membership === "invite") pendingHiddenRooms.delete(room.roomId);
        else forgetResolvedSpaceAccessRequestsForRoom(room.roomId);
        emit({ type: "snapshot", snapshot: snapshot() });
    }));
    client.on(RoomMemberEvent.Membership, (_event, member) => guarded(() => {
        forgetResolvedSpaceAccessRequest(member.roomId, member.userId);
        const room = client.getRoom(member.roomId);
        if (room && !spaceAccessMembersLoading(room)) emitRoom(room);
    }));
    client.on(RoomMemberEvent.Name, (_event, member) => guarded(() => {
        const room = client.getRoom(member.roomId);
        if (room && !spaceAccessMembersLoading(room)) emitRoom(room);
    }));
    client.on(RoomMemberEvent.PowerLevel, (_event, member) => guarded(() => {
        const room = client.getRoom(member.roomId);
        if (room && !spaceAccessMembersLoading(room)) emitRoom(room);
    }));
    client.on(RoomMemberEvent.Typing, (_event, member) => guarded(() => {
        const room = client.getRoom(member.roomId);
        if (!room) return;
        emit({
            type: "typing",
            roomId: room.roomId,
            userIds: [...new Set(room.getMembers()
                .filter(candidate => candidate.typing)
                .map(candidate => optionalUserId(candidate.userId))
                .filter((userId): userId is string => userId != null))]
                .sort()
                .slice(0, 2_000)
        });
    }));
    client.on(RoomEvent.Receipt, (receipt, room) => guarded(() => {
        const content = receipt.getContent<Record<string, any>>();
        let emitted = 0;
        for (const [rawEventId, receipts] of Object.entries(content)) {
            const eventId = optionalEventId(rawEventId);
            if (!eventId) continue;
            if (!receipts || typeof receipts !== "object") continue;
            for (const receiptType of ["m.read", "m.read.private"]) {
                const users = (receipts as Record<string, any>)[receiptType];
                if (!users || typeof users !== "object") continue;
                for (const rawUserId of Object.keys(users)) {
                    const userId = optionalUserId(rawUserId);
                    if (!userId) continue;
                    emit({ type: "receipt", roomId: room.roomId, userId, eventId });
                    if (++emitted >= 128) return;
                }
            }
        }
    }));
}

async function disposeClient(clearStores: boolean): Promise<void> {
    clientGeneration++;
    disposeSpaceAccessMemberHydrations();
    historyCursors.clear();
    searchCursors.clear();
    searchEventCache.clear();
    groupChatDirectoryCandidates.clear();
    groupChatExactLookupTimestamps.length = 0;
    const client = matrixClient;
    const store = matrixStore;
    const prefix = cryptoDatabasePrefix;
    matrixClient = null;
    matrixStore = null;
    cryptoDatabasePrefix = null;
    activeCredentials = null;
    lastSyncState = null;
    reactionTargets.clear();
    publicDirectoryTargets.clear();
    spaceHierarchyTargets.clear();
    spaceHierarchyRelationTargets.clear();
    pendingHiddenRooms.clear();
    resolvedSpaceAccessRequests.clear();
    urlPreviewMedia.clear();
    if (!client) {
        await store?.destroy();
        return;
    }

    // Suppress transient SyncState.Stopped events during intentional teardown.
    // The main process owns the externally visible logout state transition.
    client.removeAllListeners();
    client.stopClient();
    if (clearStores && prefix) {
        try {
            await client.clearStores({ cryptoDatabasePrefix: prefix });
        } finally {
            // clearStores deletes sync data but does not close the IndexedDB
            // store itself, which otherwise leaks a live connection on relogin.
            await store?.destroy();
        }
    } else {
        // stopClient closes Rust crypto, but not the separate sync IndexedDB store.
        await store?.destroy();
    }
}

async function suspend(): Promise<void> {
    const hadAccount = activeCredentials != null;
    await disposeClient(false);
    setStatus(hadAccount ? "stopped" : "logged_out");
}

async function startAuthenticated(
    accountInput: MatrixStoredAccount,
    progress: (stage: MatrixWorkerStartupStage) => void
): Promise<MatrixSnapshot> {
    const account = validateCredentials(accountInput);
    if (matrixClient && activeCredentials
        && activeCredentials.homeserver === account.homeserver
        && activeCredentials.userId === account.userId
        && activeCredentials.deviceId === account.deviceId
        && (lastSyncState === SyncState.Prepared
            || lastSyncState === SyncState.Syncing
            || lastSyncState === SyncState.Catchup
            || lastSyncState === SyncState.Reconnecting)
        && (workerState === "ready" || workerState === "syncing")) {
        return snapshot();
    }

    await disposeClient(false);
    if (!window.isSecureContext || !window.indexedDB) {
        fail("MATRIX_PERSISTENCE_UNAVAILABLE", "A secure origin with IndexedDB is required for Matrix encryption.");
    }

    setStatus("starting");
    const prefix = await databaseName(account);
    const store = new IndexedDBStore({
        indexedDB: window.indexedDB,
        localStorage: window.localStorage,
        dbName: `${prefix}-sync`
    });

    const generation = clientGeneration;
    const startupLogger = startupProgressLogger(progress);
    // MatrixClient.refreshToken() uses that client's authed HTTP pipeline. If
    // the current access token is already invalid, invoking it from the same
    // client's TokenRefresher can recursively wait on its own in-flight refresh
    // promise. A credential-free client sends /refresh without the stale bearer
    // and retains the SDK's bounded HTTP handling without bypassing sync/crypto.
    const refreshClient = createClient({
        baseUrl: account.homeserver,
        logger: silentLogger,
        localTimeoutMs: 30_000,
        disableVoip: true
    });
    let sessionIdentityValidated = false;
    let startupRefreshAttempted = false;
    let pendingRefreshedCredentials: MatrixCredentialUpdate | undefined;
    const refreshTokens = async (refreshToken: string) => {
        if (matrixClient !== client || clientGeneration !== generation) {
            fail("MATRIX_SESSION_CHANGED", "The Matrix account changed while refreshing its session.");
        }
        // Refresh tokens may rotate even when their response is lost. Record
        // the attempt before dispatch so a later transient-looking failure is
        // never replayed automatically as if this startup were read-only.
        startupRefreshAttempted = true;
        const result = await refreshClient.refreshToken(refreshToken);
        if (matrixClient !== client || clientGeneration !== generation) {
            fail("MATRIX_SESSION_CHANGED", "The Matrix account changed while refreshing its session.");
        }
        const accessToken = validateString(result?.access_token, "accessToken", 65_536);
        const nextRefreshToken = result?.refresh_token == null
            ? refreshToken
            : validateString(result.refresh_token, "refreshToken", 65_536);
        const expiresInMs = Number.isSafeInteger(result?.expires_in_ms) && result.expires_in_ms >= 0
            && result.expires_in_ms <= 8_640_000_000_000_000 - Date.now()
            ? result.expires_in_ms
            : undefined;
        const credentials: MatrixCredentialUpdate = {
            homeserver: account.homeserver,
            userId: account.userId,
            deviceId: account.deviceId,
            accessToken,
            refreshToken: nextRefreshToken
        };
        if (sessionIdentityValidated) {
            await window.MatrixBridgeWorkerHost.saveCredentials(credentials);
            if (matrixClient !== client || clientGeneration !== generation) {
                fail("MATRIX_SESSION_CHANGED", "The Matrix account changed while refreshing its session.");
            }
            activeCredentials = credentials;
        } else {
            // getVersions can refresh before we know that the replacement token
            // still belongs to this exact encrypted user/device. Stage it in the
            // isolated worker and commit only after the authenticated whoami.
            pendingRefreshedCredentials = credentials;
        }
        return {
            accessToken,
            refreshToken: nextRefreshToken,
            ...(expiresInMs == null ? {} : { expiry: new Date(Date.now() + expiresInMs) })
        };
    };

    const client = createClient({
        baseUrl: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        tokenRefreshFunction: account.refreshToken ? refreshTokens : undefined,
        store,
        timelineSupport: true,
        logger: startupLogger,
        localTimeoutMs: 30_000,
        disableVoip: true
    });
    matrixClient = client;
    matrixStore = store;
    cryptoDatabasePrefix = prefix;
    activeCredentials = {
        homeserver: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken
    };

    try {
        progress("store");
        await store.startup();
        progress("session");
        await client.getVersions();
        const identity = await client.whoami();
        if (validateUserId(identity.user_id) !== account.userId
            || validateString(identity.device_id, "deviceId", 512) !== account.deviceId) {
            fail("MATRIX_CREDENTIAL_MISMATCH", "The Matrix session did not match its encrypted device.");
        }
        if (pendingRefreshedCredentials) {
            await window.MatrixBridgeWorkerHost.saveCredentials(pendingRefreshedCredentials);
            if (matrixClient !== client || clientGeneration !== generation) {
                fail("MATRIX_SESSION_CHANGED", "The Matrix account changed while validating its refreshed session.");
            }
            activeCredentials = pendingRefreshedCredentials;
            pendingRefreshedCredentials = undefined;
        }
        sessionIdentityValidated = true;
        progress("crypto-module");
        await client.initRustCrypto({
            useIndexedDB: true,
            cryptoDatabasePrefix: prefix,
            storageKey: decodeStorageKey(account.storageKey)
        });
        attachClientListeners(client);
        for (const room of client.getRooms()) observeRoom(room);
        setStatus("syncing");
        progress("client");
        await client.startClient({
            initialSyncLimit: 50,
            lazyLoadMembers: true
        });
        return snapshot();
    } catch (error) {
        await disposeClient(false);
        let safeError = publicError(error);
        if (!sessionIdentityValidated && startupRefreshAttempted
            && (safeError.code === "MATRIX_NETWORK_ERROR"
                || safeError.code === "MATRIX_REQUEST_TIMEOUT"
                || safeError.code === "MATRIX_SERVER_UNAVAILABLE")) {
            safeError = {
                code: "MATRIX_STARTUP_REFRESH_AMBIGUOUS",
                message: "Matrix could not confirm whether its saved-session refresh completed. Reconnect manually after checking the homeserver."
            };
        }
        setStatus("error", safeError);
        throw new PublicWorkerError(safeError.code, safeError.message);
    }
}

async function login(command: Extract<MatrixWorkerCommand, { type: "login"; }>): Promise<MatrixWorkerResult> {
    if (matrixClient || activeCredentials) fail("MATRIX_ALREADY_CONFIGURED", "Log out of the current Matrix account before logging in again.");
    const { login: input } = command;
    const homeserver = validateHomeserver(input.homeserver);
    const password = input.method === "password" ? validateString(input.password, "password", 65_536) : undefined;
    const token = input.method === "access_token" ? validateString(input.accessToken, "accessToken", 65_536) : undefined;
    const username = input.method === "password" ? validateUsername(input.username) : undefined;

    setStatus("starting");
    const loginClient = createClient({
        baseUrl: homeserver,
        logger: silentLogger,
        localTimeoutMs: 30_000,
        disableVoip: true,
        ...(token ? { accessToken: token } : {})
    });

    let credentials: MatrixSessionCredentials;
    try {
        if (password) {
            const response = await loginClient.loginRequest({
                type: "m.login.password",
                identifier: { type: "m.id.user", user: username! },
                password,
                initial_device_display_name: "Discord Matrix Bridge",
                refresh_token: true
            });
            credentials = {
                homeserver,
                userId: response.user_id,
                deviceId: response.device_id,
                accessToken: response.access_token,
                refreshToken: response.refresh_token
            };
        } else {
            const response = await loginClient.whoami();
            if (!response.device_id) fail("MATRIX_DEVICE_ID_MISSING", "This access token has no Matrix device ID and cannot be used for encrypted rooms.");
            credentials = {
                homeserver,
                userId: response.user_id,
                deviceId: response.device_id,
                accessToken: token!
            };
        }
    } catch (error) {
        throwAuthenticationError(error, password ? "password" : "access_token");
    }

    credentials.userId = validateUserId(credentials.userId);
    credentials.deviceId = validateString(credentials.deviceId, "deviceId", 512);
    credentials.accessToken = validateString(credentials.accessToken, "accessToken", 65_536);
    return { credentials };
}

async function reauthenticate(
    command: Extract<MatrixWorkerCommand, { type: "reauthenticate"; }>
): Promise<MatrixWorkerResult> {
    if (matrixClient || activeCredentials) {
        fail("MATRIX_ALREADY_CONFIGURED", "Stop the existing Matrix session before reauthenticating it.");
    }
    const input = validateReauthentication(command.reauthentication);
    setStatus("starting");
    const client = createClient({
        baseUrl: input.homeserver,
        logger: silentLogger,
        localTimeoutMs: 30_000,
        disableVoip: true,
        ...(input.method === "access_token" ? { accessToken: input.accessToken } : {})
    });

    let credentials: MatrixSessionCredentials;
    try {
        if (input.method === "password") {
            const response = await client.loginRequest({
                type: "m.login.password",
                identifier: { type: "m.id.user", user: input.userId },
                password: input.password,
                device_id: input.deviceId,
                initial_device_display_name: "Discord Matrix Bridge",
                refresh_token: true
            });
            credentials = {
                homeserver: input.homeserver,
                userId: validateUserId(response.user_id),
                deviceId: validateString(response.device_id, "deviceId", 512),
                accessToken: validateString(response.access_token, "accessToken", 65_536),
                refreshToken: response.refresh_token == null
                    ? undefined
                    : validateString(response.refresh_token, "refreshToken", 65_536)
            };
        } else {
            const response = await client.whoami();
            credentials = {
                homeserver: input.homeserver,
                userId: validateUserId(response.user_id),
                deviceId: validateString(response.device_id, "deviceId", 512),
                accessToken: input.accessToken
            };
        }
    } catch (error) {
        throwAuthenticationError(error, input.method);
    }

    if (credentials.userId !== input.userId || credentials.deviceId !== input.deviceId) {
        fail("MATRIX_REAUTH_IDENTITY_MISMATCH", "The new Matrix session did not match the existing encrypted device.");
    }
    return { credentials };
}

interface RegistrationAuthData {
    session?: unknown;
    completed?: unknown;
    flows?: unknown;
    errcode?: unknown;
}

const REGISTRATION_TOKEN_STAGES = new Set([
    "m.login.registration_token",
    "org.matrix.msc3231.login.registration_token"
]);
const SUPPORTED_REGISTRATION_STAGES = new Set([...REGISTRATION_TOKEN_STAGES, "m.login.dummy"]);

function registrationAuthData(error: unknown): RegistrationAuthData | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as { httpStatus?: unknown; data?: unknown; };
    if (candidate.httpStatus !== 401 || !candidate.data || typeof candidate.data !== "object") return undefined;
    return candidate.data as RegistrationAuthData;
}

function registrationFlow(data: RegistrationAuthData): string[] {
    const flows = Array.isArray(data.flows) ? data.flows : [];
    for (const candidate of flows) {
        if (!candidate || typeof candidate !== "object") continue;
        const { stages } = (candidate as { stages?: unknown; });
        if (!Array.isArray(stages) || !stages.every(stage => typeof stage === "string")) continue;
        if (stages.some(stage => REGISTRATION_TOKEN_STAGES.has(stage))
            && stages.every(stage => SUPPORTED_REGISTRATION_STAGES.has(stage))) {
            return stages;
        }
    }
    fail("MATRIX_REGISTRATION_FLOW_UNSUPPORTED", "This homeserver requires an additional registration step that this bridge cannot display.");
}

async function registerWithToken(
    client: MatrixClient,
    username: string,
    password: string,
    registrationToken: string
) {
    const body = {
        username,
        password,
        refresh_token: true,
        inhibit_login: false,
        initial_device_display_name: "Discord Matrix Bridge"
    };
    let session: string | undefined;
    let stage: string | undefined;
    let flow: string[] | undefined;
    let completed = new Set<string>();

    for (let attempt = 0; attempt < 6; attempt++) {
        const submittedStage = stage;
        const auth: Record<string, string> | undefined = stage ? { type: stage } : undefined;
        if (auth && session) auth.session = session;
        if (auth && REGISTRATION_TOKEN_STAGES.has(stage!)) auth.token = registrationToken;
        try {
            return await client.registerRequest({ ...body, ...(auth ? { auth: auth as any } : {}) });
        } catch (error) {
            const data = registrationAuthData(error);
            if (!data) throw error;

            if (data.session != null) {
                const nextSession = validateString(data.session, "registration session", 2_048);
                if (session && nextSession !== session) {
                    fail("MATRIX_REGISTRATION_FAILED", "The homeserver changed the registration session unexpectedly.");
                }
                session = nextSession;
            }
            if (!session) fail("MATRIX_REGISTRATION_FAILED", "The homeserver did not provide a registration session.");
            if (!flow && Array.isArray(data.flows)) flow = registrationFlow(data);
            if (!flow) fail("MATRIX_REGISTRATION_FAILED", "The homeserver returned an incomplete registration flow.");

            if (Array.isArray(data.completed)) {
                const nextCompleted = new Set(data.completed.filter((value): value is string => typeof value === "string"));
                if ([...completed].some(value => !nextCompleted.has(value))) {
                    fail("MATRIX_REGISTRATION_FAILED", "The homeserver regressed the registration flow unexpectedly.");
                }
                completed = nextCompleted;
            }
            if (submittedStage && !completed.has(submittedStage) && data.errcode) {
                const tokenStage = REGISTRATION_TOKEN_STAGES.has(submittedStage);
                fail(
                    tokenStage ? "MATRIX_REGISTRATION_TOKEN_REJECTED" : "MATRIX_REGISTRATION_FAILED",
                    tokenStage
                        ? "The registration token was rejected or has expired."
                        : "The homeserver rejected account registration."
                );
            }
            const nextStage = flow.find(candidate => !completed.has(candidate));
            if (!nextStage) fail("MATRIX_REGISTRATION_FAILED", "The homeserver did not finish account registration.");
            stage = nextStage;
        }
    }
    fail("MATRIX_REGISTRATION_FAILED", "The homeserver did not finish account registration.");
}

async function registerAccount(command: Extract<MatrixWorkerCommand, { type: "register"; }>): Promise<MatrixWorkerResult> {
    if (matrixClient || activeCredentials) fail("MATRIX_ALREADY_CONFIGURED", "Log out of the current Matrix account before registering.");
    const input = command.registration;
    const homeserver = validateHomeserver(input.homeserver);
    const username = validateUsername(input.username);
    const password = validateString(input.password, "password", 65_536);
    const registrationToken = validateRegistrationToken(input.registrationToken);

    setStatus("starting");
    const registrationClient = createClient({
        baseUrl: homeserver,
        logger: silentLogger,
        localTimeoutMs: 30_000,
        disableVoip: true
    });
    let response: Awaited<ReturnType<MatrixClient["registerRequest"]>>;
    try {
        response = await registerWithToken(registrationClient, username, password, registrationToken);
    } catch (error) {
        const safeError = publicError(error);
        if (safeError.code === "ORG.MATRIX.MSC3866_USER_AWAITING_APPROVAL"
            || safeError.code === "ORG_MATRIX_MSC3866_USER_AWAITING_APPROVAL"
            || safeError.code === "ORG_MATRIX_MSC3866_USER_NOT_APPROVED") {
            fail(
                "MATRIX_ACCOUNT_CREATED_AWAITING_APPROVAL",
                "The account was created, but an administrator must approve it before it can sign in."
            );
        }
        throw new PublicWorkerError(safeError.code, safeError.message);
    }
    if (!response.access_token || !response.device_id) {
        fail("MATRIX_REGISTRATION_LOGIN_MISSING", "The account was created, but the homeserver did not return a login session.");
    }
    const credentials: MatrixSessionCredentials = {
        homeserver,
        userId: validateUserId(response.user_id),
        deviceId: validateString(response.device_id, "deviceId", 512),
        accessToken: validateString(response.access_token, "accessToken", 65_536),
        refreshToken: response.refresh_token == null
            ? undefined
            : validateString(response.refresh_token, "refreshToken", 65_536)
    };
    return { credentials };
}

async function publicRooms(
    _command: Extract<MatrixWorkerCommand, { type: "publicRooms"; }>
): Promise<MatrixPublicRoomDirectoryDTO> {
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");

    const refreshGeneration = ++publicDirectoryRefreshGeneration;
    const deadline = performance.now() + MAX_PUBLIC_DIRECTORY_CRAWL_MS;
    const roomsById = new Map<string, MatrixPublicRoomDTO>();
    const nextPublicDirectoryTargets = new Set<string>();
    const seenTokens = new Set<string>();
    let totalRoomCountEstimate: number | undefined;
    let processedEntries = 0;
    let nextBatch: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_PUBLIC_DIRECTORY_PAGES; page++) {
        const remaining = MAX_PUBLIC_DIRECTORY_ENTRIES - processedEntries;
        if (remaining <= 0) {
            truncated = true;
            break;
        }
        const limit = Math.min(PUBLIC_DIRECTORY_PAGE_SIZE, remaining);
        // Deliberately omit `server`: /publicRooms then reads only the
        // configured homeserver's directory instead of federating a remote
        // directory request.
        const response = await matrixClient.publicRooms({
            limit,
            ...(nextBatch ? { since: nextBatch } : {})
        });
        if (!response || typeof response !== "object" || !Array.isArray(response.chunk)
            || response.chunk.length > limit) {
            fail("MATRIX_DIRECTORY_INVALID", "The homeserver returned an invalid room directory page.");
        }
        if (totalRoomCountEstimate == null
            && Number.isSafeInteger(response.total_room_count_estimate)
            && response.total_room_count_estimate! >= 0
            && response.total_room_count_estimate! <= 1_000_000_000) {
            totalRoomCountEstimate = response.total_room_count_estimate;
        }

        processedEntries += response.chunk.length;
        for (const entry of response.chunk) {
            try {
                const room = normalizePublicRoom(entry);
                // m.space is the one typed room that maps cleanly to Discord's
                // server UI. Unknown custom room types remain unsupported.
                if (room.roomType && room.roomType !== RoomType.Space) continue;
                if (!roomsById.has(room.roomId)) roomsById.set(room.roomId, room);
            } catch {
                // A malformed listing must not hide the rest of the server directory.
            }
        }

        const token = response.next_batch;
        if (token == null || token === "") break;
        if (typeof token !== "string" || token.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(token)
            || seenTokens.has(token)) {
            fail("MATRIX_DIRECTORY_INVALID", "The homeserver returned an invalid room directory cursor.");
        }
        seenTokens.add(token);
        nextBatch = token;
        if (processedEntries >= MAX_PUBLIC_DIRECTORY_ENTRIES
            || page + 1 >= MAX_PUBLIC_DIRECTORY_PAGES
            || performance.now() >= deadline) {
            truncated = true;
            break;
        }
    }

    const rooms = [...roomsById.values()].sort((left, right) => {
        const leftKey = `${left.roomType === RoomType.Space ? "0" : "1"}\0${left.name.toLowerCase()}\0${left.roomId}`;
        const rightKey = `${right.roomType === RoomType.Space ? "0" : "1"}\0${right.name.toLowerCase()}\0${right.roomId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    for (const room of rooms) {
        if (room.joinRule !== "knock") nextPublicDirectoryTargets.add(room.roomId);
    }
    if (refreshGeneration !== publicDirectoryRefreshGeneration) {
        fail("MATRIX_DIRECTORY_REFRESH_SUPERSEDED", "A newer public room directory refresh replaced this request.");
    }
    // Refresh the renderer-visible result and its join authority atomically:
    // a failed crawl keeps the last successfully displayed directory usable.
    publicDirectoryTargets.clear();
    for (const roomId of nextPublicDirectoryTargets) publicDirectoryTargets.add(roomId);
    return {
        rooms,
        truncated,
        ...(totalRoomCountEstimate == null ? {} : { totalRoomCountEstimate })
    };
}

async function joinRoomWithConvergence(
    roomId: string,
    viaServers: string[] | undefined,
    mutationDispatched: () => void
): Promise<MatrixJoinRoomResult> {
    if (matrixClient!.getRoom(roomId)?.getMyMembership() === "join") return { roomId };
    try {
        mutationDispatched();
        const room = await matrixClient!.joinRoom(roomId, viaServers?.length ? { viaServers } : undefined);
        const joinedRoomId = validateRoomId(room.roomId);
        if (joinedRoomId !== roomId) fail("MATRIX_ROOM_JOIN_MISMATCH", "The homeserver joined an unexpected room.");
    } catch (error) {
        if (error instanceof PublicWorkerError && error.code === "MATRIX_ROOM_JOIN_MISMATCH") throw error;
        let converged = false;
        try { converged = await exactOwnJoinedRoom(roomId); } catch { }
        if (!converged) {
            if (isDefinitiveMatrixMutationRejection(error)) {
                fail("MATRIX_ROOM_JOIN_REJECTED", "The Matrix homeserver rejected the room join.");
            }
            fail(
                "MATRIX_ROOM_JOIN_AMBIGUOUS",
                "Matrix could not confirm whether the room was joined. Refresh rooms before trying again."
            );
        }
    }
    pendingHiddenRooms.delete(roomId);
    return { roomId };
}

async function joinRoom(
    command: Extract<MatrixWorkerCommand, { type: "joinRoom"; }>,
    mutationDispatched: () => void
): Promise<MatrixJoinRoomResult> {
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const roomId = validateRoomId(command.roomId);
    const hierarchyServers = hierarchyTargetServers(roomId);
    if (!publicDirectoryTargets.has(roomId) && !hierarchyServers) {
        fail("MATRIX_ROOM_NOT_IN_DIRECTORY", "Refresh the public room directory or its parent space before joining this room.");
    }
    const result = await joinRoomWithConvergence(roomId, hierarchyServers, mutationDispatched);
    removeHierarchyTarget(roomId);
    // MatrixClient.joinRoom may return a placeholder Room before /sync supplies
    // membership, state, and timeline. ClientEvent.Room will emit the real DTO.
    return result;
}

async function joinRoomAddress(
    command: Extract<MatrixWorkerCommand, { type: "joinRoomAddress"; }>,
    mutationDispatched: () => void
): Promise<MatrixJoinRoomResult> {
    if (!matrixClient || !activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const requested = validateRoomAddress(command.address);
    const accountServer = activeServerName();
    if (requested.serverName != null && requested.serverName !== accountServer) {
        fail("MATRIX_ROOM_SERVER_MISMATCH", "Only rooms on the configured Matrix server can be joined.");
    }

    let roomId = requested.address;
    let viaServers: string[] | undefined;
    if (requested.kind === "alias") {
        const resolved = await matrixClient.getRoomIdForAlias(requested.address);
        if (!resolved || typeof resolved !== "object") {
            fail("MATRIX_ALIAS_INVALID", "The homeserver returned an invalid room alias result.");
        }
        const target = validateRoomAddress(resolved.room_id);
        if (target.kind !== "roomId" || (target.serverName != null && target.serverName !== accountServer)) {
            fail("MATRIX_ROOM_SERVER_MISMATCH", "The room alias resolves outside the configured Matrix server.");
        }
        roomId = target.address;
        // Never let an alias response steer the join through arbitrary remote
        // `servers`. The local alias and its local/domainless target are routed
        // only through the active account's Matrix server.
        viaServers = [accountServer];
    }

    return await joinRoomWithConvergence(roomId, viaServers, mutationDispatched);
}

function hierarchySpaceChildren(value: unknown): MatrixSpaceChildDTO[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const children: OrderedSpaceChild[] = [];
    for (const rawEvent of value.slice(0, 1_000)) {
        if (!rawEvent || typeof rawEvent !== "object") continue;
        const event = rawEvent as Record<string, unknown>;
        if (event.type !== EventType.SpaceChild) continue;
        const roomId = optionalRoomId(event.state_key);
        if (!roomId || seen.has(roomId) || !validSpaceVia(event.content)) continue;
        seen.add(roomId);
        const content = event.content as Record<string, unknown>;
        const order = normalizeSpaceOrder(content.order);
        const timestamp = Number.isSafeInteger(event.origin_server_ts) && Number(event.origin_server_ts) >= 0
            ? Number(event.origin_server_ts)
            : 0;
        children.push({
            roomId,
            ...(order != null ? { order } : {}),
            ...(typeof content.suggested === "boolean" ? { suggested: content.suggested } : {}),
            timestamp
        });
    }
    return orderSpaceChildren(children);
}

function knownMembership(value: unknown): MatrixSpaceHierarchyRoomDTO["membership"] {
    return value === "join" || value === "invite" || value === "leave" ? value : undefined;
}

function normalizeHierarchyRoom(
    value: unknown,
    directRooms: Map<string, string>
): MatrixSpaceHierarchyRoomDTO {
    if (!value || typeof value !== "object") {
        fail("MATRIX_HIERARCHY_INVALID", "The homeserver returned an invalid space hierarchy room.");
    }
    const raw = value as Record<string, unknown>;
    const roomId = validateRoomId(raw.room_id);
    const localRoom = matrixClient?.getRoom(roomId) ?? undefined;
    const roomType = publicRoomText(raw.room_type, 256) ?? publicRoomText(localRoom?.getType(), 256);
    const spaceChildren = hierarchySpaceChildren(raw.children_state);
    const membership = knownMembership(localRoom?.getMyMembership()) ?? knownMembership(raw.membership);
    const result: MatrixSpaceHierarchyRoomDTO = {
        roomId,
        name: publicRoomText(raw.name, 256)
            ?? publicRoomText(raw.canonical_alias, 1_024)
            ?? publicRoomText(localRoom?.name, 256)
            ?? roomId,
        kind: roomType === "m.space" || localRoom?.isSpaceRoom()
            ? "space"
            : directRooms.has(roomId) ? "dm" : "room",
        parentIds: localRoom ? localSpaceParents(localRoom) : [],
        childIds: spaceChildren.map(child => child.roomId),
        spaceChildren
    };
    if (roomType) result.roomType = roomType;
    if (membership) result.membership = membership;
    const joinRule = normalizeJoinRule(raw.join_rule) ?? (localRoom ? normalizeJoinRule(localRoom.getJoinRule()) : undefined);
    if (joinRule) result.joinRule = joinRule;
    const topic = publicRoomText(raw.topic, 2_048);
    if (topic) result.topic = topic;
    const avatarUrl = mediaUrl(publicRoomText(raw.avatar_url, 2_048), 96, 96)
        ?? (localRoom ? mediaUrl(localRoom.getMxcAvatarUrl(), 96, 96) : undefined);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    return result;
}

function localHierarchyRoom(room: Room, directRooms: Map<string, string>): MatrixSpaceHierarchyRoomDTO {
    const spaceChildren = projectableSpaceChildren(room);
    const roomType = publicRoomText(room.getType(), 256);
    const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
    const topic = publicRoomText(topicEvent?.getContent<Record<string, unknown>>().topic, 2_048);
    const result: MatrixSpaceHierarchyRoomDTO = {
        roomId: room.roomId,
        name: publicRoomText(room.name, 256) ?? publicRoomText(room.getCanonicalAlias(), 1_024) ?? room.roomId,
        kind: roomKind(room, directRooms),
        membership: knownMembership(room.getMyMembership()),
        joinRule: normalizeJoinRule(room.getJoinRule()),
        parentIds: localSpaceParents(room),
        childIds: spaceChildren.map(child => child.roomId),
        spaceChildren
    };
    if (roomType) result.roomType = roomType;
    if (topic) result.topic = topic;
    const avatarUrl = mediaUrl(room.getMxcAvatarUrl(), 96, 96);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    return result;
}

function hierarchyRoutingServers(value: unknown): Map<string, Map<string, string[]>> {
    const result = new Map<string, Map<string, string[]>>();
    if (!Array.isArray(value)) return result;
    for (const rawRoom of value.slice(0, 200)) {
        if (!rawRoom || typeof rawRoom !== "object") continue;
        const room = rawRoom as Record<string, unknown>;
        const parentId = optionalRoomId(room.room_id);
        if (!parentId || !Array.isArray(room.children_state)) continue;
        for (const rawEvent of room.children_state.slice(0, 1_000)) {
            if (!rawEvent || typeof rawEvent !== "object") continue;
            const event = rawEvent as Record<string, unknown>;
            if (event.type !== EventType.SpaceChild) continue;
            const childId = optionalRoomId(event.state_key);
            const viaServers = spaceViaServers(event.content);
            if (!childId || !viaServers) continue;
            let children = result.get(parentId);
            if (!children) result.set(parentId, children = new Map());
            const knownServers = children.get(childId) ?? [];
            children.set(childId, [...new Set([...knownServers, ...viaServers])].slice(0, 3));
        }
    }
    return result;
}

async function loadSpaceHierarchy(
    space: Room,
    limit: number,
    maxDepth: number
): Promise<MatrixSpaceHierarchyDTO> {
    spaceHierarchyTargets.delete(space.roomId);
    spaceHierarchyRelationTargets.delete(space.roomId);
    const response = await matrixClient!.getRoomHierarchy(space.roomId, limit, maxDepth, false);
    if (!response || !Array.isArray(response.rooms)) {
        fail("MATRIX_HIERARCHY_INVALID", "The homeserver returned an invalid space hierarchy.");
    }

    const directRooms = directAccountData().roomToUser;
    const routingServers = hierarchyRoutingServers(response.rooms);
    const rooms: MatrixSpaceHierarchyRoomDTO[] = [];
    const seen = new Set<string>();
    for (const rawRoom of response.rooms.slice(0, limit)) {
        try {
            const room = normalizeHierarchyRoom(rawRoom, directRooms);
            if (seen.has(room.roomId)) continue;
            seen.add(room.roomId);
            rooms.push(room);
        } catch {
            // One malformed federated child must not hide valid hierarchy rooms.
        }
    }
    if (!seen.has(space.roomId)) {
        if (rooms.length >= limit) rooms.pop();
        rooms.unshift(localHierarchyRoom(space, directRooms));
    }

    const byId = new Map(rooms.map(room => [room.roomId, room]));
    const authorizedTargets = new Map<string, string[]>();
    const authorizedRelations = new Map<string, Map<string, string[]>>();
    for (const parent of rooms) {
        if (parent.kind !== "space") continue;
        const localParent = matrixClient!.getRoom(parent.roomId);
        const localRoutingServers = localParent?.isSpaceRoom()
            ? localSpaceRoutingServers(localParent)
            : undefined;
        for (const child of parent.spaceChildren) {
            const childRoom = byId.get(child.roomId);
            if (!childRoom) continue;
            if (!childRoom.parentIds.includes(parent.roomId) && childRoom.parentIds.length < 1_000) {
                childRoom.parentIds.push(parent.roomId);
            }
            const viaServers = routingServers.get(parent.roomId)?.get(childRoom.roomId)
                ?? localRoutingServers?.get(childRoom.roomId);
            if (viaServers) {
                let parentTargets = authorizedRelations.get(parent.roomId);
                if (!parentTargets) authorizedRelations.set(parent.roomId, parentTargets = new Map());
                parentTargets.set(childRoom.roomId, viaServers);
            }
            if (childRoom.membership === "join" || childRoom.membership === "invite") continue;
            if (childRoom.joinRule === "public"
                || childRoom.joinRule === "restricted"
                || childRoom.joinRule === "knock_restricted") {
                if (viaServers) authorizedTargets.set(childRoom.roomId, viaServers);
            }
        }
    }
    for (const room of rooms) {
        room.parentIds = [...new Set(room.parentIds)].sort().slice(0, 1_000);
    }
    spaceHierarchyTargets.set(space.roomId, authorizedTargets);
    spaceHierarchyRelationTargets.set(space.roomId, authorizedRelations);
    return { spaceId: space.roomId, rooms };
}

async function spaceChildren(
    command: Extract<MatrixWorkerCommand, { type: "spaceChildren"; }>
): Promise<MatrixSpaceHierarchyDTO> {
    const space = getRoom(command.spaceId);
    if (!space.isSpaceRoom()) fail("MATRIX_ROOM_NOT_SPACE", "The selected Matrix room is not a space.");
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 200) : 200;
    const maxDepth = Number.isSafeInteger(command.maxDepth) ? Math.min(Math.max(command.maxDepth, 1), 16) : 8;
    return await loadSpaceHierarchy(space, limit, maxDepth);
}

function suggestedChannelJoinRule(
    value: MatrixRoomJoinRule | undefined
): MatrixSuggestedSpaceChannelDTO["joinRule"] | undefined {
    return value === "public" || value === "restricted" || value === "knock_restricted"
        ? value
        : undefined;
}

async function suggestedSpaceChannelPlanId(
    spaceId: string,
    channels: MatrixSuggestedSpaceChannelDTO[]
): Promise<string> {
    const input = new TextEncoder().encode(JSON.stringify([spaceId, channels]));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return `vcsp_${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function joinedOnboardingSpace(spaceIdValue: unknown): Promise<Room> {
    const spaceId = validateRoomId(spaceIdValue);
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const room = matrixClient.getRoom(spaceId);
    if (!room?.isSpaceRoom()) fail("MATRIX_SPACE_REQUIRED", "The selected Matrix room is not a Space.");
    if (room.getMyMembership() === "join") return room;
    if (!await exactOwnJoinedRoom(spaceId)) {
        fail("MATRIX_ROOM_NOT_JOINED", "The Matrix Space is not joined.");
    }
    // joinRoom can resolve before the sliding/sync membership echo reaches the
    // SDK Room. The authoritative joined-rooms read above permits hierarchy
    // discovery without mutating or trusting that stale local membership.
    return room;
}

async function buildSuggestedSpaceChannelPlan(spaceIdValue: unknown): Promise<MatrixSuggestedSpaceChannelPlanDTO> {
    const root = await joinedOnboardingSpace(spaceIdValue);
    const hierarchy = await loadSpaceHierarchy(root, SUGGESTED_SPACE_CHANNEL_HIERARCHY_LIMIT, 2);
    const byId = new Map(hierarchy.rooms.map(room => [room.roomId, room]));
    const rootRoom = byId.get(root.roomId);
    if (!rootRoom || rootRoom.kind !== "space") {
        fail("MATRIX_HIERARCHY_INVALID", "Matrix did not return the joined root Space in its hierarchy.");
    }
    const relationTargets = spaceHierarchyRelationTargets.get(root.roomId);
    const accountServer = activeServerName();
    const channels: MatrixSuggestedSpaceChannelDTO[] = [];
    const plannedRoomIds = new Set<string>();
    let plannedJoins = 0;
    let limited = hierarchy.rooms.length >= SUGGESTED_SPACE_CHANNEL_HIERARCHY_LIMIT;

    const relationRoom = (
        parent: MatrixSpaceHierarchyRoomDTO,
        relation: MatrixSpaceChildDTO,
        kind: "space" | "room"
    ): MatrixSpaceHierarchyRoomDTO | undefined => {
        if (relation.suggested !== true) return undefined;
        const child = byId.get(relation.roomId);
        if (!child) {
            limited = true;
            return undefined;
        }
        const viaServers = relationTargets?.get(parent.roomId)?.get(child.roomId);
        if (child.roomId === parent.roomId || child.roomId === root.roomId
            || child.kind !== kind || !viaServers?.includes(accountServer) || child.membership === "invite") {
            return undefined;
        }
        return child.membership === "join" || suggestedChannelJoinRule(child.joinRule)
            ? child
            : undefined;
    };
    const addChannel = (
        room: MatrixSpaceHierarchyRoomDTO,
        parentSpaceId: string,
        depth: 1 | 2,
        includeJoined = false
    ): boolean => {
        if (plannedRoomIds.has(room.roomId)) return false;
        if (room.membership === "join" && !includeJoined) return true;
        const joinRule = room.membership === "join" && includeJoined
            ? room.joinRule
            : suggestedChannelJoinRule(room.joinRule);
        if (!joinRule) return false;
        const needsJoin = room.membership !== "join";
        if (channels.length >= MAX_SUGGESTED_SPACE_CHANNEL_PLAN_ROWS
            || (needsJoin && plannedJoins >= MAX_SUGGESTED_SPACE_CHANNEL_JOINS)) {
            limited = true;
            return false;
        }
        channels.push({
            roomId: room.roomId,
            parentSpaceId,
            name: room.name,
            kind: room.kind === "space" ? "space" : "room",
            depth,
            membership: room.membership === "join" ? "join" : "leave",
            joinRule,
            ...(room.avatarUrl ? { avatarUrl: room.avatarUrl } : {}),
            ...(room.topic ? { topic: room.topic } : {})
        });
        plannedRoomIds.add(room.roomId);
        if (needsJoin) plannedJoins++;
        return true;
    };

    for (const relation of rootRoom.spaceChildren) {
        const directRoom = relationRoom(rootRoom, relation, "room");
        if (directRoom) {
            addChannel(directRoom, root.roomId, 1);
            continue;
        }
        const category = relationRoom(rootRoom, relation, "space");
        if (!category) continue;
        const nestedRooms: MatrixSpaceHierarchyRoomDTO[] = [];
        for (const nestedRelation of category.spaceChildren) {
            const nestedRoom = relationRoom(category, nestedRelation, "room");
            if (nestedRoom) nestedRooms.push(nestedRoom);
        }
        const unjoinedNestedRooms = nestedRooms.filter(room =>
            room.membership !== "join" && !plannedRoomIds.has(room.roomId));
        if (!unjoinedNestedRooms.length) continue;
        const requiredJoinSlots = (category.membership === "join" ? 0 : 1) + 1;
        if (channels.length + 2 > MAX_SUGGESTED_SPACE_CHANNEL_PLAN_ROWS
            || plannedJoins + requiredJoinSlots > MAX_SUGGESTED_SPACE_CHANNEL_JOINS) {
            limited = true;
            continue;
        }
        if (!addChannel(category, root.roomId, 1, true)) continue;
        for (const nestedRoom of unjoinedNestedRooms) addChannel(nestedRoom, category.roomId, 2);
    }

    const planId = await suggestedSpaceChannelPlanId(root.roomId, channels);
    return {
        spaceId: root.roomId,
        planId,
        scope: "suggested_depth_2_via_account_server",
        channels,
        limited,
        complete: false
    };
}

async function suggestedSpaceChannelPlan(
    command: Extract<MatrixWorkerCommand, { type: "suggestedSpaceChannelPlan"; }>
): Promise<MatrixSuggestedSpaceChannelPlanDTO> {
    return await buildSuggestedSpaceChannelPlan(command.spaceId);
}

function validateJoinSuggestedSpaceChannelsRequest(value: unknown): MatrixJoinSuggestedSpaceChannelsRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The suggested-channel join request is invalid.");
    }
    const input = value as Partial<MatrixJoinSuggestedSpaceChannelsRequest>;
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "spaceId") || !Object.hasOwn(input, "planId")) {
        fail("MATRIX_INVALID_ARGUMENT", "The suggested-channel join request is invalid.");
    }
    const planId = validateString(input.planId, "suggested-channel plan", 69);
    if (!/^vcsp_[0-9a-f]{64}$/u.test(planId)) {
        fail("MATRIX_INVALID_ARGUMENT", "The suggested-channel plan is invalid.");
    }
    return { spaceId: validateRoomId(input.spaceId), planId };
}

async function joinSuggestedSpaceChannels(
    command: Extract<MatrixWorkerCommand, { type: "joinSuggestedSpaceChannels"; }>,
    mutationDispatched: () => void
): Promise<MatrixJoinSuggestedSpaceChannelsResult> {
    const request = validateJoinSuggestedSpaceChannelsRequest(command.request);
    const plan = await buildSuggestedSpaceChannelPlan(request.spaceId);
    if (plan.planId !== request.planId) {
        fail(
            "MATRIX_SUGGESTED_SPACE_CHANNEL_PLAN_STALE",
            "The Space's suggested channels changed. Review the refreshed list before joining."
        );
    }
    const outcomes: MatrixJoinSuggestedSpaceChannelsResult["outcomes"] = [];
    const rejectedParents = new Set<string>();
    const accountServer = activeServerName();
    let dispatched = false;

    for (const channel of plan.channels) {
        if (rejectedParents.has(channel.parentSpaceId)) {
            outcomes.push({
                roomId: channel.roomId,
                parentSpaceId: channel.parentSpaceId,
                kind: channel.kind,
                status: "blocked_by_parent"
            });
            continue;
        }
        if (matrixClient!.getRoom(channel.roomId)?.getMyMembership() === "join") {
            outcomes.push({
                roomId: channel.roomId,
                parentSpaceId: channel.parentSpaceId,
                kind: channel.kind,
                status: "already_joined"
            });
            continue;
        }
        const viaServers = spaceHierarchyRelationTargets.get(plan.spaceId)
            ?.get(channel.parentSpaceId)?.get(channel.roomId);
        if (!viaServers?.includes(accountServer)) {
            fail(
                "MATRIX_SUGGESTED_SPACE_CHANNEL_PLAN_STALE",
                "A suggested Space channel is no longer routed through this account's Matrix server."
            );
        }
        try {
            if (!dispatched) {
                mutationDispatched();
                dispatched = true;
            }
            const joined = await matrixClient!.joinRoom(channel.roomId, { viaServers: [accountServer] });
            if (validateRoomId(joined.roomId) !== channel.roomId) {
                fail("MATRIX_ROOM_JOIN_MISMATCH", "The homeserver joined an unexpected room.");
            }
            pendingHiddenRooms.delete(channel.roomId);
            outcomes.push({
                roomId: channel.roomId,
                parentSpaceId: channel.parentSpaceId,
                kind: channel.kind,
                status: "joined"
            });
        } catch (error) {
            if (error instanceof PublicWorkerError && error.code === "MATRIX_ROOM_JOIN_MISMATCH") throw error;
            let converged = false;
            try { converged = await exactOwnJoinedRoom(channel.roomId); } catch { }
            if (converged) {
                pendingHiddenRooms.delete(channel.roomId);
                outcomes.push({
                    roomId: channel.roomId,
                    parentSpaceId: channel.parentSpaceId,
                    kind: channel.kind,
                    status: "joined"
                });
                continue;
            }
            if (!isDefinitiveMatrixMutationRejection(error)) {
                fail(
                    "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS",
                    "Matrix could not confirm every suggested-channel join. Refresh the server before trying again."
                );
            }
            outcomes.push({
                roomId: channel.roomId,
                parentSpaceId: channel.parentSpaceId,
                kind: channel.kind,
                status: "rejected"
            });
            if (channel.kind === "space") rejectedParents.add(channel.roomId);
        }
    }
    return {
        spaceId: plan.spaceId,
        planId: plan.planId,
        outcomes,
        limited: plan.limited,
        complete: false
    };
}

function requireMembership(roomIdValue: unknown, expected: "join" | "invite"): Room {
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const roomId = validateRoomId(roomIdValue);
    const room = matrixClient.getRoom(roomId);
    if (!room || room.getMyMembership() !== expected) {
        fail(
            expected === "invite" ? "MATRIX_ROOM_NOT_INVITED" : "MATRIX_ROOM_NOT_JOINED",
            expected === "invite" ? "There is no pending invite for this Matrix room." : "The Matrix room is not joined."
        );
    }
    return room;
}

function directAccountDataForWrite(): Record<string, string[]> {
    const raw = matrixClient?.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>();
    if (raw == null) return Object.create(null) as Record<string, string[]>;
    if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 2_000) {
        fail("MATRIX_DIRECT_MAP_INVALID", "The Matrix direct-message account data is invalid or too large.");
    }
    const result = Object.create(null) as Record<string, string[]>;
    let totalRooms = 0;
    for (const [rawUserId, rawRoomIds] of Object.entries(raw)) {
        const userId = validateUserId(rawUserId);
        if (!Array.isArray(rawRoomIds) || rawRoomIds.length > 100) {
            fail("MATRIX_DIRECT_MAP_INVALID", "The Matrix direct-message account data is invalid or too large.");
        }
        const roomIds = [...new Set(rawRoomIds.map(validateRoomId))];
        totalRooms += roomIds.length;
        if (totalRooms > 10_000) {
            fail("MATRIX_DIRECT_MAP_INVALID", "The Matrix direct-message account data is invalid or too large.");
        }
        result[userId] = roomIds;
    }
    return result;
}

async function addDirectRoom(userIdValue: unknown, roomIdValue: unknown): Promise<void> {
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const userId = validateUserId(userIdValue);
    const roomId = validateRoomId(roomIdValue);
    const content = directAccountDataForWrite();
    const current = content[userId] ?? [];
    if (current.includes(roomId)) return;
    if (current.length >= 100) fail("MATRIX_DIRECT_MAP_INVALID", "The Matrix direct-message room list is too large.");
    content[userId] = [...current, roomId];
    await matrixClient.setAccountData(EventType.Direct, content);
}

async function exactOwnJoinedRoom(roomId: string): Promise<boolean> {
    return (await exactJoinedRoomIds()).roomIds.includes(roomId);
}

async function exactJoinedRoomIds(): Promise<MatrixJoinedRoomIdsResult> {
    const response: unknown = await matrixClient!.getJoinedRooms();
    if (!response || typeof response !== "object" || Array.isArray(response)) {
        fail("MATRIX_JOINED_ROOMS_INVALID", "Matrix returned an invalid joined-room response.");
    }
    const joinedRooms = (response as { joined_rooms?: unknown; }).joined_rooms;
    if (!Array.isArray(joinedRooms) || joinedRooms.length > 100_000) {
        fail("MATRIX_JOINED_ROOMS_INVALID", "Matrix returned an invalid joined-room response.");
    }
    const roomIds: string[] = [];
    const unique = new Set<string>();
    for (const joinedRoomId of joinedRooms) {
        const validated = validateRoomId(joinedRoomId);
        if (unique.has(validated)) {
            fail("MATRIX_JOINED_ROOMS_INVALID", "Matrix returned duplicate joined-room state.");
        }
        unique.add(validated);
        roomIds.push(validated);
    }
    roomIds.sort();
    return { roomIds };
}

async function acceptInvite(
    command: Extract<MatrixWorkerCommand, { type: "acceptInvite"; }>,
    mutationDispatched: () => void
): Promise<MatrixRoomActionResult> {
    const room = requireMembership(command.roomId, "invite");
    const { roomId } = room;
    const directInviter = optionalUserId(room.getDMInviter());
    let warning: MatrixRoomActionResult["warning"];
    try {
        mutationDispatched();
        const joined = await matrixClient!.joinRoom(roomId);
        const joinedRoomId = validateRoomId(joined.roomId);
        if (joinedRoomId !== roomId) {
            fail("MATRIX_ROOM_JOIN_MISMATCH", "The homeserver joined an unexpected room.");
        }
    } catch (error) {
        if (error instanceof PublicWorkerError && error.code === "MATRIX_ROOM_JOIN_MISMATCH") throw error;
        let converged = false;
        try {
            converged = await exactOwnJoinedRoom(roomId);
        } catch {
            // The original response still determines whether a retry is safe.
        }
        if (!converged) {
            if (isDefinitiveMatrixMutationRejection(error)) {
                fail(
                    "MATRIX_ROOM_INVITE_ACCEPT_REJECTED",
                    "The Matrix homeserver rejected the invitation acceptance. The room was not joined."
                );
            }
            fail(
                "MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS",
                "Matrix could not confirm whether the invitation was accepted. Refresh rooms before trying again."
            );
        }
    }
    // is_direct only survives on the invite membership event. Persist it after
    // the join succeeds so a failed join cannot leave a stale m.direct entry.
    if (directInviter && directInviter !== activeCredentials?.userId) {
        try {
            await addDirectRoom(directInviter, roomId);
        } catch {
            warning = {
                code: "MATRIX_DM_CLASSIFICATION_FAILED",
                message: "The room was joined, but Matrix could not save its direct-message classification."
            };
        }
    }
    pendingHiddenRooms.delete(roomId);
    return { roomId, ...(warning ? { warning } : {}) };
}

async function rejectInvite(
    command: Extract<MatrixWorkerCommand, { type: "rejectInvite"; }>,
    mutationDispatched: () => void
): Promise<MatrixRoomActionResult> {
    const room = requireMembership(command.roomId, "invite");
    try {
        mutationDispatched();
        await matrixClient!.leave(room.roomId);
    } catch (error) {
        // A sync membership transition is server-authored convergence evidence.
        if (matrixClient!.getRoom(room.roomId)?.getMyMembership() !== "leave") {
            if (isDefinitiveMatrixMutationRejection(error)) {
                fail(
                    "MATRIX_ROOM_INVITE_REJECTION_REJECTED",
                    "The Matrix homeserver rejected the invitation decline. The invitation may still be pending."
                );
            }
            fail(
                "MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS",
                "Matrix could not confirm whether the invitation was declined. Refresh rooms before trying again."
            );
        }
    }
    pendingHiddenRooms.add(room.roomId);
    emit({ type: "snapshot", snapshot: snapshot() });
    return { roomId: room.roomId };
}

async function leaveRoom(
    command: Extract<MatrixWorkerCommand, { type: "leaveRoom"; }>
): Promise<MatrixRoomActionResult> {
    const room = requireMembership(command.roomId, "join");
    await matrixClient!.leave(room.roomId);
    pendingHiddenRooms.add(room.roomId);
    spaceHierarchyTargets.delete(room.roomId);
    spaceHierarchyRelationTargets.delete(room.roomId);
    removeHierarchyTarget(room.roomId);
    forgetResolvedSpaceAccessRequestsForRoom(room.roomId);
    emit({ type: "snapshot", snapshot: snapshot() });
    return { roomId: room.roomId };
}

function validateSpaceJoinName(value: unknown): string {
    const joinName = validateString(value, "Space join name", 64);
    if (!SPACE_JOIN_NAME_PATTERN.test(joinName)) {
        fail(
            "MATRIX_INVALID_SPACE_JOIN_NAME",
            "Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, with a letter or number at each end."
        );
    }
    return joinName;
}

function sameServerSpaceAlias(joinName: string): string {
    return `#${validateSpaceJoinName(joinName)}:${activeServerName()}`;
}

function safeSameServerJoinAlias(value: unknown): { joinName: string; joinAlias: string; } | undefined {
    if (typeof value !== "string" || value.length > 1_024 || !value.startsWith("#")) return undefined;
    const suffix = `:${activeServerName()}`;
    if (!value.endsWith(suffix)) return undefined;
    const joinName = value.slice(1, -suffix.length);
    try {
        validateSpaceJoinName(joinName);
    } catch {
        return undefined;
    }
    return value === sameServerSpaceAlias(joinName) ? { joinName, joinAlias: value } : undefined;
}

function validMatrixAlias(value: unknown): value is string {
    if (typeof value !== "string" || value.length < 4 || value.length > 1_024 || value[0] !== "#") return false;
    const separator = value.indexOf(":", 1);
    return separator > 1
        && separator < value.length - 1
        && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function matrixErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as { errcode?: unknown; data?: { errcode?: unknown; }; };
    const value = candidate.errcode ?? candidate.data?.errcode;
    return typeof value === "string" && /^[A-Z0-9._]{1,128}$/u.test(value) ? value : undefined;
}

function isDefinitiveMatrixMutationRejection(error: unknown): boolean {
    if (!error || typeof error !== "object" || matrixErrorCode(error) == null) return false;
    const status = (error as { httpStatus?: unknown; }).httpStatus;
    return Number.isSafeInteger(status) && Number(status) >= 400 && Number(status) < 500;
}

async function optionalRoomState(roomId: string, eventType: string): Promise<Record<string, unknown>> {
    try {
        const content = await matrixClient!.getStateEvent(roomId, eventType, "");
        return content && typeof content === "object" && !Array.isArray(content) ? content : {};
    } catch (error) {
        if (matrixErrorCode(error) === "M_NOT_FOUND") return {};
        throw error;
    }
}

function joinedSpace(spaceId: unknown): Room {
    const room = getRoom(validateRoomId(spaceId));
    if (!room.isSpaceRoom()) fail("MATRIX_SPACE_REQUIRED", "The selected Matrix room is not a Space.");
    return room;
}

function normalizedHistoryVisibility(value: unknown): MatrixSpaceAccessSummaryDTO["historyVisibility"] {
    switch (value) {
        case HistoryVisibility.Invited:
        case HistoryVisibility.Joined:
        case HistoryVisibility.Shared:
        case HistoryVisibility.WorldReadable:
            return value;
        default:
            // The Matrix default when no valid history visibility state exists.
            return HistoryVisibility.Shared;
    }
}

function normalizedGuestAccess(value: unknown): MatrixSpaceAccessSummaryDTO["guestAccess"] {
    return value === GuestAccess.CanJoin ? GuestAccess.CanJoin : GuestAccess.Forbidden;
}

function spaceAccessMode(joinRule: MatrixRoomJoinRule): MatrixSpaceAccessSummaryDTO["mode"] {
    if (joinRule === "public") return "public";
    if (joinRule === "knock" || joinRule === "knock_restricted") return "request";
    return "invite";
}

async function readSpaceAccessSummary(space: Room): Promise<MatrixSpaceAccessSummaryDTO> {
    const [joinRules, history, guest, canonical, directory] = await Promise.all([
        optionalRoomState(space.roomId, EventType.RoomJoinRules),
        optionalRoomState(space.roomId, EventType.RoomHistoryVisibility),
        optionalRoomState(space.roomId, EventType.RoomGuestAccess),
        optionalRoomState(space.roomId, EventType.RoomCanonicalAlias),
        matrixClient!.getRoomDirectoryVisibility(space.roomId)
    ]);
    const joinRule = normalizeJoinRule(joinRules.join_rule) ?? "invite";
    const directoryVisibility = directory?.visibility;
    if (directoryVisibility !== Visibility.Public && directoryVisibility !== Visibility.Private) {
        fail("MATRIX_SPACE_ACCESS_INVALID", "Matrix returned an invalid Space directory visibility.");
    }
    const result: MatrixSpaceAccessSummaryDTO = {
        spaceId: space.roomId,
        mode: spaceAccessMode(joinRule),
        joinRule,
        directoryVisibility,
        historyVisibility: normalizedHistoryVisibility(history.history_visibility),
        guestAccess: normalizedGuestAccess(guest.guest_access)
    };
    const alias = safeSameServerJoinAlias(canonical.alias);
    if (alias && await resolveRoomAlias(alias.joinAlias) === space.roomId) {
        result.joinName = alias.joinName;
        result.joinAlias = alias.joinAlias;
    }
    return result;
}

async function getSpaceAccess(
    command: Extract<MatrixWorkerCommand, { type: "getSpaceAccess"; }>
): Promise<MatrixSpaceAccessSummaryDTO> {
    return await readSpaceAccessSummary(joinedSpace(command.spaceId));
}

function validateConfigureSpaceAccessRequest(value: unknown): MatrixConfigureSpaceAccessRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access settings are invalid.");
    }
    const input = value as Partial<MatrixConfigureSpaceAccessRequest>;
    if (!Object.keys(input).every(key => key === "spaceId" || key === "mode" || key === "joinName")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access settings contain unsupported fields.");
    }
    const spaceId = validateRoomId(input.spaceId);
    if (input.mode !== "public" && input.mode !== "request" && input.mode !== "invite") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access mode is invalid.");
    }
    return {
        spaceId,
        mode: input.mode,
        ...(input.joinName == null ? {} : { joinName: validateSpaceJoinName(input.joinName) })
    };
}

async function resolveRoomAlias(alias: string): Promise<string | undefined> {
    try {
        const response = await matrixClient!.getRoomIdForAlias(alias);
        return validateRoomId(response?.room_id);
    } catch (error) {
        if (matrixErrorCode(error) === "M_NOT_FOUND") return undefined;
        throw error;
    }
}

type SpaceAliasReservation = "preexisting" | "created" | "ambiguous";

class SpaceAliasReservationUnresolvedError extends Error { }

async function ensureSpaceAlias(
    alias: string,
    spaceId: string,
    mutationDispatched: () => void
): Promise<SpaceAliasReservation> {
    const existingRoomId = await resolveRoomAlias(alias);
    if (existingRoomId) {
        if (existingRoomId !== spaceId) {
            fail("MATRIX_SPACE_ALIAS_IN_USE", "That Matrix Space join name is already in use.");
        }
        return "preexisting";
    }
    try {
        mutationDispatched();
        await matrixClient!.createAlias(alias, spaceId);
        return "created";
    } catch (error) {
        // A lost response or a concurrent idempotent retry can report failure
        // even though the exact mapping now exists. Resolve it before failing.
        let recoveredRoomId: string | undefined;
        try {
            recoveredRoomId = await resolveRoomAlias(alias);
        } catch {
            // createAlias may have landed, but a failed recovery read cannot
            // establish ownership or absence. The caller reports an explicit
            // unconfirmed rollback and must never delete this mapping.
            throw new SpaceAliasReservationUnresolvedError();
        }
        // A lost response cannot prove that this operation, rather than a
        // concurrent same-room creator, owns the mapping. Treat it as
        // ambiguous and never attempt automatic alias deletion.
        if (recoveredRoomId === spaceId) return "ambiguous";
        if (recoveredRoomId) {
            fail("MATRIX_SPACE_ALIAS_IN_USE", "That Matrix Space join name is already in use.");
        }
        if (!isDefinitiveMatrixMutationRejection(error)) {
            throw new SpaceAliasReservationUnresolvedError();
        }
        throw error;
    }
}

function canonicalAltAliases(content: Record<string, unknown>, nextAlias: string): string[] {
    const rawAltAliases = content.alt_aliases;
    if (rawAltAliases != null && (!Array.isArray(rawAltAliases) || rawAltAliases.length > 256
        || !rawAltAliases.every(validMatrixAlias))) {
        fail("MATRIX_SPACE_CANONICAL_ALIAS_INVALID", "The Matrix Space has invalid alternate aliases.");
    }
    const aliases = [...new Set((rawAltAliases as string[] | undefined) ?? [])]
        .filter(alias => alias !== nextAlias);
    if (validMatrixAlias(content.alias) && content.alias !== nextAlias && !aliases.includes(content.alias)) {
        if (aliases.length >= 256) {
            fail("MATRIX_SPACE_CANONICAL_ALIAS_INVALID", "The Matrix Space has too many alternate aliases.");
        }
        aliases.push(content.alias);
    }
    return aliases;
}

function canonicalAliasContentMatches(
    content: Record<string, unknown>,
    alias: string,
    altAliases: readonly string[]
): boolean {
    return content.alias === alias
        && (altAliases.length === 0
            ? content.alt_aliases == null || (Array.isArray(content.alt_aliases) && content.alt_aliases.length === 0)
            : Array.isArray(content.alt_aliases)
                && content.alt_aliases.length === altAliases.length
                && content.alt_aliases.every((item, index) => item === altAliases[index]));
}

async function ensureCanonicalSpaceAlias(
    space: Room,
    alias: string,
    mutationDispatched: () => void
): Promise<boolean> {
    const content = await optionalRoomState(space.roomId, EventType.RoomCanonicalAlias);
    const altAliases = canonicalAltAliases(content, alias);
    if (canonicalAliasContentMatches(content, alias, altAliases)) return false;
    try {
        mutationDispatched();
        await matrixClient!.sendStateEvent(space.roomId, EventType.RoomCanonicalAlias, {
            alias,
            ...(altAliases.length ? { alt_aliases: altAliases } : {})
        }, "");
    } catch (error) {
        // A lost PUT response is successful if an exact authenticated state
        // re-read observes the complete desired canonical-alias content.
        try {
            const actual = await optionalRoomState(space.roomId, EventType.RoomCanonicalAlias);
            if (canonicalAliasContentMatches(actual, alias, altAliases)) return true;
        } catch {
            // Preserve the original write failure. The caller handles the
            // ownership-safe alias rollback and reports uncertainty.
        }
        throw error;
    }
    return true;
}

async function ensureSpaceStateValue(
    space: Room,
    eventType: EventType.RoomHistoryVisibility | EventType.RoomGuestAccess | EventType.RoomJoinRules,
    value: HistoryVisibility.Joined | GuestAccess.Forbidden | JoinRule.Public | JoinRule.Knock | JoinRule.Invite,
    mutationDispatched: () => void
): Promise<boolean> {
    const content = await optionalRoomState(space.roomId, eventType);
    const key = eventType === EventType.RoomHistoryVisibility
        ? "history_visibility"
        : eventType === EventType.RoomGuestAccess ? "guest_access" : "join_rule";
    if (content[key] === value && Object.keys(content).length === 1) return false;
    switch (eventType) {
        case EventType.RoomHistoryVisibility:
            mutationDispatched();
            await matrixClient!.sendStateEvent(space.roomId, eventType, {
                history_visibility: HistoryVisibility.Joined
            }, "");
            break;
        case EventType.RoomGuestAccess:
            mutationDispatched();
            await matrixClient!.sendStateEvent(space.roomId, eventType, {
                guest_access: GuestAccess.Forbidden
            }, "");
            break;
        case EventType.RoomJoinRules:
            if (value !== JoinRule.Public && value !== JoinRule.Knock && value !== JoinRule.Invite) {
                fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space join rule is invalid.");
            }
            mutationDispatched();
            await matrixClient!.sendStateEvent(space.roomId, eventType, { join_rule: value }, "");
            break;
    }
    return true;
}

async function ensureSpaceDirectoryVisibility(
    spaceId: string,
    visibility: Visibility,
    mutationDispatched: () => void
): Promise<boolean> {
    const current = await matrixClient!.getRoomDirectoryVisibility(spaceId);
    if (current?.visibility === visibility) return false;
    mutationDispatched();
    await matrixClient!.setRoomDirectoryVisibility(spaceId, visibility);
    return true;
}

function publicWorkerError(error: unknown): PublicWorkerError {
    if (error instanceof PublicWorkerError) return error;
    const safe = publicError(error);
    return new PublicWorkerError(safe.code, safe.message);
}

function partialSpaceAccessMessage(step: MatrixConfigureSpaceAccessStep): string {
    switch (step) {
        case "alias": return "Matrix could not reserve the requested Space join name.";
        case "alias_rollback": return "Matrix could not confirm the requested join-name change. That name may remain active; refresh and retry the same name before choosing another.";
        case "canonical_alias": return "Matrix could not set the Space's canonical join name.";
        case "history_visibility": return "Matrix could not restrict the Space history to joined members.";
        case "guest_access": return "Matrix could not forbid guest access to the Space.";
        case "join_rule": return "Matrix could not apply the requested Space join rule.";
        case "directory": return "Matrix could not confirm or apply the requested Space directory visibility.";
        case "verification": return "Matrix may have changed the Space, but its current access settings could not be verified.";
    }
}

function accessMismatchStep(
    actual: MatrixSpaceAccessSummaryDTO,
    alias: string | undefined,
    joinRule: MatrixRoomJoinRule,
    directoryVisibility: MatrixSpaceAccessSummaryDTO["directoryVisibility"]
): MatrixConfigureSpaceAccessStep | undefined {
    if (alias != null && actual.joinAlias !== alias) return "canonical_alias";
    if (actual.historyVisibility !== HistoryVisibility.Joined) return "history_visibility";
    if (actual.guestAccess !== GuestAccess.Forbidden) return "guest_access";
    if (actual.joinRule !== joinRule) return "join_rule";
    if (actual.directoryVisibility !== directoryVisibility) return "directory";
    return undefined;
}

async function configureSpaceAccess(
    command: Extract<MatrixWorkerCommand, { type: "configureSpaceAccess"; }>
): Promise<MatrixConfigureSpaceAccessResult> {
    const request = validateConfigureSpaceAccessRequest(command.request);
    const space = joinedSpace(request.spaceId);
    if (!canConfigureSpaceAccess(space)) {
        fail("MATRIX_SPACE_ACCESS_FORBIDDEN", "You do not have permission to change this Matrix Space's access settings.");
    }

    const initial = await readSpaceAccessSummary(space);
    const joinName = request.joinName ?? (request.mode === "request" ? initial.joinName : undefined);
    if (request.mode === "request" && !joinName) {
        fail("MATRIX_SPACE_JOIN_NAME_REQUIRED", "Choose a join name before changing this Matrix Space's access mode.");
    }
    const alias = joinName == null ? undefined : sameServerSpaceAlias(joinName);
    const desiredJoinRule = request.mode === "public"
        ? JoinRule.Public
        : request.mode === "request" ? JoinRule.Knock : JoinRule.Invite;
    const desiredDirectory = request.mode === "public" ? Visibility.Public : Visibility.Private;
    let confirmed = initial;
    let mutated = false;
    let mutationPossible = false;
    let aliasReservation: SpaceAliasReservation | undefined;
    let aliasRollbackUnconfirmed = false;
    let failure: { step: MatrixConfigureSpaceAccessStep; error: unknown; } | undefined;

    const runStep = async (
        step: MatrixConfigureSpaceAccessStep,
        action: (mutationDispatched: () => void) => Promise<boolean>
    ): Promise<boolean> => {
        if (failure) return false;
        const previousMutationPossible = mutationPossible;
        let dispatched = false;
        const markMutationDispatched = () => {
            dispatched = true;
            mutationPossible = true;
        };
        try {
            const changed = await action(markMutationDispatched);
            mutated ||= changed;
            return true;
        } catch (error) {
            if (dispatched && isDefinitiveMatrixMutationRejection(error)) {
                mutationPossible = previousMutationPossible;
            }
            failure = { step, error };
            return false;
        }
    };

    if (alias != null) {
        await runStep("alias", async mutationDispatched => {
            try {
                aliasReservation = await ensureSpaceAlias(alias, space.roomId, mutationDispatched);
            } catch (error) {
                if (error instanceof SpaceAliasReservationUnresolvedError) {
                    aliasReservation = "ambiguous";
                    aliasRollbackUnconfirmed = true;
                    // A lost create response is a possible mutation. Preserve
                    // that ambiguity even if every later access-state read is
                    // successful, and never attempt to delete an unowned alias.
                    mutationPossible = true;
                }
                throw error;
            }
            return aliasReservation !== "preexisting";
        });
        if (aliasRollbackUnconfirmed && failure?.step === "alias") {
            failure = { step: "alias_rollback", error: failure.error };
        }
    }
    if (alias != null && await runStep("canonical_alias", mutationDispatched =>
        ensureCanonicalSpaceAlias(space, alias, mutationDispatched))) {
        confirmed = { ...confirmed, joinName: joinName!, joinAlias: alias };
    } else if (alias != null && failure?.step === "canonical_alias"
        && aliasReservation && aliasReservation !== "preexisting") {
        // Alias deletion has no conditional/CAS form. Never risk deleting a
        // mapping which another client could have rebound after our create.
        aliasRollbackUnconfirmed = true;
        mutated = true;
        failure = { step: "alias_rollback", error: failure.error };
    }
    if (await runStep("history_visibility", mutationDispatched => ensureSpaceStateValue(
        space,
        EventType.RoomHistoryVisibility,
        HistoryVisibility.Joined,
        mutationDispatched
    ))) {
        confirmed = { ...confirmed, historyVisibility: HistoryVisibility.Joined };
    }
    if (await runStep("guest_access", mutationDispatched => ensureSpaceStateValue(
        space,
        EventType.RoomGuestAccess,
        GuestAccess.Forbidden,
        mutationDispatched
    ))) {
        confirmed = { ...confirmed, guestAccess: GuestAccess.Forbidden };
    }
    if (await runStep("join_rule", mutationDispatched => ensureSpaceStateValue(
        space,
        EventType.RoomJoinRules,
        desiredJoinRule,
        mutationDispatched
    ))) {
        confirmed = { ...confirmed, joinRule: desiredJoinRule, mode: spaceAccessMode(desiredJoinRule) };
    }
    if (await runStep("directory", mutationDispatched =>
        ensureSpaceDirectoryVisibility(space.roomId, desiredDirectory, mutationDispatched))) {
        confirmed = { ...confirmed, directoryVisibility: desiredDirectory };
    }

    let actual: MatrixSpaceAccessSummaryDTO;
    let exactReadSucceeded = false;
    try {
        // This exact homeserver re-read is the source of truth returned to the
        // renderer. In particular, access mode never implies directory state.
        actual = await readSpaceAccessSummary(space);
        exactReadSucceeded = true;
    } catch (error) {
        if (!mutated && !mutationPossible) throw publicWorkerError(failure?.error ?? error);
        actual = confirmed;
        failure ??= { step: "verification", error };
    }

    const mismatch = accessMismatchStep(actual, alias, desiredJoinRule, desiredDirectory);
    // A successful exact re-read supersedes an ambiguous write response. If
    // every desired field is present, the retry-safe operation did complete.
    if (failure && !mutated && !mutationPossible && (!exactReadSucceeded || mismatch != null)) {
        throw publicWorkerError(failure.error);
    }
    const canonicalAliasConfirmed = alias == null || actual.joinAlias === alias;
    const failedStep = exactReadSucceeded
        ? mismatch == null
            ? undefined
            : aliasRollbackUnconfirmed && !canonicalAliasConfirmed ? "alias_rollback" : mismatch
        : aliasRollbackUnconfirmed ? "alias_rollback" : failure?.step ?? mismatch;
    const result: MatrixConfigureSpaceAccessResult = {
        spaceId: space.roomId,
        requestedMode: request.mode,
        access: actual,
        accessConfirmed: exactReadSucceeded,
        complete: failedStep == null
    };
    if (failedStep) {
        result.partial = {
            code: "MATRIX_SPACE_ACCESS_PARTIAL",
            failedStep,
            message: partialSpaceAccessMessage(failedStep)
        };
    }
    emitRoom(space);
    return result;
}

function validateResolveSpaceAccessRequest(value: unknown): MatrixResolveSpaceAccessRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access request decision is invalid.");
    }
    const input = value as Partial<MatrixResolveSpaceAccessRequest>;
    if (!Object.keys(input).every(key => key === "spaceId" || key === "userId" || key === "decision")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access request decision contains unsupported fields.");
    }
    if (input.decision !== "approve" && input.decision !== "deny") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space access request decision is invalid.");
    }
    return {
        spaceId: validateRoomId(input.spaceId),
        userId: validateUserId(input.userId),
        decision: input.decision
    };
}

function memberRequestTimestamp(member: ReturnType<Room["getMembers"]>[number]): number | undefined {
    const timestamp = member.events.member?.getTs();
    return Number.isSafeInteger(timestamp) && timestamp! >= 0 && timestamp! <= MAX_EVENT_TIMESTAMP
        ? timestamp
        : undefined;
}

function normalizeSpaceAccessRequester(
    room: Room,
    member: ReturnType<Room["getMembers"]>[number]
): MatrixSpaceAccessRequestMemberDTO | undefined {
    const userId = optionalUserId(member.userId);
    if (!userId || member.membership !== "knock" || isResolvedSpaceAccessRequest(room.roomId, userId)) {
        return undefined;
    }
    const permissions = spaceAccessPermissions(room, userId);
    const result: MatrixSpaceAccessRequestMemberDTO = {
        userId,
        canApprove: permissions.canApprove,
        canDeny: permissions.canDeny
    };
    const displayName = publicRoomText(member.name, 256);
    if (displayName) result.displayName = displayName;
    const avatarUrl = mediaUrl(member.getMxcAvatarUrl(), 96, 96);
    if (avatarUrl) result.avatarUrl = avatarUrl;
    const requestedAt = memberRequestTimestamp(member);
    if (requestedAt != null) result.requestedAt = requestedAt;
    return result;
}

async function getSpaceAccessRequests(
    command: Extract<MatrixWorkerCommand, { type: "getSpaceAccessRequests"; }>
): Promise<MatrixSpaceAccessRequestListDTO> {
    const space = joinedSpace(command.spaceId);
    let permissions = spaceAccessPermissions(space);
    if (!permissions.canApprove && !permissions.canDeny) {
        fail(
            "MATRIX_SPACE_ACCESS_REQUESTS_FORBIDDEN",
            "You do not have permission to review this Matrix Space's access requests."
        );
    }
    await loadSpaceAccessMembers(space);
    permissions = spaceAccessPermissions(space);
    if (!permissions.canApprove && !permissions.canDeny) {
        fail(
            "MATRIX_SPACE_ACCESS_REQUESTS_FORBIDDEN",
            "You no longer have permission to review this Matrix Space's access requests."
        );
    }
    const requests: MatrixSpaceAccessRequestMemberDTO[] = [];
    let truncated = false;
    for (const member of space.getMembers()) {
        const request = normalizeSpaceAccessRequester(space, member);
        if (!request) continue;
        if (requests.length >= MAX_SPACE_ACCESS_REQUESTS) {
            truncated = true;
            break;
        }
        requests.push(request);
    }
    requests.sort((left, right) => (left.requestedAt ?? Number.MAX_SAFE_INTEGER)
        - (right.requestedAt ?? Number.MAX_SAFE_INTEGER)
        || left.userId.localeCompare(right.userId));
    const result: MatrixSpaceAccessRequestListDTO = {
        spaceId: space.roomId,
        requests,
        truncated,
        canApproveAccessRequests: permissions.canApprove,
        canDenyAccessRequests: permissions.canDeny
    };
    return result;
}

function accessRequestCountWithout(room: Room, excludedUserId?: string): number {
    let count = 0;
    for (const member of room.getMembers()) {
        if (member.membership !== "knock" || member.userId === excludedUserId
            || isResolvedSpaceAccessRequest(room.roomId, member.userId)) continue;
        count++;
        if (count >= MAX_SPACE_ACCESS_REQUESTS) return MAX_SPACE_ACCESS_REQUESTS;
    }
    return count;
}

type AccessMutationMembership = "knock" | "invite" | "join" | "leave";

async function exactRoomMembership(roomId: string, userId: string): Promise<AccessMutationMembership | undefined> {
    try {
        const content = await matrixClient!.getStateEvent(roomId, EventType.RoomMember, userId);
        if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
        const { membership }: { membership?: unknown } = content;
        return membership === "knock" || membership === "invite" || membership === "join" || membership === "leave"
            ? membership
            : undefined;
    } catch {
        return undefined;
    }
}

function resolvedSpaceAccessRequestResult(
    request: MatrixResolveSpaceAccessRequest,
    space: Room,
    membership: MatrixResolveSpaceAccessRequestResult["membership"]
): MatrixResolveSpaceAccessRequestResult {
    return {
        ...request,
        membership,
        accessRequestCount: accessRequestCountWithout(space, request.userId)
    };
}

async function resolveSpaceAccessRequest(
    command: Extract<MatrixWorkerCommand, { type: "resolveSpaceAccessRequest"; }>
): Promise<MatrixResolveSpaceAccessRequestResult> {
    const request = validateResolveSpaceAccessRequest(command.request);
    const space = joinedSpace(request.spaceId);
    const member = space.getMember(request.userId);
    if (!member || member.membership !== "knock" || isResolvedSpaceAccessRequest(space.roomId, request.userId)) {
        fail("MATRIX_SPACE_ACCESS_REQUEST_NOT_PENDING", "That Matrix Space access request is no longer pending.");
    }
    const permissions = spaceAccessPermissions(space, request.userId);
    if (request.decision === "approve") {
        if (!permissions.canApprove) {
            fail("MATRIX_SPACE_ACCESS_APPROVE_FORBIDDEN", "You do not have permission to approve this Matrix Space access request.");
        }
    } else {
        if (!permissions.canDeny) {
            fail("MATRIX_SPACE_ACCESS_DENY_FORBIDDEN", "You do not have permission to deny this Matrix Space access request.");
        }
    }
    reserveResolvedSpaceAccessRequest(space.roomId, request.userId);
    let resolvedMembership: MatrixResolveSpaceAccessRequestResult["membership"] = request.decision === "approve"
        ? "invite"
        : "leave";
    try {
        if (request.decision === "approve") await matrixClient!.invite(space.roomId, request.userId);
        else await matrixClient!.kick(space.roomId, request.userId);
    } catch (error) {
        const actualMembership = await exactRoomMembership(space.roomId, request.userId);
        const converged = request.decision === "approve"
            ? actualMembership === "invite" || actualMembership === "join"
            : actualMembership === "leave";
        if (converged) {
            resolvedMembership = actualMembership as MatrixResolveSpaceAccessRequestResult["membership"];
        } else {
            forgetResolvedSpaceAccessRequest(space.roomId, request.userId);
            if (isDefinitiveMatrixMutationRejection(error)) throw error;
            fail(
                "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS",
                `Matrix could not confirm whether this access request was ${request.decision === "approve" ? "approved" : "denied"}. It may already be resolved; refresh before acting again.`
            );
        }
    }
    const result = resolvedSpaceAccessRequestResult(request, space, resolvedMembership);
    emitRoom(space);
    return result;
}

function validateSpaceInviteCandidateSearchRequest(value: unknown): Required<MatrixSpaceInviteCandidateSearchRequest> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search is invalid.");
    }
    const input = value as Partial<MatrixSpaceInviteCandidateSearchRequest>;
    if (!Object.keys(input).every(key => key === "spaceId" || key === "query" || key === "limit")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search contains unsupported fields.");
    }
    const query = validateString(
        input.query,
        "Space invite search query",
        MAX_SPACE_INVITE_DIRECTORY_QUERY_LENGTH,
        true
    ).trim();
    if (/[\u0000-\u001f\u007f]/u.test(query)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search query is invalid.");
    }
    const limit = input.limit ?? DEFAULT_SPACE_INVITE_DIRECTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SPACE_INVITE_DIRECTORY_LIMIT) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search limit is invalid.");
    }
    return { spaceId: validateRoomId(input.spaceId), query, limit };
}

function validateGroupChatCandidateSearchRequest(value: unknown): Required<MatrixGroupChatCandidateSearchRequest> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search is invalid.");
    }
    const input = value as Partial<MatrixGroupChatCandidateSearchRequest>;
    if (!Object.keys(input).every(key => key === "query" || key === "limit" || key === "exact")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search contains unsupported fields.");
    }
    const query = validateString(
        input.query,
        "Group-chat directory search query",
        MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH,
        true
    ).trim();
    if (/[\u0000-\u001f\u007f]/u.test(query)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search query is invalid.");
    }
    const limit = input.limit ?? DEFAULT_GROUP_CHAT_DIRECTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GROUP_CHAT_DIRECTORY_LIMIT) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search limit is invalid.");
    }
    if (input.exact != null && typeof input.exact !== "boolean") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat exact lookup option is invalid.");
    }
    if (input.exact === true && !query) {
        fail("MATRIX_GROUP_CHAT_EXACT_LOOKUP_INVALID", "Enter an exact local Matrix ID or username.");
    }
    return { query, limit, exact: input.exact === true };
}

function validateGroupChatInviteCandidateSearchRequest(
    value: unknown
): Required<MatrixGroupChatInviteCandidateSearchRequest> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite search is invalid.");
    }
    const input = value as Partial<MatrixGroupChatInviteCandidateSearchRequest>;
    if (!Object.keys(input).every(key => key === "roomId" || key === "query" || key === "limit" || key === "exact")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite search contains unsupported fields.");
    }
    return {
        roomId: validateRoomId(input.roomId),
        ...validateGroupChatCandidateSearchRequest({ query: input.query, limit: input.limit, exact: input.exact })
    };
}

function validateInviteUserToGroupChatRequest(value: unknown): MatrixInviteUserToGroupChatRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite is invalid.");
    }
    const input = value as Partial<MatrixInviteUserToGroupChatRequest>;
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "roomId") || !Object.hasOwn(input, "userId")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite contains invalid fields.");
    }
    return { roomId: validateRoomId(input.roomId), userId: requireLocalServerUserId(input.userId) };
}

function validateInviteUserToSpaceRequest(value: unknown): MatrixInviteUserToSpaceRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite is invalid.");
    }
    const input = value as Partial<MatrixInviteUserToSpaceRequest>;
    if (!Object.keys(input).every(key => key === "spaceId" || key === "userId")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite contains unsupported fields.");
    }
    return { spaceId: validateRoomId(input.spaceId), userId: validateUserId(input.userId) };
}

function localServerUserId(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > 512
        || !/^@[^\s:\u0000-\u001f\u007f]+:[^\s\u0000-\u001f\u007f]+$/u.test(value)) {
        return undefined;
    }
    const separator = value.indexOf(":", 1);
    try {
        const userId = validateUserId(value);
        const serverName = validateServerName(value.slice(separator + 1));
        return serverName === activeServerName() ? userId : undefined;
    } catch {
        return undefined;
    }
}

function requireLocalServerUserId(value: unknown): string {
    const userId = validateUserId(value);
    const localUserId = localServerUserId(userId);
    if (!localUserId) {
        fail("MATRIX_REMOTE_USER_REJECTED", "Only users on this account's Matrix server can be invited here.");
    }
    return localUserId;
}

function validateCreateGroupChatRequest(value: unknown): MatrixCreateGroupChatRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat details are invalid.");
    }
    const input = value as Partial<MatrixCreateGroupChatRequest>;
    if (!Object.keys(input).every(key => key === "name" || key === "userIds")) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat details contain unsupported fields.");
    }
    const name = validateString(input.name, "Group-chat name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat name is invalid.");
    }
    if (!Array.isArray(input.userIds)
        || input.userIds.length < MIN_GROUP_CHAT_INVITEES
        || input.userIds.length > MAX_GROUP_CHAT_INVITEES) {
        fail(
            "MATRIX_INVALID_ARGUMENT",
            `A Matrix group chat allows up to ${MAX_GROUP_CHAT_INVITEES} other users.`
        );
    }
    const userIds = input.userIds.map(requireLocalServerUserId);
    if (new Set(userIds).size !== userIds.length) {
        fail("MATRIX_INVALID_ARGUMENT", "Matrix group-chat invitees must be unique.");
    }
    if (userIds.includes(activeCredentials!.userId)) {
        fail("MATRIX_GROUP_CHAT_SELF", "A Matrix group chat cannot invite your own account.");
    }
    return { name, userIds };
}

function pruneGroupChatDirectoryCandidates(now = Date.now()): void {
    for (const [userId, expiresAt] of groupChatDirectoryCandidates) {
        if (expiresAt <= now) groupChatDirectoryCandidates.delete(userId);
    }
    while (groupChatDirectoryCandidates.size > MAX_GROUP_CHAT_DIRECTORY_CANDIDATES) {
        const oldest = groupChatDirectoryCandidates.keys().next().value;
        if (typeof oldest !== "string") break;
        groupChatDirectoryCandidates.delete(oldest);
    }
}

function rememberGroupChatDirectoryCandidate(userId: string): void {
    groupChatDirectoryCandidates.delete(userId);
    groupChatDirectoryCandidates.set(userId, Date.now() + GROUP_CHAT_DIRECTORY_CANDIDATE_TTL_MS);
    pruneGroupChatDirectoryCandidates();
}

function requireCurrentGroupChatDirectoryCandidates(userIds: readonly string[]): void {
    const now = Date.now();
    pruneGroupChatDirectoryCandidates(now);
    if (userIds.some(userId => (groupChatDirectoryCandidates.get(userId) ?? 0) <= now)) {
        fail(
            "MATRIX_GROUP_CHAT_CANDIDATE_STALE",
            "Search the Matrix user directory again before creating this group chat. No room was created."
        );
    }
}

type ExactSpaceInviteMembership = MatrixSpaceInviteCandidateDTO["membership"] | "ban";

async function exactSpaceInviteMembership(roomId: string, userId: string): Promise<ExactSpaceInviteMembership> {
    try {
        const content = await matrixClient!.getStateEvent(roomId, EventType.RoomMember, userId);
        if (!content || typeof content !== "object" || Array.isArray(content)) {
            fail("MATRIX_SPACE_MEMBERSHIP_INVALID", "Matrix returned invalid Space membership state.");
        }
        const { membership }: { membership?: unknown } = content;
        if (membership === "leave" || membership === "knock" || membership === "invite"
            || membership === "join" || membership === "ban") {
            return membership;
        }
        fail("MATRIX_SPACE_MEMBERSHIP_INVALID", "Matrix returned invalid Space membership state.");
    } catch (error) {
        if (matrixErrorCode(error) === "M_NOT_FOUND") return "none";
        throw error;
    }
}

function emptyUserDirectoryQueryUnsupported(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const status = (error as { httpStatus?: unknown; }).httpStatus;
    if (status !== 400) return false;
    const code = matrixErrorCode(error);
    return code == null || code === "M_BAD_JSON" || code === "M_INVALID_PARAM"
        || code === "M_MISSING_PARAM" || code === "M_UNKNOWN";
}

async function mapSpaceInviteCandidates(
    candidates: Array<{ userId: string; displayName?: string; avatarUrl?: string; }>,
    roomId: string
): Promise<Array<MatrixSpaceInviteCandidateDTO | undefined>> {
    const results = new Array<MatrixSpaceInviteCandidateDTO | undefined>(candidates.length);
    let nextIndex = 0;
    await Promise.all(Array.from(
        { length: Math.min(SPACE_INVITE_MEMBERSHIP_CONCURRENCY, candidates.length) },
        async () => {
            while (nextIndex < candidates.length) {
                const index = nextIndex++;
                const candidate = candidates[index];
                const membership = await exactSpaceInviteMembership(roomId, candidate.userId);
                if (membership === "ban") continue;
                results[index] = { ...candidate, membership };
            }
        }
    ));
    return results;
}

async function searchSpaceInviteCandidates(
    command: Extract<MatrixWorkerCommand, { type: "searchSpaceInviteCandidates"; }>
): Promise<MatrixSpaceInviteCandidateSearchResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateSpaceInviteCandidateSearchRequest(command.request);
    const space = joinedSpace(request.spaceId);
    const permission = spaceInvitePermission(space);
    if (permissionIsUnverifiable(permission)) {
        fail(
            "MATRIX_SPACE_INVITE_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify this Space's invite power levels."
        );
    }
    if (!permission.allowed) {
        fail("MATRIX_SPACE_INVITE_FORBIDDEN", "You do not have permission to invite users to this Matrix Space.");
    }

    let directory: Awaited<ReturnType<MatrixClient["searchUserDirectory"]>>;
    try {
        directory = await matrixClient.searchUserDirectory({ term: request.query, limit: request.limit });
    } catch (error) {
        if (request.query === "" && emptyUserDirectoryQueryUnsupported(error)) {
            return {
                spaceId: space.roomId,
                query: request.query,
                scope: "homeserver_user_directory",
                candidates: [],
                limited: false,
                directoryLimited: false,
                complete: false,
                queryRequired: true
            };
        }
        throw error;
    }
    if (!directory || typeof directory !== "object" || !Array.isArray(directory.results)
        || typeof directory.limited !== "boolean") {
        fail("MATRIX_USER_DIRECTORY_INVALID", "Matrix returned an invalid user-directory response.");
    }

    const locallyLimited = directory.results.length > request.limit;
    const unique = new Set<string>();
    const localCandidates: Array<{ userId: string; displayName?: string; avatarUrl?: string; }> = [];
    for (const raw of directory.results.slice(0, request.limit)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const userId = localServerUserId(raw.user_id);
        if (!userId || userId === activeCredentials.userId || unique.has(userId)) continue;
        unique.add(userId);
        const candidate: { userId: string; displayName?: string; avatarUrl?: string; } = { userId };
        const displayName = publicRoomText(raw.display_name, 256)
            ?.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
            .trim();
        const avatarUrl = mediaUrl(raw.avatar_url, 96, 96);
        if (displayName) candidate.displayName = displayName;
        if (avatarUrl) candidate.avatarUrl = avatarUrl;
        localCandidates.push(candidate);
    }
    const memberships = await mapSpaceInviteCandidates(localCandidates, space.roomId);
    const candidates = memberships.filter((candidate): candidate is MatrixSpaceInviteCandidateDTO => candidate != null);
    return {
        spaceId: space.roomId,
        query: request.query,
        scope: "homeserver_user_directory",
        candidates,
        limited: directory.limited || locallyLimited,
        directoryLimited: directory.limited,
        complete: false,
        queryRequired: false
    };
}

function exactLocalProfileUserId(query: string): string {
    let userId: string | undefined;
    if (query.startsWith("@")) {
        const separator = query.indexOf(":", 1);
        const localpart = separator > 1 ? query.slice(1, separator) : "";
        const serverName = separator > 1 ? query.slice(separator + 1) : "";
        if (BARE_MATRIX_LOCALPART_PATTERN.test(localpart)
            && serverName === activeServerName()
            && new TextEncoder().encode(query).byteLength <= 255) {
            userId = localServerUserId(query);
            if (userId !== query) userId = undefined;
        }
    } else if (BARE_MATRIX_LOCALPART_PATTERN.test(query)) {
        const candidate = `@${query}:${activeServerName()}`;
        if (new TextEncoder().encode(candidate).byteLength <= 255) userId = localServerUserId(candidate);
    }
    if (!userId || new TextEncoder().encode(userId).byteLength > 255) {
        fail(
            "MATRIX_GROUP_CHAT_EXACT_LOOKUP_INVALID",
            "Enter an exact local Matrix ID or a lowercase local username."
        );
    }
    return userId;
}

function consumeGroupChatExactLookup(): void {
    const cutoff = Date.now() - GROUP_CHAT_EXACT_LOOKUP_WINDOW_MS;
    while (groupChatExactLookupTimestamps[0] != null && groupChatExactLookupTimestamps[0] <= cutoff) {
        groupChatExactLookupTimestamps.shift();
    }
    if (groupChatExactLookupTimestamps.length >= MAX_GROUP_CHAT_EXACT_LOOKUPS_PER_WINDOW) {
        fail(
            "MATRIX_GROUP_CHAT_EXACT_LOOKUP_RATE_LIMITED",
            "Too many exact Matrix account lookups were requested. Wait before trying again."
        );
    }
    groupChatExactLookupTimestamps.push(Date.now());
}

function groupChatDirectoryCandidate(
    userId: string,
    displayNameValue: unknown,
    avatarValue: unknown
): MatrixGroupChatCandidateDTO {
    const candidate: MatrixGroupChatCandidateDTO = { userId };
    const displayName = publicRoomText(displayNameValue, 256)
        ?.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
        .trim();
    const avatarUrl = mediaUrl(avatarValue, 96, 96);
    if (displayName) candidate.displayName = displayName;
    if (avatarUrl) candidate.avatarUrl = avatarUrl;
    return candidate;
}

async function groupChatCandidateSearch(
    request: Required<MatrixGroupChatCandidateSearchRequest>
): Promise<MatrixGroupChatCandidateSearchResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    // Validate explicit lookup scope before any homeserver request. A remote or
    // malformed MXID must never reach even the standard directory endpoint.
    const exactUserId = request.exact ? exactLocalProfileUserId(request.query) : undefined;
    let directory: Awaited<ReturnType<MatrixClient["searchUserDirectory"]>> | undefined;
    try {
        directory = await matrixClient.searchUserDirectory({
            term: exactUserId ?? request.query,
            limit: request.limit
        });
    } catch (error) {
        if (request.query === "" && emptyUserDirectoryQueryUnsupported(error)) {
            return {
                query: request.query,
                scope: "homeserver_user_directory",
                candidates: [],
                limited: false,
                directoryLimited: false,
                complete: false,
                queryRequired: true,
                exactLookup: "not_requested"
            };
        }
        if (!request.exact) throw error;
    }
    if (directory && (typeof directory !== "object" || !Array.isArray(directory.results)
        || typeof directory.limited !== "boolean")) {
        fail("MATRIX_USER_DIRECTORY_INVALID", "Matrix returned an invalid user-directory response.");
    }

    const directoryResults = directory?.results ?? [];
    const directoryLimited = directory?.limited ?? false;
    const locallyLimited = directoryResults.length > request.limit;
    const unique = new Set<string>();
    const candidates: MatrixGroupChatCandidateDTO[] = [];
    for (const raw of directoryResults.slice(0, request.limit)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const userId = localServerUserId(raw.user_id);
        if (!userId || userId === activeCredentials.userId || unique.has(userId)) continue;
        unique.add(userId);
        candidates.push(groupChatDirectoryCandidate(userId, raw.display_name, raw.avatar_url));
        rememberGroupChatDirectoryCandidate(userId);
    }

    let exactLookup: MatrixGroupChatCandidateSearchResult["exactLookup"] = "not_requested";
    if (exactUserId) {
        const existing = candidates.find(candidate => candidate.userId === exactUserId);
        if (exactUserId === activeCredentials.userId) {
            exactLookup = "not_found_or_unavailable";
        } else if (existing) {
            exactLookup = "resolved";
        } else {
            consumeGroupChatExactLookup();
            try {
                const profile = await matrixClient.getProfileInfo(exactUserId);
                if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("invalid profile");
                candidates.unshift(groupChatDirectoryCandidate(exactUserId, profile.displayname, profile.avatar_url));
                rememberGroupChatDirectoryCandidate(exactUserId);
                exactLookup = "resolved";
            } catch {
                // Deliberately collapse missing, private, malformed, and
                // unavailable profile responses into one non-oracular result.
                exactLookup = "not_found_or_unavailable";
            }
        }
    }
    return {
        query: request.query,
        scope: request.exact
            ? "homeserver_user_directory_plus_exact_local_profile"
            : "homeserver_user_directory",
        candidates: candidates.slice(0, request.limit),
        limited: directoryLimited || locallyLimited || candidates.length > request.limit,
        directoryLimited,
        complete: false,
        queryRequired: false,
        exactLookup
    };
}

async function searchGroupChatCandidates(
    command: Extract<MatrixWorkerCommand, { type: "searchGroupChatCandidates"; }>
): Promise<MatrixGroupChatCandidateSearchResult> {
    return await groupChatCandidateSearch(validateGroupChatCandidateSearchRequest(command.request));
}

function requireGroupChatInvitePermission(room: Room): void {
    const permission = spaceInvitePermission(room);
    if (permissionIsUnverifiable(permission)) {
        fail(
            "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify this group chat's invite power levels."
        );
    }
    if (!permission.allowed) {
        fail("MATRIX_GROUP_CHAT_INVITE_FORBIDDEN", "You do not have permission to invite people to this group chat.");
    }
}

function rawGroupChatPowerLevelPermission(
    powerLevels: RawGroupChatStateEvent | undefined,
    creatorId: string,
    roomVersion: string
): MatrixPowerLevelPermissionDTO {
    if (!activeCredentials) {
        return { current: "unverifiable", required: "unverifiable", allowed: false };
    }
    const content = powerLevels?.content ?? {};
    const current = powerLevels
        ? isHydraRoomVersion(roomVersion) && activeCredentials.userId === creatorId
            ? { valid: true, value: Infinity }
            : userPowerLevel(content, activeCredentials.userId, roomVersion)
        : isHydraRoomVersion(roomVersion)
            ? { valid: true, value: activeCredentials.userId === creatorId ? Infinity : 0 }
            : { valid: true, value: activeCredentials.userId === creatorId ? 100 : 0 };
    return powerLevelPermissionDTO(
        current,
        defaultedMatrixPowerLevel(content, "invite", 0, roomVersion)
    );
}

async function exactGroupChatInvitePermission(room: Room): Promise<MatrixPowerLevelPermissionDTO> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const localIdentity = groupChatRoomIdentity(room);
    let state: unknown;
    try { state = await matrixClient.roomState(room.roomId); } catch {
        fail(
            "MATRIX_GROUP_CHAT_PRIVACY_UNVERIFIABLE",
            "Matrix could not verify the current private encrypted-room state before inviting."
        );
    }
    if (!localIdentity || !Array.isArray(state) || state.length > 10_000) {
        fail(
            "MATRIX_GROUP_CHAT_PRIVACY_UNVERIFIABLE",
            "Matrix returned an invalid current group-chat state snapshot."
        );
    }
    const create = rawGroupChatStateEvent(state, EventType.RoomCreate, "");
    const marker = rawGroupChatStateEvent(state, GROUP_CHAT_CREATION_EVENT_TYPE, "");
    const encryption = rawGroupChatStateEvent(state, EventType.RoomEncryption, "");
    const joinRules = rawGroupChatStateEvent(state, EventType.RoomJoinRules, "");
    const history = rawGroupChatStateEvent(state, EventType.RoomHistoryVisibility, "");
    const guest = rawGroupChatStateEvent(state, EventType.RoomGuestAccess, "");
    const ownMembership = rawGroupChatStateEvent(state, EventType.RoomMember, activeCredentials.userId);
    const powerLevelEvents = state.filter(value => value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).type === EventType.RoomPowerLevels
        && (value as Record<string, unknown>).state_key === "");
    const hasCreateMarker = create != null && Object.hasOwn(create.content, GROUP_CHAT_CREATION_CONTENT_KEY);
    const exactCreationMarker = hasCreateMarker
        ? validGroupChatCreationMarker(create.content[GROUP_CHAT_CREATION_CONTENT_KEY])
        : validGroupChatCreationMarker(marker?.content.marker);
    if (!create || create.sender !== localIdentity.creatorId
        || !exactGroupChatCreationContent(create.content, localIdentity.roomVersion)
        || exactCreationMarker !== localIdentity.creationMarker
        || marker?.sender !== create.sender || marker.content.marker !== localIdentity.creationMarker
        || encryption?.content.algorithm !== "m.megolm.v1.aes-sha2"
        || joinRules?.content.join_rule !== JoinRule.Invite
        || history?.content.history_visibility !== HistoryVisibility.Joined
        || guest?.content.guest_access !== GuestAccess.Forbidden
        || ownMembership?.content.membership !== "join"
        || powerLevelEvents.length > 1) {
        fail(
            "MATRIX_GROUP_CHAT_PRIVACY_UNVERIFIABLE",
            "The current Matrix room state no longer matches this private encrypted group chat."
        );
    }
    const powerLevels = powerLevelEvents.length === 1
        ? rawGroupChatStateEvent(state, EventType.RoomPowerLevels, "")
        : undefined;
    if (powerLevelEvents.length === 1 && !powerLevels) {
        fail(
            "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE",
            "Matrix returned invalid current group-chat power levels."
        );
    }
    return rawGroupChatPowerLevelPermission(
        powerLevels,
        localIdentity.creatorId,
        localIdentity.roomVersion
    );
}

async function searchGroupChatInviteCandidates(
    command: Extract<MatrixWorkerCommand, { type: "searchGroupChatInviteCandidates"; }>
): Promise<MatrixGroupChatInviteCandidateSearchResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateGroupChatInviteCandidateSearchRequest(command.request);
    // Post-create exact lookup has the same existence-oracle boundary as the
    // create modal: reject remote/noncanonical input before /members or any
    // other homeserver request, even though native performs the same check.
    if (request.exact) exactLocalProfileUserId(request.query);
    const room = joinedInvitableGroupChat(request.roomId);
    requireGroupChatInvitePermission(room);
    const membership = await exactGroupChatMembershipSnapshot(room);
    const directory = await groupChatCandidateSearch(request);
    return {
        ...directory,
        roomId: room.roomId,
        candidates: directory.candidates.map(candidate => ({
            ...candidate,
            membership: membership.memberships.get(candidate.userId) ?? "none"
        })),
        participantCount: membership.participantCount,
        maxParticipants: MAX_GROUP_CHAT_PARTICIPANTS,
        full: membership.participantCount >= MAX_GROUP_CHAT_PARTICIPANTS
    };
}

async function inviteUserToGroupChat(
    command: Extract<MatrixWorkerCommand, { type: "inviteUserToGroupChat"; }>,
    mutationDispatched: () => void
): Promise<MatrixInviteUserToGroupChatResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateInviteUserToGroupChatRequest(command.request);
    if (request.userId === activeCredentials.userId) {
        fail("MATRIX_GROUP_CHAT_INVITE_SELF", "You cannot invite your own Matrix account.");
    }
    requireCurrentGroupChatDirectoryCandidates([request.userId]);
    const room = identifiedGroupChat(request.roomId);
    const snapshot = await exactGroupChatMembershipSnapshot(room);
    const before = snapshot.memberships.get(request.userId) ?? "none";
    if (before === "invite" || before === "join") {
        return { ...request, delivery: "existing", observedMembership: before, changed: false };
    }
    if (before === "ban") {
        fail("MATRIX_GROUP_CHAT_INVITE_BANNED", "That Matrix user is banned from this group chat.");
    }
    if (snapshot.participantCount >= MAX_GROUP_CHAT_PARTICIPANTS) {
        fail("MATRIX_GROUP_CHAT_FULL", "This group chat already has the maximum of 10 joined or invited participants.");
    }
    const permission = await exactGroupChatInvitePermission(room);
    if (permissionIsUnverifiable(permission)) {
        fail(
            "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify the current group-chat invite power levels."
        );
    }
    if (!permission.allowed) {
        fail("MATRIX_GROUP_CHAT_INVITE_FORBIDDEN", "You do not have permission to invite people to this group chat.");
    }

    try {
        mutationDispatched();
        await matrixClient.invite(room.roomId, request.userId);
    } catch (error) {
        let actual: ExactSpaceInviteMembership | undefined;
        try { actual = await exactSpaceInviteMembership(room.roomId, request.userId); } catch { }
        if (actual === "invite" || actual === "join") {
            try { emitRoom(room); } catch { }
            return { ...request, delivery: "accepted", observedMembership: actual, changed: true };
        }
        if (isDefinitiveMatrixMutationRejection(error)) {
            fail(
                "MATRIX_GROUP_CHAT_INVITE_REJECTED",
                "The Matrix homeserver rejected the group-chat invite. No new invite was sent."
            );
        }
        fail(
            "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS",
            "Matrix could not confirm the group-chat invite. Reconcile it before any retry."
        );
    }

    let observedMembership: MatrixInviteUserToGroupChatResult["observedMembership"];
    try {
        const actual = await exactSpaceInviteMembership(room.roomId, request.userId);
        if (actual === "invite" || actual === "join") observedMembership = actual;
    } catch { }
    try { emitRoom(room); } catch { }
    return {
        ...request,
        delivery: "accepted",
        ...(observedMembership ? { observedMembership } : {}),
        changed: true
    };
}

async function reconcileGroupChatInvite(
    command: Extract<MatrixWorkerCommand, { type: "reconcileGroupChatInvite"; }>
): Promise<MatrixReconcileGroupChatInviteResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateInviteUserToGroupChatRequest(command.request);
    if (request.userId === activeCredentials.userId) {
        fail("MATRIX_GROUP_CHAT_INVITE_SELF", "You cannot reconcile an invite for your own Matrix account.");
    }
    // Reconciliation is read-only truth recovery for a native-attested durable
    // receipt. It deliberately does not require the room to remain joined or
    // locally cached: either condition could otherwise trap the receipt.
    let membership: ExactSpaceInviteMembership | undefined;
    try { membership = await exactSpaceInviteMembership(request.roomId, request.userId); } catch { }
    if (membership !== "invite" && membership !== "join") return { status: "pending", ...request };
    return {
        status: "resolved",
        result: { ...request, delivery: "accepted", observedMembership: membership, changed: true }
    };
}

async function inviteUserToSpace(
    command: Extract<MatrixWorkerCommand, { type: "inviteUserToSpace"; }>,
    mutationDispatched: () => void
): Promise<MatrixInviteUserToSpaceResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const input = validateInviteUserToSpaceRequest(command.request);
    const request = { ...input, userId: requireLocalServerUserId(input.userId) };
    const space = joinedSpace(request.spaceId);
    if (request.userId === activeCredentials.userId) {
        fail("MATRIX_SPACE_INVITE_SELF", "You cannot invite your own Matrix account to this Space.");
    }
    const permission = spaceInvitePermission(space);
    if (permissionIsUnverifiable(permission)) {
        fail(
            "MATRIX_SPACE_INVITE_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify this Space's invite power levels."
        );
    }
    if (!permission.allowed) {
        fail("MATRIX_SPACE_INVITE_FORBIDDEN", "You do not have permission to invite users to this Matrix Space.");
    }

    const before = await exactSpaceInviteMembership(space.roomId, request.userId);
    if (before === "invite" || before === "join") {
        return { ...request, membership: before, changed: false };
    }
    if (before === "ban") {
        fail("MATRIX_SPACE_INVITE_BANNED", "That Matrix user is banned from this Space.");
    }

    try {
        mutationDispatched();
        await matrixClient.invite(space.roomId, request.userId);
    } catch (error) {
        let actual: ExactSpaceInviteMembership | undefined;
        try {
            actual = await exactSpaceInviteMembership(space.roomId, request.userId);
        } catch {
            // The original mutation failure determines whether retry is safe.
        }
        if (actual === "invite" || actual === "join") {
            try { emitRoom(space); } catch { }
            return { ...request, membership: actual, changed: true };
        }
        if (isDefinitiveMatrixMutationRejection(error)) {
            fail(
                "MATRIX_SPACE_INVITE_REJECTED",
                "The Matrix homeserver rejected the invite. No new invite was sent."
            );
        }
        fail(
            "MATRIX_SPACE_INVITE_AMBIGUOUS",
            "Matrix could not confirm the invite. It may already be pending; refresh before trying again."
        );
    }

    let membership: MatrixInviteUserToSpaceResult["membership"] = "invite";
    try {
        const actual = await exactSpaceInviteMembership(space.roomId, request.userId);
        if (actual === "invite" || actual === "join") membership = actual;
    } catch {
        // A successful /invite response already proves invite-or-invited state.
    }
    try { emitRoom(space); } catch { }
    return { ...request, membership, changed: true };
}

function validateSpaceAliasResolution(value: unknown): { roomId: string; servers: unknown[]; } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MATRIX_SPACE_ACCESS_INVALID", "Matrix returned an invalid Space alias response.");
    }
    const input = value as { room_id?: unknown; servers?: unknown; };
    if (!Array.isArray(input.servers) || input.servers.length > 100) {
        fail("MATRIX_SPACE_ACCESS_INVALID", "Matrix returned an invalid Space alias response.");
    }
    return { roomId: validateRoomId(input.room_id), servers: input.servers };
}

async function attestRequestEnabledSpace(
    joinAlias: string,
    roomId: string,
    viaServers: string[]
): Promise<MatrixRequestSpaceAccessResult["membership"] | undefined> {
    const localRoom = matrixClient!.getRoom(roomId);
    if (localRoom && !localRoom.isSpaceRoom()) {
        fail("MATRIX_SPACE_REQUIRED", "The selected Matrix room is not a Space.");
    }

    let summaryUnsupported = false;
    try {
        // The pre-join room summary surface can attest type and join rule even
        // though request-mode Spaces intentionally expose history only after
        // joining. Hierarchy commonly rejects that same nonmember.
        const summary = await matrixClient!.getRoomSummary(joinAlias, viaServers);
        const summaryJoinRule: unknown = summary?.join_rule;
        if (!summary || typeof summary !== "object" || Array.isArray(summary)
            || validateRoomId(summary.room_id) !== roomId
            || summary.room_type !== RoomType.Space
            || (summaryJoinRule !== JoinRule.Knock && summaryJoinRule !== "knock_restricted")) {
            fail("MATRIX_SPACE_REQUIRED", "Matrix could not verify a request-enabled Space at that join name.");
        }
        const summaryMembership: unknown = summary.membership;
        if (summaryMembership != null && summaryMembership !== "knock" && summaryMembership !== "invite"
            && summaryMembership !== "join" && summaryMembership !== "leave" && summaryMembership !== "ban") {
            fail("MATRIX_SPACE_ACCESS_INVALID", "Matrix returned an invalid Space membership summary.");
        }
        if (summaryMembership === "knock" || summaryMembership === "invite" || summaryMembership === "join") {
            return summaryMembership;
        }
    } catch (error) {
        if (matrixErrorCode(error) !== "M_UNRECOGNIZED") throw error;
        summaryUnsupported = true;
    }
    if (!summaryUnsupported) return undefined;

    const hierarchy = await matrixClient!.getRoomHierarchy(roomId, 1, 0, false);
    if (!hierarchy || typeof hierarchy !== "object" || !Array.isArray(hierarchy.rooms)
        || hierarchy.rooms.length > 100) {
        fail("MATRIX_SPACE_REQUIRED", "Matrix could not verify a request-enabled Space at that join name.");
    }
    const root = hierarchy.rooms.slice(0, 10).find(room => room?.room_id === roomId);
    const rootJoinRule: unknown = root?.join_rule;
    if (!root || root.room_type !== RoomType.Space
        || (rootJoinRule !== JoinRule.Knock && rootJoinRule !== "knock_restricted")) {
        fail("MATRIX_SPACE_REQUIRED", "Matrix could not verify a request-enabled Space at that join name.");
    }
    return undefined;
}

async function reconciledSpaceAccessMembership(
    joinAlias: string,
    roomId: string,
    viaServers: string[],
    userId: string
): Promise<MatrixRequestSpaceAccessResult["membership"] | undefined> {
    try {
        const resolved = validateSpaceAliasResolution(await matrixClient!.getRoomIdForAlias(joinAlias));
        if (resolved.roomId !== roomId) return undefined;
        const summaryMembership = await attestRequestEnabledSpace(joinAlias, roomId, viaServers);
        const localMembership = matrixClient!.getRoom(roomId)?.getMyMembership();
        if (localMembership === "knock" || localMembership === "invite" || localMembership === "join") {
            return localMembership;
        }
        if (summaryMembership) return summaryMembership;
        const membership = await exactRoomMembership(roomId, userId);
        return membership === "knock" || membership === "invite" || membership === "join"
            ? membership
            : undefined;
    } catch {
        return undefined;
    }
}

async function requestSpaceAccess(
    command: Extract<MatrixWorkerCommand, { type: "requestSpaceAccess"; }>
): Promise<MatrixRequestSpaceAccessResult> {
    if (!matrixClient || !activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const requestingUserId = activeCredentials.userId;
    const joinName = validateSpaceJoinName(command.joinName);
    const joinAlias = sameServerSpaceAlias(joinName);
    const { roomId, servers } = validateSpaceAliasResolution(await matrixClient.getRoomIdForAlias(joinAlias));
    const viaServers = [activeServerName()];
    for (const rawServer of servers.slice(0, 3)) {
        try {
            const server = validateServerName(rawServer);
            if (!viaServers.includes(server)) viaServers.push(server);
        } catch {
            // Ignore an invalid routing hint from an otherwise exact alias
            // response. The active alias server remains authoritative.
        }
        if (viaServers.length >= 3) break;
    }
    const localRoom = matrixClient.getRoom(roomId);
    if (localRoom && !localRoom.isSpaceRoom()) {
        fail("MATRIX_SPACE_REQUIRED", "The selected Matrix room is not a Space.");
    }

    const currentMembership = localRoom?.getMyMembership();
    if (currentMembership === "join" || currentMembership === "invite") {
        return { roomId, membership: currentMembership };
    }
    if (currentMembership === "knock") {
        await attestRequestEnabledSpace(joinAlias, roomId, viaServers);
        return { roomId, membership: currentMembership };
    }

    await attestRequestEnabledSpace(joinAlias, roomId, viaServers);
    try {
        const knocked = await matrixClient.knockRoom(roomId, { viaServers });
        if (validateRoomId(knocked?.room_id) !== roomId) {
            fail("MATRIX_SPACE_ACCESS_INVALID", "Matrix returned an unexpected room for the Space access request.");
        }
    } catch (error) {
        const membership = await reconciledSpaceAccessMembership(
            joinAlias,
            roomId,
            viaServers,
            requestingUserId
        );
        if (membership) return { roomId, membership };
        if (isDefinitiveMatrixMutationRejection(error)) throw error;
        fail(
            "MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS",
            "Matrix could not confirm the access request. It may already be pending; refresh before trying again."
        );
    }
    return { roomId, membership: "knock" };
}

function validateCreateSpaceRequest(value: unknown): Required<Pick<MatrixCreateSpaceRequest, "name" | "visibility" | "createGeneral">>
    & Pick<MatrixCreateSpaceRequest, "topic"> {
    if (!value || typeof value !== "object") fail("MATRIX_INVALID_ARGUMENT", "The Matrix space details are invalid.");
    const input = value as Partial<MatrixCreateSpaceRequest>;
    const name = validateString(input.name, "space name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix space name is invalid.");
    }
    const visibility = input.visibility ?? "private";
    if (visibility !== "private" && visibility !== "public") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix space visibility is invalid.");
    }
    const createGeneral = input.createGeneral ?? true;
    if (typeof createGeneral !== "boolean") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix initial-room option is invalid.");
    }
    let topic: string | undefined;
    if (input.topic != null) {
        topic = validateString(input.topic, "space topic", 1_024, true).trim();
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            fail("MATRIX_INVALID_ARGUMENT", "The Matrix space topic is invalid.");
        }
        if (!topic) topic = undefined;
    }
    return { name, topic, visibility, createGeneral };
}

function roomVersionSupportsCreation(version: string, restrictedRequired: boolean): boolean {
    return (SDK_STANDARD_ROOM_VERSIONS as readonly string[]).includes(version)
        && (!restrictedRequired || RESTRICTED_ROOM_VERSIONS.has(version));
}

async function selectCreationRoomVersion(restrictedRequired: boolean): Promise<string> {
    let capabilities: unknown;
    try {
        capabilities = await matrixClient!.getCapabilities();
    } catch {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            "Matrix could not verify a compatible room version before creation. No room was created."
        );
    }
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            "Matrix returned invalid room-version capabilities. No room was created."
        );
    }
    const capability = (capabilities as Record<string, unknown>)["m.room_versions"];
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            "The Matrix homeserver did not advertise compatible room versions. No room was created."
        );
    }
    const { default: defaultVersion, available } = capability as { default?: unknown; available?: unknown; };
    if (typeof defaultVersion !== "string" || defaultVersion.length > 32
        || !available || typeof available !== "object" || Array.isArray(available)) {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            "Matrix returned invalid room-version capabilities. No room was created."
        );
    }
    const versions = available as Record<string, unknown>;
    const entries = Object.entries(versions);
    if (entries.length > 128 || entries.some(([version, stability]) =>
        !version || version.length > 32 || (stability !== "stable" && stability !== "unstable"))) {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            "Matrix returned invalid room-version capabilities. No room was created."
        );
    }
    if (roomVersionSupportsCreation(defaultVersion, restrictedRequired)
        && (versions[defaultVersion] === "stable" || versions[defaultVersion] === "unstable")) {
        return defaultVersion;
    }
    const fallback = SDK_STANDARD_ROOM_VERSIONS_NEWEST_FIRST.find(version =>
        roomVersionSupportsCreation(version, restrictedRequired) && versions[version] === "stable");
    if (!fallback) {
        fail(
            "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED",
            restrictedRequired
                ? "This Matrix homeserver does not advertise a stable room version that supports restricted Space children. No room was created."
                : "This Matrix homeserver does not advertise a compatible stable room version. No room was created."
        );
    }
    return fallback;
}

function roomCreationPowerLevels(roomVersion: string) {
    const common = {
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 50
    };
    // createRoom applies each supplied top-level key over generated preset
    // power levels. Replace the generated users/events maps so the state we
    // attest is deterministic across homeservers. Hydra creators have
    // infinite authority and MUST NOT appear in `users`; v12 also requires
    // tombstone above state_default.
    const users: Record<string, number> = roomVersion === "12"
        ? {}
        : { [activeCredentials!.userId]: 100 };
    const events: Record<string, number> = roomVersion === "12"
        ? { [EventType.RoomTombstone]: 150 }
        : {};
    return { ...common, users, events };
}

function validateGroupChatCreationMarker(value: unknown): string {
    const marker = validateString(value, "Group-chat creation marker", 72);
    if (!GROUP_CHAT_CREATION_MARKER_PATTERN.test(marker)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat creation marker is invalid.");
    }
    return marker;
}

function groupChatInvitationForMembership(
    userId: string,
    membership: ExactSpaceInviteMembership | undefined,
    fallback: "invited" | "rejected" | "ambiguous"
): MatrixGroupChatInvitationDTO {
    return {
        userId,
        status: membership === "join" ? "joined" : membership === "invite" ? "invited" : fallback
    };
}

async function inviteGroupChatUser(roomId: string, userId: string): Promise<MatrixGroupChatInvitationDTO> {
    let before: ExactSpaceInviteMembership | undefined;
    try { before = await exactSpaceInviteMembership(roomId, userId); } catch { }
    if (before === "invite" || before === "join") {
        return groupChatInvitationForMembership(userId, before, "invited");
    }
    try {
        await matrixClient!.invite(roomId, userId);
    } catch (error) {
        let actual: ExactSpaceInviteMembership | undefined;
        try { actual = await exactSpaceInviteMembership(roomId, userId); } catch { }
        if (actual === "invite" || actual === "join") {
            return groupChatInvitationForMembership(userId, actual, "invited");
        }
        return groupChatInvitationForMembership(
            userId,
            actual,
            isDefinitiveMatrixMutationRejection(error) ? "rejected" : "ambiguous"
        );
    }
    let actual: ExactSpaceInviteMembership | undefined;
    try { actual = await exactSpaceInviteMembership(roomId, userId); } catch { }
    // A successful /invite response proves the invite even when a subsequent
    // exact state read is temporarily unavailable.
    return groupChatInvitationForMembership(userId, actual, "invited");
}

async function inviteGroupChatUsers(
    roomId: string,
    userIds: readonly string[]
): Promise<MatrixGroupChatInvitationDTO[]> {
    const results = new Array<MatrixGroupChatInvitationDTO>(userIds.length);
    let nextIndex = 0;
    await Promise.all(Array.from(
        { length: Math.min(GROUP_CHAT_INVITE_CONCURRENCY, userIds.length) },
        async () => {
            while (nextIndex < userIds.length) {
                const index = nextIndex++;
                results[index] = await inviteGroupChatUser(roomId, userIds[index]);
            }
        }
    ));
    return results;
}

function matrixRoomStateContent(room: Room, eventType: string): Record<string, unknown> | undefined {
    const event = room.currentState.getStateEvents(eventType, "");
    if (!event || Array.isArray(event)) return undefined;
    const content: unknown = event.getContent();
    return content && typeof content === "object" && !Array.isArray(content)
        ? content as Record<string, unknown>
        : undefined;
}

function exactGroupChatPowerLevel(
    content: Record<string, unknown>,
    key: string,
    expected: number,
    roomVersion: string
): boolean {
    if (!Object.hasOwn(content, key)) return false;
    const parsed = parseMatrixPowerLevel(content[key], roomVersion);
    return parsed.valid && parsed.value === expected;
}

function exactGroupChatPowerLevelContent(
    content: Record<string, unknown>,
    creatorId: string,
    roomVersion: string
): boolean {
    if (!exactGroupChatPowerLevel(content, "users_default", 0, roomVersion)
        || !exactGroupChatPowerLevel(content, "events_default", 0, roomVersion)
        || !exactGroupChatPowerLevel(content, "state_default", 50, roomVersion)
        || !exactGroupChatPowerLevel(content, "invite", 50, roomVersion)
        || !exactGroupChatPowerLevel(content, "kick", 50, roomVersion)
        || !exactGroupChatPowerLevel(content, "ban", 50, roomVersion)
        || !exactGroupChatPowerLevel(content, "redact", 50, roomVersion)) return false;

    const hasUsers = Object.hasOwn(content, "users");
    const usersValue = content.users;
    if (hasUsers && (!usersValue || typeof usersValue !== "object" || Array.isArray(usersValue))) return false;
    const users = hasUsers ? usersValue as Record<string, unknown> : undefined;
    if (roomVersion === "12") {
        if (users && Object.hasOwn(users, creatorId)) return false;
    } else if (!users || !Object.hasOwn(users, creatorId)) {
        return false;
    }
    if (users) {
        for (const [userIdValue, levelValue] of Object.entries(users)) {
            let userId: string;
            try { userId = validateUserId(userIdValue); } catch { return false; }
            const parsed = parseMatrixPowerLevel(levelValue, roomVersion);
            if (!parsed.valid || (userId === creatorId
                ? roomVersion === "12" || parsed.value !== 100
                : parsed.value > 0)) return false;
        }
    }

    const hasEvents = Object.hasOwn(content, "events");
    const eventsValue = content.events;
    if (roomVersion === "12") {
        if (!eventsValue || typeof eventsValue !== "object" || Array.isArray(eventsValue)) return false;
        const events = eventsValue as Record<string, unknown>;
        if (Object.keys(events).length !== 1) return false;
        const tombstone = parseMatrixPowerLevel(events[EventType.RoomTombstone], roomVersion);
        return tombstone.valid && tombstone.value === 150;
    }
    return !hasEvents || (eventsValue != null && typeof eventsValue === "object" && !Array.isArray(eventsValue)
        && Object.keys(eventsValue as Record<string, unknown>).length === 0);
}

function exactGroupChatPowerLevels(room: Room, creatorId: string, roomVersion: string): boolean {
    const event = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    if (!event || Array.isArray(event) || event.getSender() !== creatorId) return false;
    const rawContent: unknown = event.getContent();
    return Boolean(rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)
        && exactGroupChatPowerLevelContent(rawContent as Record<string, unknown>, creatorId, roomVersion));
}

interface GroupChatRoomContract {
    creatorId: string;
    creationMarker: string;
    roomVersion: string;
}

function exactGroupChatCreationContent(creation: Record<string, unknown>, roomVersion: string): boolean {
    if (creation["m.federate"] !== false || Object.hasOwn(creation, "type")) return false;
    if (!Object.hasOwn(creation, "additional_creators")) return true;
    return roomVersion === "12" && Array.isArray(creation.additional_creators)
        && creation.additional_creators.length === 0;
}

function validGroupChatCreationMarker(value: unknown): string | undefined {
    return typeof value === "string" && GROUP_CHAT_CREATION_MARKER_PATTERN.test(value)
        ? value
        : undefined;
}

function groupChatStateMarker(room: Room, creatorId: string): string | undefined {
    const markerEvent = room.currentState.getStateEvents(GROUP_CHAT_CREATION_EVENT_TYPE, "");
    if (!markerEvent || Array.isArray(markerEvent) || markerEvent.getSender() !== creatorId) return undefined;
    const rawMarkerContent: unknown = markerEvent.getContent();
    if (!rawMarkerContent || typeof rawMarkerContent !== "object" || Array.isArray(rawMarkerContent)) return undefined;
    const { marker } = rawMarkerContent as Record<string, unknown>;
    return validGroupChatCreationMarker(marker);
}

function groupChatRoomIdentity(room: Room): GroupChatRoomContract | undefined {
    if (room.isSpaceRoom()) return undefined;
    const roomVersion = room.getVersion();
    if (!(SDK_STANDARD_ROOM_VERSIONS as readonly string[]).includes(roomVersion)) return undefined;
    const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
    if (!createEvent || Array.isArray(createEvent)) return undefined;
    let creatorId: string;
    try { creatorId = validateUserId(createEvent.getSender()); } catch { return undefined; }
    const createContent: unknown = createEvent.getContent();
    if (!createContent || typeof createContent !== "object" || Array.isArray(createContent)) return undefined;
    const creation = createContent as Record<string, unknown>;
    if (!exactGroupChatCreationContent(creation, roomVersion)) return undefined;
    // Custom state is not guaranteed to be present in stripped invite state,
    // while m.room.create is. New groups carry their marker in the immutable
    // creator-signed create event; retain the state-event fallback for rooms
    // created by earlier bridge builds.
    const hasCreateMarker = Object.hasOwn(creation, GROUP_CHAT_CREATION_CONTENT_KEY);
    const creationMarker = hasCreateMarker
        ? validGroupChatCreationMarker(creation[GROUP_CHAT_CREATION_CONTENT_KEY])
        : groupChatStateMarker(room, creatorId);
    if (!creationMarker) return undefined;
    return { creatorId, creationMarker, roomVersion };
}

function groupChatPrivacyContract(room: Room): GroupChatRoomContract | undefined {
    const identity = groupChatRoomIdentity(room);
    if (!identity) return undefined;
    const encryption = matrixRoomStateContent(room, EventType.RoomEncryption);
    const joinRules = matrixRoomStateContent(room, EventType.RoomJoinRules);
    const history = matrixRoomStateContent(room, EventType.RoomHistoryVisibility);
    const guest = matrixRoomStateContent(room, EventType.RoomGuestAccess);
    if (encryption?.algorithm !== "m.megolm.v1.aes-sha2"
        || joinRules?.join_rule !== JoinRule.Invite
        || history?.history_visibility !== HistoryVisibility.Joined
        || guest?.guest_access !== GuestAccess.Forbidden
        || groupChatStateMarker(room, identity.creatorId) !== identity.creationMarker) return undefined;
    return identity;
}

function groupChatRoomContract(room: Room): GroupChatRoomContract | undefined {
    const privacy = groupChatPrivacyContract(room);
    return privacy && exactGroupChatPowerLevels(room, privacy.creatorId, privacy.roomVersion)
        ? privacy
        : undefined;
}

function identifiedGroupChat(roomId: string): Room {
    if (!activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const room = getRoom(roomId);
    if (!groupChatRoomIdentity(room)) {
        fail("MATRIX_GROUP_CHAT_REQUIRED", "The selected Matrix room is not a bridge-created group chat.");
    }
    return room;
}

function joinedInvitableGroupChat(roomId: string): Room {
    const room = identifiedGroupChat(roomId);
    if (room.getMyMembership() !== "join") {
        fail("MATRIX_GROUP_CHAT_NOT_JOINED", "Join the Matrix group chat before inviting people.");
    }
    if (!groupChatPrivacyContract(room)) {
        fail(
            "MATRIX_GROUP_CHAT_PRIVACY_UNVERIFIABLE",
            "Matrix could not verify this group chat's private encrypted-room contract."
        );
    }
    return room;
}

interface GroupChatMembershipSnapshot {
    memberships: Map<string, MatrixGroupChatCandidateMembership>;
    participantCount: number;
}

async function exactGroupChatMembershipSnapshot(room: Room): Promise<GroupChatMembershipSnapshot> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const response = await matrixClient.members(room.roomId, undefined, "leave");
    const { chunk } = (response as unknown as { chunk?: unknown; });
    if (!Array.isArray(chunk) || chunk.length > MAX_GROUP_CHAT_MEMBERSHIP_EVENTS) {
        fail("MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID", "Matrix returned an invalid group-chat membership snapshot.");
    }
    const memberships = new Map<string, MatrixGroupChatCandidateMembership>();
    for (const value of chunk) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            fail("MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID", "Matrix returned an invalid group-chat membership snapshot.");
        }
        const event = value as Record<string, unknown>;
        if (event.type !== EventType.RoomMember || typeof event.state_key !== "string"
            || !event.content || typeof event.content !== "object" || Array.isArray(event.content)) {
            fail("MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID", "Matrix returned an invalid group-chat membership snapshot.");
        }
        const userId = requireLocalServerUserId(event.state_key);
        const { membership } = (event.content as Record<string, unknown>);
        if (membership !== "leave" && membership !== "knock" && membership !== "invite"
            && membership !== "join" && membership !== "ban") {
            fail("MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID", "Matrix returned an invalid group-chat membership snapshot.");
        }
        if (memberships.has(userId)) {
            fail("MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID", "Matrix returned duplicate group-chat membership state.");
        }
        memberships.set(userId, membership);
    }
    if (memberships.get(activeCredentials.userId) !== "join") {
        fail("MATRIX_GROUP_CHAT_NOT_JOINED", "The active Matrix account is not joined to this group chat.");
    }
    const participantCount = [...memberships.values()]
        .filter(membership => membership === "join" || membership === "invite").length;
    return { memberships, participantCount };
}

function attestedGroupChatRoom(room: Room, creationMarker: string): boolean {
    if (!activeCredentials || room.getMyMembership() !== "join") return false;
    const contract = groupChatRoomContract(room);
    return contract?.creatorId === activeCredentials.userId
        && contract.creationMarker === creationMarker;
}

function projectableSpaceChildren(room: Room): MatrixSpaceChildDTO[] {
    return localSpaceChildren(room).filter(child => {
        const childRoom = matrixClient?.getRoom(child.roomId);
        return !childRoom || !groupChatRoomIdentity(childRoom);
    });
}

interface RawGroupChatStateEvent {
    sender: string;
    content: Record<string, unknown>;
}

function rawGroupChatStateEvent(
    state: unknown[],
    eventType: string,
    stateKey: string
): RawGroupChatStateEvent | undefined {
    const matches = state.filter(value => value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).type === eventType
        && (value as Record<string, unknown>).state_key === stateKey);
    if (matches.length !== 1) return undefined;
    const raw = matches[0] as Record<string, unknown>;
    let sender: string;
    try { sender = validateUserId(raw.sender); } catch { return undefined; }
    if (!raw.content || typeof raw.content !== "object" || Array.isArray(raw.content)) return undefined;
    return { sender, content: raw.content as Record<string, unknown> };
}

async function attestCreatedGroupChatState(
    roomId: string,
    roomVersion: string,
    creationMarker: string
): Promise<boolean> {
    if (!activeCredentials || !matrixClient) return false;
    let state: unknown;
    try { state = await matrixClient.roomState(roomId); } catch { return false; }
    if (!Array.isArray(state) || state.length > 10_000) return false;
    const create = rawGroupChatStateEvent(state, EventType.RoomCreate, "");
    if (!create || create.sender !== activeCredentials.userId
        || !exactGroupChatCreationContent(create.content, roomVersion)
        || create.content[GROUP_CHAT_CREATION_CONTENT_KEY] !== creationMarker) return false;
    const marker = rawGroupChatStateEvent(state, GROUP_CHAT_CREATION_EVENT_TYPE, "");
    const encryption = rawGroupChatStateEvent(state, EventType.RoomEncryption, "");
    const joinRules = rawGroupChatStateEvent(state, EventType.RoomJoinRules, "");
    const history = rawGroupChatStateEvent(state, EventType.RoomHistoryVisibility, "");
    const guest = rawGroupChatStateEvent(state, EventType.RoomGuestAccess, "");
    const powerLevels = rawGroupChatStateEvent(state, EventType.RoomPowerLevels, "");
    const ownMembership = rawGroupChatStateEvent(state, EventType.RoomMember, activeCredentials.userId);
    return marker?.sender === create.sender && marker.content.marker === creationMarker
        && encryption?.content.algorithm === "m.megolm.v1.aes-sha2"
        && joinRules?.content.join_rule === JoinRule.Invite
        && history?.content.history_visibility === HistoryVisibility.Joined
        && guest?.content.guest_access === GuestAccess.Forbidden
        && powerLevels?.sender === create.sender
        && exactGroupChatPowerLevelContent(powerLevels.content, create.sender, roomVersion)
        && ownMembership?.content.membership === "join";
}

async function createGroupChat(
    command: Extract<MatrixWorkerCommand, { type: "createGroupChat"; }>,
    mutationDispatched: () => void
): Promise<MatrixCreateGroupChatResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateCreateGroupChatRequest(command.request);
    requireCurrentGroupChatDirectoryCandidates(request.userIds);
    const creationMarker = validateGroupChatCreationMarker(command.creationMarker);
    const roomVersion = await selectCreationRoomVersion(false);
    let roomId: string;
    try {
        mutationDispatched();
        const created = await matrixClient.createRoom({
            name: request.name,
            visibility: Visibility.Private,
            preset: Preset.PrivateChat,
            room_version: roomVersion,
            creation_content: {
                "m.federate": false,
                [GROUP_CHAT_CREATION_CONTENT_KEY]: creationMarker
            },
            power_level_content_override: roomCreationPowerLevels(roomVersion),
            initial_state: [{
                type: EventType.RoomJoinRules,
                state_key: "",
                content: { join_rule: JoinRule.Invite }
            }, {
                type: EventType.RoomHistoryVisibility,
                state_key: "",
                content: { history_visibility: HistoryVisibility.Joined }
            }, {
                type: EventType.RoomGuestAccess,
                state_key: "",
                content: { guest_access: GuestAccess.Forbidden }
            }, {
                type: EventType.RoomEncryption,
                state_key: "",
                content: { algorithm: "m.megolm.v1.aes-sha2" }
            }, {
                type: GROUP_CHAT_CREATION_EVENT_TYPE,
                state_key: "",
                content: { marker: creationMarker }
            }]
        });
        roomId = validateRoomId(created?.room_id);
        if (!await attestCreatedGroupChatState(roomId, roomVersion, creationMarker)) {
            fail(
                "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
                "Matrix created a group chat, but its locked private-room state could not be confirmed. Reconcile it before trying again."
            );
        }
    } catch (error) {
        if (isDefinitiveCreateRoomRejection(error)) {
            fail(
                "MATRIX_CREATE_GROUP_CHAT_REJECTED",
                "The Matrix homeserver rejected group-chat creation. No room was created."
            );
        }
        fail(
            "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
            "Matrix group-chat creation may have succeeded. Reconcile it before trying again."
        );
    }

    const invitations = await inviteGroupChatUsers(roomId, request.userIds);
    const result: MatrixCreateGroupChatResult = {
        roomId,
        name: request.name,
        invitations,
        complete: invitations.every(invitation => invitation.status === "invited" || invitation.status === "joined")
    };
    const room = matrixClient.getRoom(roomId);
    if (room) {
        try { emitRoom(room); } catch { }
    }
    return result;
}

async function reconcileGroupChatCreate(
    command: Extract<MatrixWorkerCommand, { type: "reconcileGroupChatCreate"; }>
): Promise<MatrixReconcileGroupChatCreateResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const creationMarker = validateGroupChatCreationMarker(command.creationMarker);
    const request = validateCreateGroupChatRequest({ name: command.name, userIds: command.userIds });
    const rooms = matrixClient.getRooms();
    if (rooms.length > 10_000) {
        fail("MATRIX_GROUP_CHAT_RECONCILE_INCOMPLETE", "There are too many joined rooms to reconcile safely.");
    }
    // A marker is visible to invitees. Count only rooms whose immutable
    // creator and full locked privacy/PL contract attest this account; foreign
    // marker copies and unilateral invitations cannot poison reconciliation.
    const matches = rooms.filter(room => attestedGroupChatRoom(room, creationMarker));
    if (matches.length > 1) {
        fail("MATRIX_GROUP_CHAT_RECONCILE_CONFLICT", "Multiple Matrix rooms used the same group-chat creation marker.");
    }
    if (!matches.length) return { status: "pending" };
    const room = matches[0];
    if (!await exactOwnJoinedRoom(room.roomId)) {
        fail("MATRIX_GROUP_CHAT_RECONCILE_CONFLICT", "The recovered Matrix room did not match the private group-chat contract.");
    }
    const invitations = await Promise.all(request.userIds.map(async userId => {
        let membership: ExactSpaceInviteMembership | undefined;
        try { membership = await exactSpaceInviteMembership(room.roomId, userId); } catch { }
        // An absent membership cannot distinguish an unattempted invite from a
        // lost response or a recipient who already declined. Never resend here.
        return groupChatInvitationForMembership(userId, membership, "ambiguous");
    }));
    return {
        status: "resolved",
        result: {
            roomId: room.roomId,
            name: request.name,
            invitations,
            complete: invitations.every(invitation => invitation.status === "invited" || invitation.status === "joined")
        }
    };
}

async function createSpace(
    command: Extract<MatrixWorkerCommand, { type: "createSpace"; }>,
    mutationDispatched: () => void
): Promise<MatrixCreateSpaceResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateCreateSpaceRequest(command.request);
    const isPublic = request.visibility === "public";
    const viaServer = activeServerName();
    // Select before the first non-idempotent request. A requested private
    // #general needs restricted joins, so its selected version must be v8+.
    const roomVersion = await selectCreationRoomVersion(!isPublic && request.createGeneral);
    let roomId: string;
    try {
        mutationDispatched();
        const created = await matrixClient.createRoom({
            name: request.name,
            topic: request.topic,
            visibility: isPublic ? Visibility.Public : Visibility.Private,
            preset: isPublic ? Preset.PublicChat : Preset.PrivateChat,
            room_version: roomVersion,
            creation_content: { type: RoomType.Space },
            // Spell out the security-relevant defaults instead of depending on a
            // homeserver's preset implementation. The creator remains the sole
            // administrator (PL100) until they invite or promote someone.
            power_level_content_override: roomCreationPowerLevels(roomVersion),
            initial_state: [{
                type: EventType.RoomJoinRules,
                state_key: "",
                content: { join_rule: isPublic ? JoinRule.Public : JoinRule.Invite }
            }, {
                type: EventType.RoomHistoryVisibility,
                state_key: "",
                // Directory visibility and public joinability do not require
                // exposing the Space's state history to anonymous users.
                content: { history_visibility: HistoryVisibility.Joined }
            }]
        });
        roomId = validateRoomId(created.room_id);
    } catch (error) {
        if (isDefinitiveCreateRoomRejection(error)) {
            fail(
                "MATRIX_CREATE_SPACE_REJECTED",
                "The Matrix homeserver rejected Space creation. No Space was created."
            );
        }
        fail(
            "MATRIX_CREATE_SPACE_AMBIGUOUS",
            "Matrix could not confirm Space creation. A Space may exist; refresh before trying again."
        );
    }
    const result: MatrixCreateSpaceResult = { roomId };

    if (request.createGeneral) {
        let generalRoomId: string | undefined;
        try {
            const initialState: Array<{
                type: string;
                state_key: string;
                content: Record<string, unknown>;
            }> = [{
                type: EventType.RoomJoinRules,
                state_key: "",
                content: isPublic
                    ? { join_rule: JoinRule.Public }
                    : {
                        join_rule: JoinRule.Restricted,
                        allow: [{
                            type: RestrictedAllowType.RoomMembership,
                            room_id: roomId
                        }]
                    }
            }, {
                type: EventType.RoomHistoryVisibility,
                state_key: "",
                content: { history_visibility: HistoryVisibility.Joined }
            }, {
                type: EventType.RoomGuestAccess,
                state_key: "",
                content: { guest_access: GuestAccess.Forbidden }
            }, {
                type: EventType.SpaceParent,
                state_key: roomId,
                content: { via: [viaServer], canonical: true }
            }];
            if (!isPublic) {
                initialState.push({
                    type: EventType.RoomEncryption,
                    state_key: "",
                    content: { algorithm: "m.megolm.v1.aes-sha2" }
                });
            }
            const general = await matrixClient.createRoom({
                name: "general",
                // Child chats are discovered through their Space rather than
                // each occupying a separate homeserver-directory entry.
                visibility: Visibility.Private,
                preset: isPublic ? Preset.PublicChat : Preset.PrivateChat,
                room_version: roomVersion,
                power_level_content_override: roomCreationPowerLevels(roomVersion),
                initial_state: initialState
            });
            generalRoomId = validateRoomId(general.room_id);
            result.generalRoomId = generalRoomId;
        } catch (error) {
            result.partial = {
                code: isDefinitiveCreateRoomRejection(error)
                    ? "MATRIX_GENERAL_ROOM_CREATE_FAILED"
                    : "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS",
                message: isDefinitiveCreateRoomRejection(error)
                    ? "The Matrix Space was created, but the homeserver rejected its general chat."
                    : "The Matrix Space was created, but the general-chat result is unconfirmed. It may exist unlinked; refresh before making another."
            } satisfies MatrixCreateSpacePartialResult;
        }

        if (generalRoomId) {
            try {
                // State PUTs are idempotent by (room, type, state key), so a
                // future repair can safely repeat this half of the relation.
                await matrixClient.sendStateEvent(roomId, EventType.SpaceChild, {
                    via: [viaServer],
                    suggested: true
                }, generalRoomId);
            } catch {
                result.partial = {
                    code: "MATRIX_GENERAL_ROOM_LINK_FAILED",
                    message: "The Matrix Space and general chat were created, but Matrix could not link them completely."
                } satisfies MatrixCreateSpacePartialResult;
            }
        }
    }

    // /createRoom is the authoritative success boundary. Sync normally adds
    // the fully-populated room immediately afterwards; do not turn a slow sync
    // into a false creation failure which encourages duplicate retries.
    try {
        const room = matrixClient.getRoom(roomId);
        if (room?.getMyMembership() === "join") {
            observeRoom(room);
            emitRoom(room);
        }
        emit({ type: "snapshot", snapshot: snapshot() });
    } catch {
        // Creation is non-idempotent. Once the homeserver returned room_id,
        // never report a projection/normalization failure as a create failure:
        // the regular sync listener will publish the room, and reporting an
        // error here would invite a retry that creates a duplicate Space.
    }
    return result;
}

function validateCreateSpaceChildRequest(value: unknown): MatrixCreateSpaceChildRequest {
    if (!value || typeof value !== "object") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child details are invalid.");
    }
    const input = value as Partial<MatrixCreateSpaceChildRequest>;
    const parentSpaceId = validateRoomId(input.parentSpaceId);
    if (input.kind !== "room" && input.kind !== "space") {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child type is invalid.");
    }
    const name = validateString(input.name, "Space child name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child name is invalid.");
    }
    const request: MatrixCreateSpaceChildRequest = { parentSpaceId, kind: input.kind, name };
    if (input.topic != null) {
        const topic = validateString(input.topic, "Space child topic", 1_024, true).trim();
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child topic is invalid.");
        }
        if (topic) request.topic = topic;
    }
    return request;
}

async function createSpaceChild(
    command: Extract<MatrixWorkerCommand, { type: "createSpaceChild"; }>,
    mutationDispatched: () => void
): Promise<MatrixCreateSpaceChildResult> {
    if (!activeCredentials || !matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateCreateSpaceChildRequest(command.request);
    const creationMarker = validateString(command.creationMarker, "Space child creation marker", 73);
    if (!SPACE_CHILD_CREATION_MARKER_PATTERN.test(creationMarker)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child creation marker is invalid.");
    }
    const parent = getRoom(request.parentSpaceId);
    if (!parent.isSpaceRoom()) {
        fail("MATRIX_SPACE_REQUIRED", "The selected Matrix room is not a Space.");
    }
    const childPermission = spaceChildPermission(parent);
    if (permissionIsUnverifiable(childPermission)) {
        fail(
            "MATRIX_SPACE_CHILD_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify this Space's room-link power levels."
        );
    }
    if (!childPermission.allowed) {
        fail(
            "MATRIX_SPACE_CHILD_FORBIDDEN",
            "You do not have permission to add rooms to this Matrix Space."
        );
    }

    // Only an explicitly public parent produces a public child. Restricted,
    // invite-only, knock, and unknown parents all fail closed to private.
    const visibility = normalizeJoinRule(parent.getJoinRule()) === "public" ? "public" : "private";
    const isPublic = visibility === "public";
    const viaServer = activeServerName();
    const roomVersion = await selectCreationRoomVersion(!isPublic);
    const initialState: Array<{
        type: string;
        state_key: string;
        content: Record<string, unknown>;
    }> = [{
        type: EventType.RoomJoinRules,
        state_key: "",
        content: isPublic
            ? { join_rule: JoinRule.Public }
            : {
                join_rule: JoinRule.Restricted,
                allow: [{
                    type: RestrictedAllowType.RoomMembership,
                    room_id: parent.roomId
                }]
            }
    }, {
        type: EventType.RoomHistoryVisibility,
        state_key: "",
        content: { history_visibility: HistoryVisibility.Joined }
    }, {
        type: EventType.RoomGuestAccess,
        state_key: "",
        content: { guest_access: GuestAccess.Forbidden }
    }, {
        type: EventType.SpaceParent,
        state_key: parent.roomId,
        content: { via: [viaServer], canonical: true }
    }, {
        type: SPACE_CHILD_CREATION_EVENT_TYPE,
        state_key: "",
        content: { marker: creationMarker }
    }];
    if (!isPublic && request.kind === "room") {
        initialState.push({
            type: EventType.RoomEncryption,
            state_key: "",
            content: { algorithm: "m.megolm.v1.aes-sha2" }
        });
    }

    let roomId: string;
    try {
        mutationDispatched();
        const created = await matrixClient.createRoom({
            name: request.name,
            topic: request.topic,
            // Nested rooms and categories are discovered through the parent Space,
            // so neither public nor private children are listed independently.
            visibility: Visibility.Private,
            preset: isPublic ? Preset.PublicChat : Preset.PrivateChat,
            room_version: roomVersion,
            ...(request.kind === "space" ? { creation_content: { type: RoomType.Space } } : {}),
            power_level_content_override: roomCreationPowerLevels(roomVersion),
            initial_state: initialState
        });
        roomId = validateRoomId(created.room_id);
    } catch (error) {
        if (isDefinitiveCreateRoomRejection(error)) {
            fail(
                "MATRIX_CREATE_SPACE_CHILD_REJECTED",
                "The Matrix homeserver rejected room creation. No room was created."
            );
        }
        // /createRoom has no idempotency key. After dispatch, even a transport
        // failure can hide a committed room, so only marker reconciliation may
        // decide whether another create is safe.
        fail(
            "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS",
            "Matrix room creation may have succeeded. Reconcile the parent Space before trying again."
        );
    }
    const result: MatrixCreateSpaceChildResult = { roomId, visibility };

    try {
        // The parent-side half is idempotent by (room, type, state key), but
        // createRoom above is not. Once roomId exists, report it even if this
        // repairable link write fails so callers never create a duplicate.
        await matrixClient.sendStateEvent(parent.roomId, EventType.SpaceChild, {
            via: [viaServer],
            suggested: true
        }, roomId);
    } catch {
        result.partial = {
            code: "MATRIX_SPACE_CHILD_LINK_FAILED",
            message: "The Matrix room was created, but Matrix could not link it completely to its parent Space."
        };
    }

    try {
        const child = matrixClient.getRoom(roomId);
        if (child?.getMyMembership() === "join") {
            observeRoom(child);
            emitRoom(child);
        }
        emitRoom(parent);
        emit({ type: "snapshot", snapshot: snapshot() });
    } catch {
        // The homeserver already returned room_id. Projection failures must not
        // turn this non-idempotent mutation into a retryable creation error.
    }
    return result;
}

function spaceChildParentEvent(child: Room, parentSpaceId: string): MatrixEvent | undefined {
    const event = child.currentState.getStateEvents(EventType.SpaceParent, parentSpaceId);
    return event && validSpaceVia(event.getContent<Record<string, unknown>>()) ? event : undefined;
}

function requireSpaceChildLinkPermission(parentSpaceId: unknown, childRoomId: unknown): {
    parent: Room;
    child: Room;
} {
    if (!activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const parent = getRoom(validateRoomId(parentSpaceId));
    const child = getRoom(validateRoomId(childRoomId));
    if (!parent.isSpaceRoom()) fail("MATRIX_SPACE_REQUIRED", "The selected Matrix parent is not a Space.");
    if (parent.roomId === child.roomId || !spaceChildParentEvent(child, parent.roomId)) {
        fail("MATRIX_SPACE_CHILD_PARENT_MISMATCH", "The Matrix room does not have the selected parent Space.");
    }
    const childPermission = spaceChildPermission(parent);
    if (permissionIsUnverifiable(childPermission)) {
        fail(
            "MATRIX_SPACE_CHILD_PERMISSION_UNVERIFIABLE",
            "Matrix could not verify this Space's room-link power levels."
        );
    }
    if (!childPermission.allowed) {
        fail(
            "MATRIX_SPACE_CHILD_FORBIDDEN",
            "You do not have permission to link rooms in this Matrix Space."
        );
    }
    return { parent, child };
}

async function repairSpaceChildLinkInternal(
    parentSpaceId: unknown,
    childRoomId: unknown,
    creationMarker?: unknown
): Promise<MatrixRoomActionResult> {
    const { parent, child } = requireSpaceChildLinkPermission(parentSpaceId, childRoomId);
    if (creationMarker != null) {
        const marker = validateString(creationMarker, "Space child creation marker", 73);
        if (!SPACE_CHILD_CREATION_MARKER_PATTERN.test(marker) || roomSpaceChildCreationMarker(child) !== marker) {
            fail(
                "MATRIX_SPACE_CHILD_CREATION_MISMATCH",
                "The Matrix room did not match the pending creation operation."
            );
        }
    }
    const existing = parent.currentState.getStateEvents(EventType.SpaceChild, child.roomId);
    if (!existing || !validSpaceVia(existing.getContent<Record<string, unknown>>())) {
        try {
            await matrixClient!.sendStateEvent(parent.roomId, EventType.SpaceChild, {
                via: [activeServerName()],
                suggested: true
            }, child.roomId);
        } catch {
            fail(
                "MATRIX_SPACE_CHILD_LINK_REPAIR_FAILED",
                "Matrix could not repair the room's parent Space link."
            );
        }
    }
    try {
        emitRoom(parent);
        emitRoom(child);
        emit({ type: "snapshot", snapshot: snapshot() });
    } catch {
        // The idempotent state PUT already succeeded; sync will converge later.
    }
    return { roomId: child.roomId };
}

async function repairSpaceChildLink(
    command: Extract<MatrixWorkerCommand, { type: "repairSpaceChildLink"; }>
): Promise<MatrixRoomActionResult> {
    return await repairSpaceChildLinkInternal(
        command.parentSpaceId,
        command.childRoomId,
        command.creationMarker
    );
}

function roomSpaceChildCreationMarker(room: Room): string | undefined {
    const event = room.currentState.getStateEvents(SPACE_CHILD_CREATION_EVENT_TYPE, "");
    const content = event?.getContent<Record<string, unknown>>();
    return content && typeof content.marker === "string" && SPACE_CHILD_CREATION_MARKER_PATTERN.test(content.marker)
        ? content.marker
        : undefined;
}

async function reconcileSpaceChildCreate(
    command: Extract<MatrixWorkerCommand, { type: "reconcileSpaceChildCreate"; }>
): Promise<MatrixReconcileSpaceChildCreateResult> {
    const parentSpaceId = validateRoomId(command.parentSpaceId);
    const creationMarker = validateString(command.creationMarker, "Space child creation marker", 73);
    if (!SPACE_CHILD_CREATION_MARKER_PATTERN.test(creationMarker)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix Space child creation marker is invalid.");
    }
    const parent = getRoom(parentSpaceId);
    if (!parent.isSpaceRoom()) fail("MATRIX_SPACE_REQUIRED", "The selected Matrix parent is not a Space.");

    const rooms = matrixClient!.getRooms();
    if (rooms.length > 10_000) {
        fail("MATRIX_SPACE_CHILD_RECONCILE_INCOMPLETE", "There are too many joined rooms to reconcile safely.");
    }
    const matches = rooms.filter(room => room.getMyMembership() === "join"
        && room.roomId !== parent.roomId
        && roomSpaceChildCreationMarker(room) === creationMarker
        && Boolean(spaceChildParentEvent(room, parent.roomId)));
    if (matches.length > 1) {
        fail("MATRIX_SPACE_CHILD_RECONCILE_CONFLICT", "Multiple Matrix rooms used the same creation marker.");
    }
    if (!matches.length) return { resolved: false };

    const result = await repairSpaceChildLinkInternal(parent.roomId, matches[0].roomId, creationMarker);
    return { resolved: true, roomId: result.roomId };
}

async function openDirectMessage(
    command: Extract<MatrixWorkerCommand, { type: "openDirectMessage"; }>
): Promise<MatrixDirectMessageResult> {
    if (!activeCredentials) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const space = getRoom(command.spaceId);
    if (!space.isSpaceRoom()) fail("MATRIX_ROOM_NOT_SPACE", "Direct messages must be opened from a joined Matrix space.");
    const userId = validateUserId(command.userId);
    if (userId === activeCredentials.userId) fail("MATRIX_DM_SELF", "A direct message cannot target your own account.");
    let targetMembership: unknown;
    try {
        const memberState = await matrixClient!.getStateEvent(space.roomId, EventType.RoomMember, userId);
        targetMembership = memberState?.membership;
    } catch {
        // Do not turn a DM click into an unbounded full-member download. An
        // exact target-state read is the only bounded membership authority.
    }
    if (targetMembership !== "join") {
        fail("MATRIX_DM_USER_NOT_IN_SPACE", "This user is not a joined member of the selected Matrix space.");
    }

    const direct = directAccountData();
    const classifiedRoomIds = direct.content[userId] ?? [];
    const classified = new Set(classifiedRoomIds);
    const remainingRoomIds = matrixClient!.getRooms()
        .filter(room => !classified.has(room.roomId))
        .map(room => room.roomId);
    for (const roomId of [...classifiedRoomIds, ...remainingRoomIds].slice(0, MAX_SNAPSHOT_ROOMS)) {
        const room = matrixClient!.getRoom(roomId);
        if (!room || room.getMyMembership() !== "join" || room.isSpaceRoom()
            || groupChatRoomIdentity(room)) continue;
        // Classified DMs should be fully verified even when lazy member loading
        // is enabled. For unclassified rooms, current state is enough to recover
        // a just-created/joined two-person room after m.direct persistence failed,
        // without turning a DM click into hundreds of member-list requests.
        if (classified.has(roomId)) await room.loadMembersIfNeeded();
        const activeMembers = room.getMembers().filter(member => member.membership === "join" || member.membership === "invite");
        if (room.hasEncryptionStateEvent()
            && activeMembers.length === 2
            && activeMembers.every(member => member.userId === activeCredentials!.userId || member.userId === userId)
            && room.getMember(activeCredentials.userId)?.membership === "join"
            && (room.getMember(userId)?.membership === "join" || room.getMember(userId)?.membership === "invite")) {
            if (!classified.has(roomId)) {
                try {
                    await addDirectRoom(userId, roomId);
                } catch {
                    fail(
                        "MATRIX_DM_CLASSIFICATION_FAILED",
                        "The existing private room was found, but Matrix could not repair its direct-message classification."
                    );
                }
            }
            return { roomId, created: false };
        }
    }

    const created = await matrixClient!.createRoom({
        preset: Preset.TrustedPrivateChat,
        invite: [userId],
        is_direct: true,
        initial_state: [{
            type: EventType.RoomEncryption,
            state_key: "",
            content: { algorithm: "m.megolm.v1.aes-sha2" }
        }]
    });
    const roomId = validateRoomId(created.room_id);
    try {
        await addDirectRoom(userId, roomId);
    } catch {
        fail(
            "MATRIX_DM_CLASSIFICATION_FAILED",
            "A direct room was created, but Matrix could not save its direct-message classification."
        );
    }
    return { roomId, created: true };
}

async function logout(): Promise<void> {
    const client = matrixClient;
    if (!client) {
        await disposeClient(false);
        setStatus("logged_out");
        return;
    }

    // Do not publish SyncState.Stopped while /logout and local cleanup are in
    // flight: the renderer otherwise treats it as a reconnect request.
    client.removeAllListeners();
    try {
        await client.logout(true);
    } catch {
        // Remote revocation is best-effort. Local credentials and crypto stores
        // must still be discarded so a failed homeserver request cannot wedge
        // the bridge in an authenticated state.
    }

    try {
        await disposeClient(true);
    } catch (error) {
        const safeError = publicError(error);
        setStatus("error", safeError);
        throw new PublicWorkerError(safeError.code, safeError.message);
    }
    setStatus("logged_out");
}

async function sendText(command: Extract<MatrixWorkerCommand, { type: "sendText"; }>): Promise<MatrixActionResult> {
    const room = getRoom(command.roomId);
    const placeholderBody = validateString(command.body, "body", 65_536);
    const { body, userIds: mentionedUserIds } = validateOutgoingMentionContent(
        room,
        command.mentionedUserIds,
        placeholderBody
    );
    const content: Record<string, any> = { msgtype: MsgType.Text, body };
    if (mentionedUserIds.length) content["m.mentions"] = { user_ids: mentionedUserIds };
    if (command.replyEventId != null) {
        content["m.relates_to"] = { "m.in_reply_to": { event_id: validateEventId(command.replyEventId) } };
    }
    const response = await matrixClient!.sendMessage(room.roomId, content as any);
    return { eventId: response.event_id };
}

async function cancelPending(command: Extract<MatrixWorkerCommand, { type: "cancelPending"; }>): Promise<void> {
    const room = getRoom(command.roomId);
    const transactionId = validateString(command.transactionId, "transaction ID", 128);
    if (!/^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix transaction ID is invalid.");
    }
    const localEventId = `~${room.roomId}:${transactionId}`;
    const event = room.getLiveTimeline().getEvents().find(candidate =>
        candidate.getId() === localEventId
        && candidate.getTxnId() === transactionId
        && candidate.getSender() === activeCredentials?.userId);
    if (!event) fail("MATRIX_PENDING_EVENT_NOT_FOUND", "The failed Matrix message is no longer pending.");
    try {
        matrixClient!.cancelPendingEvent(event);
    } catch {
        fail("MATRIX_PENDING_EVENT_BUSY", "This Matrix message can no longer be cancelled safely.");
    }
}

async function sendSticker(command: Extract<MatrixWorkerCommand, { type: "sendSticker"; }>): Promise<MatrixStickerSendResult> {
    const room = getRoom(command.roomId);
    const sticker = validateStickerSendRequest(command.sticker);
    if (room.getMyMembership() !== "join") {
        fail("MATRIX_ROOM_NOT_JOINED", "Stickers can only be sent to a joined Matrix room.");
    }
    if (room.hasEncryptionStateEvent()) {
        fail(
            "MATRIX_STICKER_ENCRYPTED_ROOM_UNSUPPORTED",
            "Discord stickers cannot be sent to encrypted Matrix rooms without encrypted media upload support."
        );
    }

    const bytes = await downloadDiscordSticker(sticker);
    const media = sniffDiscordSticker(bytes, sticker.formatType);
    // Recheck mutable room state before the first homeserver write.
    if (room.getMyMembership() !== "join") fail("MATRIX_ROOM_NOT_JOINED", "This Matrix room is no longer joined.");
    if (room.hasEncryptionStateEvent()) {
        fail(
            "MATRIX_STICKER_ENCRYPTED_ROOM_UNSUPPORTED",
            "This Matrix room became encrypted before the sticker could be uploaded."
        );
    }

    const uploadController = new AbortController();
    const uploadTimer = setTimeout(() => uploadController.abort(), MATRIX_STICKER_UPLOAD_TIMEOUT_MS);
    let contentUri: string;
    try {
        const upload = await matrixClient!.uploadContent(new Blob([bytes], { type: media.mimeType }), {
            abortController: uploadController,
            includeFilename: false,
            type: media.mimeType
        });
        if (typeof upload.content_uri !== "string" || !authenticatedMediaUrl(upload.content_uri)) {
            fail("MATRIX_STICKER_UPLOAD_FAILED", "The Matrix homeserver returned an invalid sticker media URI.");
        }
        contentUri = upload.content_uri;
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        if (uploadController.signal.aborted) fail("MATRIX_STICKER_UPLOAD_TIMEOUT", "The Matrix sticker upload timed out.");
        fail("MATRIX_STICKER_UPLOAD_FAILED", "The Matrix homeserver could not upload this sticker.");
    } finally {
        clearTimeout(uploadTimer);
    }

    // Matrix media upload and event send are separate protocol operations. If the
    // room changed in between, never send a plaintext media reference into it.
    if (room.getMyMembership() !== "join") fail("MATRIX_ROOM_NOT_JOINED", "This Matrix room is no longer joined.");
    if (room.hasEncryptionStateEvent()) {
        fail(
            "MATRIX_STICKER_ENCRYPTED_ROOM_UNSUPPORTED",
            "This Matrix room became encrypted before the sticker event could be sent."
        );
    }

    let eventId: string | undefined;
    try {
        const content: Record<string, unknown> = {
            body: sticker.name,
            url: contentUri,
            info: {
                mimetype: media.mimeType,
                size: bytes.byteLength,
                w: media.width,
                h: media.height
            }
        };
        if (sticker.replyEventId) {
            content["m.relates_to"] = { "m.in_reply_to": { event_id: sticker.replyEventId } };
        }
        const response = await matrixClient!.sendEvent(room.roomId, EventType.Sticker, content as any);
        eventId = response.event_id;
    } catch {
        fail("MATRIX_STICKER_SEND_FAILED", "The Matrix homeserver could not send this sticker.");
    }
    if (typeof eventId !== "string" || !eventId.startsWith("$") || /\s/u.test(eventId) || eventId.length > 2_048) {
        fail("MATRIX_PROTOCOL_ERROR", "The Matrix homeserver returned an invalid sticker event ID.");
    }
    return { eventId };
}

async function sendAttachment(
    command: Extract<MatrixWorkerCommand, { type: "sendAttachment"; }>
): Promise<MatrixAttachmentSendResult> {
    const receivedBytes = command.attachment?.bytes instanceof Uint8Array
        && command.attachment.bytes.buffer instanceof ArrayBuffer
        ? command.attachment.bytes
        : undefined;
    try {
        return await sendAttachmentInternal(command);
    } finally {
        receivedBytes?.fill(0);
    }
}

function attachmentEventForTransaction(room: Room, transactionId: string): MatrixEvent | undefined {
    const candidates = new Set<MatrixEvent>();
    const tracked = room.getEventForTxnId(transactionId);
    if (tracked) candidates.add(tracked);
    for (const event of room.getLiveTimeline().getEvents()) {
        const unsignedTransactionId = event.getUnsigned().transaction_id;
        if (event.getTxnId() === transactionId || unsignedTransactionId === transactionId) candidates.add(event);
    }
    if (candidates.size > 1) {
        fail("MATRIX_ATTACHMENT_TXN_COLLISION", "The Matrix attachment transaction ID matched multiple events.");
    }
    return candidates.values().next().value;
}

function attachmentEventMatchesRequest(
    room: Room,
    event: MatrixEvent,
    attachment: MatrixAttachmentSendRequest,
    media: ReturnType<typeof sniffedMedia>,
    dimensions: { width: number; height: number; } | undefined
): boolean {
    if (event.getRoomId() !== room.roomId
        || event.getSender() !== activeCredentials?.userId
        || event.getType() !== EventType.RoomMessage
        || event.isRedacted()) return false;

    const content = event.getContent<Record<string, any>>();
    const image = media.mimeType.startsWith("image/");
    const video = media.mimeType.startsWith("video/");
    const audio = media.mimeType.startsWith("audio/");
    const expectedMessageType = image ? MsgType.Image : video ? MsgType.Video : audio ? MsgType.Audio : MsgType.File;
    if (content.msgtype !== expectedMessageType
        || content.body !== (attachment.caption ?? attachment.name)
        || content.filename !== attachment.name
        || content.url != null
        || !content.file || typeof content.file !== "object") return false;

    try {
        validateEncryptedMediaFile(content.file);
    } catch {
        return false;
    }

    const { info } = content;
    if (!info || typeof info !== "object"
        || info.mimetype !== media.mimeType
        || info.size !== attachment.bytes.byteLength) return false;
    if (dimensions) {
        if (info.w !== dimensions.width || info.h !== dimensions.height) return false;
    } else if (info.w != null || info.h != null) {
        return false;
    }
    const expectedDuration = video || audio ? attachment.durationMs : undefined;
    if (expectedDuration == null ? info.duration != null : info.duration !== expectedDuration) return false;

    const existingGroup = parsedAttachmentGroup(content[ATTACHMENT_GROUP_CONTENT_KEY]);
    if (attachment.attachmentGroup) {
        if (!existingGroup
            || existingGroup.id !== attachment.attachmentGroup.id
            || existingGroup.index !== attachment.attachmentGroup.index
            || existingGroup.total !== attachment.attachmentGroup.total) return false;
    } else if (content[ATTACHMENT_GROUP_CONTENT_KEY] != null) {
        return false;
    }

    const relation = content["m.relates_to"];
    if (attachment.replyEventId) {
        return relation != null
            && typeof relation === "object"
            && relation["m.in_reply_to"] != null
            && typeof relation["m.in_reply_to"] === "object"
            && relation["m.in_reply_to"].event_id === attachment.replyEventId;
    }
    return relation == null;
}

function attachmentEventId(value: unknown): string {
    const eventId = optionalEventId(value);
    if (!eventId) fail("MATRIX_PROTOCOL_ERROR", "The Matrix attachment event ID was invalid.");
    return eventId;
}

async function sendAttachmentInternal(
    command: Extract<MatrixWorkerCommand, { type: "sendAttachment"; }>
): Promise<MatrixAttachmentSendResult> {
    const room = getRoom(command.roomId);
    const attachment = validateAttachmentSendRequest(command.attachment);
    if (room.getMyMembership() !== "join") {
        fail("MATRIX_ROOM_NOT_JOINED", "Attachments can only be sent to a joined Matrix room.");
    }

    const media = sniffedMedia(attachment.bytes, attachment.declaredMimeType);
    const image = media.mimeType.startsWith("image/");
    const video = media.mimeType.startsWith("video/");
    const audio = media.mimeType.startsWith("audio/");
    const msgtype = image ? MsgType.Image : video ? MsgType.Video : audio ? MsgType.Audio : MsgType.File;
    const dimensions = image && media.width && media.height
        ? { width: media.width, height: media.height }
        : video && attachment.width && attachment.height
            ? { width: attachment.width, height: attachment.height }
            : undefined;

    const existingEvent = attachmentEventForTransaction(room, attachment.txnId);
    if (existingEvent) {
        try {
            await matrixClient!.decryptEventIfNeeded(existingEvent);
        } catch {
            fail("MATRIX_ATTACHMENT_TXN_COLLISION", "The existing Matrix attachment event could not be verified.");
        }
        if (!attachmentEventMatchesRequest(room, existingEvent, attachment, media, dimensions)) {
            fail("MATRIX_ATTACHMENT_TXN_COLLISION", "The Matrix attachment transaction ID belongs to different content.");
        }
        if (existingEvent.status == null || existingEvent.status === EventStatus.SENT) {
            return { eventId: attachmentEventId(existingEvent.getId()) };
        }
        if (existingEvent.status === EventStatus.NOT_SENT) {
            try {
                const response = await matrixClient!.resendEvent(existingEvent, room);
                return { eventId: attachmentEventId(response.event_id) };
            } catch (error) {
                if (error instanceof PublicWorkerError) throw error;
                fail("MATRIX_ATTACHMENT_SEND_FAILED", "The Matrix homeserver could not resend this attachment.");
            }
        }
        if (existingEvent.status === EventStatus.CANCELLED) {
            fail("MATRIX_ATTACHMENT_TXN_CANCELLED", "This Matrix attachment transaction was already cancelled.");
        }
        fail("MATRIX_ATTACHMENT_SEND_BUSY", "This Matrix attachment transaction is already in progress.");
    }

    // Encrypt every uploaded payload, including in currently-unencrypted rooms.
    // In an encrypted room the SDK also encrypts the event containing this key;
    // in a plaintext room this still keeps an orphaned/at-rest media object opaque.
    const plaintextSize = attachment.bytes.byteLength;
    let encrypted: Awaited<ReturnType<typeof encryptMedia>>;
    try {
        encrypted = await encryptMedia(attachment.bytes);
    } finally {
        attachment.bytes.fill(0);
    }
    if (room.getMyMembership() !== "join") {
        encrypted.ciphertext.fill(0);
        fail("MATRIX_ROOM_NOT_JOINED", "This Matrix room is no longer joined.");
    }

    const uploadController = new AbortController();
    const uploadTimer = setTimeout(() => uploadController.abort(), MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS);
    let contentUri: string;
    try {
        const upload = await matrixClient!.uploadContent(
            new Blob([encrypted.ciphertext], { type: "application/octet-stream" }),
            {
                abortController: uploadController,
                includeFilename: false,
                type: "application/octet-stream"
            }
        );
        if (typeof upload.content_uri !== "string" || !authenticatedMediaUrl(upload.content_uri)) {
            fail("MATRIX_ATTACHMENT_UPLOAD_FAILED", "The Matrix homeserver returned an invalid media URI.");
        }
        contentUri = upload.content_uri;
    } catch (error) {
        if (error instanceof PublicWorkerError) throw error;
        if (uploadController.signal.aborted) {
            fail("MATRIX_ATTACHMENT_UPLOAD_TIMEOUT", "The Matrix attachment upload timed out.");
        }
        fail("MATRIX_ATTACHMENT_UPLOAD_FAILED", "The Matrix homeserver could not upload this attachment.");
    } finally {
        clearTimeout(uploadTimer);
        encrypted.ciphertext.fill(0);
    }

    if (room.getMyMembership() !== "join") {
        fail("MATRIX_ROOM_NOT_JOINED", "This Matrix room is no longer joined.");
    }
    const info: Record<string, unknown> = {
        mimetype: media.mimeType,
        size: plaintextSize
    };
    if (dimensions) {
        info.w = dimensions.width;
        info.h = dimensions.height;
    }
    if ((video || audio) && attachment.durationMs != null) info.duration = attachment.durationMs;

    const content: Record<string, unknown> = {
        msgtype,
        body: attachment.caption ?? attachment.name,
        filename: attachment.name,
        info,
        file: { ...encrypted.file, url: contentUri }
    };
    if (attachment.attachmentGroup) {
        content[ATTACHMENT_GROUP_CONTENT_KEY] = { ...attachment.attachmentGroup };
    }
    if (attachment.replyEventId) {
        content["m.relates_to"] = { "m.in_reply_to": { event_id: attachment.replyEventId } };
    }

    let eventId: string | undefined;
    try {
        const response = await matrixClient!.sendMessage(room.roomId, content as any, attachment.txnId);
        eventId = response.event_id;
    } catch {
        fail("MATRIX_ATTACHMENT_SEND_FAILED", "The Matrix homeserver could not send this attachment.");
    }
    if (typeof eventId !== "string" || !eventId.startsWith("$") || /\s/u.test(eventId) || eventId.length > 2_048) {
        fail("MATRIX_PROTOCOL_ERROR", "The Matrix homeserver returned an invalid attachment event ID.");
    }
    return { eventId };
}

type FailedMutationMatcher = (event: MatrixEvent) => boolean;

function mutationTransactionId(): string {
    const transactionId = matrixClient!.makeTxnId();
    if (!transactionId || transactionId.length > 128 || !/^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
        fail("MATRIX_PROTOCOL_ERROR", "The Matrix SDK generated an invalid transaction ID.");
    }
    return transactionId;
}

/**
 * Locate and cancel only the local echo created by the mutation that just
 * failed. Transaction IDs are unique per client, but the room/sender/local-ID
 * checks keep a corrupted SDK index from cancelling an unrelated event.
 */
function cancelFailedMutation(
    room: Room,
    transactionId: string,
    matches: FailedMutationMatcher
): MatrixEvent | undefined {
    const localEventId = `~${room.roomId}:${transactionId}`;
    const candidates = new Set<MatrixEvent>();
    const tracked = room.getEventForTxnId(transactionId);
    if (tracked) candidates.add(tracked);
    for (const event of room.getLiveTimeline().getEvents()) {
        if (event.getTxnId() === transactionId) candidates.add(event);
    }
    const matching = [...candidates].filter(event =>
        event.getId() === localEventId
        && event.getRoomId() === room.roomId
        && event.getSender() === activeCredentials?.userId
        && event.getTxnId() === transactionId
        && matches(event));
    if (matching.length !== 1) return undefined;

    const [event] = matching;
    try {
        // encryptAndSendEvent normally performs this transition in its catch
        // handler. Complete it here if that handler itself failed so the SDK's
        // public cancellation API can still remove the exact local echo.
        if (event.status === EventStatus.SENDING) {
            room.updatePendingEvent(event, EventStatus.NOT_SENT);
        }
        if (event.status === EventStatus.CANCELLED) return event;
        if (event.status !== EventStatus.QUEUED
            && event.status !== EventStatus.NOT_SENT
            && event.status !== EventStatus.ENCRYPTING) return undefined;
        matrixClient!.cancelPendingEvent(event);
        return event;
    } catch {
        return undefined;
    }
}

function emitRestoredTimelineContext(room: Room, target: MatrixEvent): void {
    if (target.isRedacted()) return;
    const eventId = optionalEventId(target.getId());
    const events = eventId
        ? room.getTimelineForEvent(eventId)?.getEvents() ?? room.getLiveTimeline().getEvents()
        : room.getLiveTimeline().getEvents();
    const targetIndex = events.findIndex(event => event === target || Boolean(eventId && event.getId() === eventId));
    if (targetIndex === -1) return;

    const reactionMap = buildReactionMap(room);
    const before: MatrixMessageDTO[] = [];
    const after: MatrixMessageDTO[] = [];
    const scanStart = Math.max(0, targetIndex - 1_000);
    const scanEnd = Math.min(events.length, targetIndex + 1_001);
    for (let index = targetIndex - 1; index >= scanStart && before.length < 2; index--) {
        const candidateId = optionalTimelineEventId(room, events[index]);
        const message = normalizeMessage(room, events[index], candidateId ? reactionMap.get(candidateId) : undefined);
        if (message) before.unshift(message);
    }
    const targetMessage = normalizeMessage(room, target, eventId ? reactionMap.get(eventId) : undefined);
    if (!targetMessage) return;
    for (let index = targetIndex + 1; index < scanEnd && after.length < 2; index++) {
        const candidateId = optionalTimelineEventId(room, events[index]);
        const message = normalizeMessage(room, events[index], candidateId ? reactionMap.get(candidateId) : undefined);
        if (message) after.push(message);
    }

    // A snapshot lets the renderer merge the restored event between its
    // canonical neighbours and reinject the corrected timeline. Ordinary room
    // deltas are metadata-only, while emitting this as a live message would
    // incorrectly append an older deletion target to the bottom of the chat.
    const restoredSnapshot = snapshot();
    const restoredRoomIndex = restoredSnapshot.rooms.findIndex(candidate => candidate.roomId === room.roomId);
    if (restoredRoomIndex === -1) return;
    restoredSnapshot.rooms = restoredSnapshot.rooms.map((candidate, index) => ({
        ...candidate,
        // Existing renderer histories survive empty snapshot windows. Keeping
        // only the rollback context also preserves the snapshot's aggregate
        // message/JSON bounds when the ordinary global budget was already full.
        messages: index === restoredRoomIndex ? [...before, targetMessage, ...after] : []
    }));
    emit({ type: "snapshot", snapshot: restoredSnapshot });
}

function restoreFailedRedaction(room: Room, redaction: MatrixEvent, target: MatrixEvent | undefined): void {
    if (!target) return;
    if (target.localRedactionEvent() === redaction) target.unmarkLocallyRedacted();
    invalidateReactionMap(room);
    const relation = relationContent(target);
    const reactionTargetId = target.getType() === EventType.Reaction
        && relation?.rel_type === RelationType.Annotation
        ? optionalEventId(relation.event_id)
        : undefined;
    if (reactionTargetId) {
        emitReactions(room, reactionTargetId);
    } else {
        emitRestoredTimelineContext(room, target);
    }
}

async function edit(command: Extract<MatrixWorkerCommand, { type: "edit"; }>): Promise<MatrixActionResult> {
    const room = getRoom(command.roomId);
    const eventId = validateEventId(command.eventId);
    const placeholderBody = validateString(command.body, "body", 65_536);
    const { body, userIds: mentionedUserIds } = validateOutgoingMentionContent(
        room,
        command.mentionedUserIds,
        placeholderBody
    );
    const target = findRoomEvent(room, eventId);
    if (!target) fail("MATRIX_EVENT_NOT_LOADED", "Load this Matrix message before editing it.");
    try {
        await matrixClient!.decryptEventIfNeeded(target);
    } catch {
        fail("MATRIX_DECRYPTION_FAILED", "This Matrix message could not be decrypted for editing.");
    }
    if (target.isDecryptionFailure() || target.getType() !== EventType.RoomMessage) {
        fail("MATRIX_EDIT_UNSUPPORTED", "Only loaded Matrix text messages can be edited.");
    }
    const targetContent = target.getContent<Record<string, any>>();
    if (attachmentFromContent(targetContent, target.getType())) {
        fail("MATRIX_EDIT_ATTACHMENT_UNSUPPORTED", "Editing Matrix attachment captions is not supported yet.");
    }
    const { msgtype } = targetContent;
    if (msgtype !== MsgType.Text && msgtype !== MsgType.Notice && msgtype !== MsgType.Emote) {
        fail("MATRIX_EDIT_UNSUPPORTED", "This Matrix message type cannot be edited safely.");
    }
    const newContent: Record<string, unknown> = { msgtype, body };
    newContent["m.mentions"] = mentionedUserIds.length ? { user_ids: mentionedUserIds } : {};
    const previousMentionUserIds = normalizedMessageMentionUserIds(room, targetContent) ?? [];
    const introducedMentionUserIds = introducedMatrixMentionUserIds(previousMentionUserIds, mentionedUserIds);
    const targetRelation = relationContent(target);
    const replyEventId = optionalEventId(targetRelation?.["m.in_reply_to"]?.event_id);
    if (replyEventId) newContent["m.relates_to"] = { "m.in_reply_to": { event_id: replyEventId } };
    const transactionId = mutationTransactionId();
    const previousReplacement = target.replacingEvent();
    try {
        const response = await matrixClient!.sendMessage(room.roomId, {
            msgtype,
            body: `* ${body}`,
            "m.mentions": introducedMentionUserIds.length ? { user_ids: introducedMentionUserIds } : {},
            "m.new_content": newContent,
            "m.relates_to": { rel_type: RelationType.Replace, event_id: eventId }
        } as any, transactionId);
        return { eventId: response.event_id };
    } catch (error) {
        const failedEdit = cancelFailedMutation(room, transactionId, event => {
            const relation = relationContent(event);
            return event.getType() === EventType.RoomMessage
                && relation?.rel_type === RelationType.Replace
                && optionalEventId(relation.event_id) === eventId;
        });
        if (failedEdit) {
            // Relation aggregation is asynchronous. Restore immediately when
            // the failed local edit is still selected; its cancellation will
            // subsequently recompute the authoritative latest replacement.
            if (target.replacingEvent() === failedEdit) {
                target.makeReplaced(previousReplacement ?? undefined);
            }
            const message = normalizeMessage(room, target, buildReactionMap(room).get(eventId));
            if (message) emit({ type: "edit", roomId: room.roomId, eventId, message });
        }
        throw error;
    }
}

async function redact(command: Extract<MatrixWorkerCommand, { type: "redact"; }>): Promise<MatrixActionResult> {
    const room = getRoom(command.roomId);
    const eventId = validateEventId(command.eventId);
    const reason = command.reason == null ? undefined : validateString(command.reason, "reason", 1_024, true);
    const target = room.findEventById(eventId);
    const transactionId = mutationTransactionId();
    try {
        const response = await matrixClient!.redactEvent(
            room.roomId,
            eventId,
            transactionId,
            reason == null ? undefined : { reason }
        );
        return { eventId: response.event_id };
    } catch (error) {
        const failedRedaction = cancelFailedMutation(room, transactionId, event =>
            event.isRedaction() && optionalEventId(event.getAssociatedId()) === eventId);
        if (failedRedaction) restoreFailedRedaction(room, failedRedaction, target);
        throw error;
    }
}

async function react(command: Extract<MatrixWorkerCommand, { type: "react"; }>): Promise<MatrixActionResult> {
    const room = getRoom(command.roomId);
    const eventId = validateEventId(command.eventId);
    const key = validateString(command.key, "key", 128);
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix reaction key is invalid.");
    }
    if (command.remove) {
        const ownUserId = activeCredentials!.userId;
        const reactionIds = room.getLiveTimeline().getEvents().flatMap(event => {
            const relation = relationContent(event);
            const matches = event.getType() === EventType.Reaction
                && !event.isRedacted()
                && event.getSender() === ownUserId
                && relation?.rel_type === RelationType.Annotation
                && relation.event_id === eventId
                && relation.key === key;
            const reactionId = matches ? optionalEventId(event.getId()) : undefined;
            return reactionId ? [reactionId] : [];
        }).sort();
        let redactionId: string | undefined;
        for (const reactionId of reactionIds) {
            const target = room.findEventById(reactionId);
            const transactionId = mutationTransactionId();
            try {
                const response = await matrixClient!.redactEvent(room.roomId, reactionId, transactionId);
                redactionId = response.event_id;
            } catch (error) {
                const failedRedaction = cancelFailedMutation(room, transactionId, event =>
                    event.isRedaction() && optionalEventId(event.getAssociatedId()) === reactionId);
                if (failedRedaction) restoreFailedRedaction(room, failedRedaction, target);
                // Any earlier duplicate reactions were already confirmed by
                // the homeserver and remain locally redacted. Only the failed
                // redaction above is rolled back.
                throw error;
            }
        }
        convergeReactions(room, eventId);
        return redactionId ? { eventId: redactionId } : {};
    }

    const existingOwnReaction = room.getLiveTimeline().getEvents().find(event => {
        const relation = relationContent(event);
        return event.getType() === EventType.Reaction
            && !event.isRedacted()
            && event.getSender() === activeCredentials!.userId
            && relation?.rel_type === RelationType.Annotation
            && relation.event_id === eventId
            && relation.key === key;
    });
    const existingEventId = optionalEventId(existingOwnReaction?.getId());
    if (existingEventId) {
        convergeReactions(room, eventId);
        return { eventId: existingEventId };
    }

    const transactionId = mutationTransactionId();
    try {
        const response = await matrixClient!.sendEvent(room.roomId, EventType.Reaction, {
            "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key }
        }, transactionId);
        convergeReactions(room, eventId);
        return { eventId: response.event_id };
    } catch (error) {
        const failedReaction = cancelFailedMutation(room, transactionId, event => {
            const relation = relationContent(event);
            return event.getType() === EventType.Reaction
                && relation?.rel_type === RelationType.Annotation
                && optionalEventId(relation.event_id) === eventId
                && relation.key === key;
        });
        if (failedReaction) {
            convergeReactions(room, eventId);
        }
        throw error;
    }
}

async function typing(command: Extract<MatrixWorkerCommand, { type: "typing"; }>): Promise<void> {
    const room = getRoom(command.roomId);
    if (typeof command.isTyping !== "boolean") fail("MATRIX_INVALID_ARGUMENT", "Typing state is invalid.");
    const timeout = command.timeoutMs ?? DEFAULT_TYPING_TIMEOUT;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
        fail("MATRIX_INVALID_ARGUMENT", "Typing timeout is invalid.");
    }
    await matrixClient!.sendTyping(room.roomId, command.isTyping, timeout);
}

async function read(command: Extract<MatrixWorkerCommand, { type: "read"; }>): Promise<void> {
    const room = getRoom(command.roomId);
    const eventId = validateEventId(command.eventId);
    // Receipts are monotonic timeline state, not arbitrary event actions. Only
    // acknowledge events in the canonical live timeline; isolated search/jump
    // cache entries must never move a server receipt backwards.
    const event = room.getLiveTimeline().getEvents().find(candidate => candidate.getId() === eventId);
    if (!event) fail("MATRIX_EVENT_NOT_LOADED", "The Matrix event is not loaded.");
    if (activeCredentials) {
        // Ignore the SDK's synthetic receipt here: sendReadReceipt creates it
        // before the HTTP request settles and does not roll it back on failure.
        // Only a server-confirmed receipt may make a retry a no-op.
        const confirmed = room.getReadReceiptForUserId(activeCredentials.userId, true);
        const ordering = confirmed
            ? room.getUnfilteredTimelineSet().compareEventOrdering(confirmed.eventId, eventId)
            : null;
        if (confirmed?.eventId === eventId || (ordering != null && ordering >= 0)) return;
    }
    await matrixClient!.sendReadReceipt(event);
}

function boundedJsonRecord(value: unknown, maximum: number): Record<string, any> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
        const json = JSON.stringify(value);
        if (json.length > maximum) return undefined;
        const cloned = JSON.parse(json);
        return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : undefined;
    } catch {
        return undefined;
    }
}

function searchEventKey(roomId: string, eventId: string): string {
    return `${roomId}\0${eventId}`;
}

function cacheSearchEvent(roomId: string, event: MatrixEvent): void {
    const eventId = optionalEventId(event.getId());
    if (!eventId) return;
    const now = Date.now();
    for (const [key, cached] of searchEventCache) {
        if (cached.generation !== clientGeneration || cached.expiresAt <= now) searchEventCache.delete(key);
    }
    const key = searchEventKey(roomId, eventId);
    searchEventCache.delete(key);
    while (searchEventCache.size >= MAX_SEARCH_EVENT_CACHE) {
        searchEventCache.delete(searchEventCache.keys().next().value!);
    }
    searchEventCache.set(key, {
        generation: clientGeneration,
        expiresAt: now + CURSOR_TTL_MS,
        roomId,
        event
    });
}

function findRoomEvent(room: Room, eventId: string): MatrixEvent | undefined {
    const timelineEvent = room.findEventById(eventId);
    if (timelineEvent) return timelineEvent;
    const key = searchEventKey(room.roomId, eventId);
    const cached = searchEventCache.get(key);
    if (!cached || cached.generation !== clientGeneration || cached.expiresAt <= Date.now()
        || cached.roomId !== room.roomId) {
        searchEventCache.delete(key);
        return undefined;
    }
    // Refresh insertion order and lifetime on legitimate use.
    searchEventCache.delete(key);
    cached.expiresAt = Date.now() + CURSOR_TTL_MS;
    searchEventCache.set(key, cached);
    return cached.event;
}

function safeMappedEvent(roomId: string, value: unknown): MatrixEvent | undefined {
    if (!matrixClient || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, any>;
    const eventId = optionalEventId(raw.event_id);
    const sender = optionalUserId(raw.sender);
    const content = boundedJsonRecord(raw.content, MAX_RAW_EVENT_JSON_CHARS);
    const unsigned = raw.unsigned == null
        ? undefined
        : boundedJsonRecord(raw.unsigned, MAX_RAW_EVENT_JSON_CHARS);
    if (!eventId || !sender || typeof raw.type !== "string" || raw.type.length < 1 || raw.type.length > 256
        || /[\u0000-\u001f\u007f]/u.test(raw.type)
        || !content || (raw.unsigned != null && !unsigned)) return undefined;
    const event = matrixClient.getEventMapper({ decrypt: false, preventReEmit: true })({
        event_id: eventId,
        room_id: roomId,
        sender,
        type: raw.type,
        origin_server_ts: Number.isSafeInteger(raw.origin_server_ts)
            && raw.origin_server_ts >= 0 && raw.origin_server_ts <= MAX_EVENT_TIMESTAMP
            ? raw.origin_server_ts
            : 0,
        content,
        ...(unsigned ? { unsigned } : {}),
        ...(typeof raw.state_key === "string" && raw.state_key.length <= 1_024
            ? { state_key: raw.state_key }
            : {}),
        ...(typeof raw.redacts === "string" && optionalEventId(raw.redacts)
            ? { redacts: raw.redacts }
            : {})
    });
    return event;
}

async function decryptMappedEvents(events: MatrixEvent[], suppressLiveDelta = true): Promise<void> {
    for (const event of events) {
        // Detached history/search/context events are returned explicitly, so a
        // Decrypted callback must not also mis-emit them as new live messages.
        // Local search scans the actual live timeline, however: allow that
        // callback so a newly decrypted placeholder updates an open room.
        if (suppressLiveDelta) isolatedDecryptionEvents.add(event);
        try {
            await matrixClient!.decryptEventIfNeeded(event);
        } catch {
            // A single undecryptable historical event must not hide the rest of
            // the page. normalizeMessage will expose SDK decryption failures.
        } finally {
            // Suppress only the synchronous/awaited explicit fetch. If room keys
            // arrive later, the normal Decrypted listener must update the visible
            // placeholder instead of remaining muted forever.
            if (suppressLiveDelta) isolatedDecryptionEvents.delete(event);
        }
    }
}

function historyCursorState(cursorValue: unknown, roomId: string): { cursor: string; state: HistoryCursorState; } {
    const cursor = validateOpaqueCursor(cursorValue, "h");
    const state = historyCursors.get(cursor);
    if (!state || state.generation !== clientGeneration || state.expiresAt <= Date.now() || state.roomId !== roomId) {
        historyCursors.delete(cursor);
        fail("MATRIX_STALE_CURSOR", "The Matrix history cursor is invalid or has expired.");
    }
    return { cursor, state };
}

interface LoadedHistoryPage {
    messages: MatrixMessageDTO[];
    /** True after every event before the anchor has been inspected. */
    exhausted: boolean;
}

function loadedHistoryBefore(room: Room, anchorEventId: string | undefined, limit: number): LoadedHistoryPage {
    const events = room.getLiveTimeline().getEvents();
    let index = events.length - 1;
    if (anchorEventId) {
        const anchorIndex = events.findIndex(event => event.getId() === anchorEventId);
        if (anchorIndex === -1) {
            fail("MATRIX_STALE_CURSOR", "The Matrix history anchor is no longer in the loaded timeline.");
        }
        index = anchorIndex - 1;
    }

    const reactionMap = buildReactionMap(room);
    const seen = new Set<string>();
    const newestFirst: MatrixMessageDTO[] = [];
    for (; index >= 0 && newestFirst.length < limit; index--) {
        const event = events[index];
        const eventId = optionalTimelineEventId(room, event);
        if (!eventId || seen.has(eventId)) continue;
        const message = normalizeMessage(room, event, reactionMap.get(eventId));
        if (!message) continue;
        seen.add(eventId);
        newestFirst.push(message);
    }
    return { messages: newestFirst.reverse(), exhausted: index < 0 };
}

function storeHistoryCursor(
    existingCursor: string | undefined,
    roomId: string,
    token: string | null,
    anchorEventId?: string
): string {
    let cursor = existingCursor;
    if (!cursor) {
        pruneCursorMap(historyCursors, MAX_HISTORY_CURSORS);
        cursor = opaqueCursor("h");
    }
    historyCursors.set(cursor, {
        generation: clientGeneration,
        expiresAt: Date.now() + CURSOR_TTL_MS,
        roomId,
        token,
        ...(anchorEventId ? { anchorEventId } : {})
    });
    return cursor;
}

async function paginate(
    command: Extract<MatrixWorkerCommand, { type: "paginate"; }>
): Promise<MatrixHistoryPageDTO> {
    const room = getRoom(command.roomId);
    const paginationClient = matrixClient!;
    const paginationClientGeneration = clientGeneration;
    const paginationTimelineGeneration = timelineGenerations.get(room) ?? 0;
    const assertPaginationCut = () => {
        if (matrixClient !== paginationClient
            || clientGeneration !== paginationClientGeneration
            || paginationClient.getRoom(room.roomId) !== room
            || !isCurrentMatrixTimelineGeneration(
                paginationTimelineGeneration,
                timelineGenerations.get(room) ?? 0
            )) {
            fail("MATRIX_STALE_CURSOR", "The Matrix timeline changed while history was loading.");
        }
    };
    const finishPage = (
        page: Omit<MatrixHistoryPageDTO, "roomId" | "timelineGeneration">
    ): MatrixHistoryPageDTO => {
        // This is the final synchronous cut before returning the page. A reset
        // which happened during any awaited work must fail closed, and no page
        // may claim a generation other than the one whose events it contains.
        assertPaginationCut();
        return { roomId: room.roomId, timelineGeneration: paginationTimelineGeneration, ...page };
    };
    const limit = command.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("MATRIX_INVALID_ARGUMENT", "Pagination limit is invalid.");
    const fromEventId = command.fromEventId == null
        ? undefined
        : validateTimelineEventId(command.fromEventId, room.roomId);

    let cursor: string | undefined;
    let token: string | null;
    let loadedAnchor: string | undefined;
    let inspectLoadedTimeline = false;
    if (command.cursor != null) {
        const stored = historyCursorState(command.cursor, room.roomId);
        cursor = stored.cursor;
        token = stored.state.token;
        loadedAnchor = stored.state.anchorEventId;
        inspectLoadedTimeline = loadedAnchor != null;
    } else {
        loadedAnchor = fromEventId;
        inspectLoadedTimeline = true;
        token = room.getLiveTimeline().getPaginationToken(Direction.Backward);
    }

    const loadedMessages: MatrixMessageDTO[] = [];
    if (inspectLoadedTimeline) {
        const loaded = loadedHistoryBefore(room, loadedAnchor, limit);
        loadedMessages.push(...loaded.messages);
        if (loadedMessages.length >= limit) {
            const end = loaded.exhausted && token == null;
            assertPaginationCut();
            if (end) {
                if (cursor) historyCursors.delete(cursor);
                return finishPage({ messages: loadedMessages, end: true, progressed: true });
            }
            const beforeCursor = storeHistoryCursor(
                cursor,
                room.roomId,
                token,
                loaded.exhausted ? undefined : loadedMessages[0].eventId
            );
            return finishPage({
                messages: loadedMessages,
                beforeCursor,
                end: false,
                progressed: true
            });
        }
    }
    if (token == null) {
        assertPaginationCut();
        if (cursor) historyCursors.delete(cursor);
        return finishPage({
            messages: loadedMessages,
            end: true,
            progressed: loadedMessages.length > 0
        });
    }

    const initialToken = token;
    const previouslyLoadedEventIds = new Set(
        room.getLiveTimeline().getEvents()
            .map(event => optionalTimelineEventId(room, event))
            .filter((eventId): eventId is string => eventId != null)
    );
    const mappedEvents: MatrixEvent[] = [];
    let renderableMessageCount = 0;
    let requests = 0;
    let end = false;
    const networkLimit = limit - loadedMessages.length;
    while (renderableMessageCount < networkLimit && !end && requests++ < MAX_HISTORY_REQUESTS_PER_PAGE) {
        const requestLimit = Math.max(
            1,
            Math.min(100, Math.max(MIN_HISTORY_EVENTS_PER_REQUEST, networkLimit - renderableMessageCount))
        );
        const response = await matrixClient!.createMessagesRequest(
            room.roomId,
            token,
            requestLimit,
            Direction.Backward
        );
        assertPaginationCut();
        if (!response || !Array.isArray(response.chunk) || response.chunk.length > requestLimit) {
            fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned an invalid Matrix history page.");
        }
        if (response.state != null && (!Array.isArray(response.state) || response.state.length > 100)) {
            fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned invalid Matrix history state.");
        }
        const nextToken = response.end == null
            ? null
            : validateString(response.end, "history token", 4_096);
        const pageEvents: MatrixEvent[] = [];
        for (const rawEvent of response.chunk) {
            const event = safeMappedEvent(room.roomId, rawEvent);
            if (event) pageEvents.push(event);
        }
        await decryptMappedEvents(pageEvents);
        assertPaginationCut();
        mappedEvents.push(...pageEvents);

        // A /messages page can consist entirely of state, relations, thread
        // replies, or malformed events. Counting those raw events as visible
        // progress returns an empty page even when older room messages remain;
        // with no new scroll extent the renderer then has no way to ask again.
        // Repartition the bounded aggregate so roots and replies split across
        // adjacent homeserver pages are classified together, and stop only
        // after this call has found the requested number of actual messages.
        const [candidateTimelineEvents] = room.partitionThreadedEvents(mappedEvents);
        const renderableEventIds = new Set<string>();
        for (const event of candidateTimelineEvents) {
            const message = normalizeMessage(room, event);
            if (message && !previouslyLoadedEventIds.has(message.eventId)) {
                renderableEventIds.add(message.eventId);
            }
        }
        renderableMessageCount = renderableEventIds.size;
        if (!nextToken || nextToken === token) {
            token = null;
            end = true;
        } else {
            token = nextToken;
        }
        // Empty-but-advancing chunks are legal with filtering/gaps. Continue
        // within this bounded call instead of treating them as end-of-history.
    }

    // TimelineReset invalidates both the loaded anchor and every event fetched
    // against it. Check before mutating Matrix SDK timeline/relation caches.
    assertPaginationCut();
    const [timelineEvents, threadedEvents, unknownRelations] = room.partitionThreadedEvents(mappedEvents);
    if (timelineEvents.some(event => event.getType() === EventType.Reaction)) invalidateReactionMap(room);
    matrixClient!.processAggregatedTimelineEvents(room, timelineEvents);
    room.addEventsToTimeline(timelineEvents, true, true, room.getLiveTimeline(), token ?? undefined);
    matrixClient!.processThreadEvents(room, threadedEvents, true);
    unknownRelations.forEach(event => room.relations.aggregateChildEvent(event));
    room.getLiveTimeline().setPaginationToken(token, Direction.Backward);
    room.oldState.paginationToken = token;

    const reactionMap = buildReactionMap(room);
    const seen = new Set<string>();
    // /messages with dir=b returns newest-first, while consumers use the
    // authoritative oldest-first Matrix timeline sequence. Do not sort by
    // origin_server_ts: clocks may be skewed and equal timestamps are legal.
    const networkMessages = timelineEvents
        .map(event => normalizeMessage(room, event, event.getId() ? reactionMap.get(event.getId()!) : undefined))
        .filter((message): message is MatrixMessageDTO => message != null
            && !previouslyLoadedEventIds.has(message.eventId)
            && !seen.has(message.eventId) && Boolean(seen.add(message.eventId)))
        .reverse();
    const availableMessages = [...networkMessages, ...loadedMessages]
        .filter((message, index, all) => all.findIndex(candidate => candidate.eventId === message.eventId) === index);
    const messages = availableMessages.slice(-limit);
    // A larger raw request avoids one-event-at-a-time stalls when the visible
    // window is almost full but the homeserver page begins with relations. If
    // it also yielded extra messages, retain an anchor into the now-loaded SDK
    // timeline so the next opaque cursor returns them before advancing the
    // already-consumed homeserver token.
    const bufferedAnchorEventId = availableMessages.length > messages.length
        ? messages[0]?.eventId
        : undefined;
    const progressed = token !== initialToken || messages.length > 0;
    end = end || token == null;

    assertPaginationCut();
    if (end && !bufferedAnchorEventId) {
        if (cursor) historyCursors.delete(cursor);
        return finishPage({ messages, end: true, progressed });
    }
    cursor = storeHistoryCursor(cursor, room.roomId, token, bufferedAnchorEventId);
    return finishPage({ messages, beforeCursor: cursor, end: false, progressed });
}

interface ValidatedSearchRequest {
    query: string;
    scope: MatrixMessageSearchRequest["scope"];
    limit: number;
    cursor?: string;
    fingerprint: string;
}

interface SearchScopeRooms {
    roomIds: string[];
    limited: boolean;
}

function validateSearchRequest(value: unknown): ValidatedSearchRequest {
    if (!value || typeof value !== "object") fail("MATRIX_INVALID_ARGUMENT", "The Matrix search request is invalid.");
    const input = value as Partial<MatrixMessageSearchRequest>;
    const query = validateString(input.query, "search query", 256).trim();
    if (!query || /[\u0000-\u001f\u007f]/u.test(query)) fail("MATRIX_INVALID_ARGUMENT", "The Matrix search query is invalid.");
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix search limit must be between 1 and 25.");
    }
    if (!input.scope || typeof input.scope !== "object") fail("MATRIX_INVALID_ARGUMENT", "The Matrix search scope is invalid.");
    let scope: MatrixMessageSearchRequest["scope"];
    if (input.scope.kind === "all") {
        scope = { kind: "all" };
    } else if (input.scope.kind === "room") {
        scope = { kind: "room", roomId: validateRoomId(input.scope.roomId) };
    } else if (input.scope.kind === "space") {
        scope = { kind: "space", spaceId: validateRoomId(input.scope.spaceId) };
    } else {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix search scope is invalid.");
    }
    const cursor = input.cursor == null ? undefined : validateOpaqueCursor(input.cursor, "s");
    return { query, scope, limit, cursor, fingerprint: JSON.stringify([query, scope]) };
}

function searchScopeRooms(scope: MatrixMessageSearchRequest["scope"]): SearchScopeRooms {
    if (scope.kind === "room") {
        const room = getRoom(scope.roomId);
        if (room.isSpaceRoom()) fail("MATRIX_ROOM_IS_SPACE", "Choose a Matrix room or a space search scope.");
        return { roomIds: [room.roomId], limited: false };
    }
    if (scope.kind === "all") {
        const rooms = visibleRooms()
            .filter(room => room.getMyMembership() === "join" && !room.isSpaceRoom())
            .sort((left, right) => left.roomId.localeCompare(right.roomId));
        return { roomIds: rooms.slice(0, MAX_SEARCH_ROOMS).map(room => room.roomId), limited: rooms.length > MAX_SEARCH_ROOMS };
    }

    const root = getRoom(scope.spaceId);
    if (!root.isSpaceRoom()) fail("MATRIX_ROOM_NOT_SPACE", "The Matrix search scope is not a space.");
    const joinedRooms = visibleRooms()
        .filter(room => room.getMyMembership() === "join")
        .sort((left, right) => left.roomId < right.roomId ? -1 : left.roomId > right.roomId ? 1 : 0);
    return searchMatrixSpaceGraph(
        root.roomId,
        joinedRooms.map(room => ({
            roomId: room.roomId,
            space: room.isSpaceRoom(),
            declaredChildIds: room.isSpaceRoom()
                ? projectableSpaceChildren(room).map(child => child.roomId)
                : [],
            parentIds: localSpaceParents(room)
        })),
        MAX_SEARCH_ROOMS,
        MAX_SEARCH_ROOMS,
        16
    );
}

async function searchContextMessages(
    room: Room,
    events: MatrixEvent[],
    targetIndex: number
): Promise<{ before: MatrixMessageDTO[]; after: MatrixMessageDTO[]; }> {
    const before: MatrixMessageDTO[] = [];
    const after: MatrixMessageDTO[] = [];
    const reactionMap = buildReactionMap(room);
    for (let index = targetIndex - 1, scanned = 0;
        index >= 0 && before.length < 2 && scanned++ < 10;
        index--) {
        await decryptMappedEvents([events[index]], false);
        const eventId = events[index].getId();
        const message = normalizeMessage(room, events[index], eventId ? reactionMap.get(eventId) : undefined);
        if (message) before.unshift(message);
    }
    for (let index = targetIndex + 1, scanned = 0;
        index < events.length && after.length < 2 && scanned++ < 10;
        index++) {
        await decryptMappedEvents([events[index]], false);
        const eventId = events[index].getId();
        const message = normalizeMessage(room, events[index], eventId ? reactionMap.get(eventId) : undefined);
        if (message) after.push(message);
    }
    return { before, after };
}

async function messageContext(
    command: Extract<MatrixWorkerCommand, { type: "messageContext"; }>
): Promise<MatrixMessageContextDTO> {
    const room = getRoom(command.roomId);
    if (room.isSpaceRoom()) fail("MATRIX_ROOM_IS_SPACE", "A Matrix space does not have a message timeline.");
    const eventId = validateEventId(command.eventId);
    let timeline: Awaited<ReturnType<MatrixClient["getEventTimeline"]>>;
    try {
        timeline = await matrixClient!.getEventTimeline(room.getUnfilteredTimelineSet(), eventId);
    } catch {
        fail("MATRIX_EVENT_NOT_FOUND", "The replied-to Matrix message is no longer available.");
    }
    if (!timeline) fail("MATRIX_EVENT_NOT_FOUND", "The replied-to Matrix message is no longer available.");

    const events = timeline.getEvents();
    const targetIndex = events.findIndex(event => event.getId() === eventId);
    if (targetIndex < 0) fail("MATRIX_EVENT_NOT_FOUND", "The replied-to Matrix message is no longer available.");
    const target = events[targetIndex];
    isolatedDecryptionEvents.add(target);
    await decryptMappedEvents([target]);
    const reactionMap = buildReactionMap(room);
    const message = normalizeMessage(room, target, reactionMap.get(eventId));
    if (!message) fail("MATRIX_EVENT_NOT_FOUND", "The replied-to Matrix event is not a visible message.");
    cacheSearchEvent(room.roomId, target);

    const before: MatrixMessageDTO[] = [];
    const after: MatrixMessageDTO[] = [];
    for (let index = targetIndex - 1, scanned = 0; index >= 0 && before.length < 2 && scanned++ < 10; index--) {
        const event = events[index];
        isolatedDecryptionEvents.add(event);
        await decryptMappedEvents([event]);
        const contextEventId = event.getId();
        const normalized = normalizeMessage(room, event, contextEventId ? reactionMap.get(contextEventId) : undefined);
        if (!normalized) continue;
        cacheSearchEvent(room.roomId, event);
        before.unshift(normalized);
    }
    for (let index = targetIndex + 1, scanned = 0; index < events.length && after.length < 2 && scanned++ < 10; index++) {
        const event = events[index];
        isolatedDecryptionEvents.add(event);
        await decryptMappedEvents([event]);
        const contextEventId = event.getId();
        const normalized = normalizeMessage(room, event, contextEventId ? reactionMap.get(contextEventId) : undefined);
        if (!normalized) continue;
        cacheSearchEvent(room.roomId, event);
        after.push(normalized);
    }
    return { roomId: room.roomId, message, before, after, isolated: true };
}

async function localSearchResults(
    roomIds: string[],
    query: string
): Promise<{ results: MatrixMessageSearchResultDTO[]; incomplete: boolean; }> {
    const normalizedQuery = query.toLowerCase();
    const rooms = roomIds
        .map(roomId => matrixClient!.getRoom(roomId))
        .filter((room): room is Room => Boolean(room && room.getMyMembership() === "join" && !room.isSpaceRoom()))
        .sort((left, right) => {
            const leftEvents = left.getLiveTimeline().getEvents();
            const rightEvents = right.getLiveTimeline().getEvents();
            return (rightEvents.at(-1)?.getTs() ?? 0) - (leftEvents.at(-1)?.getTs() ?? 0);
        });
    const results: MatrixMessageSearchResultDTO[] = [];
    let scanned = 0;
    let incomplete = false;
    const deadline = Date.now() + MAX_LOCAL_SEARCH_MS;
    roomLoop: for (let roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
        const room = rooms[roomIndex];
        const events = room.getLiveTimeline().getEvents();
        const roomLimit = Math.min(events.length, MAX_LOCAL_SEARCH_EVENTS_PER_ROOM, MAX_LOCAL_SEARCH_EVENTS - scanned);
        if (events.length > roomLimit || room.getLiveTimeline().getPaginationToken(Direction.Backward) != null) incomplete = true;
        const reactionMap = buildReactionMap(room);
        for (let offset = 0; offset < roomLimit; offset++) {
            if (Date.now() >= deadline) {
                incomplete = true;
                break roomLoop;
            }
            const index = events.length - 1 - offset;
            const event = events[index];
            scanned++;
            await decryptMappedEvents([event], false);
            const content = event.getContent<Record<string, any>>();
            const searchable = safeMessageBody(content.body).toLowerCase();
            if (!searchable.includes(normalizedQuery)) continue;
            const eventId = event.getId();
            const message = normalizeMessage(room, event, eventId ? reactionMap.get(eventId) : undefined);
            if (!message) continue;
            let replacementIndex = -1;
            if (results.length >= MAX_LOCAL_SEARCH_RESULTS) {
                incomplete = true;
                replacementIndex = results.reduce((oldestIndex, candidate, candidateIndex) => {
                    const oldest = results[oldestIndex];
                    return candidate.message.timestamp < oldest.message.timestamp
                        || (candidate.message.timestamp === oldest.message.timestamp
                            && candidate.message.eventId.localeCompare(oldest.message.eventId) > 0)
                        ? candidateIndex
                        : oldestIndex;
                }, 0);
                const oldest = results[replacementIndex];
                if (message.timestamp < oldest.message.timestamp
                    || (message.timestamp === oldest.message.timestamp
                        && message.eventId.localeCompare(oldest.message.eventId) >= 0)) {
                    continue;
                }
            }
            const context = await searchContextMessages(room, events, index);
            const result: MatrixMessageSearchResultDTO = {
                roomId: room.roomId,
                roomName: publicRoomText(room.name, 256) ?? room.roomId,
                message,
                ...context,
                source: "local",
                // Loaded SDK history may be older than the renderer's bounded
                // snapshot. Keep it isolated so opening a hit cannot create an
                // unfillable hole in the ordinary scrolling timeline.
                isolated: true
            };
            if (replacementIndex >= 0) results[replacementIndex] = result;
            else results.push(result);
        }
        if (scanned >= MAX_LOCAL_SEARCH_EVENTS) {
            // The exact global bound is complete when this was the final room
            // and every event in it was inspected. Only advertise truncation
            // when a later room still has loaded or potentially pageable data.
            if (rooms.slice(roomIndex + 1).some(candidate =>
                candidate.getLiveTimeline().getEvents().length > 0
                || candidate.getLiveTimeline().getPaginationToken(Direction.Backward) != null)) {
                incomplete = true;
            }
            break;
        }
    }
    return { results, incomplete };
}

interface ServerSearchPage {
    results: MatrixMessageSearchResultDTO[];
    nextBatch?: string;
    incomplete: boolean;
}

async function serverSearchPage(
    roomIds: string[],
    query: string,
    limit: number,
    nextBatch?: string
): Promise<ServerSearchPage> {
    const allowedRooms = new Set(roomIds);
    const response = await matrixClient!.search({
        body: {
            search_categories: {
                room_events: {
                    search_term: query,
                    keys: ["content.body"],
                    filter: { rooms: roomIds, types: [EventType.RoomMessage, EventType.Sticker], limit },
                    order_by: "recent",
                    event_context: { before_limit: 2, after_limit: 2, include_profile: false },
                    include_state: false
                }
            }
        } as any,
        ...(nextBatch ? { next_batch: nextBatch } : {})
    });
    const roomEvents = response?.search_categories?.room_events;
    if (!roomEvents || (roomEvents.results != null && !Array.isArray(roomEvents.results))) {
        fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned an invalid Matrix search response.");
    }
    const rawResults = roomEvents.results ?? [];
    if (rawResults.length > 100) {
        fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned too many Matrix search results.");
    }
    const results: MatrixMessageSearchResultDTO[] = [];
    let incomplete = false;
    for (const rawResult of rawResults) {
        if (!rawResult || typeof rawResult !== "object" || !rawResult.result || typeof rawResult.result !== "object") continue;
        const roomId = optionalRoomId(rawResult.result.room_id);
        const room = roomId ? matrixClient!.getRoom(roomId) : undefined;
        if (!roomId || !allowedRooms.has(roomId) || !room || room.getMyMembership() !== "join" || room.hasEncryptionStateEvent()) continue;
        const target = safeMappedEvent(roomId, rawResult.result);
        if (!target) continue;
        await decryptMappedEvents([target]);
        cacheSearchEvent(roomId, target);
        const targetId = target.getId();
        const message = normalizeMessage(room, target, targetId ? buildReactionMap(room).get(targetId) : undefined);
        if (!message) continue;
        const rawContext = rawResult.context;
        const beforeEvents = Array.isArray(rawContext?.events_before)
            ? rawContext.events_before.slice(0, 2).flatMap(value => {
                const event = safeMappedEvent(roomId, value);
                return event ? [event] : [];
            })
            : [];
        const afterEvents = Array.isArray(rawContext?.events_after)
            ? rawContext.events_after.slice(0, 2).flatMap(value => {
                const event = safeMappedEvent(roomId, value);
                return event ? [event] : [];
            })
            : [];
        await decryptMappedEvents([...beforeEvents, ...afterEvents]);
        for (const event of [...beforeEvents, ...afterEvents]) cacheSearchEvent(roomId, event);
        const reactionMap = buildReactionMap(room);
        const normalizeContext = (event: MatrixEvent) => {
            const eventId = event.getId();
            return normalizeMessage(room, event, eventId ? reactionMap.get(eventId) : undefined);
        };
        const before = beforeEvents.map(normalizeContext).filter((item): item is MatrixMessageDTO => item != null);
        const after = afterEvents.map(normalizeContext).filter((item): item is MatrixMessageDTO => item != null);
        const rank = typeof rawResult.rank === "number" && Number.isFinite(rawResult.rank) ? rawResult.rank : undefined;
        results.push({
            roomId,
            roomName: publicRoomText(room.name, 256) ?? roomId,
            message,
            before,
            after,
            source: "server",
            isolated: true,
            ...(rank != null ? { rank } : {})
        });
    }
    let responseNextBatch: string | undefined;
    if (roomEvents.next_batch != null) {
        if (typeof roomEvents.next_batch !== "string"
            || roomEvents.next_batch.length === 0
            || roomEvents.next_batch.length > 4_096
            || /[\u0000-\u001f\u007f]/u.test(roomEvents.next_batch)) {
            fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned an invalid Matrix search cursor.");
        }
        responseNextBatch = roomEvents.next_batch;
    }
    if (Number.isSafeInteger(roomEvents.count) && Number(roomEvents.count) > rawResults.length && !responseNextBatch) {
        incomplete = true;
    }
    return { results, nextBatch: responseNextBatch, incomplete };
}

function appendSearchResults(state: SearchCursorState, results: MatrixMessageSearchResultDTO[]): void {
    const additions: Array<{ key: string; result: MatrixMessageSearchResultDTO; }> = [];
    const pendingKeys = new Set<string>();
    for (const result of results) {
        const key = `${result.roomId}\0${result.message.eventId}`;
        if (state.seen.has(key) || pendingKeys.has(key)) continue;
        if (state.results.length + additions.length >= MAX_SEARCH_RESULTS_BUFFER) {
            state.incomplete = true;
            if (result.source === "server") {
                // The next_batch token has not been committed yet. Fail closed
                // instead of advancing it past a server result we did not keep.
                fail("MATRIX_PROTOCOL_ERROR", "The homeserver returned more Matrix search results than can be retained safely.");
            }
            continue;
        }
        pendingKeys.add(key);
        additions.push({ key, result });
    }
    for (const { key, result } of additions) {
        state.seen.add(key);
        state.results.push(result);
    }
    state.results.sort((left, right) => right.message.timestamp - left.message.timestamp
        || left.message.eventId.localeCompare(right.message.eventId));
}

async function fillServerSearch(state: SearchCursorState, query: string, limit: number): Promise<void> {
    if (state.serverExhausted || !state.serverRoomIds.length) return;
    try {
        const page = await serverSearchPage(state.serverRoomIds, query, limit, state.nextBatch);
        appendSearchResults(state, page.results);
        if (page.results.length) state.serverResultSeen = true;
        const cycledBatch = page.nextBatch != null && state.seenServerBatches.has(page.nextBatch);
        const batchLimitReached = page.nextBatch != null
            && !cycledBatch
            && state.seenServerBatches.size >= MAX_SERVER_SEARCH_BATCHES;
        if (page.nextBatch && !cycledBatch && !batchLimitReached) {
            state.seenServerBatches.add(page.nextBatch);
        }
        state.nextBatch = cycledBatch || batchLimitReached ? undefined : page.nextBatch;
        state.serverExhausted = cycledBatch || batchLimitReached || !page.nextBatch;
        if (cycledBatch || batchLimitReached) state.incomplete = true;
        if (page.incomplete) state.incomplete = true;
    } catch (error) {
        if (error instanceof PublicWorkerError && error.code === "MATRIX_PROTOCOL_ERROR") throw error;
        state.serverExhausted = true;
        state.incomplete = true;
        state.coverage = state.serverResultSeen ? "mixed" : "local";
        const fallback = await localSearchResults(state.serverRoomIds, query);
        appendSearchResults(state, fallback.results);
        if (fallback.incomplete) state.incomplete = true;
    }
}

async function fillServerSearchForPage(state: SearchCursorState, query: string, limit: number): Promise<void> {
    // Server pages are ordered by recency. Keep at least one complete output
    // page of server hits buffered before mixing in local encrypted-room hits;
    // otherwise old local hits could be emitted ahead of a newer next_batch.
    let pages = 0;
    while (!state.serverExhausted
        && state.results.filter(result => result.source === "server").length < limit
        && pages++ < 8) {
        const previousBatch = state.nextBatch;
        const previousSize = state.results.length;
        await fillServerSearch(state, query, limit);
        if (!state.serverExhausted && state.nextBatch === previousBatch && state.results.length === previousSize) {
            state.incomplete = true;
            break;
        }
    }
    if (!state.serverExhausted && state.results.filter(result => result.source === "server").length < limit) {
        state.incomplete = true;
    }
}

function searchCursorState(cursor: string, fingerprint: string): SearchCursorState {
    const state = searchCursors.get(cursor);
    if (!state || state.generation !== clientGeneration || state.expiresAt <= Date.now() || state.fingerprint !== fingerprint) {
        searchCursors.delete(cursor);
        fail("MATRIX_STALE_CURSOR", "The Matrix search cursor is invalid or has expired.");
    }
    return state;
}

async function searchMessages(
    command: Extract<MatrixWorkerCommand, { type: "searchMessages"; }>
): Promise<MatrixMessageSearchResponse> {
    if (!matrixClient) fail("MATRIX_NOT_STARTED", "The Matrix backend is not started.");
    const request = validateSearchRequest(command.request);
    let { cursor } = request;
    let state: SearchCursorState;
    if (cursor) {
        state = searchCursorState(cursor, request.fingerprint);
        await fillServerSearchForPage(state, request.query, request.limit);
    } else {
        const scope = searchScopeRooms(request.scope);
        const encryptedRoomIds = scope.roomIds.filter(roomId => matrixClient!.getRoom(roomId)?.hasEncryptionStateEvent());
        const serverRoomIds = scope.roomIds.filter(roomId => !encryptedRoomIds.includes(roomId));
        const local = await localSearchResults(encryptedRoomIds, request.query);
        state = {
            generation: clientGeneration,
            expiresAt: Date.now() + CURSOR_TTL_MS,
            fingerprint: request.fingerprint,
            roomIds: scope.roomIds,
            serverRoomIds,
            coverage: encryptedRoomIds.length ? serverRoomIds.length ? "mixed" : "local" : "server",
            searchedRoomCount: scope.roomIds.length,
            incomplete: scope.limited || local.incomplete,
            serverExhausted: serverRoomIds.length === 0,
            serverResultSeen: false,
            seenServerBatches: new Set(),
            results: [],
            seen: new Set()
        };
        appendSearchResults(state, local.results);
        await fillServerSearchForPage(state, request.query, request.limit);
    }

    const results = state.results.splice(0, request.limit);
    state.expiresAt = Date.now() + CURSOR_TTL_MS;
    const hasMore = state.results.length > 0 || !state.serverExhausted;
    if (hasMore) {
        if (!cursor) {
            pruneCursorMap(searchCursors, MAX_SEARCH_CURSORS);
            cursor = opaqueCursor("s");
        }
        searchCursors.set(cursor, state);
    } else if (cursor) {
        searchCursors.delete(cursor);
    }
    return {
        results,
        ...(hasMore && cursor ? { cursor } : {}),
        coverage: state.coverage,
        searchedRoomCount: state.searchedRoomCount,
        limited: state.incomplete || hasMore
    };
}

const PROJECTED_SOCIAL_HOSTS = new Set([
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com"
]);
const FIRST_HTTP_URL = /https?:\/\/[^\s<>"'\u0000-\u001f\u007f]+/iu;

function previewCacheKey(roomId: string, eventId: string): string {
    return `${roomId}\0${eventId}`;
}

function trimUrlPunctuation(candidate: string): string {
    candidate = candidate.replace(/[.,!?;:]+$/u, "");
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
        while (candidate.endsWith(closing)
            && candidate.split(closing).length > candidate.split(opening).length) {
            candidate = candidate.slice(0, -1);
        }
    }
    return candidate;
}

function firstPreviewUrl(content: Record<string, any>): string | undefined {
    if (content.msgtype !== MsgType.Text || typeof content.body !== "string") return undefined;
    const match = FIRST_HTTP_URL.exec(content.body);
    const candidate = match ? trimUrlPunctuation(match[0]) : "";
    if (!candidate || candidate.length > 2_048) return undefined;
    try {
        const url = new URL(candidate);
        if ((url.protocol !== "http:" && url.protocol !== "https:")
            || url.username || url.password || url.port) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

function klipyShareUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "klipy.com"
            || url.username || url.password || url.port || url.search || url.hash
            || url.href !== value || !/^\/gifs\/[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u.test(url.pathname)) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

function tenorShareUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || (url.hostname !== "tenor.com" && url.hostname !== "www.tenor.com")
            || url.username || url.password || url.port || url.search || url.hash
            || url.href !== value
            || !/^\/view\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,238}[A-Za-z0-9])?-gif-[1-9][0-9]{0,19}$/u.test(url.pathname)) {
            return undefined;
        }
        url.hostname = "tenor.com";
        return url.href;
    } catch {
        return undefined;
    }
}

function xStatusApiUrl(value: string): { url: string; statusId: string; } | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !PROJECTED_SOCIAL_HOSTS.has(url.hostname)
            || url.username || url.password || url.port) {
            return undefined;
        }
        const match = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/(\d{2,20})\/?$/u.exec(url.pathname);
        if (!match) return undefined;
        return {
            url: `https://api.fxtwitter.com/2/status/${match[1]}`,
            statusId: match[1]
        };
    } catch {
        return undefined;
    }
}

function xVideoUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "video.twimg.com"
            || url.username || url.password || url.port || url.hash || url.href !== value
            || !url.pathname.toLowerCase().endsWith(".mp4")) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

function previewText(value: unknown, maximum: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
        .trim()
        .slice(0, maximum)
        .trim();
    return text || undefined;
}

function previewDimensions(widthValue: unknown, heightValue: unknown): { width: number; height: number; } | undefined {
    const numeric = (value: unknown): unknown => typeof value === "string" && /^[1-9]\d{0,5}$/u.test(value)
        ? Number(value)
        : value;
    return safeImageDimensions(numeric(widthValue), numeric(heightValue));
}

function previewVideoSource(preview: Awaited<ReturnType<MatrixClient["getUrlPreview"]>>): { mxc: string; } | undefined {
    const candidates = [preview["og:video:secure_url"], preview["og:video:url"], preview["og:video"]];
    for (const value of candidates) {
        if (typeof value !== "string" || value.length === 0 || value.length > 4_096
            || /[\u0000-\u001f\u007f]/u.test(value)) continue;
        if (authenticatedMediaUrl(value)) return { mxc: value };
    }
    return undefined;
}

interface OpenGraphMedia {
    url?: string;
    type?: string;
    width?: string;
    height?: string;
}

interface OpenGraphMetadata {
    title?: string;
    description?: string;
    provider?: string;
    images: OpenGraphMedia[];
    videos: OpenGraphMedia[];
}

function parseOpenGraphMetadata(html: string): OpenGraphMetadata | undefined {
    if (!html || html.length > MAX_PROVIDER_PREVIEW_DOCUMENT_CHARS) return undefined;
    const metaMarkup = Array.from(html.matchAll(/<meta\b[^>]{0,8192}>/giu), match => match[0])
        .slice(0, 256)
        .join("");
    if (!metaMarkup) return undefined;
    const document = new DOMParser().parseFromString(`<head>${metaMarkup}</head>`, "text/html");
    const metadata: OpenGraphMetadata = { images: [], videos: [] };
    let currentImage: OpenGraphMedia | undefined;
    let currentVideo: OpenGraphMedia | undefined;
    for (const element of document.querySelectorAll("meta[property], meta[name]")) {
        const property = (element.getAttribute("property") ?? element.getAttribute("name"))?.trim().toLowerCase();
        const content = element.getAttribute("content")?.trim();
        if (!property || !content) continue;
        if ((property === "og:title" || property === "twitter:title") && metadata.title == null) {
            metadata.title = previewText(content, 512);
        } else if ((property === "og:description" || property === "twitter:description")
            && metadata.description == null) {
            metadata.description = previewText(content, 4_096);
        } else if (property === "og:site_name" && metadata.provider == null) {
            metadata.provider = previewText(content, 256);
        } else if (property === "og:image" || property === "og:image:url" || property === "twitter:image") {
            currentImage = { url: content };
            metadata.images.push(currentImage);
        } else if (property === "og:image:secure_url") {
            currentImage ??= {};
            if (!metadata.images.includes(currentImage)) metadata.images.push(currentImage);
            currentImage.url = content;
        } else if (property === "og:image:type" && currentImage) currentImage.type = content;
        else if (property === "og:image:width" && currentImage) currentImage.width = content;
        else if (property === "og:image:height" && currentImage) currentImage.height = content;
        else if (property === "og:video" || property === "og:video:url"
            || property === "twitter:player:stream") {
            currentVideo = { url: content };
            metadata.videos.push(currentVideo);
        } else if (property === "og:video:secure_url") {
            currentVideo ??= {};
            if (!metadata.videos.includes(currentVideo)) metadata.videos.push(currentVideo);
            currentVideo.url = content;
        } else if ((property === "og:video:type" || property === "twitter:player:stream:content_type") && currentVideo) {
            currentVideo.type = content;
        } else if ((property === "og:video:width" || property === "twitter:player:width") && currentVideo) {
            currentVideo.width = content;
        } else if ((property === "og:video:height" || property === "twitter:player:height") && currentVideo) {
            currentVideo.height = content;
        }
    }
    return metadata;
}

async function klipyUrlPreview(sourceUrl: string): Promise<CachedUrlPreview | undefined> {
    if (!klipyShareUrl(sourceUrl)) return undefined;

    let html: string | undefined;
    try {
        html = await window.MatrixBridgeWorkerHost.fetchKlipyPreview(sourceUrl);
    } catch {
        return undefined;
    }
    const metadata = parseOpenGraphMetadata(html ?? "");
    if (!metadata) return undefined;

    let imageUrl: string | undefined;
    let dimensions: { width: number; height: number; } | undefined;
    for (const image of metadata.images) {
        const candidate = klipyMediaUrl(image.url);
        const type = normalizedMimeType(image.type);
        const candidateDimensions = previewDimensions(image.width, image.height);
        if (candidate && type === "image/gif" && candidateDimensions) {
            imageUrl = candidate;
            dimensions = candidateDimensions;
            break;
        }
    }
    if (!imageUrl || !dimensions) return undefined;

    const preview: MatrixUrlPreviewDTO = {
        url: sourceUrl,
        provider: { name: "KLIPY" },
        image: {
            name: "klipy-preview.gif",
            mimeType: "image/gif",
            width: dimensions.width,
            height: dimensions.height,
            animated: true,
            downloadable: true,
            downloadIndex: 0,
            encrypted: false
        }
    };
    if (metadata.title) preview.title = metadata.title;
    if (metadata.description) preview.description = metadata.description;
    return { sourceUrl, directProvider: "klipy", imageUrl, preview };
}

function previewImageMime(value: unknown, url: string): "image/jpeg" | "image/png" | "image/webp" | undefined {
    const declared = normalizedMimeType(value);
    if (declared === "image/jpeg" || declared === "image/png" || declared === "image/webp") return declared;
    const candidate = new URL(url);
    const format = candidate.searchParams.get("format")?.toLowerCase();
    if (format === "jpg" || format === "jpeg" || /\.jpe?g$/iu.test(candidate.pathname)) return "image/jpeg";
    if (format === "png" || /\.png$/iu.test(candidate.pathname)) return "image/png";
    if (format === "webp" || /\.webp$/iu.test(candidate.pathname)) return "image/webp";
    return undefined;
}

function fxTwitterRecord(value: unknown): Record<string, unknown> | undefined {
    return value != null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

async function xUrlPreview(
    sourceUrl: string,
    request: { url: string; statusId: string; }
): Promise<CachedUrlPreview | undefined> {
    let raw: string | undefined;
    try {
        raw = await window.MatrixBridgeWorkerHost.fetchXStatus(request.url);
    } catch {
        return undefined;
    }
    if (!raw || raw.length > MAX_PROVIDER_PREVIEW_DOCUMENT_CHARS) return undefined;

    let response: Record<string, unknown> | undefined;
    try {
        response = fxTwitterRecord(JSON.parse(raw));
    } catch {
        return undefined;
    }
    const status = fxTwitterRecord(response?.status);
    const author = fxTwitterRecord(status?.author);
    const media = fxTwitterRecord(status?.media);
    const videos = media?.videos;
    const screenName = author?.screen_name;
    const authorName = author?.name;
    const text = status?.text;
    if (response?.code !== 200 || status?.type !== "status" || status.id !== request.statusId
        || status.provider !== "twitter" || status.embed_card !== "player"
        || typeof screenName !== "string" || !/^[A-Za-z0-9_]{1,15}$/u.test(screenName)
        || (authorName != null && (typeof authorName !== "string" || authorName.length > 256))
        || typeof text !== "string" || text.length > 65_536
        || !Array.isArray(videos) || videos.length === 0 || videos.length > 16) {
        return undefined;
    }

    let video: {
        url: string;
        posterUrl: string;
        posterMimeType: "image/jpeg" | "image/png" | "image/webp";
        dimensions: { width: number; height: number; };
    } | undefined;
    for (const value of videos) {
        const candidate = fxTwitterRecord(value);
        if (!candidate || candidate.type !== "video" || candidate.format !== "video/mp4") continue;
        const url = xVideoUrl(candidate.url);
        const posterUrl = xPosterUrl(candidate.thumbnail_url);
        const posterMimeType = posterUrl ? previewImageMime(undefined, posterUrl) : undefined;
        const dimensions = previewDimensions(candidate.width, candidate.height);
        if (url && posterUrl && posterMimeType && dimensions) {
            video = { url, posterUrl, posterMimeType, dimensions };
            break;
        }
    }
    if (!video) return undefined;

    const preview: MatrixUrlPreviewDTO = {
        url: sourceUrl,
        provider: { name: "X" },
        title: previewText(authorName ? `${authorName} (@${screenName})` : `@${screenName}`, 512),
        description: previewText(text, 4_096),
        image: {
            name: `x-preview.${video.posterMimeType.split("/")[1].replace("jpeg", "jpg")}`,
            mimeType: video.posterMimeType,
            ...video.dimensions,
            downloadable: true,
            downloadIndex: 0,
            encrypted: false
        },
        video: {
            name: "x-preview.mp4",
            mimeType: "video/mp4",
            ...video.dimensions,
            downloadable: true,
            downloadIndex: 1,
            encrypted: false
        }
    };
    return {
        sourceUrl,
        directProvider: "x",
        imageUrl: video.posterUrl,
        videoUrl: video.url,
        preview
    };
}

async function tenorUrlPreview(sourceUrl: string): Promise<CachedUrlPreview | undefined> {
    let html: string | undefined;
    try {
        html = await window.MatrixBridgeWorkerHost.fetchTenorPreview(sourceUrl);
    } catch {
        return undefined;
    }
    const metadata = parseOpenGraphMetadata(html ?? "");
    if (!metadata) return undefined;

    let image: { url: string; mimeType: "image/gif" | "image/webp"; dimensions?: { width: number; height: number; }; } | undefined;
    for (const candidate of metadata.images) {
        const url = tenorMediaUrl(candidate.url);
        if (!url) continue;
        const mimeType = new URL(url).pathname.toLowerCase().endsWith(".gif") ? "image/gif"
            : new URL(url).pathname.toLowerCase().endsWith(".webp") ? "image/webp" : undefined;
        if (!mimeType) continue;
        const selected: NonNullable<typeof image> = {
            url,
            mimeType,
            dimensions: previewDimensions(candidate.width, candidate.height)
        };
        if (!image || selected.dimensions) image = selected;
        if (selected.dimensions) break;
    }
    if (!image) return undefined;

    let video: { url: string; dimensions: { width: number; height: number; }; } | undefined;
    for (const candidate of metadata.videos) {
        const url = tenorMediaUrl(candidate.url);
        const dimensions = previewDimensions(candidate.width, candidate.height);
        if (url && new URL(url).pathname.toLowerCase().endsWith(".mp4") && dimensions) {
            video = { url, dimensions };
            break;
        }
    }
    const imageDimensions = image.dimensions ?? video?.dimensions;
    if (!imageDimensions) return undefined;
    const preview: MatrixUrlPreviewDTO = {
        url: sourceUrl,
        provider: { name: "Tenor" },
        image: {
            name: `tenor-preview.${image.mimeType === "image/gif" ? "gif" : "webp"}`,
            mimeType: image.mimeType,
            ...imageDimensions,
            ...(image.mimeType === "image/gif" ? { animated: true } : {}),
            downloadable: true,
            downloadIndex: 0,
            encrypted: false
        }
    };
    if (video) {
        preview.video = {
            name: "tenor-preview.mp4",
            mimeType: "video/mp4",
            ...video.dimensions,
            downloadable: true,
            downloadIndex: 1,
            encrypted: false
        };
    }
    if (metadata.title) preview.title = metadata.title;
    if (metadata.description) preview.description = metadata.description;
    return {
        sourceUrl,
        directProvider: "tenor",
        imageUrl: image.url,
        videoUrl: video?.url,
        preview
    };
}

function cloneUrlPreview(preview: MatrixUrlPreviewDTO): MatrixUrlPreviewDTO {
    return {
        ...preview,
        provider: preview.provider ? { ...preview.provider } : undefined,
        image: preview.image ? { ...preview.image } : undefined,
        video: preview.video ? { ...preview.video } : undefined
    };
}

function cacheUrlPreview(
    key: string,
    value: CachedUrlPreview
): void {
    urlPreviewMedia.delete(key);
    while (urlPreviewMedia.size >= MAX_URL_PREVIEW_CACHE) {
        const oldest = urlPreviewMedia.keys().next().value;
        if (typeof oldest !== "string") break;
        urlPreviewMedia.delete(oldest);
    }
    urlPreviewMedia.set(key, value);
}

async function urlPreview(command: Extract<MatrixWorkerCommand, { type: "urlPreview"; }>): Promise<MatrixUrlPreviewDTO | undefined> {
    if (typeof command.allowDirectMedia !== "boolean") {
        fail("MATRIX_INVALID_ARGUMENT", "The provider-preview policy is invalid.");
    }
    const allowDirectMedia = command.allowDirectMedia && directPreviewPolicyAllowed;
    const room = getRoom(command.roomId);
    const encrypted = room.hasEncryptionStateEvent();
    const eventId = validateEventId(command.eventId);
    const event = findRoomEvent(room, eventId);
    if (!event || event.getType() !== EventType.RoomMessage || event.isRedacted()) return undefined;
    const sourceUrl = firstPreviewUrl(event.getContent<Record<string, any>>());
    if (!sourceUrl) return undefined;

    const key = previewCacheKey(room.roomId, eventId);
    const cached = urlPreviewMedia.get(key);
    if (cached?.sourceUrl === sourceUrl
        && (!cached.directProvider || allowDirectMedia)
        && (!encrypted || cached.directProvider)) {
        cacheUrlPreview(key, cached);
        return cloneUrlPreview(cached.preview);
    }
    if (cached) urlPreviewMedia.delete(key);

    const klipyUrl = klipyShareUrl(sourceUrl);
    const tenorUrl = tenorShareUrl(sourceUrl);
    const xStatusRequest = xStatusApiUrl(sourceUrl);
    if (allowDirectMedia && (klipyUrl || tenorUrl || xStatusRequest)) {
        const directPreview = klipyUrl
            ? await klipyUrlPreview(klipyUrl)
            : tenorUrl
                ? await tenorUrlPreview(tenorUrl)
                : await xUrlPreview(sourceUrl, xStatusRequest!);
        if (!directPreviewPolicyAllowed) return undefined;
        if (directPreview) {
            // Keep the message's original link as cache identity and DTO display.
            directPreview.sourceUrl = sourceUrl;
            directPreview.preview.url = sourceUrl;
            cacheUrlPreview(key, directPreview);
            return cloneUrlPreview(directPreview.preview);
        }
    }

    // Asking the homeserver to preview any URL from an encrypted room would
    // reveal plaintext which the room deliberately hid from that server.
    if (encrypted) return undefined;

    let preview: Awaited<ReturnType<MatrixClient["getUrlPreview"]>>;
    try {
        preview = await matrixClient!.getUrlPreview(sourceUrl, event.getTs());
    } catch (error) {
        const safeError = publicError(error);
        throw new PublicWorkerError(safeError.code, safeError.message);
    }
    const result: MatrixUrlPreviewDTO = { url: sourceUrl };
    const title = previewText(preview["og:title"], 512);
    const description = previewText(preview["og:description"], 4_096);
    const providerName = previewText(
        preview["og:site_name"] ?? preview["og:provider_name"] ?? preview.provider_name,
        256
    );
    if (title) result.title = title;
    if (description) result.description = description;
    if (providerName) result.provider = { name: providerName };

    let cachedImageMxc: string | undefined;
    const rawImageMxc = preview["og:image"];
    if (typeof rawImageMxc === "string" && authenticatedMediaUrl(rawImageMxc)) {
        const mimeType = normalizedMimeType(preview["og:image:type"]);
        const dimensions = safeImageDimensions(preview["og:image:width"], preview["og:image:height"]);
        const size = Number.isSafeInteger(preview["matrix:image:size"]) && Number(preview["matrix:image:size"]) >= 0
            ? Number(preview["matrix:image:size"])
            : undefined;
        if (size == null || size <= MAX_MEDIA_DOWNLOAD_BYTES) {
            const image: MatrixUrlPreviewMediaDTO = {
                name: mimeType === "image/gif" ? "link-preview.gif" : "link-preview",
                downloadable: true,
                downloadIndex: 0,
                encrypted: false
            };
            if (mimeType) image.mimeType = mimeType;
            if (size != null) image.size = size;
            if (dimensions) {
                image.width = dimensions.width;
                image.height = dimensions.height;
            }
            if (mimeType === "image/gif") image.animated = true;
            result.image = image;
            cachedImageMxc = rawImageMxc;
        }
    }

    let videoMxc: string | undefined;
    const videoSource = previewVideoSource(preview);
    const videoMimeType = normalizedMimeType(preview["og:video:type"]);
    const videoDimensions = previewDimensions(preview["og:video:width"], preview["og:video:height"]);
    const videoSize = Number.isSafeInteger(preview["matrix:video:size"]) && Number(preview["matrix:video:size"]) >= 0
        ? Number(preview["matrix:video:size"])
        : undefined;
    if (videoSource && videoMimeType === "video/mp4" && videoDimensions
        && (videoSize == null || videoSize <= MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES)) {
        result.video = {
            name: "link-preview.mp4",
            mimeType: "video/mp4",
            size: videoSize,
            width: videoDimensions.width,
            height: videoDimensions.height,
            downloadable: true,
            downloadIndex: 1,
            encrypted: false
        };
        videoMxc = videoSource.mxc;
    }
    cacheUrlPreview(key, { sourceUrl, imageMxc: cachedImageMxc, videoMxc, preview: result });
    return cloneUrlPreview(result);
}

function validDirectPreviewCache(preview: CachedUrlPreview): boolean {
    if (preview.imageMxc || preview.videoMxc) return false;
    switch (preview.directProvider) {
        case "klipy":
            return klipyShareUrl(preview.sourceUrl) != null
                && klipyMediaUrl(preview.imageUrl) === preview.imageUrl
                && preview.videoUrl == null;
        case "x":
            return xStatusApiUrl(preview.sourceUrl) != null
                && xPosterUrl(preview.imageUrl) === preview.imageUrl
                && xVideoUrl(preview.videoUrl) === preview.videoUrl;
        case "tenor":
            return tenorShareUrl(preview.sourceUrl) != null
                && tenorMediaUrl(preview.imageUrl) === preview.imageUrl
                && (preview.videoUrl == null || tenorMediaUrl(preview.videoUrl) === preview.videoUrl);
        default:
            return false;
    }
}

async function downloadMedia(command: Extract<MatrixWorkerCommand, { type: "downloadMedia"; }>): Promise<MatrixMediaDownloadResult> {
    if (typeof command.allowDirectMedia !== "boolean") {
        fail("MATRIX_INVALID_ARGUMENT", "The provider-preview policy is invalid.");
    }
    const allowDirectMedia = command.allowDirectMedia && directPreviewPolicyAllowed;
    if (!Number.isSafeInteger(command.attachmentIndex)
        || (command.attachmentIndex !== 0 && command.attachmentIndex !== 1)) {
        fail("MATRIX_INVALID_ARGUMENT", "The Matrix attachment index is invalid.");
    }
    const room = getRoom(command.roomId);
    const eventId = validateEventId(command.eventId);
    const event = findRoomEvent(room, eventId);
    if (!event) fail("MATRIX_EVENT_NOT_LOADED", "The Matrix media event is not loaded.");
    await matrixClient!.decryptEventIfNeeded(event);
    if (event.isDecryptionFailure()) fail("MATRIX_MEDIA_DECRYPTION_FAILED", "The Matrix media event could not be decrypted.");

    const content = event.getContent<Record<string, any>>();
    let attachment = attachmentFromContent(content, event.getType())?.[0];
    if (attachment && command.attachmentIndex !== 0) {
        fail("MATRIX_MEDIA_MISSING", "This Matrix event has no downloadable attachment.");
    }
    const preview = !attachment ? urlPreviewMedia.get(previewCacheKey(room.roomId, eventId)) : undefined;
    if (preview && ((!preview.directProvider && room.hasEncryptionStateEvent())
        || (preview.directProvider && (!allowDirectMedia || !validDirectPreviewCache(preview))))) {
        urlPreviewMedia.delete(previewCacheKey(room.roomId, eventId));
        fail("MATRIX_MEDIA_MISSING", "This Matrix event has no downloadable attachment.");
    }
    if (preview && preview.sourceUrl !== firstPreviewUrl(content)) {
        urlPreviewMedia.delete(previewCacheKey(room.roomId, eventId));
        fail("MATRIX_MEDIA_MISSING", "This Matrix event has no downloadable attachment.");
    }
    if (preview) {
        const previewAttachment = command.attachmentIndex === 0 ? preview.preview.image : preview.preview.video;
        if (previewAttachment?.downloadIndex !== command.attachmentIndex) {
            fail("MATRIX_MEDIA_MISSING", "This Matrix event has no downloadable attachment.");
        }
        attachment = previewAttachment;
    }
    if (!attachment?.downloadable) fail("MATRIX_MEDIA_MISSING", "This Matrix event has no downloadable attachment.");
    const maximumBytes = preview && command.attachmentIndex === 1
        ? MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES
        : MAX_MEDIA_DOWNLOAD_BYTES;
    if (attachment.size != null && attachment.size > maximumBytes) {
        fail("MATRIX_MEDIA_TOO_LARGE", "This Matrix attachment is too large to display.");
    }

    const encryptedFile = content.file && typeof content.file === "object"
        ? validateEncryptedMediaFile(content.file)
        : undefined;
    const mxc = preview
        ? command.attachmentIndex === 0 ? preview.imageMxc : preview.videoMxc
        : encryptedFile?.url ?? content.url;
    const externalImageUrl = preview && command.attachmentIndex === 0 ? preview.imageUrl : undefined;
    const externalVideoUrl = preview && command.attachmentIndex === 1 ? preview.videoUrl : undefined;
    if ((!mxc || !authenticatedMediaUrl(mxc)) && !externalImageUrl && !externalVideoUrl) {
        fail("MATRIX_MEDIA_INVALID", "The Matrix media URI is invalid.");
    }
    const downloaded = externalImageUrl
        ? preview?.directProvider === "klipy"
            ? await fetchKlipyGif(externalImageUrl)
            : preview?.directProvider === "x"
                ? await fetchXPoster(externalImageUrl)
                : preview?.directProvider === "tenor"
                    ? await fetchTenorMedia(externalImageUrl)
                    : fail("MATRIX_MEDIA_INVALID", "The provider preview cache was invalid.")
        : externalVideoUrl
            ? preview?.directProvider === "tenor"
                ? await fetchTenorMedia(externalVideoUrl)
                : preview?.directProvider === "x"
                    ? await fetchPreviewVideo(externalVideoUrl)
                    : fail("MATRIX_MEDIA_INVALID", "The provider preview cache was invalid.")
            : await fetchMedia(mxc!, maximumBytes);
    if (preview?.directProvider && !directPreviewPolicyAllowed) {
        fail("MATRIX_MEDIA_MISSING", "This provider preview was disabled while it was loading.");
    }
    const bytes = encryptedFile ? await decryptMedia(downloaded.bytes, encryptedFile) : downloaded.bytes;
    const sniffed = sniffedMedia(bytes, attachment.mimeType, downloaded.mimeType);
    if (externalImageUrl && (
        preview?.directProvider === "klipy" ? sniffed.mimeType !== "image/gif"
            : preview?.directProvider === "x" ? !["image/jpeg", "image/png", "image/webp"].includes(sniffed.mimeType)
                : preview?.directProvider === "tenor" ? !["image/gif", "image/webp"].includes(sniffed.mimeType)
                    : true
    )) {
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The provider preview image had an invalid format.");
    }
    if (externalVideoUrl && sniffed.mimeType !== "video/mp4") {
        fail("MATRIX_MEDIA_DOWNLOAD_FAILED", "The provider preview video had an invalid format.");
    }
    const videoDimensions = sniffed.mimeType.startsWith("video/")
        && attachment.width != null && attachment.height != null
        ? { width: attachment.width, height: attachment.height }
        : undefined;
    return {
        name: safeDownloadedName(attachment.name, sniffed.mimeType),
        mimeType: sniffed.mimeType,
        bytes,
        width: sniffed.width ?? videoDimensions?.width,
        height: sniffed.height ?? videoDimensions?.height,
        animated: sniffed.animated
    };
}

function updateProviderPreviewPolicy(
    command: Extract<MatrixWorkerCommand, { type: "providerPreviewPolicy"; }>
): undefined {
    if (typeof command.allowDirectMedia !== "boolean") {
        fail("MATRIX_INVALID_ARGUMENT", "The provider-preview policy is invalid.");
    }
    directPreviewPolicyAllowed = command.allowDirectMedia;
    for (const [key, preview] of urlPreviewMedia) {
        if (preview.directProvider) urlPreviewMedia.delete(key);
    }
    if (!directPreviewPolicyAllowed) {
        for (const controller of activeDirectPreviewControllers) controller.abort();
    }
    return undefined;
}

async function handleCommand(
    command: MatrixWorkerCommand,
    progress: (stage: MatrixWorkerStartupStage) => void = () => undefined,
    mutationDispatched: () => void = () => undefined
): Promise<MatrixWorkerResult> {
    switch (command.type) {
        case "login": return await login(command);
        case "reauthenticate": return await reauthenticate(command);
        case "register": return await registerAccount(command);
        case "start": return await startAuthenticated(command.account, progress);
        case "suspend": await suspend(); return undefined;
        case "logout": await logout(); return undefined;
        case "snapshot": return snapshot();
        case "joinedRoomIds": return await exactJoinedRoomIds();
        case "publicRooms": return await publicRooms(command);
        case "joinRoom": return await joinRoom(command, mutationDispatched);
        case "joinRoomAddress": return await joinRoomAddress(command, mutationDispatched);
        case "acceptInvite": return await acceptInvite(command, mutationDispatched);
        case "rejectInvite": return await rejectInvite(command, mutationDispatched);
        case "leaveRoom": return await leaveRoom(command);
        case "createSpace": return await createSpace(command, mutationDispatched);
        case "getSpaceAccess": return await getSpaceAccess(command);
        case "configureSpaceAccess": return await configureSpaceAccess(command);
        case "requestSpaceAccess": return await requestSpaceAccess(command);
        case "getSpaceAccessRequests": return await getSpaceAccessRequests(command);
        case "resolveSpaceAccessRequest": return await resolveSpaceAccessRequest(command);
        case "searchSpaceInviteCandidates": return await searchSpaceInviteCandidates(command);
        case "inviteUserToSpace": return await inviteUserToSpace(command, mutationDispatched);
        case "searchGroupChatCandidates": return await searchGroupChatCandidates(command);
        case "searchGroupChatInviteCandidates": return await searchGroupChatInviteCandidates(command);
        case "inviteUserToGroupChat": return await inviteUserToGroupChat(command, mutationDispatched);
        case "reconcileGroupChatInvite": return await reconcileGroupChatInvite(command);
        case "createGroupChat": return await createGroupChat(command, mutationDispatched);
        case "reconcileGroupChatCreate": return await reconcileGroupChatCreate(command);
        case "createSpaceChild": return await createSpaceChild(command, mutationDispatched);
        case "reconcileSpaceChildCreate": return await reconcileSpaceChildCreate(command);
        case "repairSpaceChildLink": return await repairSpaceChildLink(command);
        case "spaceChildren": return await spaceChildren(command);
        case "suggestedSpaceChannelPlan": return await suggestedSpaceChannelPlan(command);
        case "joinSuggestedSpaceChannels": return await joinSuggestedSpaceChannels(command, mutationDispatched);
        case "openDirectMessage": return await openDirectMessage(command);
        case "providerPreviewPolicy": return updateProviderPreviewPolicy(command);
        case "downloadMedia": return await downloadMedia(command);
        case "urlPreview": return await urlPreview(command);
        case "sendText": return await sendText(command);
        case "sendSticker": return await sendSticker(command);
        case "sendAttachment": return await sendAttachment(command);
        case "edit": return await edit(command);
        case "cancelPending": await cancelPending(command); return undefined;
        case "redact": return await redact(command);
        case "react": return await react(command);
        case "typing": await typing(command); return undefined;
        case "read": await read(command); return undefined;
        case "paginate": return await paginate(command);
        case "messageContext": return await messageContext(command);
        case "searchMessages": return await searchMessages(command);
        default: return unsupportedCommand(command);
    }
}

const MAX_MUTATION_QUEUE = 64;
const MAX_METADATA_QUEUE = 32;
const MAX_MEDIA_QUEUE = 12;

interface LaneWaiter {
    generation: number;
    resolve(release: () => void): void;
    reject(error: Error): void;
}

class BoundedLane {
    private active = 0;
    private readonly waiters: LaneWaiter[] = [];
    private readonly idleWaiters = new Set<() => void>();

    constructor(private readonly capacity: number, private readonly maximumQueue: number) { }

    acquire(generation: number): Promise<() => void> {
        if (this.active < this.capacity) {
            this.active++;
            return Promise.resolve(this.releaseOnce());
        }
        if (this.waiters.length >= this.maximumQueue) {
            return Promise.reject(new PublicWorkerError(
                "MATRIX_BACKEND_BUSY",
                "The Matrix backend has too many pending read requests."
            ));
        }
        return new Promise((resolve, reject) => this.waiters.push({ generation, resolve, reject }));
    }

    rejectStale(generation: number): void {
        for (let index = this.waiters.length - 1; index >= 0; index--) {
            const waiter = this.waiters[index];
            if (waiter.generation === generation) continue;
            this.waiters.splice(index, 1);
            waiter.reject(sessionChangedError());
        }
    }

    whenIdle(): Promise<void> {
        if (this.active === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.add(resolve));
    }

    private releaseOnce(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release();
        };
    }

    private release(): void {
        while (this.waiters.length) {
            const waiter = this.waiters.shift()!;
            if (waiter.generation !== schedulerGeneration || lifecyclePending > 0) {
                waiter.reject(sessionChangedError());
                continue;
            }
            waiter.resolve(this.releaseOnce());
            return;
        }
        this.active--;
        if (this.active === 0) {
            for (const resolve of this.idleWaiters) resolve();
            this.idleWaiters.clear();
        }
    }
}

const metadataLane = new BoundedLane(3, MAX_METADATA_QUEUE);
const mediaLane = new BoundedLane(2, MAX_MEDIA_QUEUE);
let mutationTail: Promise<void> = Promise.resolve();
let mutationQueued = 0;
let lifecyclePending = 0;

function sessionChangedError(): PublicWorkerError {
    return new PublicWorkerError("MATRIX_SESSION_CHANGED", "The Matrix account changed while the request was pending.");
}

function lifecycleCommand(command: MatrixWorkerCommand): boolean {
    return command.type === "login" || command.type === "reauthenticate" || command.type === "register"
        || command.type === "start" || command.type === "suspend" || command.type === "logout";
}

function mutationSignalCommand(command: MatrixWorkerCommand): boolean {
    return command.type === "createSpace" || command.type === "createSpaceChild" || command.type === "createGroupChat"
        || command.type === "inviteUserToSpace" || command.type === "inviteUserToGroupChat" || command.type === "acceptInvite"
        || command.type === "rejectInvite" || command.type === "joinSuggestedSpaceChannels"
        || command.type === "joinRoom" || command.type === "joinRoomAddress";
}

function concurrentLane(command: MatrixWorkerCommand): BoundedLane | undefined {
    switch (command.type) {
        case "downloadMedia": return mediaLane;
        case "publicRooms":
        case "snapshot":
        case "joinedRoomIds":
        case "messageContext":
        case "searchMessages":
        case "searchSpaceInviteCandidates":
        case "searchGroupChatCandidates":
        case "searchGroupChatInviteCandidates":
        case "reconcileGroupChatInvite":
        case "urlPreview": return metadataLane;
        default: return undefined;
    }
}

function scrubCommand(command: MatrixWorkerCommand): void {
    switch (command.type) {
        case "sendAttachment":
            command.attachment.bytes.fill(0);
            break;
        case "login":
            command.storageKey = "";
            if (command.login.method === "password") command.login.password = "";
            else command.login.accessToken = "";
            break;
        case "reauthenticate":
            if (command.reauthentication.method === "password") command.reauthentication.password = "";
            else command.reauthentication.accessToken = "";
            break;
        case "register":
            command.storageKey = "";
            command.registration.password = "";
            command.registration.registrationToken = "";
            break;
        case "start":
            command.account.accessToken = "";
            if (command.account.refreshToken != null) command.account.refreshToken = "";
            command.account.storageKey = "";
            break;
    }
}

function scrubResult(result: MatrixWorkerResult): void {
    if (result && typeof result === "object" && "bytes" in result && result.bytes instanceof Uint8Array) {
        result.bytes.fill(0);
    }
    if (result && typeof result === "object" && "credentials" in result) {
        result.credentials.accessToken = "";
        if (result.credentials.refreshToken != null) result.credentials.refreshToken = "";
    }
}

function respondFailure(request: MatrixWorkerRequest, error: unknown): void {
    window.MatrixBridgeWorkerHost.respond({
        kind: "response",
        id: request.id,
        ok: false,
        error: publicError(error)
    });
}

async function executeConcurrent(request: MatrixWorkerRequest, lane: BoundedLane): Promise<void> {
    const generation = schedulerGeneration;
    const generationClient = matrixClient;
    const generationClientId = clientGeneration;
    let release: (() => void) | undefined;
    let result: MatrixWorkerResult;
    let hasResult = false;
    try {
        if (lifecyclePending > 0) throw sessionChangedError();
        release = await lane.acquire(generation);
        if (generation !== schedulerGeneration || lifecyclePending > 0) throw sessionChangedError();
        window.MatrixBridgeWorkerHost.respond({ kind: "started", id: request.id });
        result = await handleCommand(request.command);
        hasResult = true;
        if (generation !== schedulerGeneration || generationClient !== matrixClient
            || generationClientId !== clientGeneration) {
            scrubResult(result);
            throw sessionChangedError();
        }
        window.MatrixBridgeWorkerHost.respond({ kind: "response", id: request.id, ok: true, result });
    } catch (error) {
        respondFailure(
            request,
            generation !== schedulerGeneration || generationClient !== matrixClient
                || generationClientId !== clientGeneration
                ? sessionChangedError()
                : error
        );
    } finally {
        if (hasResult) scrubResult(result!);
        release?.();
    }
}

function executeOrdered(request: MatrixWorkerRequest, lifecycle: boolean): void {
    if (!lifecycle && lifecyclePending > 0) {
        scrubCommand(request.command);
        respondFailure(request, sessionChangedError());
        return;
    }
    if (!lifecycle && mutationQueued >= MAX_MUTATION_QUEUE) {
        scrubCommand(request.command);
        respondFailure(request, new PublicWorkerError(
            "MATRIX_BACKEND_BUSY",
            "The Matrix backend has too many pending actions."
        ));
        return;
    }

    const generation = schedulerGeneration;
    mutationQueued++;
    mutationTail = mutationTail.then(async () => {
        mutationQueued--;
        try {
            if (generation !== schedulerGeneration) throw sessionChangedError();
            if (lifecycle) {
                await Promise.all([metadataLane.whenIdle(), mediaLane.whenIdle()]);
                if (generation !== schedulerGeneration) throw sessionChangedError();
            }
            window.MatrixBridgeWorkerHost.respond({ kind: "started", id: request.id });
            let mutationReported = false;
            const result = await handleCommand(request.command, stage => {
                window.MatrixBridgeWorkerHost.respond({ kind: "progress", id: request.id, stage });
            }, () => {
                if (!mutationSignalCommand(request.command) || mutationReported) {
                    throw new PublicWorkerError("MATRIX_PROTOCOL_ERROR", "The Matrix mutation boundary was invalid.");
                }
                mutationReported = true;
                window.MatrixBridgeWorkerHost.respond({ kind: "mutation", id: request.id });
            });
            // An ordered mutation which already started is allowed to finish
            // before the lifecycle command queued behind it. Rejecting its
            // acknowledged side effect here could make a renderer retry it.
            try {
                window.MatrixBridgeWorkerHost.respond({ kind: "response", id: request.id, ok: true, result });
            } finally {
                scrubResult(result);
            }
        } catch (error) {
            respondFailure(request, error);
        } finally {
            scrubCommand(request.command);
            if (lifecycle) lifecyclePending--;
        }
    });
}

function execute(request: MatrixWorkerRequest): void {
    if (request.command.type === "providerPreviewPolicy") {
        window.MatrixBridgeWorkerHost.respond({ kind: "started", id: request.id });
        try {
            const result = updateProviderPreviewPolicy(request.command);
            window.MatrixBridgeWorkerHost.respond({ kind: "response", id: request.id, ok: true, result });
        } catch (error) {
            respondFailure(request, error);
        }
        return;
    }
    const lifecycle = lifecycleCommand(request.command);
    if (lifecycle) {
        schedulerGeneration++;
        lifecyclePending++;
        for (const controller of activeMediaReadControllers) controller.abort();
        metadataLane.rejectStale(schedulerGeneration);
        mediaLane.rejectStale(schedulerGeneration);
        executeOrdered(request, true);
        return;
    }

    const lane = concurrentLane(request.command);
    if (lane) {
        void executeConcurrent(request, lane);
        return;
    }
    executeOrdered(request, false);
}

window.MatrixBridgeWorkerHost.onCommand(execute);
window.MatrixBridgeWorkerHost.ready();
