/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    net,
    safeStorage,
    session,
    shell,
    type WebContents
} from "electron";

import { MAX_MATRIX_MESSAGE_MENTIONS } from "./messageMentions";
import {
    MATRIX_SECURE_VIEW_BOOTSTRAP,
    MATRIX_SECURE_VIEW_EVENT,
    MATRIX_SECURE_VIEW_READY,
    MATRIX_SECURE_VIEW_REQUEST,
    type MatrixSecureViewAccountConfig,
    type MatrixSecureViewBootstrap,
    type MatrixSecureViewBounds,
    type MatrixSecureViewControlState,
    type MatrixSecureViewDiagnostic,
    type MatrixSecureViewEvent,
    type MatrixSecureViewEventEnvelope,
    type MatrixSecureViewRequest,
    type MatrixSecureViewRequestEnvelope,
    type MatrixSecureViewRoute,
    type MatrixSecureViewSecurityState,
    type MatrixSecureViewShellCommand,
    type MatrixSecureViewShowRequest,
    type MatrixShellEvent,
    type MatrixShellRoom,
    type MatrixShellSnapshot
} from "./secureViewProtocol";
import type {
    MatrixActionResult,
    MatrixAttachmentDTO,
    MatrixAttachmentGroupDTO,
    MatrixAttachmentSendRequest,
    MatrixAttachmentSendResult,
    MatrixBridgeConfig,
    MatrixBridgeError,
    MatrixBridgeEvent,
    MatrixBridgeState,
    MatrixBridgeStatus,
    MatrixConfigureSpaceAccessRequest,
    MatrixConfigureSpaceAccessResult,
    MatrixConfigureSpaceAccessStep,
    MatrixCreateGroupChatRequest,
    MatrixCreateGroupChatResult,
    MatrixCreateSpaceChildRequest,
    MatrixCreateSpaceChildResult,
    MatrixCreateSpacePartialCode,
    MatrixCreateSpaceRequest,
    MatrixCreateSpaceResult,
    MatrixDirectMessageResult,
    MatrixGroupChatCandidateDTO,
    MatrixGroupChatCandidateSearchRequest,
    MatrixGroupChatCandidateSearchResult,
    MatrixGroupChatInvitationDTO,
    MatrixGroupChatInviteCandidateDTO,
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
    MatrixMemberDTO,
    MatrixMessageContextDTO,
    MatrixMessageDTO,
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
    MatrixRegistrationRequest,
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
import {
    MATRIX_WORKER_COMMAND,
    MATRIX_WORKER_FETCH_KLIPY_PREVIEW,
    MATRIX_WORKER_MESSAGE,
    MATRIX_WORKER_ORIGIN,
    MATRIX_WORKER_SAVE_CREDENTIALS,
    type MatrixCredentialUpdate,
    type MatrixJoinedRoomIdsResult,
    type MatrixSessionCredentials,
    type MatrixStoredAccount,
    type MatrixWorkerCommand,
    type MatrixWorkerEvent,
    type MatrixWorkerMessage,
    type MatrixWorkerResult,
    type MatrixWorkerStartupStage
} from "./workerProtocol";

const WORKER_PARTITION = "persist:vencord-matrix-bridge";
const WORKER_SCRIPT = "matrixBridgeWorker.js";
const WORKER_PRELOAD = "matrixBridgePreload.js";
const WORKER_WASM = "matrix_sdk_crypto_wasm_bg.wasm";
const SECURE_VIEW_PARTITION = "vencord-matrix-secure-view";
const SECURE_VIEW_ORIGIN = "https://matrix-secure-view.invalid";
const SECURE_VIEW_URL = `${SECURE_VIEW_ORIGIN}/`;
const SECURE_VIEW_PRELOAD = "matrixSecureViewPreload.js";
const SECURE_VIEW_SCRIPT = "matrixSecureView.js";
const SECURE_VIEW_STYLE = "matrixSecureView.css";
const ACCOUNT_DIR = join(DATA_DIR, "matrixBridge");
const ACCOUNT_FILE = join(ACCOUNT_DIR, "account.enc");
const SPACE_CHILD_CREATES_FILE = join(ACCOUNT_DIR, "space-child-creates.enc");
const GROUP_CHAT_CREATES_FILE = join(ACCOUNT_DIR, "group-chat-creates.enc");
const DEFAULT_SPACE_INVITE_DIRECTORY_LIMIT = 25;
const MAX_SPACE_INVITE_DIRECTORY_LIMIT = 100;
const MAX_SPACE_INVITE_DIRECTORY_QUERY_LENGTH = 256;
const MAX_CONCURRENT_SPACE_INVITE_SEARCHES = 8;
const MAX_CONCURRENT_SPACE_INVITE_SEARCHES_PER_RENDERER = 3;
const DEFAULT_GROUP_CHAT_DIRECTORY_LIMIT = 25;
const MAX_GROUP_CHAT_DIRECTORY_LIMIT = 100;
const MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH = 256;
const BARE_MATRIX_LOCALPART_PATTERN = /^[a-z0-9._=\-/+]{1,255}$/u;
const MAX_CONCURRENT_GROUP_CHAT_SEARCHES = 8;
const MAX_CONCURRENT_GROUP_CHAT_SEARCHES_PER_RENDERER = 3;
const MIN_GROUP_CHAT_INVITEES = 0;
const MAX_GROUP_CHAT_INVITEES = 9;
const MAX_GROUP_CHAT_PARTICIPANTS = 10;
const MAX_IN_FLIGHT_GROUP_CHAT_INVITES = 32;
const MAX_GROUP_CHAT_STATE_FILE_BYTES = 256 * 1024;
const MAX_IN_FLIGHT_SPACE_INVITES = 128;
const MAX_IN_FLIGHT_ROOM_INVITE_ACTIONS = 128;
const MAX_IN_FLIGHT_ROOM_JOINS = 128;
const MAX_IN_FLIGHT_SUGGESTED_SPACE_CHANNEL_JOINS = 8;
const MAX_EVENT_QUEUE = 256;
const MAX_SHELL_EVENT_QUEUE_BYTES = 4 * 1024 * 1024;
const LONG_POLL_MS = 25_000;
const COMMAND_TIMEOUT_MS = 90_000;
const GROUP_CHAT_CREATE_TIMEOUT_MS = 5 * 60_000;
const SUGGESTED_SPACE_CHANNEL_JOIN_TIMEOUT_MS = 5 * 60_000;
const COMMAND_QUEUE_TIMEOUT_MS = 5 * 60_000;
const STARTUP_OVERALL_TIMEOUT_MS = 10 * 60_000;
const STARTUP_STAGE_TIMEOUT_MS: Readonly<Record<MatrixWorkerStartupStage, number>> = {
    store: 60_000,
    session: 3 * 60_000,
    "crypto-module": 4 * 60_000,
    "crypto-wasm": 4 * 60_000,
    "crypto-store": 4 * 60_000,
    "crypto-machine": 4 * 60_000,
    client: 90_000
};
const STARTUP_STAGES: readonly MatrixWorkerStartupStage[] = [
    "store",
    "session",
    "crypto-module",
    "crypto-wasm",
    "crypto-store",
    "crypto-machine",
    "client"
];
const MAX_MEDIA_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 33_554_432;
const ATTACHMENT_GROUP_ID_PATTERN = /^vcgrp_[0-9a-f]{64}$/u;
const SPACE_CHILD_CREATION_MARKER_PATTERN = /^vccreate_[0-9a-f]{64}$/u;
const GROUP_CHAT_CREATION_MARKER_PATTERN = /^vcgroup_[0-9a-f]{64}$/u;
const MAX_KLIPY_PREVIEW_HTML_BYTES = 512 * 1024;
const KLIPY_PREVIEW_TIMEOUT_MS = 15_000;
const KLIPY_PREVIEW_USER_AGENT = "Vencord-MatrixBridge/1.0 Discordbot/2.0";
const ACCOUNT_CUT_MAX_ATTEMPTS = 3;

const SECURE_VIEW_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src blob: data:",
    "media-src blob: data:",
    "connect-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
].join("; ");

const SECURE_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${SECURE_VIEW_CSP}">
<meta name="referrer" content="no-referrer">
<title>Matrix</title>
<link rel="stylesheet" href="/${SECURE_VIEW_STYLE}">
<script src="/${SECURE_VIEW_SCRIPT}" defer></script>
</head>
<body><main id="matrix-secure-view-root" aria-live="polite">Loading Matrix...</main></body>
</html>`;

const WORKER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
</head>
<body><script type="module" src="/${WORKER_SCRIPT}"></script></body>
</html>`;

interface PendingWorkerRequest {
    resolve(value: MatrixWorkerResult): void;
    reject(reason: Error): void;
    timer: ReturnType<typeof setTimeout>;
    commandType: MatrixWorkerCommand["type"];
    started: boolean;
    mutationDispatched: boolean;
    startupBinding?: MatrixAccountBinding;
    startupCryptoDeadline?: number;
    startupDeadline?: number;
    startupStage?: MatrixWorkerStartupStage;
}

interface ShellEventWaiter {
    afterSeq: number;
    resolve(value: MatrixShellEvent | null): void;
    timer: ReturnType<typeof setTimeout>;
    sender: WebContents;
    onDestroyed(): void;
}

interface RendererEventWaiter {
    afterSeq: number;
    resolve(value: MatrixBridgeEvent | null): void;
    timer: ReturnType<typeof setTimeout>;
    sender: WebContents;
    onDestroyed(): void;
}

interface SecureViewState {
    owner: BrowserWindow;
    ownerContents: WebContents;
    view: BrowserWindow;
    generation: string;
    route: MatrixSecureViewRoute;
    requestedBounds: MatrixSecureViewBounds;
    ready: boolean;
    visible: boolean;
    presented: boolean;
    ownerHidden: boolean;
    ownerHtmlFullscreen: boolean;
    ownerGeometryTransition: boolean;
    destroyed: boolean;
    userGestureUntil: number;
    boundAccount: MatrixAccountBinding | null | undefined;
    preloadBootstrapRequested: boolean;
    preloadBootstrapGranted: boolean;
    preloadError: boolean;
    domReady: boolean;
    mainFrameLoaded: boolean;
    readySignalReceived: boolean;
    readySignalRejected: boolean;
    didStartNavigationCount: number;
    willNavigateSeenCount: number;
    willNavigateAllowedCount: number;
    willNavigateBlockedCount: number;
    didStartLoadingCount: number;
    loadUrlResolved: boolean;
    loadUrlRejected: boolean;
    protocolRequestBaseline: number;
    protocolDocumentServedBaseline: number;
    onOwnerLayout(): void;
    onOwnerGeometryTransition(): void;
    onOwnerHidden(): void;
    onOwnerShown(): void;
    onOwnerHtmlFullscreenEntered(): void;
    onOwnerHtmlFullscreenLeft(): void;
    onOwnerClosed(): void;
    onOwnerContentsDestroyed(): void;
    onOwnerDidNavigate(): void;
    onOwnerRendererGone(): void;
    onViewClosed(): void;
}

interface MatrixAccountBinding {
    homeserver: string;
    userId: string;
    deviceId: string;
    storageKey: string;
}

interface StartupFailureLatch {
    binding: MatrixAccountBinding;
    error: MatrixBridgeError;
}

interface PendingSpaceChildCreate {
    homeserver: string;
    userId: string;
    parentSpaceId: string;
    creationMarker: string;
}

interface PendingGroupChatCreate {
    homeserver: string;
    userId: string;
    name: string;
    userIds: string[];
    creationMarker: string;
    /** Durable receipt retained until the renderer acknowledges this exact room. */
    resolved?: MatrixCreateGroupChatResult;
}

interface PendingGroupChatInvite extends MatrixInviteUserToGroupChatRequest {
    homeserver: string;
    accountUserId: string;
    /** Durable receipt retained until the renderer acknowledges this exact invite. */
    resolved?: MatrixInviteUserToGroupChatResult;
}

let workerWindow: BrowserWindow | null = null;
let workerReady: Promise<void> | null = null;
let resolveWorkerReady: (() => void) | null = null;
let rejectWorkerReady: ((reason: Error) => void) | null = null;
let sequence = 0;
let currentStatus: MatrixBridgeStatus = { seq: 0, state: "logged_out" };
let lifecycleTail: Promise<void> = Promise.resolve();
let accountMutationTail: Promise<void> = Promise.resolve();
let snapshotCutTail: Promise<void> = Promise.resolve();
let authenticationInProgress = false;
let logoutInProgress = false;
let pluginSuspended = false;
let accountLifecycleRevision = 0;
let accountLifecycleTransitions = 0;
let createSpaceInFlight = false;
let createSpaceChildInFlight = false;
let createGroupChatInFlight = false;
let activeWorkerBinding: MatrixAccountBinding | null = null;
let startupFailureLatch: StartupFailureLatch | null = null;
let accountBoundOperations = 0;
let privateAccountRequests = 0;
let privateIdentityTransition = false;
let privateIdentityTail: Promise<void> = Promise.resolve();
let spaceChildCreateStateTail: Promise<void> = Promise.resolve();
let spaceChildCreateStateLoaded = false;
let spaceChildCreateStateError: Error | null = null;
let groupChatCreateStateTail: Promise<void> = Promise.resolve();
let groupChatCreateStateLoaded = false;
let groupChatCreateStateError: Error | null = null;
let concurrentSpaceInviteSearches = 0;
const spaceInviteSearchesByRenderer = new Map<number, number>();
let concurrentGroupChatSearches = 0;
const groupChatSearchesByRenderer = new Map<number, number>();
const spaceInvitesInFlight = new Set<string>();
const roomInviteActionsInFlight = new Set<string>();
const roomJoinsInFlight = new Set<string>();
const suggestedSpaceChannelJoinsInFlight = new Set<string>();
const groupChatReconciliationsInFlight = new Set<string>();
const groupChatInviteOperationsInFlight = new Set<string>();
const groupChatInvitePruneScheduledWorkers = new WeakSet<BrowserWindow>();
const privateAccountDrainWaiters = new Set<() => void>();
const accountBoundOperationDrainWaiters = new Set<() => void>();
const privateAccountRequestContext = new AsyncLocalStorage<boolean>();

const pendingWorkerRequests = new Map<string, PendingWorkerRequest>();
const rendererEventQueue: MatrixBridgeEvent[] = [];
const rendererEventQueueSizes = new Map<number, number>();
const rendererEventWaiters = new Set<RendererEventWaiter>();
const shellEventQueue: MatrixShellEvent[] = [];
const shellEventQueueSizes = new Map<number, number>();
const shellEventWaiters = new Set<ShellEventWaiter>();
const secureViewsByOwnerId = new Map<number, SecureViewState>();
const secureViewsByContentsId = new Map<number, SecureViewState>();
let secureViewSessionConfigured = false;
let secureViewProtocolRequestCount = 0;
let secureViewProtocolDocumentServedCount = 0;
let latestShellSnapshot: MatrixShellSnapshot | null = null;
let shellSnapshotDirty = false;
let rendererEventQueueBytes = 0;
let rendererEventsDroppedThroughSeq = 0;
let shellEventQueueBytes = 0;
let lastWorkerRevision = 0;
let lastWorkerEventSequence = 0;
const workerRevisionSequences = new Map<number, number>();
const MAX_WORKER_REVISION_SEQUENCES = 4_096;
const ambiguousSpaceChildCreates = new Map<string, PendingSpaceChildCreate>();
const MAX_AMBIGUOUS_SPACE_CHILD_CREATES = 64;
const ambiguousGroupChatCreates = new Map<string, PendingGroupChatCreate>();
const MAX_AMBIGUOUS_GROUP_CHAT_CREATES = 64;
const ambiguousGroupChatInvites = new Map<string, PendingGroupChatInvite>();
const MAX_AMBIGUOUS_GROUP_CHAT_INVITES = 256;
const MATRIX_ERROR_CODE_PATTERN = /^(?=.{1,128}$)(?:MATRIX_|M_|ORG[._])[A-Z0-9._]+$/u;

function bridgeError(code: string, message: string, causeCode?: string): Error {
    const error = new Error(message);
    error.name = code;
    if (causeCode && MATRIX_ERROR_CODE_PATTERN.test(causeCode)) {
        (error as Error & { causeCode?: string; }).causeCode = causeCode;
    }
    return error;
}

function isSecureViewDocumentUrl(value: string): boolean {
    try {
        // Electron may omit or restore the root slash at different navigation
        // stages. Compare the canonical URL while still rejecting every other
        // origin, path, query, fragment, credential, and non-default port.
        return new URL(value).href === SECURE_VIEW_URL;
    } catch {
        return false;
    }
}

function errorDTO(error: unknown): MatrixBridgeError {
    if (error instanceof Error && MATRIX_ERROR_CODE_PATTERN.test(error.name)) {
        const { causeCode } = error as Error & { causeCode?: unknown; };
        return {
            code: error.name,
            message: error.message.slice(0, 300),
            ...(typeof causeCode === "string" && MATRIX_ERROR_CODE_PATTERN.test(causeCode) ? { causeCode } : {})
        };
    }

    return {
        code: "MATRIX_BACKEND_ERROR",
        message: "The isolated Matrix backend failed."
    };
}

function validateString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", `${label} is invalid.`);
    }

    return value;
}

function validateHomeserver(value: unknown): string {
    const input = validateString(value, "homeserver", 2_048);
    let url: URL;

    try {
        url = new URL(input);
    } catch {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The homeserver URL is invalid.");
    }

    const loopbackHttp = url.protocol === "http:"
        && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");

    if (url.protocol !== "https:" && !loopbackHttp) {
        throw bridgeError("MATRIX_INSECURE_HOMESERVER", "The homeserver must use HTTPS (except loopback development servers).");
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The homeserver must be an origin URL without credentials, path, query, or fragment.");
    }

    return url.origin;
}

function validateUserId(value: unknown): string {
    const userId = validateString(value, "userId", 512);
    if (!/^@[^\s:]+:[^\s]+$/.test(userId) || /[\u0000-\u001f\u007f]/u.test(userId)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix user ID is invalid.");
    }
    return userId;
}

function validateMentionUserIds(value: unknown): string[] | undefined {
    if (value == null) return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MATRIX_MESSAGE_MENTIONS) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix message mentions are invalid.");
    }
    const userIds = value.map(validateUserId);
    if (new Set(userIds).size !== userIds.length) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix message mentions contain duplicates.");
    }
    return userIds;
}

function validateUsername(value: unknown): string {
    const username = validateString(value, "username", 512).trim();
    if (!username || Buffer.byteLength(username, "utf8") > 255 || /[\s\u0000-\u001f\u007f@:]/u.test(username)) {
        throw bridgeError("MATRIX_INVALID_USERNAME", "Enter only the username, without @ or a server name.");
    }
    return username;
}

function validateRegistrationToken(value: unknown): string {
    const token = validateString(value, "registrationToken", 64);
    if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
        throw bridgeError("MATRIX_INVALID_REGISTRATION_TOKEN", "The registration token has an invalid format.");
    }
    return token;
}

function validateRoomId(value: unknown): string {
    const roomId = validateString(value, "roomId", 1_024);
    if (!roomId.startsWith("!") || /[\s\u0000-\u001f\u007f]/u.test(roomId)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix room ID is invalid.");
    }
    return roomId;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", `${label} is invalid.`);
    }
    return value as Record<string, unknown>;
}

function exactObjectKeys(
    value: unknown,
    label: string,
    allowed: readonly string[],
    required: readonly string[] = allowed
): Record<string, unknown> {
    const record = objectRecord(value, label);
    const allowedKeys = new Set(allowed);
    if (Object.keys(record).some(key => !allowedKeys.has(key))
        || required.some(key => !Object.hasOwn(record, key))) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", `${label} contains invalid fields.`);
    }
    return record;
}

function validateSecureViewGeneration(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
        throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view generation was rejected.");
    }
    return value;
}

function validateSecureViewRoute(value: unknown): MatrixSecureViewRoute {
    const route = exactObjectKeys(value, "secure view route", ["kind", "roomId"], ["kind"]);
    if (route.kind === "home" || route.kind === "settings") {
        if (Object.hasOwn(route, "roomId")) {
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view route is invalid.");
        }
        return { kind: route.kind };
    }
    if (route.kind !== "room" && route.kind !== "space" && route.kind !== "dm") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view route is invalid.");
    }
    return { kind: route.kind, roomId: validateRoomId(route.roomId) };
}

function validateSecureViewBounds(value: unknown): MatrixSecureViewBounds {
    const bounds = exactObjectKeys(value, "secure view bounds", ["x", "y", "width", "height"]);
    for (const field of ["x", "y", "width", "height"] as const) {
        if (!Number.isSafeInteger(bounds[field])) {
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view bounds are invalid.");
        }
    }
    const { x, y, width, height } = bounds as unknown as MatrixSecureViewBounds;
    if (x < 0 || y < 0 || width < 1 || height < 1
        || x > 100_000 || y > 100_000 || width > 100_000 || height > 100_000) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view bounds are invalid.");
    }
    return { x, y, width, height };
}

function validateSecureViewShellCommand(value: unknown): MatrixSecureViewShellCommand {
    const command = exactObjectKeys(value, "secure view command", ["type"]);
    if (command.type !== "openSearch") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view command is invalid.");
    }
    return { type: "openSearch" };
}

function projectShellStatus(status: MatrixBridgeStatus): MatrixBridgeStatus {
    const code = status.error?.code && MATRIX_ERROR_CODE_PATTERN.test(status.error.code)
        ? status.error.code
        : "MATRIX_BACKEND_ERROR";
    const causeCode = status.error?.causeCode && MATRIX_ERROR_CODE_PATTERN.test(status.error.causeCode)
        ? status.error.causeCode
        : undefined;
    return {
        seq: status.seq,
        state: status.state,
        ...(status.account ? { account: { userId: status.account.userId } } : {}),
        ...(status.error ? {
            error: {
                code,
                message: "The Matrix backend reported an error.",
                ...(causeCode ? { causeCode } : {})
            }
        } : {})
    };
}

function projectShellRoom(room: MatrixRoomDTO): MatrixShellRoom {
    return {
        roomId: room.roomId,
        timelineGeneration: room.timelineGeneration,
        name: room.name,
        membership: room.membership,
        kind: room.kind,
        ...(room.roomType ? { roomType: room.roomType } : {}),
        ...(room.groupChat === true ? { groupChat: true as const } : {}),
        ...(room.invitePermission ? { invitePermission: { ...room.invitePermission } } : {}),
        ...(room.canConfigureSpaceAccess == null ? {} : {
            canConfigureSpaceAccess: room.canConfigureSpaceAccess
        }),
        ...(room.accessRequestCount == null ? {} : { accessRequestCount: room.accessRequestCount }),
        ...(room.accessRequestCountComplete == null ? {} : {
            accessRequestCountComplete: room.accessRequestCountComplete
        }),
        ...(room.canApproveAccessRequests == null ? {} : {
            canApproveAccessRequests: room.canApproveAccessRequests
        }),
        ...(room.canDenyAccessRequests == null ? {} : {
            canDenyAccessRequests: room.canDenyAccessRequests
        }),
        joinRule: room.joinRule,
        parentIds: [...room.parentIds],
        childIds: [...room.childIds],
        spaceChildren: room.spaceChildren.map(child => ({ ...child })),
        encrypted: room.encrypted,
        ...(room.unreadCount == null ? {} : { unreadCount: room.unreadCount }),
        ...(room.highlightCount == null ? {} : { highlightCount: room.highlightCount })
    };
}

function projectShellSnapshot(snapshot: MatrixSnapshot): MatrixShellSnapshot {
    return {
        seq: snapshot.seq,
        revision: snapshot.revision,
        status: projectShellStatus(snapshot.status),
        ...(snapshot.account ? { account: { userId: snapshot.account.userId } } : {}),
        rooms: snapshot.rooms.map(projectShellRoom)
    };
}

function projectShellEvent(event: MatrixBridgeEvent): MatrixShellEvent {
    switch (event.type) {
        case "snapshot":
            return { seq: event.seq, type: "snapshot", snapshot: projectShellSnapshot(event.snapshot) };
        case "room":
            return { seq: event.seq, type: "room", room: projectShellRoom(event.room) };
        case "status":
            return { seq: event.seq, type: "status", status: projectShellStatus(event.status) };
        default:
            return { seq: event.seq, type: "roomChanged", roomId: event.roomId };
    }
}

function settleRendererEventWaiter(waiter: RendererEventWaiter, value: MatrixBridgeEvent | null): void {
    if (!rendererEventWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.sender.removeListener("destroyed", waiter.onDestroyed);
    waiter.resolve(value);
}

function estimatedRendererEventBytes(event: MatrixBridgeEvent): number {
    try {
        const json = JSON.stringify(event);
        if (json.length > MAX_SHELL_EVENT_QUEUE_BYTES) return MAX_SHELL_EVENT_QUEUE_BYTES + 1;
        return Buffer.byteLength(json, "utf8");
    } catch {
        return MAX_SHELL_EVENT_QUEUE_BYTES + 1;
    }
}

function shiftRendererEvent(): void {
    const removed = rendererEventQueue.shift();
    if (!removed) return;
    rendererEventsDroppedThroughSeq = Math.max(rendererEventsDroppedThroughSeq, removed.seq);
    const size = rendererEventQueueSizes.get(removed.seq) ?? 0;
    rendererEventQueueSizes.delete(removed.seq);
    rendererEventQueueBytes = Math.max(0, rendererEventQueueBytes - size);
}

function enqueueRendererEvent(event: MatrixBridgeEvent): void {
    const size = estimatedRendererEventBytes(event);
    if (size > MAX_SHELL_EVENT_QUEUE_BYTES) {
        rendererEventsDroppedThroughSeq = Math.max(rendererEventsDroppedThroughSeq, event.seq);
        for (const waiter of [...rendererEventWaiters]) settleRendererEventWaiter(waiter, null);
        return;
    }
    while (rendererEventQueue.length >= MAX_EVENT_QUEUE
        || rendererEventQueueBytes + size > MAX_SHELL_EVENT_QUEUE_BYTES) {
        shiftRendererEvent();
    }
    rendererEventQueue.push(event);
    rendererEventQueueSizes.set(event.seq, size);
    rendererEventQueueBytes += size;
    for (const waiter of [...rendererEventWaiters]) {
        if (waiter.afterSeq < rendererEventsDroppedThroughSeq) {
            // The next invocation returns an exact-cut recovery snapshot. Avoid
            // doing worker/account I/O inside the synchronous publish path.
            settleRendererEventWaiter(waiter, null);
            continue;
        }
        const queued = rendererEventQueue.find(candidate => candidate.seq > waiter.afterSeq);
        if (queued) settleRendererEventWaiter(waiter, queued);
    }
}

function settleShellEventWaiter(waiter: ShellEventWaiter, value: MatrixShellEvent | null): void {
    if (!shellEventWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.sender.removeListener("destroyed", waiter.onDestroyed);
    waiter.resolve(value);
}

function estimatedShellEventBytes(event: MatrixShellEvent): number {
    const pending: unknown[] = [event];
    const seen = new WeakSet<object>();
    let bytes = 0;
    let nodes = 0;
    while (pending.length) {
        if (++nodes > 100_000 || bytes > MAX_SHELL_EVENT_QUEUE_BYTES) return MAX_SHELL_EVENT_QUEUE_BYTES + 1;
        const value = pending.pop();
        bytes += 16;
        if (typeof value === "string") {
            bytes += Buffer.byteLength(value, "utf8");
        } else if (value && typeof value === "object") {
            if (seen.has(value)) return MAX_SHELL_EVENT_QUEUE_BYTES + 1;
            seen.add(value);
            for (const [key, child] of Object.entries(value)) {
                bytes += Buffer.byteLength(key, "utf8") + 8;
                pending.push(child);
            }
        }
    }
    return bytes;
}

function shiftShellEvent(): void {
    const removed = shellEventQueue.shift();
    if (!removed) return;
    const size = shellEventQueueSizes.get(removed.seq) ?? 0;
    shellEventQueueSizes.delete(removed.seq);
    shellEventQueueBytes = Math.max(0, shellEventQueueBytes - size);
}

function enqueueShellEvent(event: MatrixShellEvent): void {
    const size = estimatedShellEventBytes(event);
    if (size > MAX_SHELL_EVENT_QUEUE_BYTES) {
        const fallback: MatrixShellEvent = event.type === "room"
            ? { seq: event.seq, type: "roomChanged", roomId: event.room.roomId }
            : event.type === "snapshot"
                ? { seq: event.seq, type: "status", status: event.snapshot.status }
                : event;
        if (fallback !== event) {
            enqueueShellEvent(fallback);
            return;
        }
        return;
    }
    while (shellEventQueue.length >= MAX_EVENT_QUEUE
        || shellEventQueueBytes + size > MAX_SHELL_EVENT_QUEUE_BYTES) {
        shiftShellEvent();
    }
    shellEventQueue.push(event);
    shellEventQueueSizes.set(event.seq, size);
    shellEventQueueBytes += size;
    for (const waiter of [...shellEventWaiters]) {
        if (event.seq > waiter.afterSeq) settleShellEventWaiter(waiter, event);
    }
}

function publishShellNavigation(route: MatrixSecureViewRoute): void {
    const event: MatrixShellEvent = { seq: ++sequence, type: "navigate", route };
    if (latestShellSnapshot) {
        latestShellSnapshot.seq = event.seq;
        latestShellSnapshot.status.seq = event.seq;
    }
    enqueueShellEvent(event);
}

function cloneShellSnapshot(snapshot: MatrixShellSnapshot): MatrixShellSnapshot {
    return {
        ...snapshot,
        status: {
            ...snapshot.status,
            ...(snapshot.status.account ? { account: { ...snapshot.status.account } } : {}),
            ...(snapshot.status.error ? { error: { ...snapshot.status.error } } : {})
        },
        ...(snapshot.account ? { account: { ...snapshot.account } } : {}),
        rooms: snapshot.rooms.map(room => ({
            ...room,
            parentIds: [...room.parentIds],
            childIds: [...room.childIds],
            spaceChildren: room.spaceChildren.map(child => ({ ...child }))
        }))
    };
}

function updateShellSnapshotCache(event: MatrixBridgeEvent): void {
    if (event.type === "snapshot") {
        latestShellSnapshot = projectShellSnapshot(event.snapshot);
        shellSnapshotDirty = false;
        return;
    }
    if (event.type === "status"
        && (event.status.state === "logged_out" || (event.status.state === "error" && !hasLiveWorker()))) {
        latestShellSnapshot = {
            seq: event.seq,
            revision: 0,
            status: projectShellStatus(event.status),
            ...(event.status.account ? { account: { ...event.status.account } } : {}),
            rooms: []
        };
        shellSnapshotDirty = false;
        return;
    }
    if (!latestShellSnapshot) return;
    latestShellSnapshot.seq = event.seq;
    latestShellSnapshot.status.seq = event.seq;
    if (event.type === "status") {
        if (latestShellSnapshot.account?.userId !== event.status.account?.userId) {
            latestShellSnapshot = null;
            shellSnapshotDirty = true;
            return;
        }
        latestShellSnapshot.status = projectShellStatus(event.status);
        latestShellSnapshot.account = event.status.account ? { ...event.status.account } : undefined;
        return;
    }
    if (event.type === "room") {
        const projected = projectShellRoom(event.room);
        const index = latestShellSnapshot.rooms.findIndex(room => room.roomId === projected.roomId);
        if (index < 0) latestShellSnapshot.rooms.push(projected);
        else latestShellSnapshot.rooms[index] = projected;
        return;
    }
    shellSnapshotDirty = true;
}

function serverNameFromMatrixIdentifier(identifier: string): string {
    const separator = identifier.indexOf(":");
    if (separator < 1 || separator === identifier.length - 1) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix identifier has no server name.");
    }
    return identifier.slice(separator + 1);
}

function validateLocalRoomAddress(value: unknown, serverName: string): string {
    const address = validateString(value, "roomAddress", 1_024).trim();
    if (/^![^\s:\u0000-\u001f\u007f]+$/u.test(address)) {
        // Opaque room-v12 IDs are domainless and are routed through the
        // configured account homeserver by the isolated backend.
        return address;
    }
    if (!/^[#!][^\s:\u0000-\u001f\u007f]+:[^\s\u0000-\u001f\u007f]+$/u.test(address)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Enter a full room alias or room ID.");
    }
    if (serverNameFromMatrixIdentifier(address) !== serverName) {
        throw bridgeError("MATRIX_REMOTE_ROOM_REJECTED", "Only rooms hosted on this account's Matrix server can be added manually.");
    }
    return address;
}

function validateEventId(value: unknown): string {
    const eventId = validateString(value, "eventId", 2_048);
    if (!eventId.startsWith("$") || /[\s\u0000-\u001f\u007f]/u.test(eventId)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix event ID is invalid.");
    }
    return eventId;
}

function protocolRoomId(value: unknown): string {
    try {
        return validateRoomId(value);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend returned an invalid room ID.");
    }
}

function protocolString(value: unknown, label: string, maximum: number): string {
    if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    return value;
}

function protocolObjectKeys(
    value: unknown,
    label: string,
    allowed: readonly string[],
    required: readonly string[] = allowed
): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    const record = value as Record<string, unknown>;
    const allowedKeys = new Set(allowed);
    if (Object.keys(record).some(key => !allowedKeys.has(key))
        || required.some(key => !Object.hasOwn(record, key))) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response contained invalid fields.`);
    }
    return record;
}

function protocolText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    return value;
}

function protocolEventId(value: unknown): string {
    try {
        return validateEventId(value);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend returned an invalid event ID.");
    }
}

function protocolMessageEventId(value: unknown, roomId: string, pending: unknown): string {
    if (typeof value === "string" && pending === true) {
        const prefix = `~${roomId}:`;
        const transactionId = value.startsWith(prefix) ? value.slice(prefix.length) : "";
        if (value.length <= 2_048 && transactionId.length <= 128 && /^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
            return value;
        }
    }
    return protocolEventId(value);
}

function protocolUserId(value: unknown): string {
    try {
        return validateUserId(value);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend returned an invalid user ID.");
    }
}

function protocolOptionalBoolean(value: unknown, label: string): boolean | undefined {
    if (value == null) return undefined;
    if (typeof value !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    return value;
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

function protocolAttachmentGroup(value: unknown): MatrixAttachmentGroupDTO {
    const group = parsedAttachmentGroup(value);
    if (!group) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment group response was invalid.");
    }
    return group;
}

function validateAttachmentGroup(value: unknown): MatrixAttachmentGroupDTO {
    const group = parsedAttachmentGroup(value);
    if (!group) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Matrix attachment group is invalid.");
    }
    return group;
}

function protocolCursor(value: unknown, prefix: "h" | "s"): string {
    if (typeof value !== "string" || !new RegExp(`^${prefix}_[0-9a-f]{32}$`, "u").test(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend returned an invalid cursor.");
    }
    return value;
}

function validateCursor(value: unknown, prefix: "h" | "s"): string {
    if (typeof value !== "string" || !new RegExp(`^${prefix}_[0-9a-f]{32}$`, "u").test(value)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix cursor is invalid or has expired.");
    }
    return value;
}

function protocolAttachmentUrl(value: unknown, label: string): string {
    const input = protocolText(value, label, 4_096);
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    const loopbackHttp = url.protocol === "http:"
        && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.hash
        || /[\u0000-\u001f\u007f]/u.test(input)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    return input;
}

function validateProtocolAttachment(value: unknown): MatrixAttachmentDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment response was invalid.");
    }
    const raw = value as Partial<MatrixAttachmentDTO>;
    const name = protocolText(raw.name, "message attachment name", 255);
    if (/[\u0000-\u001f\u007f\\/]/u.test(name)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment name was invalid.");
    }
    const attachment: MatrixAttachmentDTO = { name };
    if (raw.mimeType != null) {
        const mimeType = protocolText(raw.mimeType, "message attachment MIME type", 128).toLowerCase();
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment MIME type was invalid.");
        }
        attachment.mimeType = mimeType;
    }
    if (raw.size != null) {
        if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > 1024 ** 4) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment size was invalid.");
        }
        attachment.size = raw.size;
    }
    const { width, height } = raw;
    if ((width == null) !== (height == null)
        || (width != null && (!Number.isSafeInteger(width) || width < 1 || width > MAX_IMAGE_DIMENSION))
        || (height != null && (!Number.isSafeInteger(height) || height < 1 || height > MAX_IMAGE_DIMENSION))
        || (width != null && height != null && width * height > MAX_IMAGE_PIXELS)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment dimensions were invalid.");
    }
    if (width != null && height != null) {
        attachment.width = width;
        attachment.height = height;
    }
    for (const field of ["animated", "downloadable", "encrypted"] as const) {
        const flag = protocolOptionalBoolean(raw[field], `message attachment ${field} flag`);
        if (flag != null) attachment[field] = flag;
    }
    if (raw.url != null) attachment.url = protocolAttachmentUrl(raw.url, "message attachment URL");
    if (raw.thumbnailUrl != null) {
        attachment.thumbnailUrl = protocolAttachmentUrl(raw.thumbnailUrl, "message attachment thumbnail URL");
    }
    return attachment;
}

function validateProtocolReaction(value: unknown): MatrixReactionDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reaction response was invalid.");
    }
    const raw = value as Partial<MatrixReactionDTO>;
    const key = protocolText(raw.key, "message reaction key", 128);
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reaction key was invalid.");
    }
    const { count } = raw;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 1_000_000
        || typeof raw.me !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reaction response was invalid.");
    }
    const reaction: MatrixReactionDTO = { key, count, me: raw.me };
    if (raw.eventId != null) {
        if (!raw.me) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reaction response was inconsistent.");
        }
        reaction.eventId = protocolEventId(raw.eventId);
    }
    return reaction;
}

function validateProtocolMessage(value: unknown, expectedRoomId?: string): MatrixMessageDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message response was invalid.");
    }
    const raw = value as Partial<MatrixMessageDTO>;
    const roomId = protocolRoomId(raw.roomId);
    if (expectedRoomId && roomId !== expectedRoomId) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message response referenced an unexpected room.");
    }
    const { timestamp } = raw;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)
        || timestamp < 0 || timestamp > 4_102_444_800_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message timestamp was invalid.");
    }
    const message: MatrixMessageDTO = {
        eventId: protocolMessageEventId(raw.eventId, roomId, raw.pending),
        roomId,
        senderId: protocolUserId(raw.senderId),
        timestamp,
        body: protocolText(raw.body, "message body", 65_536, true)
    };
    if (raw.senderName != null) {
        const senderName = protocolText(raw.senderName, "message sender name", 256);
        if (/[\u0000-\u001f\u007f]/u.test(senderName)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message sender name was invalid.");
        }
        message.senderName = senderName;
    }
    if (raw.mentionedUserIds != null) {
        if (!Array.isArray(raw.mentionedUserIds)
            || raw.mentionedUserIds.length < 1
            || raw.mentionedUserIds.length > MAX_MATRIX_MESSAGE_MENTIONS) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message mentions response was invalid.");
        }
        message.mentionedUserIds = raw.mentionedUserIds.map(protocolUserId);
        if (new Set(message.mentionedUserIds).size !== message.mentionedUserIds.length) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message mentions response contained duplicates.");
        }
    }
    if (raw.sticker != null) {
        if (raw.sticker !== true) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message sticker flag was invalid.");
        }
        message.sticker = true;
    }
    if (raw.formattedBody != null) {
        message.formattedBody = protocolText(raw.formattedBody, "formatted message body", 131_072, true);
    }
    for (const field of ["edited", "decryptionFailure", "pending", "failed"] as const) {
        const flag = protocolOptionalBoolean(raw[field], `message ${field} flag`);
        if (flag != null) message[field] = flag;
    }
    if (message.failed && !message.pending) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message send-state response was inconsistent.");
    }
    if (raw.replyToEventId != null) message.replyToEventId = protocolEventId(raw.replyToEventId);
    if (raw.transactionId != null) {
        const transactionId = protocolText(raw.transactionId, "message transaction ID", 128);
        if (!/^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message transaction ID was invalid.");
        }
        message.transactionId = transactionId;
    }
    if (message.eventId.startsWith("~")
        && message.transactionId !== message.eventId.slice(`~${roomId}:`.length)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix local message identity was inconsistent.");
    }
    if (raw.attachments != null) {
        if (!Array.isArray(raw.attachments) || raw.attachments.length < 1 || raw.attachments.length > 10) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachments response was invalid.");
        }
        message.attachments = raw.attachments.map(validateProtocolAttachment);
    }
    if (raw.attachmentGroup != null) {
        if (!message.attachments?.length || message.sticker) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message attachment group response was inconsistent.");
        }
        message.attachmentGroup = protocolAttachmentGroup(raw.attachmentGroup);
    }
    if (raw.reactions != null) {
        if (!Array.isArray(raw.reactions) || raw.reactions.length < 1 || raw.reactions.length > 100) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reactions response was invalid.");
        }
        message.reactions = raw.reactions.map(validateProtocolReaction);
        if (new Set(message.reactions.map(reaction => reaction.key)).size !== message.reactions.length) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message reactions response contained duplicates.");
        }
    }
    return message;
}

function validateProtocolMessageList(
    value: unknown,
    label: string,
    maximum: number,
    expectedRoomId: string
): MatrixMessageDTO[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    const messages = value.map(item => validateProtocolMessage(item, expectedRoomId));
    if (new Set(messages.map(message => message.eventId)).size !== messages.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response contained duplicate events.`);
    }
    return messages;
}

