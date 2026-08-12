/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    MatrixActionResult,
    MatrixAttachmentSendRequest,
    MatrixAttachmentSendResult,
    MatrixBridgeError,
    MatrixBridgeEvent,
    MatrixConfigureSpaceAccessRequest,
    MatrixConfigureSpaceAccessResult,
    MatrixCreateGroupChatRequest,
    MatrixCreateGroupChatResult,
    MatrixCreateSpaceChildRequest,
    MatrixCreateSpaceChildResult,
    MatrixCreateSpaceRequest,
    MatrixCreateSpaceResult,
    MatrixDirectMessageResult,
    MatrixGroupChatCandidateSearchRequest,
    MatrixGroupChatCandidateSearchResult,
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
    MatrixLoginRequest,
    MatrixMediaDownloadResult,
    MatrixMessageContextDTO,
    MatrixMessageSearchRequest,
    MatrixMessageSearchResponse,
    MatrixPublicRoomDirectoryDTO,
    MatrixReauthenticationRequest,
    MatrixReconcileGroupChatCreateResult,
    MatrixReconcileGroupChatInviteResult,
    MatrixReconcileSpaceChildCreateResult,
    MatrixRegistrationRequest,
    MatrixRequestSpaceAccessResult,
    MatrixResolveSpaceAccessRequest,
    MatrixResolveSpaceAccessRequestResult,
    MatrixRoomActionResult,
    MatrixRoomDTO,
    MatrixSnapshot,
    MatrixSpaceAccessRequestListDTO,
    MatrixSpaceAccessSummaryDTO,
    MatrixSpaceHierarchyDTO,
    MatrixSpaceInviteCandidateSearchRequest,
    MatrixSpaceInviteCandidateSearchResult,
    MatrixStickerSendRequest,
    MatrixStickerSendResult,
    MatrixSuggestedSpaceChannelPlanDTO,
    MatrixUrlPreviewDTO
} from "./types";

export const MATRIX_WORKER_ORIGIN = "https://matrix-worker.invalid";
export const MATRIX_WORKER_COMMAND = "VencordMatrixBridge:command";
export const MATRIX_WORKER_FETCH_KLIPY_PREVIEW = "VencordMatrixBridge:fetchKlipyPreview";
export const MATRIX_WORKER_FETCH_TENOR_PREVIEW = "VencordMatrixBridge:fetchTenorPreview";
export const MATRIX_WORKER_FETCH_X_STATUS = "VencordMatrixBridge:fetchXStatus";
export const MATRIX_WORKER_MESSAGE = "VencordMatrixBridge:message";
export const MATRIX_WORKER_SAVE_CREDENTIALS = "VencordMatrixBridge:saveCredentials";

export interface MatrixSessionCredentials {
    homeserver: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    refreshToken?: string;
}

export interface MatrixStoredAccount extends MatrixSessionCredentials {
    schema: 1;
    storageKey: string;
}

/** Exact /joined_rooms response used only to retire unreachable local receipts. */
export interface MatrixJoinedRoomIdsResult {
    roomIds: string[];
}

export interface MatrixRoomKeyImportWorkerResult {
    importedSessions: number;
}

export interface MatrixCredentialUpdate extends MatrixSessionCredentials { }

export type MatrixWorkerCommand =
    | { type: "login"; login: MatrixLoginRequest; storageKey: string; }
    | { type: "reauthenticate"; reauthentication: MatrixReauthenticationRequest; }
    | { type: "register"; registration: MatrixRegistrationRequest; storageKey: string; }
    | { type: "start"; account: MatrixStoredAccount; }
    | { type: "suspend"; }
    | { type: "logout"; }
    | { type: "importRoomKeys"; bytes: Uint8Array; passphrase: string; }
    | { type: "snapshot"; }
    | { type: "joinedRoomIds"; }
    | { type: "publicRooms"; }
    | { type: "joinRoom"; roomId: string; }
    | { type: "joinRoomAddress"; address: string; }
    | { type: "acceptInvite"; roomId: string; }
    | { type: "rejectInvite"; roomId: string; }
    | { type: "leaveRoom"; roomId: string; }
    | { type: "createSpace"; request: MatrixCreateSpaceRequest; }
    | { type: "getSpaceAccess"; spaceId: string; }
    | { type: "configureSpaceAccess"; request: MatrixConfigureSpaceAccessRequest; }
    | { type: "requestSpaceAccess"; joinName: string; }
    | { type: "getSpaceAccessRequests"; spaceId: string; }
    | { type: "resolveSpaceAccessRequest"; request: MatrixResolveSpaceAccessRequest; }
    | { type: "searchSpaceInviteCandidates"; request: MatrixSpaceInviteCandidateSearchRequest; }
    | { type: "inviteUserToSpace"; request: MatrixInviteUserToSpaceRequest; }
    | { type: "searchGroupChatCandidates"; request: MatrixGroupChatCandidateSearchRequest; }
    | { type: "searchGroupChatInviteCandidates"; request: MatrixGroupChatInviteCandidateSearchRequest; }
    | { type: "inviteUserToGroupChat"; request: MatrixInviteUserToGroupChatRequest; }
    | { type: "reconcileGroupChatInvite"; request: MatrixInviteUserToGroupChatRequest; }
    | { type: "createGroupChat"; request: MatrixCreateGroupChatRequest; creationMarker: string; }
    | {
        type: "reconcileGroupChatCreate";
        creationMarker: string;
        name: string;
        userIds: string[];
    }
    | { type: "createSpaceChild"; request: MatrixCreateSpaceChildRequest; creationMarker: string; }
    | { type: "reconcileSpaceChildCreate"; parentSpaceId: string; creationMarker: string; }
    | {
        type: "repairSpaceChildLink";
        parentSpaceId: string;
        childRoomId: string;
        creationMarker?: string;
    }
    | { type: "spaceChildren"; spaceId: string; limit: number; maxDepth: number; }
    | { type: "suggestedSpaceChannelPlan"; spaceId: string; }
    | { type: "joinSuggestedSpaceChannels"; request: MatrixJoinSuggestedSpaceChannelsRequest; }
    | { type: "openDirectMessage"; spaceId: string; userId: string; }
    | { type: "providerPreviewPolicy"; allowDirectMedia: boolean; }
    | { type: "downloadMedia"; roomId: string; eventId: string; attachmentIndex: number; allowDirectMedia: boolean; }
    | { type: "urlPreview"; roomId: string; eventId: string; allowDirectMedia: boolean; }
    | { type: "sendText"; roomId: string; body: string; replyEventId?: string; mentionedUserIds?: string[]; }
    | { type: "sendSticker"; roomId: string; sticker: MatrixStickerSendRequest; }
    | { type: "sendAttachment"; roomId: string; attachment: MatrixAttachmentSendRequest; }
    | { type: "edit"; roomId: string; eventId: string; body: string; mentionedUserIds?: string[]; }
    | { type: "cancelPending"; roomId: string; transactionId: string; }
    | { type: "redact"; roomId: string; eventId: string; reason?: string; }
    | { type: "react"; roomId: string; eventId: string; key: string; remove?: boolean; }
    | { type: "typing"; roomId: string; isTyping: boolean; timeoutMs?: number; }
    | { type: "read"; roomId: string; eventId: string; }
    | { type: "paginate"; roomId: string; limit?: number; fromEventId?: string; cursor?: string; }
    | { type: "messageContext"; roomId: string; eventId: string; }
    | { type: "searchMessages"; request: MatrixMessageSearchRequest; };

