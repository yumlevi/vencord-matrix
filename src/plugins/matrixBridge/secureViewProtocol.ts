/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    MatrixAccountDTO,
    MatrixActionResult,
    MatrixAttachmentSendRequest,
    MatrixAttachmentSendResult,
    MatrixBridgeEvent,
    MatrixBridgeStatus,
    MatrixConfigureSpaceAccessRequest,
    MatrixConfigureSpaceAccessResult,
    MatrixCreateSpaceChildRequest,
    MatrixCreateSpaceChildResult,
    MatrixCreateSpaceRequest,
    MatrixCreateSpaceResult,
    MatrixDirectMessageResult,
    MatrixHistoryPageDTO,
    MatrixJoinRoomResult,
    MatrixJoinSuggestedSpaceChannelsRequest,
    MatrixJoinSuggestedSpaceChannelsResult,
    MatrixLoginRequest,
    MatrixMediaDownloadResult,
    MatrixMessageContextDTO,
    MatrixMessageSearchRequest,
    MatrixMessageSearchResponse,
    MatrixPublicRoomDirectoryDTO,
    MatrixReconcileSpaceChildCreateResult,
    MatrixRegistrationRequest,
    MatrixRequestSpaceAccessResult,
    MatrixResolveSpaceAccessRequest,
    MatrixResolveSpaceAccessRequestResult,
    MatrixRoomActionResult,
    MatrixRoomJoinRule,
    MatrixRoomKind,
    MatrixRoomMembership,
    MatrixSnapshot,
    MatrixSpaceAccessRequestListDTO,
    MatrixSpaceAccessSummaryDTO,
    MatrixSpaceChildDTO,
    MatrixSpaceHierarchyDTO,
    MatrixStickerSendRequest,
    MatrixStickerSendResult,
    MatrixSuggestedSpaceChannelPlanDTO,
    MatrixUrlPreviewDTO
} from "./types";

// The suffix keeps these channels out of generic, human-readable IPC
// namespaces. It is not a security boundary: native.ts authenticates the
// exact WebContents, top frame, origin, and per-view generation token.
const SECURE_CHANNEL_NAMESPACE = "VencordMatrixSecureView:524d90cbe14047c6a7a4bf20b75c1228";

export const MATRIX_SECURE_VIEW_EVENT = `${SECURE_CHANNEL_NAMESPACE}:event`;
export const MATRIX_SECURE_VIEW_BOOTSTRAP = `${SECURE_CHANNEL_NAMESPACE}:bootstrap`;
export const MATRIX_SECURE_VIEW_READY = `${SECURE_CHANNEL_NAMESPACE}:ready`;
export const MATRIX_SECURE_VIEW_REQUEST = `${SECURE_CHANNEL_NAMESPACE}:request`;

/** A route contains opaque Matrix identifiers but never decrypted content. */
export type MatrixSecureViewRoute =
    | { kind: "home"; }
    | { kind: "settings"; }
    | { kind: "room" | "space" | "dm"; roomId: string; };

export interface MatrixSecureViewBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MatrixSecureViewShellCommand {
    type: "openSearch";
}

/** Metadata Discord may use for navigation. Decrypted timeline content is absent. */
export interface MatrixShellRoom {
    roomId: string;
    timelineGeneration: number;
    name: string;
    membership: MatrixRoomMembership;
    kind: MatrixRoomKind;
    roomType?: string;
    canConfigureSpaceAccess?: boolean;
    accessRequestCount?: number;
    accessRequestCountComplete?: boolean;
    canApproveAccessRequests?: boolean;
    canDenyAccessRequests?: boolean;
    joinRule: MatrixRoomJoinRule;
    parentIds: string[];
    childIds: string[];
    spaceChildren: MatrixSpaceChildDTO[];
    encrypted: boolean;
    unreadCount?: number;
    highlightCount?: number;
}

export interface MatrixShellSnapshot {
    seq: number;
    revision: number;
    status: MatrixBridgeStatus;
    account?: MatrixAccountDTO;
    rooms: MatrixShellRoom[];
}

export type MatrixShellEvent =
    | { seq: number; type: "snapshot"; snapshot: MatrixShellSnapshot; }
    | { seq: number; type: "room"; room: MatrixShellRoom; }
    | { seq: number; type: "roomChanged"; roomId: string; }
    | { seq: number; type: "navigate"; route: MatrixSecureViewRoute; }
    | { seq: number; type: "status"; status: MatrixBridgeStatus; };

export interface MatrixSecureViewControlState {
    created: boolean;
    ready: boolean;
    visible: boolean;
    diagnostic?: MatrixSecureViewDiagnostic;
}