function protocolRoomKind(value: unknown): MatrixRoomKind {
    if (value !== "space" && value !== "room" && value !== "dm") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room kind response was invalid.");
    }
    return value;
}

function protocolJoinRule(value: unknown): MatrixRoomJoinRule | undefined {
    if (value == null) return undefined;
    if (value !== "public" && value !== "invite" && value !== "knock"
        && value !== "restricted" && value !== "knock_restricted" && value !== "private") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room join-rule response was invalid.");
    }
    return value;
}

function protocolRoomIds(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > 1_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    const result = value.map(protocolRoomId);
    if (new Set(result).size !== result.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response contained duplicates.`);
    }
    return result;
}

function protocolSpaceChildren(value: unknown): MatrixSpaceChildDTO[] {
    if (!Array.isArray(value) || value.length > 1_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space-child response was invalid.");
    }
    const result = value.map(raw => {
        if (!raw || typeof raw !== "object") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space-child response was invalid.");
        }
        const child = raw as Partial<MatrixSpaceChildDTO>;
        const roomId = protocolRoomId(child.roomId);
        let order: string | undefined;
        if (child.order != null) {
            if (typeof child.order !== "string" || child.order.length > 50 || !/^[\u0020-\u007e]*$/u.test(child.order)) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space-child order was invalid.");
            }
            order = child.order;
        }
        if (child.suggested != null && typeof child.suggested !== "boolean") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space-child suggested flag was invalid.");
        }
        return { roomId, order, suggested: child.suggested };
    });
    if (new Set(result.map(child => child.roomId)).size !== result.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space-child response contained duplicates.");
    }
    return result;
}

function protocolMediaUrl(value: unknown): string | undefined {
    if (value == null) return undefined;
    const input = protocolString(value, "space avatar URL", 4_096);
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space avatar URL was invalid.");
    }
    const loopbackHttp = url.protocol === "http:"
        && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.hash) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space avatar URL was invalid.");
    }
    return input;
}

function validateProtocolPublicRoom(value: unknown): MatrixPublicRoomDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room response was invalid.");
    }
    const raw = value as Partial<MatrixPublicRoomDTO>;
    const roomId = protocolRoomId(raw.roomId);
    const name = protocolText(raw.name, "public room name", 256);
    if (/[\u0000-\u001f\u007f]/u.test(name)
        || !Number.isSafeInteger(raw.joinedMembers) || raw.joinedMembers! < 0 || raw.joinedMembers! > 1_000_000_000
        || typeof raw.worldReadable !== "boolean" || typeof raw.guestCanJoin !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room response was invalid.");
    }
    const room: MatrixPublicRoomDTO = {
        roomId,
        name,
        joinedMembers: raw.joinedMembers!,
        worldReadable: raw.worldReadable,
        guestCanJoin: raw.guestCanJoin
    };
    if (raw.alias != null) {
        const alias = protocolText(raw.alias, "public room alias", 1_024);
        if (!/^#[^\s:]+:[^\s]+$/u.test(alias)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room alias was invalid.");
        }
        room.alias = alias;
    }
    if (raw.topic != null) {
        const topic = protocolText(raw.topic, "public room topic", 2_048);
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room topic was invalid.");
        }
        room.topic = topic;
    }
    if (raw.avatarUrl != null) room.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    if (raw.joinRule != null) {
        if (raw.joinRule !== "public" && raw.joinRule !== "knock") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room join rule was invalid.");
        }
        room.joinRule = raw.joinRule;
    }
    if (raw.roomType != null) {
        if (raw.roomType !== "m.space") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room type was unsupported.");
        }
        room.roomType = raw.roomType;
    }
    return room;
}

function validateProtocolPublicRoomDirectory(value: unknown): MatrixPublicRoomDirectoryDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room directory response was invalid.");
    }
    const raw = value as Partial<MatrixPublicRoomDirectoryDTO>;
    if (!Array.isArray(raw.rooms) || raw.rooms.length > 2_000 || typeof raw.truncated !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room directory response was invalid.");
    }
    const rooms = raw.rooms.map(validateProtocolPublicRoom);
    if (new Set(rooms.map(room => room.roomId)).size !== rooms.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room directory contained duplicate rooms.");
    }
    const directory: MatrixPublicRoomDirectoryDTO = { rooms, truncated: raw.truncated };
    if (raw.totalRoomCountEstimate != null) {
        if (!Number.isSafeInteger(raw.totalRoomCountEstimate)
            || raw.totalRoomCountEstimate < 0 || raw.totalRoomCountEstimate > 1_000_000_000) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix public room count estimate was invalid.");
        }
        directory.totalRoomCountEstimate = raw.totalRoomCountEstimate;
    }
    return directory;
}

function validateProtocolMember(value: unknown): MatrixMemberDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room member response was invalid.");
    }
    const raw = value as Partial<MatrixMemberDTO>;
    const membership = protocolText(raw.membership, "room member membership", 32);
    if (/[\u0000-\u001f\u007f]/u.test(membership)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room member membership was invalid.");
    }
    const member: MatrixMemberDTO = { userId: protocolUserId(raw.userId), membership };
    if (raw.displayName != null) {
        const displayName = protocolText(raw.displayName, "room member display name", 256);
        if (/[\u0000-\u001f\u007f]/u.test(displayName)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room member display name was invalid.");
        }
        member.displayName = displayName;
    }
    if (raw.avatarUrl != null) member.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    if (raw.powerLevel != null) {
        if (typeof raw.powerLevel !== "number" || !Number.isSafeInteger(raw.powerLevel)
            || raw.powerLevel < -1_000 || raw.powerLevel > 1_000) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room member power level was invalid.");
        }
        member.powerLevel = raw.powerLevel;
    }
    return member;
}

function protocolNotificationCount(value: unknown, label: string): number | undefined {
    if (value == null) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    return value;
}

function validateProtocolPowerLevelPermission(
    value: unknown,
    label: string
): MatrixPowerLevelPermissionDTO {
    const raw = protocolObjectKeys(value, label, ["current", "required", "allowed"]);
    const currentValid = raw.current === "infinite" || raw.current === "unverifiable"
        || (typeof raw.current === "number" && Number.isSafeInteger(raw.current));
    const requiredValid = raw.required === "unverifiable"
        || (typeof raw.required === "number" && Number.isSafeInteger(raw.required));
    if (!currentValid || !requiredValid || typeof raw.allowed !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was invalid.`);
    }
    const comparable = raw.current !== "unverifiable" && raw.required !== "unverifiable";
    const expectedAllowed = comparable && (raw.current === "infinite"
        || Number(raw.current) >= Number(raw.required));
    if (raw.allowed !== expectedAllowed) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix ${label} response was inconsistent.`);
    }
    return {
        current: raw.current as MatrixPowerLevelPermissionDTO["current"],
        required: raw.required as MatrixPowerLevelPermissionDTO["required"],
        allowed: raw.allowed
    };
}

function validateProtocolRoom(value: unknown): MatrixRoomDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room response was invalid.");
    }
    const raw = value as Partial<MatrixRoomDTO>;
    const roomId = protocolRoomId(raw.roomId);
    if (!Number.isSafeInteger(raw.timelineGeneration) || raw.timelineGeneration! < 0) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room timeline generation was invalid.");
    }
    const name = protocolText(raw.name, "room name", 256);
    if (/[\u0000-\u001f\u007f]/u.test(name)
        || (raw.membership !== "join" && raw.membership !== "invite")
        || typeof raw.encrypted !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room response was invalid.");
    }
    const kind = protocolRoomKind(raw.kind);
    const joinRule = protocolJoinRule(raw.joinRule);
    if (!joinRule) throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room join-rule response was invalid.");
    const parentIds = protocolRoomIds(raw.parentIds, "room parents");
    const childIds = protocolRoomIds(raw.childIds, "room children");
    const spaceChildren = protocolSpaceChildren(raw.spaceChildren);
    if (childIds.length !== spaceChildren.length
        || childIds.some((childId, index) => childId !== spaceChildren[index].roomId)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room child relations were inconsistent.");
    }
    if (!Array.isArray(raw.members) || raw.members.length > 2_000
        || !Array.isArray(raw.messages) || raw.messages.length > 100) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room collections response was invalid.");
    }
    const members = raw.members.map(validateProtocolMember);
    if (new Set(members.map(member => member.userId)).size !== members.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room member response contained duplicates.");
    }
    const messages = validateProtocolMessageList(raw.messages, "room messages", 100, roomId);
    if (raw.membership === "invite" && messages.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix invited room response contained timeline messages.");
    }
    const room: MatrixRoomDTO = {
        roomId,
        timelineGeneration: raw.timelineGeneration!,
        name,
        membership: raw.membership,
        kind,
        joinRule,
        parentIds,
        childIds,
        spaceChildren,
        encrypted: raw.encrypted,
        members,
        messages
    };
    if (raw.groupChat !== undefined) {
        if (raw.groupChat !== true || kind !== "room"
            || raw.creatorId == null || raw.roomType != null || raw.directUserId != null
            || parentIds.length !== 0 || childIds.length !== 0) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat room response was invalid.");
        }
        room.groupChat = true;
    }
    if (raw.canManageSpaceChildren !== undefined) {
        if (kind !== "space" || typeof raw.canManageSpaceChildren !== "boolean") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space management permission was invalid.");
        }
        room.canManageSpaceChildren = raw.canManageSpaceChildren;
    }
    if (raw.spaceChildPermission !== undefined) {
        if (kind !== "space") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "A non-Space room exposed Space-child permission state.");
        }
        room.spaceChildPermission = validateProtocolPowerLevelPermission(
            raw.spaceChildPermission,
            "Space-child permission"
        );
        if (room.canManageSpaceChildren !== room.spaceChildPermission.allowed) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space-child permission response was inconsistent.");
        }
    }
    if (kind === "space" && (room.canManageSpaceChildren == null || room.spaceChildPermission == null)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space-child permission response was missing.");
    }
    const hasSpaceAccessProjection = raw.canConfigureSpaceAccess !== undefined
        || raw.accessRequestCount !== undefined
        || raw.accessRequestCountComplete !== undefined
        || raw.canApproveAccessRequests !== undefined
        || raw.canDenyAccessRequests !== undefined;
    if (kind === "space" && raw.membership === "join") {
        if (typeof raw.canConfigureSpaceAccess !== "boolean"
            || !Number.isSafeInteger(raw.accessRequestCount)
            || raw.accessRequestCount! < 0 || raw.accessRequestCount! > 200
            || typeof raw.accessRequestCountComplete !== "boolean"
            || typeof raw.canApproveAccessRequests !== "boolean"
            || typeof raw.canDenyAccessRequests !== "boolean") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access projection was invalid.");
        }
        room.canConfigureSpaceAccess = raw.canConfigureSpaceAccess;
        room.accessRequestCount = raw.accessRequestCount;
        room.accessRequestCountComplete = raw.accessRequestCountComplete;
        room.canApproveAccessRequests = raw.canApproveAccessRequests;
        room.canDenyAccessRequests = raw.canDenyAccessRequests;
        room.invitePermission = validateProtocolPowerLevelPermission(raw.invitePermission, "Space invite permission");
        if (room.canApproveAccessRequests !== room.invitePermission.allowed) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite permission response was inconsistent.");
        }
    } else if (hasSpaceAccessProjection) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "A non-joined Matrix Space exposed access-request state.");
    }
    if (raw.groupChat === true && raw.membership === "join") {
        room.invitePermission = validateProtocolPowerLevelPermission(
            raw.invitePermission,
            "group-chat invite permission"
        );
    } else if (raw.invitePermission !== undefined
        && !(kind === "space" && raw.membership === "join")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "A non-group room exposed invite permission state.");
    }
    if (raw.roomType != null) {
        const roomType = protocolText(raw.roomType, "room type", 256);
        if (/[\u0000-\u001f\u007f]/u.test(roomType)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room type response was invalid.");
        }
        room.roomType = roomType;
    }
    if (raw.creatorId != null) room.creatorId = protocolUserId(raw.creatorId);
    if (raw.directUserId != null) room.directUserId = protocolUserId(raw.directUserId);
    if (raw.inviterId != null) room.inviterId = protocolUserId(raw.inviterId);
    if (raw.avatarUrl != null) room.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    if (raw.topic != null) {
        const topic = protocolText(raw.topic, "room topic", 2_048);
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room topic response was invalid.");
        }
        room.topic = topic;
    }
    if (raw.prevToken != null) {
        const prevToken = protocolText(raw.prevToken, "room history token", 4_096);
        if (/[\u0000-\u001f\u007f]/u.test(prevToken)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room history token was invalid.");
        }
        room.prevToken = prevToken;
    }
    const unreadCount = protocolNotificationCount(raw.unreadCount, "room unread count");
    const highlightCount = protocolNotificationCount(raw.highlightCount, "room highlight count");
    if (unreadCount != null) room.unreadCount = unreadCount;
    if (highlightCount != null) room.highlightCount = highlightCount;
    return room;
}

function validateProtocolStatus(value: unknown): MatrixBridgeStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix status response was invalid.");
    }
    const raw = value as Partial<MatrixBridgeStatus>;
    if (!Number.isSafeInteger(raw.seq) || raw.seq! < 0
        || (raw.state !== "logged_out" && raw.state !== "stopped" && raw.state !== "starting"
            && raw.state !== "syncing" && raw.state !== "ready" && raw.state !== "error")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix status response was invalid.");
    }
    const status: MatrixBridgeStatus = { seq: raw.seq!, state: raw.state };
    if (raw.account != null) {
        if (typeof raw.account !== "object" || Array.isArray(raw.account)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix status account response was invalid.");
        }
        status.account = { userId: protocolUserId(raw.account.userId) };
    }
    if (raw.error != null) {
        if (typeof raw.error !== "object" || Array.isArray(raw.error)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix status error response was invalid.");
        }
        const code = protocolText(raw.error.code, "status error code", 128);
        const message = protocolText(raw.error.message, "status error message", 300);
        const causeCode = raw.error.causeCode == null
            ? undefined
            : protocolText(raw.error.causeCode, "status error cause code", 128);
        if (!MATRIX_ERROR_CODE_PATTERN.test(code)
            || (causeCode != null && !MATRIX_ERROR_CODE_PATTERN.test(causeCode))
            || /[\u0000-\u001f\u007f]/u.test(message)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix status error response was invalid.");
        }
        status.error = { code, message, ...(causeCode ? { causeCode } : {}) };
    }
    return status;
}

function validateProtocolSnapshot(value: unknown): MatrixSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot response was invalid.");
    }
    const raw = value as Partial<MatrixSnapshot>;
    if (!Number.isSafeInteger(raw.seq) || raw.seq! < 0
        || !Number.isSafeInteger(raw.revision) || raw.revision! < 0
        || !Array.isArray(raw.rooms) || raw.rooms.length > 250) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot response was invalid.");
    }
    const status = validateProtocolStatus(raw.status);
    const rooms = raw.rooms.map(validateProtocolRoom);
    if (new Set(rooms.map(room => room.roomId)).size !== rooms.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot response contained duplicate rooms.");
    }
    const totalMessages = rooms.reduce((total, room) => total + room.messages.length, 0);
    const totalMembers = rooms.reduce((total, room) => total + room.members.length, 0);
    if (totalMessages > 1_000 || totalMembers > 2_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot response exceeded its aggregate limits.");
    }
    const snapshot: MatrixSnapshot = { seq: raw.seq!, revision: raw.revision!, status, rooms };
    if (raw.account != null) {
        if (typeof raw.account !== "object" || Array.isArray(raw.account)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot account response was invalid.");
        }
        snapshot.account = { userId: protocolUserId(raw.account.userId) };
    }
    if (snapshot.account && status.account && snapshot.account.userId !== status.account.userId) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot account response was inconsistent.");
    }
    return snapshot;
}

function protocolTimelineEventId(value: unknown, roomId: string): string {
    if (typeof value === "string") {
        const prefix = `~${roomId}:`;
        const transactionId = value.startsWith(prefix) ? value.slice(prefix.length) : "";
        if (value.length <= 2_048 && transactionId.length <= 128 && /^[A-Za-z0-9._~-]+$/u.test(transactionId)) {
            return value;
        }
    }
    return protocolEventId(value);
}

function validateProtocolReactionList(value: unknown): MatrixReactionDTO[] {
    if (!Array.isArray(value) || value.length > 100) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix reaction event response was invalid.");
    }
    const reactions = value.map(validateProtocolReaction);
    if (new Set(reactions.map(reaction => reaction.key)).size !== reactions.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix reaction event response contained duplicates.");
    }
    return reactions;
}

function validateWorkerEvent(value: unknown): MatrixWorkerEvent {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend event was invalid.");
    }
    const raw = value as Record<string, unknown>;
    switch (raw.type) {
        case "status": return { type: "status", status: validateProtocolStatus(raw.status) };
        case "snapshot": return { type: "snapshot", snapshot: validateProtocolSnapshot(raw.snapshot) };
        case "room": return { type: "room", room: validateProtocolRoom(raw.room) };
        case "message": {
            const roomId = protocolRoomId(raw.roomId);
            return { type: "message", roomId, message: validateProtocolMessage(raw.message, roomId) };
        }
        case "edit": {
            const roomId = protocolRoomId(raw.roomId);
            const eventId = protocolTimelineEventId(raw.eventId, roomId);
            const message = raw.message == null ? undefined : validateProtocolMessage(raw.message, roomId);
            if (message && message.eventId !== eventId) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix edit event response was inconsistent.");
            }
            return { type: "edit", roomId, eventId, ...(message ? { message } : {}) };
        }
        case "redact": {
            const roomId = protocolRoomId(raw.roomId);
            return { type: "redact", roomId, eventId: protocolTimelineEventId(raw.eventId, roomId) };
        }
        case "reaction": {
            const roomId = protocolRoomId(raw.roomId);
            return {
                type: "reaction",
                roomId,
                eventId: protocolTimelineEventId(raw.eventId, roomId),
                reactions: validateProtocolReactionList(raw.reactions)
            };
        }
        case "typing": {
            const roomId = protocolRoomId(raw.roomId);
            if (!Array.isArray(raw.userIds) || raw.userIds.length > 2_000) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix typing event response was invalid.");
            }
            const userIds = raw.userIds.map(protocolUserId);
            if (new Set(userIds).size !== userIds.length) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix typing event response contained duplicates.");
            }
            return { type: "typing", roomId, userIds };
        }
        case "receipt": {
            const roomId = protocolRoomId(raw.roomId);
            return {
                type: "receipt",
                roomId,
                userId: protocolUserId(raw.userId),
                ...(raw.eventId == null ? {} : { eventId: protocolTimelineEventId(raw.eventId, roomId) })
            };
        }
        default: throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix backend event type was invalid.");
    }
}

function validateRoomActionResult(value: unknown, expectedRoomId: string): MatrixRoomActionResult {
    const raw = protocolObjectKeys(
        value,
        "room action response",
        ["roomId", "warning"],
        ["roomId"]
    );
    const roomId = protocolRoomId(raw.roomId);
    if (roomId !== expectedRoomId) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room action returned an unexpected room.");
    }
    if (raw.warning == null) return { roomId };
    const warning = protocolObjectKeys(
        raw.warning,
        "room action warning",
        ["code", "message"],
        ["code", "message"]
    );
    if (warning.code !== "MATRIX_DM_CLASSIFICATION_FAILED") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room action warning was invalid.");
    }
    return {
        roomId,
        warning: {
            code: warning.code,
            message: protocolText(warning.message, "room action warning message", 512)
        }
    };
}

function validateHierarchyRoom(value: unknown): MatrixSpaceHierarchyRoomDTO {
    if (!value || typeof value !== "object") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space hierarchy room was invalid.");
    }
    const raw = value as Partial<MatrixSpaceHierarchyRoomDTO>;
    const roomId = protocolRoomId(raw.roomId);
    const name = protocolString(raw.name, "space room name", 1_024);
    const kind = protocolRoomKind(raw.kind);
    const parentIds = protocolRoomIds(raw.parentIds, "space parents");
    const childIds = protocolRoomIds(raw.childIds, "space children");
    const spaceChildren = protocolSpaceChildren(raw.spaceChildren);
    if (childIds.length !== spaceChildren.length
        || childIds.some((childId, index) => childId !== spaceChildren[index].roomId)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space child relations were inconsistent.");
    }
    const { membership } = raw;
    if (membership != null && membership !== "join" && membership !== "invite" && membership !== "leave") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room membership response was invalid.");
    }
    const joinRule = protocolJoinRule(raw.joinRule);
    const roomType = raw.roomType == null ? undefined : protocolString(raw.roomType, "room type", 256);
    const topic = raw.topic == null ? undefined : protocolString(raw.topic, "space topic", 2_048);
    const avatarUrl = protocolMediaUrl(raw.avatarUrl);
    return {
        roomId,
        name,
        kind,
        roomType,
        membership,
        joinRule,
        parentIds,
        childIds,
        spaceChildren,
        avatarUrl,
        topic
    };
}

function validateSpaceHierarchy(value: unknown, expectedSpaceId: string): MatrixSpaceHierarchyDTO {
    if (!value || typeof value !== "object") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space hierarchy response was invalid.");
    }
    const raw = value as Partial<MatrixSpaceHierarchyDTO>;
    const spaceId = protocolRoomId(raw.spaceId);
    if (spaceId !== expectedSpaceId || !Array.isArray(raw.rooms) || raw.rooms.length > 200) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space hierarchy response was invalid.");
    }
    const rooms = raw.rooms.map(validateHierarchyRoom);
    if (new Set(rooms.map(room => room.roomId)).size !== rooms.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix space hierarchy contained duplicate rooms.");
    }
    return { spaceId, rooms };
}

function protocolSuggestedSpaceChannel(
    value: unknown,
    spaceId: string,
    priorCategories: Set<string>,
    seen: Set<string>
): MatrixSuggestedSpaceChannelDTO {
    const raw = protocolObjectKeys(
        value,
        "suggested Space channel",
        ["roomId", "parentSpaceId", "name", "kind", "depth", "membership", "joinRule", "avatarUrl", "topic"],
        ["roomId", "parentSpaceId", "name", "kind", "depth", "membership", "joinRule"]
    );
    const roomId = protocolRoomId(raw.roomId);
    const parentSpaceId = protocolRoomId(raw.parentSpaceId);
    const joinRule = protocolJoinRule(raw.joinRule);
    if (roomId === spaceId || roomId === parentSpaceId || seen.has(roomId)
        || (raw.kind !== "space" && raw.kind !== "room")
        || (raw.depth !== 1 && raw.depth !== 2) || (raw.membership !== "join" && raw.membership !== "leave")
        || !joinRule
        || (raw.membership === "leave" && joinRule !== "public"
            && joinRule !== "restricted" && joinRule !== "knock_restricted")
        || (raw.depth === 1 ? parentSpaceId !== spaceId : !priorCategories.has(parentSpaceId))
        || (raw.kind === "space" && raw.depth !== 1)
        || (raw.membership === "join" && raw.kind !== "space")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The suggested Matrix Space channel response was invalid.");
    }
    seen.add(roomId);
    if (raw.kind === "space") priorCategories.add(roomId);
    const result: MatrixSuggestedSpaceChannelDTO = {
        roomId,
        parentSpaceId,
        name: protocolText(raw.name, "suggested Space channel name", 1_024),
        kind: raw.kind,
        depth: raw.depth,
        membership: raw.membership,
        joinRule
    };
    if (raw.avatarUrl != null) result.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    if (raw.topic != null) result.topic = protocolText(raw.topic, "suggested Space channel topic", 2_048);
    return result;
}

function validateProtocolSuggestedSpaceChannelPlan(
    value: unknown,
    expectedSpaceId: string
): MatrixSuggestedSpaceChannelPlanDTO {
    const raw = protocolObjectKeys(
        value,
        "suggested Space channel plan",
        ["spaceId", "planId", "scope", "channels", "limited", "complete"],
        ["spaceId", "planId", "scope", "channels", "limited", "complete"]
    );
    const spaceId = protocolRoomId(raw.spaceId);
    const planId = protocolString(raw.planId, "suggested Space channel plan ID", 69);
    if (spaceId !== expectedSpaceId || !/^vcsp_[0-9a-f]{64}$/u.test(planId)
        || raw.scope !== "suggested_depth_2_via_account_server"
        || !Array.isArray(raw.channels) || raw.channels.length > 16
        || typeof raw.limited !== "boolean" || raw.complete !== false) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The suggested Matrix Space channel plan was invalid.");
    }
    const categories = new Set<string>();
    const seen = new Set<string>();
    const channels = raw.channels.map(channel =>
        protocolSuggestedSpaceChannel(channel, spaceId, categories, seen));
    return {
        spaceId,
        planId,
        scope: "suggested_depth_2_via_account_server",
        channels,
        limited: raw.limited,
        complete: false
    };
}

function validateJoinSuggestedSpaceChannelsRequest(value: unknown): MatrixJoinSuggestedSpaceChannelsRequest {
    const raw = exactObjectKeys(value, "suggested Space channel join", ["spaceId", "planId"]);
    const planId = validateString(raw.planId, "suggested Space channel plan ID", 69);
    if (!/^vcsp_[0-9a-f]{64}$/u.test(planId)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The suggested Matrix Space channel plan is invalid.");
    }
    return { spaceId: validateRoomId(raw.spaceId), planId };
}

function validateProtocolJoinSuggestedSpaceChannelsResult(
    value: unknown,
    request: MatrixJoinSuggestedSpaceChannelsRequest
): MatrixJoinSuggestedSpaceChannelsResult {
    const raw = protocolObjectKeys(
        value,
        "suggested Space channel join result",
        ["spaceId", "planId", "outcomes", "limited", "complete"],
        ["spaceId", "planId", "outcomes", "limited", "complete"]
    );
    const spaceId = protocolRoomId(raw.spaceId);
    const planId = protocolString(raw.planId, "suggested Space channel plan ID", 69);
    if (spaceId !== request.spaceId || planId !== request.planId || !Array.isArray(raw.outcomes)
        || raw.outcomes.length > 16 || typeof raw.limited !== "boolean" || raw.complete !== false) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The suggested Matrix Space channel join result was invalid.");
    }
    const seen = new Set<string>();
    const outcomes = raw.outcomes.map(value => {
        const outcome = protocolObjectKeys(
            value,
            "suggested Space channel join outcome",
            ["roomId", "parentSpaceId", "kind", "status"],
            ["roomId", "parentSpaceId", "kind", "status"]
        );
        const roomId = protocolRoomId(outcome.roomId);
        const parentSpaceId = protocolRoomId(outcome.parentSpaceId);
        if (seen.has(roomId) || (outcome.kind !== "space" && outcome.kind !== "room")
            || (outcome.status !== "joined" && outcome.status !== "already_joined"
                && outcome.status !== "rejected" && outcome.status !== "blocked_by_parent")) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The suggested Matrix Space channel join outcome was invalid.");
        }
        seen.add(roomId);
        return {
            roomId,
            parentSpaceId,
            kind: outcome.kind as "space" | "room",
            status: outcome.status as MatrixJoinSuggestedSpaceChannelsResult["outcomes"][number]["status"]
        };
    });
    return {
        spaceId,
        planId,
        outcomes,
        limited: raw.limited,
        complete: false
    };
}

function validateStickerSendRequest(value: unknown): MatrixStickerSendRequest {
    if (!value || typeof value !== "object") {
        throw bridgeError("MATRIX_INVALID_STICKER", "The Discord sticker descriptor is invalid.");
    }
    const input = value as Partial<MatrixStickerSendRequest>;
    if (typeof input.id !== "string" || !/^\d{17,20}$/u.test(input.id)) {
        throw bridgeError("MATRIX_INVALID_STICKER", "The Discord sticker ID is invalid.");
    }
    if (!Number.isSafeInteger(input.formatType) || ![1, 2, 3, 4].includes(input.formatType!)) {
        throw bridgeError("MATRIX_INVALID_STICKER", "The Discord sticker format is invalid.");
    }
    if (input.formatType === 3) {
        throw bridgeError("MATRIX_STICKER_LOTTIE_UNSUPPORTED", "Lottie stickers cannot be sent to Matrix yet.");
    }
    const name = validateString(input.name, "sticker name", 100)
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (!name) throw bridgeError("MATRIX_INVALID_STICKER", "The Discord sticker name is invalid.");
    const sticker: MatrixStickerSendRequest = {
        id: input.id,
        name,
        formatType: input.formatType as MatrixStickerSendRequest["formatType"]
    };
    if (input.replyEventId != null) sticker.replyEventId = validateEventId(input.replyEventId);
    return sticker;
}

function validateAttachmentSendRequest(value: unknown): MatrixAttachmentSendRequest {
    if (!value || typeof value !== "object") {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment upload is invalid.");
    }
    const input = value as Partial<MatrixAttachmentSendRequest>;
    const name = validateString(input.name, "attachment name", 255);
    if (/[\u0000-\u001f\u007f\\/]/u.test(name)) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment filename is invalid.");
    }
    const txnId = validateString(input.txnId, "attachment transaction ID", 128);
    if (!/^[A-Za-z0-9._~-]+$/u.test(txnId)) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Matrix attachment transaction ID is invalid.");
    }
    if (!(input.bytes instanceof Uint8Array) || !(input.bytes.buffer instanceof ArrayBuffer)
        || input.bytes.byteLength < 1
        || input.bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment is empty or too large to upload.");
    }

    let declaredMimeType: string | undefined;
    if (input.declaredMimeType != null && input.declaredMimeType !== "") {
        declaredMimeType = validateString(input.declaredMimeType, "attachment MIME type", 128).toLowerCase();
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(declaredMimeType)) {
            throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment MIME type is invalid.");
        }
    }

    const caption = input.caption == null || input.caption === ""
        ? undefined
        : validateString(input.caption, "attachment caption", 65_536);
    const width = input.width == null ? undefined : Number(input.width);
    const height = input.height == null ? undefined : Number(input.height);
    if ((width == null) !== (height == null)
        || (width != null && (!Number.isSafeInteger(width) || width < 1 || width > MAX_IMAGE_DIMENSION))
        || (height != null && (!Number.isSafeInteger(height) || height < 1 || height > MAX_IMAGE_DIMENSION))
        || (width != null && height != null && width * height > MAX_IMAGE_PIXELS)) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment dimensions are invalid.");
    }
    const durationMs = input.durationMs == null ? undefined : Number(input.durationMs);
    if (durationMs != null && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7 * 24 * 60 * 60_000)) {
        throw bridgeError("MATRIX_INVALID_ATTACHMENT", "The Discord attachment duration is invalid.");
    }

    return {
        name,
        txnId,
        declaredMimeType,
        // Renderer IPC already gave this process its own structured clone.
        bytes: input.bytes as Uint8Array<ArrayBuffer>,
        caption,
        width,
        height,
        durationMs,
        replyEventId: input.replyEventId == null ? undefined : validateEventId(input.replyEventId),
        attachmentGroup: input.attachmentGroup == null
            ? undefined
            : validateAttachmentGroup(input.attachmentGroup)
    };
}

function validateKlipyShareUrl(value: unknown): string {
    const input = validateString(value, "KLIPY preview URL", 2_048);
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The KLIPY preview URL is invalid.");
    }
    if (url.protocol !== "https:" || url.hostname !== "klipy.com"
        || url.username || url.password || url.port || url.search || url.hash
        || url.href !== input || !/^\/gifs\/[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u.test(url.pathname)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The KLIPY preview URL is invalid.");
    }
    return url.href;
}

function responseHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function requestKlipyPreview(url: string): Promise<string | undefined> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (value?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        let request: Electron.ClientRequest;
        try {
            request = net.request({
                method: "GET",
                url,
                partition: WORKER_PARTITION,
                bypassCustomProtocolHandlers: true,
                cache: "no-store",
                credentials: "omit",
                useSessionCookies: false,
                redirect: "error",
                referrerPolicy: "no-referrer"
            });
            // ClientRequest permits User-Agent while fetch treats it as a forbidden
            // header and silently substitutes Electron's default in some releases.
            request.setHeader("Accept", "text/html");
            request.setHeader("User-Agent", KLIPY_PREVIEW_USER_AGENT);
        } catch {
            settled = true;
            resolve(undefined);
            return;
        }

        const timer = setTimeout(() => {
            request.abort();
            finish();
        }, KLIPY_PREVIEW_TIMEOUT_MS);
        request.on("redirect", () => {
            request.abort();
            finish();
        });
        request.on("error", () => finish());
        request.on("response", response => {
            const contentType = responseHeader(response.headers, "content-type")
                ?.split(";", 1)[0]
                .trim()
                .toLowerCase();
            const contentLength = responseHeader(response.headers, "content-length");
            if (response.statusCode !== 200 || contentType !== "text/html"
                || (contentLength && /^\d+$/u.test(contentLength)
                    && Number.isSafeInteger(Number(contentLength))
                    && Number(contentLength) > MAX_KLIPY_PREVIEW_HTML_BYTES)) {
                request.abort();
                finish();
                return;
            }

            const chunks: Buffer[] = [];
            let length = 0;
            // Electron requires the end listener to be installed before data starts
            // flowing from its IncomingMessage implementation.
            response.on("end", () => {
                if (settled) return;
                try {
                    finish(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
                } catch {
                    finish();
                }
            });
            response.on("aborted", () => finish());
            response.on("error", () => finish());
            response.on("data", chunk => {
                if (settled) return;
                length += chunk.byteLength;
                if (length > MAX_KLIPY_PREVIEW_HTML_BYTES) {
                    request.abort();
                    finish();
                    return;
                }
                chunks.push(Buffer.from(chunk));
            });
        });
        request.end();
    });
}

function assertSecureStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) {
        throw bridgeError("MATRIX_SECURE_STORAGE_UNAVAILABLE", "OS-backed secure storage is unavailable; Matrix credentials were not loaded or saved.");
    }

    if (process.platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === "basic_text" || backend === "unknown") {
            throw bridgeError("MATRIX_SECURE_STORAGE_UNAVAILABLE", "A secure Linux keyring is required to store Matrix credentials.");
        }
    }
}

function isStoredAccount(value: unknown): value is MatrixStoredAccount {
    if (!value || typeof value !== "object") return false;
    const account = value as Partial<MatrixStoredAccount>;
    return account.schema === 1
        && typeof account.homeserver === "string"
        && typeof account.userId === "string"
        && typeof account.deviceId === "string"
        && typeof account.accessToken === "string"
        && (account.refreshToken == null || typeof account.refreshToken === "string")
        && typeof account.storageKey === "string";
}

function validateStoredAccount(value: unknown): MatrixStoredAccount {
    if (!isStoredAccount(value)) {
        throw bridgeError("MATRIX_ACCOUNT_CORRUPT", "The encrypted Matrix account record is invalid.");
    }

    const account: MatrixStoredAccount = {
        schema: 1,
        homeserver: validateHomeserver(value.homeserver),
        userId: validateUserId(value.userId),
        deviceId: validateString(value.deviceId, "deviceId", 512),
        accessToken: validateString(value.accessToken, "accessToken", 65_536),
        storageKey: validateString(value.storageKey, "storageKey", 128)
    };

    if (value.refreshToken != null) account.refreshToken = validateString(value.refreshToken, "refreshToken", 65_536);
    if (Buffer.from(account.storageKey, "base64").byteLength !== 32) {
        throw bridgeError("MATRIX_ACCOUNT_CORRUPT", "The Matrix crypto storage key is invalid.");
    }

    return account;
}

async function readStoredAccount(): Promise<MatrixStoredAccount | null> {
    let encrypted: Buffer;
    try {
        encrypted = await readFile(ACCOUNT_FILE);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw bridgeError("MATRIX_ACCOUNT_READ_FAILED", "The encrypted Matrix account record could not be read.");
    }

    assertSecureStorage();
    try {
        return validateStoredAccount(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch (error) {
        if (error instanceof Error && error.name.startsWith("MATRIX_")) throw error;
        throw bridgeError("MATRIX_ACCOUNT_DECRYPT_FAILED", "The Matrix account record could not be decrypted.");
    }
}

function accountBinding(account: MatrixStoredAccount | null): MatrixAccountBinding | null {
    return account && {
        homeserver: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        storageKey: account.storageKey
    };
}

function sameAccountBinding(left: MatrixAccountBinding | null, right: MatrixAccountBinding | null): boolean {
    return left === null || right === null
        ? left === right
        : left.homeserver === right.homeserver
            && left.userId === right.userId
            && left.deviceId === right.deviceId
            && left.storageKey === right.storageKey;
}

function startupFailureForAccount(account: MatrixStoredAccount): StartupFailureLatch | null {
    const binding = accountBinding(account)!;
    if (startupFailureLatch && !sameAccountBinding(startupFailureLatch.binding, binding)) {
        startupFailureLatch = null;
    }
    return startupFailureLatch;
}

function clearStartupFailure(binding?: MatrixAccountBinding): void {
    if (!binding || (startupFailureLatch && sameAccountBinding(startupFailureLatch.binding, binding))) {
        startupFailureLatch = null;
    }
}

function spaceChildCreateLatchKey(binding: MatrixAccountBinding, parentSpaceId: string): string {
    return `${binding.homeserver}\0${binding.userId}\0${parentSpaceId}`;
}

function pendingSpaceChildCreate(value: unknown): PendingSpaceChildCreate {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT", "The pending Matrix creation state is invalid.");
    }
    const raw = value as Partial<PendingSpaceChildCreate>;
    if (Object.keys(value).length !== 4
        || !Object.keys(value).every(key => key === "homeserver" || key === "userId"
            || key === "parentSpaceId" || key === "creationMarker")) {
        throw bridgeError("MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT", "The pending Matrix creation state is invalid.");
    }
    const creationMarker = validateString(raw.creationMarker, "Space child creation marker", 73);
    if (!SPACE_CHILD_CREATION_MARKER_PATTERN.test(creationMarker)) {
        throw bridgeError("MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT", "The pending Matrix creation state is invalid.");
    }
    return {
        homeserver: validateHomeserver(raw.homeserver),
        userId: validateUserId(raw.userId),
        parentSpaceId: validateRoomId(raw.parentSpaceId),
        creationMarker
    };
}

async function loadSpaceChildCreateState(): Promise<void> {
    if (spaceChildCreateStateError) throw spaceChildCreateStateError;
    if (spaceChildCreateStateLoaded) return;
    try {
        let encrypted: Buffer;
        try {
            encrypted = await readFile(SPACE_CHILD_CREATES_FILE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                spaceChildCreateStateLoaded = true;
                return;
            }
            throw error;
        }
        if (encrypted.byteLength > MAX_GROUP_CHAT_STATE_FILE_BYTES) throw new Error("oversized");
        assertSecureStorage();
        const raw = JSON.parse(safeStorage.decryptString(encrypted)) as {
            schema?: unknown;
            entries?: unknown;
        };
        if (!raw || raw.schema !== 1 || !Array.isArray(raw.entries)
            || raw.entries.length > MAX_AMBIGUOUS_SPACE_CHILD_CREATES) {
            throw new Error("invalid");
        }
        const markers = new Set<string>();
        for (const value of raw.entries) {
            const entry = pendingSpaceChildCreate(value);
            const key = `${entry.homeserver}\0${entry.userId}\0${entry.parentSpaceId}`;
            if (ambiguousSpaceChildCreates.has(key) || markers.has(entry.creationMarker)) throw new Error("duplicate");
            ambiguousSpaceChildCreates.set(key, entry);
            markers.add(entry.creationMarker);
        }
        spaceChildCreateStateLoaded = true;
    } catch {
        spaceChildCreateStateError = bridgeError(
            "MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT",
            "The encrypted pending Matrix creation state could not be read safely."
        );
        throw spaceChildCreateStateError;
    }
}

async function saveSpaceChildCreateState(): Promise<void> {
    if (spaceChildCreateStateError) throw spaceChildCreateStateError;
    assertSecureStorage();
    let encrypted: Buffer;
    try {
        encrypted = safeStorage.encryptString(JSON.stringify({
            schema: 1,
            entries: [...ambiguousSpaceChildCreates.values()]
        }));
    } catch {
        throw bridgeError(
            "MATRIX_CREATE_SPACE_CHILD_STATE_WRITE_FAILED",
            "The pending Matrix creation state could not be encrypted."
        );
    }
    await mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
    const temporaryFile = join(ACCOUNT_DIR, `space-child-creates-${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryFile, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporaryFile, SPACE_CHILD_CREATES_FILE);
    } catch {
        await unlink(temporaryFile).catch(() => undefined);
        throw bridgeError(
            "MATRIX_CREATE_SPACE_CHILD_STATE_WRITE_FAILED",
            "The pending Matrix creation state could not be saved."
        );
    }
}

