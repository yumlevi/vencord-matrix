/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings as useVencordSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    Checkbox,
    ConfirmModal,
    Modal,
    openModal,
    Select,
    TabBar,
    TextArea,
    TextInput,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "@webpack/common";

import {
    clearMatrixRoutePreference,
    getLatestSnapshot,
    getMatrixGroupInviteContextForRoom,
    Native,
    openMatrixDirect,
    openMatrixRoom,
    openMatrixSpace,
    refreshSnapshot,
    registerMatrixManagementModal,
    restartBridge,
    subscribeMatrixSpaceProjection,
    unregisterMatrixManagementModal,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";
import { openMatrixGroupChatCreate } from "./groupCreate";
import { openMatrixGroupInviteForRoom } from "./groupInvite";
import {
    suggestedChannelConsentRows,
    suggestedChannelJoinSummary,
    suggestedChannelPlanDisclosure,
    waitForSuggestedChannelPlan,
} from "./suggestedChannels";
import type {
    MatrixConfigureSpaceAccessResult,
    MatrixCreateSpaceResult,
    MatrixDeviceVerificationStatusDTO,
    MatrixJoinSuggestedSpaceChannelsResult,
    MatrixMemberDTO,
    MatrixPublicRoomDirectoryDTO,
    MatrixPublicRoomDTO,
    MatrixRequestSpaceAccessResult,
    MatrixRoomDTO,
    MatrixSpaceAccessMode,
    MatrixSpaceAccessRequestListDTO,
    MatrixSpaceAccessSummaryDTO,
    MatrixSpaceHierarchyDTO,
    MatrixSpaceHierarchyRoomDTO,
    MatrixSuggestedSpaceChannelPlanDTO,
} from "./types";

type AuthMode = "login" | "register";
type SettingsTab = "rooms" | "discover" | "account";
type MatrixRoomLike = MatrixRoomDTO | MatrixSpaceHierarchyRoomDTO;
type MatrixSpaceVisibility = "private" | "public";
type MatrixSpaceCreationPhase = "idle" | "creating" | "syncing" | "checking";
type MatrixSpaceAccessDraft = Pick<MatrixSpaceAccessSummaryDTO, "mode"> & { joinName: string; };

type MatrixDeviceVerificationPhase = NonNullable<MatrixDeviceVerificationStatusDTO["verification"]>["phase"] | "idle";

const ACTIVE_DEVICE_VERIFICATION_PHASES = new Set<MatrixDeviceVerificationPhase>([
    "requested",
    "ready",
    "verifying",
    "sas",
    "confirming",
]);

const JOIN_NAME_MAX_LENGTH = 64;
const JOIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const MATRIX_ROOM_ADDRESS_PATTERN = /^(?:#[^\s:]+:[^\s]+|![^\s:]+(?::[^\s]+)?)$/u;
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const MATRIX_SESSION_RESET_CODES = new Set([
    "MATRIX_SESSION_RESET_REQUIRED",
    // Older installed workers did not distinguish soft logout. Treat these as
    // destructive-only because the renderer cannot prove same-device repair is safe.
    "M_UNKNOWN_TOKEN",
    "M_MISSING_TOKEN",
]);

let matrixSpaceCreationInFlight = false;
let matrixSpaceCreationNeedsRefresh = false;

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function deviceVerificationError(status: MatrixDeviceVerificationStatusDTO | undefined) {
    const value: unknown = status?.verification?.error;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value
        && typeof (value as { message?: unknown; }).message === "string") {
        return (value as { message: string; }).message;
    }
    return status?.verification?.phase === "failed" ? "Matrix could not complete device verification." : "";
}

function deviceVerificationLabel(status: MatrixDeviceVerificationStatusDTO | undefined) {
    if (!status) return "Checking device trust";
    if (status.verified) return "Verified";
    switch (status.verification?.phase ?? "idle") {
        case "requested": return "Waiting for another device";
        case "ready": return "Devices ready";
        case "verifying": return "Verification in progress";
        case "sas": return "Security code ready";
        case "confirming": return "Finishing verification";
        case "done": return "Verification finished";
        case "cancelled": return "Verification cancelled";
        case "failed": return "Verification failed";
        case "idle": return "Not verified";
    }
}

function deviceVerificationExplanation(status: MatrixDeviceVerificationStatusDTO | undefined) {
    if (!status) return "Checking whether this Matrix device is trusted.";
    if (status.verified) {
        return "Matrix has confirmed this device as verified. Its encrypted messages can be trusted by your other verified devices.";
    }
    switch (status.verification?.phase ?? "idle") {
        case "requested":
            return "The request is waiting for another trusted Matrix device. Open that device and accept the verification request.";
        case "ready":
            return "Both devices accepted the request. The native Matrix comparison dialog is preparing the security code.";
        case "verifying":
            return "The devices are preparing a secure comparison. Keep both devices open.";
        case "sas":
            return "The security code is ready in the native Matrix comparison dialog. It is intentionally never shown in Discord settings.";
        case "confirming":
            return "Matrix is confirming the comparison with the other device. Keep both devices open.";
        case "done":
            return "The comparison finished, but Matrix has not confirmed this device as verified yet. Refresh before trying again.";
        case "cancelled":
            return "Verification was cancelled. No device trust was changed.";
        case "failed":
            return "Verification did not complete. Review the error below, then try again.";
        case "idle":
            return status.crossSigningAvailable
                ? "Compare this device with another trusted Matrix device to verify it."
                : "Cross-signing is not available for this account yet, so Matrix cannot start device verification from this session.";
    }
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        void operation.catch(() => undefined);
        throw new Error("The operation timed out.");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("The operation timed out.")), remaining);
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

function statusLabel(status: any) {
    if (!status) return "Not configured";
    const state = status.state ?? status.status ?? status.connectionState;
    const code = status.error?.code;
    const causeCode = matrixErrorCode({ code: status.error?.causeCode });
    const detail = status.error?.message ?? status.error ?? status.message;
    const cause = causeCode && causeCode !== code ? `cause ${causeCode}` : undefined;
    return [state, code, cause, detail].filter(Boolean).join(" - ") || "Not configured";
}

function matrixAccountActionRequired(status: any) {
    const code = matrixErrorCode(status?.error);
    return code === "MATRIX_REAUTH_REQUIRED"
        || (code != null && MATRIX_SESSION_RESET_CODES.has(code));
}

function normalizedHomeserver(value: string) {
    const trimmed = value.trim();
    return /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function matrixServerName(identifier: unknown) {
    if (typeof identifier !== "string") return undefined;
    const separator = identifier.indexOf(":");
    return separator > 0 && separator < identifier.length - 1
        ? identifier.slice(separator + 1)
        : undefined;
}

function matrixLocalpart(identifier: unknown) {
    if (typeof identifier !== "string") return undefined;
    const match = /^@([^\s:]+):[^\s]+$/u.exec(identifier);
    return match?.[1];
}

function cleanJoinName(value: string) {
    return value.trim().toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH);
}

function validJoinName(value: string) {
    return JOIN_NAME_PATTERN.test(value);
}

function joinNameFromAlias(alias: string | undefined, expectedServer: string | undefined) {
    if (!alias?.startsWith("#")) return undefined;
    const separator = alias.indexOf(":");
    if (separator < 2 || separator === alias.length - 1) return undefined;
    if (expectedServer && alias.slice(separator + 1) !== expectedServer) return undefined;
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

function accessResultNotice(result: MatrixRequestSpaceAccessResult) {
    switch (result.membership) {
        case "knock": return "Your access request is pending approval.";
        case "invite": return "Access was approved. Accept the server invitation under Chats & servers.";
        case "join": return "You already have access to this server.";
    }
}

function roomName(room: MatrixRoomLike) {
    return room.name?.trim() || room.roomId;
}

function roomMembership(room: MatrixRoomLike) {
    return (room as MatrixRoomLike & { membership?: string; }).membership;
}

function roomKind(room: MatrixRoomLike): "space" | "room" | "dm" {
    const { kind } = room as MatrixRoomLike & { kind?: string; };
    if (kind === "space" || kind === "dm") return kind;
    if ((room as MatrixRoomLike & { roomType?: string; }).roomType === "m.space") return "space";
    if ((room as MatrixRoomDTO).directUserId) return "dm";
    return "room";
}

function canJoinFromHierarchy(room: MatrixSpaceHierarchyRoomDTO) {
    return room.joinRule === "public"
        || room.joinRule === "restricted"
        || room.joinRule === "knock_restricted";
}

function isHierarchyChild(hierarchy: MatrixSpaceHierarchyDTO, roomId: string) {
    return hierarchy.rooms.some(parent => parent.spaceChildren.some(child => child.roomId === roomId));
}

function snapshotRooms() {
    return (getLatestSnapshot()?.rooms ?? []) as MatrixRoomDTO[];
}

function isCurrentAccount(expectedUserId: string) {
    return getLatestSnapshot()?.account?.userId === expectedUserId;
}

function hierarchyRows(hierarchy: MatrixSpaceHierarchyDTO | undefined, spaceId: string) {
    if (!hierarchy) return [];
    const byId = new Map(hierarchy.rooms.map(room => [room.roomId, room]));
    const seen = new Set([spaceId]);
    const rows: Array<{ room: MatrixSpaceHierarchyRoomDTO; depth: number; }> = [];

    function visit(parentId: string, depth: number) {
        if (depth > 16) return;
        const parent = byId.get(parentId);
        for (const child of parent?.spaceChildren ?? []) {
            const room = byId.get(child.roomId);
            if (!room || seen.has(room.roomId)) continue;
            seen.add(room.roomId);
            rows.push({ room, depth });
            visit(room.roomId, depth + 1);
        }
    }

    visit(spaceId, 0);
    for (const room of hierarchy.rooms) {
        if (seen.has(room.roomId)) continue;
        seen.add(room.roomId);
        rows.push({ room, depth: 0 });
    }
    return rows;
}

function RoomIdentity({ room }: { room: MatrixRoomLike; }) {
    const kind = roomKind(room);
    return (
        <div className="vc-matrix-room-identity">
            <div className="vc-matrix-room-heading">
                <Heading tag="h5">{roomName(room)}</Heading>
                <span className={`vc-matrix-kind vc-matrix-kind-${kind}`}>
                    {kind === "dm" ? "Direct message" : kind === "space" ? "Server" : "Room"}
                </span>
            </div>
            <div className="vc-matrix-room-id">{room.roomId}</div>
            {room.topic && <Paragraph>{room.topic}</Paragraph>}
        </div>
    );
}

type SuggestedChannelReplanReason = "ambiguous" | "stale";

function useMatrixProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
}

