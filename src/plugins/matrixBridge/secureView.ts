/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    MatrixSecureViewAccountConfig,
    MatrixSecureViewBootstrap,
    MatrixSecureViewEvent,
    MatrixSecureViewRoute,
    MatrixSecureViewSecurityState,
} from "./secureViewProtocol";
import type {
    MatrixAttachmentDTO,
    MatrixBridgeEvent,
    MatrixBridgeStatus,
    MatrixConfigureSpaceAccessResult,
    MatrixHistoryPageDTO,
    MatrixMessageDTO,
    MatrixMessageSearchResultDTO,
    MatrixPublicRoomDirectoryDTO,
    MatrixReactionDTO,
    MatrixRequestSpaceAccessResult,
    MatrixRoomDTO,
    MatrixSnapshot,
    MatrixSpaceAccessMode,
    MatrixSpaceAccessRequestListDTO,
    MatrixSpaceAccessSummaryDTO,
    MatrixSpaceHierarchyDTO,
    MatrixUrlPreviewDTO,
} from "./types";

type Child = Node | string | number | false | null | undefined;
type Overlay = "createSpace" | "directMessage" | "search" | null;
type AuthMode = "login" | "register" | "token";
type MediaState = "loading" | "ready" | "error";
type MediaTombstone = "error" | "evicted" | "deferred";

interface MediaEntry {
    state: MediaState;
    objectUrl?: string;
    mimeType?: string;
    name?: string;
    byteLength: number;
    touched: number;
}

interface HistoryState {
    messages: MatrixMessageDTO[];
    cursor?: string;
    end: boolean;
    loading: boolean;
}

interface TimelineWindow {
    start: number;
    end: number;
    /** Message count represented when this window was last reconciled. */
    total: number;
}

interface ToastMessage {
    id: number;
    text: string;
    tone: "error" | "success" | "info";
}

interface IsolatedContext {
    anchorEventId: string;
    messages: MatrixMessageDTO[];
}

interface AccountTransition {
    generation: number;
    kind: "login" | "register" | "logout" | "external";
}

interface AuthFormState {
    homeserver: string;
    username: string;
    password: string;
    confirmPassword: string;
    registrationToken: string;
    accessToken: string;
}

interface CreateSpaceFormState {
    name: string;
    topic: string;
    visibility: "private" | "public";
    createGeneral: boolean;
}

interface SpaceAccessDraft {
    mode: MatrixSpaceAccessMode;
    joinName: string;
}

interface PendingUploadItem {
    file: File;
    txnId: string;
}

interface PendingUploadBatch {
    items: PendingUploadItem[];
    caption?: string;
    replyEventId?: string;
}

const MAX_MEDIA_ENTRIES = 64;
const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_AUTO_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_AUTO_MEDIA_REQUESTS = 16;
const MAX_AUTO_PREVIEW_REQUESTS = 32;
const MAX_AUTO_HISTORY_PAGES = 4;
const MAX_MESSAGE_DOM = 180;
const MAX_COMPACT_MESSAGE_GAP_MS = 7 * 60 * 1_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 100 * 1024 * 1024;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;
const URL_PATTERN = /https?:\/\/[^\s<>]+/iu;
const JOIN_NAME_MAX_LENGTH = 64;
const JOIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const host = window.MatrixSecureViewHost;
function requireRoot() {
    const result = document.getElementById("matrix-secure-view-root");
    if (!result) throw new Error("The Matrix secure-view root is missing.");
    return result;
}

const root = requireRoot();

let bootstrap: MatrixSecureViewBootstrap | undefined;
let snapshot: MatrixSnapshot | undefined;
let config: MatrixSecureViewAccountConfig | undefined;
let status: MatrixBridgeStatus | undefined;
let security: MatrixSecureViewSecurityState | undefined;
let hostRoute: MatrixSecureViewRoute = { kind: "home" };
let localRoute: MatrixSecureViewRoute | undefined;
let overlay: Overlay = null;
let authMode: AuthMode = "login";
let authBusy = false;
let settingsPage: "discover" | "account" = "account";
let fatalMessage: string | undefined;
let loadingLabel = "Opening the isolated Matrix view...";
let visible = true;
let highlightedEventId: string | undefined;
let directory: MatrixPublicRoomDirectoryDTO | undefined;
let directoryLoading = false;
let directoryQuery = "";
let hierarchyLoading: string | undefined;
let searchLoading = false;
let searchQuery = "";
let searchResults: MatrixMessageSearchResultDTO[] = [];
let searchCursor: string | undefined;
let searchStatus = "";
let searchScopeIdentity: string | undefined;
let activeMediaJobs = 0;
let mediaBytes = 0;
let mediaGeneration = 0;
let autoMediaBytes = 0;
let autoMediaRequests = 0;
let autoPreviewRequests = 0;
let uiGeneration = 0;
let searchGeneration = 0;
let toastCounter = 0;
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let typingStoppedTimer: ReturnType<typeof setTimeout> | undefined;
let renderQueued = false;
let lastTimelineRoomId: string | undefined;
let spaceCreationBlocked = false;
let spaceCreationInFlight = false;
let joinAddressBusy = false;
let joinNameBusy = false;
let directMessageBusy = false;
let joinAddressValue = "";
let joinNameValue = "";
let joinNameError = "";
let directMessageSpaceId = "";
let directMessageUserId = "";
let accountTransition: AccountTransition | undefined;
let accountRecoveryInFlight = false;
let accountRecoveryPending = false;
let fatalRecoveryBusy = false;
let lastAppliedMatrixSeq = -1;
let lastAppliedStatusSeq = -1;
let bufferedMatrixEventBytes = 0;
let matrixEventBufferOverflow = false;

const authForm: AuthFormState = {
    homeserver: "",
    username: "",
    password: "",
    confirmPassword: "",
    registrationToken: "",
    accessToken: "",
};
const createSpaceForm: CreateSpaceFormState = {
    name: "",
    topic: "",
    visibility: "private",
    createGeneral: true,
};

const histories = new Map<string, HistoryState>();
const historyAutoLoadsByRoom = new Map<string, number>();
const isolatedContexts = new Map<string, IsolatedContext>();
const timelineWindows = new Map<string, TimelineWindow>();
const timelineAtBottomByRoom = new Map<string, boolean>();
const renderedReceiptTargetByRoom = new Map<string, string>();
const hierarchies = new Map<string, MatrixSpaceHierarchyDTO>();
const spaceAccess = new Map<string, MatrixSpaceAccessSummaryDTO>();
const spaceAccessConfirmed = new Map<string, boolean>();
const spaceAccessDrafts = new Map<string, SpaceAccessDraft>();
const spaceAccessRequests = new Map<string, MatrixSpaceAccessRequestListDTO>();
const expandedSpaceAccess = new Set<string>();
const spaceAccessErrors = new Map<string, string>();
let spaceAccessLoading: string | undefined;
let spaceAccessAction: string | undefined;
const typingByRoom = new Map<string, string[]>();
const replyByRoom = new Map<string, MatrixMessageDTO>();
const editByRoom = new Map<string, MatrixMessageDTO>();
const composerDrafts = new Map<string, string>();
const sendBusyRooms = new Set<string>();
const uploadBusyRooms = new Set<string>();
const pendingUploadsByRoom = new Map<string, PendingUploadBatch>();
const mediaCache = new Map<string, MediaEntry>();
const mediaTombstones = new Map<string, MediaTombstone>();
const mediaElements = new Map<string, HTMLImageElement | HTMLMediaElement>();
const previewDeferred = new Set<string>();
const viewportTasks = new Map<string, () => void>();
const viewportElements = new Map<string, Element>();
let viewportKeys = new WeakMap<Element, string>();
let viewportObserver: IntersectionObserver | undefined;
const bufferedMatrixEvents: MatrixBridgeEvent[] = [];
const previewCache = new Map<string, MatrixUrlPreviewDTO | null>();
const previewLoading = new Set<string>();
const pendingMedia = new Set<string>();
const redactedEvents = new Set<string>();
const lastReadRequestedByRoom = new Map<string, string>();
const toasts: ToastMessage[] = [];

function appendChildren(parent: ParentNode, children: Child[]) {
    for (const child of children.flat(Infinity) as Child[]) {
        if (child == null || child === false) continue;
        parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

function element<Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    className?: string,
    ...children: Child[]
): HTMLElementTagNameMap[Tag] {
    const result = document.createElement(tag);
    if (className) result.className = className;
    appendChildren(result, children);
    return result;
}

function textElement<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text: string) {
    const result = element(tag, className);
    result.textContent = text;
    return result;
}

function makeButton(
    label: string,
    className: string,
    onClick: () => void,
    options: { ariaLabel?: string; disabled?: boolean; current?: boolean; title?: string; } = {}
) {
    const result = textElement("button", className, label);
    result.type = "button";
    result.disabled = Boolean(options.disabled);
    if (options.ariaLabel) result.setAttribute("aria-label", options.ariaLabel);
    if (options.title) result.title = options.title;
    if (options.current) result.setAttribute("aria-current", "page");
    result.addEventListener("click", onClick);
    return result;
}

function labelledField(label: string, control: HTMLElement) {
    const field = element("label", "matrix-field");
    field.append(textElement("span", "matrix-field-label", label), control);
    return field;
}

function input(type: string, name: string, placeholder: string, value = "") {
    const result = element("input", "matrix-input");
    result.type = type;
    result.name = name;
    result.placeholder = placeholder;
    result.value = value;
    result.autocomplete = "off";
    return result;
}

function errorText(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    return "The Matrix operation failed.";
}

function cleanJoinName(value: string) {
    return value.trim().toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH);
}

function validJoinName(value: string) {
    return JOIN_NAME_PATTERN.test(value);
}

function accountServerName() {
    const userId = config?.userId;
    if (!userId) return undefined;
    const separator = userId.indexOf(":");
    return separator > 0 && separator < userId.length - 1 ? userId.slice(separator + 1) : undefined;
}

function isCurrentSecureAccount(expectedUserId: string) {
    return config?.userId === expectedUserId && snapshot?.account?.userId === expectedUserId;
}

function joinNameFromAlias(alias: string | undefined) {
    if (!alias?.startsWith("#")) return undefined;
    const separator = alias.indexOf(":");
    if (separator < 2 || separator === alias.length - 1) return undefined;
    const serverName = accountServerName();
    if (serverName && alias.slice(separator + 1) !== serverName) return undefined;
    const joinName = alias.slice(1, separator);
    return validJoinName(joinName) ? joinName : undefined;
}

function accessModeLabel(mode: MatrixSpaceAccessMode) {
    switch (mode) {
        case "public": return "Public and listed";
        case "request": return "Unlisted; requests require approval";
        case "invite": return "Unlisted; invitation only";
    }
}

function simplifiedAccessModeLabel(mode: MatrixSpaceAccessMode) {
    switch (mode) {
        case "public": return "Public access";
        case "request": return "Request approval";
        case "invite": return "Invitation only";
    }
}

function safeRequesterDisplayName(value: string | undefined) {
    return value?.replace(BIDI_FORMATTING_CONTROL_PATTERN, "").trim() || undefined;
}

function visibleRequesterUserId(value: string) {
    return value.replace(BIDI_FORMATTING_CONTROL_PATTERN, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function actualAccessLabel(access: MatrixSpaceAccessSummaryDTO) {
    const listed = access.directoryVisibility === "public" ? "listed" : "unlisted";
    const admission = access.joinRule === "public"
        ? "open to everyone"
        : access.joinRule === "knock"
            ? "requests require approval"
            : access.joinRule === "restricted"
                ? "restricted by linked-server membership"
                : access.joinRule === "knock_restricted"
                    ? "linked-server members can join; others can request approval"
                    : "invitation only";
    return `${listed}; ${admission}`;
}

function accessConfirmationText(result: MatrixConfigureSpaceAccessResult) {
    const access = actualAccessLabel(result.access);
    return result.accessConfirmed
        ? `Current access is ${access}.`
        : `Could not verify current access. Last confirmed state: ${access}.`;
}

function accessResultText(result: MatrixRequestSpaceAccessResult) {
    switch (result.membership) {
        case "knock": return "Your access request is pending approval.";
        case "invite": return "Access was approved. Accept the server invitation from Home.";
        case "join": return "You already have access to this server.";
    }
}

function errorCode(error: unknown) {
    if (!error || typeof error !== "object") return "";
    const candidate = error as { code?: unknown; name?: unknown; message?: unknown; };
    for (const value of [candidate.code, candidate.name]) {
        if (typeof value === "string" && /^(?:MATRIX_|M_|ORG[._])[A-Z0-9._]+$/u.test(value)) return value;
    }
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return message.match(/(?:^|:\s)((?:MATRIX_|M_|ORG[._])[A-Z0-9._]+)(?=:)/u)?.[1] ?? "";
}

function statusText(value = status) {
    if (!value) return "Starting";
    switch (value.state) {
        case "ready": return "Connected";
        case "syncing": return "Syncing";
        case "starting": return "Starting";
        case "stopped": return "Stopped";
        case "logged_out": return "Signed out";
        case "error": return value.error?.message || "Connection error";
    }
}

function serverLabel(value: string | undefined) {
    if (!value) return "Matrix homeserver";
    try {
        return new URL(value).hostname;
    } catch {
        return "Matrix homeserver";
    }
}

function normalizeHomeserver(value: string) {
    const clean = value.trim();
    return /^https?:\/\//iu.test(clean) ? clean : `https://${clean}`;
}

function route() {
    return localRoute ?? hostRoute;
}

function joinedRooms() {
    return (snapshot?.rooms ?? []).filter(room => room.membership === "join");
}

function invitedRooms() {
    return (snapshot?.rooms ?? []).filter(room => room.membership === "invite");
}

function roomById(roomId: string | undefined) {
    return roomId ? snapshot?.rooms.find(room => room.roomId === roomId) : undefined;
}

function roomName(room: Pick<MatrixRoomDTO, "name" | "roomId"> | undefined) {
    return room?.name?.trim() || room?.roomId || "Matrix";
}

function isSpace(room: Pick<MatrixRoomDTO, "kind" | "roomType">) {
    return room.kind === "space" || room.roomType === "m.space";
}

function isDirect(room: Pick<MatrixRoomDTO, "kind" | "directUserId">) {
    return room.kind === "dm" || Boolean(room.directUserId);
}

function selectedRoom() {
    const current = route();
    return "roomId" in current ? roomById(current.roomId) : undefined;
}

function initials(value: string) {
    const clean = value.trim();
    if (!clean) return "?";
    const pieces = clean.split(/\s+/u).slice(0, 2);
    return pieces.map(piece => [...piece][0]?.toLocaleUpperCase() ?? "").join("").slice(0, 2) || "?";
}

function authorName(message: MatrixMessageDTO) {
    return message.senderId === snapshot?.account?.userId
        ? "You"
        : message.senderName?.trim() || message.senderId;
}

function formatTime(timestamp: number) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
            month: "short",
            day: "numeric",
        }).format(new Date(timestamp));
    } catch {
        return "";
    }
}