function runSpaceChildCreateState<T>(operation: () => Promise<T>): Promise<T> {
    const result = spaceChildCreateStateTail.then(operation, operation);
    spaceChildCreateStateTail = result.then(() => undefined, () => undefined);
    return result;
}

function groupChatCreateLatchKey(binding: Pick<MatrixAccountBinding, "homeserver" | "userId">): string {
    // The MXID is the durable account identity. A delegated account can be
    // configured through more than one equivalent homeserver URL, which must
    // not bypass a lost-response creation latch.
    return binding.userId;
}

function groupChatInviteLatchKey(
    binding: Pick<MatrixAccountBinding, "userId">,
    roomId: string
): string {
    return JSON.stringify([binding.userId, roomId]);
}

function pendingGroupChatCreate(value: unknown): PendingGroupChatCreate {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT", "The pending Matrix group-chat state is invalid.");
    }
    const raw = value as Partial<PendingGroupChatCreate>;
    if ((Object.keys(value).length !== 5 && Object.keys(value).length !== 6)
        || !Object.keys(value).every(key => key === "homeserver" || key === "userId"
            || key === "name" || key === "userIds" || key === "creationMarker" || key === "resolved")) {
        throw bridgeError("MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT", "The pending Matrix group-chat state is invalid.");
    }
    const homeserver = validateHomeserver(raw.homeserver);
    const userId = validateUserId(raw.userId);
    const request = validateCreateGroupChatRequest({ name: raw.name, userIds: raw.userIds }, userId);
    const creationMarker = validateString(raw.creationMarker, "Group-chat creation marker", 72);
    if (!GROUP_CHAT_CREATION_MARKER_PATTERN.test(creationMarker)) {
        throw bridgeError("MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT", "The pending Matrix group-chat state is invalid.");
    }
    const pending: PendingGroupChatCreate = { homeserver, userId, ...request, creationMarker };
    if (Object.hasOwn(raw, "resolved")) {
        pending.resolved = validateProtocolCreateGroupChatResult(
            raw.resolved,
            request,
            serverNameFromMatrixIdentifier(userId)
        );
    }
    return pending;
}

function pendingGroupChatInvite(value: unknown): PendingGroupChatInvite {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_GROUP_CHAT_INVITE_STATE_CORRUPT", "The pending group-chat invite state is invalid.");
    }
    const raw = value as Partial<PendingGroupChatInvite>;
    if ((Object.keys(value).length !== 4 && Object.keys(value).length !== 5)
        || !Object.keys(value).every(key => key === "homeserver" || key === "accountUserId"
            || key === "roomId" || key === "userId" || key === "resolved")) {
        throw bridgeError("MATRIX_GROUP_CHAT_INVITE_STATE_CORRUPT", "The pending group-chat invite state is invalid.");
    }
    const homeserver = validateHomeserver(raw.homeserver);
    const accountUserId = validateUserId(raw.accountUserId);
    const request = validateInviteUserToGroupChatRequest(
        { roomId: raw.roomId, userId: raw.userId },
        accountUserId
    );
    const pending: PendingGroupChatInvite = { homeserver, accountUserId, ...request };
    if (Object.hasOwn(raw, "resolved")) {
        pending.resolved = validateProtocolInviteUserToGroupChatResult(
            raw.resolved,
            request,
            serverNameFromMatrixIdentifier(accountUserId)
        );
    }
    return pending;
}

async function loadGroupChatCreateState(): Promise<void> {
    if (groupChatCreateStateError) throw groupChatCreateStateError;
    if (groupChatCreateStateLoaded) return;
    try {
        let encrypted: Buffer;
        try {
            encrypted = await readFile(GROUP_CHAT_CREATES_FILE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                groupChatCreateStateLoaded = true;
                return;
            }
            throw error;
        }
        if (encrypted.byteLength > 256 * 1024) throw new Error("oversized");
        assertSecureStorage();
        const raw = JSON.parse(safeStorage.decryptString(encrypted)) as {
            schema?: unknown;
            entries?: unknown;
            invites?: unknown;
        };
        const topLevelKeys = raw && typeof raw === "object" && !Array.isArray(raw)
            ? Object.keys(raw)
            : [];
        const topLevelShapeValid = raw?.schema === 2
            ? topLevelKeys.length === 2 && topLevelKeys.every(key => key === "schema" || key === "entries")
            : raw?.schema === 3
                && topLevelKeys.length === 3
                && topLevelKeys.every(key => key === "schema" || key === "entries" || key === "invites");
        if (!raw || !topLevelShapeValid || (raw.schema !== 2 && raw.schema !== 3) || !Array.isArray(raw.entries)
            || raw.entries.length > MAX_AMBIGUOUS_GROUP_CHAT_CREATES
            || (raw.schema === 3 && (!Array.isArray(raw.invites)
                || raw.invites.length > MAX_AMBIGUOUS_GROUP_CHAT_INVITES))) {
            throw new Error("invalid");
        }
        const loadedCreates = new Map<string, PendingGroupChatCreate>();
        const loadedInvites = new Map<string, PendingGroupChatInvite>();
        const markers = new Set<string>();
        for (const value of raw.entries) {
            const entry = pendingGroupChatCreate(value);
            const key = groupChatCreateLatchKey(entry);
            if (loadedCreates.has(key) || markers.has(entry.creationMarker)) throw new Error("duplicate");
            loadedCreates.set(key, entry);
            markers.add(entry.creationMarker);
        }
        for (const value of raw.schema === 3 ? raw.invites as unknown[] : []) {
            const entry = pendingGroupChatInvite(value);
            const key = groupChatInviteLatchKey({ userId: entry.accountUserId }, entry.roomId);
            if (loadedInvites.has(key)) throw new Error("duplicate");
            loadedInvites.set(key, entry);
        }
        for (const [key, entry] of loadedCreates) ambiguousGroupChatCreates.set(key, entry);
        for (const [key, entry] of loadedInvites) ambiguousGroupChatInvites.set(key, entry);
        groupChatCreateStateLoaded = true;
    } catch {
        groupChatCreateStateError = bridgeError(
            "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT",
            "The encrypted pending Matrix group-chat state could not be read safely."
        );
        throw groupChatCreateStateError;
    }
}

async function saveGroupChatCreateState(): Promise<void> {
    if (groupChatCreateStateError) throw groupChatCreateStateError;
    assertSecureStorage();
    let encrypted: Buffer;
    try {
        encrypted = safeStorage.encryptString(JSON.stringify({
            schema: 3,
            entries: [...ambiguousGroupChatCreates.values()],
            invites: [...ambiguousGroupChatInvites.values()]
        }));
        if (encrypted.byteLength > MAX_GROUP_CHAT_STATE_FILE_BYTES) throw new Error("oversized");
    } catch {
        throw bridgeError(
            "MATRIX_CREATE_GROUP_CHAT_STATE_WRITE_FAILED",
            "The pending Matrix group-chat state could not be encrypted."
        );
    }
    await mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
    const temporaryFile = join(ACCOUNT_DIR, `group-chat-creates-${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryFile, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporaryFile, GROUP_CHAT_CREATES_FILE);
    } catch {
        await unlink(temporaryFile).catch(() => undefined);
        throw bridgeError(
            "MATRIX_CREATE_GROUP_CHAT_STATE_WRITE_FAILED",
            "The pending Matrix group-chat state could not be saved."
        );
    }
}

function runGroupChatCreateState<T>(operation: () => Promise<T>): Promise<T> {
    const result = groupChatCreateStateTail.then(operation, operation);
    groupChatCreateStateTail = result.then(() => undefined, () => undefined);
    return result;
}

function beginAccountBoundOperation(binding: MatrixAccountBinding): () => void {
    if (accountLifecycleTransitions > 0 || !sameAccountBinding(binding, activeWorkerBinding)) {
        throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account is changing. Try again.");
    }
    accountBoundOperations++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        accountBoundOperations--;
        if (accountBoundOperations === 0) {
            for (const resolve of [...accountBoundOperationDrainWaiters]) {
                accountBoundOperationDrainWaiters.delete(resolve);
                resolve();
            }
        }
    };
}

function markAccountLifecycleChange(): void {
    accountLifecycleRevision++;
}

async function runAccountLifecycleTransition<T>(operation: () => Promise<T>): Promise<T> {
    accountLifecycleTransitions++;
    markAccountLifecycleChange();
    try {
        // A secure-view request may have authenticated its exact stored/worker
        // binding before an ordinary settings login or logout reached this
        // transition. Freeze the old worker until every such request releases;
        // otherwise an unbound private command could land on the replacement
        // account. New private requests are rejected while the transition flag
        // is set. requireStarted() has a leased fast path (and fails closed if
        // the worker is unavailable), so a request being drained never queues a
        // lifecycle restart behind the transition that is waiting for it.
        if (privateAccountRequests > 0) {
            await new Promise<void>(resolve => privateAccountDrainWaiters.add(resolve));
        }
        if (accountBoundOperations > 0) {
            await new Promise<void>(resolve => accountBoundOperationDrainWaiters.add(resolve));
        }
        return await operation();
    } finally {
        accountLifecycleTransitions--;
        markAccountLifecycleChange();
    }
}

async function writeStoredAccount(account: MatrixStoredAccount): Promise<void> {
    const validated = validateStoredAccount(account);
    assertSecureStorage();

    let encrypted: Buffer;
    try {
        encrypted = safeStorage.encryptString(JSON.stringify(validated));
    } catch {
        throw bridgeError("MATRIX_ACCOUNT_ENCRYPT_FAILED", "The Matrix account record could not be encrypted.");
    }

    await mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
    const temporaryFile = join(ACCOUNT_DIR, `account-${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryFile, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporaryFile, ACCOUNT_FILE);
    } catch {
        await unlink(temporaryFile).catch(() => undefined);
        throw bridgeError("MATRIX_ACCOUNT_WRITE_FAILED", "The encrypted Matrix account record could not be saved.");
    }
}

async function deleteStoredAccount(): Promise<void> {
    try {
        await unlink(ACCOUNT_FILE);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw bridgeError("MATRIX_ACCOUNT_DELETE_FAILED", "The encrypted Matrix account record could not be removed.");
        }
    }
}

async function clearNativeAccountStorage(): Promise<void> {
    const dataRoot = resolve(DATA_DIR);
    const target = resolve(ACCOUNT_DIR);
    const expected = resolve(dataRoot, "matrixBridge");
    if (target !== expected || target === dataRoot) {
        throw bridgeError("MATRIX_ACCOUNT_DELETE_FAILED", "The Matrix local-data directory was invalid.");
    }
    await runSpaceChildCreateState(() => runGroupChatCreateState(async () => {
        try {
            // ACCOUNT_DIR is dedicated to encrypted account/receipt records;
            // removing it also clears crash-left atomic-write temp files.
            await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } catch {
            throw bridgeError("MATRIX_ACCOUNT_DELETE_FAILED", "Matrix local account data could not be removed.");
        }
        ambiguousSpaceChildCreates.clear();
        spaceChildCreateStateLoaded = false;
        spaceChildCreateStateError = null;
        ambiguousGroupChatCreates.clear();
        groupChatCreateStateLoaded = false;
        groupChatCreateStateError = null;
        ambiguousGroupChatInvites.clear();
    }));
}

function publish(workerEvent: MatrixWorkerEvent): MatrixBridgeEvent {
    const validatedEvent = validateWorkerEvent(workerEvent);
    const seq = ++sequence;
    let bridgeEvent: MatrixBridgeEvent;

    if (validatedEvent.type === "status") {
        const status = { ...validatedEvent.status, seq };
        currentStatus = status;
        bridgeEvent = { ...validatedEvent, seq, status };
    } else if (validatedEvent.type === "snapshot") {
        const snapshot = {
            ...validatedEvent.snapshot,
            seq,
            status: { ...validatedEvent.snapshot.status, seq }
        };
        currentStatus = snapshot.status;
        bridgeEvent = { ...validatedEvent, seq, snapshot };
    } else {
        bridgeEvent = { ...validatedEvent, seq } as MatrixBridgeEvent;
    }

    enqueueRendererEvent(bridgeEvent);
    updateShellSnapshotCache(bridgeEvent);
    enqueueShellEvent(projectShellEvent(bridgeEvent));

    // Authentication/logout may still emit events from the account being
    // replaced. Their post-transition convergence snapshot is the only
    // authoritative secure-view update across that identity boundary.
    if (!authenticationInProgress && !logoutInProgress) {
        broadcastSecureViewEvent({ type: "matrix", event: bridgeEvent });
        if (bridgeEvent.type === "status") {
            broadcastSecureViewEvent({ type: "security", security: secureViewSecurityState() });
        }
    }

    return bridgeEvent;
}

function publishWorkerEvent(revision: number, workerEvent: MatrixWorkerEvent): MatrixBridgeEvent {
    if (!Number.isSafeInteger(revision) || revision !== lastWorkerRevision + 1) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned an invalid event sequence.");
    }
    const event = publish(workerEvent);
    lastWorkerRevision = revision;
    lastWorkerEventSequence = event.seq;
    workerRevisionSequences.set(revision, event.seq);
    while (workerRevisionSequences.size > MAX_WORKER_REVISION_SEQUENCES) {
        workerRevisionSequences.delete(workerRevisionSequences.keys().next().value!);
    }
    return event;
}

function clearEventStream(): void {
    rendererEventsDroppedThroughSeq = Math.max(rendererEventsDroppedThroughSeq, sequence);
    rendererEventQueue.length = 0;
    rendererEventQueueSizes.clear();
    rendererEventQueueBytes = 0;
    for (const waiter of [...rendererEventWaiters]) settleRendererEventWaiter(waiter, null);
    shellEventQueue.length = 0;
    shellEventQueueSizes.clear();
    shellEventQueueBytes = 0;
    latestShellSnapshot = null;
    shellSnapshotDirty = false;
    for (const waiter of [...shellEventWaiters]) settleShellEventWaiter(waiter, null);
}

function updateStatus(state: MatrixBridgeState, account?: { userId: string; }, error?: MatrixBridgeError): void {
    publish({
        type: "status",
        status: {
            seq: 0,
            state,
            account,
            error
        }
    });
}

function finalizeSnapshot(snapshot: MatrixSnapshot, sequenceWatermark: number): MatrixSnapshot {
    const validated = validateProtocolSnapshot(snapshot);
    let snapshotSequence = sequenceWatermark;
    if (validated.revision > 0) {
        const revisionSequence = workerRevisionSequences.get(validated.revision);
        if (revisionSequence == null || validated.revision > lastWorkerRevision) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot did not have a valid event cut.");
        }
        snapshotSequence = Math.max(snapshotSequence, revisionSequence);
    }
    const result = {
        ...validated,
        seq: snapshotSequence,
        status: { ...validated.status, seq: snapshotSequence }
    };
    // Events published after the request began may describe state newer than
    // this snapshot. Keep their status instead of rolling it back while the
    // renderer replays those events from the conservative watermark.
    if (sequence === snapshotSequence) currentStatus = result.status;
    return result;
}

function emptySnapshot(): MatrixSnapshot {
    return {
        seq: sequence,
        revision: 0,
        status: { ...currentStatus, seq: sequence },
        account: currentStatus.account,
        rooms: []
    };
}

function publishConvergenceSnapshot(snapshotValue: MatrixSnapshot): MatrixSnapshot {
    const snapshot = validateProtocolSnapshot(snapshotValue);
    if (snapshot.seq > sequence || snapshot.status.seq !== snapshot.seq) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix snapshot did not have a valid event cut.");
    }

    // Keep the content cut assigned by finalizeSnapshot. Events with a larger
    // seq may already have been delivered while this snapshot request was in
    // flight; stamping their latest seq onto older content would make those
    // deltas appear replayed even though the snapshot does not contain them.
    broadcastSecureViewEvent({
        type: "matrix",
        event: { seq: snapshot.seq, type: "snapshot", snapshot }
    });

    if (sequence === snapshot.seq) {
        const shellSequence = ++sequence;
        const projected = projectShellSnapshot(snapshot);
        const shellSnapshot: MatrixShellSnapshot = {
            ...projected,
            seq: shellSequence,
            status: { ...projected.status, seq: shellSequence }
        };
        latestShellSnapshot = shellSnapshot;
        shellSnapshotDirty = false;
        enqueueShellEvent({ seq: shellSequence, type: "snapshot", snapshot: shellSnapshot });
    } else {
        // Incremental shell events may describe state newer than this cut. Do
        // not roll metadata back; the coalesced shell refresh will fetch it.
        shellSnapshotDirty = true;
        const wakeSequence = ++sequence;
        if (latestShellSnapshot) {
            latestShellSnapshot.seq = wakeSequence;
            latestShellSnapshot.status.seq = wakeSequence;
        }
        enqueueShellEvent({
            seq: wakeSequence,
            type: "status",
            status: projectShellStatus({ ...currentStatus, seq: wakeSequence })
        });
    }
    return snapshot;
}

function snapshotMatchesAccountBinding(value: MatrixSnapshot, binding: MatrixAccountBinding | null): boolean {
    const expectedUserId = binding?.userId;
    if (!expectedUserId) {
        return activeWorkerBinding == null
            && value.account == null && value.status.account == null && value.rooms.length === 0;
    }
    return sameAccountBinding(activeWorkerBinding, binding)
        && value.account?.userId === expectedUserId && value.status.account?.userId === expectedUserId;
}

async function commitAccountConsistentRead<T, R>(
    read: () => Promise<T>,
    consistent: (value: T, binding: MatrixAccountBinding | null) => boolean,
    commit: (value: T, binding: MatrixAccountBinding | null) => R,
    guard?: () => void,
    retryInconsistent = false
): Promise<R> {
    for (let attempt = 0; attempt < ACCOUNT_CUT_MAX_ATTEMPTS; attempt++) {
        guard?.();
        if (accountLifecycleTransitions > 0) {
            await lifecycleTail.catch(() => undefined);
            continue;
        }
        const revisionBefore = accountLifecycleRevision;
        const bindingBefore = accountBinding(await readStoredAccount());
        if (accountLifecycleTransitions > 0 || revisionBefore !== accountLifecycleRevision) continue;

        let value: T;
        try {
            value = await read();
        } catch (error) {
            const bindingAfterError = accountBinding(await readStoredAccount());
            if (accountLifecycleTransitions > 0
                || !sameAccountBinding(bindingBefore, bindingAfterError)) {
                continue;
            }
            // If this read itself attempted a start and that start failed, its
            // lifecycle revision changed but the original error is still the
            // authoritative result. Do not turn one backend failure into three
            // repeated starts.
            throw error;
        }

        const bindingAfter = accountBinding(await readStoredAccount());
        guard?.();
        if (accountLifecycleTransitions > 0 || revisionBefore !== accountLifecycleRevision
            || !sameAccountBinding(bindingBefore, bindingAfter)) {
            continue;
        }
        if (!consistent(value, bindingAfter)) {
            if (retryInconsistent) continue;
            throw bridgeError(
                "MATRIX_ACCOUNT_STATE_INCONSISTENT",
                "The Matrix account changed while isolated state was being read."
            );
        }

        // No await is allowed between the final lifecycle/account check and
        // commit. This prevents logout/login from publishing an older account
        // snapshot after the new lifecycle has begun.
        return commit(value, bindingAfter);
    }

    throw bridgeError(
        "MATRIX_ACCOUNT_STATE_CHANGED",
        "The Matrix account changed while isolated state was being read. Try again."
    );
}

async function stableShellSnapshot(event: IpcMainInvokeEvent): Promise<MatrixShellSnapshot> {
    return await runSnapshotCut(() => commitAccountConsistentRead(
        () => snapshot(event),
        (value, binding) => snapshotMatchesAccountBinding(value, binding) && value.seq === sequence,
        value => {
            const projected = projectShellSnapshot(value);
            // Keep the returned cut detached from the mutable cache. An event
            // can arrive after this promise resolves but before its caller
            // resumes; mutating the cache must not relabel the returned cut.
            latestShellSnapshot = cloneShellSnapshot(projected);
            shellSnapshotDirty = false;
            return projected;
        },
        undefined,
        true
    ));
}

async function refreshConvergenceSnapshot(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    reaffirmViewBinding = true
): Promise<MatrixSnapshot> {
    return await runSnapshotCut(() => commitAccountConsistentRead(
        () => snapshot(event),
        snapshotMatchesAccountBinding,
        (value, binding) => {
            // refresh is authorized only for the view's existing exact
            // binding; reaffirm that same cut without rebinding stale views.
            if (reaffirmViewBinding) state.boundAccount = binding ? { ...binding } : null;
            return publishConvergenceSnapshot(value);
        },
        () => {
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
        }
    ));
}

function ambiguousAccessMutationError(error: unknown): boolean {
    return error instanceof Error && (error.name === "MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS"
        || error.name === "MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS"
        || error.name === "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS");
}

function ambiguousRoomInviteMutationError(error: unknown): boolean {
    return error instanceof Error && (error.name === "MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS"
        || error.name === "MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS"
        || error.name === "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS"
        || error.name === "MATRIX_ROOM_JOIN_AMBIGUOUS");
}

function ambiguousCreateMutationError(error: unknown): boolean {
    return error instanceof Error && (error.name === "MATRIX_CREATE_SPACE_AMBIGUOUS"
        || error.name === "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS"
        || error.name === "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS");
}

async function bestEffortMutationRefresh(
    event: IpcMainInvokeEvent,
    state: SecureViewState
): Promise<void> {
    try {
        await refreshConvergenceSnapshot(event, state);
    } catch (error) {
        // The worker mutation result remains authoritative. Force the outer
        // shell's next read through a fresh snapshot cut, and log only the
        // sanitized public code (never account or event data).
        shellSnapshotDirty = true;
        console.warn(`[MatrixBridge] A mutation succeeded or is ambiguous, but convergence refresh failed (${errorDTO(error).code}).`);
    }
}

async function runPrivateAccessMutation<T>(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    mutation: () => Promise<T>
): Promise<T> {
    try {
        const result = await mutation();
        await bestEffortMutationRefresh(event, state);
        return result;
    } catch (error) {
        if (ambiguousAccessMutationError(error)) {
            await bestEffortMutationRefresh(event, state);
        }
        throw error;
    }
}

async function runPrivateRoomInviteMutation<T>(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    mutation: () => Promise<T>
): Promise<T> {
    try {
        const result = await mutation();
        await bestEffortMutationRefresh(event, state);
        return result;
    } catch (error) {
        if (ambiguousRoomInviteMutationError(error)) {
            await bestEffortMutationRefresh(event, state);
        }
        throw error;
    }
}

async function runPrivateCreateMutation<T>(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    mutation: () => Promise<T>
): Promise<T> {
    try {
        const result = await mutation();
        await bestEffortMutationRefresh(event, state);
        return result;
    } catch (error) {
        if (ambiguousCreateMutationError(error)) {
            await bestEffortMutationRefresh(event, state);
        }
        throw error;
    }
}

function secureViewSecurityState(): MatrixSecureViewSecurityState {
    return {
        isolated: true,
        transport: "private-ipc",
        backendConnected: hasLiveWorker(),
        persistentE2EE: true
    };
}

async function secureViewDiagnostic(state: SecureViewState): Promise<MatrixSecureViewDiagnostic> {
    const contents = state.view.webContents;
    const ownerContentBounds = state.owner.getContentBounds();
    const { width: ownerWidth, height: ownerHeight } = ownerContentBounds;
    const absoluteBounds = state.view.getBounds();
    const actualBounds: MatrixSecureViewBounds = {
        x: absoluteBounds.x - ownerContentBounds.x,
        y: absoluteBounds.y - ownerContentBounds.y,
        width: absoluteBounds.width,
        height: absoluteBounds.height
    };
    const expectedBounds = clampSecureViewBounds(state, state.requestedBounds, [ownerWidth, ownerHeight]);
    const attachedToOwner = state.view.getParentWindow() === state.owner;
    const actuallyVisible = state.visible && state.presented && state.view.isVisible();
    const diagnostic: MatrixSecureViewDiagnostic = {
        ownerContentSize: { width: ownerWidth, height: ownerHeight },
        requestedBounds: { ...state.requestedBounds },
        expectedBounds: { ...expectedBounds },
        actualBounds: { ...actualBounds },
        actualViewVisible: actuallyVisible,
        attachedToOwner,
        // Owned child windows are maintained above their parent by the OS.
        topmostInOwner: attachedToOwner && actuallyVisible,
        actualBoundsNonEmpty: actualBounds.width > 0 && actualBounds.height > 0,
        actualBoundsMatchExpected: actualBounds.x === expectedBounds.x
            && actualBounds.y === expectedBounds.y
            && actualBounds.width === expectedBounds.width
            && actualBounds.height === expectedBounds.height,
        actualBoundsWithinOwner: actualBounds.x >= 0 && actualBounds.y >= 0
            && actualBounds.x + actualBounds.width <= ownerWidth
            && actualBounds.y + actualBounds.height <= ownerHeight,
        webContentsLoading: !contents.isDestroyed() && contents.isLoading(),
        didStartNavigationCount: state.didStartNavigationCount,
        willNavigateSeenCount: state.willNavigateSeenCount,
        willNavigateAllowedCount: state.willNavigateAllowedCount,
        willNavigateBlockedCount: state.willNavigateBlockedCount,
        protocolRequestSeenCount: Math.max(0, secureViewProtocolRequestCount - state.protocolRequestBaseline),
        protocolDocumentServedCount: Math.max(
            0,
            secureViewProtocolDocumentServedCount - state.protocolDocumentServedBaseline
        ),
        didStartLoadingCount: state.didStartLoadingCount,
        loadUrlResolved: state.loadUrlResolved,
        loadUrlRejected: state.loadUrlRejected,
        preloadBootstrapRequested: state.preloadBootstrapRequested,
        preloadBootstrapGranted: state.preloadBootstrapGranted,
        preloadError: state.preloadError,
        domReady: state.domReady,
        mainFrameLoaded: state.mainFrameLoaded,
        urlCommitted: !contents.isDestroyed() && isSecureViewDocumentUrl(contents.getURL()),
        readySignalReceived: state.readySignalReceived,
        readySignalRejected: state.readySignalRejected
    };
    if (state.destroyed || contents.isDestroyed() || !state.mainFrameLoaded) return diagnostic;

    try {
        const probe = await contents.executeJavaScript(`(() => {
            const root = document.getElementById("matrix-secure-view-root");
            const fatalCard = root?.querySelector(".matrix-fatal-card:not(.matrix-auth-card)");
            return {
                documentInteractive: document.readyState !== "loading",
                documentComplete: document.readyState === "complete",
                hostExposed: typeof globalThis.MatrixSecureViewHost === "object",
                rootPresent: root !== null,
                scriptRan: Boolean(root && root.childElementCount > 0),
                secureUiLoading: Boolean(fatalCard && !fatalCard.querySelector("button")),
                secureUiFatal: Boolean(fatalCard?.querySelector("button")),
                secureUiAuth: Boolean(root?.querySelector(".matrix-auth-card")),
                secureUiMain: Boolean(root?.querySelector(".matrix-embedded"))
            };
        })()`);
        if (probe && typeof probe === "object") {
            for (const key of [
                "documentInteractive",
                "documentComplete",
                "hostExposed",
                "rootPresent",
                "scriptRan",
                "secureUiLoading",
                "secureUiFatal",
                "secureUiAuth",
                "secureUiMain"
            ] as const) {
                if (typeof probe[key] === "boolean") diagnostic[key] = probe[key];
            }
        }
    } catch {
        diagnostic.probeFailed = true;
    }
    return diagnostic;
}

async function secureViewControlState(state?: SecureViewState): Promise<MatrixSecureViewControlState> {
    const created = Boolean(state && !state.destroyed && !state.owner.isDestroyed()
        && !state.view.isDestroyed() && !state.view.webContents.isDestroyed());
    return {
        created,
        ready: Boolean(created && state?.ready),
        // `visible` is the outer lease. `diagnostic.actualViewVisible` and
        // private visibility events track owner minimize/hide presentation.
        visible: Boolean(created && state?.visible),
        ...(created && state ? { diagnostic: await secureViewDiagnostic(state) } : {})
    };
}

function sendSecureViewEvent(state: SecureViewState, event: MatrixSecureViewEvent): void {
    if (state.destroyed || !state.ready || state.view.webContents.isDestroyed()) return;
    const envelope: MatrixSecureViewEventEnvelope = { generation: state.generation, event };
    state.view.webContents.send(MATRIX_SECURE_VIEW_EVENT, envelope);
}

function broadcastSecureViewEvent(event: MatrixSecureViewEvent): void {
    for (const state of secureViewsByOwnerId.values()) sendSecureViewEvent(state, event);
}

function clampSecureViewBounds(
    state: SecureViewState,
    requested = state.requestedBounds,
    ownerSize = state.owner.getContentSize()
): MatrixSecureViewBounds {
    const [rawOwnerWidth, rawOwnerHeight] = ownerSize;
    const ownerWidth = Math.max(1, rawOwnerWidth);
    const ownerHeight = Math.max(1, rawOwnerHeight);
    const x = Math.min(requested.x, ownerWidth - 1);
    const y = Math.min(requested.y, ownerHeight - 1);
    return {
        x,
        y,
        width: Math.max(1, Math.min(requested.width, ownerWidth - x)),
        height: Math.max(1, Math.min(requested.height, ownerHeight - y))
    };
}

function layoutSecureView(state: SecureViewState): boolean {
    if (state.destroyed || state.owner.isDestroyed() || state.view.isDestroyed()) return false;
    try {
        const ownerContentBounds = state.owner.getContentBounds();
        const bounds = clampSecureViewBounds(
            state,
            state.requestedBounds,
            [ownerContentBounds.width, ownerContentBounds.height]
        );
        const desired = {
            x: ownerContentBounds.x + bounds.x,
            y: ownerContentBounds.y + bounds.y,
            width: bounds.width,
            height: bounds.height
        };
        let candidate = { ...desired };
        for (let attempt = 0; attempt < 4; attempt++) {
            state.view.setBounds(candidate);
            const actual = state.view.getBounds();
            const leftOverflow = Math.max(0, desired.x - actual.x);
            const topOverflow = Math.max(0, desired.y - actual.y);
            const rightOverflow = Math.max(0,
                actual.x + actual.width - (desired.x + desired.width));
            const bottomOverflow = Math.max(0,
                actual.y + actual.height - (desired.y + desired.height));
            if (leftOverflow === 0 && topOverflow === 0 && rightOverflow === 0 && bottomOverflow === 0) {
                return true;
            }
            candidate = {
                x: candidate.x + leftOverflow,
                y: candidate.y + topOverflow,
                width: Math.max(1, candidate.width - leftOverflow - rightOverflow),
                height: Math.max(1, candidate.height - topOverflow - bottomOverflow)
            };
        }
    } catch {
        return false;
    }
    return false;
}

function syncSecureViewPresentation(state: SecureViewState): void {
    if (state.destroyed || state.owner.isDestroyed() || state.view.isDestroyed()) return;
    const wasPresented = state.presented;
    try {
        if (!state.visible || state.ownerHidden || state.ownerHtmlFullscreen || state.ownerGeometryTransition
            || !state.owner.isVisible() || state.owner.isMinimized()) {
            state.view.hide();
            state.presented = false;
        } else {
            if (!layoutSecureView(state)) {
                disposeSecureViewState(state);
                return;
            }
            state.view.showInactive();
            state.presented = state.view.isVisible();
        }
    } catch {
        disposeSecureViewState(state);
        return;
    }
    if (state.presented !== wasPresented) {
        sendSecureViewEvent(state, { type: "visibility", visible: state.presented });
    }
}

function requireSecureViewPresentation(state: SecureViewState): void {
    if (!state.visible) return;
    const attachedToOwner = !state.view.isDestroyed() && state.view.getParentWindow() === state.owner;
    const shouldBeVisible = !state.ownerHidden && !state.ownerHtmlFullscreen && !state.ownerGeometryTransition
        && state.owner.isVisible() && !state.owner.isMinimized();
    if (attachedToOwner && (!shouldBeVisible || state.presented && state.view.isVisible())) return;

    // Never continue servicing a detached or unexpectedly hidden presentation
    // surface. Teardown targets only this exact owned child window.
    disposeSecureViewState(state);
    throw bridgeError("MATRIX_SECURE_VIEW_CONFLICT", "The secure Matrix view could not be presented safely.");
}

function disposeSecureViewState(state: SecureViewState): void {
    if (state.destroyed) return;
    state.destroyed = true;
    state.ready = false;
    state.visible = false;
    state.presented = false;
    if (secureViewsByOwnerId.get(state.ownerContents.id) === state) {
        secureViewsByOwnerId.delete(state.ownerContents.id);
    }
    if (secureViewsByContentsId.get(state.view.webContents.id) === state) {
        secureViewsByContentsId.delete(state.view.webContents.id);
    }
    state.owner.removeListener("move", state.onOwnerLayout);
    state.owner.removeListener("resize", state.onOwnerLayout);
    state.owner.removeListener("maximize", state.onOwnerLayout);
    state.owner.removeListener("unmaximize", state.onOwnerLayout);
    state.owner.removeListener("moved", state.onOwnerLayout);
    state.owner.removeListener("resized", state.onOwnerLayout);
    state.owner.removeListener("enter-full-screen", state.onOwnerLayout);
    state.owner.removeListener("leave-full-screen", state.onOwnerLayout);
    state.owner.removeListener("enter-html-full-screen", state.onOwnerHtmlFullscreenEntered);
    state.owner.removeListener("leave-html-full-screen", state.onOwnerHtmlFullscreenLeft);
    state.owner.removeListener("will-move", state.onOwnerGeometryTransition);
    state.owner.removeListener("will-resize", state.onOwnerGeometryTransition);
    state.owner.removeListener("restore", state.onOwnerLayout);
    state.owner.removeListener("restore", state.onOwnerShown);
    state.owner.removeListener("minimize", state.onOwnerHidden);
    state.owner.removeListener("hide", state.onOwnerHidden);
    state.owner.removeListener("show", state.onOwnerShown);
    state.owner.removeListener("closed", state.onOwnerClosed);
    state.ownerContents.removeListener("destroyed", state.onOwnerContentsDestroyed);
    state.ownerContents.removeListener("did-navigate", state.onOwnerDidNavigate);
    state.ownerContents.removeListener("render-process-gone", state.onOwnerRendererGone);
    state.view.removeListener("closed", state.onViewClosed);
    if (!state.view.isDestroyed()) state.view.destroy();
}

function disposeAllSecureViews(): void {
    for (const state of [...secureViewsByOwnerId.values()]) disposeSecureViewState(state);
}

async function ensureSecureViewSession(): Promise<void> {
    await app.whenReady();
    if (secureViewSessionConfigured) return;
    const secureSession = session.fromPartition(SECURE_VIEW_PARTITION);
    secureSession.setPermissionCheckHandler(() => false);
    secureSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    secureSession.on("will-download", event => event.preventDefault());

    if (!secureSession.protocol.isProtocolHandled("http")) {
        secureSession.protocol.handle("http", () => new Response(null, { status: 403 }));
    }
    if (!secureSession.protocol.isProtocolHandled("https")) {
        secureSession.protocol.handle("https", async request => {
            secureViewProtocolRequestCount++;
            let url: URL;
            try {
                url = new URL(request.url);
            } catch {
                return new Response(null, { status: 400 });
            }
            if (url.origin !== SECURE_VIEW_ORIGIN || request.method !== "GET" || url.search || url.hash) {
                return new Response(null, { status: 403 });
            }

            const securityHeaders = {
                "Cache-Control": "no-store",
                "Content-Security-Policy": SECURE_VIEW_CSP,
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Resource-Policy": "same-origin",
                "Permissions-Policy": "accelerometer=(), autoplay=(self), camera=(), clipboard-read=(), clipboard-write=(self), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY"
            };
            if (url.pathname === "/" || url.pathname === "/index.html") {
                secureViewProtocolDocumentServedCount++;
                return new Response(SECURE_VIEW_HTML, {
                    headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8" }
                });
            }

            const asset = url.pathname === `/${SECURE_VIEW_SCRIPT}`
                ? { name: SECURE_VIEW_SCRIPT, contentType: "text/javascript; charset=utf-8" }
                : url.pathname === `/${SECURE_VIEW_STYLE}`
                    ? { name: SECURE_VIEW_STYLE, contentType: "text/css; charset=utf-8" }
                    : undefined;
            if (!asset) return new Response(null, { status: 404, headers: securityHeaders });
            try {
                const body = new Uint8Array(await readFile(join(__dirname, asset.name)));
                return new Response(body, {
                    headers: { ...securityHeaders, "Content-Type": asset.contentType }
                });
            } catch {
                return new Response(null, { status: 404, headers: securityHeaders });
            }
        });
    }
    secureViewSessionConfigured = true;
}

