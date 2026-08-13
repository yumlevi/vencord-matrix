/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type MatrixBridgeState = "logged_out" | "stopped" | "starting" | "syncing" | "ready" | "error";

export interface MatrixBridgeError {
    code: string;
    message: string;
    /** Sanitized code-only provenance for a wrapped startup-stage failure. */
    causeCode?: string;
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
    /** A tokenless exact-device binding is retained for safe same-account login. */
    preservedDevice?: boolean;
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
    /** Canonical Matrix identities intentionally mentioned by this event. */
    mentionedUserIds?: string[];
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

/** A fail-closed, room-version-aware Matrix power-level comparison. */
export interface MatrixPowerLevelPermissionDTO {
    /** The current account's effective level, including Hydra creator authority. */
    current: number | "infinite" | "unverifiable";
    /** The event threshold, or unverifiable when present Matrix state is malformed. */
    required: number | "unverifiable";
    allowed: boolean;
}

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
    /** Creator-signed bridge group identity; it always outranks mutable m.direct and Space relations. */
    groupChat?: true;
    /** Whether the current account may add m.space.child state in this Space. */
    canManageSpaceChildren?: boolean;
    /** Exact power-level comparison underlying canManageSpaceChildren. */
    spaceChildPermission?: MatrixPowerLevelPermissionDTO;
    /** Exact power-level comparison for inviting a member to this joined Space or tagged group. */
    invitePermission?: MatrixPowerLevelPermissionDTO;
    /** Whether the current account may change every state event used by Space access settings. */
    canConfigureSpaceAccess?: boolean;
    /** Bounded number of pending membership knocks for a joined Space. */
    accessRequestCount?: number;
    /** Whether accessRequestCount was computed from the Space's fully-loaded member list. */
    accessRequestCountComplete?: boolean;
    /** Whether the current account meets this Space's exact invite threshold. */
    canApproveAccessRequests?: boolean;
    /** Whether the current account meets this Space's exact kick threshold. */
    canDenyAccessRequests?: boolean;
    joinRule: MatrixRoomJoinRule;
    /** Sender of the immutable m.room.create event (the creator in every room version). */
    creatorId?: string;
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
    warning?: {
        code: "MATRIX_DM_CLASSIFICATION_FAILED";
        message: string;
    };
}

export type MatrixSpaceVisibility = "private" | "public";

export type MatrixSpaceAccessMode = "public" | "request" | "invite";
export type MatrixSpaceHistoryVisibility = "invited" | "joined" | "shared" | "world_readable";
export type MatrixSpaceGuestAccess = "can_join" | "forbidden";

/** Actual interoperable Matrix state which governs discovery and Space admission. */
export interface MatrixSpaceAccessSummaryDTO {
    spaceId: string;
    /** Discord-facing mode derived from the actual Matrix join rule. */
    mode: MatrixSpaceAccessMode;
    joinRule: MatrixRoomJoinRule;
    /** Actual homeserver directory state; never inferred from mode. */
    directoryVisibility: MatrixSpaceVisibility;
    historyVisibility: MatrixSpaceHistoryVisibility;
    guestAccess: MatrixSpaceGuestAccess;
    /** Safe same-server alias localpart, when one is configured canonically. */
    joinName?: string;
    /** Exact same-server Matrix alias corresponding to joinName. */
    joinAlias?: string;
}

export interface MatrixConfigureSpaceAccessRequest {
    spaceId: string;
    mode: MatrixSpaceAccessMode;
    /** Lowercase same-server alias localpart. Required when no safe alias exists. */
    joinName?: string;
}

export type MatrixConfigureSpaceAccessStep =
    | "alias"
    | "alias_rollback"
    | "canonical_alias"
    | "history_visibility"
    | "guest_access"
    | "join_rule"
    | "directory"
    | "verification";

export interface MatrixConfigureSpaceAccessResult {
    spaceId: string;
    requestedMode: MatrixSpaceAccessMode;
    /** Exact state when accessConfirmed is true; otherwise the safest last-known state. */
    access: MatrixSpaceAccessSummaryDTO;
    /** True only when every access field was re-read from the homeserver after the mutation. */
    accessConfirmed: boolean;
    complete: boolean;
    partial?: {
        code: "MATRIX_SPACE_ACCESS_PARTIAL";
        failedStep: MatrixConfigureSpaceAccessStep;
        message: string;
    };
}

export interface MatrixRequestSpaceAccessResult {
    roomId: string;
    membership: "knock" | "invite" | "join";
}

export interface MatrixSpaceAccessRequestMemberDTO {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    /** Homeserver event timestamp, when it is a safe non-negative integer. */
    requestedAt?: number;
    canApprove: boolean;
    canDeny: boolean;
}

