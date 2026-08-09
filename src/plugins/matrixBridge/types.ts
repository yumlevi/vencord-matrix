/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type MatrixBridgeState = "logged_out" | "stopped" | "starting" | "syncing" | "ready" | "error";

export interface MatrixBridgeError {
    code: string;
    message: string;
}

export interface MatrixAccountDTO {
    userId: string;
}

export interface MatrixBridgeStatus {
    seq: number;
    state: MatrixBridgeState;
    account?: MatrixAccountDTO;
    error?: MatrixBridgeError;
}

export interface MatrixBridgeConfig {
    configured: boolean;
    homeserver?: string;
    userId?: string;
    deviceId?: string;
    persistentE2EE: true;
}

export type MatrixLoginRequest =
    | { homeserver: string; method: "password"; username: string; password: string; }
    | { homeserver: string; method: "access_token"; accessToken: string; };

/**
 * Replaces an expired soft-logout session while retaining the exact Matrix
 * device and its local encryption store. The identity fields are an explicit
 * stale-UI guard and must match the native account record exactly.
 */
export type MatrixReauthenticationRequest =
    | {
        homeserver: string;
        userId: string;
        deviceId: string;
        method: "password";
        password: string;
    }
    | {
        homeserver: string;
        userId: string;
        deviceId: string;
        method: "access_token";
        accessToken: string;
    };

export interface MatrixRegistrationRequest {
    homeserver: string;
    username: string;
    password: string;
    registrationToken: string;
}

export interface MatrixMemberDTO {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    membership: string;
    powerLevel?: number;
}

export interface MatrixAttachmentDTO {
    name: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    animated?: boolean;
    downloadable?: boolean;
    encrypted?: boolean;
    url?: string;
    thumbnailUrl?: string;
}

/** Binary media returned only by an explicit download request, never in snapshots/events. */
export interface MatrixMediaDownloadResult {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    width?: number;
    height?: number;
    animated?: boolean;
}

/** Opaque preview media handle. Its source URL never crosses into Discord's renderer. */
export interface MatrixUrlPreviewMediaDTO extends MatrixAttachmentDTO {
    downloadable: true;
    downloadIndex: 0 | 1;
}

/** Sanitized homeserver preview data returned on demand, never in a room snapshot. */
export interface MatrixUrlPreviewDTO {
    /** Normalized URL submitted to the homeserver preview endpoint. */
    url: string;
    title?: string;
    description?: string;
    provider?: { name: string; };
    image?: MatrixUrlPreviewMediaDTO;
    video?: MatrixUrlPreviewMediaDTO;
}

export interface MatrixReactionDTO {
    key: string;
    count: number;
    me: boolean;
    /** The current user's reaction event, when one exists. */
    eventId?: string;
}

/**
 * Client-defined grouping for a bounded set of attachment events. Matrix has
 * no standard multi-media message event, so each file remains independently
 * interoperable while clients which understand this marker may coalesce it.
 */
export interface MatrixAttachmentGroupDTO {
    id: string;
    index: number;
    total: number;
}

export interface MatrixMessageDTO {
    eventId: string;
    roomId: string;
    senderId: string;
    senderName?: string;
    timestamp: number;
    body: string;
    /** True when the original Matrix event type is m.sticker. */
    sticker?: true;
    formattedBody?: string;
    edited?: boolean;
    replyToEventId?: string;
    attachments?: MatrixAttachmentDTO[];
    attachmentGroup?: MatrixAttachmentGroupDTO;
    reactions?: MatrixReactionDTO[];
    decryptionFailure?: boolean;
    pending?: boolean;
    failed?: boolean;
    /** Stable local/remote echo identity when Matrix supplies one. */
    transactionId?: string;
}

export type MatrixRoomMembership = "join" | "invite";
export type MatrixKnownRoomMembership = MatrixRoomMembership | "leave";
export type MatrixRoomKind = "space" | "room" | "dm";
export type MatrixRoomJoinRule = "public" | "invite" | "knock" | "restricted" | "knock_restricted" | "private";

export interface MatrixSpaceChildDTO {
    roomId: string;
    order?: string;
    suggested?: boolean;
}