function secureViewOwner(event: IpcMainInvokeEvent): BrowserWindow {
    const { sender, senderFrame } = event;
    if (sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame
        || senderFrame.url !== sender.getURL() || secureViewsByContentsId.has(sender.id)
        || sender === workerWindow?.webContents) {
        throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view owner was rejected.");
    }
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed() || owner.webContents !== sender) {
        throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view owner was rejected.");
    }
    return owner;
}

function secureViewForOwner(event: IpcMainInvokeEvent, required = true): SecureViewState | undefined {
    const owner = secureViewOwner(event);
    const state = secureViewsByOwnerId.get(owner.webContents.id);
    if (required && (!state || state.destroyed)) {
        throw bridgeError("MATRIX_SECURE_VIEW_MISSING", "The secure Matrix view is not open.");
    }
    return state;
}

async function createSecureView(owner: BrowserWindow, route: MatrixSecureViewRoute, bounds: MatrixSecureViewBounds): Promise<SecureViewState> {
    await ensureSecureViewSession();
    const generation = randomBytes(32).toString("hex");
    const view = new BrowserWindow({
        parent: owner,
        modal: false,
        show: false,
        paintWhenInitiallyHidden: true,
        width: 1,
        height: 1,
        useContentSize: true,
        frame: false,
        transparent: false,
        backgroundColor: "#313338",
        backgroundMaterial: "none",
        skipTaskbar: true,
        autoHideMenuBar: true,
        focusable: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        fullscreenable: false,
        hasShadow: false,
        roundedCorners: false,
        thickFrame: false,
        webPreferences: {
            partition: SECURE_VIEW_PARTITION,
            preload: join(__dirname, SECURE_VIEW_PRELOAD),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            webviewTag: false,
            devTools: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: false,
            spellcheck: false,
            navigateOnDragDrop: false
        }
    });
    const state: SecureViewState = {
        owner,
        ownerContents: owner.webContents,
        view,
        generation,
        route,
        requestedBounds: bounds,
        ready: false,
        visible: false,
        presented: false,
        ownerHidden: !owner.isVisible() || owner.isMinimized(),
        ownerHtmlFullscreen: false,
        ownerGeometryTransition: false,
        destroyed: false,
        userGestureUntil: 0,
        boundAccount: undefined,
        preloadBootstrapRequested: false,
        preloadBootstrapGranted: false,
        preloadError: false,
        domReady: false,
        mainFrameLoaded: false,
        readySignalReceived: false,
        readySignalRejected: false,
        didStartNavigationCount: 0,
        willNavigateSeenCount: 0,
        willNavigateAllowedCount: 0,
        willNavigateBlockedCount: 0,
        didStartLoadingCount: 0,
        loadUrlResolved: false,
        loadUrlRejected: false,
        protocolRequestBaseline: secureViewProtocolRequestCount,
        protocolDocumentServedBaseline: secureViewProtocolDocumentServedCount,
        onOwnerLayout: () => {
            state.ownerGeometryTransition = false;
            syncSecureViewPresentation(state);
        },
        onOwnerGeometryTransition: () => {
            state.ownerGeometryTransition = true;
            syncSecureViewPresentation(state);
        },
        onOwnerHidden: () => {
            state.ownerHidden = true;
            syncSecureViewPresentation(state);
        },
        onOwnerShown: () => {
            state.ownerHidden = false;
            syncSecureViewPresentation(state);
        },
        onOwnerHtmlFullscreenEntered: () => {
            state.ownerHtmlFullscreen = true;
            syncSecureViewPresentation(state);
        },
        onOwnerHtmlFullscreenLeft: () => {
            state.ownerHtmlFullscreen = false;
            syncSecureViewPresentation(state);
        },
        onOwnerClosed: () => disposeSecureViewState(state),
        onOwnerContentsDestroyed: () => disposeSecureViewState(state),
        onOwnerDidNavigate: () => disposeSecureViewState(state),
        onOwnerRendererGone: () => disposeSecureViewState(state),
        onViewClosed: () => disposeSecureViewState(state)
    };
    secureViewsByOwnerId.set(owner.webContents.id, state);
    secureViewsByContentsId.set(view.webContents.id, state);
    try {
        owner.on("move", state.onOwnerLayout);
        owner.on("resize", state.onOwnerLayout);
        owner.on("maximize", state.onOwnerLayout);
        owner.on("unmaximize", state.onOwnerLayout);
        owner.on("moved", state.onOwnerLayout);
        owner.on("resized", state.onOwnerLayout);
        owner.on("enter-full-screen", state.onOwnerLayout);
        owner.on("leave-full-screen", state.onOwnerLayout);
        owner.on("enter-html-full-screen", state.onOwnerHtmlFullscreenEntered);
        owner.on("leave-html-full-screen", state.onOwnerHtmlFullscreenLeft);
        owner.on("will-move", state.onOwnerGeometryTransition);
        owner.on("will-resize", state.onOwnerGeometryTransition);
        owner.on("restore", state.onOwnerLayout);
        owner.on("restore", state.onOwnerShown);
        owner.on("minimize", state.onOwnerHidden);
        owner.on("hide", state.onOwnerHidden);
        owner.on("show", state.onOwnerShown);
        owner.once("closed", state.onOwnerClosed);
        owner.webContents.once("destroyed", state.onOwnerContentsDestroyed);
        owner.webContents.once("did-navigate", state.onOwnerDidNavigate);
        owner.webContents.once("render-process-gone", state.onOwnerRendererGone);
        view.once("closed", state.onViewClosed);
        view.setMenu(null);
        if (!layoutSecureView(state)) {
            throw bridgeError("MATRIX_SECURE_VIEW_FAILED", "The secure Matrix view could not be positioned safely.");
        }

        const contents = view.webContents;
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-navigate", (navigationEvent, url) => {
            state.willNavigateSeenCount++;
            if (isSecureViewDocumentUrl(url)) {
                state.willNavigateAllowedCount++;
            } else {
                state.willNavigateBlockedCount++;
                navigationEvent.preventDefault();
            }
        });
        contents.on("did-start-navigation", (_event, _url, _isSameDocument, isMainFrame) => {
            if (isMainFrame) state.didStartNavigationCount++;
        });
        contents.on("did-start-loading", () => {
            state.didStartLoadingCount++;
        });
        contents.on("will-redirect", redirectEvent => redirectEvent.preventDefault());
        contents.on("will-attach-webview", attachEvent => attachEvent.preventDefault());
        contents.on("preload-error", () => {
            state.preloadError = true;
        });
        contents.on("dom-ready", () => {
            if (isSecureViewDocumentUrl(contents.getURL())) state.domReady = true;
        });
        contents.on("did-finish-load", () => {
            if (isSecureViewDocumentUrl(contents.getURL())) state.mainFrameLoaded = true;
        });
        contents.on("before-mouse-event", (_event, mouse) => {
            if (state.visible && state.presented && mouse.type === "mouseDown" && mouse.button === "left") {
                state.userGestureUntil = Date.now() + 1_500;
            }
        });
        contents.on("before-input-event", (_event, input) => {
            if (state.visible && state.presented && input.type === "keyDown" && !input.isAutoRepeat
                && (input.key === "Enter" || input.code === "Space")) {
                state.userGestureUntil = Date.now() + 1_500;
            }
        });
        contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame && !isSecureViewDocumentUrl(url)) disposeSecureViewState(state);
        });
        contents.on("devtools-opened", () => contents.closeDevTools());
        contents.on("render-process-gone", () => disposeSecureViewState(state));
        contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
            if (isMainFrame) disposeSecureViewState(state);
        });
        contents.setAudioMuted(false);
        try {
            await contents.loadURL(SECURE_VIEW_URL);
            state.loadUrlResolved = true;
        } catch (error) {
            state.loadUrlRejected = true;
            throw error;
        }
        if (state.destroyed || contents.isDestroyed()) {
            throw bridgeError("MATRIX_SECURE_VIEW_FAILED", "The secure Matrix view could not be opened.");
        }
        return state;
    } catch {
        // View creation is transactional. Never leave a half-configured state
        // in either lookup map after a runtime/API/load failure.
        disposeSecureViewState(state);
        throw bridgeError("MATRIX_SECURE_VIEW_FAILED", "The secure Matrix view could not be opened.");
    }
}

function secureViewStateForSender(
    event: IpcMainEvent | IpcMainInvokeEvent,
    generationValue: unknown
): SecureViewState {
    const generation = validateSecureViewGeneration(generationValue);
    const state = secureViewsByContentsId.get(event.sender.id);
    const frame = event.senderFrame;
    if (!state || state.destroyed || state.generation !== generation
        || state.view.webContents !== event.sender || event.sender.isDestroyed()
        || !frame || frame !== event.sender.mainFrame
        || !isSecureViewDocumentUrl(frame.url) || !isSecureViewDocumentUrl(event.sender.getURL())
        || state.owner.isDestroyed() || state.ownerContents.isDestroyed()) {
        throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
    }
    requireSecureViewPresentation(state);
    return state;
}

function requireSecureViewUserGesture(state: SecureViewState): void {
    const authorized = state.visible && state.presented && state.view.isVisible()
        && !state.view.webContents.isDestroyed()
        && state.view.webContents.isFocused() && Date.now() <= state.userGestureUntil;
    state.userGestureUntil = 0;
    if (!authorized) {
        throw bridgeError("MATRIX_USER_GESTURE_REQUIRED", "This action requires a click in the secure Matrix view.");
    }
}

async function secureViewBootstrap(event: IpcMainInvokeEvent, state: SecureViewState): Promise<MatrixSecureViewBootstrap> {
    return await runSnapshotCut(() => commitAccountConsistentRead(
        async () => ({
            matrixSnapshot: await snapshot(event),
            status: await getStatus(event),
            rawConfig: await getConfig(event)
        }),
        ({ matrixSnapshot, status, rawConfig }, binding) => {
            if (!snapshotMatchesAccountBinding(matrixSnapshot, binding)) return false;
            if (!binding) {
                return !rawConfig.configured && rawConfig.homeserver == null
                    && rawConfig.userId == null && rawConfig.deviceId == null
                    && status.account == null;
            }
            return rawConfig.configured
                && rawConfig.homeserver === binding.homeserver
                && rawConfig.userId === binding.userId
                && rawConfig.deviceId === binding.deviceId
                && status.account?.userId === binding.userId;
        },
        ({ matrixSnapshot, status, rawConfig }, binding) => {
            const config: MatrixSecureViewAccountConfig = {
                configured: rawConfig.configured,
                ...(rawConfig.homeserver ? { homeserver: rawConfig.homeserver } : {}),
                ...(rawConfig.userId ? { userId: rawConfig.userId } : {}),
                persistentE2EE: true
            };
            if (state.boundAccount !== undefined && !sameAccountBinding(state.boundAccount, binding)) {
                state.route = { kind: "home" };
            }
            state.boundAccount = binding ? { ...binding } : null;
            return {
                snapshot: matrixSnapshot,
                status,
                config,
                route: state.route,
                security: secureViewSecurityState()
            };
        },
        () => {
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
        }
    ));
}

function interruptedAccessMutationError(commandType: MatrixWorkerCommand["type"]): Error | undefined {
    switch (commandType) {
        case "configureSpaceAccess":
            return bridgeError(
                "MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS",
                "Matrix access settings were interrupted and may have changed. Refresh them before saving again."
            );
        case "requestSpaceAccess":
            return bridgeError(
                "MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS",
                "Matrix could not confirm the access request. It may already be pending; refresh before trying again."
            );
        case "resolveSpaceAccessRequest":
            return bridgeError(
                "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS",
                "Matrix could not confirm the access decision. It may already be resolved; refresh before acting again."
            );
        case "inviteUserToSpace":
            return bridgeError(
                "MATRIX_SPACE_INVITE_AMBIGUOUS",
                "Matrix could not confirm the invite. It may already be pending; refresh before trying again."
            );
        case "inviteUserToGroupChat":
            return bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS",
                "Matrix could not confirm the group-chat invite. Reconcile it before any retry."
            );
        case "acceptInvite":
            return bridgeError(
                "MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS",
                "Matrix could not confirm whether the invitation was accepted. Refresh rooms before trying again."
            );
        case "rejectInvite":
            return bridgeError(
                "MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS",
                "Matrix could not confirm whether the invitation was declined. Refresh rooms before trying again."
            );
        case "joinSuggestedSpaceChannels":
            return bridgeError(
                "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS",
                "Matrix could not confirm every suggested-channel join. Refresh the server before trying again."
            );
        case "joinRoom":
        case "joinRoomAddress":
            return bridgeError(
                "MATRIX_ROOM_JOIN_AMBIGUOUS",
                "Matrix could not confirm whether the room was joined. Refresh rooms before trying again."
            );
        case "createGroupChat":
            return bridgeError(
                "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
                "Matrix could not confirm group-chat creation. Reconcile it before trying again."
            );
        default:
            return undefined;
    }
}

function mutationSignalCommandType(commandType: MatrixWorkerCommand["type"]): boolean {
    return commandType === "createSpace" || commandType === "createSpaceChild" || commandType === "createGroupChat"
        || commandType === "inviteUserToSpace" || commandType === "inviteUserToGroupChat" || commandType === "acceptInvite"
        || commandType === "rejectInvite" || commandType === "joinSuggestedSpaceChannels"
        || commandType === "joinRoom" || commandType === "joinRoomAddress";
}

function accessMutationRequiresDispatchSignal(commandType: MatrixWorkerCommand["type"]): boolean {
    return commandType === "inviteUserToSpace" || commandType === "inviteUserToGroupChat" || commandType === "acceptInvite"
        || commandType === "rejectInvite" || commandType === "joinSuggestedSpaceChannels"
        || commandType === "joinRoom" || commandType === "joinRoomAddress" || commandType === "createGroupChat";
}

function rejectWorker(reason: Error): void {
    rejectWorkerReady?.(reason);
    resolveWorkerReady = null;
    rejectWorkerReady = null;
    workerReady = null;

    for (const request of pendingWorkerRequests.values()) {
        clearTimeout(request.timer);
        const interruptedAccessMutation = request.started
            && (!accessMutationRequiresDispatchSignal(request.commandType) || request.mutationDispatched)
            ? interruptedAccessMutationError(request.commandType)
            : undefined;
        request.reject(request.mutationDispatched && request.commandType === "createSpaceChild"
            ? bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS",
                "Matrix room creation was interrupted and may have succeeded. Reconcile the parent Space before trying again."
            )
            : request.commandType === "createSpaceChild"
                ? bridgeError(
                    "MATRIX_CREATE_SPACE_CHILD_PRE_DISPATCH_FAILED",
                    "Matrix room creation stopped before the homeserver mutation was dispatched. No room was created."
                )
                : request.mutationDispatched && request.commandType === "createSpace"
                    ? bridgeError(
                        "MATRIX_CREATE_SPACE_AMBIGUOUS",
                        "Matrix Space creation was interrupted and may have succeeded. Refresh your Spaces before trying again."
                    )
                    : interruptedAccessMutation ?? reason);
    }
    pendingWorkerRequests.clear();
}

function terminateWorker(reason: Error): void {
    const win = workerWindow;
    const changed = Boolean(win || workerReady || pendingWorkerRequests.size);
    if (changed) markAccountLifecycleChange();
    workerWindow = null;
    activeWorkerBinding = null;
    rejectWorker(reason);
    if (win && !win.isDestroyed()) win.destroy();
}

function failWorker(reason: Error): void {
    terminateWorker(reason);
    updateStatus("error", currentStatus.account, errorDTO(reason));
}

function hasLiveWorker(): boolean {
    return Boolean(workerWindow && !workerWindow.isDestroyed() && workerReady);
}

function commandTimer(
    commandType: MatrixWorkerCommand["type"],
    queued: boolean,
    mutationDispatched = false
): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
        const createSpaceMayHaveSucceeded = !queued && mutationDispatched && commandType === "createSpace";
        const createSpaceChildMayHaveSucceeded = !queued && mutationDispatched && commandType === "createSpaceChild";
        const interruptedAccessMutation = !queued
            && (!accessMutationRequiresDispatchSignal(commandType) || mutationDispatched)
            ? interruptedAccessMutationError(commandType)
            : undefined;
        let error: Error;
        if (queued) {
            error = bridgeError(
                "MATRIX_COMMAND_QUEUE_TIMEOUT",
                `The Matrix ${commandType} operation could not start; its backend was restarted.`
            );
        } else if (createSpaceChildMayHaveSucceeded) {
            error = bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS",
                "Matrix room creation timed out and may have succeeded. Refresh the parent Space before trying again."
            );
        } else if (createSpaceMayHaveSucceeded) {
            error = bridgeError(
                "MATRIX_CREATE_SPACE_AMBIGUOUS",
                "Matrix Space creation timed out and may have succeeded. Refresh your Spaces before trying again."
            );
        } else if (commandType === "createSpaceChild") {
            error = bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_PRE_DISPATCH_TIMEOUT",
                "Matrix room creation timed out before dispatch. No room was created."
            );
        } else {
            error = interruptedAccessMutation ?? bridgeError(
                "MATRIX_COMMAND_TIMEOUT",
                `The Matrix ${commandType} operation timed out; its backend was restarted.`
            );
        }
        failWorker(error);
    }, queued
        ? COMMAND_QUEUE_TIMEOUT_MS
        : commandType === "createGroupChat"
            ? GROUP_CHAT_CREATE_TIMEOUT_MS
        : mutationDispatched && commandType === "joinSuggestedSpaceChannels"
            ? SUGGESTED_SPACE_CHANNEL_JOIN_TIMEOUT_MS
            : COMMAND_TIMEOUT_MS);
}

function startupTimeoutError(stage: MatrixWorkerStartupStage): Error {
    switch (stage) {
        case "store":
            return bridgeError(
                "MATRIX_STARTUP_STORE_TIMEOUT",
                "Matrix startup timed out while opening its local sync store. Toggle the plugin to try again."
            );
        case "session":
            return bridgeError(
                "MATRIX_STARTUP_SESSION_TIMEOUT",
                "Matrix startup timed out while validating its saved session. Toggle the plugin to try again."
            );
        case "crypto-module":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_MODULE_TIMEOUT",
                "Matrix startup timed out while loading its crypto module. Toggle the plugin to try again."
            );
        case "crypto-wasm":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_WASM_TIMEOUT",
                "Matrix startup timed out while initializing its crypto runtime. Toggle the plugin to try again."
            );
        case "crypto-store":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_STORE_TIMEOUT",
                "Matrix startup timed out while opening its encrypted crypto store. Toggle the plugin to try again."
            );
        case "crypto-machine":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_MACHINE_TIMEOUT",
                "Matrix startup timed out while restoring its encryption machine. Toggle the plugin to try again."
            );
        case "client":
            return bridgeError(
                "MATRIX_STARTUP_CLIENT_TIMEOUT",
                "Matrix startup timed out while starting sync. Toggle the plugin to try again."
            );
    }
}

function startupStageFailureError(stage: MatrixWorkerStartupStage, causeCode: string): Error {
    switch (stage) {
        case "store":
            return bridgeError(
                "MATRIX_STARTUP_STORE_FAILED",
                "Matrix could not open its local sync store. Toggle the plugin to try again.",
                causeCode
            );
        case "session":
            return bridgeError(
                "MATRIX_STARTUP_SESSION_FAILED",
                "Matrix could not validate its saved session. Toggle the plugin to try again.",
                causeCode
            );
        case "crypto-module":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_MODULE_FAILED",
                "Matrix could not load its crypto module. Toggle the plugin to try again.",
                causeCode
            );
        case "crypto-wasm":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_WASM_FAILED",
                "Matrix could not initialize its crypto runtime. Toggle the plugin to try again.",
                causeCode
            );
        case "crypto-store":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_STORE_FAILED",
                "Matrix could not open its encrypted crypto store. Toggle the plugin to try again.",
                causeCode
            );
        case "crypto-machine":
            return bridgeError(
                "MATRIX_STARTUP_CRYPTO_MACHINE_FAILED",
                "Matrix could not restore its encryption machine. Toggle the plugin to try again.",
                causeCode
            );
        case "client":
            return bridgeError(
                "MATRIX_STARTUP_CLIENT_FAILED",
                "Matrix could not start sync. Toggle the plugin to try again.",
                causeCode
            );
    }
}

function latchStartupFailure(pending: PendingWorkerRequest, error: Error): void {
    if (!pending.startupBinding) return;
    startupFailureLatch = {
        binding: { ...pending.startupBinding },
        error: errorDTO(error)
    };
}

function isSessionRecoveryError(error: MatrixBridgeError): boolean {
    return error.code === "MATRIX_REAUTH_REQUIRED" || error.code === "MATRIX_SESSION_RESET_REQUIRED";
}

const RETRYABLE_PRE_CRYPTO_SESSION_FAILURES = new Set([
    "MATRIX_NETWORK_ERROR",
    "MATRIX_REQUEST_TIMEOUT",
    "MATRIX_SERVER_UNAVAILABLE"
]);

function retryablePreCryptoSessionFailure(
    pending: PendingWorkerRequest,
    error: MatrixBridgeError
): boolean {
    return pending.startupStage === "session" && RETRYABLE_PRE_CRYPTO_SESSION_FAILURES.has(error.code);
}

function latchActiveSessionFailure(error: MatrixBridgeError): void {
    if (!activeWorkerBinding || !isSessionRecoveryError(error)) return;
    startupFailureLatch = {
        binding: { ...activeWorkerBinding },
        error: { ...error }
    };
}

function startupStageTimer(pending: PendingWorkerRequest): ReturnType<typeof setTimeout> {
    const stage = pending.startupStage!;
    const now = Date.now();
    const overallRemaining = Math.max(1, (pending.startupDeadline ?? now) - now);
    const cryptoRemaining = stage.startsWith("crypto-")
        ? Math.max(1, (pending.startupCryptoDeadline ?? now) - now)
        : overallRemaining;
    const duration = Math.max(1, Math.min(
        STARTUP_STAGE_TIMEOUT_MS[stage],
        overallRemaining,
        cryptoRemaining
    ));
    return setTimeout(() => {
        const error = startupTimeoutError(stage);
        latchStartupFailure(pending, error);
        failWorker(error);
    }, duration);
}

function startupInitialTimer(pending: PendingWorkerRequest): ReturnType<typeof setTimeout> {
    const remaining = Math.max(1, (pending.startupDeadline ?? Date.now()) - Date.now());
    return setTimeout(() => {
        const error = startupTimeoutError("store");
        latchStartupFailure(pending, error);
        failWorker(error);
    }, Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remaining)));
}

function handleWorkerMessage(message: MatrixWorkerMessage): void {
    if (message.kind === "ready") {
        resolveWorkerReady?.();
        resolveWorkerReady = null;
        rejectWorkerReady = null;
        return;
    }

    if (message.kind === "event") {
        const event = publishWorkerEvent(message.revision, message.event);
        if (event.type === "status" && event.status.state === "error" && event.status.error
            && isSessionRecoveryError(event.status.error)) {
            const error = bridgeError(event.status.error.code, event.status.error.message);
            if (activeWorkerBinding) {
                latchActiveSessionFailure(event.status.error);
            } else {
                const startup = [...pendingWorkerRequests.values()].find(pending =>
                    pending.commandType === "start" && pending.started && pending.startupBinding);
                if (startup) latchStartupFailure(startup, error);
            }
            failWorker(error);
        }
        return;
    }

    const pending = pendingWorkerRequests.get(message.id);
    if (!pending) return;
    if (message.kind === "started") {
        clearTimeout(pending.timer);
        pending.started = true;
        if (pending.commandType === "start") {
            pending.startupDeadline = Date.now() + STARTUP_OVERALL_TIMEOUT_MS;
        }
        pending.timer = pending.commandType === "start"
            ? startupInitialTimer(pending)
            : commandTimer(pending.commandType, false);
        return;
    }
    if (message.kind === "mutation") {
        if (!pending.started || pending.mutationDispatched || !mutationSignalCommandType(pending.commandType)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned an invalid mutation boundary.");
        }
        pending.mutationDispatched = true;
        clearTimeout(pending.timer);
        pending.timer = commandTimer(pending.commandType, false, true);
        return;
    }
    if (message.kind === "progress") {
        const currentIndex = pending.startupStage == null
            ? -1
            : STARTUP_STAGES.indexOf(pending.startupStage);
        const nextIndex = STARTUP_STAGES.indexOf(message.stage);
        const monotonic = currentIndex < 0
            ? nextIndex === 0
            : nextIndex > currentIndex;
        if (!pending.started || pending.commandType !== "start"
            || !pending.startupBinding || pending.startupDeadline == null
            || !monotonic) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned invalid startup progress.");
        }
        pending.startupStage = message.stage;
        if (message.stage.startsWith("crypto-") && pending.startupCryptoDeadline == null) {
            pending.startupCryptoDeadline = Math.min(
                pending.startupDeadline,
                Date.now() + STARTUP_STAGE_TIMEOUT_MS[message.stage]
            );
        }
        clearTimeout(pending.timer);
        pending.timer = startupStageTimer(pending);
        return;
    }
    pendingWorkerRequests.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) {
        if (pending.commandType === "start" && pending.startupBinding) {
            clearStartupFailure(pending.startupBinding);
        }
        pending.resolve(message.result);
        return;
    }

    if (pending.commandType === "start" && pending.startupStage && pending.startupBinding) {
        // initRustCrypto does not expose its in-progress StoreHandle through
        // client.cryptoBackend. Destroy this exact worker on any staged startup
        // failure so a leaked handle cannot poison the next deliberate retry.
        const retryableSessionFailure = retryablePreCryptoSessionFailure(pending, message.error);
        const error = isSessionRecoveryError(message.error)
            ? bridgeError(message.error.code, message.error.message)
            : startupStageFailureError(pending.startupStage, message.error.code);
        // A proven transient session failure happened before Rust crypto was
        // opened and before any ambiguous refresh attempt. The backend closed
        // its sync store, and failWorker still destroys this exact worker, so
        // the renderer may use its bounded reconnect loop without clearing any
        // account or crypto data. Every other staged failure stays latched.
        if (!retryableSessionFailure) latchStartupFailure(pending, error);
        failWorker(error);
        pending.reject(error);
        return;
    }
    const error = bridgeError(message.error.code, message.error.message);
    if (pending.commandType === "createSpace" && pending.mutationDispatched
        && error.name !== "MATRIX_CREATE_SPACE_REJECTED") {
        pending.reject(bridgeError(
            "MATRIX_CREATE_SPACE_AMBIGUOUS",
            "Matrix could not confirm Space creation after dispatch. A Space may exist; refresh before trying again."
        ));
        return;
    }
    if (pending.commandType === "createGroupChat" && pending.mutationDispatched
        && error.name !== "MATRIX_CREATE_GROUP_CHAT_REJECTED") {
        pending.reject(bridgeError(
            "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
            "Matrix could not confirm group-chat creation after dispatch. Reconcile it before trying again."
        ));
        return;
    }
    if (pending.commandType === "inviteUserToGroupChat" && pending.mutationDispatched
        && error.name !== "MATRIX_GROUP_CHAT_INVITE_REJECTED") {
        pending.reject(bridgeError(
            "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS",
            "Matrix could not confirm the group-chat invite after dispatch. Reconcile it before any retry."
        ));
        return;
    }
    if (isSessionRecoveryError(message.error) && activeWorkerBinding) {
        latchActiveSessionFailure(message.error);
        failWorker(error);
    }
    pending.reject(error);
}

ipcMain.on(MATRIX_WORKER_MESSAGE, (event, message: MatrixWorkerMessage) => {
    if (!workerWindow || event.sender !== workerWindow.webContents) return;
    try {
        handleWorkerMessage(message);
    } catch {
        const error = bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned invalid event data.");
        failWorker(error);
    }
});

ipcMain.handle(MATRIX_WORKER_SAVE_CREDENTIALS, async (event, update: MatrixCredentialUpdate) => {
    if (!workerWindow || event.sender !== workerWindow.webContents) {
        throw bridgeError("MATRIX_UNTRUSTED_WORKER", "Credential update rejected.");
    }
    return runAccountMutation(async () => {
        if (logoutInProgress) {
            throw bridgeError("MATRIX_LOGOUT_IN_PROGRESS", "Credential updates are disabled while logging out.");
        }

        const existing = await readStoredAccount();
        if (!existing) throw bridgeError("MATRIX_ACCOUNT_MISSING", "No Matrix account is configured.");

        const homeserver = validateHomeserver(update?.homeserver);
        const userId = validateUserId(update?.userId);
        const deviceId = validateString(update?.deviceId, "deviceId", 512);
        if (homeserver !== existing.homeserver || userId !== existing.userId || deviceId !== existing.deviceId) {
            throw bridgeError("MATRIX_CREDENTIAL_MISMATCH", "The Matrix credential update did not match the configured account.");
        }

        await writeStoredAccount({
            ...existing,
            accessToken: validateString(update.accessToken, "accessToken", 65_536),
            refreshToken: update.refreshToken == null
                ? undefined
                : validateString(update.refreshToken, "refreshToken", 65_536)
        });
    });
});

ipcMain.handle(MATRIX_WORKER_FETCH_KLIPY_PREVIEW, async (event, input: unknown) => {
    if (!workerWindow || event.sender !== workerWindow.webContents) return undefined;

    let url: string;
    try {
        url = validateKlipyShareUrl(input);
    } catch {
        return undefined;
    }

    return await requestKlipyPreview(url);
});

async function ensureWorker(): Promise<void> {
    await app.whenReady();
    if (workerWindow && !workerWindow.isDestroyed() && workerReady) return workerReady;

    const workerSession = session.fromPartition(WORKER_PARTITION);
    workerSession.setPermissionCheckHandler(() => false);
    workerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    if (!workerSession.protocol.isProtocolHandled("https")) {
        workerSession.protocol.handle("https", async request => {
            const url = new URL(request.url);
            if (url.origin !== MATRIX_WORKER_ORIGIN) {
                return net.fetch(request, { bypassCustomProtocolHandlers: true });
            }

            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(WORKER_HTML, {
                    headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cross-Origin-Opener-Policy": "same-origin",
                        "Referrer-Policy": "no-referrer",
                        "X-Content-Type-Options": "nosniff"
                    }
                });
            }

            let asset: string | null = null;
            if (url.pathname === `/${WORKER_SCRIPT}`) asset = WORKER_SCRIPT;
            if (url.pathname === `/pkg/${WORKER_WASM}` || url.pathname === `/${WORKER_WASM}`) asset = WORKER_WASM;
            if (!asset || request.method !== "GET") return new Response(null, { status: 404 });
            try {
                const body = new Uint8Array(await readFile(join(__dirname, asset)));
                return new Response(body, {
                    headers: {
                        "Content-Type": asset === WORKER_WASM ? "application/wasm" : "text/javascript; charset=utf-8",
                        "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff"
                    }
                });
            } catch {
                return new Response(null, { status: 404 });
            }
        });
    }

    lastWorkerRevision = 0;
    lastWorkerEventSequence = 0;
    workerRevisionSequences.clear();
    workerReady = new Promise<void>((resolve, reject) => {
        resolveWorkerReady = resolve;
        rejectWorkerReady = reject;
    });

    const readyTimeout = setTimeout(() => {
        failWorker(bridgeError("MATRIX_WORKER_TIMEOUT", "The isolated Matrix backend did not start."));
    }, 30_000);
    workerReady.finally(() => clearTimeout(readyTimeout)).catch(() => undefined);

    const win = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        skipTaskbar: true,
        webPreferences: {
            partition: WORKER_PARTITION,
            preload: join(__dirname, WORKER_PRELOAD),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            devTools: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: false,
            spellcheck: false
        }
    });
    activeWorkerBinding = null;
    workerWindow = win;

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== MATRIX_WORKER_ORIGIN) event.preventDefault();
    });
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    win.webContents.on("render-process-gone", () => {
        if (workerWindow !== win) return;
        const error = bridgeError("MATRIX_WORKER_CRASHED", "The isolated Matrix backend stopped unexpectedly.");
        failWorker(error);
    });
    win.on("closed", () => {
        if (workerWindow !== win) return;
        markAccountLifecycleChange();
        workerWindow = null;
        activeWorkerBinding = null;
        const error = bridgeError("MATRIX_WORKER_CLOSED", "The isolated Matrix backend was closed unexpectedly.");
        rejectWorker(error);
        updateStatus("error", currentStatus.account, errorDTO(error));
    });

    await win.loadURL(`${MATRIX_WORKER_ORIGIN}/`);
    return workerReady;
}

async function clearWorkerStorage(): Promise<void> {
    try {
        await session.fromPartition(WORKER_PARTITION).clearStorageData();
    } catch {
        throw bridgeError("MATRIX_STORAGE_CLEANUP_FAILED", "The local Matrix worker storage could not be cleared.");
    }
}

async function callWorker<T extends MatrixWorkerResult>(command: MatrixWorkerCommand): Promise<T> {
    await ensureWorker();
    if (!workerWindow || workerWindow.isDestroyed()) {
        throw bridgeError("MATRIX_WORKER_UNAVAILABLE", "The isolated Matrix backend is unavailable.");
    }

    return new Promise<T>((resolve, reject) => {
        const id = randomUUID();
        const timer = commandTimer(command.type, true);

        pendingWorkerRequests.set(id, {
            resolve: value => resolve(value as T),
            reject,
            timer,
            commandType: command.type,
            started: false,
            mutationDispatched: false,
            ...(command.type === "start" ? { startupBinding: accountBinding(command.account)! } : {})
        });
        workerWindow!.webContents.send(MATRIX_WORKER_COMMAND, { id, command });
    });
}

function runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
}

function runAccountMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = accountMutationTail.then(operation, operation);
    accountMutationTail = result.then(() => undefined, () => undefined);
    return result;
}

function runSnapshotCut<T>(operation: () => Promise<T>): Promise<T> {
    const result = snapshotCutTail.then(operation, operation);
    snapshotCutTail = result.then(() => undefined, () => undefined);
    return result;
}

function validateLogin(login: MatrixLoginRequest): MatrixLoginRequest {
    if (!login || typeof login !== "object") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Login details are required.");
    }

    const homeserver = validateHomeserver(login.homeserver);
    if (login.method === "password") {
        return {
            homeserver,
            method: "password",
            username: validateUsername(login.username),
            password: validateString(login.password, "password", 65_536)
        };
    }
    if (login.method === "access_token") {
        return {
            homeserver,
            method: "access_token",
            accessToken: validateString(login.accessToken, "accessToken", 65_536)
        };
    }
    throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix sign-in method is invalid.");
}

function validateReauthentication(input: MatrixReauthenticationRequest): MatrixReauthenticationRequest {
    if (!input || typeof input !== "object") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Matrix reauthentication details are required.");
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
    throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix reauthentication method is invalid.");
}

function validateRegistration(registration: MatrixRegistrationRequest): MatrixRegistrationRequest {
    if (!registration || typeof registration !== "object") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Registration details are required.");
    }
    return {
        homeserver: validateHomeserver(registration.homeserver),
        username: validateUsername(registration.username),
        password: validateString(registration.password, "password", 65_536),
        registrationToken: validateRegistrationToken(registration.registrationToken)
    };
}

function isAuthenticationResult(result: MatrixWorkerResult): result is { credentials: MatrixSessionCredentials; } {
    return Boolean(result && typeof result === "object" && "credentials" in result);
}

async function requireStarted(): Promise<void> {
    // Secure-view account requests are already counted by
    // beginPrivateAccountRequest(). Let a healthy request finish on that exact
    // worker while an identity transition waits for the count to drain. Never
    // enqueue a worker restart from inside the drained request: doing so would
    // deadlock behind the transition, and could otherwise resume on a new
    // account after the view's authorization check.
    if (privateAccountRequestContext.getStore() === true && !pluginSuspended && !logoutInProgress) {
        const account = await readStoredAccount();
        const binding = accountBinding(account);
        if (account && (currentStatus.state === "ready" || currentStatus.state === "syncing")
            && hasLiveWorker() && sameAccountBinding(activeWorkerBinding, binding)) {
            return;
        }
        if (privateAccountRequests > 0) {
            throw bridgeError(
                "MATRIX_SESSION_CHANGED",
                "The Matrix account worker changed during an isolated account request. Refresh and try again."
            );
        }
    }
    // Starting is a lifecycle transition too. Serializing it with explicit
    // start/login/logout prevents two ordinary renderer calls from issuing
    // competing worker `start` commands and canceling the poller's startup.
    await runLifecycle(async () => {
        if (pluginSuspended) {
            throw bridgeError("MATRIX_PLUGIN_SUSPENDED", "The Matrix plugin is disabled.");
        }
        if (logoutInProgress) {
            throw bridgeError("MATRIX_LOGOUT_IN_PROGRESS", "Matrix is logging out.");
        }
        const account = await readStoredAccount();
        if (!account) throw bridgeError("MATRIX_ACCOUNT_MISSING", "No Matrix account is configured.");
        const startupFailure = startupFailureForAccount(account);
        if (startupFailure) {
            throw bridgeError(startupFailure.error.code, startupFailure.error.message);
        }
        if ((currentStatus.state === "ready" || currentStatus.state === "syncing")
            && hasLiveWorker() && sameAccountBinding(activeWorkerBinding, accountBinding(account))) return;
        await startInternal(account);
    });
}

function validateProtocolJoinedRoomIds(value: unknown): MatrixJoinedRoomIdsResult {
    const raw = protocolObjectKeys(value, "joined-room IDs", ["roomIds"]);
    if (!Array.isArray(raw.roomIds) || raw.roomIds.length > 100_000) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix joined-room response was invalid.");
    }
    const roomIds = raw.roomIds.map(protocolRoomId);
    if (roomIds.some((roomId, index) => index > 0 && roomIds[index - 1] >= roomId)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix joined-room response was not unique and sorted.");
    }
    return { roomIds };
}