function formatBytes(size: number | undefined) {
    if (!size || size < 1) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function showToast(text: string, tone: ToastMessage["tone"] = "info") {
    const message: ToastMessage = { id: ++toastCounter, text, tone };
    toasts.push(message);
    if (toasts.length > 4) toasts.shift();
    scheduleRender();
    setTimeout(() => {
        const index = toasts.findIndex(toast => toast.id === message.id);
        if (index !== -1) {
            toasts.splice(index, 1);
            scheduleRender();
        }
    }, 4_500);
}

function clearMedia() {
    mediaGeneration++;
    for (const entry of mediaCache.values()) {
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
    for (const media of mediaElements.values()) {
        media.removeAttribute("src");
        if (media instanceof HTMLMediaElement) media.load();
    }
    mediaCache.clear();
    mediaTombstones.clear();
    mediaElements.clear();
    previewDeferred.clear();
    viewportObserver?.disconnect();
    viewportObserver = undefined;
    viewportTasks.clear();
    viewportElements.clear();
    viewportKeys = new WeakMap();
    previewCache.clear();
    previewLoading.clear();
    pendingMedia.clear();
    mediaBytes = 0;
    autoMediaBytes = 0;
    autoMediaRequests = 0;
    autoPreviewRequests = 0;
}

function clearSensitiveUiState() {
    uiGeneration++;
    searchGeneration++;
    if (typingTimer) clearTimeout(typingTimer);
    if (typingStoppedTimer) clearTimeout(typingStoppedTimer);
    typingTimer = undefined;
    typingStoppedTimer = undefined;
    clearMedia();
    histories.clear();
    historyAutoLoadsByRoom.clear();
    isolatedContexts.clear();
    timelineWindows.clear();
    timelineAtBottomByRoom.clear();
    renderedReceiptTargetByRoom.clear();
    hierarchies.clear();
    spaceAccess.clear();
    spaceAccessConfirmed.clear();
    spaceAccessDrafts.clear();
    spaceAccessRequests.clear();
    expandedSpaceAccess.clear();
    spaceAccessErrors.clear();
    spaceAccessLoading = undefined;
    spaceAccessAction = undefined;
    typingByRoom.clear();
    replyByRoom.clear();
    editByRoom.clear();
    composerDrafts.clear();
    sendBusyRooms.clear();
    uploadBusyRooms.clear();
    pendingUploadsByRoom.clear();
    redactedEvents.clear();
    lastReadRequestedByRoom.clear();
    directory = undefined;
    directoryQuery = "";
    directoryLoading = false;
    hierarchyLoading = undefined;
    searchLoading = false;
    searchResults = [];
    searchCursor = undefined;
    searchQuery = "";
    searchScopeIdentity = undefined;
    overlay = null;
    highlightedEventId = undefined;
    lastTimelineRoomId = undefined;
    toasts.splice(0);
    spaceCreationBlocked = false;
    spaceCreationInFlight = false;
    joinAddressBusy = false;
    joinNameBusy = false;
    directMessageBusy = false;
    joinAddressValue = "";
    joinNameValue = "";
    joinNameError = "";
    directMessageSpaceId = "";
    directMessageUserId = "";
    authBusy = false;
    fatalRecoveryBusy = false;
    Object.assign(authForm, {
        homeserver: "",
        username: "",
        password: "",
        confirmPassword: "",
        registrationToken: "",
        accessToken: "",
    });
    Object.assign(createSpaceForm, {
        name: "",
        topic: "",
        visibility: "private" as const,
        createGeneral: true,
    });
}

function searchScopeForRoute(value: MatrixSecureViewRoute) {
    if (value.kind === "space") return `space\0${value.roomId}`;
    if (value.kind === "room" || value.kind === "dm") return `room\0${value.roomId}`;
    return "all";
}

function invalidateSearch() {
    searchGeneration++;
    searchLoading = false;
    searchResults = [];
    searchCursor = undefined;
    searchStatus = "";
    searchScopeIdentity = undefined;
}

function setRoute(next: MatrixSecureViewRoute, local = true) {
    const previousRoute = route();
    const previousRoomId = "roomId" in previousRoute ? previousRoute.roomId : undefined;
    if (local) localRoute = next;
    else {
        hostRoute = next;
        localRoute = undefined;
    }
    const nextRoomId = "roomId" in next ? next.roomId : undefined;
    if (searchScopeForRoute(previousRoute) !== searchScopeForRoute(next)) invalidateSearch();
    if (next.kind !== "settings") {
        joinNameValue = "";
        joinNameError = "";
        joinAddressValue = "";
    }
    if (nextRoomId !== previousRoomId) {
        clearMedia();
        lastTimelineRoomId = undefined;
        highlightedEventId = undefined;
        void stopTyping(previousRoomId);
        if (previousRoomId) {
            spaceAccessDrafts.delete(previousRoomId);
            expandedSpaceAccess.delete(previousRoomId);
            spaceAccessErrors.delete(previousRoomId);
        }
        if (nextRoomId) {
            isolatedContexts.delete(nextRoomId);
            timelineWindows.delete(nextRoomId);
            timelineAtBottomByRoom.set(nextRoomId, true);
            renderedReceiptTargetByRoom.delete(nextRoomId);
            historyAutoLoadsByRoom.delete(nextRoomId);
        }
    }
    if (next.kind === "space") void loadHierarchy(next.roomId);
    if (local && host) {
        void host.request({ type: "navigate", route: next }).catch(error => {
            showToast(`Could not update Matrix navigation: ${errorText(error)}`, "error");
        });
    }
    scheduleRender();
}

function updateRoom(roomId: string, update: (room: MatrixRoomDTO) => MatrixRoomDTO) {
    if (!snapshot) return;
    snapshot = {
        ...snapshot,
        rooms: snapshot.rooms.map(room => room.roomId === roomId ? update(room) : room),
    };
}

function updateCachedMessage(
    roomId: string,
    eventId: string,
    update: (message: MatrixMessageDTO) => MatrixMessageDTO | undefined
) {
    const history = histories.get(roomId);
    if (history) {
        history.messages = history.messages.flatMap(message => {
            if (message.eventId !== eventId) return [message];
            const next = update(message);
            return next ? [next] : [];
        });
    }
    const context = isolatedContexts.get(roomId);
    if (context) {
        context.messages = context.messages.flatMap(message => {
            if (message.eventId !== eventId) return [message];
            const next = update(message);
            return next ? [next] : [];
        });
    }
}

function messageIndex(messages: MatrixMessageDTO[], target: MatrixMessageDTO) {
    const eventIndex = messages.findIndex(message => message.eventId === target.eventId);
    if (eventIndex !== -1 || !target.transactionId) return eventIndex;
    return messages.findIndex(message => message.transactionId === target.transactionId
        && message.senderId === target.senderId);
}

/**
 * Snapshot message arrays are bounded windows, not complete timelines. Merge a
 * newer window into the retained canonical order using shared event/transaction
 * IDs as anchors; never infer Matrix order from timestamps.
 */
function mergeMessageWindows(retained: MatrixMessageDTO[], incoming: MatrixMessageDTO[]) {
    if (!incoming.length) return retained;
    const merged = [...retained];
    for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex++) {
        const message = incoming[incomingIndex];
        redactedEvents.delete(message.eventId);
        const existingIndex = messageIndex(merged, message);
        if (existingIndex !== -1) {
            merged[existingIndex] = message;
            continue;
        }

        let insertionIndex = -1;
        for (let nextIndex = incomingIndex + 1; nextIndex < incoming.length; nextIndex++) {
            insertionIndex = messageIndex(merged, incoming[nextIndex]);
            if (insertionIndex !== -1) break;
        }
        if (insertionIndex === -1) {
            for (let previousIndex = incomingIndex - 1; previousIndex >= 0; previousIndex--) {
                const anchorIndex = messageIndex(merged, incoming[previousIndex]);
                if (anchorIndex !== -1) {
                    insertionIndex = anchorIndex + 1;
                    break;
                }
            }
        }
        merged.splice(insertionIndex === -1 ? merged.length : insertionIndex, 0, message);
    }
    return merged;
}

function reconcileRoomWindow(previous: MatrixRoomDTO | undefined, next: MatrixRoomDTO) {
    if (!previous) return next;
    if (previous.timelineGeneration === next.timelineGeneration) {
        return { ...next, messages: mergeMessageWindows(previous.messages, next.messages) };
    }

    // A generation change is an authoritative remote timeline reset. Keep only
    // cancellable/retryable local echoes; the new SDK window replaces all other
    // retained remote rows.
    const localEchoes = previous.messages.filter(message => message.pending || message.failed);
    return { ...next, messages: mergeMessageWindows(next.messages, localEchoes) };
}

function replaceMessage(room: MatrixRoomDTO, message: MatrixMessageDTO) {
    const next = [...room.messages];
    redactedEvents.delete(message.eventId);
    const index = messageIndex(next, message);
    if (index === -1) next.push(message);
    else next[index] = message;
    return { ...room, messages: next };
}

function discardResetRoomState(roomId: string) {
    histories.delete(roomId);
    historyAutoLoadsByRoom.delete(roomId);
    isolatedContexts.delete(roomId);
    timelineWindows.delete(roomId);
    timelineAtBottomByRoom.delete(roomId);
    renderedReceiptTargetByRoom.delete(roomId);
    typingByRoom.delete(roomId);
    replyByRoom.delete(roomId);
    editByRoom.delete(roomId);
    // Redaction IDs do not carry a room prefix. A generation reset is rare;
    // clear this bounded set rather than risk hiding an event in the new cut.
    redactedEvents.clear();
    const current = route();
    if ("roomId" in current && current.roomId === roomId) clearMedia();
}

function validateSnapshotIdentity(next: MatrixSnapshot, expectedAccount?: string | null) {
    const accountId = next.account?.userId;
    const statusAccountId = next.status.account?.userId;
    if (statusAccountId && statusAccountId !== accountId) {
        throw new Error("The Matrix snapshot contains conflicting account identities.");
    }
    if (!accountId && next.rooms.length) {
        throw new Error("The signed-out Matrix snapshot contains room data.");
    }
    if (accountId && next.status.state === "logged_out") {
        throw new Error("The Matrix snapshot has a conflicting signed-out status.");
    }
    if (expectedAccount !== undefined && accountId !== (expectedAccount ?? undefined)) {
        throw new Error("The Matrix snapshot belongs to a different account.");
    }
    return accountId;
}

function validateBootstrap(next: MatrixSecureViewBootstrap, expectedAccount?: string | null) {
    const accountId = validateSnapshotIdentity(next.snapshot, expectedAccount);
    if (next.snapshot.status.seq !== next.snapshot.seq || next.status.seq < next.snapshot.seq) {
        throw new Error("The Matrix bootstrap has inconsistent event watermarks.");
    }
    const { configured } = next.config;
    if (configured !== Boolean(accountId)) {
        throw new Error("The Matrix bootstrap has inconsistent account configuration.");
    }
    if (configured && (!next.config.userId || next.config.userId !== accountId)) {
        throw new Error("The Matrix bootstrap configuration belongs to a different account.");
    }
    if (!configured && (next.config.userId || next.snapshot.rooms.length)) {
        throw new Error("The signed-out Matrix bootstrap contains account data.");
    }
    for (const statusValue of [next.status, next.snapshot.status]) {
        if (statusValue.account && statusValue.account.userId !== accountId) {
            throw new Error("The Matrix bootstrap status belongs to a different account.");
        }
        if (accountId && statusValue.state === "logged_out") {
            throw new Error("The Matrix bootstrap has a conflicting signed-out status.");
        }
    }
    return accountId;
}

function failClosed(message = "The isolated Matrix account boundary could not be verified.") {
    clearSensitiveUiState();
    bufferedMatrixEvents.length = 0;
    bufferedMatrixEventBytes = 0;
    matrixEventBufferOverflow = false;
    lastAppliedMatrixSeq = -1;
    lastAppliedStatusSeq = -1;
    bootstrap = undefined;
    snapshot = undefined;
    config = undefined;
    status = undefined;
    accountTransition = undefined;
    accountRecoveryInFlight = false;
    accountRecoveryPending = false;
    loadingLabel = "";
    fatalMessage = message;
    scheduleRender();
}

function beginAccountTransition(kind: AccountTransition["kind"], label: string) {
    clearSensitiveUiState();
    bufferedMatrixEvents.length = 0;
    bufferedMatrixEventBytes = 0;
    matrixEventBufferOverflow = false;
    lastAppliedMatrixSeq = -1;
    lastAppliedStatusSeq = -1;
    bootstrap = undefined;
    snapshot = undefined;
    config = undefined;
    status = undefined;
    localRoute = undefined;
    hostRoute = { kind: "home" };
    fatalMessage = undefined;
    loadingLabel = label;
    accountTransition = { generation: uiGeneration, kind };
    scheduleRender();
    return accountTransition;
}

function isCurrentAccountTransition(value: AccountTransition) {
    return accountTransition === value && value.generation === uiGeneration;
}

function applySnapshot(next: MatrixSnapshot, expectedAccount = config?.configured ? config.userId ?? null : null) {
    validateSnapshotIdentity(next, expectedAccount);
    const previousRooms = new Map((snapshot?.rooms ?? []).map(room => [room.roomId, room]));
    const rooms = next.rooms.map(room => {
        const previous = previousRooms.get(room.roomId);
        if (previous && previous.timelineGeneration !== room.timelineGeneration) {
            discardResetRoomState(room.roomId);
        }
        return reconcileRoomWindow(previous, room);
    });
    snapshot = { ...next, rooms };
    if (next.status.seq > lastAppliedStatusSeq) {
        status = next.status;
        lastAppliedStatusSeq = next.status.seq;
    }
    if (bootstrap) bootstrap = { ...bootstrap, snapshot, status: status ?? next.status };
}

function applyMatrixEvent(event: MatrixBridgeEvent) {
    switch (event.type) {
        case "snapshot":
            applySnapshot(event.snapshot);
            break;
        case "room": {
            if (!snapshot) break;
            const previousRoom = snapshot.rooms.find(room => room.roomId === event.room.roomId);
            if (previousRoom && previousRoom.timelineGeneration !== event.room.timelineGeneration) {
                discardResetRoomState(event.room.roomId);
            }
            const nextRoom = reconcileRoomWindow(previousRoom, event.room);
            snapshot = {
                ...snapshot,
                rooms: snapshot.rooms.some(room => room.roomId === event.room.roomId)
                    ? snapshot.rooms.map(room => room.roomId === event.room.roomId ? nextRoom : room)
                    : [...snapshot.rooms, nextRoom],
            };
            break;
        }
        case "message":
            updateRoom(event.roomId, room => replaceMessage(room, event.message));
            break;
        case "edit":
            if (event.message) {
                updateRoom(event.roomId, room => replaceMessage(room, event.message!));
                updateCachedMessage(event.roomId, event.eventId, () => event.message);
            }
            break;
        case "redact":
            redactedEvents.add(event.eventId);
            updateCachedMessage(event.roomId, event.eventId, () => undefined);
            updateRoom(event.roomId, room => ({
                ...room,
                messages: room.messages.filter(message => message.eventId !== event.eventId),
            }));
            break;
        case "reaction":
            updateCachedMessage(event.roomId, event.eventId, message => ({ ...message, reactions: event.reactions }));
            updateRoom(event.roomId, room => ({
                ...room,
                messages: room.messages.map(message => message.eventId === event.eventId
                    ? { ...message, reactions: event.reactions }
                    : message),
            }));
            break;
        case "typing":
            typingByRoom.set(event.roomId, event.userIds.filter(userId => userId !== snapshot?.account?.userId));
            break;
        case "status":
            status = event.status;
            break;
        case "receipt":
            break;
    }
    scheduleRender();
}

function applySequencedMatrixEvent(event: MatrixBridgeEvent) {
    if (event.type === "status") {
        if (event.status.seq <= lastAppliedStatusSeq) return;
    } else if (event.type === "snapshot"
        ? event.snapshot.seq < lastAppliedMatrixSeq
        : event.seq <= lastAppliedMatrixSeq) return;
    const expectedAccount = config?.configured ? config.userId : undefined;
    if (event.type === "status") {
        const eventAccount = event.status.account?.userId;
        if ((event.status.state === "logged_out" && config?.configured)
            || (eventAccount && eventAccount !== expectedAccount)) {
            void recoverAccountBoundary();
            return;
        }
    } else if (event.type === "snapshot") {
        if (event.snapshot.seq < lastAppliedMatrixSeq) return;
        try {
            validateSnapshotIdentity(event.snapshot, expectedAccount ?? null);
        } catch {
            void recoverAccountBoundary();
            return;
        }
    }
    try {
        applyMatrixEvent(event);
        if (event.type === "status") {
            lastAppliedStatusSeq = event.status.seq;
        } else {
            lastAppliedMatrixSeq = Math.max(lastAppliedMatrixSeq, event.seq);
        }
    } catch {
        void recoverAccountBoundary();
    }
}

function receiveMatrixEvent(event: MatrixBridgeEvent) {
    if (!bootstrap || accountTransition) {
        if (matrixEventBufferOverflow) return;
        let estimatedBytes = 0;
        try {
            estimatedBytes = JSON.stringify(event).length * 2;
        } catch {
            matrixEventBufferOverflow = true;
            bufferedMatrixEvents.length = 0;
            bufferedMatrixEventBytes = 0;
            return;
        }
        if (bufferedMatrixEvents.length >= 256 || bufferedMatrixEventBytes + estimatedBytes > 4 * 1024 * 1024) {
            matrixEventBufferOverflow = true;
            bufferedMatrixEvents.length = 0;
            bufferedMatrixEventBytes = 0;
            return;
        }
        bufferedMatrixEvents.push(event);
        bufferedMatrixEventBytes += estimatedBytes;
        return;
    }
    applySequencedMatrixEvent(event);
}

function applyBootstrap(next: MatrixSecureViewBootstrap, expectedAccount?: string | null) {
    if (matrixEventBufferOverflow) {
        throw new Error("The Matrix event replay buffer overflowed before bootstrap completed.");
    }
    const accountId = validateBootstrap(next, expectedAccount);
    const previousAccount = config
        ? config.configured ? config.userId ?? null : null
        : undefined;
    const nextAccount = accountId ?? null;
    const sameKnownAccount = previousAccount !== undefined && previousAccount === nextAccount;
    const preserveNewerCut = Boolean(bootstrap && !accountTransition && sameKnownAccount
        && next.snapshot.seq < lastAppliedMatrixSeq);
    if (previousAccount !== undefined && previousAccount !== nextAccount) {
        clearSensitiveUiState();
        lastAppliedMatrixSeq = -1;
        lastAppliedStatusSeq = -1;
    }
    config = next.config;
    security = next.security;
    hostRoute = next.route;
    localRoute = undefined;
    fatalMessage = undefined;
    fatalRecoveryBusy = false;
    loadingLabel = "";
    if (!preserveNewerCut) {
        applySnapshot(next.snapshot, nextAccount);
        lastAppliedMatrixSeq = next.snapshot.seq;
    }
    if (next.status.seq > lastAppliedStatusSeq) {
        status = next.status;
        lastAppliedStatusSeq = next.status.seq;
    }
    bootstrap = {
        ...next,
        snapshot: snapshot ?? next.snapshot,
        status: status ?? next.status,
    };
    const replay = bufferedMatrixEvents
        .filter(event => event.type === "status"
            ? event.status.seq > lastAppliedStatusSeq
            : event.type === "snapshot"
                ? event.snapshot.seq >= lastAppliedMatrixSeq
                : event.seq > lastAppliedMatrixSeq)
        .sort((left, right) => left.seq - right.seq);
    bufferedMatrixEvents.length = 0;
    bufferedMatrixEventBytes = 0;
    matrixEventBufferOverflow = false;
    accountTransition = undefined;
    for (const event of replay) receiveMatrixEvent(event);
    scheduleRender();
}

async function requestTransitionBootstrap(
    transition: AccountTransition,
    expectedAccount?: string | null,
    retryOverflow = true,
) {
    if (!host) throw new Error("The isolated Matrix host is unavailable.");
    for (let attempt = 0; attempt < (retryOverflow ? 2 : 1); attempt++) {
        if (attempt) {
            bufferedMatrixEvents.length = 0;
            bufferedMatrixEventBytes = 0;
            matrixEventBufferOverflow = false;
        }
        const next = await host.request({ type: "bootstrap" });
        if (!isCurrentAccountTransition(transition)) return false;
        try {
            applyBootstrap(next, expectedAccount);
            return true;
        } catch (error) {
            if (!matrixEventBufferOverflow || attempt > 0) throw error;
        }
    }
    return false;
}

async function recoverAccountBoundary() {
    if (!host) return;
    if (accountRecoveryInFlight) {
        accountRecoveryPending = true;
        return;
    }
    const transition = beginAccountTransition("external", "Verifying the Matrix account...");
    accountRecoveryInFlight = true;
    try {
        await requestTransitionBootstrap(transition);
    } catch {
        if (accountTransition === transition) failClosed();
    } finally {
        accountRecoveryInFlight = false;
        if (accountRecoveryPending) {
            accountRecoveryPending = false;
            void recoverAccountBoundary();
        }
    }
}

function enterRecoverableFatal(message: string) {
    loadingLabel = "";
    fatalMessage = message;
    scheduleRender();
}

async function retrySecureConnection() {
    if (!host || fatalRecoveryBusy) return;
    const generation = uiGeneration;
    const expectedAccount = config
        ? config.configured ? config.userId ?? null : null
        : undefined;
    fatalRecoveryBusy = true;
    loadingLabel = "Reconnecting to the isolated view...";
    scheduleRender();

    let next: MatrixSecureViewBootstrap;
    try {
        next = await host.request({ type: "bootstrap" });
    } catch (error) {
        if (generation === uiGeneration) {
            enterRecoverableFatal(`The private Matrix backend did not answer: ${errorText(error)}`);
        }
        return;
    } finally {
        if (generation === uiGeneration) fatalRecoveryBusy = false;
    }
    if (generation !== uiGeneration) return;

    try {
        applyBootstrap(next, expectedAccount);
    } catch {
        // A malformed or cross-account bootstrap is not a transient transport
        // failure. Clear decrypted state before offering another explicit retry.
        failClosed();
    }
}

function handleHostEvent(event: MatrixSecureViewEvent) {
    switch (event.type) {
        case "bootstrap":
            if (accountTransition) break;
            try {
                applyBootstrap(event.bootstrap);
            } catch {
                failClosed();
            }
            break;
        case "matrix":
            receiveMatrixEvent(event.event);
            break;
        case "route":
            setRoute(event.route, false);
            break;
        case "visibility":
            visible = event.visible;
            document.body.toggleAttribute("data-matrix-hidden", !visible);
            if (!visible) {
                const current = route();
                void stopTyping("roomId" in current ? current.roomId : undefined);
            } else {
                setTimeout(() => markLatestRead());
            }
            scheduleRender();
            break;
        case "shellCommand":
            if (event.command.type === "openSearch") openSearch();
            break;
        case "security":
            security = event.security;
            scheduleRender();
            break;
        case "fatal":
            enterRecoverableFatal(event.message || "The isolated Matrix view stopped unexpectedly.");
            break;
    }
}

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
        renderQueued = false;
        render();
    });
}