export interface MatrixSpaceAccessRequestListDTO {
    spaceId: string;
    requests: MatrixSpaceAccessRequestMemberDTO[];
    truncated: boolean;
    canApproveAccessRequests: boolean;
    canDenyAccessRequests: boolean;
}

export type MatrixSpaceAccessDecision = "approve" | "deny";

export interface MatrixResolveSpaceAccessRequest {
    spaceId: string;
    userId: string;
    decision: MatrixSpaceAccessDecision;
}

export interface MatrixResolveSpaceAccessRequestResult extends MatrixResolveSpaceAccessRequest {
    membership: "invite" | "join" | "leave";
    accessRequestCount: number;
}

export type MatrixSpaceInviteCandidateMembership = "none" | "leave" | "knock" | "invite" | "join";

/** A bounded query against the standard Matrix user-directory search endpoint. */
export interface MatrixSpaceInviteCandidateSearchRequest {
    spaceId: string;
    /** Empty is a best-effort initial directory query; servers need not support it. */
    query: string;
    /** Defaults to 25 and is capped at 100. */
    limit?: number;
}

export interface MatrixSpaceInviteCandidateDTO {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    membership: MatrixSpaceInviteCandidateMembership;
}

export interface MatrixSpaceInviteCandidateSearchResult {
    spaceId: string;
    query: string;
    /** Results are a local-server filter over the homeserver's standard user directory. */
    scope: "homeserver_user_directory";
    candidates: MatrixSpaceInviteCandidateDTO[];
    /** True when either the homeserver or the local response bound truncated results. */
    limited: boolean;
    /** The homeserver's own `limited` value. There is no cursor in this API. */
    directoryLimited: boolean;
    /** Always false: Matrix user-directory search never proves account completeness. */
    complete: false;
    /** Empty search was rejected; issue a non-empty query before searching again. */
    queryRequired: boolean;
}

/** A bounded query against the active homeserver's user directory for a new group chat. */
export interface MatrixGroupChatCandidateSearchRequest {
    /** Empty is a best-effort initial directory query; servers need not support it. */
    query: string;
    /** Defaults to 25 and is capped at 100. */
    limit?: number;
    /** Explicit-submit exact local MXID/bare-localpart profile lookup; locally rate limited. */
    exact?: boolean;
}

export interface MatrixGroupChatCandidateDTO {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
}

export interface MatrixGroupChatCandidateSearchResult {
    query: string;
    /** Exact-profile scope is used only for an explicit, same-provider lookup. */
    scope: "homeserver_user_directory" | "homeserver_user_directory_plus_exact_local_profile";
    candidates: MatrixGroupChatCandidateDTO[];
    /** True when either the homeserver or the local response bound truncated results. */
    limited: boolean;
    /** The homeserver's own `limited` value. There is no cursor in this API. */
    directoryLimited: boolean;
    /** Always false: Matrix user-directory search never proves account completeness. */
    complete: false;
    /** Empty search was rejected; issue a non-empty query before searching again. */
    queryRequired: boolean;
    /** Exact lookup never distinguishes a missing account from unavailable/private profile lookup. */
    exactLookup: "not_requested" | "resolved" | "not_found_or_unavailable";
}

/** Create an ordinary encrypted room projected as a Discord group DM. */
export interface MatrixCreateGroupChatRequest {
    name: string;
    /** Zero to nine unique same-provider users; the creator is the tenth possible member. */
    userIds: string[];
}

export type MatrixGroupChatInvitationStatus = "invited" | "joined" | "rejected" | "ambiguous";

export interface MatrixGroupChatInvitationDTO {
    userId: string;
    status: MatrixGroupChatInvitationStatus;
}

export interface MatrixCreateGroupChatResult extends MatrixRoomActionResult {
    name: string;
    invitations: MatrixGroupChatInvitationDTO[];
    /** True only when every selected user is authoritatively invited or joined. */
    complete: boolean;
}

export type MatrixReconcileGroupChatCreateResult =
    | { status: "none"; }
    | { status: "pending"; }
    | { status: "resolved"; result: MatrixCreateGroupChatResult; };

export type MatrixGroupChatCandidateMembership = "none" | "leave" | "knock" | "invite" | "join" | "ban";

export interface MatrixGroupChatInviteCandidateSearchRequest extends MatrixGroupChatCandidateSearchRequest {
    roomId: string;
}

export interface MatrixGroupChatInviteCandidateDTO extends MatrixGroupChatCandidateDTO {
    membership: MatrixGroupChatCandidateMembership;
}