export interface MatrixRoomDTO {
    roomId: string;
    /** Monotonic for this SDK Room object; changes when its live timeline is reset. */
    timelineGeneration: number;
    name: string;
    membership: MatrixRoomMembership;
    kind: MatrixRoomKind;
    /** Matrix room type, including m.space for spaces. */
    roomType?: string;
    /** Whether the current account may add m.space.child state in this Space. */
    canManageSpaceChildren?: boolean;
    joinRule: MatrixRoomJoinRule;
    /** The other user for rooms listed in the account's m.direct map. */
    directUserId?: string;
    /** The inviter for an invite, when it can be determined from stripped state. */
    inviterId?: string;
    /** Valid m.space.parent state links. */
    parentIds: string[];
    /** Room IDs from valid m.space.child state, in state order. */
    childIds: string[];
    /** Ordered m.space.child relations, preserving order/suggested metadata. */
    spaceChildren: MatrixSpaceChildDTO[];
    avatarUrl?: string;
    topic?: string;
    encrypted: boolean;
    members: MatrixMemberDTO[];
    /**
     * A bounded, possibly empty timeline window. Merge it into retained
     * messages while timelineGeneration is unchanged; a generation change is
     * the authoritative reset boundary.
     */
    messages: MatrixMessageDTO[];
    prevToken?: string;
    unreadCount?: number;
    highlightCount?: number;
}

export interface MatrixPublicRoomDTO {
    roomId: string;
    name: string;
    alias?: string;
    topic?: string;
    avatarUrl?: string;
    joinedMembers: number;
    worldReadable: boolean;
    guestCanJoin: boolean;
    joinRule?: "public" | "knock";
    roomType?: string;
}

export interface MatrixPublicRoomDirectoryDTO {
    rooms: MatrixPublicRoomDTO[];
    /** Homeserver-provided estimate; it can include unsupported custom room types. */
    totalRoomCountEstimate?: number;
    /** True when the bounded client-side crawl stopped while another page or entry remained. */
    truncated: boolean;
}

export interface MatrixJoinRoomResult {
    roomId: string;
}

export interface MatrixRoomActionResult {
    roomId: string;
}

export type MatrixSpaceVisibility = "private" | "public";

/** User-controlled metadata for creating a Matrix Space. */
export interface MatrixCreateSpaceRequest {
    name: string;
    topic?: string;
    /** Defaults to private when omitted. */
    visibility?: MatrixSpaceVisibility;
    /** Create and link a usable #general chat. Defaults to true. */
    createGeneral?: boolean;
}

export type MatrixCreateSpacePartialCode =
    | "MATRIX_GENERAL_ROOM_CREATE_FAILED"
    | "MATRIX_GENERAL_ROOM_LINK_FAILED";

export interface MatrixCreateSpacePartialResult {
    code: MatrixCreateSpacePartialCode;
    message: string;
}

export interface MatrixCreateSpaceResult extends MatrixRoomActionResult {
    /** Present when the initial #general room was created. */
    generalRoomId?: string;
    /** A recoverable child-room/link warning; the Space itself still exists. */
    partial?: MatrixCreateSpacePartialResult;
}

export type MatrixSpaceChildKind = "room" | "space";

/** Create a chat or nested category inside an existing joined Space. */
export interface MatrixCreateSpaceChildRequest {
    parentSpaceId: string;
    kind: MatrixSpaceChildKind;
    name: string;
    topic?: string;
}

export interface MatrixCreateSpaceChildResult extends MatrixRoomActionResult {
    /** Derived from the parent Space by the backend; callers cannot override it. */
    visibility: MatrixSpaceVisibility;
    /** The child exists, but the parent-side m.space.child state write failed. */
    partial?: {
        code: "MATRIX_SPACE_CHILD_LINK_FAILED";
        message: string;
    };
}

export type MatrixReconcileSpaceChildCreateResult =
    | { resolved: false; }
    | { resolved: true; roomId: string; };

export interface MatrixDirectMessageResult extends MatrixRoomActionResult {
    created: boolean;
}

export interface MatrixSpaceHierarchyRoomDTO {
    roomId: string;
    name: string;
    kind: MatrixRoomKind;
    roomType?: string;
    membership?: MatrixKnownRoomMembership;
    joinRule?: MatrixRoomJoinRule;
    parentIds: string[];
    childIds: string[];
    spaceChildren: MatrixSpaceChildDTO[];
    avatarUrl?: string;
    topic?: string;
}