function mergedMessages(room: MatrixRoomDTO) {
    const ordered: MatrixMessageDTO[] = [];
    const positions = new Map<string, number>();
    for (const message of [...(histories.get(room.roomId)?.messages ?? []), ...room.messages]) {
        const position = positions.get(message.eventId);
        if (position == null) {
            positions.set(message.eventId, ordered.length);
            ordered.push(message);
        } else {
            ordered[position] = message;
        }
    }
    return ordered.filter(message => !redactedEvents.has(message.eventId));
}

function mergeHistory(roomId: string, messages: MatrixMessageDTO[], page?: MatrixHistoryPageDTO) {
    const previous = histories.get(roomId);
    const ordered: MatrixMessageDTO[] = [];
    const positions = new Map<string, number>();
    // Pagination and event context both arrive in authoritative chronological
    // order and precede the current live window. Never infer order from clocks.
    for (const message of [...messages, ...(previous?.messages ?? [])]) {
        const position = positions.get(message.eventId);
        if (position == null) {
            positions.set(message.eventId, ordered.length);
            ordered.push(message);
        }
    }
    histories.set(roomId, {
        messages: ordered,
        cursor: page?.beforeCursor ?? previous?.cursor,
        end: page?.end ?? previous?.end ?? false,
        loading: false,
    });
}

async function refresh(allowSpaceRetry = false, announce = true, reportErrors = true) {
    if (!host) return false;
    const generation = uiGeneration;
    const expectedAccount = config?.configured ? config.userId ?? null : null;
    try {
        loadingLabel = "Refreshing Matrix...";
        scheduleRender();
        const next = await host.request({ type: "refresh" });
        if (generation !== uiGeneration || accountTransition) return false;
        validateSnapshotIdentity(next, expectedAccount);
        // A delta delivered while refresh was in flight is newer than this
        // snapshot cut. Never replace it with the older response.
        if (next.seq >= lastAppliedMatrixSeq) {
            applySnapshot(next, expectedAccount);
            lastAppliedMatrixSeq = next.seq;
        }
        if (allowSpaceRetry) spaceCreationBlocked = false;
        if (announce) showToast("Matrix is up to date.", "success");
        return true;
    } catch (error) {
        if (generation === uiGeneration) {
            if (errorText(error).includes("different account") || errorText(error).includes("conflicting account")) {
                void recoverAccountBoundary();
            } else if (reportErrors) {
                showToast(errorText(error), "error");
            }
        }
        return false;
    } finally {
        if (generation === uiGeneration) loadingLabel = "";
        scheduleRender();
    }
}

async function loadHierarchy(spaceId: string) {
    if (!host || hierarchies.has(spaceId) || hierarchyLoading === spaceId) return;
    const generation = uiGeneration;
    hierarchyLoading = spaceId;
    scheduleRender();
    try {
        const result = await host.request({ type: "spaceChildren", spaceId, limit: 200, maxDepth: 8 });
        if (generation !== uiGeneration) return;
        hierarchies.set(spaceId, result);
    } catch (error) {
        if (generation === uiGeneration) showToast(`Could not load this server: ${errorText(error)}`, "error");
    } finally {
        if (generation === uiGeneration && hierarchyLoading === spaceId) hierarchyLoading = undefined;
        scheduleRender();
    }
}

async function loadDirectory() {
    if (!host || directoryLoading) return;
    const generation = uiGeneration;
    directoryLoading = true;
    scheduleRender();
    try {
        const result = await host.request({ type: "publicRooms" });
        if (generation !== uiGeneration) return;
        directory = result;
    } catch (error) {
        if (generation === uiGeneration) showToast(`Directory refresh failed: ${errorText(error)}`, "error");
    } finally {
        if (generation === uiGeneration) directoryLoading = false;
        scheduleRender();
    }
}

async function requestServerAccess(joinName: string, inlineError = true) {
    const normalized = cleanJoinName(joinName);
    if (!validJoinName(normalized)) {
        const message = "Use 1-64 lowercase letters or numbers. Dots, underscores, and hyphens may appear between them.";
        if (inlineError) {
            joinNameError = message;
            scheduleRender();
        } else showToast(message, "error");
        return;
    }
    const expectedUserId = config?.userId;
    if (!host || !expectedUserId || joinNameBusy) return;
    const generation = uiGeneration;
    joinNameBusy = true;
    joinNameError = "";
    scheduleRender();
    try {
        const result = await host.request({ type: "requestSpaceAccess", joinName: normalized });
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        joinNameValue = "";
        joinNameError = "";
        showToast(accessResultText(result), "success");
        if (result.membership === "invite" || result.membership === "join") {
            const refreshed = await refresh(false, false, false);
            if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
            if (!refreshed) {
                showToast("The access request succeeded, but the server list could not be refreshed yet.", "info");
                return;
            }
        }
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        if (result.membership === "join") {
            const joined = roomById(result.roomId);
            if (joined?.membership === "join") {
                setRoute({ kind: isSpace(joined) ? "space" : "room", roomId: result.roomId });
            }
        }
    } catch (error) {
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        if (errorCode(error) === "MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS") {
            joinNameValue = "";
            joinNameError = "";
            showToast(`The access request may have succeeded, but its response could not be confirmed: ${errorText(error)}`, "info");
            const refreshed = await refresh(false, false, false);
            if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId) && !refreshed) {
                showToast("The access request may have succeeded, but the server list could not be refreshed yet.", "info");
            }
            return;
        }
        if (inlineError) joinNameError = errorText(error);
        else showToast(errorText(error), "error");
    } finally {
        if (generation === uiGeneration) joinNameBusy = false;
        scheduleRender();
    }
}

async function loadSpaceAccess(space: MatrixRoomDTO, force = false) {
    const expectedUserId = config?.userId;
    if (!host || !expectedUserId || spaceAccessLoading === space.roomId || !force && spaceAccess.has(space.roomId)) return;
    const generation = uiGeneration;
    spaceAccessLoading = space.roomId;
    spaceAccessErrors.delete(space.roomId);
    scheduleRender();
    try {
        const access = await host.request({ type: "getSpaceAccess", spaceId: space.roomId });
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        spaceAccess.set(space.roomId, access);
        spaceAccessConfirmed.set(space.roomId, true);
        spaceAccessDrafts.set(space.roomId, { mode: access.mode, joinName: access.joinName ?? "" });
        if (space.canApproveAccessRequests || space.canDenyAccessRequests) {
            try {
                const requests = await host.request({ type: "getSpaceAccessRequests", spaceId: space.roomId });
                if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
                    spaceAccessRequests.set(space.roomId, requests);
                }
            } catch (error) {
                if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
                    spaceAccessErrors.set(space.roomId, `Could not load access requests: ${errorText(error)}`);
                }
            }
        }
    } catch (error) {
        if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
            spaceAccessErrors.set(space.roomId, errorText(error));
        }
    } finally {
        if (generation === uiGeneration && spaceAccessLoading === space.roomId) spaceAccessLoading = undefined;
        scheduleRender();
    }
}

function toggleSpaceAccess(space: MatrixRoomDTO) {
    if (expandedSpaceAccess.delete(space.roomId)) {
        spaceAccessDrafts.delete(space.roomId);
        spaceAccessErrors.delete(space.roomId);
        scheduleRender();
        return;
    }
    expandedSpaceAccess.add(space.roomId);
    void loadSpaceAccess(space, true);
    scheduleRender();
}

function applySpaceAccessResult(result: MatrixConfigureSpaceAccessResult) {
    spaceAccess.set(result.spaceId, result.access);
    spaceAccessConfirmed.set(result.spaceId, result.accessConfirmed);
    spaceAccessDrafts.set(result.spaceId, {
        mode: result.access.mode,
        joinName: result.access.joinName ?? "",
    });
    const confirmation = accessConfirmationText(result);
    if (result.complete) showToast(`Access settings saved. ${confirmation}`, "success");
    else showToast(`Access settings were only partly applied. ${result.partial?.message ?? "Review the settings."} ${confirmation}`, "info");
}

async function saveSpaceAccess(spaceId: string) {
    const draft = spaceAccessDrafts.get(spaceId);
    const expectedUserId = config?.userId;
    if (!host || !expectedUserId || !draft || spaceAccessAction) return;
    const normalizedJoinName = cleanJoinName(draft.joinName);
    if (draft.mode === "request" && !validJoinName(normalizedJoinName)) {
        spaceAccessErrors.set(
            spaceId,
            "Request approval needs a unique join name using 1-64 lowercase letters or numbers. Dots, underscores, and hyphens may appear between them."
        );
        scheduleRender();
        return;
    }
    const generation = uiGeneration;
    spaceAccessAction = `save:${spaceId}`;
    spaceAccessErrors.delete(spaceId);
    scheduleRender();
    try {
        const result = await host.request({
            type: "configureSpaceAccess",
            request: {
                spaceId,
                mode: draft.mode,
                ...(draft.mode === "request" ? { joinName: normalizedJoinName } : {}),
            },
        });
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        applySpaceAccessResult(result);
        const refreshed = await refresh(false, false, false);
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        if (!refreshed) {
            showToast(`${result.complete ? "Access settings were saved" : "Access settings were partly applied"}, but the server list could not be refreshed yet. ${accessConfirmationText(result)}`, "info");
        }
    } catch (error) {
        if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
            if (errorCode(error) === "MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS") {
                let refreshedAccess: MatrixSpaceAccessSummaryDTO | undefined;
                try {
                    const access = await host.request({ type: "getSpaceAccess", spaceId });
                    if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
                    refreshedAccess = access;
                    spaceAccess.set(spaceId, access);
                    spaceAccessConfirmed.set(spaceId, true);
                    spaceAccessDrafts.set(spaceId, {
                        mode: access.mode,
                        joinName: access.joinName ?? ""
                    });
                } catch {
                    spaceAccessConfirmed.set(spaceId, false);
                }
                await refresh(false, false, false);
                if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
                showToast(refreshedAccess
                    ? `The save response could not be confirmed. Current access was refreshed: ${actualAccessLabel(refreshedAccess)}.`
                    : "Access settings may have changed, but current access could not be verified. Refresh before saving again.", "info");
            } else {
                spaceAccessErrors.set(spaceId, errorText(error));
            }
        }
    } finally {
        if (generation === uiGeneration && spaceAccessAction === `save:${spaceId}`) spaceAccessAction = undefined;
        scheduleRender();
    }
}

async function resolveSpaceAccessRequest(spaceId: string, userId: string, decision: "approve" | "deny") {
    const expectedUserId = config?.userId;
    if (!host || !expectedUserId || spaceAccessAction) return;
    const generation = uiGeneration;
    const action = `${decision}:${spaceId}:${userId}`;
    spaceAccessAction = action;
    spaceAccessErrors.delete(spaceId);
    scheduleRender();
    try {
        const result = await host.request({
            type: "resolveSpaceAccessRequest",
            request: { spaceId, userId, decision },
        });
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        const existing = spaceAccessRequests.get(spaceId);
        if (existing) {
            spaceAccessRequests.set(spaceId, {
                ...existing,
                requests: existing.requests.filter(request => request.userId !== userId),
            });
        }
        const approved = result.membership === "invite" || result.membership === "join";
        showToast(approved
            ? result.membership === "join"
                ? "Access approved. The requester has joined the server."
                : "Access approved. The server invitation is ready."
            : "Access request denied.", "success");
        const refreshed = await refresh(false, false, false);
        if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
        let requestsRefreshed = false;
        try {
            const requests = await host.request({ type: "getSpaceAccessRequests", spaceId });
            if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
                spaceAccessRequests.set(spaceId, requests);
                requestsRefreshed = true;
            }
        } catch {
            // The mutation result remains authoritative; the next open/refresh retries the list.
        }
        if (!refreshed || !requestsRefreshed) {
            showToast(approved
                ? "Access was approved, but the server or request list could not be refreshed yet."
                : "Access was denied, but the server or request list could not be refreshed yet.", "info");
        }
    } catch (error) {
        if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
            if (errorCode(error) === "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS") {
                showToast(`This access decision may have succeeded, but its response could not be confirmed: ${errorText(error)}`, "info");
                const refreshed = await refresh(false, false, false);
                if (generation !== uiGeneration || !isCurrentSecureAccount(expectedUserId)) return;
                let requestsRefreshed = false;
                try {
                    const requests = await host.request({ type: "getSpaceAccessRequests", spaceId });
                    if (generation === uiGeneration && isCurrentSecureAccount(expectedUserId)) {
                        spaceAccessRequests.set(spaceId, requests);
                        requestsRefreshed = true;
                    }
                } catch {
                    // Keep the may-have-succeeded notice; reopening retries this list.
                }
                if (!refreshed || !requestsRefreshed) {
                    showToast("This access decision may have succeeded, but the server or request list could not be refreshed yet.", "info");
                }
            } else {
                spaceAccessErrors.set(spaceId, errorText(error));
            }
        }
    } finally {
        if (generation === uiGeneration && spaceAccessAction === action) spaceAccessAction = undefined;
        scheduleRender();
    }
}