export interface MatrixGroupChatInviteCandidateSearchResult
    extends Omit<MatrixGroupChatCandidateSearchResult, "candidates"> {
    roomId: string;
    candidates: MatrixGroupChatInviteCandidateDTO[];
    /** Authoritative current join+invite count, including the active account. */
    participantCount: number;
    maxParticipants: 10;
    full: boolean;
}

export interface MatrixInviteUserToGroupChatRequest {
    roomId: string;
    userId: string;
}

export interface MatrixInviteUserToGroupChatResult extends MatrixInviteUserToGroupChatRequest {
    /** Whether this call was accepted or authoritative preflight found an existing membership. */
    delivery: "accepted" | "existing";
    /** Exact membership when observed; it may be absent after an accepted invite was immediately declined. */
    observedMembership?: "invite" | "join";
    /** False only with delivery=existing and an observed existing invite/join. */
    changed: boolean;
}

export type MatrixReconcileGroupChatInviteResult =
    | { status: "none"; }
    | { status: "pending"; roomId: string; userId: string; }
    | { status: "resolved"; result: MatrixInviteUserToGroupChatResult; };

export interface MatrixInviteUserToSpaceRequest {
    spaceId: string;
    userId: string;
}

export interface MatrixInviteUserToSpaceResult extends MatrixInviteUserToSpaceRequest {
    membership: "invite" | "join";
    /** False only when the target was already invited or joined at authoritative preflight. */
    changed: boolean;
}

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
    | "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS"
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

export interface MatrixSuggestedSpaceChannelDTO {
    roomId: string;
    parentSpaceId: string;
    name: string;
    kind: "space" | "room";
    depth: 1 | 2;
    membership: "join" | "leave";
    joinRule: MatrixRoomJoinRule;
    avatarUrl?: string;
    topic?: string;
}

/**
 * A deliberately incomplete, fixed-depth onboarding plan. It contains only
 * direct suggested rooms or suggested rooms one suggested category below the
 * joined root Space, routed through the active account's Matrix server.
 */
export interface MatrixSuggestedSpaceChannelPlanDTO {
    spaceId: string;
    planId: string;
    scope: "suggested_depth_2_via_account_server";
    channels: MatrixSuggestedSpaceChannelDTO[];
    limited: boolean;
    complete: false;
}

export interface MatrixJoinSuggestedSpaceChannelsRequest {
    spaceId: string;
    planId: string;
}

export interface MatrixSuggestedSpaceChannelJoinOutcomeDTO {
    roomId: string;
    parentSpaceId: string;
    kind: "space" | "room";
    status: "joined" | "already_joined" | "rejected" | "blocked_by_parent";
}

export interface MatrixJoinSuggestedSpaceChannelsResult {
    spaceId: string;
    planId: string;
    outcomes: MatrixSuggestedSpaceChannelJoinOutcomeDTO[];
    limited: boolean;
    complete: false;
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

export interface MatrixSnapshotCoverage {
    /** Every currently visible worker room is present in `rooms`. */
    roomsComplete: boolean;
    /** Every emitted room DTO field, including its bounded member list, is represented. */
    roomStateComplete: boolean;
    /** Every worker timeline event is present. False for ordinary bounded snapshots. */
    timelinesComplete: boolean;
}

export interface MatrixSnapshot {
    /** Native resume watermark; it may be older than `revision` for bounded content. */
    seq: number;
    /** Exact monotonic worker-side content cut observed while building this snapshot. */
    revision: number;
    coverage: MatrixSnapshotCoverage;
    status: MatrixBridgeStatus;
    account?: MatrixAccountDTO;
    rooms: MatrixRoomDTO[];
}

export type MatrixBridgeEvent =
    | { seq: number; type: "snapshot"; snapshot: MatrixSnapshot; }
    | { seq: number; type: "room"; room: MatrixRoomDTO; }
    | {
        seq: number;
        type: "message";
        roomId: string;
        message: MatrixMessageDTO;
        previousEventId?: string;
        nextEventId?: string;
    }
    | { seq: number; type: "edit"; roomId: string; eventId: string; message?: MatrixMessageDTO; }
    | { seq: number; type: "redact"; roomId: string; eventId: string; }
    | { seq: number; type: "reaction"; roomId: string; eventId: string; reactions: MatrixReactionDTO[]; }
    | { seq: number; type: "typing"; roomId: string; userIds: string[]; }
    | { seq: number; type: "receipt"; roomId: string; userId: string; eventId?: string; }
    | { seq: number; type: "status"; status: MatrixBridgeStatus; };

export interface MatrixActionResult {
    eventId?: string;
}