/** Content-free native readiness telemetry for the isolated view. */
export interface MatrixSecureViewDiagnostic {
    ownerContentSize: { width: number; height: number; };
    requestedBounds: MatrixSecureViewBounds;
    expectedBounds: MatrixSecureViewBounds;
    actualBounds: MatrixSecureViewBounds;
    actualViewVisible: boolean;
    attachedToOwner: boolean;
    topmostInOwner: boolean;
    actualBoundsNonEmpty: boolean;
    actualBoundsMatchExpected: boolean;
    actualBoundsWithinOwner: boolean;
    webContentsLoading: boolean;
    didStartNavigationCount: number;
    willNavigateSeenCount: number;
    willNavigateAllowedCount: number;
    willNavigateBlockedCount: number;
    protocolRequestSeenCount: number;
    protocolDocumentServedCount: number;
    didStartLoadingCount: number;
    loadUrlResolved: boolean;
    loadUrlRejected: boolean;
    preloadBootstrapRequested: boolean;
    preloadBootstrapGranted: boolean;
    preloadError: boolean;
    domReady: boolean;
    mainFrameLoaded: boolean;
    urlCommitted: boolean;
    readySignalReceived: boolean;
    readySignalRejected: boolean;
    documentInteractive?: boolean;
    documentComplete?: boolean;
    hostExposed?: boolean;
    rootPresent?: boolean;
    scriptRan?: boolean;
    secureUiLoading?: boolean;
    secureUiFatal?: boolean;
    secureUiAuth?: boolean;
    secureUiMain?: boolean;
    probeFailed?: boolean;
}

export interface MatrixSecureViewShowRequest {
    route: MatrixSecureViewRoute;
    bounds: MatrixSecureViewBounds;
}

export interface MatrixSecureViewSaveResult {
    saved: boolean;
}

/** Account metadata safe to show in the isolated account UI. Tokens are excluded. */
export interface MatrixSecureViewAccountConfig {
    configured: boolean;
    homeserver?: string;
    userId?: string;
    persistentE2EE: true;
}

export interface MatrixSecureViewSecurityState {
    /** Must always be true for a real native secure-view host. */
    isolated: true;
    transport: "private-ipc";
    backendConnected: boolean;
    persistentE2EE: true;
}

export interface MatrixSecureViewBootstrap {
    snapshot: MatrixSnapshot;
    status: MatrixBridgeStatus;
    config: MatrixSecureViewAccountConfig;
    route: MatrixSecureViewRoute;
    security: MatrixSecureViewSecurityState;
}

export type MatrixSecureViewEvent =
    | { type: "bootstrap"; bootstrap: MatrixSecureViewBootstrap; }
    | { type: "matrix"; event: MatrixBridgeEvent; }
    | { type: "route"; route: MatrixSecureViewRoute; }
    | { type: "visibility"; visible: boolean; }
    | { type: "shellCommand"; command: MatrixSecureViewShellCommand; }
    | { type: "security"; security: MatrixSecureViewSecurityState; }
    | { type: "fatal"; message: string; };

export interface MatrixSecureViewRequestMap {
    bootstrap: { input: {}; output: MatrixSecureViewBootstrap; };
    navigate: { input: { route: MatrixSecureViewRoute; }; output: void; };
    refresh: { input: {}; output: MatrixSnapshot; };
    login: { input: { login: MatrixLoginRequest; }; output: MatrixSnapshot; };
    register: { input: { registration: MatrixRegistrationRequest; }; output: MatrixSnapshot; };
    logout: { input: {}; output: void; };