async function joinRoom(roomId: string) {
    if (!host) return;
    const generation = uiGeneration;
    try {
        const result = await host.request({ type: "joinRoom", roomId });
        if (generation !== uiGeneration) return;
        await refresh();
        if (generation !== uiGeneration) return;
        const joined = roomById(result.roomId);
        setRoute({ kind: joined && isSpace(joined) ? "space" : "room", roomId: result.roomId });
        showToast("Joined on Matrix.", "success");
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function joinAddress(address: string) {
    if (!host || !address.trim() || joinAddressBusy) return;
    const generation = uiGeneration;
    joinAddressBusy = true;
    scheduleRender();
    try {
        const result = await host.request({ type: "joinRoomAddress", address: address.trim() });
        if (generation !== uiGeneration) return;
        await refresh();
        if (generation !== uiGeneration) return;
        const joined = roomById(result.roomId);
        setRoute({ kind: joined && isSpace(joined) ? "space" : "room", roomId: result.roomId });
        joinAddressValue = "";
        showToast("Joined on Matrix.", "success");
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    } finally {
        if (generation === uiGeneration) joinAddressBusy = false;
        scheduleRender();
    }
}

async function acceptInvite(roomId: string) {
    if (!host) return;
    const generation = uiGeneration;
    try {
        await host.request({ type: "acceptInvite", roomId });
        if (generation !== uiGeneration) return;
        await refresh();
        if (generation !== uiGeneration) return;
        const room = roomById(roomId);
        setRoute({ kind: room && isSpace(room) ? "space" : room && isDirect(room) ? "dm" : "room", roomId });
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function rejectInvite(roomId: string) {
    if (!host) return;
    const generation = uiGeneration;
    try {
        await host.request({ type: "rejectInvite", roomId });
        if (generation !== uiGeneration) return;
        await refresh();
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function leaveRoom(room: MatrixRoomDTO) {
    if (!host || !window.confirm(`Leave ${roomName(room)}?`)) return;
    const generation = uiGeneration;
    try {
        await host.request({ type: "leaveRoom", roomId: room.roomId });
        if (generation !== uiGeneration) return;
        setRoute({ kind: "home" });
        await refresh();
        if (generation === uiGeneration) showToast("Left the Matrix room.", "success");
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function loadOlder(room: MatrixRoomDTO, timeline: HTMLElement, automatic = false) {
    if (!host) return;
    const generation = uiGeneration;
    const { timelineGeneration } = room;
    const current = histories.get(room.roomId) ?? { messages: [], end: false, loading: false };
    if (current.loading || current.end) return;
    if (automatic) {
        const autoLoads = historyAutoLoadsByRoom.get(room.roomId) ?? 0;
        if (autoLoads >= MAX_AUTO_HISTORY_PAGES) return;
        historyAutoLoadsByRoom.set(room.roomId, autoLoads + 1);
    } else {
        historyAutoLoadsByRoom.delete(room.roomId);
    }
    current.loading = true;
    histories.set(room.roomId, current);
    const previousHeight = timeline.scrollHeight;
    const previousTop = timeline.scrollTop;
    scheduleRender();
    try {
        const earliest = mergedMessages(room)[0];
        const page = await host.request({
            type: "paginate",
            roomId: room.roomId,
            limit: 50,
            ...(current.cursor ? { cursor: current.cursor } : earliest ? { fromEventId: earliest.eventId } : {}),
        });
        if (generation !== uiGeneration
            || roomById(room.roomId)?.timelineGeneration !== timelineGeneration) {
            showToast("Room history changed while loading. Scroll up to retry.", "info");
            return;
        }
        if (!page.end && !page.progressed && !page.messages.length) {
            throw new Error("Matrix history did not advance. Retry loading older messages.");
        }
        mergeHistory(room.roomId, page.messages, page);
        const messages = mergedMessages(room);
        const end = Math.min(messages.length, MAX_MESSAGE_DOM);
        timelineWindows.set(room.roomId, { start: 0, end, total: messages.length });
        render();
        const nextTimeline = root.querySelector<HTMLElement>(".matrix-timeline");
        if (nextTimeline) nextTimeline.scrollTop = Math.max(0, nextTimeline.scrollHeight - previousHeight + previousTop);
    } catch (error) {
        const sameTimeline = generation === uiGeneration
            && roomById(room.roomId)?.timelineGeneration === timelineGeneration;
        if (sameTimeline) {
            current.loading = false;
            histories.set(room.roomId, current);
        }
        if (sameTimeline) {
            const stale = errorCode(error) === "MATRIX_STALE_CURSOR"
                || errorText(error).includes("MATRIX_STALE_CURSOR");
            if (stale) {
                current.cursor = undefined;
                current.end = false;
            }
            showToast(stale
                ? "The history cursor expired. Retry from the retained timeline."
                : `Could not load older messages: ${errorText(error)}`, stale ? "info" : "error");
        }
    } finally {
        const updated = generation === uiGeneration
            && roomById(room.roomId)?.timelineGeneration === timelineGeneration
            ? histories.get(room.roomId)
            : undefined;
        if (updated) updated.loading = false;
        scheduleRender();
    }
}

function mediaKey(roomId: string, eventId: string, attachmentIndex: number, kind = "attachment") {
    return `${kind}\0${roomId}\0${eventId}\0${attachmentIndex}`;
}

function armViewportTask(key: string, target: Element, task: () => void) {
    if (!viewportObserver) {
        viewportObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const entryKey = viewportKeys.get(entry.target);
                if (!entryKey || viewportElements.get(entryKey) !== entry.target) continue;
                viewportObserver?.unobserve(entry.target);
                viewportElements.delete(entryKey);
                const run = viewportTasks.get(entryKey);
                viewportTasks.delete(entryKey);
                run?.();
            }
        }, { rootMargin: "240px 0px" });
    }
    const previous = viewportElements.get(key);
    if (previous) viewportObserver.unobserve(previous);
    viewportTasks.set(key, task);
    viewportElements.set(key, target);
    viewportKeys.set(target, key);
    viewportObserver.observe(target);
}

function disarmViewportTask(key: string) {
    const target = viewportElements.get(key);
    if (target) viewportObserver?.unobserve(target);
    viewportElements.delete(key);
    viewportTasks.delete(key);
}

function setMediaTombstone(key: string, reason: MediaTombstone) {
    mediaTombstones.delete(key);
    mediaTombstones.set(key, reason);
    while (mediaTombstones.size > 1_024) {
        mediaTombstones.delete(mediaTombstones.keys().next().value!);
    }
}

function releaseMediaElement(key: string) {
    const media = mediaElements.get(key);
    if (!media) return;
    media.removeAttribute("src");
    if (media instanceof HTMLMediaElement) media.load();
    mediaElements.delete(key);
}

function evictMedia() {
    const ready = [...mediaCache.entries()]
        .filter(([, entry]) => entry.state !== "loading")
        .sort((left, right) => left[1].touched - right[1].touched);
    while ((mediaCache.size > MAX_MEDIA_ENTRIES || mediaBytes > MAX_MEDIA_BYTES) && ready.length) {
        const [key, entry] = ready.shift()!;
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
        mediaBytes = Math.max(0, mediaBytes - entry.byteLength);
        mediaCache.delete(key);
        releaseMediaElement(key);
        setMediaTombstone(key, "evicted");
    }
}

function queueMedia(roomId: string, eventId: string, attachmentIndex: number, kind = "attachment", retry = false) {
    if (!host) return;
    const key = mediaKey(roomId, eventId, attachmentIndex, kind);
    disarmViewportTask(`media\0${key}`);
    if (retry) {
        const previous = mediaCache.get(key);
        if (previous?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
        mediaBytes = Math.max(0, mediaBytes - (previous?.byteLength ?? 0));
        mediaCache.delete(key);
        mediaTombstones.delete(key);
        releaseMediaElement(key);
    } else if (mediaTombstones.has(key)) {
        return;
    }
    const existing = mediaCache.get(key);
    if (existing) {
        existing.touched = Date.now();
        return;
    }
    mediaCache.set(key, { state: "loading", byteLength: 0, touched: Date.now() });
    pendingMedia.add(key);
    pumpMediaQueue();
}

function queueMediaAutomatically(
    roomId: string,
    eventId: string,
    attachmentIndex: number,
    kind: string,
    estimatedBytes: number | undefined,
) {
    const key = mediaKey(roomId, eventId, attachmentIndex, kind);
    if (mediaCache.has(key) || mediaTombstones.has(key)) return;
    const nativeCap = kind === "preview-video" ? 96 * 1024 * 1024 : MAX_UPLOAD_BYTES;
    const estimate = Math.max(nativeCap, Math.min(96 * 1024 * 1024, estimatedBytes ?? nativeCap));
    if (autoMediaRequests >= MAX_AUTO_MEDIA_REQUESTS || autoMediaBytes + estimate > MAX_AUTO_MEDIA_BYTES) {
        setMediaTombstone(key, "deferred");
        scheduleRender();
        return;
    }
    autoMediaRequests++;
    autoMediaBytes += estimate;
    queueMedia(roomId, eventId, attachmentIndex, kind);
    scheduleRender();
}

function mediaEntryForRender(key: string): MediaEntry {
    return mediaCache.get(key) ?? {
        state: mediaTombstones.has(key) ? "error" : "loading",
        byteLength: 0,
        touched: Date.now(),
    };
}

function pumpMediaQueue() {
    if (!host) return;
    while (activeMediaJobs < MEDIA_DOWNLOAD_CONCURRENCY && pendingMedia.size) {
        const key = pendingMedia.values().next().value as string;
        pendingMedia.delete(key);
        const [, roomId, eventId, indexText] = key.split("\0");
        const attachmentIndex = Number(indexText);
        const generation = mediaGeneration;
        activeMediaJobs++;
        void host.request({ type: "downloadMedia", roomId, eventId, attachmentIndex }).then(result => {
            const { bytes } = result;
            let blobBytes: Uint8Array | undefined;
            let objectUrl: string | undefined;
            try {
                const entry = generation === mediaGeneration ? mediaCache.get(key) : undefined;
                if (!entry) return;
                const blobBuffer = new ArrayBuffer(bytes.byteLength);
                blobBytes = new Uint8Array(blobBuffer);
                blobBytes.set(bytes);
                objectUrl = URL.createObjectURL(new Blob([blobBuffer], { type: result.mimeType }));
                Object.assign(entry, {
                    state: "ready" as const,
                    objectUrl,
                    mimeType: result.mimeType,
                    name: result.name,
                    byteLength: bytes.byteLength,
                    touched: Date.now(),
                });
                objectUrl = undefined;
                mediaBytes += entry.byteLength;
                evictMedia();
            } finally {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                bytes.fill(0);
                blobBytes?.fill(0);
            }
        }).catch(() => {
            const entry = generation === mediaGeneration ? mediaCache.get(key) : undefined;
            if (entry) {
                entry.state = "error";
                setMediaTombstone(key, "error");
            }
        }).finally(() => {
            activeMediaJobs--;
            scheduleRender();
            pumpMediaQueue();
        });
    }
}

function queuePreview(message: MatrixMessageDTO, force = false) {
    if (!host || previewCache.has(message.eventId) || previewLoading.has(message.eventId)) return;
    if (!URL_PATTERN.test(message.body)) return;
    if (!force && previewDeferred.has(message.eventId)) return;
    if (!force && autoPreviewRequests >= MAX_AUTO_PREVIEW_REQUESTS) {
        previewDeferred.add(message.eventId);
        scheduleRender();
        return;
    }
    if (!force) autoPreviewRequests++;
    previewDeferred.delete(message.eventId);
    disarmViewportTask(`preview\0${message.eventId}`);
    const generation = uiGeneration;
    const previewGeneration = mediaGeneration;
    previewLoading.add(message.eventId);
    scheduleRender();
    void host.request({ type: "urlPreview", roomId: message.roomId, eventId: message.eventId }).then(preview => {
        if (generation !== uiGeneration || previewGeneration !== mediaGeneration) return;
        previewCache.set(message.eventId, preview ?? null);
    }).catch(() => {
        if (generation === uiGeneration && previewGeneration === mediaGeneration) previewCache.set(message.eventId, null);
    }).finally(() => {
        if (generation === uiGeneration && previewGeneration === mediaGeneration) previewLoading.delete(message.eventId);
        scheduleRender();
    });
}

function openSearch() {
    if (!config?.configured) return;
    overlay = "search";
    scheduleRender();
    setTimeout(() => root.querySelector<HTMLInputElement>("[data-focus-key='matrix-search']")?.focus());
}

async function runSearch(loadMore = false) {
    if (!host || searchLoading || !searchQuery.trim()) return;
    const currentRoute = route();
    const scopeIdentity = searchScopeForRoute(currentRoute);
    if (loadMore && searchScopeIdentity !== scopeIdentity) return;
    searchLoading = true;
    const generation = uiGeneration;
    const requestGeneration = loadMore ? searchGeneration : ++searchGeneration;
    if (!loadMore) searchScopeIdentity = scopeIdentity;
    searchStatus = "Searching...";
    scheduleRender();
    const scope = currentRoute.kind === "space"
        ? { kind: "space" as const, spaceId: currentRoute.roomId }
        : (currentRoute.kind === "room" || currentRoute.kind === "dm")
            ? { kind: "room" as const, roomId: currentRoute.roomId }
            : { kind: "all" as const };
    try {
        const response = await host.request({
            type: "searchMessages",
            request: {
                query: searchQuery.trim(),
                scope,
                limit: 25,
                ...(loadMore && searchCursor ? { cursor: searchCursor } : {}),
            },
        });
        if (generation !== uiGeneration || requestGeneration !== searchGeneration
            || searchScopeForRoute(route()) !== scopeIdentity
            || searchScopeIdentity !== scopeIdentity) return;
        const combined = new Map((loadMore ? searchResults : []).map(result => [
            `${result.roomId}\0${result.message.eventId}`,
            result,
        ]));
        for (const result of response.results) combined.set(`${result.roomId}\0${result.message.eventId}`, result);
        searchResults = [...combined.values()];
        searchCursor = response.cursor;
        searchStatus = `${searchResults.length} result${searchResults.length === 1 ? "" : "s"} - ${response.coverage}`;
    } catch (error) {
        if (generation === uiGeneration && requestGeneration === searchGeneration
            && searchScopeForRoute(route()) === scopeIdentity) searchStatus = errorText(error);
    } finally {
        if (generation === uiGeneration && requestGeneration === searchGeneration
            && searchScopeForRoute(route()) === scopeIdentity) searchLoading = false;
        scheduleRender();
    }
}

function jumpToSearchResult(result: MatrixMessageSearchResultDTO) {
    highlightedEventId = result.message.eventId;
    const room = roomById(result.roomId);
    setRoute({ kind: room && isDirect(room) ? "dm" : "room", roomId: result.roomId });
    isolatedContexts.set(result.roomId, {
        anchorEventId: result.message.eventId,
        messages: [...result.before, result.message, ...result.after],
    });
    overlay = null;
    scheduleRender();
    setTimeout(() => {
        const target = root.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(result.message.eventId)}"]`);
        target?.scrollIntoView({ block: "center" });
        target?.focus({ preventScroll: true });
    });
}

async function stopTyping(roomId: string | undefined) {
    if (typingTimer) clearTimeout(typingTimer);
    if (typingStoppedTimer) clearTimeout(typingStoppedTimer);
    typingTimer = undefined;
    typingStoppedTimer = undefined;
    if (!host || !roomId) return;
    try {
        await host.request({ type: "typing", roomId, isTyping: false, timeoutMs: 5_000 });
    } catch { }
}

function noteTyping(roomId: string) {
    if (!host) return;
    const generation = uiGeneration;
    const accountId = config?.userId;
    if (typingTimer) clearTimeout(typingTimer);
    if (typingStoppedTimer) clearTimeout(typingStoppedTimer);
    typingTimer = setTimeout(() => {
        if (generation !== uiGeneration || accountTransition || config?.userId !== accountId) return;
        void host.request({ type: "typing", roomId, isTyping: true, timeoutMs: 15_000 }).catch(() => undefined);
    }, 350);
    typingStoppedTimer = setTimeout(() => {
        if (generation === uiGeneration && !accountTransition && config?.userId === accountId) void stopTyping(roomId);
    }, 4_000);
}

function markLatestRead(room = selectedRoom()) {
    if (!host || !room || isolatedContexts.has(room.roomId) || !visible || !document.hasFocus()) return;
    if (!timelineAtBottomByRoom.get(room.roomId)) return;
    const eventId = renderedReceiptTargetByRoom.get(room.roomId);
    if (!eventId?.startsWith("$")
        || !root.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`)
        || lastReadRequestedByRoom.get(room.roomId) === eventId) return;
    const generation = uiGeneration;
    lastReadRequestedByRoom.set(room.roomId, eventId);
    void host.request({ type: "read", roomId: room.roomId, eventId }).catch(() => {
        if (generation === uiGeneration && lastReadRequestedByRoom.get(room.roomId) === eventId) {
            lastReadRequestedByRoom.delete(room.roomId);
        }
    });
}

async function sendComposer(room: MatrixRoomDTO, textarea: HTMLTextAreaElement) {
    if (!host || sendBusyRooms.has(room.roomId) || uploadBusyRooms.has(room.roomId)
        || pendingUploadsByRoom.has(room.roomId)) return;
    composerDrafts.set(room.roomId, textarea.value);
    const body = textarea.value.trim();
    if (!body) return;
    const generation = uiGeneration;
    sendBusyRooms.add(room.roomId);
    scheduleRender();
    const editing = editByRoom.get(room.roomId);
    const replying = replyByRoom.get(room.roomId);
    try {
        if (editing) {
            await host.request({ type: "edit", roomId: room.roomId, eventId: editing.eventId, body });
            if (generation !== uiGeneration) return;
            editByRoom.delete(room.roomId);
        } else {
            await host.request({
                type: "sendText",
                roomId: room.roomId,
                body,
                ...(replying ? { replyEventId: replying.eventId } : {}),
            });
            if (generation !== uiGeneration) return;
            replyByRoom.delete(room.roomId);
        }
        if (generation !== uiGeneration) return;
        composerDrafts.delete(room.roomId);
        isolatedContexts.delete(room.roomId);
        await stopTyping(room.roomId);
    } catch (error) {
        if (generation === uiGeneration) showToast(`Message not sent: ${errorText(error)}`, "error");
    } finally {
        if (generation === uiGeneration) sendBusyRooms.delete(room.roomId);
        scheduleRender();
    }
}

async function sendFiles(room: MatrixRoomDTO, files: FileList, textarea: HTMLTextAreaElement) {
    if (!host || !files.length || uploadBusyRooms.has(room.roomId)) return;
    if (pendingUploadsByRoom.has(room.roomId)) {
        showToast("Retry or discard the unfinished attachment batch first.", "error");
        return;
    }
    if (files.length > 10) {
        showToast("You can send at most 10 files at once.", "error");
        return;
    }
    const selected = [...files];
    const oversized = selected.find(file => file.size > MAX_UPLOAD_BYTES);
    if (oversized) {
        showToast(`${oversized.name} is larger than the 25 MB Matrix upload limit.`, "error");
        return;
    }
    const aggregateSize = selected.reduce((total, file) => total + file.size, 0);
    if (aggregateSize > MAX_UPLOAD_BATCH_BYTES) {
        showToast("That batch is larger than the 100 MB Matrix upload limit.", "error");
        return;
    }
    const caption = textarea.value.trim();
    const reply = replyByRoom.get(room.roomId);
    composerDrafts.set(room.roomId, textarea.value);
    pendingUploadsByRoom.set(room.roomId, {
        items: selected.map(file => ({ file, txnId: `secure-${crypto.randomUUID()}` })),
        caption: caption || undefined,
        replyEventId: reply?.eventId,
    });
    await processPendingUploads(room.roomId);
}

async function processPendingUploads(roomId: string) {
    if (!host || uploadBusyRooms.has(roomId)) return;
    const batch = pendingUploadsByRoom.get(roomId);
    if (!batch?.items.length) return;
    const generation = uiGeneration;
    const startingCount = batch.items.length;
    uploadBusyRooms.add(roomId);
    scheduleRender();
    let sent = 0;
    try {
        while (batch.items.length) {
            const item = batch.items[0];
            const { file } = item;
            const finalAttachment = batch.items.length === 1;
            const bytes = new Uint8Array(await file.arrayBuffer());
            try {
                if (generation !== uiGeneration || pendingUploadsByRoom.get(roomId) !== batch) return;
                await host.request({
                    type: "sendAttachment",
                    roomId,
                    attachment: {
                        name: file.name.slice(0, 255) || "attachment",
                        txnId: item.txnId,
                        declaredMimeType: file.type || undefined,
                        bytes,
                        caption: finalAttachment ? batch.caption : undefined,
                        replyEventId: finalAttachment ? batch.replyEventId : undefined,
                    },
                });
                if (generation !== uiGeneration || pendingUploadsByRoom.get(roomId) !== batch) return;
                batch.items.shift();
                sent++;
            } finally {
                bytes.fill(0);
            }
        }
        pendingUploadsByRoom.delete(roomId);
        composerDrafts.delete(roomId);
        isolatedContexts.delete(roomId);
        if (!batch.replyEventId || replyByRoom.get(roomId)?.eventId === batch.replyEventId) replyByRoom.delete(roomId);
        await stopTyping(roomId);
        showToast(`${startingCount} attachment${startingCount === 1 ? "" : "s"} sent.`, "success");
    } catch (error) {
        if (generation === uiGeneration) {
            showToast(`${sent ? `${sent} sent; ` : ""}upload paused: ${errorText(error)}`, "error");
        }
    } finally {
        if (generation === uiGeneration) uploadBusyRooms.delete(roomId);
        scheduleRender();
    }
}

async function toggleReaction(room: MatrixRoomDTO, message: MatrixMessageDTO, reaction: MatrixReactionDTO) {
    if (!host) return;
    const generation = uiGeneration;
    try {
        await host.request({
            type: "react",
            roomId: room.roomId,
            eventId: message.eventId,
            key: reaction.key,
            remove: reaction.me,
        });
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function addReaction(room: MatrixRoomDTO, message: MatrixMessageDTO, key: string) {
    if (!host) return;
    const existing = message.reactions?.find(reaction => reaction.key === key);
    if (existing) return toggleReaction(room, message, existing);
    const generation = uiGeneration;
    try {
        await host.request({ type: "react", roomId: room.roomId, eventId: message.eventId, key });
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function redactMessage(room: MatrixRoomDTO, message: MatrixMessageDTO) {
    if (!host || !window.confirm("Delete this Matrix message?")) return;
    const generation = uiGeneration;
    try {
        if (message.pending && message.transactionId) {
            await host.request({ type: "cancelPending", roomId: room.roomId, transactionId: message.transactionId });
        } else {
            await host.request({ type: "redact", roomId: room.roomId, eventId: message.eventId });
        }
    } catch (error) {
        if (generation === uiGeneration) showToast(errorText(error), "error");
    }
}

async function jumpToReply(room: MatrixRoomDTO, eventId: string) {
    const generation = uiGeneration;
    const { timelineGeneration } = room;
    highlightedEventId = eventId;
    scheduleRender();
    let target = root.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`);
    if (!target) {
        const messages = mergedMessages(room);
        const index = messages.findIndex(message => message.eventId === eventId);
        if (index !== -1) {
            const start = Math.max(0, index - Math.floor(MAX_MESSAGE_DOM / 2));
            timelineWindows.set(room.roomId, {
                start,
                end: Math.min(messages.length, start + MAX_MESSAGE_DOM),
                total: messages.length,
            });
            render();
            target = root.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`);
        }
    }
    if (!target && host) {
        try {
            const context = await host.request({ type: "messageContext", roomId: room.roomId, eventId });
            if (generation !== uiGeneration
                || roomById(room.roomId)?.timelineGeneration !== timelineGeneration) return;
            isolatedContexts.set(room.roomId, {
                anchorEventId: eventId,
                messages: [...context.before, context.message, ...context.after],
            });
            render();
            target = root.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`);
        } catch (error) {
            if (generation === uiGeneration
                && roomById(room.roomId)?.timelineGeneration === timelineGeneration) {
                showToast(`Reply context unavailable: ${errorText(error)}`, "error");
            }
        }
    }
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
}

function renderMediaElement(
    key: string,
    entry: MediaEntry,
    attachment: MatrixAttachmentDTO,
    sticker: boolean,
    onSave?: () => void,
    onRetry?: () => void,
    onAutoLoad?: () => void,
) {
    if (entry.state === "loading") {
        const queued = mediaCache.has(key);
        const statusElement = element("div", "matrix-media-status",
            textElement("span", "", queued ? "Loading media..." : "Media will load when it is visible."),
            queued ? null : makeButton("Load now", "matrix-button", () => onRetry?.(), { disabled: !onRetry }),
        );
        if (!queued && onAutoLoad) armViewportTask(`media\0${key}`, statusElement, onAutoLoad);
        return statusElement;
    }
    if (entry.state === "error" || !entry.objectUrl) {
        const tombstone = mediaTombstones.get(key);
        const reason = tombstone === "evicted"
            ? "Media was unloaded to keep this view within its memory limit."
            : tombstone === "deferred"
                ? "Automatic media loading reached its safety bound."
                : "This media could not be loaded securely.";
        return element("div", "matrix-media-status",
            textElement("span", "", reason),
            makeButton(tombstone === "deferred" ? "Load" : "Load again", "matrix-button", () => onRetry?.(), { disabled: !onRetry }),
        );
    }
    entry.touched = Date.now();
    const mimeType = entry.mimeType?.toLocaleLowerCase() || attachment.mimeType?.toLocaleLowerCase() || "";
    let media: HTMLImageElement | HTMLMediaElement;
    const existing = mediaElements.get(key);
    if (mimeType.startsWith("image/") || sticker) {
        const image = existing instanceof HTMLImageElement ? existing : element("img", "matrix-media");
        image.className = "matrix-media";
        if (sticker) image.classList.add("matrix-sticker");
        if (image.src !== entry.objectUrl) image.src = entry.objectUrl;
        image.alt = sticker ? `Sticker: ${attachment.name}` : attachment.name;
        image.loading = "lazy";
        image.decoding = "async";
        media = image;
    } else if (mimeType.startsWith("video/")) {
        const video = existing instanceof HTMLVideoElement ? existing : element("video", "matrix-media");
        video.className = "matrix-media";
        if (video.src !== entry.objectUrl) video.src = entry.objectUrl;
        video.controls = true;
        video.preload = "metadata";
        video.setAttribute("playsinline", "");
        video.setAttribute("aria-label", attachment.name);
        media = video;
    } else if (mimeType.startsWith("audio/")) {
        const audio = existing instanceof HTMLAudioElement ? existing : element("audio", "matrix-media");
        audio.className = "matrix-media";
        if (audio.src !== entry.objectUrl) audio.src = entry.objectUrl;
        audio.controls = true;
        audio.preload = "metadata";
        audio.setAttribute("aria-label", attachment.name);
        media = audio;
    } else {
        const save = makeButton("Save file", "matrix-button", () => onSave?.(), { disabled: !onSave });
        const copy = element("div", "matrix-file-copy",
            textElement("strong", "", attachment.name || entry.name || "Attachment"),
            textElement("div", "matrix-subtle", [mimeType, formatBytes(attachment.size)].filter(Boolean).join(" - ")),
        );
        return element("div", "matrix-file", textElement("span", "", "File"), copy, save);
    }
    mediaElements.set(key, media);
    return element("div", sticker ? "matrix-media-wrap matrix-sticker-wrap" : "matrix-media-wrap",
        media,
        makeButton("Save", "matrix-media-save matrix-button", () => onSave?.(), {
            ariaLabel: `Save ${attachment.name || "media"}`,
            disabled: !onSave,
        }),
    );
}

function saveMedia(roomId: string, eventId: string, attachmentIndex: number) {
    if (!host) return;
    const generation = uiGeneration;
    void host.request({ type: "saveMedia", roomId, eventId, attachmentIndex }).then(result => {
        if (generation === uiGeneration && result.saved) showToast("File saved.", "success");
    }).catch(error => {
        if (generation === uiGeneration) showToast(`Could not save file: ${errorText(error)}`, "error");
    });
}

function renderAttachment(room: MatrixRoomDTO, message: MatrixMessageDTO, attachment: MatrixAttachmentDTO, index: number) {
    if (!attachment.downloadable) {
        return element("div", "matrix-file",
            textElement("span", "", "File"),
            element("div", "matrix-file-copy",
                textElement("strong", "", attachment.name || "Attachment"),
                textElement("div", "matrix-subtle", "This attachment is unavailable."),
            ),
        );
    }
    const save = host ? () => saveMedia(room.roomId, message.eventId, index) : undefined;
    const declaredMimeType = attachment.mimeType?.toLocaleLowerCase() || "";
    const inlineMedia = Boolean(message.sticker)
        || declaredMimeType.startsWith("image/")
        || declaredMimeType.startsWith("video/")
        || declaredMimeType.startsWith("audio/");
    if (!inlineMedia) {
        return element("div", "matrix-file",
            textElement("span", "", "File"),
            element("div", "matrix-file-copy",
                textElement("strong", "", attachment.name || "Attachment"),
                textElement("div", "matrix-subtle", [declaredMimeType, formatBytes(attachment.size)].filter(Boolean).join(" - ")),
            ),
            makeButton("Save file", "matrix-button", () => save?.(), { disabled: !save }),
        );
    }
    const key = mediaKey(room.roomId, message.eventId, index);
    return renderMediaElement(
        key,
        mediaEntryForRender(key),
        attachment,
        Boolean(message.sticker),
        save,
        () => {
            queueMedia(room.roomId, message.eventId, index, "attachment", true);
            scheduleRender();
        },
        () => queueMediaAutomatically(room.roomId, message.eventId, index, "attachment", attachment.size),
    );
}

function renderMessageBody(body: string) {
    const container = element("div", "matrix-message-body");
    const pattern = new RegExp(URL_PATTERN.source, "giu");
    let position = 0;
    for (const match of body.matchAll(pattern)) {
        const index = match.index ?? 0;
        const url = match[0];
        if (index > position) container.append(document.createTextNode(body.slice(position, index)));
        const link = makeButton(url, "matrix-inline-link", () => {
            if (!host) return;
            void host.request({ type: "openExternal", url }).catch(error => showToast(errorText(error), "error"));
        }, { ariaLabel: `Open link: ${url}` });
        container.append(link);
        position = index + url.length;
    }
    if (position < body.length) container.append(document.createTextNode(body.slice(position)));
    return container;
}

function renderPreview(room: MatrixRoomDTO, message: MatrixMessageDTO) {
    if (!previewCache.has(message.eventId)) {
        if (previewLoading.has(message.eventId)) {
            return textElement("div", "matrix-media-status", "Loading link preview...");
        }
        const deferred = previewDeferred.has(message.eventId);
        const placeholder = element("div", "matrix-media-status",
            textElement("span", "", deferred
                ? "Automatic link previews reached their safety bound."
                : "Link preview will load when it is visible."),
            makeButton("Load preview", "matrix-button", () => queuePreview(message, true)),
        );
        if (!deferred) armViewportTask(`preview\0${message.eventId}`, placeholder, () => queuePreview(message));
        return placeholder;
    }
    const preview = previewCache.get(message.eventId);
    if (!preview) return null;
    const bareGif = !preview.video && preview.image?.downloadable
        && (preview.image.animated || preview.image.mimeType?.toLocaleLowerCase() === "image/gif");
    if (bareGif) {
        const key = mediaKey(room.roomId, message.eventId, preview.image!.downloadIndex, "preview-image");
        return renderMediaElement(
            key,
            mediaEntryForRender(key),
            preview.image!,
            false,
            () => saveMedia(room.roomId, message.eventId, preview.image!.downloadIndex),
            () => {
                queueMedia(room.roomId, message.eventId, preview.image!.downloadIndex, "preview-image", true);
                scheduleRender();
            },
            () => queueMediaAutomatically(
                room.roomId,
                message.eventId,
                preview.image!.downloadIndex,
                "preview-image",
                preview.image!.size,
            ),
        );
    }
    const card = element("div", "matrix-link-card");
    const copy = element("div", "matrix-link-copy");
    if (preview.provider?.name) copy.append(textElement("div", "matrix-subtle", preview.provider.name));
    if (preview.title) copy.append(textElement("strong", "", preview.title));
    if (preview.description) copy.append(textElement("div", "matrix-subtle", preview.description));
    const [match] = message.body.match(URL_PATTERN) ?? [];
    if (match && host) {
        copy.append(makeButton("Open link", "matrix-button", () => {
            void host.request({ type: "openExternal", url: match }).catch(error => showToast(errorText(error), "error"));
        }));
    }
    card.append(copy);
    const media = preview.video ?? preview.image;
    if (media?.downloadable) {
        const kind = media === preview.video ? "preview-video" : "preview-image";
        const key = mediaKey(room.roomId, message.eventId, media.downloadIndex, kind);
        card.append(renderMediaElement(
            key,
            mediaEntryForRender(key),
            media,
            false,
            () => saveMedia(room.roomId, message.eventId, media.downloadIndex),
            () => {
                queueMedia(room.roomId, message.eventId, media.downloadIndex, kind, true);
                scheduleRender();
            },
            () => queueMediaAutomatically(room.roomId, message.eventId, media.downloadIndex, kind, media.size),
        ));
    }
    return card;
}

function renderMessage(
    room: MatrixRoomDTO,
    message: MatrixMessageDTO,
    messagesById: Map<string, MatrixMessageDTO>,
    compact = false,
) {
    const row = element("article", "matrix-message");
    if (compact) row.dataset.compact = "true";
    row.dataset.eventId = message.eventId;
    row.tabIndex = -1;
    if (message.eventId === highlightedEventId) row.dataset.highlighted = "true";
    const sender = authorName(message);
    row.append(textElement("div", "matrix-avatar", initials(sender)));
    const main = element("div", "matrix-message-main");
    const reply = message.replyToEventId ? messagesById.get(message.replyToEventId) : undefined;
    if (message.replyToEventId) {
        const replyLabel = reply
            ? `${authorName(reply)}: ${reply.body || reply.attachments?.[0]?.name || "Attachment"}`
            : "View replied-to message";
        main.append(makeButton(replyLabel, "matrix-reply-preview", () => {
            void jumpToReply(room, message.replyToEventId!);
        }, { ariaLabel: `Jump to replied-to message: ${replyLabel}` }));
    }
    const heading = element("div", "matrix-message-heading",
        textElement("span", "matrix-sender", sender),
        textElement("time", "matrix-time", formatTime(message.timestamp)),
    );
    if (message.edited) heading.append(textElement("span", "matrix-edited", "edited"));
    if (message.pending) heading.append(textElement("span", "matrix-edited", message.failed ? "failed" : "sending"));
    main.append(heading);
    if (message.decryptionFailure) {
        main.append(textElement("div", "matrix-message-body matrix-subtle", "This encrypted message could not be decrypted."));
    } else if (message.body && !message.sticker) {
        main.append(renderMessageBody(message.body));
    }
    if (message.attachments?.length) {
        const attachments = element("div", "matrix-attachments");
        message.attachments.forEach((attachment, index) => attachments.append(renderAttachment(room, message, attachment, index)));
        main.append(attachments);
    } else if (!message.decryptionFailure && URL_PATTERN.test(message.body)) {
        const preview = renderPreview(room, message);
        if (preview) main.append(preview);
    }
    if (message.reactions?.length) {
        const reactions = element("div", "matrix-reactions");
        for (const reaction of message.reactions) {
            const control = makeButton(`${reaction.key} ${reaction.count}`, "matrix-reaction", () => {
                void toggleReaction(room, message, reaction);
            }, { ariaLabel: `${reaction.me ? "Remove" : "Add"} ${reaction.key} reaction, ${reaction.count}` });
            control.dataset.me = String(reaction.me);
            reactions.append(control);
        }
        main.append(reactions);
    }
    const actions = element("div", "matrix-message-actions");
    actions.append(
        makeButton("Reply", "", () => {
            replyByRoom.set(room.roomId, message);
            editByRoom.delete(room.roomId);
            scheduleRender();
            setTimeout(() => root.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus());
        }, { ariaLabel: "Reply" }),
        makeButton("+1", "", () => void addReaction(room, message, "\u{1F44D}"), { ariaLabel: "Add reaction" }),
    );
    if (message.senderId === snapshot?.account?.userId) {
        if (!message.sticker && !message.attachments?.length && !message.failed) {
            actions.append(makeButton("Edit", "", () => {
                editByRoom.set(room.roomId, message);
                replyByRoom.delete(room.roomId);
                composerDrafts.set(room.roomId, message.body);
                scheduleRender();
                setTimeout(() => root.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus());
            }, { ariaLabel: "Edit message" }));
        }
        actions.append(makeButton("Delete", "", () => void redactMessage(room, message), { ariaLabel: "Delete message" }));
    }
    row.append(main, actions);
    return row;
}

function renderComposer(room: MatrixRoomDTO) {
    const wrap = element("div", "matrix-composer-wrap");
    const replying = replyByRoom.get(room.roomId);
    const editing = editByRoom.get(room.roomId);
    const context = editing ?? replying;
    const pendingUpload = pendingUploadsByRoom.get(room.roomId);
    const sending = sendBusyRooms.has(room.roomId);
    const uploading = uploadBusyRooms.has(room.roomId);
    const busy = sending || uploading || Boolean(pendingUpload);
    if (context) {
        const contextRow = element("div", "matrix-composer-context");
        contextRow.append(
            textElement(
                "span",
                "matrix-composer-context-copy",
                editing
                    ? `Editing: ${context.body}`
                    : `Replying to ${authorName(context)}: ${context.body || context.attachments?.[0]?.name || "Attachment"}`,
            ),
            makeButton("Cancel", "matrix-icon-button", () => {
                replyByRoom.delete(room.roomId);
                editByRoom.delete(room.roomId);
                if (editing) composerDrafts.delete(room.roomId);
                scheduleRender();
            }, { disabled: sending || uploading }),
        );
        wrap.append(contextRow);
    }
    if (pendingUpload) {
        wrap.append(element("div", "matrix-composer-context",
            textElement("span", "matrix-composer-context-copy", uploading
                ? `Sending ${pendingUpload.items.length} remaining attachment${pendingUpload.items.length === 1 ? "" : "s"}...`
                : `${pendingUpload.items.length} attachment${pendingUpload.items.length === 1 ? "" : "s"} waiting to retry.`),
            makeButton("Retry", "matrix-button matrix-button-primary", () => void processPendingUploads(room.roomId), {
                disabled: uploading,
            }),
            makeButton("Discard", "matrix-button", () => {
                pendingUploadsByRoom.delete(room.roomId);
                scheduleRender();
            }, { disabled: uploading }),
        ));
    }
    const composer = element("div", "matrix-composer");
    composer.dataset.hasContext = String(Boolean(context));
    const fileInput = element("input", "matrix-sr-only");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.tabIndex = -1;
    fileInput.disabled = busy;
    const textarea = element("textarea", "matrix-textarea");
    textarea.dataset.composer = "true";
    textarea.dataset.focusKey = "matrix-composer";
    textarea.setAttribute("aria-label", `Message ${roomName(room)}`);
    textarea.placeholder = `Message ${roomName(room)}`;
    textarea.maxLength = 65_536;
    textarea.value = composerDrafts.get(room.roomId) ?? (editing?.body || "");
    textarea.disabled = busy;
    textarea.addEventListener("input", () => {
        composerDrafts.set(room.roomId, textarea.value);
        noteTyping(room.roomId);
    });
    textarea.addEventListener("keydown", event => {
        if (event.key === "Escape" && context) {
            event.preventDefault();
            replyByRoom.delete(room.roomId);
            editByRoom.delete(room.roomId);
            scheduleRender();
            return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void sendComposer(room, textarea);
        }
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files) void sendFiles(room, fileInput.files, textarea);
        fileInput.value = "";
    });
    composer.append(
        fileInput,
        makeButton("+", "matrix-icon-button", () => fileInput.click(), {
            ariaLabel: "Add files",
            title: "Add files",
            disabled: busy,
        }),
        textarea,
        makeButton("Send", "matrix-icon-button", () => void sendComposer(room, textarea), {
            ariaLabel: "Send message",
            disabled: busy,
        }),
    );
    wrap.append(composer);
    const typingIds = typingByRoom.get(room.roomId) ?? [];
    const names = typingIds.map(userId => room.members.find(member => member.userId === userId)?.displayName || userId);
    wrap.append(textElement("div", "matrix-typing", names.length
        ? `${names.slice(0, 3).join(", ")} ${names.length === 1 ? "is" : "are"} typing...`
        : ""));
    return wrap;
}

function renderTimeline(room: MatrixRoomDTO) {
    const chat = element("div", "matrix-chat");
    const timeline = element("div", "matrix-timeline");
    timeline.setAttribute("role", "log");
    timeline.setAttribute("aria-label", `${roomName(room)} messages`);
    timeline.setAttribute("aria-live", "polite");
    timeline.dataset.roomId = room.roomId;
    const isolatedContext = isolatedContexts.get(room.roomId);
    const allMessages = isolatedContext?.messages ?? mergedMessages(room);
    const byId = new Map(allMessages.map(message => [message.eventId, message]));
    const highlightedIndex = highlightedEventId
        ? allMessages.findIndex(message => message.eventId === highlightedEventId)
        : -1;
    const wasAtBottom = timelineAtBottomByRoom.get(room.roomId) ?? true;
    let windowState: TimelineWindow;
    const previousWindow = isolatedContext ? undefined : timelineWindows.get(room.roomId);
    if (isolatedContext) {
        windowState = { start: 0, end: allMessages.length, total: allMessages.length };
    } else if (!previousWindow) {
        windowState = {
            start: Math.max(0, allMessages.length - MAX_MESSAGE_DOM),
            end: allMessages.length,
            total: allMessages.length,
        };
    } else if (allMessages.length > previousWindow.total
        && previousWindow.end >= previousWindow.total
        && wasAtBottom) {
        // The authoritative sequence grew at its tail while the user was
        // pinned there. Advance the bounded window with it.
        windowState = {
            start: Math.max(0, allMessages.length - MAX_MESSAGE_DOM),
            end: allMessages.length,
            total: allMessages.length,
        };
    } else {
        // Edits/redactions and tail appends must not move a historical view.
        const end = Math.min(previousWindow.end, allMessages.length);
        windowState = {
            start: Math.min(previousWindow.start, Math.max(0, end - 1)),
            end,
            total: allMessages.length,
        };
    }
    if (highlightedIndex !== -1 && (highlightedIndex < windowState.start || highlightedIndex >= windowState.end)) {
        const start = Math.max(0, highlightedIndex - Math.floor(MAX_MESSAGE_DOM / 2));
        windowState = {
            start,
            end: Math.min(allMessages.length, start + MAX_MESSAGE_DOM),
            total: allMessages.length,
        };
    }
    if (!isolatedContext) timelineWindows.set(room.roomId, windowState);
    const history = histories.get(room.roomId);
    const historyStatus = isolatedContext
        ? element("div", "matrix-history-status",
            "Showing isolated message context. ",
            makeButton("Back to latest", "matrix-button", () => {
                isolatedContexts.delete(room.roomId);
                highlightedEventId = undefined;
                lastTimelineRoomId = undefined;
                scheduleRender();
            }),
        )
        : history?.loading
            ? textElement("div", "matrix-history-status", "Loading older messages...")
            : history?.end
                ? textElement("div", "matrix-history-status", "Beginning of this room's available history")
                : element(
                    "div",
                    "matrix-history-status",
                    "Scroll up or ",
                    makeButton("load older messages", "matrix-button", () => void loadOlder(room, timeline)),
                );
    timeline.append(historyStatus);
    const visibleMessages = allMessages.slice(windowState.start, windowState.end);
    const receiptTarget = !isolatedContext && windowState.end === allMessages.length
        ? visibleMessages.findLast(message => message.eventId.startsWith("$"))?.eventId
        : undefined;
    if (receiptTarget) renderedReceiptTargetByRoom.set(room.roomId, receiptTarget);
    else renderedReceiptTargetByRoom.delete(room.roomId);
    if (!visibleMessages.length) {
        timeline.append(element("div", "matrix-empty", textElement("div", "", "No messages yet. Say hello.")));
    } else {
        for (let index = 0; index < visibleMessages.length; index++) {
            const message = visibleMessages[index];
            const previousMessage = visibleMessages[index - 1];
            const timestampDelta = previousMessage ? message.timestamp - previousMessage.timestamp : -1;
            timeline.append(renderMessage(
                room,
                message,
                byId,
                Boolean(previousMessage
                    && previousMessage.senderId === message.senderId
                    && !message.replyToEventId
                    && timestampDelta >= 0
                    && timestampDelta <= MAX_COMPACT_MESSAGE_GAP_MS),
            ));
        }
    }
    let scrollWork = false;
    timeline.addEventListener("scroll", () => {
        if (isolatedContext) return;
        timelineAtBottomByRoom.set(
            room.roomId,
            timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80,
        );
        if (scrollWork) return;
        if (timeline.scrollTop < 90) {
            scrollWork = true;
            if (windowState!.start > 0) {
                const previousHeight = timeline.scrollHeight;
                const previousTop = timeline.scrollTop;
                const start = Math.max(0, windowState!.start - 60);
                timelineWindows.set(room.roomId, {
                    start,
                    end: Math.min(allMessages.length, start + MAX_MESSAGE_DOM),
                    total: allMessages.length,
                });
                render();
                const nextTimeline = root.querySelector<HTMLElement>(".matrix-timeline");
                if (nextTimeline) {
                    nextTimeline.scrollTop = Math.max(0, nextTimeline.scrollHeight - previousHeight + previousTop);
                }
            } else {
                void loadOlder(room, timeline).finally(() => { scrollWork = false; });
            }
            return;
        }
        if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100
            && windowState!.end < allMessages.length) {
            scrollWork = true;
            const end = Math.min(allMessages.length, windowState!.end + 60);
            timelineWindows.set(room.roomId, {
                start: Math.max(0, end - MAX_MESSAGE_DOM),
                end,
                total: allMessages.length,
            });
            scheduleRender();
        }
    }, { passive: true });
    chat.append(timeline, renderComposer(room));
    setTimeout(() => {
        const currentTimeline = root.querySelector<HTMLElement>(".matrix-timeline");
        if (!currentTimeline || currentTimeline.dataset.roomId !== room.roomId) return;
        if (lastTimelineRoomId !== room.roomId) {
            currentTimeline.scrollTop = currentTimeline.scrollHeight;
            lastTimelineRoomId = room.roomId;
        }
        timelineAtBottomByRoom.set(
            room.roomId,
            currentTimeline.scrollHeight - currentTimeline.scrollTop - currentTimeline.clientHeight < 80,
        );
        if (!isolatedContext) {
            markLatestRead(room);
            const currentRoom = roomById(room.roomId);
            const currentHistory = histories.get(room.roomId);
            if (visible && currentTimeline.clientHeight > 0
                && currentTimeline.scrollHeight <= currentTimeline.clientHeight + 1
                && currentRoom?.timelineGeneration === room.timelineGeneration
                && !currentHistory?.loading && !currentHistory?.end) {
                void loadOlder(currentRoom, currentTimeline, true);
            }
        }
    });
    return chat;
}

function renderHeading(title: string, topic = "", showLeave?: MatrixRoomDTO) {
    const heading = element("header", "matrix-main-heading");
    const copy = element("div", "matrix-heading-copy", textElement("strong", "", title));
    if (topic) copy.append(textElement("span", "matrix-heading-topic", topic));
    const actions = element("div", "matrix-heading-actions");
    actions.append(
        makeButton("Search", "matrix-icon-button", openSearch, { ariaLabel: "Search Matrix messages" }),
        makeButton("Refresh", "matrix-icon-button", () => void refresh(true), { ariaLabel: "Refresh Matrix" }),
    );
    if (showLeave) {
        actions.append(makeButton("Leave", "matrix-icon-button", () => void leaveRoom(showLeave), {
            ariaLabel: `Leave ${roomName(showLeave)}`,
        }));
    }
    heading.append(copy, actions);
    return heading;
}

function renderRoomMain(room: MatrixRoomDTO) {
    const main = element("section", "matrix-main");
    main.append(renderHeading(roomName(room), room.topic || "", room), element("div", "matrix-content", renderTimeline(room)));
    return main;
}

function roomCard(room: MatrixRoomDTO, actions: HTMLElement[] = []) {
    const copy = element("div", "matrix-card-copy",
        textElement("h3", "", roomName(room)),
        room.topic ? textElement("p", "matrix-subtle", room.topic) : null,
        textElement("div", "matrix-subtle", isSpace(room) ? "Server" : isDirect(room) ? "Direct message" : "Chat"),
    );
    const card = element("article", "matrix-card", element("div", "matrix-card-row", copy));
    if (actions.length) card.append(element("div", "matrix-card-actions", ...actions));
    return card;
}

function renderHomeMain() {
    const main = element("section", "matrix-main");
    main.append(renderHeading("Matrix", "Private chats in an isolated view"));
    const page = element("div", "matrix-page");
    const narrow = element("div", "matrix-page-narrow");
    narrow.append(
        textElement("h1", "", "Your Matrix chats"),
        textElement("p", "matrix-subtle", "Messages and authentication stay inside this isolated renderer."),
        renderSecurityIndicator(),
    );
    const invites = invitedRooms();
    if (invites.length) {
        narrow.append(textElement("h2", "", "Invitations"));
        const inviteGrid = element("div", "matrix-grid");
        for (const room of invites) {
            inviteGrid.append(roomCard(room, [
                makeButton("Accept", "matrix-button matrix-button-primary", () => void acceptInvite(room.roomId)),
                makeButton("Decline", "matrix-button", () => void rejectInvite(room.roomId)),
            ]));
        }
        narrow.append(inviteGrid);
    }
    const spaces = joinedRooms().filter(isSpace);
    narrow.append(
        element("div", "matrix-card-actions",
            textElement("h2", "", "Servers"),
            makeButton(spaceCreationBlocked ? "Refresh before creating" : spaceCreationInFlight ? "Creating..." : "Create server", "matrix-button matrix-button-primary", () => {
                overlay = "createSpace";
                scheduleRender();
            }, { disabled: spaceCreationBlocked || spaceCreationInFlight }),
        ),
    );
    const spaceGrid = element("div", "matrix-grid");
    for (const space of spaces) {
        spaceGrid.append(roomCard(space, [
            makeButton("Open", "matrix-button matrix-button-primary", () => setRoute({ kind: "space", roomId: space.roomId })),
        ]));
    }
    if (!spaces.length) spaceGrid.append(textElement("div", "matrix-subtle", "No joined servers yet."));
    narrow.append(spaceGrid);

    const chats = joinedRooms().filter(room => !isSpace(room));
    narrow.append(textElement("h2", "", "Recent chats"));
    const chatGrid = element("div", "matrix-grid");
    for (const room of chats.slice(0, 12)) {
        chatGrid.append(roomCard(room, [
            makeButton("Open", "matrix-button", () => setRoute({
                kind: isDirect(room) ? "dm" : "room",
                roomId: room.roomId,
            })),
        ]));
    }
    if (!chats.length) chatGrid.append(textElement("div", "matrix-subtle", "No joined chats yet."));
    narrow.append(chatGrid);
    page.append(narrow);
    main.append(page);
    return main;
}

function renderSpaceAccessPanel(space: MatrixRoomDTO) {
    const spaceId = space.roomId;
    const access = spaceAccess.get(spaceId);
    const draft = spaceAccessDrafts.get(spaceId);
    const requests = spaceAccessRequests.get(spaceId);
    const saving = spaceAccessAction === `save:${spaceId}`;
    const accessActionBusy = spaceAccessAction != null;
    const card = element(
        "section",
        "matrix-card matrix-access-panel",
        textElement("h2", "", "Access settings"),
        textElement(
            "p",
            "matrix-subtle",
            "Unlisted means not listed in your provider's public directory; links, aliases, or parent servers may still reveal the server. Admission is controlled by invitation or request; a join name is not a password."
        ),
        access ? textElement(
            "p",
            "matrix-subtle",
            spaceAccessConfirmed.get(spaceId) === false
                ? `Could not verify current access. Last confirmed state: ${actualAccessLabel(access)}.`
                : `Current access: ${actualAccessLabel(access)}.`
        ) : null,
    );
    if (spaceAccessLoading === spaceId) card.append(textElement("p", "matrix-subtle", "Loading access settings..."));

    if (space.canConfigureSpaceAccess === true && draft) {
        if (access && (access.joinRule === "restricted" || access.joinRule === "knock_restricted")) {
            card.append(textElement(
                "p",
                "matrix-access-warning",
                `Saving will replace the current linked-server membership rule with ${simplifiedAccessModeLabel(draft.mode)}.`
            ));
        }
        const mode = element("select", "matrix-select");
        mode.name = "access-mode";
        mode.dataset.focusKey = `matrix-access-mode-${spaceId}`;
        for (const value of ["public", "request", "invite"] as const) {
            const option = element("option", "");
            option.value = value;
            option.textContent = accessModeLabel(value);
            mode.append(option);
        }
        mode.value = draft.mode;
        mode.disabled = accessActionBusy;
        mode.addEventListener("change", () => {
            draft.mode = mode.value === "public" || mode.value === "request" ? mode.value : "invite";
            spaceAccessErrors.delete(spaceId);
            scheduleRender();
        });
        card.append(labelledField("Who can join?", mode));

        if (draft.mode === "request") {
            const joinName = input("text", "joinName", "my-server", draft.joinName);
            joinName.maxLength = JOIN_NAME_MAX_LENGTH;
            joinName.dataset.focusKey = `matrix-access-join-name-${spaceId}`;
            joinName.disabled = accessActionBusy;
            joinName.addEventListener("input", () => {
                draft.joinName = joinName.value.toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH);
                spaceAccessErrors.delete(spaceId);
                scheduleRender();
            });
            card.append(
                labelledField("Server join name", joinName),
                textElement("p", "matrix-subtle", "Share this unique lowercase name so people can request access. It is not a password."),
            );
            if (access?.joinName) {
                card.append(textElement("p", "matrix-subtle", `Current join name: ${access.joinName}`));
            }
        }

        card.append(makeButton(saving ? "Saving access settings..." : "Save access settings", "matrix-button matrix-button-primary", () => {
            void saveSpaceAccess(spaceId);
        }, {
            disabled: accessActionBusy || draft.mode === "request" && !validJoinName(cleanJoinName(draft.joinName)),
        }));
    }

    const accessError = spaceAccessErrors.get(spaceId);
    if (accessError) card.append(textElement("p", "matrix-access-error", accessError));

    if (requests) {
        card.append(textElement("h3", "matrix-access-requests-heading", `Access requests (${requests.requests.length})`));
        if (!requests.requests.length) card.append(textElement("p", "matrix-subtle", "No pending access requests."));
        if (requests.truncated) card.append(textElement("p", "matrix-subtle", "Only the first pending requests are shown."));
        const grid = element("div", "matrix-grid");
        for (const request of requests.requests) {
            const approveAction = `approve:${spaceId}:${request.userId}`;
            const denyAction = `deny:${spaceId}:${request.userId}`;
            const requesterName = safeRequesterDisplayName(request.displayName);
            const requesterUserId = visibleRequesterUserId(request.userId);
            const actions: HTMLElement[] = [];
            if (request.canApprove) {
                actions.push(makeButton(
                    spaceAccessAction === approveAction ? "Approving..." : "Approve",
                    "matrix-button matrix-button-primary",
                    () => void resolveSpaceAccessRequest(spaceId, request.userId, "approve"),
                    { disabled: accessActionBusy }
                ));
            }
            if (request.canDeny) {
                actions.push(makeButton(
                    spaceAccessAction === denyAction ? "Denying..." : "Deny",
                    "matrix-button matrix-button-danger",
                    () => void resolveSpaceAccessRequest(spaceId, request.userId, "deny"),
                    { disabled: accessActionBusy }
                ));
            }
            grid.append(element(
                "article",
                "matrix-card",
                textElement("h3", "", requesterName || requesterUserId),
                requesterName ? textElement("div", "matrix-subtle", requesterUserId) : null,
                actions.length ? element("div", "matrix-card-actions", ...actions) : null,
            ));
        }
        card.append(grid);
    }
    return card;
}

function renderSpaceMain(space: MatrixRoomDTO) {
    const main = element("section", "matrix-main");
    main.append(renderHeading(roomName(space), space.topic || "Server", space));
    const page = element("div", "matrix-page");
    const canOpenAccess = space.canConfigureSpaceAccess === true
        || space.canApproveAccessRequests === true
        || space.canDenyAccessRequests === true;
    const accessExpanded = expandedSpaceAccess.has(space.roomId);
    const narrow = element("div", "matrix-page-narrow",
        textElement("h1", "", roomName(space)),
        space.topic ? textElement("p", "matrix-subtle", space.topic) : null,
        element("div", "matrix-card-actions",
            makeButton("Message a member", "matrix-button matrix-button-primary", () => {
                overlay = "directMessage";
                scheduleRender();
            }),
            makeButton("Reload rooms", "matrix-button", () => {
                hierarchies.delete(space.roomId);
                void loadHierarchy(space.roomId);
            }),
            canOpenAccess ? makeButton(
                `${accessExpanded ? "Hide access settings" : "Access settings"}${space.accessRequestCount ? ` (${space.accessRequestCount})` : ""}`,
                "matrix-button",
                () => toggleSpaceAccess(space),
                { disabled: spaceAccessLoading === space.roomId }
            ) : null,
        ),
    );
    if (accessExpanded) narrow.append(renderSpaceAccessPanel(space));
    const hierarchy = hierarchies.get(space.roomId);
    narrow.append(textElement("h2", "", "Rooms"));
    if (hierarchyLoading === space.roomId) {
        narrow.append(textElement("p", "matrix-subtle", "Loading rooms..."));
    } else if (!hierarchy) {
        narrow.append(
            textElement("p", "matrix-subtle", "The room list has not loaded."),
            makeButton("Load rooms", "matrix-button", () => void loadHierarchy(space.roomId)),
        );
    } else {
        const grid = element("div", "matrix-grid");
        for (const hierarchyRoom of hierarchy.rooms.filter(room => room.roomId !== space.roomId && room.kind !== "space")) {
            const known = roomById(hierarchyRoom.roomId);
            const display = known ?? {
                ...space,
                roomId: hierarchyRoom.roomId,
                name: hierarchyRoom.name,
                topic: hierarchyRoom.topic,
                kind: hierarchyRoom.kind,
                roomType: hierarchyRoom.roomType,
            };
            const actions: HTMLElement[] = [];
            if (known?.membership === "join") {
                actions.push(makeButton("Open", "matrix-button matrix-button-primary", () => setRoute({
                    kind: isDirect(known) ? "dm" : "room",
                    roomId: known.roomId,
                })));
            } else if (known?.membership === "invite") {
                actions.push(makeButton("Accept invite", "matrix-button matrix-button-primary", () => void acceptInvite(known.roomId)));
            } else if (["public", "restricted", "knock_restricted"].includes(hierarchyRoom.joinRule ?? "")) {
                actions.push(makeButton("Join", "matrix-button matrix-button-primary", () => void joinRoom(hierarchyRoom.roomId)));
            }
            grid.append(roomCard(display as MatrixRoomDTO, actions));
        }
        if (!grid.childElementCount) grid.append(textElement("div", "matrix-subtle", "This server has no visible rooms."));
        narrow.append(grid);
    }
    narrow.append(textElement("h2", "", "Members"));
    const members = space.members.filter(member => member.membership === "join");
    const memberGrid = element("div", "matrix-grid");
    for (const member of members.slice(0, 100)) {
        memberGrid.append(element("div", "matrix-card",
            textElement("strong", "", member.userId === snapshot?.account?.userId ? "You" : member.displayName || member.userId),
            member.userId === snapshot?.account?.userId ? null : textElement("div", "matrix-subtle", member.userId),
        ));
    }
    narrow.append(memberGrid);
    page.append(narrow);
    main.append(page);
    return main;
}

function renderDiscoverMain() {
    const main = element("section", "matrix-main");
    main.append(renderHeading("Discover servers", "Public listings and join-name access"));
    const page = element("div", "matrix-page");
    const narrow = element("div", "matrix-page-narrow", renderSettingsTabs("discover"));

    const joinNameForm = element("form", "matrix-card matrix-form");
    joinNameForm.append(
        textElement("h2", "", "Request server access"),
        textElement("p", "matrix-subtle", "Enter the server's join name. An admin can then approve your request."),
    );
    const joinName = input("text", "joinName", "my-server", joinNameValue);
    joinName.maxLength = JOIN_NAME_MAX_LENGTH;
    joinName.dataset.focusKey = "matrix-request-access-join-name";
    joinName.disabled = joinNameBusy || joinAddressBusy;
    joinName.addEventListener("input", () => {
        joinNameValue = joinName.value.toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH);
        joinNameError = "";
        scheduleRender();
    });
    joinNameForm.append(labelledField("Server join name", joinName));
    joinNameForm.append(makeButton(joinNameBusy ? "Requesting access..." : "Request access", "matrix-button matrix-button-primary", () => {
        joinNameForm.requestSubmit();
    }, { disabled: joinNameBusy || joinAddressBusy || !joinNameValue.trim() }));
    joinNameForm.addEventListener("submit", event => {
        event.preventDefault();
        joinNameValue = joinName.value.toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH);
        void requestServerAccess(joinNameValue);
    });
    if (joinNameError) joinNameForm.append(textElement("p", "matrix-access-error", joinNameError));
    narrow.append(joinNameForm);

    const advanced = element("details", "matrix-card matrix-advanced-join");
    advanced.append(textElement("summary", "", "Advanced: join by full room address"));
    const joinForm = element("form", "matrix-form");
    joinForm.append(textElement("p", "matrix-subtle", "Use a full Matrix alias or room ID."));
    const address = input("text", "address", "#room:server.example or !roomId:server.example", joinAddressValue);
    address.dataset.focusKey = "matrix-join-address";
    address.disabled = joinAddressBusy || joinNameBusy;
    address.addEventListener("input", () => { joinAddressValue = address.value.slice(0, 512); });
    joinForm.append(labelledField("Room alias or ID", address));
    joinForm.append(makeButton(joinAddressBusy ? "Joining..." : "Join", "matrix-button matrix-button-primary", () => {
        if (joinForm.requestSubmit) joinForm.requestSubmit();
    }, { disabled: joinAddressBusy || joinNameBusy }));
    joinForm.addEventListener("submit", event => {
        event.preventDefault();
        joinAddressValue = address.value.slice(0, 512);
        void joinAddress(joinAddressValue);
    });
    advanced.append(joinForm);
    narrow.append(advanced);
    const heading = element("div", "matrix-card-actions",
        textElement("h2", "", "Public servers and chats"),
        makeButton(directoryLoading ? "Refreshing..." : "Refresh discovery", "matrix-button", () => void loadDirectory(), {
            disabled: directoryLoading,
        }),
    );
    narrow.append(heading);
    if (directoryLoading) {
        narrow.append(textElement("p", "matrix-subtle", "Fetching public listings from your provider..."));
    } else if (directory) {
        narrow.append(textElement(
            "p",
            "matrix-subtle",
            `${directory.rooms.length} listed${directory.totalRoomCountEstimate == null
                ? ""
                : ` - provider estimate: ${directory.totalRoomCountEstimate}`}.`,
        ));
        if (directory.truncated) {
            narrow.append(textElement(
                "p",
                "matrix-subtle",
                "The safe 2,000-entry scan bound was reached. This discovery list is incomplete.",
            ));
        }
    } else {
        narrow.append(textElement("p", "matrix-subtle", "Discovery has not been loaded yet."));
    }
    const filter = input("search", "directory-query", "Search public servers and chats", directoryQuery);
    filter.dataset.focusKey = "matrix-directory-query";
    filter.addEventListener("input", () => {
        directoryQuery = filter.value.slice(0, 256);
        scheduleRender();
    });
    narrow.append(labelledField("Search discovery", filter));
    if (!directory && !directoryLoading) {
        narrow.append(makeButton("Load public listings", "matrix-button matrix-button-primary", () => void loadDirectory()));
    }
    const query = directoryQuery.trim().toLocaleLowerCase();
    const visibleDirectory = (directory?.rooms ?? []).filter(room => !query
        || room.name.toLocaleLowerCase().includes(query)
        || room.alias?.toLocaleLowerCase().includes(query)
        || room.topic?.toLocaleLowerCase().includes(query));
    const grid = element("div", "matrix-grid");
    for (const publicRoom of visibleDirectory) {
        const known = roomById(publicRoom.roomId);
        const listedJoinName = publicRoom.joinRule === "knock" && publicRoom.roomType === "m.space"
            ? joinNameFromAlias(publicRoom.alias)
            : undefined;
        const copy = element("div", "matrix-card-copy",
            textElement("h3", "", publicRoom.name || publicRoom.alias || (publicRoom.roomType === "m.space" ? "Server" : "Chat")),
            publicRoom.topic ? textElement("p", "matrix-subtle", publicRoom.topic) : null,
            textElement("div", "matrix-subtle", `${publicRoom.joinedMembers} members - ${publicRoom.roomType === "m.space" ? "server" : "chat"}`),
        );
        const card = element("article", "matrix-card", element("div", "matrix-card-row", copy));
        const action = known?.membership === "join"
                ? makeButton("Open", "matrix-button", () => setRoute({
                    kind: isSpace(known) ? "space" : isDirect(known) ? "dm" : "room",
                    roomId: known.roomId,
                }))
                : publicRoom.joinRule === "knock"
                    ? listedJoinName
                        ? makeButton("Request access", "matrix-button matrix-button-primary", () => {
                            void requestServerAccess(listedJoinName, false);
                        }, { disabled: joinNameBusy || joinAddressBusy })
                        : textElement("span", "matrix-subtle", "Ask an admin for an invitation")
                    : makeButton(
                        publicRoom.roomType === "m.space" ? "Join server" : "Join",
                        "matrix-button matrix-button-primary",
                        () => void joinRoom(publicRoom.roomId),
                        { disabled: joinNameBusy || joinAddressBusy }
                    );
        card.append(element("div", "matrix-card-actions", action));
        grid.append(card);
    }
    if (directory && !visibleDirectory.length) grid.append(textElement("div", "matrix-subtle", "No public servers or chats match."));
    narrow.append(grid);
    page.append(narrow);
    main.append(page);
    return main;
}