async function bestEffortPruneUnjoinedGroupChatInviteReceipts(
    binding: MatrixAccountBinding,
    expectedWorker: BrowserWindow
): Promise<void> {
    try {
        if (accountLifecycleTransitions > 0 || workerWindow !== expectedWorker
            || expectedWorker.isDestroyed() || !sameAccountBinding(binding, activeWorkerBinding)) return;
        const captured = await captureGroupChatInviteReceipts(binding);
        if (!captured.length || accountLifecycleTransitions > 0 || workerWindow !== expectedWorker
            || expectedWorker.isDestroyed() || !sameAccountBinding(binding, activeWorkerBinding)) return;
        const raw = await callWorker<MatrixJoinedRoomIdsResult>({ type: "joinedRoomIds" });
        const joined = validateProtocolJoinedRoomIds(raw);
        if (accountLifecycleTransitions > 0 || workerWindow !== expectedWorker
            || expectedWorker.isDestroyed() || !sameAccountBinding(binding, activeWorkerBinding)) return;

        // The network read deliberately owns no account lease, so a logout or
        // worker restart can cancel it immediately. Hold a short lease only
        // while rechecking the exact worker/account and atomically updating the
        // local receipt file.
        let releaseAccount: (() => void) | undefined;
        try {
            releaseAccount = beginAccountBoundOperation(binding);
        } catch {
            return;
        }
        try {
            if (accountLifecycleTransitions > 0 || workerWindow !== expectedWorker
                || expectedWorker.isDestroyed() || !sameAccountBinding(binding, activeWorkerBinding)) return;
            await pruneUnjoinedGroupChatInviteReceipts(binding, captured, new Set(joined.roomIds));
        } finally {
            releaseAccount();
        }
    } catch (error) {
        // A transient /joined_rooms failure must retain every ambiguity receipt.
        console.warn(`[MatrixBridge] Could not prune unjoined group-chat invite receipts (${errorDTO(error).code}).`);
    }
}

function scheduleUnjoinedGroupChatInviteReceiptPrune(binding: MatrixAccountBinding): void {
    const expectedWorker = workerWindow;
    if (!expectedWorker || expectedWorker.isDestroyed()
        || groupChatInvitePruneScheduledWorkers.has(expectedWorker)) return;
    groupChatInvitePruneScheduledWorkers.add(expectedWorker);
    // Never add homeserver latency to startup/snapshot delivery. The captured
    // worker identity and binding are rechecked before any local deletion. A
    // worker gets at most one housekeeping request; ordinary snapshots never
    // turn this into a joined_rooms poller.
    setTimeout(() => {
        void bestEffortPruneUnjoinedGroupChatInviteReceipts(binding, expectedWorker);
    }, 0);
}

async function startInternal(account: MatrixStoredAccount): Promise<MatrixSnapshot> {
    return await runAccountLifecycleTransition(async () => {
        const binding = accountBinding(account)!;
        if (activeWorkerBinding && !sameAccountBinding(activeWorkerBinding, binding)) {
            terminateWorker(bridgeError("MATRIX_ACCOUNT_CHANGED", "The configured Matrix account changed."));
        }
        updateStatus("starting", { userId: account.userId });
        try {
            const sequenceWatermark = sequence;
            const result = await callWorker<MatrixSnapshot>({ type: "start", account });
            if (!result || typeof result !== "object" || !("rooms" in result)) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned an invalid snapshot.");
            }
            const finalized = finalizeSnapshot(result, sequenceWatermark);
            activeWorkerBinding = binding;
            scheduleUnjoinedGroupChatInviteReceiptPrune(binding);
            return finalized;
        } catch (error) {
            updateStatus("error", { userId: account.userId }, errorDTO(error));
            throw error;
        }
    });
}

async function getStatus(_: IpcMainInvokeEvent): Promise<MatrixBridgeStatus> {
    const account = await readStoredAccount();
    if (account && currentStatus.state === "logged_out") {
        currentStatus = { seq: sequence, state: "stopped", account: { userId: account.userId } };
    } else if (!account && !authenticationInProgress
        && ["starting", "syncing", "ready", "stopped"].includes(currentStatus.state)) {
        currentStatus = { seq: sequence, state: "logged_out" };
    }
    return { ...currentStatus, seq: sequence };
}

async function getConfig(_: IpcMainInvokeEvent): Promise<MatrixBridgeConfig> {
    const account = await readStoredAccount();
    if (!account) return { configured: false, persistentE2EE: true };
    return {
        configured: true,
        homeserver: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        persistentE2EE: true
    };
}

async function authenticate(
    command: (storageKey: string) => MatrixWorkerCommand,
    homeserver: string,
    accountWasCreated: boolean
): Promise<MatrixSnapshot> {
    assertSecureStorage();
    if (await readStoredAccount()) {
        throw bridgeError("MATRIX_ALREADY_CONFIGURED", "Log out of the current Matrix account before adding another one.");
    }
    // Retry privacy cleanup after an interrupted logout before persisting a
    // replacement account in this dedicated directory.
    await clearNativeAccountStorage();

    const storageKey = randomBytes(32).toString("base64");
    updateStatus("starting");
    let result: MatrixWorkerResult;
    try {
        result = await callWorker(command(storageKey));
    } catch (error) {
        updateStatus("error", undefined, errorDTO(error));
        throw error;
    }
    if (!isAuthenticationResult(result)) {
        terminateWorker(bridgeError("MATRIX_AUTHENTICATION_DISCARDED", "The invalid Matrix session was discarded."));
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The isolated Matrix backend returned invalid authentication data.");
    }

    const { credentials } = result;
    let account: MatrixStoredAccount;
    try {
        if (validateHomeserver(credentials.homeserver) !== homeserver) {
            throw bridgeError("MATRIX_CREDENTIAL_MISMATCH", "The homeserver returned credentials for a different server.");
        }
        account = validateStoredAccount({
            schema: 1,
            homeserver: credentials.homeserver,
            userId: credentials.userId,
            deviceId: credentials.deviceId,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            storageKey
        });
    } catch (error) {
        terminateWorker(bridgeError("MATRIX_AUTHENTICATION_DISCARDED", "The invalid Matrix session was discarded."));
        updateStatus("error", undefined, errorDTO(error));
        throw error;
    }

    try {
        await runAccountMutation(() => writeStoredAccount(account));
    } catch (error) {
        // Authentication succeeded, but the token must not remain resident in
        // a hidden renderer when secure persistence failed.
        terminateWorker(bridgeError("MATRIX_AUTHENTICATION_DISCARDED", "The unsaved Matrix session was discarded."));
        updateStatus("error", { userId: account.userId }, errorDTO(error));
        if (accountWasCreated) {
            throw bridgeError(
                "MATRIX_ACCOUNT_CREATED_NOT_SAVED",
                "The account was created, but its secure session could not be saved. Sign in with the new username and password."
            );
        }
        throw error;
    }

    try {
        return await startInternal(account);
    } catch (error) {
        const startupError = errorDTO(error);
        throw bridgeError(
            "MATRIX_STARTUP_FAILED",
            `Signed in and saved the session, but sync or encryption could not start: ${startupError.message}`
        );
    }
}

async function login(_: IpcMainInvokeEvent, input: MatrixLoginRequest): Promise<MatrixSnapshot> {
    try {
        return await runLifecycle(() => runAccountLifecycleTransition(async () => {
            pluginSuspended = false;
            authenticationInProgress = true;
            try {
                const loginDetails = validateLogin(input);
                return await authenticate(
                    storageKey => ({ type: "login", login: loginDetails, storageKey }),
                    loginDetails.homeserver,
                    false
                );
            } finally {
                authenticationInProgress = false;
            }
        }));
    } finally {
        // Structured-clone arguments belong to main after IPC. Drop its extra
        // copy as soon as authentication settles; the worker scrubs its copy.
        if (input?.method === "password") input.password = "";
        else if (input?.method === "access_token") input.accessToken = "";
    }
}

async function reauthenticate(
    _: IpcMainInvokeEvent,
    input: MatrixReauthenticationRequest
): Promise<MatrixSnapshot> {
    try {
        return await runLifecycle(() => runAccountLifecycleTransition(async () => {
            pluginSuspended = false;
            authenticationInProgress = true;
            let accountUserId: string | undefined;
            let reauthenticationBinding: MatrixAccountBinding | undefined;
            let credentialsCommitted = false;
            try {
                assertSecureStorage();
                const request = validateReauthentication(input);
                const existing = await runAccountMutation(readStoredAccount);
                if (!existing) {
                    throw bridgeError("MATRIX_ACCOUNT_MISSING", "No Matrix account is configured.");
                }
                accountUserId = existing.userId;
                if (request.homeserver !== existing.homeserver
                    || request.userId !== existing.userId
                    || request.deviceId !== existing.deviceId) {
                    throw bridgeError(
                        "MATRIX_CREDENTIAL_MISMATCH",
                        "The Matrix reauthentication request did not match the configured account."
                    );
                }
                const binding = accountBinding(existing)!;
                reauthenticationBinding = binding;
                const startupFailure = startupFailureForAccount(existing);
                if (startupFailure?.error.code !== "MATRIX_REAUTH_REQUIRED") {
                    throw bridgeError(
                        "MATRIX_REAUTH_NOT_ALLOWED",
                        "This Matrix device cannot be safely reauthenticated in place."
                    );
                }

                // A fresh worker prevents an old client's refresh callback from
                // racing the replacement credentials. Its persistent partition
                // is intentionally retained for the same encrypted device.
                terminateWorker(bridgeError(
                    "MATRIX_SESSION_CHANGED",
                    "The expired Matrix session is being reauthenticated."
                ));
                clearEventStream();
                updateStatus("starting", { userId: existing.userId });

                let result: MatrixWorkerResult;
                try {
                    result = await callWorker({ type: "reauthenticate", reauthentication: request });
                } finally {
                    // The auth-only worker must not retain either submitted or
                    // returned session credentials while native persists them.
                    terminateWorker(bridgeError(
                        "MATRIX_SESSION_CHANGED",
                        "The replacement Matrix session is being committed."
                    ));
                }
                if (!isAuthenticationResult(result)) {
                    throw bridgeError(
                        "MATRIX_PROTOCOL_ERROR",
                        "The isolated Matrix backend returned invalid reauthentication data."
                    );
                }
                const { credentials } = result;
                const replacement = validateStoredAccount({
                    ...existing,
                    homeserver: credentials.homeserver,
                    userId: credentials.userId,
                    deviceId: credentials.deviceId,
                    accessToken: credentials.accessToken,
                    refreshToken: credentials.refreshToken
                });
                if (!sameAccountBinding(binding, accountBinding(replacement))) {
                    throw bridgeError(
                        "MATRIX_REAUTH_IDENTITY_MISMATCH",
                        "The new Matrix session did not match the existing encrypted device."
                    );
                }

                await runAccountMutation(() => writeStoredAccount(replacement));
                credentialsCommitted = true;
                clearStartupFailure(binding);
                return await startInternal(replacement);
            } catch (error) {
                if (hasLiveWorker()) terminateWorker(error instanceof Error
                    ? error
                    : bridgeError("MATRIX_REAUTH_FAILED", "The Matrix session could not be reauthenticated."));
                const recoveryFailure = reauthenticationBinding
                    && startupFailureLatch
                    && sameAccountBinding(reauthenticationBinding, startupFailureLatch.binding)
                    && startupFailureLatch.error.code === "MATRIX_REAUTH_REQUIRED"
                    ? startupFailureLatch.error
                    : undefined;
                if (!credentialsCommitted && recoveryFailure) {
                    // A rejected replacement secret is returned to the caller,
                    // but the durable UI state remains the verified soft logout
                    // so the repair form stays available for another attempt.
                    updateStatus("error", { userId: accountUserId! }, recoveryFailure);
                } else if (!credentialsCommitted || currentStatus.state !== "error") {
                    updateStatus("error", accountUserId ? { userId: accountUserId } : undefined, errorDTO(error));
                }
                throw error;
            } finally {
                authenticationInProgress = false;
            }
        }));
    } finally {
        if (input?.method === "password") input.password = "";
        else if (input?.method === "access_token") input.accessToken = "";
    }
}

async function register(_: IpcMainInvokeEvent, input: MatrixRegistrationRequest): Promise<MatrixSnapshot> {
    try {
        return await runLifecycle(() => runAccountLifecycleTransition(async () => {
            pluginSuspended = false;
            authenticationInProgress = true;
            try {
                const registration = validateRegistration(input);
                return await authenticate(
                    storageKey => ({ type: "register", registration, storageKey }),
                    registration.homeserver,
                    true
                );
            } finally {
                authenticationInProgress = false;
            }
        }));
    } finally {
        if (input && typeof input === "object") {
            input.password = "";
            input.registrationToken = "";
        }
    }
}

async function logout(_: IpcMainInvokeEvent): Promise<void> {
    return runLifecycle(() => runAccountLifecycleTransition(async () => {
        logoutInProgress = true;
        clearStartupFailure();
        try {
            // Remove the native account first. Worker status events emitted while
            // stopping must not let the renderer auto-start this account again.
            await runAccountMutation(deleteStoredAccount);

            // A live worker can still own a client even when the account record is
            // already absent (for example after an interrupted previous logout).
            if (hasLiveWorker()) {
                try {
                    await callWorker({ type: "logout" });
                } catch (error) {
                    terminateWorker(error instanceof Error
                        ? error
                        : bridgeError("MATRIX_LOGOUT_FAILED", "The Matrix backend could not be stopped cleanly."));
                }
            }

            // Destroy the isolated renderer before clearing its dedicated
            // partition so no open IndexedDB handles can retain account data.
            if (workerWindow && !workerWindow.isDestroyed()) {
                terminateWorker(bridgeError("MATRIX_LOGOUT_IN_PROGRESS", "Matrix logged out before the operation completed."));
            }

            let cleanupError: MatrixBridgeError | undefined;
            try {
                await clearWorkerStorage();
            } catch (error) {
                cleanupError = errorDTO(error);
            }
            try {
                await clearNativeAccountStorage();
            } catch (error) {
                cleanupError ??= errorDTO(error);
            }

            // Do not let a new poller replay snapshots or events from the
            // disconnected account. Sequence remains monotonic across logins.
            clearEventStream();
            updateStatus("logged_out", undefined, cleanupError);
            if (cleanupError) throw bridgeError(cleanupError.code, cleanupError.message);
        } finally {
            logoutInProgress = false;
        }
    }));
}

async function start(_: IpcMainInvokeEvent): Promise<MatrixSnapshot> {
    return runLifecycle(async () => {
        pluginSuspended = false;
        const account = await readStoredAccount();
        if (!account) {
            // A crash after deleting account.enc but before normal logout
            // cleanup can leave an orphaned sync/crypto partition. With no
            // credentials left, purge it before reporting an empty account.
            if (workerWindow && !workerWindow.isDestroyed()) {
                terminateWorker(bridgeError("MATRIX_ACCOUNT_MISSING", "No Matrix account is configured."));
            }
            clearEventStream();
            let cleanupError: MatrixBridgeError | undefined;
            try { await clearWorkerStorage(); } catch (error) { cleanupError = errorDTO(error); }
            try { await clearNativeAccountStorage(); } catch (error) { cleanupError ??= errorDTO(error); }
            if (cleanupError) {
                updateStatus("logged_out", undefined, cleanupError);
                throw bridgeError(cleanupError.code, cleanupError.message);
            }
            if (currentStatus.state !== "logged_out" || currentStatus.error) updateStatus("logged_out");
            return emptySnapshot();
        }
        const startupFailure = startupFailureForAccount(account);
        if (startupFailure) {
            if (currentStatus.state !== "error"
                || currentStatus.error?.code !== startupFailure.error.code) {
                updateStatus("error", { userId: account.userId }, startupFailure.error);
            }
            return emptySnapshot();
        }
        if ((currentStatus.state === "ready" || currentStatus.state === "syncing")
            && currentStatus.account?.userId === account.userId && hasLiveWorker()
            && sameAccountBinding(activeWorkerBinding, accountBinding(account))) {
            const sequenceWatermark = sequence;
            const result = await callWorker<MatrixSnapshot>({ type: "snapshot" });
            return finalizeSnapshot(result, sequenceWatermark);
        }
        try {
            return await startInternal(account);
        } catch (error) {
            const latchedFailure = startupFailureForAccount(account);
            if (latchedFailure && error instanceof Error && error.name === latchedFailure.error.code) {
                return emptySnapshot();
            }
            throw error;
        }
    });
}

async function suspend(_: IpcMainInvokeEvent): Promise<void> {
    return runLifecycle(() => runAccountLifecycleTransition(async () => {
        pluginSuspended = true;
        clearStartupFailure();
        if (logoutInProgress) return;
        let account: MatrixStoredAccount | null = null;
        try {
            account = await readStoredAccount();
        } catch {
            // Suspending must remain fail-safe even if secure storage is
            // unavailable or the stored account record is corrupt.
        }
        try {
            if (hasLiveWorker()) {
                await callWorker({ type: "suspend" });
            }
        } catch {
            // The finally block below still destroys the isolated renderer.
        } finally {
            if (workerWindow && !workerWindow.isDestroyed()) {
                terminateWorker(bridgeError("MATRIX_SUSPENDED", "The Matrix plugin was disabled."));
            }
            clearEventStream();
        }
        const accountIdentity = account ? { userId: account.userId } : currentStatus.account;
        updateStatus(accountIdentity ? "stopped" : "logged_out", accountIdentity);
    }));
}

async function snapshot(_: IpcMainInvokeEvent): Promise<MatrixSnapshot> {
    const account = await readStoredAccount();
    if (!account) return emptySnapshot();
    await requireStarted();
    const sequenceWatermark = sequence;
    const result = await callWorker<MatrixSnapshot>({ type: "snapshot" });
    return finalizeSnapshot(result, sequenceWatermark);
}

async function publicRooms(_: IpcMainInvokeEvent): Promise<MatrixPublicRoomDirectoryDTO> {
    await requireStarted();
    const result = await callWorker<MatrixPublicRoomDirectoryDTO>({ type: "publicRooms" });
    return validateProtocolPublicRoomDirectory(result);
}

async function runRoomJoin<T>(
    binding: MatrixAccountBinding,
    target: string,
    operation: () => Promise<T>
): Promise<T> {
    const operationKey = JSON.stringify([
        binding.homeserver,
        binding.userId,
        binding.deviceId,
        binding.storageKey,
        target
    ]);
    if (roomJoinsInFlight.has(operationKey)) {
        throw bridgeError("MATRIX_ROOM_JOIN_IN_PROGRESS", "That Matrix room is already being joined.");
    }
    if (roomJoinsInFlight.size >= MAX_IN_FLIGHT_ROOM_JOINS) {
        throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many room joins pending.");
    }
    roomJoinsInFlight.add(operationKey);
    try {
        return await operation();
    } finally {
        roomJoinsInFlight.delete(operationKey);
    }
}

async function joinRoom(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<MatrixJoinRoomResult> {
    const targetRoomId = validateRoomId(roomId);
    return await withExpectedMatrixAccount(expectedUserId, binding =>
        runRoomJoin(binding, targetRoomId, async () => {
            const result = await callWorker<MatrixJoinRoomResult>({ type: "joinRoom", roomId: targetRoomId });
            try {
                if (!result || typeof result !== "object" || typeof result.roomId !== "string") throw new Error();
                const joinedRoomId = validateRoomId(result.roomId);
                if (joinedRoomId !== targetRoomId) throw new Error();
                return { roomId: joinedRoomId };
            } catch {
                throw bridgeError(
                    "MATRIX_ROOM_JOIN_AMBIGUOUS",
                    "Matrix joined a room but returned an invalid confirmation. Refresh rooms before trying again."
                );
            }
        }));
}

async function joinRoomAddress(
    _: IpcMainInvokeEvent,
    address: string,
    expectedUserId: string
): Promise<MatrixJoinRoomResult> {
    return await withExpectedMatrixAccount(expectedUserId, binding => {
        const localAddress = validateLocalRoomAddress(address, serverNameFromMatrixIdentifier(binding.userId));
        return runRoomJoin(binding, localAddress, async () => {
            const result = await callWorker<MatrixJoinRoomResult>({
                type: "joinRoomAddress",
                address: localAddress
            });
            try {
                if (!result || typeof result !== "object" || typeof result.roomId !== "string") throw new Error();
                const joinedRoomId = validateRoomId(result.roomId);
                const accountServer = serverNameFromMatrixIdentifier(binding.userId);
                if (localAddress.startsWith("!")
                    ? joinedRoomId !== localAddress
                    : joinedRoomId.includes(":")
                        && serverNameFromMatrixIdentifier(joinedRoomId) !== accountServer) {
                    throw new Error();
                }
                return { roomId: joinedRoomId };
            } catch {
                throw bridgeError(
                    "MATRIX_ROOM_JOIN_AMBIGUOUS",
                    "Matrix joined a room but returned an invalid confirmation. Refresh rooms before trying again."
                );
            }
        });
    });
}

async function roomInviteAction(
    commandType: "acceptInvite" | "rejectInvite",
    roomId: string,
    expectedUserId: string
): Promise<MatrixRoomActionResult> {
    const targetRoomId = validateRoomId(roomId);
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const operationKey = JSON.stringify([
            binding.homeserver,
            binding.userId,
            binding.deviceId,
            binding.storageKey,
            targetRoomId
        ]);
        if (roomInviteActionsInFlight.has(operationKey)) {
            throw bridgeError("MATRIX_ROOM_INVITE_ACTION_IN_PROGRESS", "That Matrix invitation is already being handled.");
        }
        if (roomInviteActionsInFlight.size >= MAX_IN_FLIGHT_ROOM_INVITE_ACTIONS) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending invitation actions.");
        }
        roomInviteActionsInFlight.add(operationKey);
        try {
            const result = await callWorker<MatrixRoomActionResult>({ type: commandType, roomId: targetRoomId });
            try {
                return validateRoomActionResult(result, targetRoomId);
            } catch {
                throw commandType === "acceptInvite"
                    ? bridgeError(
                        "MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS",
                        "Matrix accepted the invitation but returned an invalid confirmation. Refresh rooms before trying again."
                    )
                    : bridgeError(
                        "MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS",
                        "Matrix declined the invitation but returned an invalid confirmation. Refresh rooms before trying again."
                    );
            }
        } finally {
            roomInviteActionsInFlight.delete(operationKey);
        }
    });
}

async function acceptInvite(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<MatrixRoomActionResult> {
    return await roomInviteAction("acceptInvite", roomId, expectedUserId);
}

async function rejectInvite(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<MatrixRoomActionResult> {
    return await roomInviteAction("rejectInvite", roomId, expectedUserId);
}

async function leaveRoom(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<MatrixRoomActionResult> {
    const targetRoomId = validateRoomId(roomId);
    const targetUserId = validateUserId(expectedUserId);
    await requireStarted();
    const binding = activeWorkerBinding;
    if (!binding || binding.userId !== targetUserId) {
        throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account changed. Try again.");
    }

    // The synchronous lease acquisition closes the only gap after
    // requireStarted(): an already-running identity transition rejects here,
    // while a later transition must wait until the leave response is checked.
    const releaseAccount = beginAccountBoundOperation(binding);
    const receiptOperationKey = groupChatInviteLatchKey(binding, targetRoomId);
    try {
        if (groupChatInviteOperationsInFlight.has(receiptOperationKey)) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_IN_PROGRESS",
                "Finish reconciling the group-chat invite before leaving this room."
            );
        }
        if (groupChatInviteOperationsInFlight.size >= MAX_IN_FLIGHT_GROUP_CHAT_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending group-chat operations.");
        }
        groupChatInviteOperationsInFlight.add(receiptOperationKey);
        const result = await callWorker<MatrixRoomActionResult>({ type: "leaveRoom", roomId: targetRoomId });
        if (!sameAccountBinding(binding, activeWorkerBinding)) {
            throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account changed during the leave request.");
        }
        const action = validateRoomActionResult(result, targetRoomId);
        try {
            const pending = await pendingGroupChatInviteForRoom(binding, targetRoomId);
            if (pending) await clearPendingGroupChatInvite(binding, pending);
        } catch (error) {
            // The authoritative leave result wins. A retained receipt will be
            // pruned by the next exact /joined_rooms lifecycle check.
            console.warn(`[MatrixBridge] Room leave succeeded, but its group-chat invite receipt was not cleared (${errorDTO(error).code}).`);
        }
        return action;
    } finally {
        groupChatInviteOperationsInFlight.delete(receiptOperationKey);
        releaseAccount();
    }
}

function validateCreateSpaceRequest(value: unknown): MatrixCreateSpaceRequest {
    if (!value || typeof value !== "object") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix space details are invalid.");
    }
    const input = value as Partial<MatrixCreateSpaceRequest>;
    const name = validateString(input.name, "space name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix space name is invalid.");
    }
    const visibility = input.visibility ?? "private";
    if (visibility !== "private" && visibility !== "public") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix space visibility is invalid.");
    }
    const createGeneral = input.createGeneral ?? true;
    if (typeof createGeneral !== "boolean") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix initial-room option is invalid.");
    }
    const request: MatrixCreateSpaceRequest = { name, visibility, createGeneral };
    if (input.topic != null) {
        const topic = validateString(input.topic, "space topic", 1_024, true).trim();
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix space topic is invalid.");
        }
        if (topic) request.topic = topic;
    }
    return request;
}

async function createSpace(
    _: IpcMainInvokeEvent,
    request: MatrixCreateSpaceRequest,
    expectedUserId: string
): Promise<MatrixCreateSpaceResult> {
    const validatedRequest = validateCreateSpaceRequest(request);
    return await withExpectedMatrixAccount(expectedUserId, async () => {
        if (createSpaceInFlight) {
            throw bridgeError(
                "MATRIX_CREATE_SPACE_IN_PROGRESS",
                "A Matrix Space is already being created."
            );
        }
        createSpaceInFlight = true;
        try {
            // Only validation of a resolved worker response is remapped below.
            // Definitive pre-dispatch capability/argument failures and definitive
            // worker rejections retain their original safe-to-retry taxonomy.
            const result = await callWorker<MatrixCreateSpaceResult>({
                type: "createSpace",
                request: validatedRequest
            });
            try {
                if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
                const roomId = protocolRoomId(result.roomId);
                const generalRoomId = result.generalRoomId == null ? undefined : protocolRoomId(result.generalRoomId);
                let partial: MatrixCreateSpaceResult["partial"];
                if (result.partial != null) {
                    if (typeof result.partial !== "object" || Array.isArray(result.partial)) throw new Error();
                    const code = result.partial.code as MatrixCreateSpacePartialCode;
                    if (code !== "MATRIX_GENERAL_ROOM_CREATE_FAILED"
                        && code !== "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS"
                        && code !== "MATRIX_GENERAL_ROOM_LINK_FAILED") {
                        throw new Error();
                    }
                    partial = {
                        code,
                        message: protocolString(result.partial.message, "space partial-result message", 300)
                    };
                }
                if (generalRoomId === roomId
                    || (!validatedRequest.createGeneral && (generalRoomId || partial))
                    || (validatedRequest.createGeneral && !generalRoomId && !partial)
                    || ((partial?.code === "MATRIX_GENERAL_ROOM_CREATE_FAILED"
                        || partial?.code === "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS") && generalRoomId)
                    || (partial?.code === "MATRIX_GENERAL_ROOM_LINK_FAILED" && !generalRoomId)) {
                    throw new Error();
                }
                return {
                    roomId,
                    ...(generalRoomId ? { generalRoomId } : {}),
                    ...(partial ? { partial } : {})
                };
            } catch {
                throw bridgeError(
                    "MATRIX_CREATE_SPACE_AMBIGUOUS",
                    "Matrix created a Space but returned an invalid confirmation. Refresh Spaces before trying again."
                );
            }
        } finally {
            createSpaceInFlight = false;
        }
    });
}

const SPACE_JOIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const MAX_SPACE_ACCESS_REQUEST_TIMESTAMP = 4_102_444_800_000;

function validateSpaceJoinName(value: unknown): string {
    const joinName = validateString(value, "Space join name", 64);
    if (!SPACE_JOIN_NAME_PATTERN.test(joinName)) {
        throw bridgeError(
            "MATRIX_INVALID_SPACE_JOIN_NAME",
            "Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, with a letter or number at each end."
        );
    }
    return joinName;
}

function validateConfigureSpaceAccessRequest(value: unknown): MatrixConfigureSpaceAccessRequest {
    const input = exactObjectKeys(
        value,
        "Space access settings",
        ["spaceId", "mode", "joinName"],
        ["spaceId", "mode"]
    );
    if (input.mode !== "public" && input.mode !== "request" && input.mode !== "invite") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space access mode is invalid.");
    }
    return {
        spaceId: validateRoomId(input.spaceId),
        mode: input.mode,
        ...(input.joinName == null ? {} : { joinName: validateSpaceJoinName(input.joinName) })
    };
}

function validateResolveSpaceAccessRequest(value: unknown): MatrixResolveSpaceAccessRequest {
    const input = exactObjectKeys(
        value,
        "Space access request decision",
        ["spaceId", "userId", "decision"]
    );
    if (input.decision !== "approve" && input.decision !== "deny") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space access request decision is invalid.");
    }
    return {
        spaceId: validateRoomId(input.spaceId),
        userId: validateUserId(input.userId),
        decision: input.decision
    };
}

async function withExpectedMatrixAccount<T>(
    expectedUserId: string,
    operation: (binding: MatrixAccountBinding) => Promise<T>
): Promise<T> {
    const targetUserId = validateUserId(expectedUserId);
    await requireStarted();
    const binding = activeWorkerBinding;
    if (!binding || binding.userId !== targetUserId) {
        throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account changed. Try again.");
    }
    const releaseAccount = beginAccountBoundOperation(binding);
    try {
        const result = await operation(binding);
        if (!sameAccountBinding(binding, activeWorkerBinding)) {
            throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account changed during the request.");
        }
        return result;
    } finally {
        releaseAccount();
    }
}

function validateProtocolSpaceAccessSummary(
    value: unknown,
    expectedSpaceId: string,
    expectedServerName: string
): MatrixSpaceAccessSummaryDTO {
    const raw = protocolObjectKeys(
        value,
        "Space access summary",
        [
            "spaceId",
            "mode",
            "joinRule",
            "directoryVisibility",
            "historyVisibility",
            "guestAccess",
            "joinName",
            "joinAlias"
        ],
        ["spaceId", "mode", "joinRule", "directoryVisibility", "historyVisibility", "guestAccess"]
    );
    const spaceId = protocolRoomId(raw.spaceId);
    const joinRule = protocolJoinRule(raw.joinRule);
    if (spaceId !== expectedSpaceId || !joinRule
        || (raw.mode !== "public" && raw.mode !== "request" && raw.mode !== "invite")
        || (raw.directoryVisibility !== "public" && raw.directoryVisibility !== "private")
        || (raw.historyVisibility !== "invited" && raw.historyVisibility !== "joined"
            && raw.historyVisibility !== "shared" && raw.historyVisibility !== "world_readable")
        || (raw.guestAccess !== "can_join" && raw.guestAccess !== "forbidden")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access summary was invalid.");
    }
    const derivedMode = joinRule === "public"
        ? "public"
        : joinRule === "knock" || joinRule === "knock_restricted" ? "request" : "invite";
    if (raw.mode !== derivedMode || (raw.joinName == null) !== (raw.joinAlias == null)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access summary was inconsistent.");
    }
    const result: MatrixSpaceAccessSummaryDTO = {
        spaceId,
        mode: raw.mode,
        joinRule,
        directoryVisibility: raw.directoryVisibility,
        historyVisibility: raw.historyVisibility,
        guestAccess: raw.guestAccess
    };
    if (raw.joinName != null) {
        let joinName: string;
        try {
            joinName = validateSpaceJoinName(raw.joinName);
        } catch {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space join name response was invalid.");
        }
        const joinAlias = protocolString(raw.joinAlias, "Space join alias", 1_024);
        if (joinAlias !== `#${joinName}:${expectedServerName}`) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space join alias response was invalid.");
        }
        result.joinName = joinName;
        result.joinAlias = joinAlias;
    }
    return result;
}

function validateProtocolConfigureSpaceAccessResult(
    value: unknown,
    request: MatrixConfigureSpaceAccessRequest,
    expectedServerName: string
): MatrixConfigureSpaceAccessResult {
    const raw = protocolObjectKeys(
        value,
        "Space access configuration",
        ["spaceId", "requestedMode", "access", "accessConfirmed", "complete", "partial"],
        ["spaceId", "requestedMode", "access", "accessConfirmed", "complete"]
    );
    if (protocolRoomId(raw.spaceId) !== request.spaceId || raw.requestedMode !== request.mode
        || typeof raw.accessConfirmed !== "boolean" || typeof raw.complete !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access configuration was inconsistent.");
    }
    const access = validateProtocolSpaceAccessSummary(raw.access, request.spaceId, expectedServerName);
    let partial: MatrixConfigureSpaceAccessResult["partial"];
    if (raw.partial != null) {
        const candidate = protocolObjectKeys(
            raw.partial,
            "Space access partial result",
            ["code", "failedStep", "message"]
        );
        const steps = new Set<MatrixConfigureSpaceAccessStep>([
            "alias",
            "alias_rollback",
            "canonical_alias",
            "history_visibility",
            "guest_access",
            "join_rule",
            "directory",
            "verification"
        ]);
        if (candidate.code !== "MATRIX_SPACE_ACCESS_PARTIAL" || !steps.has(candidate.failedStep as MatrixConfigureSpaceAccessStep)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access partial result was invalid.");
        }
        partial = {
            code: "MATRIX_SPACE_ACCESS_PARTIAL",
            failedStep: candidate.failedStep as MatrixConfigureSpaceAccessStep,
            message: protocolText(candidate.message, "Space access partial-result message", 300)
        };
    }
    if (raw.complete === (partial != null)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access configuration completion state was invalid.");
    }
    if (raw.complete && !raw.accessConfirmed) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access configuration was not confirmed.");
    }
    if (raw.complete) {
        const desiredJoinRule = request.mode === "public" ? "public" : request.mode === "request" ? "knock" : "invite";
        const desiredDirectory = request.mode === "public" ? "public" : "private";
        if (access.joinRule !== desiredJoinRule || access.directoryVisibility !== desiredDirectory
            || access.historyVisibility !== "joined" || access.guestAccess !== "forbidden"
            || (request.joinName != null
                && access.joinAlias !== `#${request.joinName}:${expectedServerName}`)
            || (request.mode === "request" && !access.joinName)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access configuration claimed an incomplete state.");
        }
    }
    return {
        spaceId: request.spaceId,
        requestedMode: request.mode,
        access,
        accessConfirmed: raw.accessConfirmed,
        complete: raw.complete,
        ...(partial ? { partial } : {})
    };
}

function validateProtocolRequestSpaceAccessResult(value: unknown): MatrixRequestSpaceAccessResult {
    const raw = protocolObjectKeys(value, "Space access request", ["roomId", "membership"]);
    if (raw.membership !== "knock" && raw.membership !== "invite" && raw.membership !== "join") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access request membership was invalid.");
    }
    return { roomId: protocolRoomId(raw.roomId), membership: raw.membership };
}

function validateProtocolSpaceAccessRequestMember(value: unknown): MatrixSpaceAccessRequestMemberDTO {
    const raw = protocolObjectKeys(
        value,
        "Space access requester",
        ["userId", "displayName", "avatarUrl", "requestedAt", "canApprove", "canDeny"],
        ["userId", "canApprove", "canDeny"]
    );
    if (typeof raw.canApprove !== "boolean" || typeof raw.canDeny !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access requester permissions were invalid.");
    }
    const result: MatrixSpaceAccessRequestMemberDTO = {
        userId: protocolUserId(raw.userId),
        canApprove: raw.canApprove,
        canDeny: raw.canDeny
    };
    if (raw.displayName != null) {
        result.displayName = protocolText(raw.displayName, "Space access requester display name", 256);
    }
    if (raw.avatarUrl != null) result.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    if (raw.requestedAt != null) {
        if (!Number.isSafeInteger(raw.requestedAt) || Number(raw.requestedAt) < 0
            || Number(raw.requestedAt) > MAX_SPACE_ACCESS_REQUEST_TIMESTAMP) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access request timestamp was invalid.");
        }
        result.requestedAt = Number(raw.requestedAt);
    }
    return result;
}

function validateProtocolSpaceAccessRequestList(
    value: unknown,
    expectedSpaceId: string
): MatrixSpaceAccessRequestListDTO {
    const raw = protocolObjectKeys(
        value,
        "Space access request list",
        ["spaceId", "requests", "truncated", "canApproveAccessRequests", "canDenyAccessRequests"]
    );
    if (protocolRoomId(raw.spaceId) !== expectedSpaceId || !Array.isArray(raw.requests)
        || raw.requests.length > 200 || typeof raw.truncated !== "boolean"
        || typeof raw.canApproveAccessRequests !== "boolean"
        || typeof raw.canDenyAccessRequests !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access request list was invalid.");
    }
    const requests = raw.requests.map(validateProtocolSpaceAccessRequestMember);
    if (new Set(requests.map(request => request.userId)).size !== requests.length
        || requests.some(request => request.canApprove !== raw.canApproveAccessRequests
            || (!raw.canDenyAccessRequests && request.canDeny))) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access request list was inconsistent.");
    }
    return {
        spaceId: expectedSpaceId,
        requests,
        truncated: raw.truncated,
        canApproveAccessRequests: raw.canApproveAccessRequests,
        canDenyAccessRequests: raw.canDenyAccessRequests
    };
}

function validateProtocolResolveSpaceAccessRequestResult(
    value: unknown,
    request: MatrixResolveSpaceAccessRequest
): MatrixResolveSpaceAccessRequestResult {
    const raw = protocolObjectKeys(
        value,
        "Space access request resolution",
        ["spaceId", "userId", "decision", "membership", "accessRequestCount"]
    );
    const membershipValid = request.decision === "approve"
        ? raw.membership === "invite" || raw.membership === "join"
        : raw.membership === "leave";
    if (protocolRoomId(raw.spaceId) !== request.spaceId || protocolUserId(raw.userId) !== request.userId
        || raw.decision !== request.decision || !membershipValid
        || !Number.isSafeInteger(raw.accessRequestCount)
        || Number(raw.accessRequestCount) < 0 || Number(raw.accessRequestCount) > 200) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space access request resolution was invalid.");
    }
    return {
        ...request,
        membership: raw.membership as MatrixResolveSpaceAccessRequestResult["membership"],
        accessRequestCount: Number(raw.accessRequestCount)
    };
}

async function getSpaceAccess(
    _: IpcMainInvokeEvent,
    spaceId: string,
    expectedUserId: string
): Promise<MatrixSpaceAccessSummaryDTO> {
    const targetSpaceId = validateRoomId(spaceId);
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const result = await callWorker<MatrixSpaceAccessSummaryDTO>({ type: "getSpaceAccess", spaceId: targetSpaceId });
        return validateProtocolSpaceAccessSummary(
            result,
            targetSpaceId,
            serverNameFromMatrixIdentifier(binding.userId)
        );
    });
}

async function configureSpaceAccess(
    _: IpcMainInvokeEvent,
    request: MatrixConfigureSpaceAccessRequest,
    expectedUserId: string
): Promise<MatrixConfigureSpaceAccessResult> {
    const validatedRequest = validateConfigureSpaceAccessRequest(request);
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const result = await callWorker<MatrixConfigureSpaceAccessResult>({
            type: "configureSpaceAccess",
            request: validatedRequest
        });
        return validateProtocolConfigureSpaceAccessResult(
            result,
            validatedRequest,
            serverNameFromMatrixIdentifier(binding.userId)
        );
    });
}