    publicRooms: { input: {}; output: MatrixPublicRoomDirectoryDTO; };
    joinRoom: { input: { roomId: string; }; output: MatrixJoinRoomResult; };
    joinRoomAddress: { input: { address: string; }; output: MatrixJoinRoomResult; };
    acceptInvite: { input: { roomId: string; }; output: MatrixRoomActionResult; };
    rejectInvite: { input: { roomId: string; }; output: MatrixRoomActionResult; };
    suggestedSpaceChannelPlan: { input: { spaceId: string; }; output: MatrixSuggestedSpaceChannelPlanDTO; };
    joinSuggestedSpaceChannels: {
        input: { request: MatrixJoinSuggestedSpaceChannelsRequest; };
        output: MatrixJoinSuggestedSpaceChannelsResult;
    };
    leaveRoom: { input: { roomId: string; }; output: MatrixRoomActionResult; };
    createSpace: { input: { request: MatrixCreateSpaceRequest; }; output: MatrixCreateSpaceResult; };
    getSpaceAccess: { input: { spaceId: string; }; output: MatrixSpaceAccessSummaryDTO; };
    configureSpaceAccess: {
        input: { request: MatrixConfigureSpaceAccessRequest; };
        output: MatrixConfigureSpaceAccessResult;
    };
    requestSpaceAccess: { input: { joinName: string; }; output: MatrixRequestSpaceAccessResult; };
    getSpaceAccessRequests: { input: { spaceId: string; }; output: MatrixSpaceAccessRequestListDTO; };
    resolveSpaceAccessRequest: {
        input: { request: MatrixResolveSpaceAccessRequest; };
        output: MatrixResolveSpaceAccessRequestResult;
    };
    createSpaceChild: {
        input: { request: MatrixCreateSpaceChildRequest; };
        output: MatrixCreateSpaceChildResult;
    };
    reconcileSpaceChildCreate: {
        input: { parentSpaceId: string; };
        output: MatrixReconcileSpaceChildCreateResult;
    };
    repairSpaceChildLink: {
        input: { parentSpaceId: string; childRoomId: string; };
        output: MatrixRoomActionResult;
    };
    spaceChildren: {
        input: { spaceId: string; limit?: number; maxDepth?: number; };
        output: MatrixSpaceHierarchyDTO;
    };
    openDirectMessage: {
        input: { spaceId: string; userId: string; };
        output: MatrixDirectMessageResult;
    };

    paginate: {
        input: { roomId: string; limit?: number; fromEventId?: string; cursor?: string; };
        output: MatrixHistoryPageDTO;
    };
    messageContext: {
        input: { roomId: string; eventId: string; };
        output: MatrixMessageContextDTO;
    };
    searchMessages: { input: { request: MatrixMessageSearchRequest; }; output: MatrixMessageSearchResponse; };

    sendText: {
        input: { roomId: string; body: string; replyEventId?: string; };
        output: MatrixActionResult;
    };
    sendAttachment: {
        input: { roomId: string; attachment: MatrixAttachmentSendRequest; };
        output: MatrixAttachmentSendResult;
    };
    sendSticker: {
        input: { roomId: string; sticker: MatrixStickerSendRequest; };
        output: MatrixStickerSendResult;
    };
    edit: {
        input: { roomId: string; eventId: string; body: string; };
        output: MatrixActionResult;
    };
    cancelPending: { input: { roomId: string; transactionId: string; }; output: void; };
    redact: {
        input: { roomId: string; eventId: string; reason?: string; };
        output: MatrixActionResult;
    };
    react: {
        input: { roomId: string; eventId: string; key: string; remove?: boolean; };
        output: MatrixActionResult;
    };
    typing: {
        input: { roomId: string; isTyping: boolean; timeoutMs?: number; };
        output: void;
    };
    read: { input: { roomId: string; eventId: string; }; output: void; };
    downloadMedia: {
        input: { roomId: string; eventId: string; attachmentIndex: number; };
        output: MatrixMediaDownloadResult;
    };
    saveMedia: {
        input: { roomId: string; eventId: string; attachmentIndex: number; };
        output: MatrixSecureViewSaveResult;
    };
    urlPreview: {
        input: { roomId: string; eventId: string; };
        output: MatrixUrlPreviewDTO | undefined;
    };
    openExternal: { input: { url: string; }; output: void; };
}

export type MatrixSecureViewRequestType = keyof MatrixSecureViewRequestMap;

export type MatrixSecureViewRequest<Type extends MatrixSecureViewRequestType = MatrixSecureViewRequestType> =
    Type extends MatrixSecureViewRequestType
        ? { type: Type; } & MatrixSecureViewRequestMap[Type]["input"]
        : never;

export type MatrixSecureViewResult<Type extends MatrixSecureViewRequestType> =
    MatrixSecureViewRequestMap[Type]["output"];

export interface MatrixSecureViewHost {
    /** Invoke a validated main-process operation over the view-only IPC channel. */
    request<Type extends MatrixSecureViewRequestType>(
        request: MatrixSecureViewRequest<Type>
    ): Promise<MatrixSecureViewResult<Type>>;
    /** Subscribe to events sent only to this isolated view. */
    onEvent(callback: (event: MatrixSecureViewEvent) => void): () => void;
    /** Announce that the DOM and event subscription are ready. */
    ready(): void;
}

/** Private preload envelopes. The generation is never exposed to page JS. */
export interface MatrixSecureViewRequestEnvelope {
    generation: string;
    request: MatrixSecureViewRequest;
}

export interface MatrixSecureViewEventEnvelope {
    generation: string;
    event: MatrixSecureViewEvent;
}

declare global {
    interface Window {
        MatrixSecureViewHost?: MatrixSecureViewHost;
    }
}