async function logout() {
    if (!host || accountTransition || !window.confirm("Sign out of Matrix and erase this device's local Matrix session?")) return;
    const current = route();
    void stopTyping("roomId" in current ? current.roomId : undefined);
    const transition = beginAccountTransition("logout", "Signing out of Matrix...");
    try {
        await host.request({ type: "logout" });
        if (!isCurrentAccountTransition(transition)) return;
        await requestTransitionBootstrap(transition, null);
        setRoute({ kind: "home" });
    } catch (error) {
        if (accountTransition !== transition) return;
        try {
            if (await requestTransitionBootstrap(transition)) showToast(errorText(error), "error");
        } catch {
            failClosed("Matrix sign-out could not be verified safely.");
        }
    }
}

function renderAccountMain() {
    const main = element("section", "matrix-main");
    main.append(renderHeading("Matrix account", serverLabel(config?.homeserver)));
    const page = element("div", "matrix-page");
    const narrow = element("div", "matrix-page-narrow", renderSettingsTabs("account"));
    const card = element("section", "matrix-card matrix-form",
        textElement("h2", "", "Connected account"),
        labelledField("Matrix user", textElement("div", "", config?.userId || snapshot?.account?.userId || "Unknown")),
        labelledField("Homeserver", textElement("div", "", serverLabel(config?.homeserver))),
        labelledField("Status", textElement("div", "", statusText())),
        labelledField("Encryption storage", textElement("div", "", "Persistent, isolated Matrix storage")),
        element("div", "matrix-card-actions",
            makeButton("Refresh", "matrix-button", () => void refresh(true)),
            makeButton("Sign out", "matrix-button matrix-button-danger", () => void logout()),
        ),
    );
    narrow.append(
        textElement("h1", "", "Account & privacy"),
        textElement("p", "matrix-subtle", "Decrypted content is rendered only in this isolated Matrix view. The Discord renderer receives navigation metadata, not message bodies."),
        card,
    );
    page.append(narrow);
    main.append(page);
    return main;
}