async function requestSpaceAccess(
    _: IpcMainInvokeEvent,
    joinName: string,
    expectedUserId: string
): Promise<MatrixRequestSpaceAccessResult> {
    const validatedJoinName = validateSpaceJoinName(joinName);
    return await withExpectedMatrixAccount(expectedUserId, async () => {
        const result = await callWorker<MatrixRequestSpaceAccessResult>({
            type: "requestSpaceAccess",
            joinName: validatedJoinName
        });
        return validateProtocolRequestSpaceAccessResult(result);
    });
}

async function getSpaceAccessRequests(
    _: IpcMainInvokeEvent,
    spaceId: string,
    expectedUserId: string
): Promise<MatrixSpaceAccessRequestListDTO> {
    const targetSpaceId = validateRoomId(spaceId);
    return await withExpectedMatrixAccount(expectedUserId, async () => {
        const result = await callWorker<MatrixSpaceAccessRequestListDTO>({
            type: "getSpaceAccessRequests",
            spaceId: targetSpaceId
        });
        return validateProtocolSpaceAccessRequestList(result, targetSpaceId);
    });
}

async function resolveSpaceAccessRequest(
    _: IpcMainInvokeEvent,
    request: MatrixResolveSpaceAccessRequest,
    expectedUserId: string
): Promise<MatrixResolveSpaceAccessRequestResult> {
    const validatedRequest = validateResolveSpaceAccessRequest(request);
    return await withExpectedMatrixAccount(expectedUserId, async () => {
        const result = await callWorker<MatrixResolveSpaceAccessRequestResult>({
            type: "resolveSpaceAccessRequest",
            request: validatedRequest
        });
        return validateProtocolResolveSpaceAccessRequestResult(result, validatedRequest);
    });
}

function validateSpaceInviteCandidateSearchRequest(value: unknown): Required<MatrixSpaceInviteCandidateSearchRequest> {
    const raw = objectRecord(value, "Matrix Space invite search");
    if (!Object.keys(raw).every(key => key === "spaceId" || key === "query" || key === "limit")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search contains unsupported fields.");
    }
    const query = validateString(
        raw.query,
        "Space invite search query",
        MAX_SPACE_INVITE_DIRECTORY_QUERY_LENGTH,
        true
    ).trim();
    if (/[\u0000-\u001f\u007f]/u.test(query)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search query is invalid.");
    }
    const limit = raw.limit ?? DEFAULT_SPACE_INVITE_DIRECTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_SPACE_INVITE_DIRECTORY_LIMIT) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite search limit is invalid.");
    }
    return { spaceId: validateRoomId(raw.spaceId), query, limit: Number(limit) };
}

function validateInviteUserToSpaceRequest(value: unknown): MatrixInviteUserToSpaceRequest {
    const raw = objectRecord(value, "Matrix Space invite");
    if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "spaceId") || !Object.hasOwn(raw, "userId")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space invite contains invalid fields.");
    }
    return { spaceId: validateRoomId(raw.spaceId), userId: validateUserId(raw.userId) };
}

function validateProtocolSpaceInviteCandidate(
    value: unknown,
    expectedServerName: string,
    expectedUserId: string
): MatrixSpaceInviteCandidateDTO {
    const raw = protocolObjectKeys(
        value,
        "Space invite candidate",
        ["userId", "displayName", "avatarUrl", "membership"],
        ["userId", "membership"]
    );
    const userId = protocolUserId(raw.userId);
    if (userId === expectedUserId || serverNameFromMatrixIdentifier(userId) !== expectedServerName
        || (raw.membership !== "none" && raw.membership !== "leave" && raw.membership !== "knock"
            && raw.membership !== "invite" && raw.membership !== "join")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite candidate response was invalid.");
    }
    const candidate: MatrixSpaceInviteCandidateDTO = {
        userId,
        membership: raw.membership
    };
    if (raw.displayName != null) {
        const displayName = protocolText(raw.displayName, "Space invite candidate display name", 256);
        if (/[\u0000-\u001f\u007f]/u.test(displayName)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite candidate response was invalid.");
        }
        candidate.displayName = displayName;
    }
    if (raw.avatarUrl != null) candidate.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    return candidate;
}

function validateProtocolSpaceInviteCandidateSearchResult(
    value: unknown,
    request: Required<MatrixSpaceInviteCandidateSearchRequest>,
    binding: MatrixAccountBinding
): MatrixSpaceInviteCandidateSearchResult {
    const raw = protocolObjectKeys(value, "Space invite search", [
        "spaceId",
        "query",
        "scope",
        "candidates",
        "limited",
        "directoryLimited",
        "complete",
        "queryRequired"
    ]);
    if (protocolRoomId(raw.spaceId) !== request.spaceId
        || protocolText(raw.query, "Space invite search query", MAX_SPACE_INVITE_DIRECTORY_QUERY_LENGTH, true) !== request.query
        || raw.scope !== "homeserver_user_directory" || !Array.isArray(raw.candidates)
        || raw.candidates.length > request.limit || typeof raw.limited !== "boolean"
        || typeof raw.directoryLimited !== "boolean" || raw.complete !== false
        || typeof raw.queryRequired !== "boolean" || (raw.directoryLimited && !raw.limited)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite search response was invalid.");
    }
    const expectedServerName = serverNameFromMatrixIdentifier(binding.userId);
    const candidates = raw.candidates.map(candidate => validateProtocolSpaceInviteCandidate(
        candidate,
        expectedServerName,
        binding.userId
    ));
    if (new Set(candidates.map(candidate => candidate.userId)).size !== candidates.length
        || (raw.queryRequired && (request.query !== "" || candidates.length > 0
            || raw.limited || raw.directoryLimited))) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite search response was inconsistent.");
    }
    return {
        spaceId: request.spaceId,
        query: request.query,
        scope: "homeserver_user_directory",
        candidates,
        limited: raw.limited,
        directoryLimited: raw.directoryLimited,
        complete: false,
        queryRequired: raw.queryRequired
    };
}

function validateProtocolInviteUserToSpaceResult(
    value: unknown,
    request: MatrixInviteUserToSpaceRequest,
    expectedServerName: string
): MatrixInviteUserToSpaceResult {
    const raw = protocolObjectKeys(
        value,
        "Space invite result",
        ["spaceId", "userId", "membership", "changed"]
    );
    const userId = protocolUserId(raw.userId);
    if (protocolRoomId(raw.spaceId) !== request.spaceId || userId !== request.userId
        || serverNameFromMatrixIdentifier(userId) !== expectedServerName
        || (raw.membership !== "invite" && raw.membership !== "join")
        || typeof raw.changed !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space invite result was invalid.");
    }
    return {
        spaceId: request.spaceId,
        userId: request.userId,
        membership: raw.membership,
        changed: raw.changed
    };
}

async function searchSpaceInviteCandidates(
    event: IpcMainInvokeEvent,
    request: MatrixSpaceInviteCandidateSearchRequest,
    expectedUserId: string
): Promise<MatrixSpaceInviteCandidateSearchResult> {
    const rendererId = event.sender.id;
    const rendererCount = spaceInviteSearchesByRenderer.get(rendererId) ?? 0;
    if (concurrentSpaceInviteSearches >= MAX_CONCURRENT_SPACE_INVITE_SEARCHES
        || rendererCount >= MAX_CONCURRENT_SPACE_INVITE_SEARCHES_PER_RENDERER) {
        throw bridgeError(
            "MATRIX_SPACE_INVITE_SEARCH_BUSY",
            "Too many Matrix user-directory searches are already running."
        );
    }
    concurrentSpaceInviteSearches++;
    spaceInviteSearchesByRenderer.set(rendererId, rendererCount + 1);
    try {
        return await withExpectedMatrixAccount(expectedUserId, async binding => {
            const validatedRequest = validateSpaceInviteCandidateSearchRequest(request);
            const result = await callWorker<MatrixSpaceInviteCandidateSearchResult>({
                type: "searchSpaceInviteCandidates",
                request: validatedRequest
            });
            return validateProtocolSpaceInviteCandidateSearchResult(result, validatedRequest, binding);
        });
    } finally {
        concurrentSpaceInviteSearches--;
        const remaining = (spaceInviteSearchesByRenderer.get(rendererId) ?? 1) - 1;
        if (remaining > 0) spaceInviteSearchesByRenderer.set(rendererId, remaining);
        else spaceInviteSearchesByRenderer.delete(rendererId);
    }
}

function exactLocalProfileUserId(query: string, accountUserId: string): string {
    const activeServerName = serverNameFromMatrixIdentifier(accountUserId);
    let userId: string | undefined;
    if (query.startsWith("@")) {
        const separator = query.indexOf(":", 1);
        const localpart = separator > 1 ? query.slice(1, separator) : "";
        const serverName = separator > 1 ? query.slice(separator + 1) : "";
        if (BARE_MATRIX_LOCALPART_PATTERN.test(localpart)
            && serverName === activeServerName
            && Buffer.byteLength(query, "utf8") <= 255) {
            try {
                const validated = validateUserId(query);
                if (validated === query) userId = validated;
            } catch { }
        }
    } else if (BARE_MATRIX_LOCALPART_PATTERN.test(query)) {
        const candidate = `@${query}:${activeServerName}`;
        if (Buffer.byteLength(candidate, "utf8") <= 255) {
            try { userId = validateUserId(candidate); } catch { }
        }
    }
    if (!userId) {
        throw bridgeError(
            "MATRIX_GROUP_CHAT_EXACT_LOOKUP_INVALID",
            "Enter an exact local Matrix ID or a lowercase local username."
        );
    }
    return userId;
}

function validateGroupChatCandidateSearchRequest(
    value: unknown,
    expectedUserId: string
): Required<MatrixGroupChatCandidateSearchRequest> {
    const raw = objectRecord(value, "Matrix group-chat directory search");
    if (!Object.keys(raw).every(key => key === "query" || key === "limit" || key === "exact")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search contains unsupported fields.");
    }
    const query = validateString(
        raw.query,
        "Group-chat directory search query",
        MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH,
        true
    ).trim();
    if (/[\u0000-\u001f\u007f]/u.test(query)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search query is invalid.");
    }
    const limit = raw.limit ?? DEFAULT_GROUP_CHAT_DIRECTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_GROUP_CHAT_DIRECTORY_LIMIT) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat directory search limit is invalid.");
    }
    const exact = raw.exact ?? false;
    if (typeof exact !== "boolean") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat exact-search option is invalid.");
    }
    if (exact) exactLocalProfileUserId(query, expectedUserId);
    return { query, limit: Number(limit), exact };
}

function validateCreateGroupChatRequest(
    value: unknown,
    expectedUserId: string
): MatrixCreateGroupChatRequest {
    const raw = objectRecord(value, "Matrix group-chat details");
    if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "name") || !Object.hasOwn(raw, "userIds")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat details contain invalid fields.");
    }
    const name = validateString(raw.name, "Group-chat name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat name is invalid.");
    }
    if (!Array.isArray(raw.userIds)
        || raw.userIds.length < MIN_GROUP_CHAT_INVITEES
        || raw.userIds.length > MAX_GROUP_CHAT_INVITEES) {
        throw bridgeError(
            "MATRIX_INVALID_ARGUMENT",
            `A Matrix group chat allows up to ${MAX_GROUP_CHAT_INVITEES} other users.`
        );
    }
    const accountUserId = validateUserId(expectedUserId);
    const accountServerName = serverNameFromMatrixIdentifier(accountUserId);
    const userIds = raw.userIds.map(userId => validateUserId(userId));
    if (new Set(userIds).size !== userIds.length) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Matrix group-chat invitees must be unique.");
    }
    if (userIds.includes(accountUserId)) {
        throw bridgeError("MATRIX_GROUP_CHAT_SELF", "A Matrix group chat cannot invite your own account.");
    }
    if (userIds.some(userId => serverNameFromMatrixIdentifier(userId) !== accountServerName)) {
        throw bridgeError(
            "MATRIX_REMOTE_USER_REJECTED",
            "Only users on this account's Matrix server can be added to this group chat."
        );
    }
    return { name, userIds };
}

function validateProtocolGroupChatCandidate(
    value: unknown,
    expectedServerName: string,
    expectedUserId: string
): MatrixGroupChatCandidateDTO {
    const raw = protocolObjectKeys(
        value,
        "Group-chat directory candidate",
        ["userId", "displayName", "avatarUrl"],
        ["userId"]
    );
    const userId = protocolUserId(raw.userId);
    if (userId === expectedUserId || serverNameFromMatrixIdentifier(userId) !== expectedServerName) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat directory candidate was invalid.");
    }
    const candidate: MatrixGroupChatCandidateDTO = { userId };
    if (raw.displayName != null) {
        const displayName = protocolText(raw.displayName, "Group-chat directory display name", 256);
        if (/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(displayName)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat directory candidate was invalid.");
        }
        candidate.displayName = displayName;
    }
    if (raw.avatarUrl != null) candidate.avatarUrl = protocolMediaUrl(raw.avatarUrl);
    return candidate;
}

function validateProtocolGroupChatCandidateSearchResult(
    value: unknown,
    request: Required<MatrixGroupChatCandidateSearchRequest>,
    binding: MatrixAccountBinding
): MatrixGroupChatCandidateSearchResult {
    const raw = protocolObjectKeys(value, "Group-chat directory search", [
        "query",
        "scope",
        "candidates",
        "limited",
        "directoryLimited",
        "complete",
        "queryRequired",
        "exactLookup"
    ]);
    const expectedScope = request.exact
        ? "homeserver_user_directory_plus_exact_local_profile"
        : "homeserver_user_directory";
    if (protocolText(raw.query, "Group-chat directory search query", MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH, true)
        !== request.query || raw.scope !== expectedScope || !Array.isArray(raw.candidates)
        || raw.candidates.length > request.limit || typeof raw.limited !== "boolean"
        || typeof raw.directoryLimited !== "boolean" || raw.complete !== false
        || typeof raw.queryRequired !== "boolean" || (raw.directoryLimited && !raw.limited)
        || (request.exact
            ? raw.exactLookup !== "resolved" && raw.exactLookup !== "not_found_or_unavailable"
            : raw.exactLookup !== "not_requested")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat directory search response was invalid.");
    }
    const expectedServerName = serverNameFromMatrixIdentifier(binding.userId);
    const candidates = raw.candidates.map(candidate => validateProtocolGroupChatCandidate(
        candidate,
        expectedServerName,
        binding.userId
    ));
    const exactUserId = request.exact ? exactLocalProfileUserId(request.query, binding.userId) : undefined;
    if (new Set(candidates.map(candidate => candidate.userId)).size !== candidates.length
        || (raw.exactLookup === "resolved" && !candidates.some(candidate => candidate.userId === exactUserId))
        || (raw.exactLookup === "not_found_or_unavailable"
            && candidates.some(candidate => candidate.userId === exactUserId))
        || (raw.queryRequired && (request.query !== "" || candidates.length > 0
            || raw.limited || raw.directoryLimited || raw.exactLookup !== "not_requested"))) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat directory search response was inconsistent.");
    }
    return {
        query: request.query,
        scope: expectedScope,
        candidates,
        limited: raw.limited,
        directoryLimited: raw.directoryLimited,
        complete: false,
        queryRequired: raw.queryRequired,
        exactLookup: raw.exactLookup as MatrixGroupChatCandidateSearchResult["exactLookup"]
    };
}

async function searchGroupChatCandidates(
    event: IpcMainInvokeEvent,
    request: MatrixGroupChatCandidateSearchRequest,
    expectedUserId: string
): Promise<MatrixGroupChatCandidateSearchResult> {
    const rendererId = event.sender.id;
    const rendererCount = groupChatSearchesByRenderer.get(rendererId) ?? 0;
    if (concurrentGroupChatSearches >= MAX_CONCURRENT_GROUP_CHAT_SEARCHES
        || rendererCount >= MAX_CONCURRENT_GROUP_CHAT_SEARCHES_PER_RENDERER) {
        throw bridgeError(
            "MATRIX_GROUP_CHAT_SEARCH_BUSY",
            "Too many Matrix group-chat directory searches are already running."
        );
    }
    concurrentGroupChatSearches++;
    groupChatSearchesByRenderer.set(rendererId, rendererCount + 1);
    try {
        return await withExpectedMatrixAccount(expectedUserId, async binding => {
            const validatedRequest = validateGroupChatCandidateSearchRequest(request, binding.userId);
            const result = await callWorker<MatrixGroupChatCandidateSearchResult>({
                type: "searchGroupChatCandidates",
                request: validatedRequest
            });
            return validateProtocolGroupChatCandidateSearchResult(result, validatedRequest, binding);
        });
    } finally {
        concurrentGroupChatSearches--;
        const remaining = (groupChatSearchesByRenderer.get(rendererId) ?? 1) - 1;
        if (remaining > 0) groupChatSearchesByRenderer.set(rendererId, remaining);
        else groupChatSearchesByRenderer.delete(rendererId);
    }
}

function validateGroupChatInviteCandidateSearchRequest(
    value: unknown,
    expectedUserId: string
): Required<MatrixGroupChatInviteCandidateSearchRequest> {
    const raw = objectRecord(value, "Matrix group-chat invite search");
    if (!Object.keys(raw).every(key => key === "roomId" || key === "query" || key === "limit" || key === "exact")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite search contains unsupported fields.");
    }
    const search = validateGroupChatCandidateSearchRequest({
        query: raw.query,
        ...(Object.hasOwn(raw, "limit") ? { limit: raw.limit } : {}),
        ...(Object.hasOwn(raw, "exact") ? { exact: raw.exact } : {})
    }, expectedUserId);
    return { roomId: validateRoomId(raw.roomId), ...search };
}

function validateInviteUserToGroupChatRequest(
    value: unknown,
    expectedUserId: string
): MatrixInviteUserToGroupChatRequest {
    const raw = objectRecord(value, "Matrix group-chat invite");
    if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "roomId") || !Object.hasOwn(raw, "userId")) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix group-chat invite contains invalid fields.");
    }
    const accountUserId = validateUserId(expectedUserId);
    const userId = validateUserId(raw.userId);
    if (userId === accountUserId) {
        throw bridgeError("MATRIX_GROUP_CHAT_INVITE_SELF", "You cannot invite your own Matrix account.");
    }
    if (serverNameFromMatrixIdentifier(userId) !== serverNameFromMatrixIdentifier(accountUserId)) {
        throw bridgeError(
            "MATRIX_REMOTE_USER_REJECTED",
            "Only users on this account's Matrix server can be invited to this group chat."
        );
    }
    return { roomId: validateRoomId(raw.roomId), userId };
}

function validateProtocolGroupChatInviteCandidate(
    value: unknown,
    expectedServerName: string,
    expectedUserId: string
): MatrixGroupChatInviteCandidateDTO {
    const raw = protocolObjectKeys(
        value,
        "Group-chat invite candidate",
        ["userId", "displayName", "avatarUrl", "membership"],
        ["userId", "membership"]
    );
    const candidate = validateProtocolGroupChatCandidate({
        userId: raw.userId,
        ...(raw.displayName != null ? { displayName: raw.displayName } : {}),
        ...(raw.avatarUrl != null ? { avatarUrl: raw.avatarUrl } : {})
    }, expectedServerName, expectedUserId);
    if (raw.membership !== "none" && raw.membership !== "leave" && raw.membership !== "knock"
        && raw.membership !== "invite" && raw.membership !== "join" && raw.membership !== "ban") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat invite candidate was invalid.");
    }
    return { ...candidate, membership: raw.membership };
}

function validateProtocolGroupChatInviteCandidateSearchResult(
    value: unknown,
    request: Required<MatrixGroupChatInviteCandidateSearchRequest>,
    binding: MatrixAccountBinding
): MatrixGroupChatInviteCandidateSearchResult {
    const raw = protocolObjectKeys(value, "Group-chat invite search", [
        "roomId",
        "query",
        "scope",
        "candidates",
        "limited",
        "directoryLimited",
        "complete",
        "queryRequired",
        "exactLookup",
        "participantCount",
        "maxParticipants",
        "full"
    ]);
    const expectedScope = request.exact
        ? "homeserver_user_directory_plus_exact_local_profile"
        : "homeserver_user_directory";
    if (protocolRoomId(raw.roomId) !== request.roomId
        || protocolText(raw.query, "Group-chat invite search query", MAX_GROUP_CHAT_DIRECTORY_QUERY_LENGTH, true)
            !== request.query
        || raw.scope !== expectedScope || !Array.isArray(raw.candidates)
        || raw.candidates.length > request.limit || typeof raw.limited !== "boolean"
        || typeof raw.directoryLimited !== "boolean" || raw.complete !== false
        || typeof raw.queryRequired !== "boolean" || (raw.directoryLimited && !raw.limited)
        || (request.exact
            ? raw.exactLookup !== "resolved" && raw.exactLookup !== "not_found_or_unavailable"
            : raw.exactLookup !== "not_requested")
        || !Number.isSafeInteger(raw.participantCount) || Number(raw.participantCount) < 1
        || Number(raw.participantCount) > 1_000 || raw.maxParticipants !== MAX_GROUP_CHAT_PARTICIPANTS
        || typeof raw.full !== "boolean"
        || raw.full !== (Number(raw.participantCount) >= MAX_GROUP_CHAT_PARTICIPANTS)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat invite search response was invalid.");
    }
    const expectedServerName = serverNameFromMatrixIdentifier(binding.userId);
    const candidates = raw.candidates.map(candidate => validateProtocolGroupChatInviteCandidate(
        candidate,
        expectedServerName,
        binding.userId
    ));
    const exactUserId = request.exact ? exactLocalProfileUserId(request.query, binding.userId) : undefined;
    if (new Set(candidates.map(candidate => candidate.userId)).size !== candidates.length
        || (raw.exactLookup === "resolved" && !candidates.some(candidate => candidate.userId === exactUserId))
        || (raw.exactLookup === "not_found_or_unavailable"
            && candidates.some(candidate => candidate.userId === exactUserId))
        || (raw.queryRequired && (request.query !== "" || candidates.length > 0
            || raw.limited || raw.directoryLimited || raw.exactLookup !== "not_requested"))) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat invite search response was inconsistent.");
    }
    return {
        roomId: request.roomId,
        query: request.query,
        scope: expectedScope,
        candidates,
        limited: raw.limited,
        directoryLimited: raw.directoryLimited,
        complete: false,
        queryRequired: raw.queryRequired,
        exactLookup: raw.exactLookup as MatrixGroupChatCandidateSearchResult["exactLookup"],
        participantCount: Number(raw.participantCount),
        maxParticipants: MAX_GROUP_CHAT_PARTICIPANTS,
        full: raw.full
    };
}

function validateProtocolInviteUserToGroupChatResult(
    value: unknown,
    request: MatrixInviteUserToGroupChatRequest,
    expectedServerName: string
): MatrixInviteUserToGroupChatResult {
    const raw = protocolObjectKeys(
        value,
        "Group-chat invite result",
        ["roomId", "userId", "delivery", "observedMembership", "changed"],
        ["roomId", "userId", "delivery", "changed"]
    );
    const userId = protocolUserId(raw.userId);
    if (protocolRoomId(raw.roomId) !== request.roomId || userId !== request.userId
        || serverNameFromMatrixIdentifier(userId) !== expectedServerName
        || (raw.delivery !== "accepted" && raw.delivery !== "existing")
        || (raw.observedMembership != null
            && raw.observedMembership !== "invite" && raw.observedMembership !== "join")
        || typeof raw.changed !== "boolean"
        || (raw.changed
            ? raw.delivery !== "accepted"
            : raw.delivery !== "existing" || raw.observedMembership == null)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat invite result was invalid.");
    }
    return {
        ...request,
        delivery: raw.delivery,
        ...(raw.observedMembership != null ? { observedMembership: raw.observedMembership } : {}),
        changed: raw.changed
    };
}

async function searchGroupChatInviteCandidates(
    event: IpcMainInvokeEvent,
    request: MatrixGroupChatInviteCandidateSearchRequest,
    expectedUserId: string
): Promise<MatrixGroupChatInviteCandidateSearchResult> {
    const rendererId = event.sender.id;
    const rendererCount = groupChatSearchesByRenderer.get(rendererId) ?? 0;
    if (concurrentGroupChatSearches >= MAX_CONCURRENT_GROUP_CHAT_SEARCHES
        || rendererCount >= MAX_CONCURRENT_GROUP_CHAT_SEARCHES_PER_RENDERER) {
        throw bridgeError(
            "MATRIX_GROUP_CHAT_SEARCH_BUSY",
            "Too many Matrix group-chat directory searches are already running."
        );
    }
    concurrentGroupChatSearches++;
    groupChatSearchesByRenderer.set(rendererId, rendererCount + 1);
    try {
        return await withExpectedMatrixAccount(expectedUserId, async binding => {
            const validatedRequest = validateGroupChatInviteCandidateSearchRequest(request, binding.userId);
            const result = await callWorker<MatrixGroupChatInviteCandidateSearchResult>({
                type: "searchGroupChatInviteCandidates",
                request: validatedRequest
            });
            return validateProtocolGroupChatInviteCandidateSearchResult(result, validatedRequest, binding);
        });
    } finally {
        concurrentGroupChatSearches--;
        const remaining = (groupChatSearchesByRenderer.get(rendererId) ?? 1) - 1;
        if (remaining > 0) groupChatSearchesByRenderer.set(rendererId, remaining);
        else groupChatSearchesByRenderer.delete(rendererId);
    }
}

async function pendingGroupChatInviteForRoom(
    binding: MatrixAccountBinding,
    roomId: string
): Promise<PendingGroupChatInvite | undefined> {
    return await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        return ambiguousGroupChatInvites.get(groupChatInviteLatchKey(binding, roomId));
    });
}

async function createPendingGroupChatInvite(
    binding: MatrixAccountBinding,
    request: MatrixInviteUserToGroupChatRequest
): Promise<PendingGroupChatInvite> {
    const key = groupChatInviteLatchKey(binding, request.roomId);
    const pending: PendingGroupChatInvite = {
        homeserver: binding.homeserver,
        accountUserId: binding.userId,
        ...request
    };
    await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        if (ambiguousGroupChatInvites.has(key)) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_RECONCILE_REQUIRED",
                "Reconcile or acknowledge the pending invite for this group chat before inviting another person."
            );
        }
        if (ambiguousGroupChatInvites.size >= MAX_AMBIGUOUS_GROUP_CHAT_INVITES) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_RECONCILE_REQUIRED",
                "Too many group-chat invites require reconciliation before another can start."
            );
        }
        ambiguousGroupChatInvites.set(key, pending);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            ambiguousGroupChatInvites.delete(key);
            throw error;
        }
    });
    return pending;
}

function samePendingGroupChatInvite(
    current: PendingGroupChatInvite | undefined,
    expected: PendingGroupChatInvite
): current is PendingGroupChatInvite {
    return current?.accountUserId === expected.accountUserId
        && current.roomId === expected.roomId
        && current.userId === expected.userId;
}

async function persistResolvedGroupChatInvite(
    binding: MatrixAccountBinding,
    pending: PendingGroupChatInvite,
    result: MatrixInviteUserToGroupChatResult
): Promise<PendingGroupChatInvite> {
    const key = groupChatInviteLatchKey(binding, pending.roomId);
    return await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        const current = ambiguousGroupChatInvites.get(key);
        if (!samePendingGroupChatInvite(current, pending)) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_STATE_CORRUPT",
                "The pending group-chat invite state changed unexpectedly."
            );
        }
        if (current.resolved) return current;
        const resolved: PendingGroupChatInvite = { ...current, resolved: result };
        ambiguousGroupChatInvites.set(key, resolved);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            ambiguousGroupChatInvites.set(key, current);
            throw error;
        }
        return resolved;
    });
}

async function clearPendingGroupChatInvite(
    binding: MatrixAccountBinding,
    pending: PendingGroupChatInvite
): Promise<void> {
    const key = groupChatInviteLatchKey(binding, pending.roomId);
    await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        const current = ambiguousGroupChatInvites.get(key);
        if (!samePendingGroupChatInvite(current, pending)) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_STATE_CORRUPT",
                "The pending group-chat invite state changed unexpectedly."
            );
        }
        ambiguousGroupChatInvites.delete(key);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            ambiguousGroupChatInvites.set(key, current);
            throw error;
        }
    });
}

async function pruneUnjoinedGroupChatInviteReceipts(
    binding: MatrixAccountBinding,
    captured: ReadonlyArray<readonly [string, PendingGroupChatInvite]>,
    joinedRoomIds: ReadonlySet<string>
): Promise<number> {
    return await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        const removed: Array<[string, PendingGroupChatInvite]> = [];
        for (const [key, pending] of captured) {
            // The membership cut may be older than a newly-created or newly-
            // resolved receipt. Delete only the exact object captured before
            // /joined_rooms and never interfere with an active room mutation.
            if (ambiguousGroupChatInvites.get(key) !== pending
                || groupChatInviteOperationsInFlight.has(key)
                || pending.accountUserId !== binding.userId
                || joinedRoomIds.has(pending.roomId)) continue;
            removed.push([key, pending]);
        }
        if (!removed.length) return 0;
        for (const [key] of removed) ambiguousGroupChatInvites.delete(key);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            for (const [key, pending] of removed) ambiguousGroupChatInvites.set(key, pending);
            throw error;
        }
        return removed.length;
    });
}

async function captureGroupChatInviteReceipts(
    binding: MatrixAccountBinding
): Promise<Array<readonly [string, PendingGroupChatInvite]>> {
    return await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        return [...ambiguousGroupChatInvites].filter(([, pending]) => pending.accountUserId === binding.userId);
    });
}

function definitiveGroupChatInviteError(error: unknown): boolean {
    return error instanceof Error && (
        error.name === "MATRIX_INVALID_ARGUMENT"
        || error.name === "MATRIX_NOT_STARTED"
        || error.name === "MATRIX_WORKER_UNAVAILABLE"
        || error.name === "MATRIX_WORKER_CLOSED"
        || error.name === "MATRIX_WORKER_CRASHED"
        || error.name === "MATRIX_COMMAND_QUEUE_TIMEOUT"
        || error.name === "MATRIX_BACKEND_BUSY"
        || error.name === "MATRIX_SESSION_CHANGED"
        || error.name === "MATRIX_PROTOCOL_ERROR"
        || error.name === "MATRIX_GROUP_CHAT_REQUIRED"
        || error.name === "MATRIX_GROUP_CHAT_NOT_JOINED"
        || error.name === "MATRIX_GROUP_CHAT_PRIVACY_UNVERIFIABLE"
        || error.name === "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE"
        || error.name === "MATRIX_GROUP_CHAT_INVITE_FORBIDDEN"
        || error.name === "MATRIX_GROUP_CHAT_INVITE_SELF"
        || error.name === "MATRIX_GROUP_CHAT_INVITE_BANNED"
        || error.name === "MATRIX_GROUP_CHAT_FULL"
        || error.name === "MATRIX_GROUP_CHAT_CANDIDATE_STALE"
        || error.name === "MATRIX_GROUP_CHAT_MEMBERSHIP_INVALID"
        || error.name === "MATRIX_GROUP_CHAT_INVITE_REJECTED"
    );
}

function validateProtocolReconcileGroupChatInviteResult(
    value: unknown,
    pending: PendingGroupChatInvite,
    expectedServerName: string
): Exclude<MatrixReconcileGroupChatInviteResult, { status: "none"; }> {
    const raw = protocolObjectKeys(
        value,
        "group-chat invite reconciliation",
        ["status", "roomId", "userId", "result"],
        ["status"]
    );
    if (raw.status === "pending") {
        if (Object.hasOwn(raw, "result") || protocolRoomId(raw.roomId) !== pending.roomId
            || protocolUserId(raw.userId) !== pending.userId) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The group-chat invite reconciliation response was invalid.");
        }
        return { status: "pending", roomId: pending.roomId, userId: pending.userId };
    }
    if (raw.status !== "resolved" || Object.hasOwn(raw, "roomId") || Object.hasOwn(raw, "userId")
        || !Object.hasOwn(raw, "result")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The group-chat invite reconciliation response was invalid.");
    }
    return {
        status: "resolved",
        result: validateProtocolInviteUserToGroupChatResult(raw.result, pending, expectedServerName)
    };
}

async function inviteUserToGroupChat(
    _: IpcMainInvokeEvent,
    request: MatrixInviteUserToGroupChatRequest,
    expectedUserId: string
): Promise<MatrixInviteUserToGroupChatResult> {
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const validatedRequest = validateInviteUserToGroupChatRequest(request, binding.userId);
        const operationKey = groupChatInviteLatchKey(binding, validatedRequest.roomId);
        if (groupChatInviteOperationsInFlight.has(operationKey)) {
            throw bridgeError("MATRIX_GROUP_CHAT_INVITE_IN_PROGRESS", "A group-chat invite is already in progress for this room.");
        }
        if (groupChatInviteOperationsInFlight.size >= MAX_IN_FLIGHT_GROUP_CHAT_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending group-chat invites.");
        }
        groupChatInviteOperationsInFlight.add(operationKey);
        try {
            const pending = await createPendingGroupChatInvite(binding, validatedRequest);
            let rawResult: MatrixInviteUserToGroupChatResult;
            try {
                rawResult = await callWorker<MatrixInviteUserToGroupChatResult>({
                    type: "inviteUserToGroupChat",
                    request: validatedRequest
                });
            } catch (error) {
                if (definitiveGroupChatInviteError(error)) {
                    await clearPendingGroupChatInvite(binding, pending);
                }
                throw error;
            }
            let result: MatrixInviteUserToGroupChatResult;
            try {
                result = validateProtocolInviteUserToGroupChatResult(
                    rawResult,
                    validatedRequest,
                    serverNameFromMatrixIdentifier(binding.userId)
                );
            } catch {
                throw bridgeError(
                    "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS",
                    "Matrix may have sent the group-chat invite but returned an invalid confirmation. Reconcile it before any retry."
                );
            }
            if (!result.changed) {
                await clearPendingGroupChatInvite(binding, pending);
                return result;
            }
            try {
                await persistResolvedGroupChatInvite(binding, pending, result);
            } catch (error) {
                console.warn(`[MatrixBridge] Group-chat invite succeeded, but its resolved receipt was not cached (${errorDTO(error).code}).`);
            }
            return result;
        } finally {
            groupChatInviteOperationsInFlight.delete(operationKey);
        }
    });
}

async function reconcileGroupChatInvite(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<MatrixReconcileGroupChatInviteResult> {
    const targetRoomId = validateRoomId(roomId);
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const operationKey = groupChatInviteLatchKey(binding, targetRoomId);
        if (groupChatInviteOperationsInFlight.has(operationKey)) {
            throw bridgeError(
                "MATRIX_GROUP_CHAT_INVITE_RECONCILE_IN_PROGRESS",
                "This group-chat invite is already being reconciled."
            );
        }
        if (groupChatInviteOperationsInFlight.size >= MAX_IN_FLIGHT_GROUP_CHAT_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending group-chat invites.");
        }
        groupChatInviteOperationsInFlight.add(operationKey);
        try {
            const pending = await pendingGroupChatInviteForRoom(binding, targetRoomId);
            if (!pending) return { status: "none" };
            if (pending.resolved) return { status: "resolved", result: pending.resolved };
            let result: Exclude<MatrixReconcileGroupChatInviteResult, { status: "none"; }>;
            try {
                const rawResult = await callWorker<MatrixReconcileGroupChatInviteResult>({
                    type: "reconcileGroupChatInvite",
                    request: { roomId: pending.roomId, userId: pending.userId }
                });
                result = validateProtocolReconcileGroupChatInviteResult(
                    rawResult,
                    pending,
                    serverNameFromMatrixIdentifier(binding.userId)
                );
            } catch (error) {
                if (error instanceof Error && error.name !== "MATRIX_PROTOCOL_ERROR") throw error;
                throw bridgeError(
                    "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS",
                    "Matrix returned an invalid invite reconciliation response; the durable receipt was retained."
                );
            }
            if (result.status === "resolved") {
                try {
                    await persistResolvedGroupChatInvite(binding, pending, result.result);
                } catch (error) {
                    console.warn(`[MatrixBridge] Group-chat invite reconciliation resolved, but its receipt was not cached (${errorDTO(error).code}).`);
                }
            }
            return result;
        } finally {
            groupChatInviteOperationsInFlight.delete(operationKey);
        }
    });
}

async function acknowledgeGroupChatInvite(
    _: IpcMainInvokeEvent,
    request: MatrixInviteUserToGroupChatRequest,
    expectedUserId: string
): Promise<void> {
    await withExpectedMatrixAccount(expectedUserId, async binding => {
        const validatedRequest = validateInviteUserToGroupChatRequest(request, binding.userId);
        const operationKey = groupChatInviteLatchKey(binding, validatedRequest.roomId);
        if (groupChatInviteOperationsInFlight.has(operationKey)) {
            throw bridgeError("MATRIX_GROUP_CHAT_INVITE_RECONCILE_IN_PROGRESS", "This group-chat invite is still being reconciled.");
        }
        if (groupChatInviteOperationsInFlight.size >= MAX_IN_FLIGHT_GROUP_CHAT_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending group-chat invites.");
        }
        groupChatInviteOperationsInFlight.add(operationKey);
        try {
            const pending = await pendingGroupChatInviteForRoom(binding, validatedRequest.roomId);
            if (!pending) return;
            if (pending.userId !== validatedRequest.userId) {
                throw bridgeError("MATRIX_GROUP_CHAT_INVITE_STATE_MISMATCH", "A different invite is pending for this group chat.");
            }
            if (!pending.resolved) {
                throw bridgeError(
                    "MATRIX_GROUP_CHAT_INVITE_ACK_NOT_READY",
                    "The group-chat invite is still unconfirmed; reconcile or explicitly override it first."
                );
            }
            await clearPendingGroupChatInvite(binding, pending);
        } finally {
            groupChatInviteOperationsInFlight.delete(operationKey);
        }
    });
}

async function overrideGroupChatInviteAmbiguity(
    _: IpcMainInvokeEvent,
    request: MatrixInviteUserToGroupChatRequest,
    expectedUserId: string
): Promise<void> {
    await withExpectedMatrixAccount(expectedUserId, async binding => {
        const validatedRequest = validateInviteUserToGroupChatRequest(request, binding.userId);
        const operationKey = groupChatInviteLatchKey(binding, validatedRequest.roomId);
        if (groupChatInviteOperationsInFlight.has(operationKey)) {
            throw bridgeError("MATRIX_GROUP_CHAT_INVITE_RECONCILE_IN_PROGRESS", "This group-chat invite is still being reconciled.");
        }
        if (groupChatInviteOperationsInFlight.size >= MAX_IN_FLIGHT_GROUP_CHAT_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending group-chat invites.");
        }
        groupChatInviteOperationsInFlight.add(operationKey);
        try {
            const pending = await pendingGroupChatInviteForRoom(binding, validatedRequest.roomId);
            if (!pending) return;
            if (pending.userId !== validatedRequest.userId) {
                throw bridgeError("MATRIX_GROUP_CHAT_INVITE_STATE_MISMATCH", "A different invite is pending for this group chat.");
            }
            if (pending.resolved) {
                throw bridgeError(
                    "MATRIX_GROUP_CHAT_INVITE_OVERRIDE_NOT_ALLOWED",
                    "Matrix already confirmed this invite. Acknowledge the confirmed result instead."
                );
            }
            const rawResult = await callWorker<MatrixReconcileGroupChatInviteResult>({
                type: "reconcileGroupChatInvite",
                request: validatedRequest
            });
            const reconciliation = validateProtocolReconcileGroupChatInviteResult(
                rawResult,
                pending,
                serverNameFromMatrixIdentifier(binding.userId)
            );
            if (reconciliation.status === "resolved") {
                try { await persistResolvedGroupChatInvite(binding, pending, reconciliation.result); } catch { }
                throw bridgeError(
                    "MATRIX_GROUP_CHAT_INVITE_OVERRIDE_NOT_ALLOWED",
                    "Matrix now confirms this invite. Acknowledge the confirmed result instead."
                );
            }
            // Explicit user confirmation only abandons the uncertainty receipt;
            // it never sends or retries an invite by itself.
            await clearPendingGroupChatInvite(binding, pending);
        } finally {
            groupChatInviteOperationsInFlight.delete(operationKey);
        }
    });
}