function SuggestedChannelsModal({
    modalProps,
    initialPlan,
    expectedUserId,
    onJoined,
}: {
    modalProps: RenderModalProps;
    initialPlan: MatrixSuggestedSpaceChannelPlanDTO;
    expectedUserId: string;
    onJoined: (result: MatrixJoinSuggestedSpaceChannelsResult) => Promise<void>;
}) {
    useMatrixProjectionRevision();
    const [plan, setPlan] = useState(initialPlan);
    const [busy, setBusy] = useState(false);
    const [replanReason, setReplanReason] = useState<SuggestedChannelReplanReason>();
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const current = isCurrentAccount(expectedUserId);
    const rows = suggestedChannelConsentRows(plan);
    const actionableCount = rows.filter(row => row.actionable).length;

    useEffect(() => () => {
        mounted.current = false;
    }, []);

    async function refreshDisplayedPlan(reason: SuggestedChannelReplanReason, previousPlanId: string) {
        if (reason === "ambiguous") {
            try {
                await refreshSnapshot();
            } catch {
                // The exact-account plan read below is still required before
                // another confirmation can become available.
            }
        }
        if (!isCurrentAccount(expectedUserId)) return;
        try {
            const nextPlan = await Native.suggestedSpaceChannelPlan(plan.spaceId, expectedUserId);
            if (!mounted.current || !isCurrentAccount(expectedUserId)) return;
            if (reason === "ambiguous" && nextPlan.planId === previousPlanId) {
                setReplanReason("ambiguous");
                setError("The previous join is still unconfirmed. Refresh suggestions later before trying again.");
                return;
            }
            setPlan(nextPlan);
            setReplanReason(undefined);
            setError("");
            setMessage(reason === "ambiguous"
                ? "The previous join could not be confirmed. Review this refreshed list before confirming again."
                : "Suggestions changed. Review this refreshed list before confirming again.");
        } catch {
            if (!mounted.current || !isCurrentAccount(expectedUserId)) return;
            setReplanReason(reason);
            setError(reason === "ambiguous"
                ? "The previous join is unconfirmed and suggestions could not be refreshed. Try refreshing suggestions later."
                : "Suggestions changed but could not be refreshed. Try refreshing suggestions again.");
        }
    }

    async function performPrimaryAction() {
        if (busy || !current) return;
        const displayedPlan = plan;
        setBusy(true);
        setError("");
        try {
            if (replanReason) {
                await refreshDisplayedPlan(replanReason, displayedPlan.planId);
                return;
            }
            if (!actionableCount) return;
            const result = await Native.joinSuggestedSpaceChannels({
                spaceId: displayedPlan.spaceId,
                planId: displayedPlan.planId,
            }, expectedUserId);
            if (!mounted.current || !isCurrentAccount(expectedUserId)) return;
            modalProps.onClose();
            await onJoined(result);
        } catch (caught) {
            if (!mounted.current || !isCurrentAccount(expectedUserId)) return;
            const code = matrixErrorCode(caught);
            if (code === "MATRIX_SUGGESTED_SPACE_CHANNEL_PLAN_STALE") {
                await refreshDisplayedPlan("stale", displayedPlan.planId);
            } else if (code === "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS") {
                await refreshDisplayedPlan("ambiguous", displayedPlan.planId);
            } else {
                setError("The account provider could not join these suggested channels. No unconfirmed retry was started.");
            }
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    const primaryLabel = busy
        ? replanReason ? "Refreshing..." : "Joining..."
        : replanReason ? "Refresh suggestions"
            : actionableCount ? "Join suggested channels" : "Nothing to join";
    return (
        <Modal
            {...modalProps}
            onClose={busy ? () => undefined : modalProps.onClose}
            title="Join Suggested Channels?"
            subtitle="Review the exact provider suggestion list before joining."
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    disabled: busy,
                    onClick: modalProps.onClose,
                },
                {
                    text: primaryLabel,
                    variant: "primary",
                    disabled: busy || !current || (!actionableCount && !replanReason),
                    onClick: () => void performPrimaryAction(),
                },
            ]}
        >
            <div className="vc-matrix-section-stack">
                <Paragraph>{suggestedChannelPlanDisclosure(plan)}</Paragraph>
                {!current && (
                    <div className="vc-matrix-error" role="alert">
                        The signed-in account changed. Close this window and try again.
                    </div>
                )}
                {message && <div className="vc-matrix-invite-notice" role="status">{message}</div>}
                {error && <div className="vc-matrix-error" role="alert">{error}</div>}
                <div className="vc-matrix-card-list" role="list" aria-label="Suggested channels">
                    {rows.map(row => (
                        <div className="vc-matrix-room-card" role="listitem" key={row.key}>
                            <div className="vc-matrix-room-identity">
                                <div className="vc-matrix-room-heading">
                                    <Heading tag="h5">{row.name}</Heading>
                                    <span className={`vc-matrix-kind vc-matrix-kind-${row.kindLabel === "Category" ? "space" : "room"}`}>
                                        {row.kindLabel}
                                    </span>
                                </div>
                                {row.parentLabel && <Paragraph>Under Category: {row.parentLabel}</Paragraph>}
                                {row.topic && <Paragraph>{row.topic}</Paragraph>}
                                <Paragraph>{row.status}</Paragraph>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </Modal>
    );
}

function openSuggestedChannelsModal(
    plan: MatrixSuggestedSpaceChannelPlanDTO,
    expectedUserId: string,
    onJoined: (result: MatrixJoinSuggestedSpaceChannelsResult) => Promise<void>
) {
    if (!isCurrentAccount(expectedUserId) || !plan.channels.some(channel => channel.membership === "leave")) return false;
    let modalKey = "";
    modalKey = openModal(
        modalProps => (
            <SuggestedChannelsModal
                modalProps={modalProps}
                initialPlan={plan}
                expectedUserId={expectedUserId}
                onJoined={onJoined}
            />
        ),
        { onCloseCallback: () => unregisterMatrixManagementModal(modalKey) }
    );
    registerMatrixManagementModal(modalKey);
    return true;
}

function MemberSelect({
    disabled,
    members,
    selected,
    onSelect,
}: {
    disabled: boolean;
    members: MatrixMemberDTO[];
    selected: string;
    onSelect(value: string): void;
}) {
    return (
        <Select
            placeholder={members.length ? "Choose a member" : "No members available"}
            options={members.map(member => ({
                label: member.displayName?.trim()
                    ? `${member.displayName} (${member.userId})`
                    : member.userId,
                value: member.userId,
            }))}
            maxVisibleItems={8}
            closeOnSelect={true}
            select={onSelect}
            isSelected={value => value === selected}
            serialize={value => value}
            isDisabled={disabled || members.length === 0}
        />
    );
}

function CreateMatrixServerModal({
    modalProps,
    expectedUserId,
    onCreationAmbiguous,
    onCreationContextChanged,
    onCreationFailed,
    onCreationStarted,
    onCreated,
}: {
    modalProps: RenderModalProps;
    expectedUserId: string;
    onCreationAmbiguous(name: string): Promise<boolean>;
    onCreationContextChanged(name: string): void;
    onCreationFailed(): void;
    onCreationStarted(): void;
    onCreated(result: MatrixCreateSpaceResult, name: string): Promise<boolean>;
}) {
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [visibility, setVisibility] = useState<MatrixSpaceVisibility>("private");
    const [createGeneral, setCreateGeneral] = useState(true);
    const [phase, setPhase] = useState<MatrixSpaceCreationPhase>("idle");
    const [createError, setCreateError] = useState("");
    const createStarted = useRef(false);
    const cleanName = name.trim();
    const busy = phase !== "idle";

    async function createServer() {
        if (!cleanName || busy || createStarted.current) return;
        if (!isCurrentAccount(expectedUserId)) {
            setCreateError("The signed-in account changed. Close this window and try again.");
            return;
        }
        if (matrixSpaceCreationInFlight || matrixSpaceCreationNeedsRefresh) {
            setCreateError(matrixSpaceCreationNeedsRefresh
                ? "Refresh your server list before trying another creation."
                : "Another server is already being created.");
            return;
        }
        createStarted.current = true;
        matrixSpaceCreationInFlight = true;
        onCreationStarted();
        setPhase("creating");
        setCreateError("");
        let result: MatrixCreateSpaceResult;
        try {
            result = await Native.createSpace({
                name: cleanName,
                topic: topic.trim() || undefined,
                visibility,
                createGeneral,
            }, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) {
                matrixSpaceCreationInFlight = false;
                matrixSpaceCreationNeedsRefresh = true;
                onCreationContextChanged(cleanName);
                modalProps.onClose();
                return;
            }
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) {
                matrixSpaceCreationInFlight = false;
                matrixSpaceCreationNeedsRefresh = true;
                onCreationContextChanged(cleanName);
                modalProps.onClose();
                return;
            }
            if (matrixErrorCode(caught) === "MATRIX_CREATE_SPACE_AMBIGUOUS") {
                setPhase("checking");
                let resolved = false;
                try {
                    resolved = await onCreationAmbiguous(cleanName);
                } finally {
                    matrixSpaceCreationInFlight = false;
                    matrixSpaceCreationNeedsRefresh = !resolved;
                    modalProps.onClose();
                }
                return;
            }
            createStarted.current = false;
            matrixSpaceCreationInFlight = false;
            onCreationFailed();
            setCreateError(errorMessage(caught));
            setPhase("idle");
            return;
        }

        // The server exists after createSpace resolves. Never re-enable Create
        // if the subsequent /sync projection is slow or temporarily fails.
        setPhase("syncing");
        let projected = false;
        try {
            projected = await onCreated(result, cleanName);
        } finally {
            matrixSpaceCreationInFlight = false;
            matrixSpaceCreationNeedsRefresh = !projected;
            modalProps.onClose();
        }
    }

    return (
        <Modal
            {...modalProps}
            title="Create a server"
            subtitle="It will appear beside your other Discord servers."
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    disabled: busy,
                    onClick: modalProps.onClose,
                },
                {
                    text: phase === "creating"
                        ? "Creating..."
                        : phase === "syncing"
                            ? "Waiting for sync..."
                            : phase === "checking" ? "Checking..." : "Create server",
                    variant: "primary",
                    disabled: busy || !cleanName,
                    onClick: () => void createServer(),
                },
            ]}
        >
            <div className="vc-matrix-create-server">
                <label>
                    <Heading tag="h5">Server name</Heading>
                    <TextInput
                        autoFocus
                        disabled={busy}
                        value={name}
                        placeholder="My server"
                        maxLength={100}
                        onChange={value => {
                            setName(value.slice(0, 100));
                            setCreateError("");
                        }}
                        onKeyDown={event => {
                            if (event.key === "Enter") void createServer();
                        }}
                    />
                </label>
                <label>
                    <Heading tag="h5">Description <span className="vc-matrix-optional">Optional</span></Heading>
                    <TextArea
                        autosize
                        disabled={busy}
                        value={topic}
                        placeholder="What is this server for?"
                        maxLength={1_024}
                        onChange={value => {
                            setTopic(value.slice(0, 1_024));
                            setCreateError("");
                        }}
                    />
                </label>
                <label>
                    <Heading tag="h5">Who can join?</Heading>
                    <Select
                        options={[
                            {
                                label: "Unlisted - invitation only",
                                value: "private" as const,
                            },
                            {
                                label: "Public - listed and open to everyone",
                                value: "public" as const,
                            },
                        ]}
                        closeOnSelect={true}
                        select={value => {
                            setVisibility(value);
                            setCreateError("");
                        }}
                        isSelected={value => value === visibility}
                        serialize={value => value}
                        isDisabled={busy}
                    />
                    <Paragraph className="vc-matrix-field-help">
                        {visibility === "private"
                            ? "This server will not be listed in your provider's public directory, but links, aliases, or parent servers may still reveal it. Admission is controlled by invitation or request; a join name is not a password."
                            : "This server will appear in discovery and anyone can join."}
                    </Paragraph>
                    <Paragraph className="vc-matrix-field-help">
                        After creation, use Access settings on the server card to require approval and choose a unique join name.
                    </Paragraph>
                </label>
                <Checkbox
                    value={createGeneral}
                    disabled={busy}
                    size={20}
                    onChange={(_, value) => {
                        setCreateGeneral(value);
                        setCreateError("");
                    }}
                >
                    <span className="vc-matrix-checkbox-copy">
                        <strong>Create a general chat</strong>
                        <span>
                            {visibility === "private"
                                ? "Start with a #general chat for invited server members."
                                : "Start with a #general chat that is reached through this server and is not listed separately."}
                        </span>
                    </span>
                </Checkbox>
                {(phase === "syncing" || phase === "checking") && (
                    <Paragraph className="vc-matrix-form-status" role="status" aria-live="polite">
                        {phase === "syncing"
                            ? "Server created. Waiting for it to appear in Discord..."
                            : "The request timed out. Checking whether the server was created..."}
                    </Paragraph>
                )}
                {createError && (
                    <Paragraph className="vc-matrix-form-error" role="alert">
                        Could not create the server: {createError}
                    </Paragraph>
                )}
            </div>
        </Modal>
    );
}