function renderSecurityIndicator() {
    const connected = Boolean(security?.isolated && security.transport === "private-ipc" && security.backendConnected);
    const indicator = element("div", "matrix-security",
        element("span", "matrix-security-dot"),
        textElement("span", "", connected ? "Isolated Matrix connection" : "Isolated view - Matrix reconnecting"),
    );
    indicator.dataset.connected = String(connected);
    indicator.setAttribute("role", "status");
    return indicator;
}

function renderSettingsTabs(selected: "discover" | "account") {
    const tabs = element("div", "matrix-tabs");
    for (const [page, label] of [["account", "Account"], ["discover", "Discover"]] as const) {
        const tab = makeButton(label, "matrix-tab", () => {
            settingsPage = page;
            if (page !== "discover") {
                joinNameValue = "";
                joinNameError = "";
                joinAddressValue = "";
            }
            scheduleRender();
            if (page === "discover" && !directory && !directoryLoading) void loadDirectory();
        });
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(selected === page));
        tabs.append(tab);
    }
    return tabs;
}

function renderAuth() {
    const shell = element("div", "matrix-fatal");
    const card = element("section", "matrix-fatal-card matrix-auth-card");
    card.append(
        textElement("h1", "", "Connect Matrix"),
        textElement("p", "matrix-subtle", "Sign in here. Credentials remain inside the isolated Matrix view and private native boundary."),
    );
    const tabs = element("div", "matrix-tabs");
    for (const [mode, label] of [["login", "Sign in"], ["register", "Register"], ["token", "Access token"]] as const) {
        const tab = makeButton(label, "matrix-tab", () => {
            authMode = mode;
            scheduleRender();
        }, { disabled: authBusy });
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(authMode === mode));
        tabs.append(tab);
    }
    card.append(tabs);
    const form = element("form", "matrix-form");
    const homeserver = input("text", "homeserver", "matrix.example.org", authForm.homeserver);
    homeserver.required = true;
    homeserver.autocomplete = "off";
    homeserver.dataset.focusKey = "matrix-auth-homeserver";
    homeserver.disabled = authBusy;
    homeserver.addEventListener("input", () => { authForm.homeserver = homeserver.value.slice(0, 2_048); });
    form.append(labelledField("Homeserver", homeserver));
    if (authMode !== "token") {
        const username = input("text", "username", "username", authForm.username);
        username.required = true;
        username.autocomplete = "username";
        username.dataset.focusKey = "matrix-auth-username";
        username.disabled = authBusy;
        username.addEventListener("input", () => { authForm.username = username.value.slice(0, 512); });
        const password = input("password", "password", "Password", authForm.password);
        password.required = true;
        password.autocomplete = authMode === "register" ? "new-password" : "current-password";
        password.dataset.focusKey = "matrix-auth-password";
        password.disabled = authBusy;
        password.addEventListener("input", () => { authForm.password = password.value; });
        form.append(labelledField("Username", username), labelledField("Password", password));
        if (authMode === "register") {
            const confirm = input("password", "confirmPassword", "Confirm password", authForm.confirmPassword);
            confirm.required = true;
            confirm.autocomplete = "new-password";
            confirm.dataset.focusKey = "matrix-auth-confirm";
            confirm.disabled = authBusy;
            confirm.addEventListener("input", () => { authForm.confirmPassword = confirm.value; });
            const token = input("password", "registrationToken", "Registration token", authForm.registrationToken);
            token.required = true;
            token.dataset.focusKey = "matrix-auth-registration-token";
            token.disabled = authBusy;
            token.addEventListener("input", () => { authForm.registrationToken = token.value; });
            form.append(labelledField("Confirm password", confirm), labelledField("Registration token", token));
        }
    } else {
        const token = input("password", "accessToken", "Matrix access token", authForm.accessToken);
        token.required = true;
        token.dataset.focusKey = "matrix-auth-access-token";
        token.disabled = authBusy;
        token.addEventListener("input", () => { authForm.accessToken = token.value; });
        form.append(labelledField("Access token", token));
    }
    const submit = makeButton(authBusy ? "Working..." : authMode === "register" ? "Create account" : "Sign in", "matrix-button matrix-button-primary", () => form.requestSubmit(), {
        disabled: authBusy,
    });
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!host || authBusy || accountTransition) return;
        const mode = authMode;
        const server = normalizeHomeserver(authForm.homeserver);
        const username = authForm.username.trim();
        const { password, confirmPassword, registrationToken, accessToken } = authForm;
        if (mode === "register" && password !== confirmPassword) {
            showToast("Passwords do not match.", "error");
            return;
        }
        const transition = beginAccountTransition(mode === "register" ? "register" : "login",
            mode === "register" ? "Creating Matrix account..." : "Signing in...");
        authBusy = true;
        const operation = mode === "register"
            ? host.request({
                type: "register",
                registration: { homeserver: server, username, password, registrationToken },
            })
            : host.request({
                type: "login",
                login: mode === "token"
                    ? { homeserver: server, method: "access_token", accessToken }
                    : { homeserver: server, method: "password", username, password },
            });
        void operation.then(async result => {
            if (!isCurrentAccountTransition(transition)) return;
            const accountId = validateSnapshotIdentity(result);
            if (!accountId) throw new Error("Matrix did not return the signed-in account.");
            if (await requestTransitionBootstrap(transition, accountId)) setRoute({ kind: "home" });
        }).catch(async error => {
            if (accountTransition !== transition) return;
            try {
                if (await requestTransitionBootstrap(transition)) showToast(errorText(error), "error");
            } catch {
                failClosed("Matrix sign-in could not be verified safely.");
            }
        }).finally(() => {
            authBusy = false;
            if (accountTransition === transition) loadingLabel = "";
            scheduleRender();
        });
    });
    card.append(form, textElement("p", "matrix-subtle", "You can use a local username; the full @user:server ID is not required."));
    shell.append(card);
    return shell;
}