async function inviteUserToSpace(
    _: IpcMainInvokeEvent,
    request: MatrixInviteUserToSpaceRequest,
    expectedUserId: string
): Promise<MatrixInviteUserToSpaceResult> {
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const validatedRequest = validateInviteUserToSpaceRequest(request);
        if (serverNameFromMatrixIdentifier(validatedRequest.userId)
            !== serverNameFromMatrixIdentifier(binding.userId)) {
            throw bridgeError(
                "MATRIX_REMOTE_USER_REJECTED",
                "Only users on this account's Matrix server can be invited here."
            );
        }
        const operationKey = JSON.stringify([
            binding.homeserver,
            binding.userId,
            binding.deviceId,
            binding.storageKey,
            validatedRequest.spaceId,
            validatedRequest.userId
        ]);
        if (spaceInvitesInFlight.has(operationKey)) {
            throw bridgeError("MATRIX_SPACE_INVITE_IN_PROGRESS", "That Matrix user is already being invited.");
        }
        if (spaceInvitesInFlight.size >= MAX_IN_FLIGHT_SPACE_INVITES) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many pending invites.");
        }
        spaceInvitesInFlight.add(operationKey);
        try {
            const result = await callWorker<MatrixInviteUserToSpaceResult>({
                type: "inviteUserToSpace",
                request: validatedRequest
            });
            try {
                return validateProtocolInviteUserToSpaceResult(
                    result,
                    validatedRequest,
                    serverNameFromMatrixIdentifier(binding.userId)
                );
            } catch {
                throw bridgeError(
                    "MATRIX_SPACE_INVITE_AMBIGUOUS",
                    "Matrix sent the invite but returned an invalid confirmation. Refresh before trying again."
                );
            }
        } finally {
            spaceInvitesInFlight.delete(operationKey);
        }
    });
}

function validateProtocolCreateGroupChatResult(
    value: unknown,
    request: MatrixCreateGroupChatRequest,
    expectedServerName: string
): MatrixCreateGroupChatResult {
    const raw = protocolObjectKeys(
        value,
        "group-chat creation",
        ["roomId", "name", "invitations", "complete"]
    );
    const name = protocolText(raw.name, "group-chat name", 100);
    if (name !== request.name
        || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)
        || !Array.isArray(raw.invitations) || raw.invitations.length !== request.userIds.length
        || typeof raw.complete !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat creation response was invalid.");
    }
    const invitations = raw.invitations.map((value, index): MatrixGroupChatInvitationDTO => {
        const invitation = protocolObjectKeys(value, "group-chat invitation", ["userId", "status"]);
        const userId = protocolUserId(invitation.userId);
        if (userId !== request.userIds[index]
            || serverNameFromMatrixIdentifier(userId) !== expectedServerName
            || (invitation.status !== "invited" && invitation.status !== "joined"
                && invitation.status !== "rejected" && invitation.status !== "ambiguous")) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat invitation response was invalid.");
        }
        return { userId, status: invitation.status };
    });
    const complete = invitations.every(invitation => invitation.status === "invited" || invitation.status === "joined");
    if (raw.complete !== complete) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat creation response was inconsistent.");
    }
    return { roomId: protocolRoomId(raw.roomId), name, invitations, complete };
}

async function clearPendingGroupChatCreate(
    binding: MatrixAccountBinding,
    pending: PendingGroupChatCreate
): Promise<void> {
    const latchKey = groupChatCreateLatchKey(binding);
    await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        const current = ambiguousGroupChatCreates.get(latchKey);
        if (current?.creationMarker !== pending.creationMarker) {
            throw bridgeError(
                "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT",
                "The pending Matrix group-chat state changed unexpectedly."
            );
        }
        ambiguousGroupChatCreates.delete(latchKey);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            ambiguousGroupChatCreates.set(latchKey, current);
            throw error;
        }
    });
}

async function persistResolvedGroupChatCreate(
    binding: MatrixAccountBinding,
    pending: PendingGroupChatCreate,
    result: MatrixCreateGroupChatResult
): Promise<PendingGroupChatCreate> {
    const latchKey = groupChatCreateLatchKey(binding);
    return await runGroupChatCreateState(async () => {
        await loadGroupChatCreateState();
        const current = ambiguousGroupChatCreates.get(latchKey);
        if (current?.creationMarker !== pending.creationMarker) {
            throw bridgeError(
                "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT",
                "The pending Matrix group-chat state changed unexpectedly."
            );
        }
        if (current.resolved) return current;
        const resolved: PendingGroupChatCreate = { ...current, resolved: result };
        ambiguousGroupChatCreates.set(latchKey, resolved);
        try {
            await saveGroupChatCreateState();
        } catch (error) {
            ambiguousGroupChatCreates.set(latchKey, current);
            throw error;
        }
        return resolved;
    });
}

function definitiveGroupChatCreateError(error: unknown): boolean {
    return error instanceof Error && (
        error.name === "MATRIX_INVALID_ARGUMENT"
        || error.name === "MATRIX_NOT_STARTED"
        || error.name === "MATRIX_WORKER_UNAVAILABLE"
        || error.name === "MATRIX_WORKER_CLOSED"
        || error.name === "MATRIX_WORKER_CRASHED"
        || error.name === "MATRIX_WORKER_TIMEOUT"
        || error.name === "MATRIX_COMMAND_TIMEOUT"
        || error.name === "MATRIX_COMMAND_QUEUE_TIMEOUT"
        || error.name === "MATRIX_BACKEND_BUSY"
        || error.name === "MATRIX_SESSION_CHANGED"
        || error.name === "MATRIX_PROTOCOL_ERROR"
        || error.name === "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED"
        || error.name === "MATRIX_CREATE_GROUP_CHAT_REJECTED"
        || error.name === "MATRIX_GROUP_CHAT_CANDIDATE_STALE"
    );
}

async function createGroupChat(
    _: IpcMainInvokeEvent,
    request: MatrixCreateGroupChatRequest,
    expectedUserId: string
): Promise<MatrixCreateGroupChatResult> {
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const validatedRequest = validateCreateGroupChatRequest(request, binding.userId);
        if (createGroupChatInFlight) {
            throw bridgeError("MATRIX_CREATE_GROUP_CHAT_IN_PROGRESS", "A Matrix group chat is already being created.");
        }
        createGroupChatInFlight = true;
        try {
            const latchKey = groupChatCreateLatchKey(binding);
            const pending: PendingGroupChatCreate = {
                homeserver: binding.homeserver,
                userId: binding.userId,
                ...validatedRequest,
                creationMarker: `vcgroup_${randomBytes(32).toString("hex")}`
            };
            await runGroupChatCreateState(async () => {
                await loadGroupChatCreateState();
                if (ambiguousGroupChatCreates.has(latchKey)) {
                    throw bridgeError(
                        "MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED",
                        "Reconcile the pending Matrix group chat before creating another one."
                    );
                }
                if (ambiguousGroupChatCreates.size >= MAX_AMBIGUOUS_GROUP_CHAT_CREATES) {
                    throw bridgeError(
                        "MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED",
                        "Too many Matrix group chats require reconciliation before another can start."
                    );
                }
                ambiguousGroupChatCreates.set(latchKey, pending);
                try {
                    await saveGroupChatCreateState();
                } catch (error) {
                    ambiguousGroupChatCreates.delete(latchKey);
                    throw error;
                }
            });

            let rawResult: MatrixCreateGroupChatResult;
            try {
                rawResult = await callWorker<MatrixCreateGroupChatResult>({
                    type: "createGroupChat",
                    request: validatedRequest,
                    creationMarker: pending.creationMarker
                });
            } catch (error) {
                if (definitiveGroupChatCreateError(error)) {
                    await clearPendingGroupChatCreate(binding, pending);
                    throw error;
                }
                if (error instanceof Error && error.name === "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS") throw error;
                throw bridgeError(
                    "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
                    "Matrix group-chat creation may have succeeded. Reconcile it before trying again."
                );
            }

            let result: MatrixCreateGroupChatResult;
            try {
                result = validateProtocolCreateGroupChatResult(
                    rawResult,
                    validatedRequest,
                    serverNameFromMatrixIdentifier(binding.userId)
                );
            } catch {
                throw bridgeError(
                    "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS",
                    "Matrix created a group chat but returned an invalid confirmation. Reconcile it before trying again."
                );
            }
            try {
                await persistResolvedGroupChatCreate(binding, pending, result);
            } catch (error) {
                // The original marker remains durable and still blocks a
                // duplicate; exact reconciliation can recover the receipt.
                console.warn(`[MatrixBridge] Group-chat creation succeeded, but its resolved receipt was not cached (${errorDTO(error).code}).`);
            }
            return result;
        } finally {
            createGroupChatInFlight = false;
        }
    });
}

function validateProtocolReconcileGroupChatCreateResult(
    value: unknown,
    pending: PendingGroupChatCreate,
    expectedServerName: string
): Exclude<MatrixReconcileGroupChatCreateResult, { status: "none"; }> {
    const raw = protocolObjectKeys(value, "group-chat reconciliation", ["status", "result"], ["status"]);
    if (raw.status === "pending") {
        if (Object.hasOwn(raw, "result")) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat reconciliation response was invalid.");
        }
        return { status: "pending" };
    }
    if (raw.status !== "resolved" || !Object.hasOwn(raw, "result")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix group-chat reconciliation response was invalid.");
    }
    return {
        status: "resolved",
        result: validateProtocolCreateGroupChatResult(
            raw.result,
            { name: pending.name, userIds: pending.userIds },
            expectedServerName
        )
    };
}

async function reconcileGroupChatCreate(
    _: IpcMainInvokeEvent,
    expectedUserId: string
): Promise<MatrixReconcileGroupChatCreateResult> {
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const operationKey = groupChatCreateLatchKey(binding);
        if (createGroupChatInFlight || groupChatReconciliationsInFlight.has(operationKey)) {
            throw bridgeError(
                "MATRIX_CREATE_GROUP_CHAT_RECONCILE_IN_PROGRESS",
                "Matrix group-chat creation is already being reconciled."
            );
        }
        groupChatReconciliationsInFlight.add(operationKey);
        try {
            const pending = await runGroupChatCreateState(async () => {
                await loadGroupChatCreateState();
                return ambiguousGroupChatCreates.get(operationKey);
            });
            if (!pending) return { status: "none" };
            if (pending.resolved) return { status: "resolved", result: pending.resolved };
            const rawResult = await callWorker<MatrixReconcileGroupChatCreateResult>({
                type: "reconcileGroupChatCreate",
                creationMarker: pending.creationMarker,
                name: pending.name,
                userIds: [...pending.userIds]
            });
            const result = validateProtocolReconcileGroupChatCreateResult(
                rawResult,
                pending,
                serverNameFromMatrixIdentifier(binding.userId)
            );
            if (result.status === "resolved") {
                try {
                    await persistResolvedGroupChatCreate(binding, pending, result.result);
                } catch (error) {
                    console.warn(`[MatrixBridge] Group-chat reconciliation resolved, but its receipt was not cached (${errorDTO(error).code}).`);
                }
            }
            return result;
        } finally {
            groupChatReconciliationsInFlight.delete(operationKey);
        }
    });
}

async function acknowledgeGroupChatCreate(
    _: IpcMainInvokeEvent,
    roomId: string,
    expectedUserId: string
): Promise<void> {
    const targetRoomId = validateRoomId(roomId);
    await withExpectedMatrixAccount(expectedUserId, async binding => {
        const operationKey = groupChatCreateLatchKey(binding);
        if (createGroupChatInFlight || groupChatReconciliationsInFlight.has(operationKey)) {
            throw bridgeError(
                "MATRIX_CREATE_GROUP_CHAT_RECONCILE_IN_PROGRESS",
                "Matrix group-chat creation is already being reconciled."
            );
        }
        groupChatReconciliationsInFlight.add(operationKey);
        try {
            const pending = await runGroupChatCreateState(async () => {
                await loadGroupChatCreateState();
                return ambiguousGroupChatCreates.get(operationKey);
            });
            // Idempotent after an acknowledgement whose reply was lost.
            if (!pending) return;
            // A cached receipt protects the renderer from a lost IPC response,
            // but acknowledgement is the destructive step. Re-attest the full
            // locked room contract in the worker immediately before clearing
            // the durable marker, even when a resolved receipt was cached.
            const rawResult = await callWorker<MatrixReconcileGroupChatCreateResult>({
                type: "reconcileGroupChatCreate",
                creationMarker: pending.creationMarker,
                name: pending.name,
                userIds: [...pending.userIds]
            });
            const reconciliation = validateProtocolReconcileGroupChatCreateResult(
                rawResult,
                pending,
                serverNameFromMatrixIdentifier(binding.userId)
            );
            if (reconciliation.status !== "resolved") {
                throw bridgeError(
                    "MATRIX_CREATE_GROUP_CHAT_ACK_NOT_READY",
                    "The Matrix group chat is not ready to acknowledge. Reconcile it again after sync."
                );
            }
            if (pending.resolved && pending.resolved.roomId !== reconciliation.result.roomId) {
                throw bridgeError(
                    "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT",
                    "The recovered Matrix group chat did not match its durable receipt."
                );
            }
            if (reconciliation.result.roomId !== targetRoomId) {
                throw bridgeError(
                    "MATRIX_CREATE_GROUP_CHAT_ACK_MISMATCH",
                    "The Matrix group-chat acknowledgement did not match the recovered room."
                );
            }
            await clearPendingGroupChatCreate(binding, pending);
        } finally {
            groupChatReconciliationsInFlight.delete(operationKey);
        }
    });
}

function validateCreateSpaceChildRequest(value: unknown): MatrixCreateSpaceChildRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space child details are invalid.");
    }
    const input = value as Partial<MatrixCreateSpaceChildRequest>;
    const parentSpaceId = validateRoomId(input.parentSpaceId);
    if (input.kind !== "room" && input.kind !== "space") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space child type is invalid.");
    }
    const name = validateString(input.name, "Space child name", 100).trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space child name is invalid.");
    }
    const request: MatrixCreateSpaceChildRequest = { parentSpaceId, kind: input.kind, name };
    if (input.topic != null) {
        const topic = validateString(input.topic, "Space child topic", 1_024, true).trim();
        if (/[\u0000-\u001f\u007f]/u.test(topic)) {
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix Space child topic is invalid.");
        }
        if (topic) request.topic = topic;
    }
    return request;
}

async function createSpaceChildForBinding(
    request: MatrixCreateSpaceChildRequest,
    binding: MatrixAccountBinding
): Promise<MatrixCreateSpaceChildResult> {
    const validatedRequest = validateCreateSpaceChildRequest(request);
    if (createSpaceChildInFlight) {
        throw bridgeError(
            "MATRIX_CREATE_SPACE_CHILD_IN_PROGRESS",
            "A Matrix Space room is already being created."
        );
    }

    createSpaceChildInFlight = true;
    try {
        const latchKey = spaceChildCreateLatchKey(binding, validatedRequest.parentSpaceId);
        const pending: PendingSpaceChildCreate = {
            homeserver: binding.homeserver,
            userId: binding.userId,
            parentSpaceId: validatedRequest.parentSpaceId,
            creationMarker: `vccreate_${randomBytes(32).toString("hex")}`
        };
        await runSpaceChildCreateState(async () => {
            await loadSpaceChildCreateState();
            if (ambiguousSpaceChildCreates.has(latchKey)) {
                throw bridgeError(
                    "MATRIX_CREATE_SPACE_CHILD_RECONCILE_REQUIRED",
                    "Reconcile the pending Matrix room creation before creating another room in this Space."
                );
            }
            if (ambiguousSpaceChildCreates.size >= MAX_AMBIGUOUS_SPACE_CHILD_CREATES) {
                throw bridgeError(
                    "MATRIX_CREATE_SPACE_CHILD_RECONCILE_REQUIRED",
                    "Too many Matrix room creations require reconciliation before another can start."
                );
            }
            ambiguousSpaceChildCreates.set(latchKey, pending);
            try {
                await saveSpaceChildCreateState();
            } catch (error) {
                ambiguousSpaceChildCreates.delete(latchKey);
                throw error;
            }
        });

        let rawResult: MatrixCreateSpaceChildResult;
        try {
            rawResult = await callWorker<MatrixCreateSpaceChildResult>({
                type: "createSpaceChild",
                request: validatedRequest,
                creationMarker: pending.creationMarker
            });
        } catch (error) {
            const definitive = error instanceof Error && (
                error.name === "MATRIX_INVALID_ARGUMENT"
                || error.name === "MATRIX_NOT_STARTED"
                || error.name === "MATRIX_WORKER_UNAVAILABLE"
                || error.name === "MATRIX_ROOM_NOT_JOINED"
                || error.name === "MATRIX_SPACE_REQUIRED"
                || error.name === "MATRIX_SPACE_CHILD_FORBIDDEN"
                || error.name === "MATRIX_SPACE_CHILD_PERMISSION_UNVERIFIABLE"
                || error.name === "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED"
                || error.name === "MATRIX_CREATE_SPACE_CHILD_REJECTED"
                || error.name === "MATRIX_CREATE_SPACE_CHILD_PRE_DISPATCH_FAILED"
                || error.name === "MATRIX_CREATE_SPACE_CHILD_PRE_DISPATCH_TIMEOUT"
                || error.name === "MATRIX_BACKEND_BUSY"
                || error.name === "MATRIX_COMMAND_QUEUE_TIMEOUT"
                || error.name === "MATRIX_SESSION_CHANGED"
            );
            if (definitive) {
                await runSpaceChildCreateState(async () => {
                    await loadSpaceChildCreateState();
                    const current = ambiguousSpaceChildCreates.get(latchKey);
                    if (current?.creationMarker !== pending.creationMarker) {
                        throw bridgeError(
                            "MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT",
                            "The pending Matrix creation state changed unexpectedly."
                        );
                    }
                    ambiguousSpaceChildCreates.delete(latchKey);
                    try {
                        await saveSpaceChildCreateState();
                    } catch (saveError) {
                        ambiguousSpaceChildCreates.set(latchKey, pending);
                        throw saveError;
                    }
                });
                throw error;
            }
            if (error instanceof Error && error.name === "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS") throw error;
            throw bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS",
                "Matrix room creation was interrupted and may have succeeded. Reconcile the parent Space before trying again."
            );
        }

        let result: MatrixCreateSpaceChildResult;
        try {
            if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space child creation response was invalid.");
            }
            const roomId = protocolRoomId(rawResult.roomId);
            if (roomId === validatedRequest.parentSpaceId
                || (rawResult.visibility !== "public" && rawResult.visibility !== "private")) {
                throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space child creation response was inconsistent.");
            }
            let partial: MatrixCreateSpaceChildResult["partial"];
            if (rawResult.partial != null) {
                if (typeof rawResult.partial !== "object" || Array.isArray(rawResult.partial)
                    || rawResult.partial.code !== "MATRIX_SPACE_CHILD_LINK_FAILED") {
                    throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix Space child partial result was invalid.");
                }
                partial = {
                    code: "MATRIX_SPACE_CHILD_LINK_FAILED",
                    message: protocolString(rawResult.partial.message, "Space child partial-result message", 300)
                };
            }
            result = {
                roomId,
                visibility: rawResult.visibility,
                ...(partial ? { partial } : {})
            };
        } catch {
            throw bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS",
                "Matrix created a room but returned an invalid response. Reconcile the parent Space before trying again."
            );
        }

        if (!result.partial) {
            await runSpaceChildCreateState(async () => {
                await loadSpaceChildCreateState();
                const current = ambiguousSpaceChildCreates.get(latchKey);
                if (current?.creationMarker !== pending.creationMarker) {
                    throw bridgeError(
                        "MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT",
                        "The pending Matrix creation state changed unexpectedly."
                    );
                }
                ambiguousSpaceChildCreates.delete(latchKey);
                try {
                    await saveSpaceChildCreateState();
                } catch (error) {
                    ambiguousSpaceChildCreates.set(latchKey, pending);
                    throw error;
                }
            });
        }
        return result;
    } finally {
        createSpaceChildInFlight = false;
    }
}

async function createSpaceChild(
    _: IpcMainInvokeEvent,
    request: MatrixCreateSpaceChildRequest,
    expectedUserId: string
): Promise<MatrixCreateSpaceChildResult> {
    return await withExpectedMatrixAccount(expectedUserId, binding =>
        createSpaceChildForBinding(request, binding));
}

async function repairSpaceChildLinkForBinding(
    parentSpaceId: string,
    childRoomId: string,
    binding: MatrixAccountBinding
): Promise<MatrixRoomActionResult> {
    const targetParentSpaceId = validateRoomId(parentSpaceId);
    const targetChildRoomId = validateRoomId(childRoomId);
    if (targetParentSpaceId === targetChildRoomId) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "A Matrix Space cannot be its own child.");
    }
    const latchKey = spaceChildCreateLatchKey(binding, targetParentSpaceId);
        const pending = await runSpaceChildCreateState(async () => {
        await loadSpaceChildCreateState();
        const value = ambiguousSpaceChildCreates.get(latchKey);
        return value ? { ...value } : undefined;
        });
        const result = await callWorker<MatrixRoomActionResult>({
        type: "repairSpaceChildLink",
        parentSpaceId: targetParentSpaceId,
        childRoomId: targetChildRoomId,
        ...(pending ? { creationMarker: pending.creationMarker } : {})
        });
        const validatedResult = validateRoomActionResult(result, targetChildRoomId);
        if (pending) {
        if (!sameAccountBinding(binding, activeWorkerBinding)) {
            throw bridgeError("MATRIX_SESSION_CHANGED", "The Matrix account changed during link repair.");
        }
        await runSpaceChildCreateState(async () => {
            await loadSpaceChildCreateState();
            const current = ambiguousSpaceChildCreates.get(latchKey);
            if (current?.creationMarker !== pending.creationMarker) {
                throw bridgeError(
                    "MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT",
                    "The pending Matrix creation state changed unexpectedly."
                );
            }
            ambiguousSpaceChildCreates.delete(latchKey);
            try {
                await saveSpaceChildCreateState();
            } catch (error) {
                ambiguousSpaceChildCreates.set(latchKey, pending);
                throw error;
            }
        });
        }
    return validatedResult;
}

async function repairSpaceChildLink(
    _: IpcMainInvokeEvent,
    parentSpaceId: string,
    childRoomId: string,
    expectedUserId: string
): Promise<MatrixRoomActionResult> {
    return await withExpectedMatrixAccount(expectedUserId, binding =>
        repairSpaceChildLinkForBinding(parentSpaceId, childRoomId, binding));
}

async function reconcileSpaceChildCreateForBinding(
    parentSpaceId: string,
    binding: MatrixAccountBinding
): Promise<MatrixReconcileSpaceChildCreateResult> {
    const targetParentSpaceId = validateRoomId(parentSpaceId);
    const latchKey = spaceChildCreateLatchKey(binding, targetParentSpaceId);
        const pending = await runSpaceChildCreateState(async () => {
        await loadSpaceChildCreateState();
        const value = ambiguousSpaceChildCreates.get(latchKey);
        if (!value) {
            throw bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_RECONCILE_NOT_PENDING",
                "There is no pending Matrix room creation for this Space."
            );
        }
        return { ...value };
        });

        const rawResult = await callWorker<MatrixReconcileSpaceChildCreateResult>({
        type: "reconcileSpaceChildCreate",
        parentSpaceId: targetParentSpaceId,
        creationMarker: pending.creationMarker
        });
        if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)
        || typeof rawResult.resolved !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room reconciliation response was invalid.");
        }
        if (!rawResult.resolved) {
        if ("roomId" in rawResult && rawResult.roomId != null) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room reconciliation response was inconsistent.");
        }
        return { resolved: false };
        }
        const roomId = protocolRoomId(rawResult.roomId);
        if (roomId === targetParentSpaceId || !sameAccountBinding(binding, activeWorkerBinding)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix room reconciliation response was inconsistent.");
        }

        await runSpaceChildCreateState(async () => {
        await loadSpaceChildCreateState();
        const current = ambiguousSpaceChildCreates.get(latchKey);
        if (current?.creationMarker !== pending.creationMarker) {
            throw bridgeError(
                "MATRIX_CREATE_SPACE_CHILD_STATE_CORRUPT",
                "The pending Matrix creation state changed unexpectedly."
            );
        }
        ambiguousSpaceChildCreates.delete(latchKey);
        try {
            await saveSpaceChildCreateState();
        } catch (error) {
            ambiguousSpaceChildCreates.set(latchKey, pending);
            throw error;
        }
        });
    return { resolved: true, roomId };
}

async function reconcileSpaceChildCreate(
    _: IpcMainInvokeEvent,
    parentSpaceId: string,
    expectedUserId: string
): Promise<MatrixReconcileSpaceChildCreateResult> {
    return await withExpectedMatrixAccount(expectedUserId, binding =>
        reconcileSpaceChildCreateForBinding(parentSpaceId, binding));
}

async function spaceChildren(
    _: IpcMainInvokeEvent,
    spaceId: string,
    limit = 200,
    maxDepth = 8
): Promise<MatrixSpaceHierarchyDTO> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 16) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix space hierarchy limits are invalid.");
    }
    await requireStarted();
    const targetSpaceId = validateRoomId(spaceId);
    const result = await callWorker<MatrixSpaceHierarchyDTO>({
        type: "spaceChildren",
        spaceId: targetSpaceId,
        limit,
        maxDepth
    });
    return validateSpaceHierarchy(result, targetSpaceId);
}

async function suggestedSpaceChannelPlan(
    _: IpcMainInvokeEvent,
    spaceId: string,
    expectedUserId: string
): Promise<MatrixSuggestedSpaceChannelPlanDTO> {
    const targetSpaceId = validateRoomId(spaceId);
    return await withExpectedMatrixAccount(expectedUserId, async () => {
        const result = await callWorker<MatrixSuggestedSpaceChannelPlanDTO>({
            type: "suggestedSpaceChannelPlan",
            spaceId: targetSpaceId
        });
        return validateProtocolSuggestedSpaceChannelPlan(result, targetSpaceId);
    });
}

async function joinSuggestedSpaceChannels(
    _: IpcMainInvokeEvent,
    request: MatrixJoinSuggestedSpaceChannelsRequest,
    expectedUserId: string
): Promise<MatrixJoinSuggestedSpaceChannelsResult> {
    const validatedRequest = validateJoinSuggestedSpaceChannelsRequest(request);
    return await withExpectedMatrixAccount(expectedUserId, async binding => {
        const operationKey = JSON.stringify([
            binding.homeserver,
            binding.userId,
            binding.deviceId,
            binding.storageKey,
            validatedRequest.spaceId
        ]);
        if (suggestedSpaceChannelJoinsInFlight.has(operationKey)) {
            throw bridgeError(
                "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_IN_PROGRESS",
                "Suggested channels are already being joined for this Matrix Space."
            );
        }
        if (suggestedSpaceChannelJoinsInFlight.size >= MAX_IN_FLIGHT_SUGGESTED_SPACE_CHANNEL_JOINS) {
            throw bridgeError("MATRIX_BACKEND_BUSY", "The Matrix backend has too many suggested-channel joins pending.");
        }
        suggestedSpaceChannelJoinsInFlight.add(operationKey);
        try {
            const result = await callWorker<MatrixJoinSuggestedSpaceChannelsResult>({
                type: "joinSuggestedSpaceChannels",
                request: validatedRequest
            });
            try {
                return validateProtocolJoinSuggestedSpaceChannelsResult(result, validatedRequest);
            } catch {
                throw bridgeError(
                    "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS",
                    "Matrix joined suggested channels but returned an invalid confirmation. Refresh the server before trying again."
                );
            }
        } finally {
            suggestedSpaceChannelJoinsInFlight.delete(operationKey);
        }
    });
}

async function openDirectMessage(
    _: IpcMainInvokeEvent,
    spaceId: string,
    userId: string
): Promise<MatrixDirectMessageResult> {
    await requireStarted();
    const targetSpaceId = validateRoomId(spaceId);
    const targetUserId = validateUserId(userId);
    const result = await callWorker<MatrixDirectMessageResult>({
        type: "openDirectMessage",
        spaceId: targetSpaceId,
        userId: targetUserId
    });
    if (!result || typeof result !== "object" || typeof result.created !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix direct-message response was invalid.");
    }
    return { roomId: protocolRoomId(result.roomId), created: result.created };
}

async function downloadMedia(
    _: IpcMainInvokeEvent,
    roomId: string,
    eventId: string,
    attachmentIndex = 0
): Promise<MatrixMediaDownloadResult> {
    if (!Number.isSafeInteger(attachmentIndex) || (attachmentIndex !== 0 && attachmentIndex !== 1)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix attachment index is invalid.");
    }
    await requireStarted();
    const result = await callWorker<MatrixMediaDownloadResult>({
        type: "downloadMedia",
        roomId: validateRoomId(roomId),
        eventId: validateEventId(eventId),
        attachmentIndex
    });
    const maximumBytes = attachmentIndex === 1
        ? MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES
        : MAX_MEDIA_DOWNLOAD_BYTES;
    if (!result || typeof result !== "object" || !(result.bytes instanceof Uint8Array)
        || result.bytes.byteLength > maximumBytes) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix media response was invalid.");
    }
    const name = validateString(result.name, "media name", 255);
    const mimeType = validateString(result.mimeType, "media mimeType", 128);
    if (/[\u0000-\u001f\u007f\\/]/u.test(name)
        || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix media metadata was invalid.");
    }
    const width = result.width == null ? undefined : Number(result.width);
    const height = result.height == null ? undefined : Number(result.height);
    if ((width == null) !== (height == null)
        || (width != null && (!Number.isSafeInteger(width) || width < 1 || width > MAX_IMAGE_DIMENSION))
        || (height != null && (!Number.isSafeInteger(height) || height < 1 || height > MAX_IMAGE_DIMENSION))
        || (width != null && height != null && width * height > MAX_IMAGE_PIXELS)
        || (result.animated != null && typeof result.animated !== "boolean")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix media dimensions were invalid.");
    }
    return {
        name,
        mimeType,
        // Worker IPC already structured-cloned this buffer. Avoid another
        // main-process copy for large preview videos before renderer IPC.
        bytes: attachmentIndex === 1 ? result.bytes : new Uint8Array(result.bytes),
        width,
        height,
        animated: result.animated
    };
}

function validatePreviewMedia(
    source: unknown,
    label: "image" | "video",
    downloadIndex: 0 | 1
): MatrixUrlPreviewMediaDTO {
    if (!source || typeof source !== "object") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", `The Matrix URL preview ${label} was invalid.`);
    }
    const input = source as Partial<MatrixUrlPreviewMediaDTO>;
    const name = validateString(input.name, `preview ${label} name`, 255);
    if (/[\u0000-\u001f\u007f\\/]/u.test(name)
        || input.downloadable !== true || input.downloadIndex !== downloadIndex) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview metadata was invalid.");
    }
    const media: MatrixUrlPreviewMediaDTO = { name, downloadable: true, downloadIndex };
    if (input.mimeType != null) {
        const mimeType = validateString(input.mimeType, "preview mimeType", 128);
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
            || (label === "video" && mimeType !== "video/mp4")) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview metadata was invalid.");
        }
        media.mimeType = mimeType;
    } else if (label === "video") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview video type was invalid.");
    }
    if (input.size != null) {
        const maximumBytes = label === "video"
            ? MAX_PREVIEW_VIDEO_DOWNLOAD_BYTES
            : MAX_MEDIA_DOWNLOAD_BYTES;
        if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maximumBytes) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview size was invalid.");
        }
        media.size = input.size;
    }
    for (const field of ["width", "height"] as const) {
        const value = input[field];
        if (value == null) continue;
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview dimensions were invalid.");
        }
        media[field] = value;
    }
    if ((media.width == null) !== (media.height == null)
        || (label === "video" && media.width == null)
        || (media.width != null && media.height != null && media.width * media.height > MAX_IMAGE_PIXELS)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview dimensions were invalid.");
    }
    if (input.animated != null) {
        if (label !== "image" || typeof input.animated !== "boolean") {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview metadata was invalid.");
        }
        media.animated = input.animated;
    }
    return media;
}

async function urlPreview(
    _: IpcMainInvokeEvent,
    roomId: string,
    eventId: string
): Promise<MatrixUrlPreviewDTO | undefined> {
    await requireStarted();
    const result = await callWorker<MatrixUrlPreviewDTO | undefined>({
        type: "urlPreview",
        roomId: validateRoomId(roomId),
        eventId: validateEventId(eventId)
    });
    if (result == null) return undefined;
    if (typeof result !== "object" || typeof result.url !== "string" || result.url.length > 2_048) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview response was invalid.");
    }

    let previewUrl: URL;
    try {
        previewUrl = new URL(result.url);
    } catch {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview URL was invalid.");
    }
    if ((previewUrl.protocol !== "http:" && previewUrl.protocol !== "https:")
        || previewUrl.username || previewUrl.password || previewUrl.port || previewUrl.href !== result.url
        || /[\u0000-\u001f\u007f]/u.test(result.url)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview URL was invalid.");
    }

    const preview: MatrixUrlPreviewDTO = { url: previewUrl.href };
    for (const [field, maximum] of [["title", 512], ["description", 4_096]] as const) {
        const value = result[field];
        if (value == null) continue;
        if (typeof value !== "string" || value.length === 0 || value.length > maximum
            || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview text was invalid.");
        }
        preview[field] = value;
    }
    if (result.provider != null) {
        if (typeof result.provider !== "object" || typeof result.provider.name !== "string"
            || result.provider.name.length === 0 || result.provider.name.length > 256
            || /[\u0000-\u001f\u007f]/u.test(result.provider.name)) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix URL preview provider was invalid.");
        }
        preview.provider = { name: result.provider.name };
    }

    if (result.image != null) preview.image = validatePreviewMedia(result.image, "image", 0);
    if (result.video != null) preview.video = validatePreviewMedia(result.video, "video", 1);
    return preview;
}

function validateMessageSearchRequest(value: unknown): MatrixMessageSearchRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix search request is invalid.");
    }
    const raw = value as Partial<MatrixMessageSearchRequest>;
    const query = validateString(raw.query, "search query", 256).trim();
    if (!query || /[\u0000-\u001f\u007f]/u.test(query)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix search query is invalid.");
    }
    const limit = raw.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix search limit must be between 1 and 25.");
    }
    if (!raw.scope || typeof raw.scope !== "object" || Array.isArray(raw.scope)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix search scope is invalid.");
    }
    let scope: MatrixMessageSearchRequest["scope"];
    if (raw.scope.kind === "all") {
        scope = { kind: "all" };
    } else if (raw.scope.kind === "room") {
        scope = { kind: "room", roomId: validateRoomId(raw.scope.roomId) };
    } else if (raw.scope.kind === "space") {
        scope = { kind: "space", spaceId: validateRoomId(raw.scope.spaceId) };
    } else {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix search scope is invalid.");
    }
    return {
        query,
        scope,
        limit,
        ...(raw.cursor == null ? {} : { cursor: validateCursor(raw.cursor, "s") })
    };
}

function validateMessageSearchResult(
    value: unknown,
    request: MatrixMessageSearchRequest
): MatrixMessageSearchResultDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search result was invalid.");
    }
    const raw = value as Partial<MatrixMessageSearchResultDTO>;
    const roomId = protocolRoomId(raw.roomId);
    if (request.scope.kind === "room" && roomId !== request.scope.roomId) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search returned a result outside the requested room.");
    }
    const message = validateProtocolMessage(raw.message, roomId);
    const before = validateProtocolMessageList(raw.before, "search context", 2, roomId);
    const after = validateProtocolMessageList(raw.after, "search context", 2, roomId);
    const contextEventIds = [...before, ...after].map(item => item.eventId);
    if (contextEventIds.includes(message.eventId) || new Set(contextEventIds).size !== contextEventIds.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search context response contained duplicate events.");
    }
    if (raw.source !== "server" && raw.source !== "local") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search result source was invalid.");
    }
    const roomName = protocolText(raw.roomName, "search room name", 256);
    if (/[\u0000-\u001f\u007f]/u.test(roomName)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search room name was invalid.");
    }
    const result: MatrixMessageSearchResultDTO = {
        roomId,
        roomName,
        message,
        before,
        after,
        source: raw.source
    };
    if (raw.isolated != null) {
        if (raw.isolated !== true) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search result isolation flag was invalid.");
        }
        result.isolated = true;
    }
    if (raw.rank != null) {
        if (typeof raw.rank !== "number" || !Number.isFinite(raw.rank) || Math.abs(raw.rank) > 1_000_000_000) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search result rank was invalid.");
        }
        result.rank = raw.rank;
    }
    return result;
}

function validateMessageSearchResponse(
    value: unknown,
    request: MatrixMessageSearchRequest
): MatrixMessageSearchResponse {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search response was invalid.");
    }
    const raw = value as Partial<MatrixMessageSearchResponse>;
    const limit = request.limit ?? 25;
    const { searchedRoomCount } = raw;
    if (!Array.isArray(raw.results) || raw.results.length > limit
        || typeof searchedRoomCount !== "number" || !Number.isSafeInteger(searchedRoomCount)
        || searchedRoomCount < 0 || searchedRoomCount > 200
        || typeof raw.limited !== "boolean"
        || (raw.coverage !== "server" && raw.coverage !== "local" && raw.coverage !== "mixed")) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search response was invalid.");
    }
    const results = raw.results.map(result => validateMessageSearchResult(result, request));
    if (new Set(results.map(result => `${result.roomId}\0${result.message.eventId}`)).size !== results.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search response contained duplicate results.");
    }
    if (new Set(results.map(result => result.roomId)).size > searchedRoomCount) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search response room count was inconsistent.");
    }
    const cursor = raw.cursor == null ? undefined : protocolCursor(raw.cursor, "s");
    if (cursor && !raw.limited) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix search response cursor was inconsistent.");
    }
    return {
        results,
        ...(cursor ? { cursor } : {}),
        coverage: raw.coverage,
        searchedRoomCount,
        limited: raw.limited
    };
}