export type MatrixWorkerResult =
    | undefined
    | MatrixActionResult
    | MatrixConfigureSpaceAccessResult
    | MatrixCreateGroupChatResult
    | MatrixCreateSpaceResult
    | MatrixCreateSpaceChildResult
    | MatrixJoinRoomResult
    | MatrixJoinedRoomIdsResult
    | MatrixRoomActionResult
    | MatrixRequestSpaceAccessResult
    | MatrixResolveSpaceAccessRequestResult
    | MatrixDirectMessageResult
    | MatrixMediaDownloadResult
    | MatrixHistoryPageDTO
    | MatrixInviteUserToSpaceResult
    | MatrixInviteUserToGroupChatResult
    | MatrixJoinSuggestedSpaceChannelsResult
    | MatrixRoomKeyImportWorkerResult
    | MatrixMessageContextDTO
    | MatrixMessageSearchResponse
    | MatrixPublicRoomDirectoryDTO
    | MatrixReconcileGroupChatCreateResult
    | MatrixReconcileGroupChatInviteResult
    | MatrixReconcileSpaceChildCreateResult
    | MatrixRoomDTO
    | MatrixSnapshot
    | MatrixSpaceAccessRequestListDTO
    | MatrixSpaceAccessSummaryDTO
    | MatrixSpaceHierarchyDTO
    | MatrixSpaceInviteCandidateSearchResult
    | MatrixGroupChatCandidateSearchResult
    | MatrixGroupChatInviteCandidateSearchResult
    | MatrixSuggestedSpaceChannelPlanDTO
    | MatrixStickerSendResult
    | MatrixAttachmentSendResult
    | MatrixUrlPreviewDTO
    | { credentials: MatrixSessionCredentials; };

export interface MatrixWorkerRequest {
    id: string;
    command: MatrixWorkerCommand;
}

/** Content-free startup stage used only to supervise bounded worker startup. */
export type MatrixWorkerStartupStage =
    | "store"
    | "session"
    | "crypto-module"
    | "crypto-wasm"
    | "crypto-store"
    | "crypto-machine"
    | "client";

export type MatrixWorkerEvent = MatrixBridgeEvent extends infer Event
    ? Event extends { seq: number; }
        ? Omit<Event, "seq">
        : never
    : never;

export type MatrixWorkerMessage =
    | { kind: "ready"; }
    | { kind: "event"; revision: number; event: MatrixWorkerEvent; }
    | { kind: "started"; id: string; }
    /** Emitted immediately before a homeserver mutation whose lost response is ambiguous. */
    | { kind: "mutation"; id: string; }
    | { kind: "progress"; id: string; stage: MatrixWorkerStartupStage; }
    | { kind: "response"; id: string; ok: true; result: MatrixWorkerResult; }
    | { kind: "response"; id: string; ok: false; error: MatrixBridgeError; };

export interface MatrixWorkerHost {
    onCommand(callback: (request: MatrixWorkerRequest) => void): void;
    respond(message: MatrixWorkerMessage): void;
    ready(): void;
    saveCredentials(credentials: MatrixCredentialUpdate): Promise<void>;
    fetchKlipyPreview(url: string): Promise<string | undefined>;
    fetchTenorPreview(url: string): Promise<string | undefined>;
    fetchXStatus(url: string): Promise<string | undefined>;
}

declare global {
    interface Window {
        MatrixBridgeWorkerHost: MatrixWorkerHost;
    }
}