function renderCreateSpaceOverlay() {
    const body = element("div", "matrix-modal-body");
    const form = element("form", "matrix-form");
    const name = input("text", "name", "My server", createSpaceForm.name);
    name.required = true;
    name.maxLength = 100;
    name.dataset.focusKey = "matrix-create-space-name";
    name.disabled = spaceCreationInFlight || spaceCreationBlocked;
    name.addEventListener("input", () => { createSpaceForm.name = name.value; });
    const topic = element("textarea", "matrix-textarea");
    topic.name = "topic";
    topic.placeholder = "What is this server for?";
    topic.maxLength = 1_024;
    topic.value = createSpaceForm.topic;
    topic.dataset.focusKey = "matrix-create-space-topic";
    topic.disabled = spaceCreationInFlight || spaceCreationBlocked;
    topic.addEventListener("input", () => { createSpaceForm.topic = topic.value; });
    const visibility = element("select", "matrix-select");
    visibility.name = "visibility";
    for (const [value, label] of [["private", "Unlisted - invitation only"], ["public", "Public - listed and open to everyone"]]) {
        const option = element("option", "");
        option.value = value;
        option.textContent = label;
        visibility.append(option);
    }
    visibility.value = createSpaceForm.visibility;
    visibility.dataset.focusKey = "matrix-create-space-visibility";
    visibility.disabled = spaceCreationInFlight || spaceCreationBlocked;
    visibility.addEventListener("change", () => {
        createSpaceForm.visibility = visibility.value === "public" ? "public" : "private";
    });
    const general = element("input", "");
    general.type = "checkbox";
    general.dataset.focusKey = "matrix-create-space-general";
    general.checked = createSpaceForm.createGeneral;
    general.disabled = spaceCreationInFlight || spaceCreationBlocked;
    general.addEventListener("change", () => { createSpaceForm.createGeneral = general.checked; });
    const generalLabel = element("label", "", general, " Create a #general chat");
    form.append(
        labelledField("Server name", name),
        labelledField("Description (optional)", topic),
        labelledField("Initial access", visibility),
        textElement("p", "matrix-subtle", "Unlisted servers are not listed in your provider's public directory, but links, aliases, or parent servers may still reveal them. Admission is controlled by invitation or request; a join name is not a password."),
        textElement("p", "matrix-subtle", "After creation, use Access settings on the server page to require approval and choose a unique join name."),
        generalLabel,
    );
    const submit = makeButton(spaceCreationInFlight ? "Creating..." : "Create server", "matrix-button matrix-button-primary", () => form.requestSubmit(), {
        disabled: spaceCreationInFlight || spaceCreationBlocked,
    });
    submit.type = "submit";
    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!host || spaceCreationInFlight || spaceCreationBlocked) return;
        createSpaceForm.name = name.value.trim();
        createSpaceForm.topic = topic.value.trim();
        createSpaceForm.visibility = visibility.value === "public" ? "public" : "private";
        createSpaceForm.createGeneral = general.checked;
        const generation = uiGeneration;
        spaceCreationInFlight = true;
        scheduleRender();
        void host.request({
            type: "createSpace",
            request: {
                name: createSpaceForm.name,
                topic: createSpaceForm.topic || undefined,
                visibility: createSpaceForm.visibility,
                createGeneral: createSpaceForm.createGeneral,
            },
        }).then(async result => {
            if (generation !== uiGeneration) return;
            overlay = null;
            await refresh();
            if (generation !== uiGeneration) return;
            Object.assign(createSpaceForm, { name: "", topic: "", visibility: "private" as const, createGeneral: true });
            setRoute({ kind: "space", roomId: result.roomId });
            if (result.partial) showToast(result.partial.message, "error");
        }).catch(async error => {
            if (generation !== uiGeneration) return;
            if (errorCode(error) === "MATRIX_CREATE_SPACE_AMBIGUOUS"
                || errorText(error).includes("MATRIX_CREATE_SPACE_AMBIGUOUS")
                || errorText(error).includes("may have succeeded")) {
                spaceCreationBlocked = true;
                overlay = null;
                scheduleRender();
                await refresh(false);
                if (generation !== uiGeneration) return;
                showToast("Matrix could not confirm the result. Verify the refreshed server list before creating again, then press Refresh.", "error");
                return;
            }
            showToast(errorText(error), "error");
        }).finally(() => {
            if (generation === uiGeneration) spaceCreationInFlight = false;
            scheduleRender();
        });
    });
    body.append(form);
    return renderModal("Create a server", body, [submit]);
}