export function MatrixSettings() {
    const matrixBridgeSettings = useVencordSettings([
        "plugins.MatrixBridge.encryptedRoomProviderPreviews" as any,
    ]).plugins.MatrixBridge as { encryptedRoomProviderPreviews?: boolean; };
    const [tab, setTab] = useState<SettingsTab>("rooms");
    const [mode, setMode] = useState<AuthMode>("login");
    const [homeserver, setHomeserver] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [registrationToken, setRegistrationToken] = useState("");
    const [accessToken, setAccessToken] = useState("");
    const [status, setStatus] = useState<any>();
    const [config, setConfig] = useState<any>();
    const [deviceVerification, setDeviceVerification] = useState<MatrixDeviceVerificationStatusDTO>();
    const [deviceVerificationRefreshError, setDeviceVerificationRefreshError] = useState("");
    const [deviceVerificationActionError, setDeviceVerificationActionError] = useState("");
    const [deviceVerificationBusy, setDeviceVerificationBusy] = useState(false);
    const [deviceVerificationCancelBusy, setDeviceVerificationCancelBusy] = useState(false);
    const [rooms, setRooms] = useState<MatrixRoomDTO[]>(snapshotRooms);
    const [publicRooms, setPublicRooms] = useState<MatrixPublicRoomDTO[]>([]);
    const [directoryLoaded, setDirectoryLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [directoryBusy, setDirectoryBusy] = useState(false);
    const [directoryError, setDirectoryError] = useState("");
    const [directorySearch, setDirectorySearch] = useState("");
    const [directoryTotalEstimate, setDirectoryTotalEstimate] = useState<number>();
    const [directoryTruncated, setDirectoryTruncated] = useState(false);
    const [refreshBusy, setRefreshBusy] = useState(false);
    const [roomAddress, setRoomAddress] = useState("");
    const [addressBusy, setAddressBusy] = useState(false);
    const [addressError, setAddressError] = useState("");
    const [pendingAddressRoomId, setPendingAddressRoomId] = useState<string>();
    const [joinName, setJoinName] = useState("");
    const [joinNameBusy, setJoinNameBusy] = useState(false);
    const [joinNameError, setJoinNameError] = useState("");
    const [notice, setNoticeText] = useState("");
    const [noticeTone, setNoticeTone] = useState<"success" | "warning">("success");
    const [error, setError] = useState("");
    const [roomSearch, setRoomSearch] = useState("");
    const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(() => new Set());
    const [spaceLoading, setSpaceLoading] = useState<string>();
    const [suggestedChannelsLoading, setSuggestedChannelsLoading] = useState<string>();
    const [spaceCreationPending, setSpaceCreationPending] = useState(matrixSpaceCreationInFlight);
    const [spaceCreationNeedsRefresh, setSpaceCreationNeedsRefresh] = useState(matrixSpaceCreationNeedsRefresh);
    const [spaceHierarchies, setSpaceHierarchies] = useState<Record<string, MatrixSpaceHierarchyDTO>>({});
    const [spaceErrors, setSpaceErrors] = useState<Record<string, string>>({});
    const [expandedAccessSpaces, setExpandedAccessSpaces] = useState<Set<string>>(() => new Set());
    const [spaceAccess, setSpaceAccess] = useState<Record<string, MatrixSpaceAccessSummaryDTO>>({});
    const [spaceAccessConfirmed, setSpaceAccessConfirmed] = useState<Record<string, boolean>>({});
    const [spaceAccessDrafts, setSpaceAccessDrafts] = useState<Record<string, MatrixSpaceAccessDraft>>({});
    const [spaceAccessRequests, setSpaceAccessRequests] = useState<Record<string, MatrixSpaceAccessRequestListDTO>>({});
    const [spaceAccessLoading, setSpaceAccessLoading] = useState<string>();
    const [spaceAccessAction, setSpaceAccessAction] = useState<string>();
    const [spaceAccessErrors, setSpaceAccessErrors] = useState<Record<string, string>>({});
    const [dmSpaceId, setDmSpaceId] = useState("");
    const [dmUserId, setDmUserId] = useState("");
    const [dmMembersLoading, setDmMembersLoading] = useState(false);
    const [dmMembersError, setDmMembersError] = useState("");
    const directoryRequest = useRef(0);
    const operationBusy = useRef(false);
    const deviceVerificationMounted = useRef(true);
    const deviceVerificationIdentity = useRef("");
    const deviceVerificationRequest = useRef(0);
    const deviceVerificationMutation = useRef(0);
    const deviceVerificationStartInFlight = useRef(false);
    const deviceVerificationCancelInFlight = useRef(false);

    function setNotice(value: string) {
        setNoticeText(value);
        setNoticeTone("success");
    }

    function setWarning(value: string) {
        setNoticeText(value);
        setNoticeTone("warning");
    }

    const invites = rooms.filter(room => roomMembership(room) === "invite");
    const joinedSpaces = rooms.filter(room => roomMembership(room) === "join" && roomKind(room) === "space");
    const joinedChats = rooms.filter(room => roomMembership(room) === "join" && roomKind(room) !== "space");
    const visibleChats = joinedChats.filter(room => {
        const query = roomSearch.trim().toLocaleLowerCase();
        return !query
            || roomName(room).toLocaleLowerCase().includes(query)
            || room.roomId.toLocaleLowerCase().includes(query);
    });
    const knownRoomsById = useMemo(() => new Map(rooms.map(room => [room.roomId, room])), [rooms]);
    const visiblePublicRooms = useMemo(() => {
        const query = directorySearch.trim().toLocaleLowerCase();
        if (!query) return publicRooms;
        return publicRooms.filter(room => room.name.toLocaleLowerCase().includes(query)
            || room.alias?.toLocaleLowerCase().includes(query)
            || room.roomId.toLocaleLowerCase().includes(query)
            || room.topic?.toLocaleLowerCase().includes(query));
    }, [directorySearch, publicRooms]);
    const publicSpaceCount = publicRooms.filter(room => room.roomType === "m.space").length;
    const publicChatCount = publicRooms.length - publicSpaceCount;
    const selectedDmSpace = joinedSpaces.find(room => room.roomId === dmSpaceId);
    const dmMembers = useMemo(() => (selectedDmSpace?.members ?? [])
        .filter(member => member.membership === "join" && member.userId !== config?.userId)
        .sort((left, right) => (left.displayName || left.userId).localeCompare(right.displayName || right.userId)),
    [selectedDmSpace, config?.userId]);
    const statusErrorCode = matrixErrorCode(status?.error);
    const reauthenticationRequired = config?.configured === true && statusErrorCode === "MATRIX_REAUTH_REQUIRED";
    const sessionResetRequired = config?.configured === true
        && statusErrorCode != null
        && MATRIX_SESSION_RESET_CODES.has(statusErrorCode);
    const accountActionRequired = reauthenticationRequired || sessionResetRequired;
    const preservedDevice = config?.preservedDevice === true;

    function verificationIdentityFor(accountConfig: any) {
        return accountConfig?.configured && typeof accountConfig.userId === "string"
            && typeof accountConfig.deviceId === "string"
            ? `${accountConfig.userId}\0${accountConfig.deviceId}`
            : "";
    }

    function bindDeviceVerificationAccount(accountConfig: any) {
        const identity = verificationIdentityFor(accountConfig);
        if (deviceVerificationIdentity.current === identity) return identity;
        deviceVerificationIdentity.current = identity;
        deviceVerificationRequest.current++;
        deviceVerificationMutation.current++;
        deviceVerificationStartInFlight.current = false;
        deviceVerificationCancelInFlight.current = false;
        setDeviceVerification(undefined);
        setDeviceVerificationRefreshError("");
        setDeviceVerificationActionError("");
        setDeviceVerificationBusy(false);
        setDeviceVerificationCancelBusy(false);
        return identity;
    }

    async function reloadDeviceVerification(accountConfig: any) {
        const expectedIdentity = verificationIdentityFor(accountConfig);
        const expectedDeviceId = accountConfig?.deviceId;
        if (!expectedIdentity || deviceVerificationIdentity.current !== expectedIdentity) return;
        const requestId = ++deviceVerificationRequest.current;
        try {
            const nextVerification = await Native.getDeviceVerification();
            if (!deviceVerificationMounted.current
                || requestId !== deviceVerificationRequest.current
                || expectedIdentity !== deviceVerificationIdentity.current) return;
            if (nextVerification.deviceId !== expectedDeviceId) {
                setDeviceVerificationRefreshError("Matrix returned device trust for a different device. Reconnect this account before verifying it.");
                return;
            }
            setDeviceVerification(nextVerification);
            setDeviceVerificationRefreshError("");
        } catch (caught) {
            if (deviceVerificationMounted.current
                && requestId === deviceVerificationRequest.current
                && expectedIdentity === deviceVerificationIdentity.current) {
                setDeviceVerificationRefreshError(`Device trust could not be refreshed: ${errorMessage(caught)}`);
            }
        }
    }

    async function reload() {
        try {
            const [nextStatus, nextConfig] = await Promise.all([
                Native.getStatus(),
                Native.getConfig(),
            ]);
            setStatus(nextStatus);
            setConfig(nextConfig);
            bindDeviceVerificationAccount(nextConfig);
            if (nextConfig?.homeserver) setHomeserver(nextConfig.homeserver);
            if (nextConfig?.preservedDevice) {
                const localpart = matrixLocalpart(nextConfig.userId);
                if (localpart) setUsername(localpart);
            }
            setRooms(snapshotRooms());
            if (nextConfig?.configured && !matrixAccountActionRequired(nextStatus)) {
                await reloadDeviceVerification(nextConfig);
            }
            return { config: nextConfig, status: nextStatus };
        } catch (caught) {
            setError(errorMessage(caught));
        }
    }

    async function loadPublicRooms(expectedUserId?: string): Promise<MatrixPublicRoomDirectoryDTO | undefined> {
        const requestId = ++directoryRequest.current;
        setDirectoryBusy(true);
        setDirectoryLoaded(false);
        setDirectoryError("");
        try {
            const directory = await Native.publicRooms();
            if (requestId !== directoryRequest.current) return;
            if (expectedUserId && !isCurrentAccount(expectedUserId)) return;
            setPublicRooms(directory.rooms);
            setDirectoryTotalEstimate(directory.totalRoomCountEstimate);
            setDirectoryTruncated(directory.truncated);
            setDirectoryLoaded(true);
            return directory;
        } catch (caught) {
            if (requestId !== directoryRequest.current) return;
            setDirectoryLoaded(true);
            setDirectoryError(errorMessage(caught));
        } finally {
            if (requestId === directoryRequest.current) setDirectoryBusy(false);
        }
    }

    async function loadRooms(includeDirectory = false, expectedUserId?: string) {
        const snapshot = await refreshSnapshot();
        if (expectedUserId && snapshot.account?.userId !== expectedUserId) {
            throw new Error("The connected account changed while refreshing.");
        }
        const nextRooms = (snapshot.rooms ?? []) as MatrixRoomDTO[];
        setRooms(nextRooms);
        const directory = includeDirectory ? await loadPublicRooms(expectedUserId) : undefined;
        if (expectedUserId && !isCurrentAccount(expectedUserId)) {
            throw new Error("The connected account changed while refreshing.");
        }
        return { rooms: nextRooms, directory };
    }

    useEffect(() => {
        deviceVerificationMounted.current = true;
        void reload().then(result => {
            if (result?.config?.configured && !matrixAccountActionRequired(result.status)) {
                void loadRooms(true).catch(caught => setError(errorMessage(caught)));
            } else {
                setTab("account");
            }
        });
        const interval = setInterval(() => void reload(), 2_000);
        return () => {
            clearInterval(interval);
            directoryRequest.current++;
            deviceVerificationMounted.current = false;
            deviceVerificationRequest.current++;
            deviceVerificationMutation.current++;
        };
    }, []);

    useEffect(() => {
        if (!pendingAddressRoomId || !rooms.some(room => room.roomId === pendingAddressRoomId)) return;
        setPendingAddressRoomId(undefined);
        setAddressBusy(false);
        setNotice("Room joined and is now available in Discord.");
        setTab("rooms");
    }, [pendingAddressRoomId, rooms]);

    useEffect(() => {
        if (accountActionRequired) setTab("account");
    }, [accountActionRequired]);

    useEffect(() => {
        if (preservedDevice && mode === "register") setMode("login");
    }, [mode, preservedDevice]);

    useEffect(() => {
        if (!pendingAddressRoomId) return;
        const timeout = setTimeout(() => {
            setPendingAddressRoomId(undefined);
            setAddressBusy(false);
            setNotice("The room joined, but has not appeared in sync yet. Use Refresh to check again.");
        }, 20_000);
        return () => clearTimeout(timeout);
    }, [pendingAddressRoomId]);

    useEffect(() => {
        setDmSpaceId(current => joinedSpaces.some(space => space.roomId === current)
            ? current
            : joinedSpaces[0]?.roomId ?? "");
    }, [rooms]);

    useEffect(() => {
        if (!dmMembers.some(member => member.userId === dmUserId)) setDmUserId("");
    }, [dmMembers, dmUserId]);

    useEffect(() => {
        if (accountActionRequired || !dmSpaceId) {
            setDmMembersLoading(false);
            setDmMembersError("");
            return;
        }
        let cancelled = false;
        setDmMembersLoading(true);
        setDmMembersError("");
        void (async () => {
            try {
                const hierarchy = await Native.spaceChildren(dmSpaceId, 200, 8);
                if (cancelled) return;
                setSpaceHierarchies(current => ({ ...current, [dmSpaceId]: hierarchy }));
                const snapshot = await refreshSnapshot();
                if (!cancelled) setRooms((snapshot.rooms ?? []) as MatrixRoomDTO[]);
            } catch (caught) {
                if (!cancelled) setDmMembersError(errorMessage(caught));
            } finally {
                if (!cancelled) setDmMembersLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [accountActionRequired, dmSpaceId]);

    async function run(action: () => Promise<void>) {
        if (operationBusy.current) return;
        operationBusy.current = true;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await action();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            try {
                await reload();
            } finally {
                setBusy(false);
                operationBusy.current = false;
            }
        }
    }

    async function refreshAll() {
        setRefreshBusy(true);
        try {
            await run(async () => {
                const { directory } = await loadRooms(true);
                matrixSpaceCreationNeedsRefresh = false;
                setSpaceCreationNeedsRefresh(false);
                if (directory) {
                    setNotice(`Chats, servers, and ${directory.rooms.length} public listings refreshed.`);
                } else {
                    setWarning("Chats and servers refreshed, but discovery could not be refreshed.");
                }
            });
        } finally {
            setRefreshBusy(false);
        }
    }

    async function verifyThisDevice() {
        const expectedIdentity = verificationIdentityFor(config);
        const expectedDeviceId = config?.deviceId;
        if (!expectedIdentity || expectedIdentity !== deviceVerificationIdentity.current) {
            setDeviceVerificationActionError("Reconnect this Matrix account before verifying its device.");
            return;
        }
        if (accountActionRequired) {
            setDeviceVerificationActionError("Reconnect this Matrix session before verifying its device.");
            return;
        }
        if (!deviceVerification) return;
        if (deviceVerificationStartInFlight.current
            || ACTIVE_DEVICE_VERIFICATION_PHASES.has(deviceVerification.verification?.phase ?? "idle")) return;

        const mutationId = ++deviceVerificationMutation.current;
        deviceVerificationStartInFlight.current = true;
        setDeviceVerificationBusy(true);
        setDeviceVerificationActionError("");
        setDeviceVerificationRefreshError("");
        try {
            const result = await Native.verifyCurrentDevice();
            if (!deviceVerificationMounted.current
                || mutationId !== deviceVerificationMutation.current
                || expectedIdentity !== deviceVerificationIdentity.current) return;
            if (result.deviceId !== expectedDeviceId) {
                setDeviceVerificationActionError("Matrix completed verification for a different device. Reconnect this account before trying again.");
                return;
            }
            deviceVerificationRequest.current++;
            setDeviceVerification(result);
        } catch (caught) {
            if (deviceVerificationMounted.current
                && mutationId === deviceVerificationMutation.current
                && expectedIdentity === deviceVerificationIdentity.current) {
                setDeviceVerificationActionError(errorMessage(caught));
            }
        } finally {
            if (expectedIdentity === deviceVerificationIdentity.current) {
                deviceVerificationStartInFlight.current = false;
                if (deviceVerificationMounted.current) setDeviceVerificationBusy(false);
            }
        }
    }

    async function cancelThisDeviceVerification() {
        const expectedIdentity = verificationIdentityFor(config);
        const expectedDeviceId = config?.deviceId;
        if (!expectedIdentity || expectedIdentity !== deviceVerificationIdentity.current
            || deviceVerificationCancelInFlight.current) return;

        const mutationId = ++deviceVerificationMutation.current;
        deviceVerificationCancelInFlight.current = true;
        setDeviceVerificationCancelBusy(true);
        setDeviceVerificationActionError("");
        try {
            const result = await Native.cancelDeviceVerification();
            if (!deviceVerificationMounted.current
                || mutationId !== deviceVerificationMutation.current
                || expectedIdentity !== deviceVerificationIdentity.current) return;
            if (result.deviceId !== expectedDeviceId) {
                setDeviceVerificationActionError("Matrix cancelled verification for a different device. Reconnect this account before trying again.");
                return;
            }
            deviceVerificationRequest.current++;
            deviceVerificationStartInFlight.current = false;
            setDeviceVerificationBusy(false);
            setDeviceVerification(result);
        } catch (caught) {
            if (deviceVerificationMounted.current
                && mutationId === deviceVerificationMutation.current
                && expectedIdentity === deviceVerificationIdentity.current) {
                setDeviceVerificationActionError(errorMessage(caught));
            }
        } finally {
            if (expectedIdentity === deviceVerificationIdentity.current) {
                deviceVerificationCancelInFlight.current = false;
                if (deviceVerificationMounted.current) setDeviceVerificationCancelBusy(false);
            }
        }
    }

    function clearSecrets() {
        setPassword("");
        setConfirmPassword("");
        setRegistrationToken("");
        setAccessToken("");
    }

    async function finishAuthentication(action: () => Promise<unknown>) {
        await run(async () => {
            try {
                await action();
                await restartBridge();
                await loadRooms(true);
                setTab("rooms");
                setNotice("Matrix is connected.");
            } finally {
                clearSecrets();
            }
        });
    }

    async function reauthenticate() {
        const currentHomeserver = config?.homeserver;
        const currentUserId = config?.userId;
        const currentDeviceId = config?.deviceId;
        if (!reauthenticationRequired || !currentHomeserver || !currentUserId || !currentDeviceId) {
            clearSecrets();
            setError("This Matrix session can no longer be repaired safely. Disconnect it, then sign in again.");
            return;
        }
        if (!password && !accessToken) {
            setError("Enter your Matrix password or an access token.");
            return;
        }

        await run(async () => {
            try {
                await Native.reauthenticate(accessToken
                    ? {
                        homeserver: currentHomeserver,
                        userId: currentUserId,
                        deviceId: currentDeviceId,
                        method: "access_token",
                        accessToken,
                    }
                    : {
                        homeserver: currentHomeserver,
                        userId: currentUserId,
                        deviceId: currentDeviceId,
                        method: "password",
                        password,
                    });
                // Reauthentication has already restarted the native client. Rebuild
                // renderer projections without suspending that fresh session.
                await restartBridge(false);
                await loadRooms(true);
                setTab("rooms");
                setNotice("Matrix is connected again.");
            } finally {
                clearSecrets();
            }
        });
    }

    async function login() {
        const loginHomeserver = preservedDevice ? config?.homeserver ?? "" : homeserver;
        const loginUsername = preservedDevice ? matrixLocalpart(config?.userId) ?? "" : username;
        if (!loginHomeserver.trim() || (!accessToken && (!loginUsername.trim() || !password))) {
            setError(accessToken
                ? "A homeserver is required."
                : "Homeserver, username, and password are required.");
            return;
        }

        await finishAuthentication(() => Native.login(accessToken
            ? {
                homeserver: normalizedHomeserver(loginHomeserver),
                method: "access_token",
                accessToken,
            }
            : {
                homeserver: normalizedHomeserver(loginHomeserver),
                method: "password",
                username: loginUsername.trim(),
                password,
            }));
    }

    async function registerAccount() {
        const trimmedRegistrationToken = registrationToken.trim();
        if (!homeserver.trim() || !username.trim() || !password || !trimmedRegistrationToken) {
            setError("Homeserver, username, password, and registration token are required.");
            return;
        }
        if (password !== confirmPassword) {
            setError("The passwords do not match.");
            return;
        }

        await finishAuthentication(() => Native.register({
            homeserver: normalizedHomeserver(homeserver),
            username: username.trim(),
            password,
            registrationToken: trimmedRegistrationToken,
        }));
    }

    function resetAccountUi() {
        directoryRequest.current++;
        bindDeviceVerificationAccount(undefined);
        setRooms([]);
        setPublicRooms([]);
        setDirectoryLoaded(false);
        setDirectoryBusy(false);
        setDirectoryError("");
        setDirectorySearch("");
        setDirectoryTotalEstimate(undefined);
        setDirectoryTruncated(false);
        setRefreshBusy(false);
        setRoomAddress("");
        setAddressError("");
        setPendingAddressRoomId(undefined);
        setJoinName("");
        setJoinNameBusy(false);
        setJoinNameError("");
        setExpandedSpaces(new Set());
        setSpaceHierarchies({});
        setExpandedAccessSpaces(new Set());
        setSpaceAccess({});
        setSpaceAccessConfirmed({});
        setSpaceAccessDrafts({});
        setSpaceAccessRequests({});
        setSpaceAccessLoading(undefined);
        setSpaceAccessAction(undefined);
        setSpaceAccessErrors({});
        setTab("account");
    }

    async function signOut() {
        await run(async () => {
            let signOutError: unknown;
            let routeError: unknown;
            try {
                await Native.signOut();
            } catch (caught) {
                signOutError = caught;
            }
            try {
                await clearMatrixRoutePreference();
            } catch (caught) {
                routeError = caught;
            } finally {
                // Plaintext projections must disappear even if the remote
                // revocation request failed. Native has already committed the
                // tokenless preserved-device record.
                await restartBridge();
                resetAccountUi();
            }
            if (signOutError) throw signOutError;
            if (routeError) throw routeError;
        });
    }

    async function logout() {
        await run(async () => {
            let logoutError: unknown;
            let routeError: unknown;
            try {
                await Native.logout();
            } catch (caught) {
                logoutError = caught;
            }
            try {
                await clearMatrixRoutePreference();
            } catch (caught) {
                routeError = caught;
            } finally {
                // Always remove plaintext projections/messages after a logout
                // attempt, even when secure storage or route cleanup failed.
                await restartBridge();
                resetAccountUi();
            }
            if (logoutError) throw logoutError;
            if (routeError) throw routeError;
        });
    }

    function confirmLogout() {
        openModal(modalProps => (
            <ConfirmModal
                {...modalProps}
                title="Forget this Matrix account and its local keys?"
                confirmText="Forget account and keys"
                cancelText="Cancel"
                variant="danger"
                onConfirm={() => void logout()}
            >
                <Paragraph>
                    This permanently deletes this device&apos;s local encryption keys. Old encrypted history may become unreadable
                    unless another trusted device or key backup can restore it. It also abandons any unacknowledged room or server creation receipt.
                    The remote room and invitations may still exist and can no longer be reconciled.
                </Paragraph>
            </ConfirmModal>
        ));
    }

    async function joinPublicRoom(room: MatrixPublicRoomDTO) {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) return;
        let joined = false;
        let opened = false;
        await run(async () => {
            if (!isCurrentAccount(expectedUserId)) return;
            await Native.joinRoom(room.roomId, expectedUserId);
            joined = true;
            if (!isCurrentAccount(expectedUserId)) return;
            const deadline = Date.now() + 20_000;
            do {
                try {
                    const snapshot = await beforeDeadline(refreshSnapshot(), deadline);
                    if (snapshot.account?.userId !== expectedUserId || !isCurrentAccount(expectedUserId)) return;
                    const nextRooms = (snapshot.rooms ?? []) as MatrixRoomDTO[];
                    setRooms(nextRooms);
                    const joinedRoom = nextRooms.find(candidate => candidate.roomId === room.roomId
                        && roomMembership(candidate) === "join");
                    if (joinedRoom) {
                        opened = roomKind(joinedRoom) === "space"
                            ? openMatrixSpace(joinedRoom.roomId)
                            : openMatrixRoom(joinedRoom.roomId);
                        if (opened) break;
                    }
                } catch {
                    // A successful join may need another /sync before it can be projected.
                }

                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await new Promise(resolve => setTimeout(resolve, Math.min(1_000, remaining)));
                if (!isCurrentAccount(expectedUserId)) return;
            } while (Date.now() < deadline);
        });
        if (!joined || !isCurrentAccount(expectedUserId)) return;
        setError("");
        if (opened) {
            setTab("rooms");
            setNotice(room.roomType === "m.space"
                ? "Server joined and opened."
                : "Room joined and opened in Discord.");
        } else {
            setWarning(`${room.name} was joined, but it is still syncing. Use Refresh in a moment.`);
        }
    }

    async function joinRoomByAddress() {
        const address = roomAddress.trim();
        const expectedUserId = config?.userId;
        if (!address) {
            setAddressError("Enter a full Matrix room alias or room ID.");
            return;
        }
        if (address.length > 512 || !MATRIX_ROOM_ADDRESS_PATTERN.test(address)) {
            setAddressError("Use #alias:server, !legacy-id:server, or a domainless room ID such as !opaque.");
            return;
        }
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) {
            setAddressError("Reconnect your account before joining this address.");
            return;
        }

        setAddressBusy(true);
        setAddressError("");
        setNotice("");
        try {
            const result = await Native.joinRoomAddress(address, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) {
                setAddressBusy(false);
                return;
            }
            setRoomAddress("");
            setPendingAddressRoomId(result.roomId);
            setNotice("Room joined. Waiting for Matrix to sync it...");
            try {
                await loadRooms(false, expectedUserId);
            } catch {
                // The bridge poll will pick up a successful join after /sync.
            }
        } catch (caught) {
            setAddressBusy(false);
            if (isCurrentAccount(expectedUserId)) setAddressError(errorMessage(caught));
        }
    }

    async function requestAccess(joinNameValue: string, inlineError = true) {
        const normalized = cleanJoinName(joinNameValue);
        if (!validJoinName(normalized)) {
            const message = "Use 1-64 lowercase letters or numbers. Dots, underscores, and hyphens may appear between them.";
            if (inlineError) setJoinNameError(message);
            else setError(message);
            return;
        }
        if (!config?.userId) {
            const message = "Reconnect your account before requesting access.";
            if (inlineError) setJoinNameError(message);
            else setError(message);
            return;
        }
        const expectedUserId = config.userId;

        setJoinNameBusy(true);
        setJoinNameError("");
        setError("");
        setNotice("");
        try {
            const result = await Native.requestSpaceAccess(normalized, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) return;
            setJoinName("");
            setJoinNameError("");
            setNotice(accessResultNotice(result));
            if (result.membership === "invite" || result.membership === "join") {
                try {
                    const { rooms: nextRooms } = await loadRooms(false, expectedUserId);
                    if (!isCurrentAccount(expectedUserId)) return;
                    const joinedSpace = nextRooms.find(room => room.roomId === result.roomId
                        && roomMembership(room) === "join" && roomKind(room) === "space");
                    if (joinedSpace && result.membership === "join") {
                        openMatrixSpace(joinedSpace.roomId);
                        setTab("rooms");
                    }
                } catch {
                    if (!isCurrentAccount(expectedUserId)) return;
                    setWarning("The access request succeeded, but the server list could not be refreshed yet.");
                }
            }
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) return;
            if (matrixErrorCode(caught) === "MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS") {
                const ambiguity = errorMessage(caught);
                setJoinName("");
                setJoinNameError("");
                setWarning(`The access request may have succeeded, but its response could not be confirmed: ${ambiguity}`);
                try {
                    await loadRooms(false, expectedUserId);
                } catch {
                    if (!isCurrentAccount(expectedUserId)) return;
                    setWarning(`The access request may have succeeded, but the server list could not be refreshed yet. ${ambiguity}`);
                }
                return;
            }
            const message = errorMessage(caught);
            if (inlineError) setJoinNameError(message);
            else setError(message);
        } finally {
            setJoinNameBusy(false);
        }
    }

    async function loadSpaceAccess(space: MatrixRoomDTO) {
        if (!config?.userId) return;
        const expectedUserId = config.userId;
        const spaceId = space.roomId;
        setSpaceAccessLoading(spaceId);
        setSpaceAccessErrors(current => ({ ...current, [spaceId]: "" }));
        try {
            const access = await Native.getSpaceAccess(spaceId, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) return;
            setSpaceAccess(current => ({ ...current, [spaceId]: access }));
            setSpaceAccessConfirmed(current => ({ ...current, [spaceId]: true }));
            setSpaceAccessDrafts(current => ({
                ...current,
                [spaceId]: { mode: access.mode, joinName: access.joinName ?? "" },
            }));
            if (space.canApproveAccessRequests || space.canDenyAccessRequests) {
                const requests = await Native.getSpaceAccessRequests(spaceId, expectedUserId);
                if (!isCurrentAccount(expectedUserId)) return;
                setSpaceAccessRequests(current => ({ ...current, [spaceId]: requests }));
            }
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) return;
            setSpaceAccessErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
        } finally {
            setSpaceAccessLoading(current => current === spaceId ? undefined : current);
        }
    }

    function toggleSpaceAccess(space: MatrixRoomDTO) {
        if (expandedAccessSpaces.has(space.roomId)) {
            setExpandedAccessSpaces(current => {
                const next = new Set(current);
                next.delete(space.roomId);
                return next;
            });
            setSpaceAccessDrafts(current => {
                const next = { ...current };
                delete next[space.roomId];
                return next;
            });
            return;
        }
        setExpandedAccessSpaces(current => new Set(current).add(space.roomId));
        void loadSpaceAccess(space);
    }

    function applyAccessResult(result: MatrixConfigureSpaceAccessResult) {
        setSpaceAccess(current => ({ ...current, [result.spaceId]: result.access }));
        setSpaceAccessConfirmed(current => ({ ...current, [result.spaceId]: result.accessConfirmed }));
        setSpaceAccessDrafts(current => ({
            ...current,
            [result.spaceId]: { mode: result.access.mode, joinName: result.access.joinName ?? "" },
        }));
        const confirmation = accessConfirmationText(result);
        if (result.complete) setNotice(`Access settings saved. ${confirmation}`);
        else setWarning(`Access settings were only partly applied. ${result.partial?.message ?? "Review the settings."} ${confirmation}`);
    }

    async function saveSpaceAccess(spaceId: string) {
        const draft = spaceAccessDrafts[spaceId];
        if (!draft || !config?.userId || spaceAccessAction) return;
        const expectedUserId = config.userId;
        const normalizedJoinName = cleanJoinName(draft.joinName);
        if (draft.mode === "request" && !validJoinName(normalizedJoinName)) {
            setSpaceAccessErrors(current => ({
                ...current,
                [spaceId]: "Request approval needs a unique join name using 1-64 lowercase letters or numbers. Dots, underscores, and hyphens may appear between them.",
            }));
            return;
        }

        setSpaceAccessAction(`save:${spaceId}`);
        setSpaceAccessErrors(current => ({ ...current, [spaceId]: "" }));
        setError("");
        setNotice("");
        try {
            const result = await Native.configureSpaceAccess({
                spaceId,
                mode: draft.mode,
                ...(draft.mode === "request" ? { joinName: normalizedJoinName } : {}),
            }, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) return;
            applyAccessResult(result);
            try {
                const { directory } = await loadRooms(true, expectedUserId);
                if (!isCurrentAccount(expectedUserId)) return;
                if (!directory) {
                    setWarning(`${result.complete ? "Access settings were saved" : "Access settings were partly applied"}, but the public directory could not be refreshed yet. ${accessConfirmationText(result)}`);
                }
            } catch {
                if (!isCurrentAccount(expectedUserId)) return;
                setWarning(`${result.complete ? "Access settings were saved" : "Access settings were partly applied"}, but the server list could not be refreshed yet. ${accessConfirmationText(result)}`);
            }
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) return;
            if (matrixErrorCode(caught) === "MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS") {
                setSpaceAccessConfirmed(current => ({ ...current, [spaceId]: false }));
                let refreshedAccess: MatrixSpaceAccessSummaryDTO | undefined;
                try {
                    const access = await Native.getSpaceAccess(spaceId, expectedUserId);
                    if (!isCurrentAccount(expectedUserId)) return;
                    refreshedAccess = access;
                    setSpaceAccess(current => ({ ...current, [spaceId]: access }));
                    setSpaceAccessConfirmed(current => ({ ...current, [spaceId]: true }));
                    setSpaceAccessDrafts(current => ({
                        ...current,
                        [spaceId]: {
                            mode: access.mode,
                            joinName: access.joinName ?? "",
                        },
                    }));
                } catch {
                    if (!isCurrentAccount(expectedUserId)) return;
                    setSpaceAccessDrafts(current => {
                        const next = { ...current };
                        delete next[spaceId];
                        return next;
                    });
                }
                try {
                    await loadRooms(true, expectedUserId);
                } catch {
                    // The bridge poll will retry the room and directory lists.
                }
                if (!isCurrentAccount(expectedUserId)) return;
                setWarning(refreshedAccess
                    ? `The save response could not be confirmed. Current access was refreshed: ${actualAccessLabel(refreshedAccess)}.`
                    : "Access settings may have changed, but current access could not be verified. Refresh before saving again.");
                return;
            }
            setSpaceAccessErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
        } finally {
            setSpaceAccessAction(current => current === `save:${spaceId}` ? undefined : current);
        }
    }

    async function resolveAccessRequest(spaceId: string, userId: string, decision: "approve" | "deny") {
        if (!config?.userId || spaceAccessAction) return;
        const expectedUserId = config.userId;
        const action = `${decision}:${spaceId}:${userId}`;
        setSpaceAccessAction(action);
        setSpaceAccessErrors(current => ({ ...current, [spaceId]: "" }));
        setError("");
        setNotice("");
        try {
            const result = await Native.resolveSpaceAccessRequest({ spaceId, userId, decision }, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) return;
            setSpaceAccessRequests(current => {
                const existing = current[spaceId];
                if (!existing) return current;
                return {
                    ...current,
                    [spaceId]: {
                        ...existing,
                        requests: existing.requests.filter(request => request.userId !== userId),
                    },
                };
            });
            const approved = result.membership === "invite" || result.membership === "join";
            setNotice(approved
                ? result.membership === "join"
                    ? "Access approved. The requester has joined the server."
                    : "Access approved. The server invitation is ready."
                : "Access request denied.");
            try {
                const [requests] = await Promise.all([
                    Native.getSpaceAccessRequests(spaceId, expectedUserId),
                    loadRooms(false, expectedUserId),
                ]);
                if (!isCurrentAccount(expectedUserId)) return;
                setSpaceAccessRequests(current => ({ ...current, [spaceId]: requests }));
            } catch {
                if (!isCurrentAccount(expectedUserId)) return;
                setWarning(approved
                    ? "Access was approved, but the request list could not be refreshed yet."
                    : "Access was denied, but the request list could not be refreshed yet.");
            }
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) return;
            if (matrixErrorCode(caught) === "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS") {
                const ambiguity = errorMessage(caught);
                setWarning(`This access decision may have succeeded, but its response could not be confirmed: ${ambiguity}`);
                let requestsRefreshed = false;
                let roomsRefreshed = false;
                try {
                    const requests = await Native.getSpaceAccessRequests(spaceId, expectedUserId);
                    if (!isCurrentAccount(expectedUserId)) return;
                    setSpaceAccessRequests(current => ({ ...current, [spaceId]: requests }));
                    requestsRefreshed = true;
                } catch {
                    // Reopening access settings retries the authoritative request list.
                }
                try {
                    await loadRooms(false, expectedUserId);
                    roomsRefreshed = true;
                } catch {
                    // The bridge poll retries the room projection.
                }
                if (!isCurrentAccount(expectedUserId)) return;
                if (!requestsRefreshed || !roomsRefreshed) {
                    setWarning(`This access decision may have succeeded, but the server or request list could not be refreshed yet. ${ambiguity}`);
                }
            } else {
                setSpaceAccessErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
            }
        } finally {
            setSpaceAccessAction(current => current === action ? undefined : current);
        }
    }

    async function refreshSpaceHierarchy(spaceId: string, expectedUserId = config?.userId) {
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) return false;
        try {
            const hierarchy = await Native.spaceChildren(spaceId, 200, 8);
            if (!isCurrentAccount(expectedUserId)) return false;
            setSpaceHierarchies(current => ({ ...current, [spaceId]: hierarchy }));
            setSpaceErrors(current => ({ ...current, [spaceId]: "" }));
            return true;
        } catch (caught) {
            if (!isCurrentAccount(expectedUserId)) return false;
            setSpaceErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
            return false;
        }
    }

    async function loadSuggestedChannelPlan(spaceId: string, expectedUserId: string) {
        return await waitForSuggestedChannelPlan(
            () => Native.suggestedSpaceChannelPlan(spaceId, expectedUserId),
            () => isCurrentAccount(expectedUserId),
            caught => matrixErrorCode(caught) === "MATRIX_ROOM_NOT_JOINED"
        );
    }

    async function finishSuggestedChannelJoins(
        result: MatrixJoinSuggestedSpaceChannelsResult,
        expectedUserId: string
    ) {
        if (!isCurrentAccount(expectedUserId)) return;
        let refreshFailed = false;
        try {
            await loadRooms(false, expectedUserId);
        } catch {
            refreshFailed = true;
        }
        if (!isCurrentAccount(expectedUserId)) return;
        if (!await refreshSpaceHierarchy(result.spaceId, expectedUserId)) refreshFailed = true;
        if (!isCurrentAccount(expectedUserId)) return;
        setError("");
        const summary = suggestedChannelJoinSummary(result);
        if (refreshFailed) {
            setWarning(`${summary} Rooms could not be refreshed yet. Use Refresh to check again.`);
        } else {
            setNotice(summary);
        }
    }

    async function showSuggestedChannels(spaceId: string) {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId) || suggestedChannelsLoading) return;
        setSuggestedChannelsLoading(spaceId);
        setError("");
        setNoticeText("");
        try {
            const plan = await loadSuggestedChannelPlan(spaceId, expectedUserId);
            if (!isCurrentAccount(expectedUserId)) return;
            if (!plan) {
                setWarning("Suggested channels are still syncing. No channels were joined. Try again later.");
                return;
            }
            if (!plan.channels.some(channel => channel.membership === "leave")) {
                setNotice("There are no new provider-suggested channels to join.");
                return;
            }
            openSuggestedChannelsModal(
                plan,
                expectedUserId,
                result => finishSuggestedChannelJoins(result, expectedUserId)
            );
        } catch {
            if (isCurrentAccount(expectedUserId)) {
                setWarning("Suggested channels could not be loaded. No channels were joined. Try again later.");
            }
        } finally {
            setSuggestedChannelsLoading(undefined);
        }
    }

    async function acceptInvite(roomId: string, spaceId?: string) {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) return;
        const acceptedRoom = rooms.find(room => room.roomId === roomId)
            ?? snapshotRooms().find(room => room.roomId === roomId);
        const acceptedSpace = acceptedRoom ? roomKind(acceptedRoom) === "space" : false;
        let accepted = false;
        let refreshFailed = false;
        let suggestedPlan: MatrixSuggestedSpaceChannelPlanDTO | undefined;
        let suggestedPlanTimedOut = false;
        let suggestedPlanFailed = false;
        let directMessageClassificationFailed = false;
        setWarning("");
        await run(async () => {
            if (!isCurrentAccount(expectedUserId)) return;
            const result = await Native.acceptInvite(roomId, expectedUserId);
            accepted = true;
            directMessageClassificationFailed = result.warning?.code === "MATRIX_DM_CLASSIFICATION_FAILED";
            if (!isCurrentAccount(expectedUserId)) return;
            try {
                await loadRooms(false, expectedUserId);
            } catch {
                refreshFailed = true;
            }
            if (!isCurrentAccount(expectedUserId)) return;
            if (spaceId && !await refreshSpaceHierarchy(spaceId, expectedUserId)) refreshFailed = true;
            if (acceptedSpace) {
                try {
                    suggestedPlan = await loadSuggestedChannelPlan(roomId, expectedUserId);
                    suggestedPlanTimedOut = !suggestedPlan;
                } catch {
                    suggestedPlanFailed = true;
                }
            }
        });
        if (!accepted || !isCurrentAccount(expectedUserId)) return;
        setError("");
        setNotice("Invitation accepted.");
        const warnings: string[] = [];
        if (refreshFailed) warnings.push("Rooms could not be refreshed yet. Use Refresh to check again.");
        if (directMessageClassificationFailed) {
            warnings.push("This chat could not be classified as a direct message, so it will appear as a regular chat.");
        }
        if (suggestedPlanTimedOut) {
            warnings.push("Suggested channels are still syncing; no channels were joined. Open server settings later and select Suggested Channels.");
        } else if (suggestedPlanFailed) {
            warnings.push("Suggested channels could not be loaded; no channels were joined. Open server settings later and select Suggested Channels.");
        }
        if (warnings.length) setWarning(`Invitation was accepted. ${warnings.join(" ")}`);
        if (suggestedPlan?.channels.some(channel => channel.membership === "leave")) {
            openSuggestedChannelsModal(
                suggestedPlan,
                expectedUserId,
                result => finishSuggestedChannelJoins(result, expectedUserId)
            );
        }
    }

    async function rejectInvite(roomId: string, spaceId?: string) {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) return;
        let declined = false;
        let refreshFailed = false;
        setWarning("");
        await run(async () => {
            if (!isCurrentAccount(expectedUserId)) return;
            await Native.rejectInvite(roomId, expectedUserId);
            declined = true;
            if (!isCurrentAccount(expectedUserId)) return;
            try {
                await loadRooms(false, expectedUserId);
            } catch {
                refreshFailed = true;
            }
            if (!isCurrentAccount(expectedUserId)) return;
            if (spaceId && !await refreshSpaceHierarchy(spaceId, expectedUserId)) refreshFailed = true;
        });
        if (!declined || !isCurrentAccount(expectedUserId)) return;
        setError("");
        setNotice("Invitation declined.");
        if (refreshFailed) {
            setWarning("Invitation was declined, but rooms could not be refreshed yet. Use Refresh to check again.");
        }
    }

    async function joinHierarchyRoom(spaceId: string, room: MatrixSpaceHierarchyRoomDTO) {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) return;
        let joined = false;
        let refreshFailed = false;
        await run(async () => {
            if (!isCurrentAccount(expectedUserId)) return;
            const hierarchy = await Native.spaceChildren(spaceId, 200, 8);
            if (!isCurrentAccount(expectedUserId)) return;
            setSpaceHierarchies(current => ({ ...current, [spaceId]: hierarchy }));
            const freshRoom = hierarchy.rooms.find(candidate => candidate.roomId === room.roomId);
            const freshMembership = freshRoom && roomMembership(freshRoom);
            if (!freshRoom
                || !isHierarchyChild(hierarchy, freshRoom.roomId)
                || freshMembership === "join"
                || freshMembership === "invite"
                || !canJoinFromHierarchy(freshRoom)) {
                throw new Error("This room is no longer available to join from the selected server.");
            }
            await Native.joinRoom(room.roomId, expectedUserId);
            joined = true;
            if (!isCurrentAccount(expectedUserId)) return;
            try {
                await loadRooms(false, expectedUserId);
            } catch {
                refreshFailed = true;
            }
            if (!isCurrentAccount(expectedUserId)) return;
            if (!await refreshSpaceHierarchy(spaceId, expectedUserId)) refreshFailed = true;
        });
        if (!joined || !isCurrentAccount(expectedUserId)) return;
        setError("");
        if (refreshFailed) {
            setWarning(`${roomName(room)} was joined, but rooms could not be refreshed yet. Use Refresh to check again.`);
        } else {
            setNotice(`${roomName(room)} joined and added to Discord.`);
        }
    }

    async function finishCreatedSpace(result: MatrixCreateSpaceResult, name: string, expectedUserId: string) {
        if (!isCurrentAccount(expectedUserId)) return false;
        const deadline = Date.now() + 20_000;
        const linkedGeneralRoomId = result.partial?.code === "MATRIX_GENERAL_ROOM_LINK_FAILED"
            || result.partial?.code === "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS"
            ? undefined
            : result.generalRoomId;
        let opened = false;
        setError("");

        try {
            do {
                try {
                    const snapshot = await beforeDeadline(refreshSnapshot(), deadline);
                    if (snapshot.account?.userId !== expectedUserId || !isCurrentAccount(expectedUserId)) return false;
                    setRooms((snapshot.rooms ?? []) as MatrixRoomDTO[]);
                    if (linkedGeneralRoomId) {
                        // Only open General after the applied bridge snapshot
                        // sees its Space link, so it cannot flash as a standalone chat.
                        const projectedSpace = snapshotRooms().find(room => room.roomId === result.roomId);
                        const generalIsLinked = projectedSpace?.spaceChildren.some(child =>
                            child.roomId === linkedGeneralRoomId);
                        opened = Boolean(generalIsLinked && openMatrixRoom(linkedGeneralRoomId));
                    } else {
                        opened = openMatrixSpace(result.roomId);
                    }
                    if (opened) break;
                } catch {
                    // A successful create must not become a duplicate-prone retry.
                    // The event poll may still project it before this bounded wait ends.
                }

                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await new Promise(resolve => setTimeout(resolve, Math.min(1_000, remaining)));
                if (!isCurrentAccount(expectedUserId)) return false;
            } while (Date.now() < deadline);
        } finally {
            setSpaceCreationPending(false);
            setSpaceCreationNeedsRefresh(!opened);
            setBusy(false);
        }

        if (!isCurrentAccount(expectedUserId)) return false;
        if (result.partial) {
            setWarning(result.partial.code === "MATRIX_GENERAL_ROOM_CREATE_FAILED"
                ? `${name} was created, but its general chat could not be created. Use Refresh if the server has not appeared; do not create it again.`
                : result.partial.code === "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS"
                    ? `${name} was created, but the general chat result could not be confirmed and an unlinked chat may exist. Refresh and check before creating another chat; do not create the server again.`
                    : `${name} and its general chat were created, but the chat could not be added to the server. The chat remains under Chats; do not create the server again.`);
        } else if (!opened) {
            setWarning(`${name} was created, but it is still syncing. Use Refresh in a moment; do not create it again.`);
        } else {
            setNotice(`${name} was created and selected in your Discord server list.`);
        }
        return opened;
    }

    async function resolveAmbiguousSpaceCreation(
        name: string,
        expectedUserId: string
    ) {
        if (!isCurrentAccount(expectedUserId)) return false;
        try {
            const snapshot = await beforeDeadline(refreshSnapshot(), Date.now() + 20_000);
            if (snapshot.account?.userId !== expectedUserId || !isCurrentAccount(expectedUserId)) return false;
            const nextRooms = (snapshot.rooms ?? []) as MatrixRoomDTO[];
            setRooms(nextRooms);
        } catch {
            // The request may still have reached the homeserver. Keep creation
            // blocked until the user explicitly refreshes and inspects the list.
        } finally {
            setSpaceCreationPending(false);
            setSpaceCreationNeedsRefresh(true);
            setBusy(false);
        }

        if (isCurrentAccount(expectedUserId)) {
            setWarning(`The request for ${name} may have succeeded. Inspect the refreshed server list before any retry; matching names do not confirm which server was created.`);
        }
        return false;
    }

    function openCreateMatrixServer() {
        const expectedUserId = config?.userId;
        if (!expectedUserId || !isCurrentAccount(expectedUserId)) {
            setError("Reconnect your account before creating a server.");
            return;
        }
        setError("");
        setNotice("");
        openModal(modalProps => (
            <CreateMatrixServerModal
                modalProps={modalProps}
                expectedUserId={expectedUserId}
                onCreationAmbiguous={name => resolveAmbiguousSpaceCreation(name, expectedUserId)}
                onCreationContextChanged={name => {
                    setSpaceCreationPending(false);
                    setSpaceCreationNeedsRefresh(true);
                    setBusy(false);
                    setWarning(`The signed-in account changed while ${name} was being created. It may have been created; reconnect that account, refresh, and check before trying again.`);
                }}
                onCreationFailed={() => {
                    setSpaceCreationPending(false);
                    setBusy(false);
                }}
                onCreationStarted={() => {
                    setSpaceCreationPending(true);
                    setBusy(true);
                }}
                onCreated={(result, name) => finishCreatedSpace(result, name, expectedUserId)}
            />
        ));
    }

    async function leaveRoom(room: MatrixRoomDTO) {
        await run(async () => {
            const expectedUserId = config?.userId;
            if (typeof expectedUserId !== "string") {
                throw new Error("The Matrix account changed. Refresh settings and try again.");
            }
            await Native.leaveRoom(room.roomId, expectedUserId);
            await loadRooms(false);
            setExpandedSpaces(current => {
                const next = new Set(current);
                next.delete(room.roomId);
                for (const parentId of room.parentIds ?? []) next.delete(parentId);
                return next;
            });
            setSpaceHierarchies(current => {
                const next = { ...current };
                delete next[room.roomId];
                for (const parentId of room.parentIds ?? []) delete next[parentId];
                return next;
            });
            setNotice(`${roomName(room)} left.`);
        });
    }

    function confirmLeave(room: MatrixRoomDTO) {
        openModal(modalProps => (
            <ConfirmModal
                {...modalProps}
                title={`Leave ${roomName(room)}?`}
                confirmText="Leave"
                cancelText="Cancel"
                variant="danger"
                onConfirm={() => void leaveRoom(room)}
            >
                <Paragraph>
                    This removes the Matrix {roomKind(room) === "space" ? "space" : "chat"} from this account.
                    You may need another invitation to return.
                </Paragraph>
                {room.groupChat === true && (
                    <Paragraph>
                        Leaving does not cancel an Add People invitation that may already have landed or been declined. Any unfinished local Add People warning or recovery receipt for this group will be discarded.
                    </Paragraph>
                )}
            </ConfirmModal>
        ));
    }

    async function toggleSpace(spaceId: string) {
        if (expandedSpaces.has(spaceId)) {
            setExpandedSpaces(current => {
                const next = new Set(current);
                next.delete(spaceId);
                return next;
            });
            return;
        }

        setExpandedSpaces(current => new Set(current).add(spaceId));
        if (spaceHierarchies[spaceId]) return;
        setSpaceLoading(spaceId);
        setSpaceErrors(current => ({ ...current, [spaceId]: "" }));
        try {
            const hierarchy = await Native.spaceChildren(spaceId, 200, 8);
            setSpaceHierarchies(current => ({ ...current, [spaceId]: hierarchy }));
        } catch (caught) {
            setSpaceErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
        } finally {
            setSpaceLoading(current => current === spaceId ? undefined : current);
        }
    }

    async function createDirectMessage() {
        if (!dmSpaceId || !dmUserId) {
            setError("Choose a server and one of its joined members.");
            return;
        }
        await run(async () => {
            const opened = await openMatrixDirect(dmSpaceId, dmUserId);
            setRooms(snapshotRooms());
            setTab("rooms");
            if (!opened) {
                setError("The direct message could not be opened. Check the Matrix notification, then refresh Chats.");
            } else {
                setDmUserId("");
            }
        });
    }

    const accountServer = matrixServerName(config?.userId);

    function renderDeviceVerification() {
        const verification = deviceVerification?.verification;
        const phase = verification?.phase ?? "idle";
        const active = deviceVerificationBusy || ACTIVE_DEVICE_VERIFICATION_PHASES.has(phase);
        const statusError = deviceVerificationError(deviceVerification);
        const visibleError = deviceVerification?.verified
            ? ""
            : deviceVerificationActionError || statusError || deviceVerificationRefreshError;
        const deviceId = deviceVerification?.deviceId ?? config?.deviceId;
        const expiresAt = verification?.expiresAt;
        const expiryDate = typeof expiresAt === "number" && Number.isFinite(expiresAt)
            ? new Date(expiresAt)
            : undefined;
        const phaseLabel = deviceVerificationBusy && phase === "idle"
            ? "Starting verification"
            : deviceVerificationLabel(deviceVerification);
        const phaseExplanation = accountActionRequired
            ? "Reconnect this Matrix session before starting or continuing device verification."
            : deviceVerificationBusy && phase === "idle"
                ? "Sending a verification request to your other trusted Matrix devices."
                : deviceVerificationExplanation(deviceVerification);
        const retry = phase === "cancelled" || phase === "failed" || phase === "done";

        return (
            <section
                className="vc-matrix-card vc-matrix-device-verification-card"
                aria-labelledby="vc-matrix-device-verification-heading"
                aria-busy={(deviceVerificationBusy && phase === "idle") || deviceVerificationCancelBusy}
            >
                <div className="vc-matrix-device-verification-heading">
                    <div>
                        <Heading id="vc-matrix-device-verification-heading" tag="h4">Verify this device</Heading>
                        <Paragraph>
                            Compare this session with another trusted Matrix device. Security codes are handled only by a native Matrix comparison dialog and are never rendered here.
                        </Paragraph>
                    </div>
                    <span
                        className="vc-matrix-device-verification-trust"
                        data-verified={String(deviceVerification?.verified === true)}
                    >
                        {phaseLabel}
                    </span>
                </div>

                <div className="vc-matrix-device-verification-identity">
                    <span>Device ID</span>
                    <code dir="ltr">{deviceId || "Unavailable"}</code>
                </div>

                {deviceVerification && (
                    <div className="vc-matrix-device-verification-details" aria-label="Device trust details">
                        <span>Cross-signing: {deviceVerification.crossSigningVerified ? "verified" : "not verified"}</span>
                        <span>Cross-signing setup: {deviceVerification.crossSigningAvailable ? "available" : "unavailable"}</span>
                        <span>Owner signature: {deviceVerification.signedByOwner ? "present" : "not confirmed"}</span>
                        <span>Local verification: {deviceVerification.localVerified ? "verified" : "not verified"}</span>
                    </div>
                )}

                <div
                    className="vc-matrix-device-verification-status"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                >
                    <strong>{phaseLabel}</strong>
                    <span>{phaseExplanation}</span>
                    {verification?.otherDeviceId && (
                        <span>
                            Other device: <code dir="ltr">{verification.otherDeviceId}</code>
                        </span>
                    )}
                    {expiryDate && active && (
                        <span>Request expires <time dateTime={expiryDate.toISOString()}>{expiryDate.toLocaleString()}</time>.</span>
                    )}
                    {phase === "cancelled" && verification?.cancellationCode && (
                        <span>
                            {verification.cancelledByMe === true
                                ? "Cancelled on this device"
                                : verification.cancelledByMe === false
                                    ? "Cancelled by the other device"
                                    : "Verification cancelled"}
                            {verification.cancellationCode === "m.timeout" ? " because the request expired." : "."}
                        </span>
                    )}
                </div>

                {visibleError && (
                    <Paragraph className="vc-matrix-device-verification-error" role="alert">
                        {visibleError}
                    </Paragraph>
                )}

                <div className="vc-matrix-device-verification-actions">
                    {!deviceVerification?.verified && !active && (
                        <Button
                            disabled={deviceVerificationCancelBusy
                                || accountActionRequired
                                || !deviceVerification}
                            variant="positive"
                            onClick={() => void verifyThisDevice()}
                        >
                            {retry ? "Try verification again" : "Verify this device"}
                        </Button>
                    )}
                    {active && (
                        <Button
                            disabled={deviceVerificationCancelBusy}
                            variant="dangerSecondary"
                            onClick={() => void cancelThisDeviceVerification()}
                        >
                            {deviceVerificationCancelBusy ? "Cancelling verification..." : "Cancel verification"}
                        </Button>
                    )}
                </div>
            </section>
        );
    }

    function renderAccount() {
        return (
            <div className="vc-matrix-section-stack">
                <div className="vc-matrix-section-heading">
                    <Heading tag="h3">Account</Heading>
                    <Paragraph>
                        The session is encrypted with OS-protected storage. End-to-end encryption device state stays isolated in a dedicated native Matrix worker database. Passwords and registration tokens are never saved.
                    </Paragraph>
                    <Paragraph>
                        Sign-in details are entered through Discord&apos;s renderer before being passed to the native worker. They are cleared after authentication, but Discord&apos;s app code or another installed client plugin could inspect them while they are being entered.
                    </Paragraph>
                    <Paragraph>
                        Matrix message contents are not intentionally sent through Discord&apos;s message APIs. They are decrypted locally and copied into Discord&apos;s renderer so this UI can display them. Discord&apos;s app code and other installed client plugins can therefore read that plaintext in memory; this bridge cannot make the closed-source renderer cryptographically unable to inspect it. Synthetic Matrix IDs are blocked from Discord&apos;s REST API.
                    </Paragraph>
                    <Paragraph>
                        Supported encrypted-room GIF, Tenor, and X previews load automatically by default. KLIPY, Tenor, FxTwitter, and their media hosts can see your IP address, the public link, and request timing. You can turn this off below. Other encrypted-room link previews stay disabled. Uploaded attachments are unaffected.
                    </Paragraph>
                    <Paragraph>
                        In Discord, visible x.com and Twitter links and their preview cards open through girlcockx.com. The original link remains unchanged in Matrix; opening the projected link contacts girlcockx.com.
                    </Paragraph>
                    <Checkbox
                        value={matrixBridgeSettings.encryptedRoomProviderPreviews !== false}
                        size={20}
                        onChange={(_, enabled) => {
                            matrixBridgeSettings.encryptedRoomProviderPreviews = enabled;
                        }}
                    >
                        <span className="vc-matrix-checkbox-copy">
                            <strong>Load encrypted-room KLIPY GIF, Tenor, and X previews</strong>
                            <span>
                                Automatically contacts KLIPY (klipy.com, static.klipy.com, static2.klipy.com), Tenor (tenor.com, media.tenor.com, media1.tenor.com), FxTwitter (api.fxtwitter.com), or X media hosts (pbs.twimg.com, video.twimg.com). They can see your IP address, the public link, and request timing. Other encrypted-room links remain text only.
                            </span>
                        </span>
                    </Checkbox>
                </div>

                {!config?.configured ? (
                    <div className="vc-matrix-card vc-matrix-auth-card" aria-busy={busy}>
                        {preservedDevice && (
                            <div>
                                <Heading tag="h4">Signed out — local keys preserved</Heading>
                                <Paragraph>
                                    Sign back into {config.userId} on this homeserver to reuse the same Matrix device and encrypted history.
                                    To use another account, explicitly forget these local keys first.
                                </Paragraph>
                            </div>
                        )}
                        <TabBar
                            type="top"
                            look="brand"
                            selectedItem={mode}
                            onItemSelect={(nextMode: AuthMode) => {
                                setMode(nextMode);
                                clearSecrets();
                                setError("");
                            }}
                        >
                            <TabBar.Item id="login">Sign in</TabBar.Item>
                            {!preservedDevice && <TabBar.Item id="register">Create account</TabBar.Item>}
                        </TabBar>

                        <label>
                            <Heading tag="h5">Homeserver</Heading>
                            <TextInput
                                disabled={busy || preservedDevice}
                                value={homeserver}
                                placeholder="matrix.example.org"
                                onChange={setHomeserver}
                            />
                        </label>
                        <label>
                            <Heading tag="h5">Username</Heading>
                            <TextInput
                                disabled={busy || preservedDevice || !!accessToken}
                                value={username}
                                placeholder="alice"
                                onChange={setUsername}
                            />
                            <Paragraph>Just the username; no @name:server ID.</Paragraph>
                        </label>
                        <label>
                            <Heading tag="h5">Password</Heading>
                            <TextInput
                                disabled={busy || !!accessToken}
                                type="password"
                                value={password}
                                onChange={value => {
                                    setPassword(value);
                                    if (value) setAccessToken("");
                                }}
                            />
                        </label>

                        {mode === "register" ? (
                            <>
                                <label>
                                    <Heading tag="h5">Confirm password</Heading>
                                    <TextInput
                                        disabled={busy}
                                        type="password"
                                        value={confirmPassword}
                                        onChange={setConfirmPassword}
                                    />
                                </label>
                                <label>
                                    <Heading tag="h5">Registration token</Heading>
                                    <TextInput
                                        disabled={busy}
                                        type="password"
                                        value={registrationToken}
                                        placeholder="Token from the server owner"
                                        onChange={setRegistrationToken}
                                    />
                                </label>
                            </>
                        ) : (
                            <details className="vc-matrix-advanced-auth">
                                <summary>Advanced: use an access token</summary>
                                <Paragraph>
                                    {preservedDevice
                                        ? "The token must belong to this exact account and preserved Matrix device. A token for another account or device is rejected."
                                        : "Access-token login can start a session without the prior device's encryption state. Encrypted history may remain unavailable unless Matrix recovery or compatible device state is present."}
                                </Paragraph>
                                <label>
                                    <Heading tag="h5">Access token</Heading>
                                    <TextInput
                                        disabled={busy}
                                        type="password"
                                        value={accessToken}
                                        onChange={value => {
                                            setAccessToken(value);
                                            if (value) setPassword("");
                                        }}
                                    />
                                </label>
                            </details>
                        )}

                        <Button
                            disabled={busy}
                            variant="positive"
                            onClick={() => void (mode === "register" ? registerAccount() : login())}
                        >
                            {busy
                                ? mode === "register" ? "Creating account..." : "Signing in..."
                                : mode === "register" ? "Create account" : "Sign in"}
                        </Button>
                        {error && (
                            <Paragraph className="vc-matrix-auth-error" role="alert" style={{ color: "var(--text-danger)" }}>
                                {error}
                            </Paragraph>
                        )}
                        <Button
                            disabled={busy}
                            variant="secondary"
                            onClick={confirmLogout}
                        >
                            {preservedDevice ? "Forget account and keys" : "Clear local Matrix data"}
                        </Button>
                    </div>
                ) : (
                    <>
                        <div className="vc-matrix-card vc-matrix-account-card">
                            <div>
                                <Heading tag="h4">Connected account</Heading>
                                <Paragraph>{config.userId}</Paragraph>
                                <Paragraph>{config.homeserver}</Paragraph>
                            </div>
                            <div className="vc-matrix-row-actions">
                                <Button disabled={busy || addressBusy} variant="secondary" onClick={() => void signOut()}>
                                    Sign out
                                </Button>
                                <Button disabled={busy || addressBusy} variant="dangerSecondary" onClick={confirmLogout}>
                                    Forget account and keys
                                </Button>
                            </div>
                        </div>

                        {renderDeviceVerification()}

                        {reauthenticationRequired && (
                            <div className="vc-matrix-card vc-matrix-auth-card">
                                <div>
                                    <Heading tag="h4">Reconnect this Matrix session</Heading>
                                    <Paragraph role="alert">
                                        Your homeserver requested a safe reauthentication. Sign in to the same account and device; existing encrypted local data will be kept.
                                    </Paragraph>
                                </div>

                                <label>
                                    <Heading tag="h5">Password</Heading>
                                    <TextInput
                                        disabled={busy || !!accessToken}
                                        type="password"
                                        value={password}
                                        onChange={value => {
                                            setPassword(value);
                                            if (value) setAccessToken("");
                                        }}
                                    />
                                </label>

                                <details className="vc-matrix-advanced-auth">
                                    <summary>Advanced: use an access token</summary>
                                    <Paragraph>
                                        The token must belong to this exact account and Matrix device. A token for another device will be rejected.
                                    </Paragraph>
                                    <label>
                                        <Heading tag="h5">Access token</Heading>
                                        <TextInput
                                            disabled={busy}
                                            type="password"
                                            value={accessToken}
                                            onChange={value => {
                                                setAccessToken(value);
                                                if (value) setPassword("");
                                            }}
                                        />
                                    </label>
                                </details>

                                <Button
                                    disabled={busy || (!password && !accessToken)}
                                    variant="positive"
                                    onClick={() => void reauthenticate()}
                                >
                                    {busy ? "Reconnecting..." : "Reconnect account"}
                                </Button>
                                {error && (
                                    <Paragraph className="vc-matrix-auth-error" role="alert" style={{ color: "var(--text-danger)" }}>
                                        {error}
                                    </Paragraph>
                                )}
                            </div>
                        )}

                        {sessionResetRequired && (
                            <div className="vc-matrix-card vc-matrix-auth-card">
                                <div>
                                    <Heading tag="h4">Matrix session ended</Heading>
                                    <Paragraph role="alert">
                                        This session cannot be repaired in place. Sign out above, then sign back into the same account to retain this device&apos;s local encryption keys.
                                    </Paragraph>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    }

    function renderInvite(room: MatrixRoomDTO) {
        return (
            <div className="vc-matrix-room-card" key={room.roomId}>
                <RoomIdentity room={room} />
                {room.inviterId && <Paragraph>Invited by {room.inviterId}</Paragraph>}
                <div className="vc-matrix-row-actions">
                    <Button disabled={busy} variant="positive" onClick={() => void acceptInvite(room.roomId)}>
                        Accept
                    </Button>
                    <Button disabled={busy} variant="dangerSecondary" onClick={() => void rejectInvite(room.roomId)}>
                        Decline
                    </Button>
                </div>
            </div>
        );
    }

    function renderHierarchyRoom(
        spaceId: string,
        hierarchy: MatrixSpaceHierarchyDTO,
        room: MatrixSpaceHierarchyRoomDTO,
        depth: number,
    ) {
        const membership = roomMembership(room);
        const kind = roomKind(room);
        const joinable = canJoinFromHierarchy(room) && isHierarchyChild(hierarchy, room.roomId);
        return (
            <div
                className="vc-matrix-hierarchy-room"
                key={room.roomId}
                style={{ paddingLeft: `${14 + Math.min(depth, 8) * 16}px` }}
            >
                <RoomIdentity room={room} />
                <div className="vc-matrix-row-actions">
                    {membership === "join" && (
                        <Button
                            disabled={busy}
                            variant="secondary"
                            onClick={() => kind === "space"
                                ? openMatrixSpace(room.roomId)
                                : openMatrixRoom(room.roomId)}
                        >
                            Open
                        </Button>
                    )}
                    {membership === "invite" && (
                        <Button disabled={busy} variant="positive" onClick={() => void acceptInvite(room.roomId, spaceId)}>
                            Accept invite
                        </Button>
                    )}
                    {membership === "invite" && (
                        <Button disabled={busy} variant="dangerSecondary" onClick={() => void rejectInvite(room.roomId, spaceId)}>
                            Decline
                        </Button>
                    )}
                    {membership !== "join" && membership !== "invite" && joinable && (
                        <Button disabled={busy} variant="positive" onClick={() => void joinHierarchyRoom(spaceId, room)}>
                            Join
                        </Button>
                    )}
                    {membership !== "join" && membership !== "invite" && !joinable && (
                        <span className="vc-matrix-restriction">Invite or request required</span>
                    )}
                </div>
            </div>
        );
    }

    function renderSpaceAccess(space: MatrixRoomDTO) {
        const spaceId = space.roomId;
        const access = spaceAccess[spaceId];
        const draft = spaceAccessDrafts[spaceId];
        const requests = spaceAccessRequests[spaceId];
        const saving = spaceAccessAction === `save:${spaceId}`;
        const accessActionBusy = spaceAccessAction != null;
        return (
            <div className="vc-matrix-hierarchy">
                <div className="vc-matrix-section-heading">
                    <Heading tag="h4">Access settings</Heading>
                    <Paragraph>
                        Unlisted means not listed in your provider&apos;s public directory; links, aliases, or parent servers may still reveal the server. Admission is controlled by invitation or request; a join name is not a password.
                    </Paragraph>
                    {access && <Paragraph>
                        {spaceAccessConfirmed[spaceId] === false
                            ? `Could not verify current access. Last confirmed state: ${actualAccessLabel(access)}.`
                            : `Current access: ${actualAccessLabel(access)}.`}
                    </Paragraph>}
                </div>
                {spaceAccessLoading === spaceId && <Paragraph>Loading access settings...</Paragraph>}
                {space.canConfigureSpaceAccess === true && draft && (
                    <>
                        {access && (access.joinRule === "restricted" || access.joinRule === "knock_restricted") && (
                            <Paragraph style={{ color: "var(--text-warning)" }}>
                                Saving will replace the current linked-server membership rule with {simplifiedAccessModeLabel(draft.mode)}.
                            </Paragraph>
                        )}
                        <label>
                            <Heading tag="h5">Who can join?</Heading>
                            <Select
                                options={(["public", "request", "invite"] as const).map(mode => ({
                                    label: accessModeLabel(mode),
                                    value: mode,
                                }))}
                                closeOnSelect={true}
                                select={mode => {
                                    setSpaceAccessDrafts(current => ({
                                        ...current,
                                        [spaceId]: { ...current[spaceId], mode },
                                    }));
                                    setSpaceAccessErrors(current => ({ ...current, [spaceId]: "" }));
                                }}
                                isSelected={mode => mode === draft.mode}
                                serialize={mode => mode}
                                isDisabled={accessActionBusy || spaceAccessLoading === spaceId}
                            />
                        </label>
                        {draft.mode === "request" && (
                            <label>
                                <Heading tag="h5">Server join name</Heading>
                                <TextInput
                                    disabled={accessActionBusy || spaceAccessLoading === spaceId}
                                    value={draft.joinName}
                                    placeholder="my-server"
                                    maxLength={JOIN_NAME_MAX_LENGTH}
                                    onChange={value => {
                                        setSpaceAccessDrafts(current => ({
                                            ...current,
                                            [spaceId]: {
                                                ...current[spaceId],
                                                joinName: value.toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH),
                                            },
                                        }));
                                        setSpaceAccessErrors(current => ({ ...current, [spaceId]: "" }));
                                    }}
                                />
                                <Paragraph>
                                    Share this unique lowercase name so people can request access. It is not a password.
                                </Paragraph>
                                {access?.joinName && <Paragraph>Current join name: {access.joinName}</Paragraph>}
                            </label>
                        )}
                        <Button
                            disabled={accessActionBusy
                                || spaceAccessLoading === spaceId
                                || (draft.mode === "request" && !validJoinName(cleanJoinName(draft.joinName)))}
                            variant="positive"
                            onClick={() => void saveSpaceAccess(spaceId)}
                        >
                            {saving ? "Saving access settings..." : "Save access settings"}
                        </Button>
                    </>
                )}
                {spaceAccessErrors[spaceId] && (
                    <Paragraph style={{ color: "var(--text-danger)" }} role="alert">
                        {spaceAccessErrors[spaceId]}
                    </Paragraph>
                )}
                {requests && (
                    <div className="vc-matrix-section-heading">
                        <Heading tag="h5">Access requests ({requests.requests.length})</Heading>
                        {!requests.requests.length && <Paragraph>No pending access requests.</Paragraph>}
                        {requests.truncated && <Paragraph>Only the first pending requests are shown.</Paragraph>}
                        <div className="vc-matrix-card-list">
                            {requests.requests.map(request => {
                                const approveAction = `approve:${spaceId}:${request.userId}`;
                                const denyAction = `deny:${spaceId}:${request.userId}`;
                                const requesterName = safeRequesterDisplayName(request.displayName);
                                const requesterUserId = visibleRequesterUserId(request.userId);
                                return (
                                    <div className="vc-matrix-room-card" key={request.userId}>
                                        <div className="vc-matrix-room-identity">
                                            <Heading tag="h5">{requesterName || requesterUserId}</Heading>
                                            {requesterName && <div className="vc-matrix-room-id">{requesterUserId}</div>}
                                        </div>
                                        <div className="vc-matrix-row-actions">
                                            {request.canApprove && (
                                                <Button
                                                    disabled={accessActionBusy}
                                                    variant="positive"
                                                    onClick={() => void resolveAccessRequest(spaceId, request.userId, "approve")}
                                                >
                                                    {spaceAccessAction === approveAction ? "Approving..." : "Approve"}
                                                </Button>
                                            )}
                                            {request.canDeny && (
                                                <Button
                                                    disabled={accessActionBusy}
                                                    variant="dangerSecondary"
                                                    onClick={() => void resolveAccessRequest(spaceId, request.userId, "deny")}
                                                >
                                                    {spaceAccessAction === denyAction ? "Denying..." : "Deny"}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    function renderSpace(space: MatrixRoomDTO) {
        const expanded = expandedSpaces.has(space.roomId);
        const accessExpanded = expandedAccessSpaces.has(space.roomId);
        const hierarchy = spaceHierarchies[space.roomId];
        const children = hierarchyRows(hierarchy, space.roomId);
        const canOpenAccess = space.canConfigureSpaceAccess === true
            || space.canApproveAccessRequests === true
            || space.canDenyAccessRequests === true;
        return (
            <div className="vc-matrix-space-card" key={space.roomId}>
                <div className="vc-matrix-room-card">
                    <RoomIdentity room={space} />
                    <div className="vc-matrix-row-actions">
                        <Button disabled={busy} variant="secondary" onClick={() => openMatrixSpace(space.roomId)}>
                            Open
                        </Button>
                        <Button disabled={busy || spaceLoading === space.roomId} variant="secondary" onClick={() => void toggleSpace(space.roomId)}>
                            {spaceLoading === space.roomId ? "Loading..." : expanded ? "Hide rooms" : "Browse rooms"}
                        </Button>
                        <Button
                            disabled={busy || Boolean(suggestedChannelsLoading)}
                            variant="secondary"
                            onClick={() => void showSuggestedChannels(space.roomId)}
                        >
                            {suggestedChannelsLoading === space.roomId ? "Loading suggestions..." : "Suggested Channels"}
                        </Button>
                        {canOpenAccess && (
                            <Button
                                disabled={busy || spaceAccessLoading === space.roomId}
                                variant="secondary"
                                onClick={() => toggleSpaceAccess(space)}
                            >
                                {spaceAccessLoading === space.roomId
                                    ? "Loading access..."
                                    : `${accessExpanded ? "Hide access settings" : "Access settings"}${space.accessRequestCount ? ` (${space.accessRequestCount})` : ""}`}
                            </Button>
                        )}
                        <Button disabled={busy} variant="dangerSecondary" onClick={() => confirmLeave(space)}>
                            Leave
                        </Button>
                    </div>
                </div>
                {expanded && (
                    <div className="vc-matrix-hierarchy">
                        {spaceLoading === space.roomId && <Paragraph>Loading this server...</Paragraph>}
                        {spaceErrors[space.roomId] && (
                            <Paragraph style={{ color: "var(--text-danger)" }}>
                                Could not load this server: {spaceErrors[space.roomId]}
                            </Paragraph>
                        )}
                        {hierarchy && children.length === 0 && <Paragraph>This server has no visible rooms.</Paragraph>}
                        {hierarchy && children.map(({ room, depth }) =>
                            renderHierarchyRoom(space.roomId, hierarchy, room, depth))}
                    </div>
                )}
                {accessExpanded && renderSpaceAccess(space)}
            </div>
        );
    }

    function renderRooms() {
        if (!config?.configured) {
            return (
                <div className="vc-matrix-empty-state">
                    <Heading tag="h3">Connect a Matrix account</Heading>
                    <Paragraph>Sign in first to make your Matrix chats available in Discord.</Paragraph>
                    <Button variant="positive" onClick={() => setTab("account")}>Open account setup</Button>
                </div>
            );
        }

        return (
            <div className="vc-matrix-section-stack">
                {invites.length > 0 && (
                    <section>
                        <div className="vc-matrix-section-heading">
                            <Heading tag="h3">Invitations</Heading>
                            <Paragraph>Accept or decline invitations to chats and servers.</Paragraph>
                        </div>
                        <div className="vc-matrix-card-list">{invites.map(renderInvite)}</div>
                    </section>
                )}

                <section>
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-actions">
                        <div>
                            <Heading tag="h3">Servers</Heading>
                            <Paragraph>Each server can contain multiple chats.</Paragraph>
                        </div>
                        <Button
                            disabled={busy || spaceCreationPending || spaceCreationNeedsRefresh}
                            variant="positive"
                            onClick={openCreateMatrixServer}
                        >
                            {spaceCreationPending
                                ? "Creating server..."
                                : spaceCreationNeedsRefresh ? "Refresh before creating" : "Create server"}
                        </Button>
                    </div>
                    <div className="vc-matrix-card-list">
                        {joinedSpaces.map(renderSpace)}
                        {!joinedSpaces.length && <Paragraph>No joined servers.</Paragraph>}
                    </div>
                </section>

                <section>
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-control">
                        <div>
                            <Heading tag="h3">Chats</Heading>
                            <Paragraph>Every joined Matrix room is available in Discord automatically.</Paragraph>
                        </div>
                        <TextInput
                            value={roomSearch}
                            placeholder="Search chats"
                            onChange={setRoomSearch}
                        />
                    </div>
                    <div className="vc-matrix-card-list">
                        {visibleChats.map(room => {
                            const groupInvite = room.groupChat === true
                                ? getMatrixGroupInviteContextForRoom(room.roomId)
                                : undefined;
                            return (
                                <div className="vc-matrix-room-card" key={room.roomId}>
                                    <RoomIdentity room={room} />
                                    <div className="vc-matrix-row-actions">
                                        <Button disabled={busy} variant="secondary" onClick={() => openMatrixRoom(room.roomId)}>
                                            Open
                                        </Button>
                                        {room.groupChat === true && (
                                            <Button
                                                disabled={busy || !groupInvite}
                                                variant="secondary"
                                                onClick={() => openMatrixGroupInviteForRoom(room.roomId)}
                                            >
                                                {groupInvite?.full
                                                    ? "Group full"
                                                    : groupInvite?.canInvite ? "Add People" : "Add People unavailable"}
                                            </Button>
                                        )}
                                        <Button disabled={busy} variant="dangerSecondary" onClick={() => confirmLeave(room)}>
                                            Leave
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                        {!visibleChats.length && (
                            <Paragraph>{joinedChats.length ? "No chats match that search." : "No joined chats."}</Paragraph>
                        )}
                    </div>
                </section>

                <section className="vc-matrix-card vc-matrix-dm-card">
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-actions">
                        <div>
                            <Heading tag="h3">Create a group chat</Heading>
                            <Paragraph>
                                Create a private group now. Optionally search for up to nine people to invite before creation,
                                or add people later from the group chat.
                            </Paragraph>
                        </div>
                        <Button
                            disabled={busy}
                            variant="positive"
                            onClick={() => {
                                if (!openMatrixGroupChatCreate()) {
                                    setError("The signed-in account changed. Refresh settings and try again.");
                                }
                            }}
                        >
                            Create Group Chat
                        </Button>
                    </div>
                </section>

                <section className="vc-matrix-card vc-matrix-dm-card">
                    <div className="vc-matrix-section-heading">
                        <Heading tag="h3">Start a direct message</Heading>
                            <Paragraph>Choose a joined member from one of your servers.</Paragraph>
                    </div>
                    <label>
                        <Heading tag="h5">Server</Heading>
                        <Select
                            placeholder={joinedSpaces.length ? "Choose a server" : "Join a server first"}
                            options={joinedSpaces.map(space => ({ label: roomName(space), value: space.roomId }))}
                            maxVisibleItems={8}
                            closeOnSelect={true}
                            select={value => {
                                setDmSpaceId(value);
                                setDmUserId("");
                                setDmMembersError("");
                            }}
                            isSelected={value => value === dmSpaceId}
                            serialize={value => value}
                            isDisabled={busy || joinedSpaces.length === 0}
                        />
                    </label>
                    <label>
                        <Heading tag="h5">Member</Heading>
                        <MemberSelect
                            disabled={busy || dmMembersLoading || !dmSpaceId}
                            members={dmMembers}
                            selected={dmUserId}
                            onSelect={setDmUserId}
                        />
                        {dmMembersLoading && <Paragraph>Loading server members...</Paragraph>}
                        {dmMembersError && <Paragraph>Could not load all members: {dmMembersError}</Paragraph>}
                    </label>
                    <Button
                        disabled={busy || dmMembersLoading || !dmSpaceId || !dmUserId}
                        variant="positive"
                        onClick={() => void createDirectMessage()}
                    >
                        Open direct message
                    </Button>
                </section>
            </div>
        );
    }

    function renderDiscover() {
        if (!config?.configured) {
            return (
                <div className="vc-matrix-empty-state">
                    <Heading tag="h3">Connect a Matrix account</Heading>
                    <Paragraph>Sign in before discovering or joining rooms.</Paragraph>
                    <Button variant="positive" onClick={() => setTab("account")}>Open account setup</Button>
                </div>
            );
        }

        return (
            <div className="vc-matrix-section-stack">
                <section className="vc-matrix-card vc-matrix-room-address">
                    <div className="vc-matrix-section-heading">
                        <Heading tag="h3">Request server access</Heading>
                        <Paragraph>Enter the server's join name. An admin can then approve your request.</Paragraph>
                    </div>
                    <label>
                        <Heading tag="h5">Server join name</Heading>
                        <TextInput
                            disabled={busy || joinNameBusy || addressBusy}
                            value={joinName}
                            placeholder="my-server"
                            maxLength={JOIN_NAME_MAX_LENGTH}
                            onChange={value => {
                                setJoinName(value.toLowerCase().slice(0, JOIN_NAME_MAX_LENGTH));
                                setJoinNameError("");
                            }}
                        />
                    </label>
                    <Button
                        disabled={busy || joinNameBusy || addressBusy || !joinName.trim()}
                        variant="positive"
                        onClick={() => void requestAccess(joinName)}
                    >
                        {joinNameBusy ? "Requesting access..." : "Request access"}
                    </Button>
                    {joinNameError && <Paragraph style={{ color: "var(--text-danger)" }} role="alert">{joinNameError}</Paragraph>}
                </section>

                <details className="vc-matrix-card vc-matrix-room-address">
                    <summary>Advanced: join by full room address</summary>
                    <div className="vc-matrix-section-heading">
                        <Paragraph>
                            Enter #alias:server, !legacy-id:server, or a domainless room ID such as !opaque. It will be routed through {accountServer ?? "this account's Matrix server"}.
                        </Paragraph>
                    </div>
                    <label>
                        <Heading tag="h5">Matrix room alias or ID</Heading>
                        <TextInput
                            disabled={busy || addressBusy || joinNameBusy || !!pendingAddressRoomId}
                            value={roomAddress}
                            placeholder={`#general:${accountServer ?? "example.org"} or !opaque`}
                            maxLength={512}
                            onChange={value => {
                                setRoomAddress(value.slice(0, 512));
                                setAddressError("");
                            }}
                        />
                    </label>
                    <Button
                        disabled={busy || addressBusy || joinNameBusy || !!pendingAddressRoomId || !roomAddress.trim()}
                        variant="positive"
                        onClick={() => void joinRoomByAddress()}
                    >
                        {addressBusy || pendingAddressRoomId ? "Waiting for sync..." : "Join room"}
                    </Button>
                    {addressError && <Paragraph style={{ color: "var(--text-danger)" }}>{addressError}</Paragraph>}
                </details>

                <section>
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-actions">
                        <div>
                            <Heading tag="h3">Discover servers & chats</Heading>
                            <Paragraph>
                                Public listings from your provider. Unlisted servers are not listed here, but links, aliases, or parent servers may still reveal them. Admission is controlled by invitation or request; a join name is not a password.
                            </Paragraph>
                        </div>
                        <Button
                            disabled={busy || directoryBusy}
                            variant="secondary"
                            onClick={() => void loadPublicRooms()}
                        >
                            {directoryBusy ? "Refreshing directory..." : "Refresh directory"}
                        </Button>
                    </div>
                    <div className="vc-matrix-heading-with-control">
                        <div>
                            <Paragraph role="status" aria-live="polite">
                                {directoryBusy
                                    ? "Fetching public listings from your provider..."
                                    : directoryLoaded
                                        ? `${publicRooms.length} supported listings: ${publicChatCount} chats and ${publicSpaceCount} servers.`
                                        : "Discovery has not been loaded yet."}
                            </Paragraph>
                            {!directoryBusy && directoryTotalEstimate != null && (
                                <Paragraph>Provider estimate: {directoryTotalEstimate} total public listings.</Paragraph>
                            )}
                            {!directoryBusy && directoryTruncated && (
                                <Paragraph style={{ color: "var(--text-warning)" }}>
                                    The safe 2,000-entry scan limit was reached; this list is incomplete.
                                </Paragraph>
                            )}
                        </div>
                        <TextInput
                            disabled={directoryBusy && !publicRooms.length}
                            value={directorySearch}
                            placeholder="Search public servers & chats"
                            onChange={setDirectorySearch}
                        />
                    </div>
                    <div className="vc-matrix-card-list">
                        {visiblePublicRooms.map(room => {
                            const knownRoom = knownRoomsById.get(room.roomId);
                            const membership = knownRoom && roomMembership(knownRoom);
                            const isSpace = room.roomType === "m.space";
                            const listedJoinName = room.joinRule === "knock" && isSpace
                                ? joinNameFromAlias(room.alias, accountServer)
                                : undefined;
                            return (
                                <div className="vc-matrix-room-card" key={room.roomId}>
                                    <div className="vc-matrix-room-identity">
                                        <div className="vc-matrix-room-heading">
                                            <Heading tag="h5">{room.name || room.alias || room.roomId}</Heading>
                                            <span className={`vc-matrix-kind${isSpace ? " vc-matrix-kind-space" : ""}`}>
                                                {isSpace ? "Server" : "Chat"}
                                            </span>
                                            {membership === "join" && <span className="vc-matrix-kind">Joined</span>}
                                            {membership === "invite" && <span className="vc-matrix-kind">Invited</span>}
                                        </div>
                                        <div className="vc-matrix-room-id">{room.alias || room.roomId}</div>
                                        {room.topic && <Paragraph>{room.topic}</Paragraph>}
                                        <Paragraph>{room.joinedMembers} joined members</Paragraph>
                                    </div>
                                    {membership === "join" ? (
                                        <Button
                                            disabled={busy || addressBusy}
                                            variant="secondary"
                                            onClick={() => isSpace
                                                ? openMatrixSpace(room.roomId)
                                                : openMatrixRoom(room.roomId)}
                                        >
                                            Open
                                        </Button>
                                    ) : membership === "invite" ? (
                                        <Button
                                            disabled={busy || addressBusy || directoryBusy}
                                            variant="positive"
                                            onClick={() => void acceptInvite(room.roomId)}
                                        >
                                            Accept invite
                                        </Button>
                                    ) : room.joinRule === "knock" ? listedJoinName ? (
                                        <Button
                                            disabled={busy || joinNameBusy || addressBusy || directoryBusy}
                                            variant="positive"
                                            onClick={() => void requestAccess(listedJoinName, false)}
                                        >
                                            {joinNameBusy ? "Requesting..." : "Request access"}
                                        </Button>
                                    ) : (
                                        <span className="vc-matrix-restriction">Ask an admin for an invitation</span>
                                    ) : (
                                        <Button
                                            disabled={busy || joinNameBusy || addressBusy || directoryBusy}
                                            variant="positive"
                                            onClick={() => void joinPublicRoom(room)}
                                        >
                                            {isSpace ? "Join server" : "Join"}
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                        {directoryLoaded && !directoryBusy && !publicRooms.length && !directoryError && (
                            <Paragraph>No supported public servers or chats were found.</Paragraph>
                        )}
                        {directoryLoaded && !directoryBusy && publicRooms.length > 0 && !visiblePublicRooms.length && (
                            <Paragraph>No public servers or chats match that search.</Paragraph>
                        )}
                    </div>
                    {directoryError && (
                        <Paragraph style={{ color: "var(--text-danger)" }} role="alert">
                            Directory refresh failed{publicRooms.length ? "; showing the last successful result" : ""}: {directoryError}
                        </Paragraph>
                    )}
                </section>
            </div>
        );
    }

    const visibleTab: SettingsTab = accountActionRequired ? "account" : tab;

    return (
        <div className="vc-matrix-settings">
            <div className="vc-matrix-settings-header">
                <div>
                    <Heading tag="h2">Matrix Bridge</Heading>
                    <Paragraph>Status: {statusLabel(status)}</Paragraph>
                </div>
                {config?.configured && (
                    <Button
                        disabled={accountActionRequired || busy || addressBusy || directoryBusy}
                        variant="secondary"
                        onClick={() => void refreshAll()}
                    >
                        {refreshBusy ? "Refreshing rooms & directory..." : "Refresh rooms & directory"}
                    </Button>
                )}
            </div>

            <TabBar
                type="top"
                look="brand"
                selectedItem={visibleTab}
                onItemSelect={(nextTab: SettingsTab) => {
                    setTab(accountActionRequired ? "account" : nextTab);
                    if (nextTab !== "discover") {
                        setJoinName("");
                        setJoinNameError("");
                        setRoomAddress("");
                        setAddressError("");
                    }
                    if (nextTab !== "rooms") {
                        setExpandedAccessSpaces(new Set());
                        setSpaceAccessDrafts({});
                    }
                    setError("");
                    setNotice("");
                }}
            >
                <TabBar.Item id="rooms">Chats & servers{invites.length ? ` (${invites.length})` : ""}</TabBar.Item>
                <TabBar.Item id="discover">Discover</TabBar.Item>
                <TabBar.Item id="account">Account</TabBar.Item>
            </TabBar>

            {error && <Paragraph style={{ color: "var(--text-danger)" }}>{error}</Paragraph>}
            {notice && <Paragraph className={`vc-matrix-notice vc-matrix-notice-${noticeTone}`}>{notice}</Paragraph>}

            {visibleTab === "rooms" ? renderRooms() : visibleTab === "discover" ? renderDiscover() : renderAccount()}
        </div>
    );
}
