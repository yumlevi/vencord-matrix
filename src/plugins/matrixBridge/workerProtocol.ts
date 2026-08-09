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
    MatrixCreateSpaceChildRequest,
    MatrixCreateSpaceChildResult,
    MatrixCreateSpaceRequest,
    MatrixCreateSpaceResult,
    MatrixDirectMessageResult,
    MatrixHistoryPageDTO,
    MatrixJoinRoomResult,
    MatrixLoginRequest,
    MatrixMediaDownloadResult,
    MatrixMessageContextDTO,
    MatrixMessageSearchRequest,
    MatrixMessageSearchResponse,
    MatrixPublicRoomDirectoryDTO,
    MatrixReauthenticationRequest,
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
    MatrixStickerSendRequest,
    MatrixStickerSendResult,
    MatrixUrlPreviewDTO
} from "./types";

export const MATRIX_WORKER_ORIGIN = "https://matrix-worker.invalid";
export const MATRIX_WORKER_COMMAND = "VencordMatrixBridge:command";
export const MATRIX_WORKER_FETCH_KLIPY_PREVIEW = "VencordMatrixBridge:fetchKlipyPreview";
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

export interface MatrixCredentialUpdate extends MatrixSessionCredentials { }

export type MatrixWorkerCommand =
    | { type: "login"; login: MatrixLoginRequest; storageKey: string; }
    | { type: "reauthenticate"; reauthentication: MatrixReauthenticationRequest; }
    | { type: "register"; registration: MatrixRegistrationRequest; storageKey: string; }
    | { type: "start"; account: MatrixStoredAccount; }
    | { type: "suspend"; }
    | { type: "logout"; }
    | { type: "snapshot"; }
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
    | { type: "createSpaceChild"; request: MatrixCreateSpaceChildRequest; creationMarker: string; }
    | { type: "reconcileSpaceChildCreate"; parentSpaceId: string; creationMarker: string; }
    | {
        type: "repairSpaceChildLink";
        parentSpaceId: string;
        childRoomId: string;
        creationMarker?: string;
    }
    | { type: "spaceChildren"; spaceId: string; limit: number; maxDepth: number; }
    | { type: "openDirectMessage"; spaceId: string; userId: string; }
    | { type: "downloadMedia"; roomId: string; eventId: string; attachmentIndex: number; }
    | { type: "urlPreview"; roomId: string; eventId: string; }
    | { type: "sendText"; roomId: string; body: string; replyEventId?: string; }
    | { type: "sendSticker"; roomId: string; sticker: MatrixStickerSendRequest; }
    | { type: "sendAttachment"; roomId: string; attachment: MatrixAttachmentSendRequest; }
    | { type: "edit"; roomId: string; eventId: string; body: string; }
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
    | MatrixCreateSpaceResult
    | MatrixCreateSpaceChildResult
    | MatrixJoinRoomResult
    | MatrixRoomActionResult
    | MatrixRequestSpaceAccessResult
    | MatrixResolveSpaceAccessRequestResult
    | MatrixDirectMessageResult
    | MatrixMediaDownloadResult
    | MatrixHistoryPageDTO
    | MatrixMessageContextDTO
    | MatrixMessageSearchResponse
    | MatrixPublicRoomDirectoryDTO
    | MatrixReconcileSpaceChildCreateResult
    | MatrixRoomDTO
    | MatrixSnapshot
    | MatrixSpaceAccessRequestListDTO
    | MatrixSpaceAccessSummaryDTO
    | MatrixSpaceHierarchyDTO
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
    | { kind: "progress"; id: string; stage: MatrixWorkerStartupStage; }
    | { kind: "response"; id: string; ok: true; result: MatrixWorkerResult; }
    | { kind: "response"; id: string; ok: false; error: MatrixBridgeError; };

export interface MatrixWorkerHost {
    onCommand(callback: (request: MatrixWorkerRequest) => void): void;
    respond(message: MatrixWorkerMessage): void;
    ready(): void;
    saveCredentials(credentials: MatrixCredentialUpdate): Promise<void>;
    fetchKlipyPreview(url: string): Promise<string | undefined>;
}

declare global {
    interface Window {
        MatrixBridgeWorkerHost: MatrixWorkerHost;
    }
}