function validateHistoryPage(
    value: unknown,
    expectedRoomId: string,
    maximumMessages: number
): MatrixHistoryPageDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix history response was invalid.");
    }
    const raw = value as Partial<MatrixHistoryPageDTO>;
    const roomId = protocolRoomId(raw.roomId);
    if (roomId !== expectedRoomId
        || !Number.isSafeInteger(raw.timelineGeneration) || raw.timelineGeneration! < 0
        || typeof raw.end !== "boolean" || typeof raw.progressed !== "boolean") {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix history response was invalid.");
    }
    const messages = validateProtocolMessageList(raw.messages, "history messages", maximumMessages, roomId);
    const beforeCursor = raw.beforeCursor == null ? undefined : protocolCursor(raw.beforeCursor, "h");
    if ((raw.end && beforeCursor) || (!raw.end && !beforeCursor)
        || (messages.length > 0 && !raw.progressed) || (beforeCursor && !raw.progressed)
        || (!raw.progressed && !raw.end)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix history response progress was inconsistent.");
    }
    return {
        roomId,
        timelineGeneration: raw.timelineGeneration!,
        messages,
        ...(beforeCursor ? { beforeCursor } : {}),
        end: raw.end,
        progressed: raw.progressed
    };
}

function validateMessageContext(
    value: unknown,
    expectedRoomId: string,
    expectedEventId: string
): MatrixMessageContextDTO {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message context response was invalid.");
    }
    const raw = value as Partial<MatrixMessageContextDTO>;
    const roomId = protocolRoomId(raw.roomId);
    if (roomId !== expectedRoomId || raw.isolated !== true) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message context response was invalid.");
    }
    const message = validateProtocolMessage(raw.message, roomId);
    if (message.eventId !== expectedEventId) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message context returned the wrong event.");
    }
    const before = validateProtocolMessageList(raw.before, "message context", 2, roomId);
    const after = validateProtocolMessageList(raw.after, "message context", 2, roomId);
    const contextEventIds = [...before, ...after].map(item => item.eventId);
    if (contextEventIds.includes(message.eventId) || new Set(contextEventIds).size !== contextEventIds.length) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix message context contained duplicate events.");
    }
    return { roomId, message, before, after, isolated: true };
}

async function searchMessages(
    _: IpcMainInvokeEvent,
    request: MatrixMessageSearchRequest
): Promise<MatrixMessageSearchResponse> {
    const validated = validateMessageSearchRequest(request);
    await requireStarted();
    const result = await callWorker<MatrixMessageSearchResponse>({ type: "searchMessages", request: validated });
    return validateMessageSearchResponse(result, validated);
}

async function sendText(
    _: IpcMainInvokeEvent,
    roomId: string,
    body: string,
    replyEventId?: string,
    mentionedUserIds?: string[]
): Promise<MatrixActionResult> {
    await requireStarted();
    return await callWorker<MatrixActionResult>({
        type: "sendText",
        roomId: validateRoomId(roomId),
        body: validateString(body, "body", 65_536),
        replyEventId: replyEventId == null ? undefined : validateEventId(replyEventId),
        mentionedUserIds: validateMentionUserIds(mentionedUserIds)
    });
}

async function sendSticker(
    _: IpcMainInvokeEvent,
    roomId: string,
    sticker: MatrixStickerSendRequest
): Promise<MatrixStickerSendResult> {
    const targetRoomId = validateRoomId(roomId);
    const validatedSticker = validateStickerSendRequest(sticker);
    await requireStarted();
    const result = await callWorker<MatrixStickerSendResult>({
        type: "sendSticker",
        roomId: targetRoomId,
        sticker: validatedSticker
    });
    if (!result || typeof result !== "object" || typeof result.eventId !== "string"
        || !result.eventId.startsWith("$") || /\s/u.test(result.eventId) || result.eventId.length > 2_048) {
        throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix sticker send response was invalid.");
    }
    return { eventId: result.eventId };
}

async function sendAttachment(
    _: IpcMainInvokeEvent,
    roomId: string,
    attachment: MatrixAttachmentSendRequest
): Promise<MatrixAttachmentSendResult> {
    const receivedBytes = attachment?.bytes instanceof Uint8Array && attachment.bytes.buffer instanceof ArrayBuffer
        ? attachment.bytes
        : undefined;
    try {
        const targetRoomId = validateRoomId(roomId);
        const validatedAttachment = validateAttachmentSendRequest(attachment);
        await requireStarted();
        const result = await callWorker<MatrixAttachmentSendResult>({
            type: "sendAttachment",
            roomId: targetRoomId,
            attachment: validatedAttachment
        });
        if (!result || typeof result !== "object" || typeof result.eventId !== "string"
            || !result.eventId.startsWith("$") || /\s/u.test(result.eventId) || result.eventId.length > 2_048) {
            throw bridgeError("MATRIX_PROTOCOL_ERROR", "The Matrix attachment send response was invalid.");
        }
        return { eventId: result.eventId };
    } finally {
        receivedBytes?.fill(0);
    }
}

async function edit(
    _: IpcMainInvokeEvent,
    roomId: string,
    eventId: string,
    body: string,
    mentionedUserIds?: string[]
): Promise<MatrixActionResult> {
    await requireStarted();
    return await callWorker<MatrixActionResult>({
        type: "edit",
        roomId: validateRoomId(roomId),
        eventId: validateEventId(eventId),
        body: validateString(body, "body", 65_536),
        mentionedUserIds: validateMentionUserIds(mentionedUserIds)
    });
}

async function cancelPending(_: IpcMainInvokeEvent, roomId: string, transactionId: string): Promise<void> {
    const validatedTransactionId = validateString(transactionId, "transactionId", 128);
    if (!/^[A-Za-z0-9._~-]+$/u.test(validatedTransactionId)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix transaction ID is invalid.");
    }
    await requireStarted();
    await callWorker({
        type: "cancelPending",
        roomId: validateRoomId(roomId),
        transactionId: validatedTransactionId
    });
}

async function redact(_: IpcMainInvokeEvent, roomId: string, eventId: string, reason?: string): Promise<MatrixActionResult> {
    await requireStarted();
    return await callWorker<MatrixActionResult>({
        type: "redact",
        roomId: validateRoomId(roomId),
        eventId: validateEventId(eventId),
        reason: reason == null ? undefined : validateString(reason, "reason", 1_024, true)
    });
}

async function react(_: IpcMainInvokeEvent, roomId: string, eventId: string, key: string, remove = false): Promise<MatrixActionResult> {
    await requireStarted();
    return await callWorker<MatrixActionResult>({
        type: "react",
        roomId: validateRoomId(roomId),
        eventId: validateEventId(eventId),
        key: validateString(key, "key", 128),
        remove: Boolean(remove)
    });
}

async function typing(_: IpcMainInvokeEvent, roomId: string, isTyping: boolean, timeoutMs = 30_000): Promise<void> {
    await requireStarted();
    if (typeof isTyping !== "boolean" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Typing parameters are invalid.");
    }
    await callWorker({ type: "typing", roomId: validateRoomId(roomId), isTyping, timeoutMs });
}

async function read(_: IpcMainInvokeEvent, roomId: string, eventId: string): Promise<void> {
    await requireStarted();
    await callWorker({ type: "read", roomId: validateRoomId(roomId), eventId: validateEventId(eventId) });
}

async function paginate(
    _: IpcMainInvokeEvent,
    roomId: string,
    limit = 50,
    fromEventId?: string,
    cursor?: string
): Promise<MatrixHistoryPageDTO> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The pagination limit must be between 1 and 100.");
    }
    const targetRoomId = validateRoomId(roomId);
    const anchorEventId = fromEventId == null ? undefined : protocolTimelineEventId(fromEventId, targetRoomId);
    const historyCursor = cursor == null ? undefined : validateCursor(cursor, "h");
    await requireStarted();
    const result = await callWorker<MatrixHistoryPageDTO>({
        type: "paginate",
        roomId: targetRoomId,
        limit,
        fromEventId: anchorEventId,
        cursor: historyCursor
    });
    return validateHistoryPage(result, targetRoomId, limit);
}

async function messageContext(
    _: IpcMainInvokeEvent,
    roomId: string,
    eventId: string
): Promise<MatrixMessageContextDTO> {
    const targetRoomId = validateRoomId(roomId);
    const targetEventId = validateEventId(eventId);
    await requireStarted();
    const result = await callWorker<MatrixMessageContextDTO>({
        type: "messageContext",
        roomId: targetRoomId,
        eventId: targetEventId
    });
    return validateMessageContext(result, targetRoomId, targetEventId);
}

function validatePrivateRequest(value: unknown): MatrixSecureViewRequest {
    const request = objectRecord(value, "secure view request");
    if (typeof request.type !== "string") {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view request type is invalid.");
    }
    switch (request.type) {
        case "bootstrap":
        case "refresh":
        case "logout":
        case "publicRooms":
        case "reconcileGroupChatCreate":
            exactObjectKeys(request, "secure view request", ["type"]);
            break;
        case "navigate":
            exactObjectKeys(request, "secure view request", ["type", "route"]);
            validateSecureViewRoute(request.route);
            break;
        case "login": {
            exactObjectKeys(request, "secure view request", ["type", "login"]);
            const loginRequest = objectRecord(request.login, "login request");
            if (loginRequest.method === "password") {
                exactObjectKeys(loginRequest, "login request", ["homeserver", "method", "username", "password"]);
            } else if (loginRequest.method === "access_token") {
                exactObjectKeys(loginRequest, "login request", ["homeserver", "method", "accessToken"]);
            } else {
                throw bridgeError("MATRIX_INVALID_ARGUMENT", "The login request type is invalid.");
            }
            break;
        }
        case "register":
            exactObjectKeys(request, "secure view request", ["type", "registration"]);
            exactObjectKeys(
                request.registration,
                "registration request",
                ["homeserver", "username", "password", "registrationToken"]
            );
            break;
        case "joinRoom":
        case "acknowledgeGroupChatCreate":
        case "reconcileGroupChatInvite":
        case "acceptInvite":
        case "rejectInvite":
        case "leaveRoom":
            exactObjectKeys(request, "secure view request", ["type", "roomId"]);
            break;
        case "joinRoomAddress":
            exactObjectKeys(request, "secure view request", ["type", "address"]);
            break;
        case "createSpace":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "create Space request",
                ["name", "topic", "visibility", "createGeneral"],
                ["name"]
            );
            break;
        case "searchGroupChatCandidates":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "group-chat directory search",
                ["query", "limit", "exact"],
                ["query"]
            );
            break;
        case "searchGroupChatInviteCandidates":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "group-chat invite search",
                ["roomId", "query", "limit", "exact"],
                ["roomId", "query"]
            );
            break;
        case "inviteUserToGroupChat":
        case "acknowledgeGroupChatInvite":
        case "overrideGroupChatInviteAmbiguity":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(request.request, "group-chat invite request", ["roomId", "userId"]);
            break;
        case "createGroupChat":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(request.request, "create group-chat request", ["name", "userIds"]);
            break;
        case "getSpaceAccess":
        case "getSpaceAccessRequests":
            exactObjectKeys(request, "secure view request", ["type", "spaceId"]);
            break;
        case "configureSpaceAccess":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "configure Space access request",
                ["spaceId", "mode", "joinName"],
                ["spaceId", "mode"]
            );
            break;
        case "requestSpaceAccess":
            exactObjectKeys(request, "secure view request", ["type", "joinName"]);
            break;
        case "resolveSpaceAccessRequest":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "resolve Space access request",
                ["spaceId", "userId", "decision"]
            );
            break;
        case "createSpaceChild":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            exactObjectKeys(
                request.request,
                "create Space child request",
                ["parentSpaceId", "kind", "name", "topic"],
                ["parentSpaceId", "kind", "name"]
            );
            break;
        case "reconcileSpaceChildCreate":
            exactObjectKeys(request, "secure view request", ["type", "parentSpaceId"]);
            break;
        case "repairSpaceChildLink":
            exactObjectKeys(request, "secure view request", ["type", "parentSpaceId", "childRoomId"]);
            break;
        case "spaceChildren":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "spaceId", "limit", "maxDepth"],
                ["type", "spaceId"]
            );
            break;
        case "suggestedSpaceChannelPlan":
            exactObjectKeys(request, "secure view request", ["type", "spaceId"]);
            break;
        case "joinSuggestedSpaceChannels":
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            validateJoinSuggestedSpaceChannelsRequest(request.request);
            break;
        case "openDirectMessage":
            exactObjectKeys(request, "secure view request", ["type", "spaceId", "userId"]);
            break;
        case "paginate":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "roomId", "limit", "fromEventId", "cursor"],
                ["type", "roomId"]
            );
            break;
        case "messageContext":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "eventId"]);
            break;
        case "searchMessages": {
            exactObjectKeys(request, "secure view request", ["type", "request"]);
            const searchRequest = exactObjectKeys(
                request.request,
                "search request",
                ["query", "scope", "limit", "cursor"],
                ["query", "scope"]
            );
            const scope = objectRecord(searchRequest.scope, "search scope");
            if (scope.kind === "all") {
                exactObjectKeys(scope, "search scope", ["kind"]);
            } else if (scope.kind === "room") {
                exactObjectKeys(scope, "search scope", ["kind", "roomId"]);
            } else if (scope.kind === "space") {
                exactObjectKeys(scope, "search scope", ["kind", "spaceId"]);
            } else {
                throw bridgeError("MATRIX_INVALID_ARGUMENT", "The search scope is invalid.");
            }
            break;
        }
        case "sendText":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "roomId", "body", "replyEventId"],
                ["type", "roomId", "body"]
            );
            break;
        case "sendAttachment": {
            exactObjectKeys(request, "secure view request", ["type", "roomId", "attachment"]);
            const attachment = exactObjectKeys(
                request.attachment,
                "attachment request",
                [
                    "name",
                    "txnId",
                    "declaredMimeType",
                    "bytes",
                    "caption",
                    "width",
                    "height",
                    "durationMs",
                    "replyEventId",
                    "attachmentGroup"
                ],
                ["name", "txnId", "bytes"]
            );
            if (attachment.attachmentGroup != null) {
                exactObjectKeys(
                    attachment.attachmentGroup,
                    "attachment group",
                    ["id", "index", "total"]
                );
            }
            break;
        }
        case "sendSticker":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "sticker"]);
            exactObjectKeys(
                request.sticker,
                "sticker request",
                ["id", "name", "formatType", "replyEventId"],
                ["id", "name", "formatType"]
            );
            break;
        case "edit":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "eventId", "body"]);
            break;
        case "cancelPending":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "transactionId"]);
            break;
        case "redact":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "roomId", "eventId", "reason"],
                ["type", "roomId", "eventId"]
            );
            break;
        case "react":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "roomId", "eventId", "key", "remove"],
                ["type", "roomId", "eventId", "key"]
            );
            if (request.remove != null && typeof request.remove !== "boolean") {
                throw bridgeError("MATRIX_INVALID_ARGUMENT", "The reaction request is invalid.");
            }
            break;
        case "typing":
            exactObjectKeys(
                request,
                "secure view request",
                ["type", "roomId", "isTyping", "timeoutMs"],
                ["type", "roomId", "isTyping"]
            );
            break;
        case "read":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "eventId"]);
            break;
        case "downloadMedia":
        case "saveMedia":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "eventId", "attachmentIndex"]);
            break;
        case "urlPreview":
            exactObjectKeys(request, "secure view request", ["type", "roomId", "eventId"]);
            break;
        case "openExternal":
            exactObjectKeys(request, "secure view request", ["type", "url"]);
            break;
        default:
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The secure view request type is invalid.");
    }
    return request as unknown as MatrixSecureViewRequest;
}

function clearPrivateRequest(request: MatrixSecureViewRequest): void {
    switch (request.type) {
        case "login":
            if (request.login.method === "password") request.login.password = "";
            else request.login.accessToken = "";
            break;
        case "register":
            request.registration.password = "";
            request.registration.registrationToken = "";
            break;
        case "sendText":
            request.body = "";
            break;
        case "sendAttachment":
            if (request.attachment.bytes instanceof Uint8Array) request.attachment.bytes.fill(0);
            if (request.attachment.caption != null) request.attachment.caption = "";
            break;
        case "edit":
            request.body = "";
            break;
        case "redact":
            if (request.reason != null) request.reason = "";
            break;
        case "searchMessages":
            request.request.query = "";
            break;
    }
}

function requireCurrentSecureViewAccount(state: SecureViewState): void {
    if (accountLifecycleTransitions > 0 || !state.boundAccount
        || !sameAccountBinding(state.boundAccount, activeWorkerBinding)) {
        throw bridgeError(
            "MATRIX_SECURE_VIEW_ACCOUNT_STALE",
            "The Matrix account changed. Reopen or refresh the isolated account view."
        );
    }
}

function secureViewExpectedUserId(state: SecureViewState): string {
    const userId = state.boundAccount?.userId;
    if (!userId) {
        throw bridgeError(
            "MATRIX_SECURE_VIEW_ACCOUNT_STALE",
            "Reload the secure Matrix view before changing Space access."
        );
    }
    return userId;
}

function requireVerifiedSignedOutView(state: SecureViewState): void {
    if (accountLifecycleTransitions > 0 || state.boundAccount !== null || activeWorkerBinding !== null) {
        throw bridgeError(
            "MATRIX_SECURE_VIEW_ACCOUNT_STALE",
            "The Matrix account changed. Reopen the isolated account view."
        );
    }
}

async function requireStoredSecureViewAccount(state: SecureViewState): Promise<void> {
    const storedBinding = accountBinding(await readStoredAccount());
    requireCurrentSecureViewAccount(state);
    if (!sameAccountBinding(state.boundAccount ?? null, storedBinding)) {
        throw bridgeError(
            "MATRIX_SECURE_VIEW_ACCOUNT_STALE",
            "The configured Matrix account changed. Reopen the isolated account view."
        );
    }
}

async function requireStoredSignedOutView(state: SecureViewState): Promise<void> {
    const storedBinding = accountBinding(await readStoredAccount());
    requireVerifiedSignedOutView(state);
    if (storedBinding !== null) {
        throw bridgeError(
            "MATRIX_SECURE_VIEW_ACCOUNT_STALE",
            "A Matrix account is already configured. Reopen the isolated account view."
        );
    }
}

function beginPrivateAccountRequest(state: SecureViewState): () => void {
    if (privateIdentityTransition) {
        throw bridgeError("MATRIX_ACCOUNT_TRANSITION", "The Matrix account is changing. Try again.");
    }
    requireCurrentSecureViewAccount(state);
    privateAccountRequests++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        privateAccountRequests--;
        if (privateAccountRequests === 0) {
            for (const resolve of [...privateAccountDrainWaiters]) {
                privateAccountDrainWaiters.delete(resolve);
                resolve();
            }
        }
    };
}

function runPrivateIdentityTransition<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
        privateIdentityTransition = true;
        try {
            if (privateAccountRequests > 0) {
                await new Promise<void>(resolve => privateAccountDrainWaiters.add(resolve));
            }
            if (accountLifecycleTransitions > 0) await lifecycleTail.catch(() => undefined);
            return await operation();
        } finally {
            privateIdentityTransition = false;
        }
    };
    const result = privateIdentityTail.then(run, run);
    privateIdentityTail = result.then(() => undefined, () => undefined);
    return result;
}

function validateExternalUrl(value: unknown): string {
    const input = validateString(value, "external URL", 4_096);
    if (/[\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The external URL is invalid.");
    }
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The external URL is invalid.");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "Only ordinary HTTP or HTTPS links can be opened.");
    }
    return url.href;
}

function safeSaveDialogName(value: string): string {
    let name = value
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/gu, "_")
        .replace(/[. ]+$/gu, "")
        .slice(0, 240);
    if (!name) name = "matrix-attachment";
    const stem = name.split(".", 1)[0];
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) name = `_${name}`;
    return name;
}

async function handlePrivateRequest(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    request: MatrixSecureViewRequest
): Promise<unknown> {
    switch (request.type) {
        case "bootstrap":
            return await secureViewBootstrap(event, state);
        case "navigate": {
            const route = validateSecureViewRoute(request.route);
            state.route = route;
            sendSecureViewEvent(state, { type: "route", route });
            publishShellNavigation(route);
            return;
        }
        case "refresh":
            return await refreshConvergenceSnapshot(event, state);
        case "login":
            await login(event, request.login);
            return await refreshConvergenceSnapshot(event, state, false);
        case "register":
            await register(event, request.registration);
            return await refreshConvergenceSnapshot(event, state, false);
        case "logout": {
            await logout(event);
            await refreshConvergenceSnapshot(event, state, false);
            return;
        }
        case "publicRooms":
            return await publicRooms(event);
        case "joinRoom": return await runPrivateRoomInviteMutation(event, state, () =>
            joinRoom(event, request.roomId, secureViewExpectedUserId(state)));
        case "joinRoomAddress": return await runPrivateRoomInviteMutation(event, state, () =>
            joinRoomAddress(event, request.address, secureViewExpectedUserId(state)));
        case "acceptInvite": return await runPrivateRoomInviteMutation(event, state, () =>
            acceptInvite(event, request.roomId, secureViewExpectedUserId(state)));
        case "rejectInvite": return await runPrivateRoomInviteMutation(event, state, () =>
            rejectInvite(event, request.roomId, secureViewExpectedUserId(state)));
        case "suggestedSpaceChannelPlan": return await suggestedSpaceChannelPlan(
            event, request.spaceId, secureViewExpectedUserId(state)
        );
        case "joinSuggestedSpaceChannels": return await runPrivateRoomInviteMutation(event, state, () =>
            joinSuggestedSpaceChannels(event, request.request, secureViewExpectedUserId(state)));
        case "leaveRoom": return await runPrivateRoomInviteMutation(event, state, () =>
            leaveRoom(event, request.roomId, secureViewExpectedUserId(state)));
        case "createSpace": return await runPrivateCreateMutation(event, state, () =>
            createSpace(event, request.request, secureViewExpectedUserId(state)));
        case "searchGroupChatCandidates":
            return await searchGroupChatCandidates(event, request.request, secureViewExpectedUserId(state));
        case "searchGroupChatInviteCandidates":
            return await searchGroupChatInviteCandidates(event, request.request, secureViewExpectedUserId(state));
        case "inviteUserToGroupChat": return await runPrivateRoomInviteMutation(event, state, () =>
            inviteUserToGroupChat(event, request.request, secureViewExpectedUserId(state)));
        case "reconcileGroupChatInvite": {
            const result = await reconcileGroupChatInvite(
                event,
                request.roomId,
                secureViewExpectedUserId(state)
            );
            if (result.status === "resolved") await bestEffortMutationRefresh(event, state);
            return result;
        }
        case "acknowledgeGroupChatInvite":
            return await acknowledgeGroupChatInvite(event, request.request, secureViewExpectedUserId(state));
        case "overrideGroupChatInviteAmbiguity":
            return await overrideGroupChatInviteAmbiguity(event, request.request, secureViewExpectedUserId(state));
        case "createGroupChat": return await runPrivateCreateMutation(event, state, () =>
            createGroupChat(event, request.request, secureViewExpectedUserId(state)));
        case "reconcileGroupChatCreate": {
            const result = await reconcileGroupChatCreate(event, secureViewExpectedUserId(state));
            if (result.status === "resolved") await bestEffortMutationRefresh(event, state);
            return result;
        }
        case "acknowledgeGroupChatCreate":
            return await acknowledgeGroupChatCreate(
                event,
                request.roomId,
                secureViewExpectedUserId(state)
            );
        case "getSpaceAccess":
            return await getSpaceAccess(event, request.spaceId, secureViewExpectedUserId(state));
        case "configureSpaceAccess": {
            return await runPrivateAccessMutation(event, state, () => configureSpaceAccess(
                event, request.request, secureViewExpectedUserId(state)
            ));
        }
        case "requestSpaceAccess": return await runPrivateAccessMutation(event, state, () =>
            requestSpaceAccess(event, request.joinName, secureViewExpectedUserId(state))
        );
        case "getSpaceAccessRequests":
            return await getSpaceAccessRequests(event, request.spaceId, secureViewExpectedUserId(state));
        case "resolveSpaceAccessRequest": {
            return await runPrivateAccessMutation(event, state, () => resolveSpaceAccessRequest(
                event, request.request, secureViewExpectedUserId(state)
            ));
        }
        case "createSpaceChild": return await runPrivateCreateMutation(event, state, () =>
            createSpaceChild(event, request.request, secureViewExpectedUserId(state)));
        case "reconcileSpaceChildCreate": {
            const result = await reconcileSpaceChildCreate(
                event,
                request.parentSpaceId,
                secureViewExpectedUserId(state)
            );
            if (result.resolved) await bestEffortMutationRefresh(event, state);
            return result;
        }
        case "repairSpaceChildLink": {
            const result = await repairSpaceChildLink(
                event,
                request.parentSpaceId,
                request.childRoomId,
                secureViewExpectedUserId(state)
            );
            await bestEffortMutationRefresh(event, state);
            return result;
        }
        case "spaceChildren":
            return await spaceChildren(event, request.spaceId, request.limit, request.maxDepth);
        case "openDirectMessage": {
            const result = await openDirectMessage(event, request.spaceId, request.userId);
            await bestEffortMutationRefresh(event, state);
            return result;
        }
        case "paginate":
            return await paginate(event, request.roomId, request.limit, request.fromEventId, request.cursor);
        case "messageContext":
            return await messageContext(event, request.roomId, request.eventId);
        case "searchMessages":
            return await searchMessages(event, request.request);
        case "sendText":
            return await sendText(event, request.roomId, request.body, request.replyEventId);
        case "sendAttachment":
            return await sendAttachment(event, request.roomId, request.attachment);
        case "sendSticker":
            return await sendSticker(event, request.roomId, request.sticker);
        case "edit":
            return await edit(event, request.roomId, request.eventId, request.body);
        case "cancelPending":
            return await cancelPending(event, request.roomId, request.transactionId);
        case "redact":
            return await redact(event, request.roomId, request.eventId, request.reason);
        case "react":
            return await react(event, request.roomId, request.eventId, request.key, request.remove);
        case "typing":
            return await typing(event, request.roomId, request.isTyping, request.timeoutMs);
        case "read":
            return await read(event, request.roomId, request.eventId);
        case "downloadMedia":
            return await downloadMedia(event, request.roomId, request.eventId, request.attachmentIndex);
        case "saveMedia": {
            requireSecureViewUserGesture(state);
            const media = await downloadMedia(event, request.roomId, request.eventId, request.attachmentIndex);
            try {
                const selection = await dialog.showSaveDialog(state.owner, {
                    title: "Save Matrix attachment",
                    defaultPath: join(app.getPath("downloads"), safeSaveDialogName(media.name)),
                    properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"]
                });
                if (selection.canceled || !selection.filePath || state.destroyed) return { saved: false };
                // The native save dialog is the authority for an explicitly
                // confirmed overwrite; page JavaScript never supplies a path.
                await writeFile(selection.filePath, media.bytes, { flag: "w", mode: 0o600 });
                return { saved: true };
            } finally {
                media.bytes.fill(0);
            }
        }
        case "urlPreview":
            return await urlPreview(event, request.roomId, request.eventId);
        case "openExternal":
            requireSecureViewUserGesture(state);
            await shell.openExternal(validateExternalUrl(request.url), { activate: true });
            return;
    }
}

async function handleAuthorizedPrivateRequest(
    event: IpcMainInvokeEvent,
    state: SecureViewState,
    request: MatrixSecureViewRequest
): Promise<unknown> {
    if (request.type === "bootstrap" || request.type === "navigate") {
        return await handlePrivateRequest(event, state, request);
    }
    if (request.type === "login" || request.type === "register") {
        return await runPrivateIdentityTransition(async () => {
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
            await requireStoredSignedOutView(state);
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
            return await handlePrivateRequest(event, state, request);
        });
    }
    if (request.type === "logout") {
        return await runPrivateIdentityTransition(async () => {
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
            await requireStoredSecureViewAccount(state);
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
            return await handlePrivateRequest(event, state, request);
        });
    }

    const release = beginPrivateAccountRequest(state);
    try {
        return await privateAccountRequestContext.run(true, async () => {
            await requireStoredSecureViewAccount(state);
            if (secureViewStateForSender(event, state.generation) !== state) {
                throw bridgeError("MATRIX_SECURE_VIEW_UNTRUSTED", "The secure Matrix view request was rejected.");
            }
            return await handlePrivateRequest(event, state, request);
        });
    } finally {
        release();
    }
}

ipcMain.on(MATRIX_SECURE_VIEW_BOOTSTRAP, event => {
    // The sandbox preload can run before senderFrame or the target URL is
    // available, so authenticate its immutable WebContents identity here and
    // reject a subframe whenever Electron supplies one. All later IPC still
    // requires the exact top frame, committed secure origin, and generation.
    const state = secureViewsByContentsId.get(event.sender.id);
    if (state) state.preloadBootstrapRequested = true;
    const frame = event.senderFrame;
    let reply: string | null = null;
    if (state && !state.destroyed && state.view.webContents === event.sender
        && !event.sender.isDestroyed() && (!frame || frame === event.sender.mainFrame)
        && !state.owner.isDestroyed() && !state.ownerContents.isDestroyed()) {
        state.preloadBootstrapGranted = true;
        reply = state.generation;
    }
    // Assign once: setting returnValue immediately releases sendSync in the
    // sandbox preload, so an earlier fallback assignment cannot be replaced.
    event.returnValue = reply;
});

ipcMain.on(MATRIX_SECURE_VIEW_READY, (event, generation: unknown) => {
    const candidate = secureViewsByContentsId.get(event.sender.id);
    if (candidate) candidate.readySignalReceived = true;
    let state: SecureViewState;
    try {
        state = secureViewStateForSender(event, generation);
    } catch {
        if (candidate) candidate.readySignalRejected = true;
        return;
    }
    if (state.ready) return;
    state.readySignalRejected = false;
    state.ready = true;
    sendSecureViewEvent(state, { type: "route", route: state.route });
    sendSecureViewEvent(state, { type: "visibility", visible: state.presented });
});

ipcMain.handle(MATRIX_SECURE_VIEW_REQUEST, async (event, envelopeValue: unknown) => {
    const envelope = exactObjectKeys(
        envelopeValue,
        "secure view envelope",
        ["generation", "request"]
    ) as unknown as MatrixSecureViewRequestEnvelope;
    const state = secureViewStateForSender(event, envelope.generation);
    const request = validatePrivateRequest(envelope.request);
    try {
        return await handleAuthorizedPrivateRequest(event, state, request);
    } finally {
        clearPrivateRequest(request);
    }
});

async function runShellBoundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch {
        throw bridgeError("MATRIX_SHELL_UNAVAILABLE", "The Matrix navigation shell is unavailable.");
    }
}

async function rendererRecoverySnapshot(event: IpcMainInvokeEvent): Promise<MatrixSnapshot> {
    return await runSnapshotCut(() => commitAccountConsistentRead(
        () => snapshot(event),
        snapshotMatchesAccountBinding,
        value => value,
        undefined,
        true
    ));
}

/**
 * Full renderer event stream used by the Discord-native presentation mode.
 * The bounded queue never exposes worker tokens or credentials. If a renderer
 * falls behind, it receives an exact-cut snapshot and can replay every queued
 * event whose sequence is newer than that cut.
 */
export async function nextEvent(
    event: IpcMainInvokeEvent,
    afterSeq = 0
): Promise<MatrixBridgeEvent | null> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > sequence) {
        throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix event cursor is invalid.");
    }

    if (afterSeq < rendererEventsDroppedThroughSeq) {
        const recovery = await rendererRecoverySnapshot(event);
        return { seq: recovery.seq, type: "snapshot", snapshot: recovery };
    }
    const queued = rendererEventQueue.find(item => item.seq > afterSeq);
    if (queued) return queued;

    return await new Promise<MatrixBridgeEvent | null>(resolve => {
        const waiter: RendererEventWaiter = {
            afterSeq,
            resolve,
            timer: setTimeout(() => settleRendererEventWaiter(waiter, null), LONG_POLL_MS),
            sender: event.sender,
            onDestroyed: () => settleRendererEventWaiter(waiter, null)
        };
        rendererEventWaiters.add(waiter);
        event.sender.once("destroyed", waiter.onDestroyed);
    });
}

export async function shellStart(event: IpcMainInvokeEvent): Promise<MatrixShellSnapshot> {
    return await runShellBoundary(async () => {
        secureViewOwner(event);
        await start(event);
        const startedSnapshot = await stableShellSnapshot(event);
        return cloneShellSnapshot(startedSnapshot);
    });
}

export async function shellSnapshot(event: IpcMainInvokeEvent): Promise<MatrixShellSnapshot> {
    return await runShellBoundary(async () => {
        secureViewOwner(event);
        if (!latestShellSnapshot || shellSnapshotDirty) {
            return cloneShellSnapshot(await stableShellSnapshot(event));
        }
        return cloneShellSnapshot(latestShellSnapshot);
    });
}

export async function shellNextEvent(event: IpcMainInvokeEvent, afterSeq = 0): Promise<MatrixShellEvent | null> {
    return await runShellBoundary(async () => {
        secureViewOwner(event);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
            throw bridgeError("MATRIX_INVALID_ARGUMENT", "The Matrix shell cursor is invalid.");
        }

        const queued = shellEventQueue.find(item => item.seq > afterSeq);
        const missedEvents = afterSeq !== 0
            && (queued ? queued.seq > afterSeq + 1 : afterSeq < sequence);
        if (missedEvents) {
            const recovery = !latestShellSnapshot || shellSnapshotDirty
                ? await stableShellSnapshot(event)
                : cloneShellSnapshot(latestShellSnapshot);
            const state = secureViewsByOwnerId.get(event.sender.id);
            if (state && !state.destroyed) {
                // A metadata snapshot cannot reconstruct a missed navigation
                // event. Re-emit the current route after the truthful snapshot
                // cut so the outer channel highlight can converge too.
                enqueueShellEvent({ seq: ++sequence, type: "navigate", route: state.route });
            }
            return { seq: recovery.seq, type: "snapshot", snapshot: recovery };
        }
        if (queued) return queued;

        return await new Promise<MatrixShellEvent | null>(resolve => {
            const waiter: ShellEventWaiter = {
                afterSeq,
                resolve,
                timer: setTimeout(() => settleShellEventWaiter(waiter, null), LONG_POLL_MS),
                sender: event.sender,
                onDestroyed: () => settleShellEventWaiter(waiter, null)
            };
            shellEventWaiters.add(waiter);
            event.sender.once("destroyed", waiter.onDestroyed);
        });
    });
}

export async function shellSuspend(event: IpcMainInvokeEvent): Promise<void> {
    return await runShellBoundary(async () => {
        secureViewOwner(event);
        try {
            await suspend(event);
        } finally {
            disposeAllSecureViews();
        }
    });
}

export async function secureViewShow(
    event: IpcMainInvokeEvent,
    input: MatrixSecureViewShowRequest
): Promise<MatrixSecureViewControlState> {
    const showRequest = exactObjectKeys(input, "secure view show request", ["route", "bounds"]);
    const route = validateSecureViewRoute(showRequest.route);
    const bounds = validateSecureViewBounds(showRequest.bounds);
    const owner = secureViewOwner(event);
    let state = secureViewsByOwnerId.get(owner.webContents.id);
    if (!state || state.destroyed) {
        state = await createSecureView(owner, route, bounds);
    } else {
        state.route = route;
        state.requestedBounds = bounds;
    }
    state.visible = true;
    syncSecureViewPresentation(state);
    requireSecureViewPresentation(state);
    sendSecureViewEvent(state, { type: "route", route });
    return await secureViewControlState(state);
}

export async function secureViewSetRoute(
    event: IpcMainInvokeEvent,
    routeValue: MatrixSecureViewRoute
): Promise<MatrixSecureViewControlState> {
    const state = secureViewForOwner(event)!;
    requireSecureViewPresentation(state);
    const route = validateSecureViewRoute(routeValue);
    state.route = route;
    sendSecureViewEvent(state, { type: "route", route });
    return await secureViewControlState(state);
}

export async function secureViewUpdateBounds(
    event: IpcMainInvokeEvent,
    boundsValue: MatrixSecureViewBounds
): Promise<MatrixSecureViewControlState> {
    const state = secureViewForOwner(event)!;
    requireSecureViewPresentation(state);
    state.requestedBounds = validateSecureViewBounds(boundsValue);
    if (!layoutSecureView(state)) {
        disposeSecureViewState(state);
        throw bridgeError("MATRIX_SECURE_VIEW_FAILED", "The secure Matrix view could not be positioned safely.");
    }
    return await secureViewControlState(state);
}

export async function secureViewHide(event: IpcMainInvokeEvent): Promise<MatrixSecureViewControlState> {
    const state = secureViewForOwner(event, false);
    if (!state) return await secureViewControlState();
    state.visible = false;
    syncSecureViewPresentation(state);
    if (!state.ownerContents.isDestroyed()) state.ownerContents.focus();
    return await secureViewControlState(state);
}

export async function secureViewFocus(event: IpcMainInvokeEvent): Promise<MatrixSecureViewControlState> {
    const state = secureViewForOwner(event)!;
    requireSecureViewPresentation(state);
    if (state.visible && state.presented && !state.view.isDestroyed()
        && (state.owner.isFocused() || state.view.isFocused())) {
        state.view.focus();
    }
    return await secureViewControlState(state);
}

export async function secureViewCommand(
    event: IpcMainInvokeEvent,
    commandValue: MatrixSecureViewShellCommand
): Promise<MatrixSecureViewControlState> {
    const state = secureViewForOwner(event)!;
    requireSecureViewPresentation(state);
    const command = validateSecureViewShellCommand(commandValue);
    sendSecureViewEvent(state, { type: "shellCommand", command });
    return await secureViewControlState(state);
}

export async function secureViewDispose(event: IpcMainInvokeEvent): Promise<void> {
    const state = secureViewForOwner(event, false);
    if (state) disposeSecureViewState(state);
}

// Discord-native mode deliberately receives normalized Matrix DTOs while the
// access token, crypto stores, SDK client, and homeserver pagination tokens
// remain confined to main/worker processes. Strict isolated-view mode keeps
// using the shell*/secureView* exports above.
export {
    acceptInvite,
    acknowledgeGroupChatCreate,
    acknowledgeGroupChatInvite,
    cancelPending,
    configureSpaceAccess,
    createGroupChat,
    createSpace,
    createSpaceChild,
    downloadMedia,
    edit,
    getConfig,
    getSpaceAccess,
    getSpaceAccessRequests,
    getStatus,
    inviteUserToGroupChat,
    inviteUserToSpace,
    joinRoom,
    joinRoomAddress,
    joinSuggestedSpaceChannels,
    leaveRoom,
    login,
    logout,
    messageContext,
    openDirectMessage,
    overrideGroupChatInviteAmbiguity,
    paginate,
    publicRooms,
    react,
    read,
    reauthenticate,
    reconcileGroupChatCreate,
    reconcileGroupChatInvite,
    reconcileSpaceChildCreate,
    redact,
    register,
    rejectInvite,
    repairSpaceChildLink,
    requestSpaceAccess,
    resolveSpaceAccessRequest,
    searchGroupChatCandidates,
    searchGroupChatInviteCandidates,
    searchMessages,
    searchSpaceInviteCandidates,
    sendAttachment,
    sendSticker,
    sendText,
    snapshot,
    spaceChildren,
    start,
    suggestedSpaceChannelPlan,
    suspend,
    typing,
    urlPreview
};