function setSelectOptions(select: HTMLSelectElement, values: Array<{ value: string; label: string; }>) {
    select.replaceChildren();
    for (const value of values) {
        const option = element("option", "");
        option.value = value.value;
        option.textContent = value.label;
        select.append(option);
    }
}

function renderDirectMessageOverlay() {
    const body = element("div", "matrix-modal-body");
    const form = element("form", "matrix-form");
    const spaces = joinedRooms().filter(isSpace);
    const spaceSelect = element("select", "matrix-select");
    const memberSelect = element("select", "matrix-select");
    setSelectOptions(spaceSelect, spaces.map(space => ({ value: space.roomId, label: roomName(space) })));
    const current = route();
    if (!directMessageSpaceId || !spaces.some(space => space.roomId === directMessageSpaceId)) {
        directMessageSpaceId = current.kind === "space" && spaces.some(space => space.roomId === current.roomId)
            ? current.roomId
            : spaces[0]?.roomId ?? "";
    }
    spaceSelect.value = directMessageSpaceId;
    spaceSelect.dataset.focusKey = "matrix-dm-space";
    spaceSelect.disabled = directMessageBusy;
    function updateMembers() {
        const space = roomById(directMessageSpaceId);
        const members = (space?.members ?? []).filter(member => member.membership === "join"
            && member.userId !== snapshot?.account?.userId);
        setSelectOptions(memberSelect, members.map(member => ({
            value: member.userId,
            label: member.displayName ? `${member.displayName} (${member.userId})` : member.userId,
        })));
        if (!members.some(member => member.userId === directMessageUserId)) {
            directMessageUserId = members[0]?.userId ?? "";
        }
        memberSelect.value = directMessageUserId;
    }
    updateMembers();
    memberSelect.dataset.focusKey = "matrix-dm-member";
    memberSelect.disabled = directMessageBusy;
    spaceSelect.addEventListener("change", () => {
        directMessageSpaceId = spaceSelect.value;
        directMessageUserId = "";
        scheduleRender();
    });
    memberSelect.addEventListener("change", () => { directMessageUserId = memberSelect.value; });
    form.append(labelledField("Server", spaceSelect), labelledField("Member", memberSelect));
    const submit = makeButton(directMessageBusy ? "Opening..." : "Open direct message", "matrix-button matrix-button-primary", () => form.requestSubmit(), {
        disabled: !spaces.length || !directMessageUserId || directMessageBusy,
    });
    submit.type = "submit";
    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!host || !directMessageSpaceId || !directMessageUserId || directMessageBusy) return;
        const generation = uiGeneration;
        directMessageBusy = true;
        scheduleRender();
        void host.request({
            type: "openDirectMessage",
            spaceId: directMessageSpaceId,
            userId: directMessageUserId,
        }).then(async result => {
            if (generation !== uiGeneration) return;
            overlay = null;
            await refresh();
            if (generation !== uiGeneration) return;
            directMessageSpaceId = "";
            directMessageUserId = "";
            setRoute({ kind: "dm", roomId: result.roomId });
        }).catch(error => {
            if (generation === uiGeneration) showToast(errorText(error), "error");
        }).finally(() => {
            if (generation === uiGeneration) directMessageBusy = false;
            scheduleRender();
        });
    });
    body.append(form);
    return renderModal("Start a private Matrix chat", body, [submit]);
}

function renderModal(title: string, body: HTMLElement, footerActions: HTMLElement[] = []) {
    const overlayElement = element("div", "matrix-overlay");
    overlayElement.setAttribute("role", "presentation");
    const modal = element("section", "matrix-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", title);
    modal.append(element("header", "matrix-modal-header",
        textElement("h2", "", title),
        makeButton("Close", "matrix-icon-button", () => {
            overlay = null;
            scheduleRender();
        }, { ariaLabel: "Close" }),
    ), body);
    if (footerActions.length) modal.append(element("footer", "matrix-modal-footer", ...footerActions));
    overlayElement.append(modal);
    overlayElement.addEventListener("mousedown", event => {
        if (event.target === overlayElement) {
            overlay = null;
            scheduleRender();
        }
    });
    return overlayElement;
}

function renderSearchOverlay() {
    const body = element("div", "matrix-modal-body");
    const form = element("form", "matrix-form");
    const search = input("search", "query", "Search Matrix messages", searchQuery);
    search.dataset.focusKey = "matrix-search";
    search.maxLength = 256;
    search.addEventListener("input", () => {
        const nextQuery = search.value.slice(0, 256);
        if (nextQuery !== searchQuery) {
            searchQuery = nextQuery;
            searchGeneration++;
            searchLoading = false;
            searchResults = [];
            searchCursor = undefined;
            searchStatus = "";
            searchScopeIdentity = undefined;
        }
    });
    const submit = makeButton(searchLoading ? "Searching..." : "Search", "matrix-button matrix-button-primary", () => form.requestSubmit(), {
        disabled: searchLoading,
    });
    submit.type = "submit";
    form.append(labelledField("Search messages", search), submit);
    form.addEventListener("submit", event => {
        event.preventDefault();
        searchQuery = search.value.slice(0, 256);
        searchResults = [];
        searchCursor = undefined;
        void runSearch();
    });
    body.append(form, textElement("div", "matrix-subtle", searchStatus));
    const results = element("div", "matrix-search-results");
    for (const result of searchResults) {
        const control = element("button", "matrix-search-result");
        control.type = "button";
        control.append(
            element("div", "matrix-message-heading",
                textElement("strong", "", result.message.senderId === snapshot?.account?.userId
                    ? "You"
                    : result.message.senderName || result.message.senderId),
                textElement("span", "matrix-subtle", result.roomName),
                textElement("time", "matrix-time", formatTime(result.message.timestamp)),
            ),
            textElement("div", "matrix-search-result-body", result.message.body || result.message.attachments?.[0]?.name || "Attachment"),
        );
        control.addEventListener("click", () => jumpToSearchResult(result));
        results.append(control);
    }
    if (!searchLoading && searchStatus && !searchResults.length) {
        results.append(textElement("div", "matrix-empty", "No matching messages."));
    }
    if (searchCursor) {
        results.append(makeButton("Load more", "matrix-button", () => void runSearch(true), { disabled: searchLoading }));
    }
    body.append(results);
    return renderModal("Search Matrix", body);
}

function renderToastRegion() {
    const region = element("div", "matrix-toast-region");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    for (const toast of toasts) {
        const item = textElement("div", "matrix-toast", toast.text);
        item.dataset.tone = toast.tone;
        region.append(item);
    }
    return region;
}

function renderFatal(message: string) {
    const shell = element("div", "matrix-fatal");
    shell.append(element("section", "matrix-fatal-card",
        textElement("h1", "", "Matrix isolation unavailable"),
        textElement("p", "matrix-subtle", message),
        textElement("p", "matrix-subtle", "No Matrix messages are being rendered in Discord's normal message view."),
        host ? makeButton(
            fatalRecoveryBusy ? "Reconnecting..." : "Retry secure connection",
            "matrix-button matrix-button-primary",
            () => void retrySecureConnection(),
            { disabled: fatalRecoveryBusy },
        ) : null,
    ));
    return shell;
}

function renderLoading() {
    return element("div", "matrix-fatal",
        element("section", "matrix-fatal-card",
            textElement("h1", "", "Isolated Matrix view"),
            textElement("p", "matrix-subtle", loadingLabel || "Loading Matrix..."),
        ),
    );
}

function renderMain() {
    const current = route();
    if (current.kind === "home") return renderHomeMain();
    if (current.kind === "settings") return settingsPage === "discover" ? renderDiscoverMain() : renderAccountMain();
    const room = roomById(current.roomId);
    if (!room) {
        const main = element("section", "matrix-main");
        main.append(renderHeading("Matrix room"), element("div", "matrix-empty", "This room is not available in the current sync."));
        return main;
    }
    return current.kind === "space" || isSpace(room) ? renderSpaceMain(room) : renderRoomMain(room);
}

function render() {
    const previousTimeline = root.querySelector<HTMLElement>(".matrix-timeline");
    const previousTimelineRoomId = previousTimeline?.dataset.roomId;
    const previousScrollTop = previousTimeline?.scrollTop ?? 0;
    const previousBottomDistance = previousTimeline
        ? previousTimeline.scrollHeight - previousTimeline.scrollTop - previousTimeline.clientHeight
        : 0;
    if (previousTimelineRoomId) {
        timelineAtBottomByRoom.set(previousTimelineRoomId, previousBottomDistance < 80);
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusKey = active?.dataset.focusKey;
    const selectionStart = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.selectionStart
        : null;
    const selectionEnd = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.selectionEnd
        : null;

    let content: HTMLElement;
    let renderState: "loading" | "error" | "auth" | "main";
    if (!host) {
        content = renderFatal("The private Matrix preload did not start. Restart Discord after rebuilding the plugin.");
        renderState = "error";
    } else if (fatalMessage) {
        content = renderFatal(fatalMessage);
        renderState = "error";
    } else if (!bootstrap) {
        content = renderLoading();
        renderState = "loading";
    } else if (!config?.configured) {
        content = renderAuth();
        renderState = "auth";
    } else {
        content = renderMain();
        content.classList.add("matrix-embedded");
        renderState = "main";
    }
    root.dataset.state = renderState;
    content.dataset.state = renderState;
    root.replaceChildren(content, renderToastRegion());
    const toastRegion = root.querySelector(".matrix-toast-region");
    if (overlay && config?.configured && !fatalMessage) {
        root.append(overlay === "search"
            ? renderSearchOverlay()
            : overlay === "createSpace" ? renderCreateSpaceOverlay() : renderDirectMessageOverlay());
    }
    if (config?.configured && !fatalMessage && (status?.state === "error" || status?.state === "stopped")) {
        const connectionProblem = element(
            "div",
            "matrix-toast",
            `${statusText()} `,
            makeButton("Retry connection", "matrix-button", () => void refresh(true), {
                disabled: Boolean(loadingLabel),
            }),
        );
        connectionProblem.dataset.tone = "error";
        connectionProblem.setAttribute("role", "alert");
        toastRegion?.append(connectionProblem);
    }
    if (loadingLabel && bootstrap && config?.configured) {
        const progress = textElement("div", "matrix-toast", loadingLabel);
        progress.setAttribute("role", "status");
        toastRegion?.append(progress);
    }
    const nextTimeline = root.querySelector<HTMLElement>(".matrix-timeline");
    if (previousTimeline && nextTimeline && previousTimelineRoomId
        && previousTimelineRoomId === nextTimeline.dataset.roomId) {
        nextTimeline.scrollTop = previousBottomDistance < 80
            ? nextTimeline.scrollHeight
            : Math.min(previousScrollTop, Math.max(0, nextTimeline.scrollHeight - nextTimeline.clientHeight));
        timelineAtBottomByRoom.set(previousTimelineRoomId, previousBottomDistance < 80);
    }
    if (focusKey) {
        const next = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
        next?.focus({ preventScroll: true });
        if (next && selectionStart != null && selectionEnd != null) {
            next.setSelectionRange(selectionStart, selectionEnd);
        }
    }
    for (const [key, target] of viewportElements) {
        if (!target.isConnected) disarmViewportTask(key);
    }
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape" && overlay) {
        event.preventDefault();
        overlay = null;
        scheduleRender();
    }
});

window.addEventListener("focus", () => markLatestRead());

let unsubscribe = () => { };

if (!host) {
    fatalMessage = "The isolated Matrix host is unavailable.";
    render();
} else {
    unsubscribe = host.onEvent(handleHostEvent);
    host.ready();
    void host.request({ type: "bootstrap" }).then(next => {
        try {
            applyBootstrap(next);
        } catch {
            failClosed();
        }
    }).catch(error => {
        enterRecoverableFatal(`The private Matrix backend did not answer: ${errorText(error)}`);
    });
    setTimeout(() => {
        if (!bootstrap && !fatalMessage) {
            fatalMessage = "The private Matrix backend did not answer in time.";
            scheduleRender();
        }
    }, 15_000);
    render();
}

window.addEventListener("beforeunload", () => {
    unsubscribe();
    clearSensitiveUiState();
    const current = route();
    void stopTyping("roomId" in current ? current.roomId : undefined);
});