export interface MatrixSpaceHierarchyDTO {
    spaceId: string;
    rooms: MatrixSpaceHierarchyRoomDTO[];
}

export type MatrixDiscordStickerFormatType = 1 | 2 | 3 | 4;

/** Public Discord sticker descriptor accepted by the native Matrix boundary. */
export interface MatrixStickerSendRequest {
    id: string;
    name: string;
    formatType: MatrixDiscordStickerFormatType;
    replyEventId?: string;
}

export interface MatrixStickerSendResult {
    eventId: string;
}

/** Bounded file payload copied from Discord's local composer into the native boundary. */
export interface MatrixAttachmentSendRequest {
    name: string;
    txnId: string;
    declaredMimeType?: string;
    bytes: Uint8Array<ArrayBuffer>;
    caption?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    replyEventId?: string;
    attachmentGroup?: MatrixAttachmentGroupDTO;
}

export interface MatrixAttachmentSendResult {
    eventId: string;
}

export type MatrixMessageSearchScope =
    | { kind: "room"; roomId: string; }
    | { kind: "space"; spaceId: string; }
    | { kind: "all"; };

export interface MatrixMessageSearchRequest {
    query: string;
    scope: MatrixMessageSearchScope;
    limit?: number;
    cursor?: string;
}

export type MatrixMessageSearchCoverage = "server" | "local" | "mixed";
export type MatrixMessageSearchSource = "server" | "local";

export interface MatrixMessageSearchResultDTO {
    roomId: string;
    roomName: string;
    message: MatrixMessageDTO;
    /** Context is chronological and excludes the matching message. */
    before: MatrixMessageDTO[];
    after: MatrixMessageDTO[];
    source: MatrixMessageSearchSource;
    /** Server-search context is not guaranteed contiguous with the live timeline. */
    isolated?: true;
    rank?: number;
}

export interface MatrixMessageSearchResponse {
    results: MatrixMessageSearchResultDTO[];
    cursor?: string;
    coverage: MatrixMessageSearchCoverage;
    searchedRoomCount: number;
    /** More matches may exist, or encrypted/local history coverage is incomplete. */
    limited: boolean;
}

export interface MatrixHistoryPageDTO {
    roomId: string;
    /** Exact room timeline generation represented by this page. */
    timelineGeneration: number;
    /** Newly fetched messages, in chronological order. */
    messages: MatrixMessageDTO[];
    /** Worker-opaque cursor for the next older page. */
    beforeCursor?: string;
    end: boolean;
    /** True when messages were returned or the homeserver cursor advanced. */
    progressed: boolean;
}

/** Bounded, isolated context for an explicitly referenced Matrix event. */
export interface MatrixMessageContextDTO {
    roomId: string;
    message: MatrixMessageDTO;
    before: MatrixMessageDTO[];
    after: MatrixMessageDTO[];
    isolated: true;
}

export interface MatrixSnapshot {
    seq: number;
    /** Monotonic worker-side state cut represented by this snapshot. */
    revision: number;
    status: MatrixBridgeStatus;
    account?: MatrixAccountDTO;
    rooms: MatrixRoomDTO[];
}

export type MatrixBridgeEvent =
    | { seq: number; type: "snapshot"; snapshot: MatrixSnapshot; }
    | { seq: number; type: "room"; room: MatrixRoomDTO; }
    | { seq: number; type: "message"; roomId: string; message: MatrixMessageDTO; }
    | { seq: number; type: "edit"; roomId: string; eventId: string; message?: MatrixMessageDTO; }
    | { seq: number; type: "redact"; roomId: string; eventId: string; }
    | { seq: number; type: "reaction"; roomId: string; eventId: string; reactions: MatrixReactionDTO[]; }
    | { seq: number; type: "typing"; roomId: string; userIds: string[]; }
    | { seq: number; type: "receipt"; roomId: string; userId: string; eventId?: string; }
    | { seq: number; type: "status"; status: MatrixBridgeStatus; };

export interface MatrixActionResult {
    eventId?: string;
}
