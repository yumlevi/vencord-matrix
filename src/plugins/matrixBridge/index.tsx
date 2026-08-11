/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { findGroupChildrenByChildId, type NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import SettingsPlugin from "@plugins/_core/settings";
import { Devs } from "@utils/constants";
import { removeFromArray } from "@utils/misc";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import { ChannelType, StickerFormatType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import {
    ConfirmModal,
    DraftType,
    FluxDispatcher,
    Menu,
    openModal,
    React,
    SelectedChannelStore,
    SettingsRouter,
    showToast,
    StickersStore,
    Toasts,
    Tooltip,
    UploadAttachmentStore,
    UploadManager
} from "@webpack/common";

import {
    MatrixAccessRequestsToolbarButton,
    openMatrixAccessRequests,
    startMatrixAccessRequestUx,
    stopMatrixAccessRequestUx,
} from "./accessRequests";
import {
    activateMatrixChannel,
    addMatrixReaction,
    deleteMatrixMessage,
    editMatrixMessage,
    fetchMatrixMessages,
    getMatrixAccessRequestContext,
    getMatrixCategoryCreateContext,
    getMatrixGroupChatCreateContext,
    getMatrixGroupInviteContext,
    getMatrixGroupLeaveContext,
    getMatrixInviteContext,
    getMatrixSendSessionToken,
    getMatrixSpaceCreateContext,
    getMatrixVideoPosterUrl,
    hasMatrixRecipients,
    installReadStateProjection,
    installRestGuard,
    isMatrixChannelId,
    isMatrixGuildId,
    isMatrixMediaUrl,
    leaveMatrixGroup,
    leaveMatrixGuild,
    matrixReceipt,
    matrixTyping,
    openMatrixPrivateChannel,
    reapplyMatrixProjectionAfterConnectionOpen,
    removeMatrixReaction,
    removeReadStateProjection,
    removeRestGuard,
    restartBridge,
    sendMatrixAttachment,
    sendMatrixMessage,
    sendMatrixSticker,
    setEncryptedRoomProviderPreviewsPolicy,
    startBridge,
    subscribeMatrixSpaceProjection,
    suspendBridge,
} from "./bridge";
import { openMatrixGroupChatCreate } from "./groupCreate";
import { openMatrixGroupInvite } from "./groupInvite";
import { openMatrixInvitePeople } from "./invite";
import {
    MATRIX_EDITED_REACTION_UPDATE_PATCH,
    MATRIX_PARTIAL_REACTION_UPDATE_PATCH,
    patchEditedMatrixReactionUpdate,
    patchPartialMatrixReactionUpdate,
    selectProjectedMessageReactions,
} from "./reactionProjection";
import { openMatrixSearch } from "./search";
import { MatrixSettings } from "./settings";
import { openMatrixSpaceChildModal } from "./spaceCreate";
import type { MatrixAttachmentGroupDTO, MatrixPowerLevelPermissionDTO } from "./types";
import { MATRIX_VIDEO_POSTER_PATCH, MATRIX_VIDEO_POSTER_REPLACEMENT } from "./videoPosterPatch";

const settings = definePluginSettings({
    encryptedRoomProviderPreviews: {
        type: OptionType.BOOLEAN,
        displayName: "Encrypted-room GIF, Tenor, and X previews",
        description: "Automatically load supported cards directly in encrypted Matrix rooms. KLIPY (klipy.com, static.klipy.com, static2.klipy.com), Tenor (tenor.com, media.tenor.com, media1.tenor.com), FxTwitter (api.fxtwitter.com), and X media hosts (pbs.twimg.com, video.twimg.com) can see your IP address, the public link, and request timing. Other encrypted-room link previews remain disabled.",
        default: true,
        onChange: enabled => {
            void setEncryptedRoomProviderPreviewsPolicy(enabled).catch(() => {
                showToast("Matrix could not apply the encrypted-room preview setting.", Toasts.Type.FAILURE);
            });
        },
    },
    matrix: {
        type: OptionType.COMPONENT,
        component: MatrixSettings,
    },
});

const MATRIX_SETTINGS_ENTRY_KEY = "vencord_matrix";
const ChannelSidebarActions = findByPropsLazy("toggleMembersSection");
let pluginLifecycleGeneration = 0;
let pendingPluginShutdown: Promise<void> = Promise.resolve();

const MAX_MATRIX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MATRIX_ATTACHMENT_COUNT = 10;
const MAX_MATRIX_ATTACHMENT_BATCH_BYTES = 100 * 1024 * 1024;
const MAX_TOMBSTONE_CHANNELS = 32;
const MAX_TOMBSTONES_PER_CHANNEL = MAX_MATRIX_ATTACHMENT_COUNT;
const activeAttachmentBatches = new Set<string>();
const consumedUploadTombstones = new Map<string, Set<string>>();
const attachmentGroupAssignments = new Map<string, {
    sessionToken: string;
    assignments: Map<string, MatrixAttachmentGroupDTO>;
}>();
let tombstoneSafetyLock = false;

type MatrixComposerUpload = ReturnType<typeof UploadAttachmentStore.getUploads>[number];

interface MatrixAttachmentBatchResult {
    total: number;
    sent: number;
    complete: boolean;
    failedIndex?: number;
    cleanupFailed?: boolean;
    contentConsumed: boolean;
}

function attachmentName(upload: any, file: File) {
    const source = typeof upload?.filename === "string" && upload.filename
        ? upload.filename
        : file.name || "attachment";
    const clean = source.replace(/[\u0000-\u001f\u007f\\/]+/gu, "_").slice(0, 255) || "attachment";
    return upload?.spoiler && !clean.startsWith("SPOILER_")
        ? `SPOILER_${clean}`.slice(0, 255)
        : clean;
}

function attachmentMimeType(upload: any, file: File) {
    const source = typeof file.type === "string" && file.type
        ? file.type
        : typeof upload?.mimeType === "string" ? upload.mimeType : "";
    const candidate = source.split(";", 1)[0].trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(candidate) ? candidate : undefined;
}

async function videoMetadata(file: File): Promise<{
    width?: number;
    height?: number;
    durationMs?: number;
}> {
    const objectUrl = URL.createObjectURL(file);
    const element = document.createElement("video");
    element.muted = true;
    element.preload = "metadata";
    try {
        return await new Promise(resolve => {
            let settled = false;
            const finish = (value: { width?: number; height?: number; durationMs?: number; }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => finish({}), 5_000);
            element.onloadedmetadata = () => {
                const width = Number.isSafeInteger(element.videoWidth) && element.videoWidth > 0
                    ? element.videoWidth
                    : undefined;
                const height = Number.isSafeInteger(element.videoHeight) && element.videoHeight > 0
                    ? element.videoHeight
                    : undefined;
                const durationCandidate = Number.isFinite(element.duration) && element.duration >= 0
                    ? Math.round(element.duration * 1_000)
                    : undefined;
                const durationMs = durationCandidate != null && durationCandidate <= 7 * 24 * 60 * 60_000
                    ? durationCandidate
                    : undefined;
                finish(width && height ? { width, height, durationMs } : { durationMs });
            };
            element.onerror = () => finish({});
            element.src = objectUrl;
            element.load();
        });
    } finally {
        element.onloadedmetadata = null;
        element.onerror = null;
        element.removeAttribute("src");
        element.load();
        URL.revokeObjectURL(objectUrl);
    }
}

function sameComposerUpload(left: MatrixComposerUpload, right: MatrixComposerUpload) {
    if (left === right) return true;
    if (typeof left.id === "string" && left.id && left.id === right.id) return true;
    return typeof left.uniqueId === "string" && left.uniqueId && left.uniqueId === right.uniqueId;
}

function composerUploadKey(upload: MatrixComposerUpload) {
    const id = typeof upload.id === "string" ? upload.id.slice(0, 256) : "";
    const uniqueId = typeof upload.uniqueId === "string" ? upload.uniqueId.slice(0, 256) : "";
    return `${id.length}:${id}:${uniqueId}`;
}

async function attachmentTxnId(channelId: string, upload: MatrixComposerUpload, file: File) {
    const identity = [
        channelId,
        typeof upload.id === "string" ? upload.id.slice(0, 512) : "",
        typeof upload.uniqueId === "string" ? upload.uniqueId.slice(0, 512) : "",
        file.name.slice(0, 512),
        String(file.size),
        String(file.lastModified)
    ].join("\0");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
    return `vcatt_${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function attachmentGroupId(transactionIds: string[]) {
    const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(transactionIds.join("\0"))
    ));
    return `vcgrp_${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function attachmentGroupPlan(
    channelId: string,
    sessionToken: string,
    uploads: Array<{ upload: MatrixComposerUpload; file: File; }>,
    transactionIds: string[]
): Promise<Array<MatrixAttachmentGroupDTO | undefined> | undefined> {
    const uploadKeys = uploads.map(({ upload }) => composerUploadKey(upload));
    if (new Set(uploadKeys).size !== uploadKeys.length) {
        showToast("Discord did not provide unique identities for this attachment batch.", Toasts.Type.FAILURE);
        return undefined;
    }
    let record = attachmentGroupAssignments.get(channelId);
    if (record?.sessionToken !== sessionToken) {
        attachmentGroupAssignments.delete(channelId);
        record = undefined;
    }
    let assignments = record?.assignments;
    if (assignments) {
        const presentKeys = new Set(uploadKeys);
        for (const key of assignments.keys()) {
            if (!presentKeys.has(key)) assignments.delete(key);
        }
        if (!assignments.size) {
            attachmentGroupAssignments.delete(channelId);
            assignments = undefined;
        }
    }

    const existing = uploadKeys.map(key => assignments?.get(key));
    if (existing.some(Boolean)) {
        const first = existing.find((group): group is MatrixAttachmentGroupDTO => Boolean(group))!;
        if (existing.some(group => !group || group.id !== first.id || group.total !== first.total)) {
            showToast(
                "Finish or remove the remaining Matrix attachment batch before adding new files.",
                Toasts.Type.FAILURE
            );
            return undefined;
        }
        return existing;
    }
    if (uploads.length < 2) return uploads.map(() => undefined);
    if (!assignments) {
        if (attachmentGroupAssignments.size >= MAX_TOMBSTONE_CHANNELS) {
            showToast("Too many unfinished Matrix attachment batches are open.", Toasts.Type.FAILURE);
            return undefined;
        }
        assignments = new Map();
        attachmentGroupAssignments.set(channelId, { sessionToken, assignments });
    }
    const id = await attachmentGroupId(transactionIds);
    const plan = uploadKeys.map((key, index) => {
        const group = { id, index, total: uploads.length };
        assignments!.set(key, group);
        return group;
    });
    return plan;
}

function rememberConsumedUpload(channelId: string, upload: MatrixComposerUpload) {
    let tombstones = consumedUploadTombstones.get(channelId);
    if (!tombstones) {
        if (consumedUploadTombstones.size >= MAX_TOMBSTONE_CHANNELS) {
            tombstoneSafetyLock = true;
            return;
        }
        consumedUploadTombstones.set(channelId, tombstones = new Set());
    }
    const key = composerUploadKey(upload);
    if (tombstones.size >= MAX_TOMBSTONES_PER_CHANNEL && !tombstones.has(key)) {
        tombstoneSafetyLock = true;
        return;
    }
    tombstones.add(key);
}

function uploadWasRemoved(channelId: string, upload: MatrixComposerUpload) {
    try {
        return !UploadAttachmentStore
            .getUploads(channelId, DraftType.ChannelMessage)
            .some(candidate => sameComposerUpload(candidate, upload));
    } catch {
        return false;
    }
}

function removeSentUpload(channelId: string, upload: MatrixComposerUpload) {
    try {
        // Discord's REMOVE_FILES reducer matches CloudUpload.id exactly, calls
        // removeFromMsgDraft(), and publishes the shortened store list.
        UploadManager.removeFiles(channelId, [upload.id], DraftType.ChannelMessage);
    } catch {
        // Fall back to replacing the draft list below.
    }
    if (uploadWasRemoved(channelId, upload)) return true;

    try {
        upload.removeFromMsgDraft();
        const remaining = UploadAttachmentStore
            .getUploads(channelId, DraftType.ChannelMessage)
            .filter(candidate => !sameComposerUpload(candidate, upload));
        UploadManager.setUploads({
            uploads: remaining,
            channelId,
            draftType: DraftType.ChannelMessage,
            resetState: false
        });
    } catch {
        return false;
    }
    return uploadWasRemoved(channelId, upload);
}

function retryConsumedUploadCleanup(channelId: string, uploads: MatrixComposerUpload[]) {
    const tombstones = consumedUploadTombstones.get(channelId);
    if (!tombstones) return true;

    const present = new Set<string>();
    let blocked = false;
    for (const upload of uploads) {
        const key = composerUploadKey(upload);
        if (!tombstones.has(key)) continue;
        present.add(key);
        if (removeSentUpload(channelId, upload)) tombstones.delete(key);
        else blocked = true;
    }
    for (const key of tombstones) {
        if (!present.has(key)) tombstones.delete(key);
    }
    if (!tombstones.size) consumedUploadTombstones.delete(channelId);
    return !blocked;
}

async function sendMatrixAttachmentBatch(
    channelId: string,
    uploads: Array<{ upload: MatrixComposerUpload; file: File; }>,
    caption: string | undefined,
    replyMessageId: string | undefined
): Promise<MatrixAttachmentBatchResult> {
    const result: MatrixAttachmentBatchResult = {
        total: uploads.length,
        sent: 0,
        complete: false,
        contentConsumed: false
    };
    const lifecycleGeneration = pluginLifecycleGeneration;
    const sessionToken = getMatrixSendSessionToken(channelId);
    if (!sessionToken) {
        showToast("The Matrix channel is no longer connected.", Toasts.Type.FAILURE);
        return result;
    }
    const sessionIsCurrent = () =>
        lifecycleGeneration === pluginLifecycleGeneration
        && getMatrixSendSessionToken(channelId) === sessionToken;
    const stopForSessionChange = (failedIndex?: number) => {
        if (attachmentGroupAssignments.get(channelId)?.sessionToken === sessionToken) {
            attachmentGroupAssignments.delete(channelId);
        }
        result.failedIndex = failedIndex;
        showToast(
            "The Matrix account or connection changed. Unsent attachments remain in the draft.",
            Toasts.Type.FAILURE
        );
    };

    let transactionIds: string[];
    let attachmentGroups: Array<MatrixAttachmentGroupDTO | undefined> | undefined;
    try {
        if (!sessionIsCurrent()) {
            stopForSessionChange();
            return result;
        }
        transactionIds = await Promise.all(uploads.map(({ upload, file }) =>
            attachmentTxnId(channelId, upload, file)));
        if (!sessionIsCurrent()) {
            stopForSessionChange();
            return result;
        }
        attachmentGroups = await attachmentGroupPlan(channelId, sessionToken, uploads, transactionIds);
        if (!sessionIsCurrent()) {
            stopForSessionChange();
            return result;
        }
    } catch {
        showToast("Discord could not prepare this attachment batch for Matrix.", Toasts.Type.FAILURE);
        return result;
    }
    if (!attachmentGroups) return result;
    const plannedUploads = uploads.map((item, index) => ({
        ...item,
        txnId: transactionIds[index],
        attachmentGroup: attachmentGroups![index],
        originalIndex: index,
    })).sort((left, right) =>
        (left.attachmentGroup?.index ?? left.originalIndex)
        - (right.attachmentGroup?.index ?? right.originalIndex));

    for (let index = 0; index < plannedUploads.length; index++) {
        const { upload, file, txnId, attachmentGroup } = plannedUploads[index];
        let bytes: Uint8Array<ArrayBuffer>;
        try {
            if (!sessionIsCurrent()) {
                stopForSessionChange(index);
                break;
            }
            const buffer = await file.arrayBuffer();
            if (buffer.byteLength !== file.size || buffer.byteLength > MAX_MATRIX_ATTACHMENT_BYTES) throw new Error();
            bytes = new Uint8Array(buffer);
        } catch {
            showToast(`Discord could not read attachment ${index + 1} for Matrix.`, Toasts.Type.FAILURE);
            result.failedIndex = index;
            break;
        }
        if (!sessionIsCurrent()) {
            bytes.fill(0);
            stopForSessionChange(index);
            break;
        }

        const declaredMimeType = attachmentMimeType(upload, file);
        let metadata: Awaited<ReturnType<typeof videoMetadata>> = {};
        if (upload.isVideo || declaredMimeType?.startsWith("video/")) {
            try {
                if (!sessionIsCurrent()) {
                    bytes.fill(0);
                    stopForSessionChange(index);
                    break;
                }
                metadata = await videoMetadata(file);
            } catch {
                // Dimensions and duration are optional Matrix metadata. A
                // valid file should still send when the browser cannot probe it.
            }
            if (!sessionIsCurrent()) {
                bytes.fill(0);
                stopForSessionChange(index);
                break;
            }
        }

        const finalAttachment = index === plannedUploads.length - 1;
        showToast(`Uploading attachment ${index + 1} of ${plannedUploads.length} to Matrix...`, Toasts.Type.MESSAGE);
        let sent = false;
        let sessionChangedAfterSend = false;
        try {
            if (!sessionIsCurrent()) {
                stopForSessionChange(index);
                break;
            }
            sent = await sendMatrixAttachment(channelId, {
                name: attachmentName(upload, file),
                txnId,
                declaredMimeType,
                bytes,
                // Caption and reply are attached to the final event. If an
                // earlier item fails, both remain in the Discord draft and are
                // therefore delivered exactly once on a later retry.
                caption: finalAttachment ? caption : undefined,
                attachmentGroup,
                ...metadata
            }, finalAttachment ? replyMessageId : undefined);
            sessionChangedAfterSend = !sessionIsCurrent();
        } catch {
            sessionChangedAfterSend = !sessionIsCurrent();
            showToast("Matrix attachment send failed.", Toasts.Type.FAILURE);
        } finally {
            bytes.fill(0);
        }

        if (!sent && sessionChangedAfterSend) {
            stopForSessionChange(index);
            break;
        }
        if (!sent) {
            result.failedIndex = index;
            break;
        }
        result.sent++;
        if (finalAttachment) result.contentConsumed = true;

        // Remove only this successful item. Current and later failures remain
        // visible and retryable, while already-sent files cannot be resent.
        if (!removeSentUpload(channelId, upload)) {
            rememberConsumedUpload(channelId, upload);
            result.failedIndex = index;
            result.cleanupFailed = true;
            break;
        }
        if (sessionChangedAfterSend) {
            stopForSessionChange(index + 1 < plannedUploads.length ? index + 1 : undefined);
            break;
        }
    }

    if (result.sent === result.total) attachmentGroupAssignments.delete(channelId);
    result.complete = result.sent === result.total && !result.cleanupFailed;
    return result;
}

function getStickerForMatrix(stickerId: unknown) {
    if (typeof stickerId !== "string" || !/^[0-9]{17,20}$/u.test(stickerId)) return undefined;
    try {
        return StickersStore?.getStickerById(stickerId);
    } catch {
        return undefined;
    }
}

function MatrixIcon({ height = 28, width = 28, className }: IconProps) {
    return (
        <svg aria-hidden="true" className={className} width={width} height={height} viewBox="0 0 28 28" fill="none">
            <path d="M6 4H3v20h3M22 4h3v20h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M8 19V9h2.7l3.3 4.2L17.3 9H20v10h-3v-5.7L14 17l-3-3.7V19H8Z" fill="currentColor" />
        </svg>
    );
}

function SearchIcon({ height = 24, width = 24 }: IconProps) {
    return (
        <svg aria-hidden="true" width={width} height={height} viewBox="0 0 24 24">
            <path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.73 13.32l4.22 4.23a1 1 0 0 0 1.42-1.42l-4.23-4.22A7.5 7.5 0 0 0 10.5 3Zm-5.5 7.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z" />
        </svg>
    );
}

function MembersIcon({ height = 24, width = 24 }: IconProps) {
    return (
        <svg aria-hidden="true" width={width} height={height} viewBox="0 0 24 24">
            <path fill="currentColor" d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8.5-1a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM1.5 20.5c0-4 2.7-6.5 6.5-6.5s6.5 2.5 6.5 6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Zm13.2.5c.2-.8.3-1.6.2-2.4-.1-1.6-.7-3-1.7-4.1a6 6 0 0 1 3.3-1c3.5 0 6 2.4 6 6a1.5 1.5 0 0 1-1.5 1.5h-6.3Z" />
        </svg>
    );
}

function GroupAddIcon({ height = 20, width = 20 }: IconProps) {
    return (
        <svg aria-hidden="true" width={width} height={height} viewBox="0 0 24 24">
            <path fill="currentColor" d="M7.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM1 20.5C1 16.4 3.7 14 7.5 14c2.1 0 3.8.7 4.9 1.9A6.9 6.9 0 0 0 11 20v1H2a1 1 0 0 1-1-1v.5Zm15-7.5h2v3h3v2h-3v3h-2v-3h-3v-2h3v-3Z" />
        </svg>
    );
}

function MatrixGroupChatHeaderButton() {
    const [, setRevision] = React.useState(0);
    React.useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
    const context = getMatrixGroupChatCreateContext();
    if (!context) return null;
    return (
        <Tooltip text="Create Group Chat" position="top">
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className="vc-matrix-group-chat-header-button"
                    aria-label="Create Group Chat"
                    onClick={() => openMatrixGroupChatCreate(context)}
                >
                    <GroupAddIcon />
                </button>
            )}
        </Tooltip>
    );
}

function renderMatrixGroupChatHeaderButton() {
    return <MatrixGroupChatHeaderButton />;
}

function MatrixGroupInviteToolbarButton({ channelId }: { channelId: string; }) {
    const [, setRevision] = React.useState(0);
    React.useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
    const context = getMatrixGroupInviteContext(channelId);
    if (!context) return null;
    const tooltip = context.full
        ? "Add People - group is full; open to check invite status"
        : context.canInvite ? "Add People" : matrixPermissionMenuLabel("Add People", context.permission);
    return (
        <Tooltip text={tooltip}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className="vc-matrix-search-button"
                    aria-label={tooltip}
                    onClick={() => openMatrixGroupInvite(channelId, context)}
                >
                    <GroupAddIcon />
                </button>
            )}
        </Tooltip>
    );
}

function renderMatrixToolbar(channel: any) {
    const guildId = typeof channel.guild_id === "string" ? channel.guild_id : undefined;
    return [
        <MatrixGroupInviteToolbarButton key="matrix-add-people" channelId={channel.id} />,
        channel.type !== ChannelType.DM && (
            <Tooltip key="matrix-members" text="Show Member List">
                {tooltipProps => (
                    <button
                        {...tooltipProps}
                        type="button"
                        className="vc-matrix-search-button"
                        aria-label="Show member list"
                        onClick={() => ChannelSidebarActions.toggleMembersSection()}
                    >
                        <MembersIcon />
                    </button>
                )}
            </Tooltip>
        ),
        guildId && <MatrixAccessRequestsToolbarButton key="matrix-access-requests" guildId={guildId} />,
        <Tooltip key="matrix-search" text="Search">
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className="vc-matrix-search-button"
                    aria-label="Search messages"
                    onClick={() => openMatrixSearch(channel.id)}
                >
                    <SearchIcon />
                </button>
            )}
        </Tooltip>,
    ].filter(Boolean);
}

function renderMatrixReadOnlyTitle(channel: any) {
    const name = typeof channel?.name === "string" && channel.name.trim()
        ? channel.name.trim()
        : "Group chat";
    return (
        <div className="vc-matrix-readonly-title" role="heading" aria-level={1} aria-label={name} title={name}>
            <span>{name}</span>
        </div>
    );
}

function openMatrixSettings() {
    SettingsRouter.openUserSettings(MATRIX_SETTINGS_ENTRY_KEY);
}

function confirmLeaveMatrixGuild(guildId: string, label: string) {
    openModal(modalProps => (
        <ConfirmModal
            {...modalProps}
            title={`Leave ${label}?`}
            confirmText="Leave Server"
            cancelText="Cancel"
            variant="danger"
            onConfirm={() => void leaveMatrixGuild(guildId)}
        >
            This leaves the Matrix Space from this account. Rooms joined separately remain available as Matrix chats.
        </ConfirmModal>
    ));
}

function confirmLeaveMatrixGroup(channelId: string, label: string, isCreator: boolean) {
    openModal(modalProps => (
        <ConfirmModal
            {...modalProps}
            title={`Leave ${label}?`}
            confirmText="Leave Group"
            cancelText="Cancel"
            variant="danger"
            onConfirm={() => void leaveMatrixGroup(channelId)}
        >
            {isCreator
                ? "You created this group. Leaving removes the only invite and admin authority. You cannot be invited back unless you first transferred that authority in another Matrix client. Treat this as irreversible. "
                : "This removes the group chat from this account. You may need another invitation to return. "}
            Leaving does not cancel an Add People invitation that may already have landed or been declined. Any unfinished local Add People warning or recovery receipt for this group will be discarded.
        </ConfirmModal>
    ));
}

type MatrixMenuChildren = Parameters<NavContextMenuPatchCallback>[0];

function removeMatrixMenuItems(children: MatrixMenuChildren, ids: readonly string[]) {
    let group: ReturnType<typeof findGroupChildrenByChildId>;
    while ((group = findGroupChildrenByChildId([...ids], children))) {
        const index = group.findIndex(child => ids.includes(child?.props?.id));
        if (index === -1) break;
        group.splice(index, 1);
    }
}

function filterMatrixMenuTree(value: any, predicate: (id: unknown) => boolean): any {
    if (Array.isArray(value)) {
        return value.map(child => filterMatrixMenuTree(child, predicate)).filter(child => child != null);
    }
    if (!React.isValidElement(value)) return value;
    const element = value as any;
    if (predicate(element.props?.id)) return null;
    const nested = element.props?.children;
    if (!nested || typeof nested === "function") return element;
    return React.cloneElement(element, { children: filterMatrixMenuTree(nested, predicate) });
}

function removeMatrixMenuItemsWhere(
    children: Array<any>,
    predicate: (id: unknown) => boolean
) {
    for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (Array.isArray(child)) {
            removeMatrixMenuItemsWhere(child, predicate);
            continue;
        }
        if (!child?.props) continue;
        if (predicate(child.props.id)) {
            children.splice(index, 1);
            continue;
        }
        let nested = child.props.children;
        if (typeof nested === "function") {
            const renderChildren = nested;
            child.props.children = (...args: any[]) => {
                const rendered = renderChildren(...args);
                return filterMatrixMenuTree(rendered, predicate);
            };
            continue;
        }
        if (!nested) continue;
        if (!Array.isArray(nested)) child.props.children = nested = [nested];
        removeMatrixMenuItemsWhere(nested, predicate);
    }
}

function replaceMatrixMenuAction({
    children,
    stockIds,
    matrixId,
    label,
    action,
    disabled,
}: {
    children: MatrixMenuChildren;
    stockIds: readonly string[];
    matrixId: string;
    label: string;
    action?: () => void;
    disabled: boolean;
}) {
    const ids = [...stockIds, matrixId];
    const anchorGroup = findGroupChildrenByChildId(ids, children);
    const anchorIndex = anchorGroup?.findIndex(child => ids.includes(child?.props?.id)) ?? -1;
    const anchor = anchorIndex === -1 ? undefined : anchorGroup?.[anchorIndex];
    removeMatrixMenuItems(children, ids);

    // Preserve only the visual icon. Copying a stock React element could retain
    // an undocumented route or callback prop and leak the synthetic ID to REST.
    const replacement = (
        <Menu.MenuItem
            key={matrixId}
            id={matrixId}
            label={label}
            action={disabled ? undefined : action}
            disabled={disabled}
            icon={anchor?.props?.icon}
        />
    );
    if (anchorGroup) anchorGroup.splice(Math.min(anchorIndex, anchorGroup.length), 0, replacement);
    else children.push(<Menu.MenuGroup key={`${matrixId}-group`}>{replacement}</Menu.MenuGroup>);
}

function matrixPermissionMenuLabel(base: string, permission: MatrixPowerLevelPermissionDTO | undefined) {
    if (permission?.allowed) return base;
    if (!permission || permission.current === "unverifiable" || permission.required === "unverifiable") {
        return `${base} (server permission could not be verified)`;
    }
    const current = permission.current === "infinite" ? "\u221e" : permission.current;
    return `${base} (permission level ${current}; requires ${permission.required})`;
}

function replaceMatrixGuildLeaveAction(
    children: Parameters<NavContextMenuPatchCallback>[0],
    guildId: string,
    label: string
) {
    const replacement = (
        <Menu.MenuItem
            key="vc-matrix-leave-server"
            id="vc-matrix-leave-server"
            label="Leave Matrix server"
            color="danger"
            action={() => confirmLeaveMatrixGuild(guildId, label)}
        />
    );
    const destructiveGroup = findGroupChildrenByChildId(
        ["leave-guild", "delete-guild", "vc-matrix-leave-server"],
        children
    );
    if (!destructiveGroup) {
        children.push(<Menu.MenuGroup key="vc-matrix-leave-server-group">{replacement}</Menu.MenuGroup>);
        return;
    }

    const destructiveIds = new Set(["leave-guild", "delete-guild", "vc-matrix-leave-server"]);
    const firstIndex = destructiveGroup.findIndex(child => destructiveIds.has(child?.props?.id));
    if (firstIndex === -1) return;
    destructiveGroup.splice(firstIndex, 1, replacement);
    for (let index = destructiveGroup.length - 1; index >= 0; index--) {
        if (index !== firstIndex && destructiveIds.has(destructiveGroup[index]?.props?.id)) {
            destructiveGroup.splice(index, 1);
        }
    }
}

const matrixGuildCreateMenuPatch: NavContextMenuPatchCallback = (children, { guild }) => {
    if (!guild?.id || !isMatrixGuildId(guild.id)) return;
    const accessContext = guild?.id ? getMatrixAccessRequestContext(guild.id) : undefined;
    const inviteContext = guild?.id ? getMatrixInviteContext(guild.id) : undefined;
    const context = guild?.id ? getMatrixSpaceCreateContext(guild.id) : undefined;
    removeMatrixMenuItems(children, ["vc-matrix-access-requests"]);
    if (accessContext?.canApprove || accessContext?.canDeny) {
        children.push(
            <Menu.MenuGroup key="vc-matrix-access-requests">
                <Menu.MenuItem
                    id="vc-matrix-access-requests"
                    label={accessContext.countComplete
                        ? `Access requests (${accessContext.count >= 200 ? "200+" : accessContext.count})`
                        : "Access requests"}
                    action={() => openMatrixAccessRequests(guild.id, accessContext)}
                />
            </Menu.MenuGroup>
        );
    }
    replaceMatrixMenuAction({
        children,
        stockIds: ["invite-people"],
        matrixId: "vc-matrix-invite-people",
        label: matrixPermissionMenuLabel("Invite People", inviteContext?.permission),
        action: inviteContext ? () => openMatrixInvitePeople(guild.id, inviteContext) : undefined,
        disabled: !inviteContext?.canInvite,
    });
    replaceMatrixMenuAction({
        children,
        stockIds: ["create-channel"],
        matrixId: "vc-matrix-create-channel",
        label: matrixPermissionMenuLabel("Create Channel", context?.permission),
        action: context ? () => openMatrixSpaceChildModal(context, "room", true) : undefined,
        disabled: !context?.canManageSpaceChildren,
    });
    replaceMatrixMenuAction({
        children,
        stockIds: ["create-category"],
        matrixId: "vc-matrix-create-category",
        label: matrixPermissionMenuLabel("Create Category", context?.permission),
        action: context ? () => openMatrixSpaceChildModal(context, "space", true) : undefined,
        disabled: !context?.canManageSpaceChildren,
    });
    replaceMatrixGuildLeaveAction(children, guild.id, context?.parentLabel ?? guild.name ?? "Matrix server");
};

const matrixCategoryCreateMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.id || !isMatrixChannelId(channel.id)) return;
    const inviteContext = channel.guild_id ? getMatrixInviteContext(channel.guild_id) : undefined;
    replaceMatrixMenuAction({
        children,
        stockIds: ["invite-people"],
        matrixId: "vc-matrix-invite-people",
        label: matrixPermissionMenuLabel("Invite People", inviteContext?.permission),
        action: inviteContext ? () => openMatrixInvitePeople(channel.guild_id, inviteContext) : undefined,
        disabled: !inviteContext?.canInvite,
    });

    const context = getMatrixCategoryCreateContext(channel.id);
    if (!context) return;
    removeMatrixMenuItems(children, ["create-voice-channel"]);
    replaceMatrixMenuAction({
        children,
        stockIds: ["create-text-channel", "create-channel"],
        matrixId: "vc-matrix-create-category-channel",
        label: matrixPermissionMenuLabel("Create Channel", context.permission),
        action: () => openMatrixSpaceChildModal(context, "room", true),
        disabled: !context.canManageSpaceChildren,
    });
};

const MATRIX_GROUP_MUTATION_MENU_IDS = [
    "add-recipient",
    "remove-recipient",
    "remove-from-group",
    "remove",
    "make-owner",
    "set-owner",
    "transfer-owner",
    "transfer-ownership",
    "change-icon",
    "set-icon",
    "edit-group",
    "rename-group",
    "change-name",
    "invite-to-group",
    "invite-people",
    "add-friends",
    "add-people",
    "add-friends-to-dm",
    "add-people-to-group",
    "add-participant",
    "manage-members",
    "edit-channel",
] as const;

function isMatrixGroupMutationMenuItem(id: unknown) {
    if (typeof id !== "string") return false;
    const normalized = id.toLocaleLowerCase("en-US");
    return normalized.includes("recipient")
        || normalized.includes("owner")
        || normalized === "remove"
        || MATRIX_GROUP_MUTATION_MENU_IDS.some(token =>
            token !== "remove" && (normalized === token || normalized.includes(token)));
}

const matrixUserInviteToServerMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    const prefix = "invite-to-server--";
    removeMatrixMenuItemsWhere(children, id => typeof id === "string"
        && id.startsWith(prefix)
        && isMatrixGuildId(id.slice(prefix.length)));
    if (channel?.id && getMatrixGroupLeaveContext(channel.id)) {
        removeMatrixMenuItemsWhere(children, isMatrixGroupMutationMenuItem);
    }
};

const matrixGroupLeaveMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    const context = channel?.id ? getMatrixGroupLeaveContext(channel.id) : undefined;
    if (!context) return;
    const inviteContext = getMatrixGroupInviteContext(context.channelId);
    if (inviteContext) {
        replaceMatrixMenuAction({
            children,
            stockIds: [
                "add-recipient",
                "invite-people",
                "add-friends",
                "add-friends-to-dm",
                "add-people",
                "add-people-to-group",
                "add-participant",
                "invite-to-group",
                "manage-members",
            ],
            matrixId: "vc-matrix-group-add-people",
            label: inviteContext.full
                ? "Add People (group is full)"
                : matrixPermissionMenuLabel("Add People", inviteContext.permission),
            action: () => openMatrixGroupInvite(context.channelId, inviteContext),
            disabled: false,
        });
    }
    removeMatrixMenuItemsWhere(children, id =>
        id !== "vc-matrix-group-add-people" && isMatrixGroupMutationMenuItem(id));
    const replacement = (
        <Menu.MenuItem
            key="vc-matrix-leave-group"
            id="vc-matrix-leave-group"
            label="Leave Group"
            color="danger"
            action={() => confirmLeaveMatrixGroup(context.channelId, context.label, context.isCreator)}
        />
    );
    const leaveGroup = findGroupChildrenByChildId("leave-channel", children);
    if (!leaveGroup) {
        children.push(<Menu.MenuGroup key="vc-matrix-leave-group-container">{replacement}</Menu.MenuGroup>);
        return;
    }
    const leaveIndex = leaveGroup.findIndex(child => child?.props?.id === "leave-channel");
    if (leaveIndex === -1) return;
    leaveGroup.splice(leaveIndex, 1, replacement);
    for (let index = leaveGroup.length - 1; index >= 0; index--) {
        if (index !== leaveIndex && leaveGroup[index]?.props?.id === "leave-channel") leaveGroup.splice(index, 1);
    }
};

function onMatrixSearchShortcut(event: KeyboardEvent) {
    if (event.defaultPrevented
        || event.altKey
        || event.shiftKey
        || event.key.toLocaleLowerCase() !== "f"
        || !event.ctrlKey && !event.metaKey) return;
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId || !isMatrixChannelId(channelId)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const existingInput = document.querySelector<HTMLInputElement>("#vc-matrix-search-input");
    if (existingInput) existingInput.focus();
    else openMatrixSearch(channelId);
}

/**
 * Discord's MESSAGE_UPDATE converter intentionally preserves its existing
 * reaction array. Matrix reaction deltas are authoritative aggregates, so the
 * synthetic channel must accept the incoming array while ordinary Discord
 * channels retain the stock merge rule.
 */
function matrixMessageUpdateReactions(channelId: string, existing: unknown, incoming: unknown) {
    return selectProjectedMessageReactions(isMatrixChannelId(channelId), existing, incoming);
}

export default definePlugin({
    name: "MatrixBridge",
    description: "Brings Matrix rooms, spaces, and direct messages into Discord.",
    authors: [Devs.MatrixBridge],
    tags: ["Chat", "Privacy"],
    dependencies: ["MessageEventsAPI", "PinDMs"],
    enabledByDefault: IS_DISCORD_DESKTOP || IS_VESKTOP,
    hidden: !(IS_DISCORD_DESKTOP || IS_VESKTOP),
    settings,

    contextMenus: {
        "guild-context": matrixGuildCreateMenuPatch,
        "guild-header-popout": matrixGuildCreateMenuPatch,
        "channel-context": matrixCategoryCreateMenuPatch,
        "gdm-context": matrixGroupLeaveMenuPatch,
        "user-context": matrixUserInviteToServerMenuPatch,
    },

    patches: [
        {
            // Discord preserves reactions across ordinary MESSAGE_UPDATE
            // payloads, including a separate edited-message fast path. Matrix
            // sends an authoritative aggregate through that same action, so
            // select it only for an already-projected synthetic channel.
            find: "premiumGroupInviteId:",
            replacement: [
                {
                    match: MATRIX_EDITED_REACTION_UPDATE_PATCH,
                    replace: patchEditedMatrixReactionUpdate,
                },
                {
                    match: MATRIX_PARTIAL_REACTION_UPDATE_PATCH,
                    replace: patchPartialMatrixReactionUpdate,
                },
            ],
        },
        {
            // Add a separate provider-backed group-chat action beside Discord's
            // stock Create Message action. The stock component and callback are
            // deliberately untouched so ordinary Discord DMs keep their exact path.
            find: '"clean-up-inactive-gdms"',
            replacement: {
                match: /(?=\(0,\i\.jsx\)\(\i\.\i,\{tooltip:\i\.intl\.string\(\i\.t\.\i\),tooltipPosition:"top",className:\i\.\i,iconClassName:\i\.\i,icon:\i\.\i,subscribeToGlobalHotkey:!0\}\))/,
                replace: "$self.renderMatrixGroupChatHeaderButton(),",
            },
        },
        {
            // Discord's lazy-image experiment can mount a synthetic room while
            // it is hidden, then never deliver a later intersection callback.
            // Eagerly start only media URLs owned by this bridge; all normal
            // Discord media keeps the stock lazy-loading path.
            find: '"2026-02-lazy-load-all-images"',
            replacement: {
                match: /componentDidMount\(\)\{let\{readyState:(\i)\}=this\.state;if\(\1===(\i)\.\i\.LOADING\)/,
                replace: "$&if($self.isMatrixMediaUrl(this.props.src))this._triggerLazyLoad();else ",
            },
        },
        {
            // Discord's CDN proxy can derive a still poster from a video by
            // appending ?format=webp. Matrix videos are renderer-local Blobs,
            // where that query changes the resource key and fails. Substitute
            // only our separately generated poster while leaving the player
            // source and every normal Discord attachment untouched.
            find: "disableArrowKeySeek:!0",
            replacement: {
                match: MATRIX_VIDEO_POSTER_PATCH,
                replace: MATRIX_VIDEO_POSTER_REPLACEMENT,
            },
        },
        {
            find: '"MessageManager"',
            replacement: {
                match: /forceFetch:\i,isPreload:.+?}=(\i);(?=.+?getChannel\((\i)\))/,
                replace: (match, request, channelId) => `${match}if($self.isMatrixChannelId(${channelId}))return $self.fetchMatrixMessages(${channelId},${request});`,
            },
        },
        {
            find: "Missing channel in Channel.renderHeaderToolbar",
            replacement: [
                {
                    match: /(renderHeaderToolbar(?:",|=)\(\)=>\{let\{channel:(\i),[^}]+\}=this\.props;.+?let \i=\[\];)/,
                    replace: (_, prefix, channel) => `${prefix}if($self.isMatrixChannelId(${channel}.id))return $self.renderMatrixToolbar(${channel});`,
                },
                {
                    match: /(renderMobileToolbar(?:",|=)\(\)=>\{let\{channel:(\i)\}=this\.props;.+?let \i=\[\];)/,
                    replace: (_, prefix, channel) => `${prefix}if($self.isMatrixChannelId(${channel}.id))return $self.renderMatrixToolbar(${channel});`,
                },
                {
                    match: /(?<=renderHeaderBar(?:",|=)\(\)=>\{.+?hideSearch:(\i)\.isDirectory\(\))/,
                    replace: (_, channel) => `||$self.isMatrixChannelId(${channel}.id)`,
                },
            ],
        },
        {
            // Matrix group chats use Discord's normal title styling, without
            // exposing rename/avatar/context-menu affordances that cannot be
            // routed to Matrix yet.
            find: 'action:"entry_point_hovered"',
            replacement: {
                match: /(\i=\i\.memo\(function\((\i)\)\{)(?=let\{channel:\i\}=\2,)/,
                replace: "$&if($self.isMatrixChannelId($2.channel.id))return $self.renderMatrixReadOnlyTitle($2.channel);",
            },
        },
        {
            find: "GUILD_SUBSCRIPTIONS_FLUSH:function",
            replacement: [
                {
                    // Member requests can batch multiple guilds. Strip local
                    // Matrix projections while preserving normal guilds.
                    match: /GUILD_MEMBERS_REQUEST:function\((\i)\)\{/,
                    replace: "$&$1={...$1,guildIds:$1.guildIds.filter(guildId=>!$self.isMatrixGuildId(guildId))};if(!$1.guildIds.length)return!1;",
                },
                {
                    match: /GUILD_SEARCH_RECENT_MEMBERS:function\((\i)\)\{/,
                    replace: "$&if($self.isMatrixGuildId($1.guildId))return;",
                },
                {
                    // Current Discord sends a guild-keyed subscription map,
                    // not one event.guildId. Never put synthetic IDs on the
                    // gateway; an invalid guild ID closes the live session.
                    match: /GUILD_SUBSCRIPTIONS_FLUSH:function\((\i)\)\{let\{subscriptions:(\i)\}=\1;/,
                    replace: "$&$2=Object.fromEntries(Object.entries($2).filter(([guildId])=>!$self.isMatrixGuildId(guildId)));if(!Object.keys($2).length)return!1;",
                },
                {
                    match: /CALL_CONNECT:function\((\i)\)\{let\{channelId:(\i)\}=\1;/,
                    replace: "$&if($self.isMatrixChannelId($2))return!1;",
                },
                {
                    match: /CALL_CONNECT_MULTIPLE:function\((\i)\)\{let\{channelIds:(\i)\}=\1;/,
                    replace: "$&$2=$2.filter(channelId=>!$self.isMatrixChannelId(channelId));",
                },
                {
                    match: /STREAM_START:function\((\i)\)\{let\{streamType:\i,guildId:(\i),channelId:(\i)\}=\1;/,
                    replace: "$&if($self.isMatrixGuildId($2)||$self.isMatrixChannelId($3))return!1;",
                },
                {
                    match: /REQUEST_FORUM_UNREADS:function\((\i)\)\{let\{guildId:(\i),channelId:(\i),threads:\i\}=\1;/,
                    replace: "$&if($self.isMatrixGuildId($2)||$self.isMatrixChannelId($3))return;",
                },
                {
                    match: /REQUEST_SOUNDBOARD_SOUNDS:function\((\i)\)\{let\{guildIds:(\i)\}=\1;/,
                    replace: "$&$2=$2.filter(guildId=>!$self.isMatrixGuildId(guildId));if(!$2.length)return;",
                },
            ],
        },
        {
            find: "},closePrivateChannel(",
            replacement: [
                {
                    match: /async openPrivateChannel\((\i)\)\{/,
                    replace: "$&if($self.hasMatrixRecipients($1?.recipientIds))return $self.openMatrixPrivateChannel($1);",
                },
                {
                    match: /closePrivateChannel\((\i)\)\{/,
                    replace: "$&if($self.isMatrixChannelId($1))return Promise.resolve();",
                },
                {
                    match: /addRecipient\((\i),\i,\i,\i\)\{/,
                    replace: '$&if($self.isMatrixChannelId($1))return Promise.reject(new Error("Group membership changes are unavailable here."));',
                },
                {
                    match: /removeRecipient:\((\i),(\i)\)=>/,
                    replace: '$&$self.isMatrixChannelId($1)?Promise.reject(new Error("Group membership changes are unavailable here.")):',
                },
                {
                    match: /setDMOwner:\((\i),(\i)\)=>/,
                    replace: '$&$self.isMatrixChannelId($1)?Promise.reject(new Error("Group ownership changes are unavailable here.")):',
                },
                {
                    match: /async setName\((\i),\i\)\{/,
                    replace: '$&if($self.isMatrixChannelId($1))throw new Error("Group name changes are unavailable here.");',
                },
                {
                    match: /async setIcon\((\i),\i,\i\)\{/,
                    replace: '$&if($self.isMatrixChannelId($1))throw new Error("Group icon changes are unavailable here.");',
                },
                {
                    match: /async updateChannel\((\i),\i,\i\)\{/,
                    replace: '$&if($self.isMatrixChannelId($1))throw new Error("Group settings changes are unavailable here.");',
                },
            ],
        },
        {
            find: '"MessageActionCreators"',
            replacement: [
                {
                    match: /fetchMessages\((\i)\)\{/,
                    replace: "$&if($self.isMatrixChannelId($1.channelId))return $self.fetchMatrixMessages($1.channelId,$1);",
                },
                {
                    match: /async deleteMessage\((\i),(\i)\)\{/,
                    replace: "$&if($self.isMatrixChannelId($1))return $self.deleteMatrixMessage($1,$2);",
                },
            ],
        },
        {
            find: '"TypingStore"',
            replacement: [
                {
                    match: /TYPING_START_LOCAL:function\((\i)\)\{let\{channelId:(\i)\}=\1,/,
                    replace: (_, event, channelId) => `TYPING_START_LOCAL:function(${event}){let{channelId:${channelId}}=${event};if($self.isMatrixChannelId(${channelId}))return void $self.matrixTyping(${channelId},true);let `,
                },
                {
                    match: /TYPING_STOP_LOCAL:function\((\i)\)\{let\{channelId:(\i)\}=\1,/,
                    replace: (_, event, channelId) => `TYPING_STOP_LOCAL:function(${event}){let{channelId:${channelId}}=${event};if($self.isMatrixChannelId(${channelId}))return void $self.matrixTyping(${channelId},false);let `,
                },
            ],
        },
        {
            find: '"ReadStateStore"',
            replacement: [
                {
                    match: /_ack\(\i,\i\)\{let\{outgoingAck:(\i)\}=this;if\(null==\1\)return;/,
                    replace: "$&if($self.isMatrixChannelId(this.channelId))return void $self.matrixReceipt(this.channelId,$1);",
                },
                {
                    match: /(\i\.push\(\.\.\.)(\i)(\.map\((\i)=>\(\{channel_id:\4\.channelId,message_id:\4\.messageId,read_state_type:\4\.readStateType\}\)\)\))/,
                    replace: (_, push, list, map) => `${push}${list}.filter(entry=>!$self.isMatrixChannelId(entry.channelId))${map}`,
                },
                {
                    match: /(?=\i&&this\._persisted&&\i\.\i\.del\(\{url:\i\.\i\.CHANNEL_ACK\(this\.channelId\))/,
                    replace: "!$self.isMatrixChannelId(this.channelId)&&",
                },
            ],
        },
        {
            find: 'type:"MESSAGE_REACTION_ADD_USERS",channelId:',
            replacement: [
                {
                    match: /async function (\i)\((\i),(\i),(\i)\)\{(?=var \i,\i,\i,\i;let \i,\i=arguments\.length>3)/,
                    replace: "$&if($self.isMatrixChannelId($2))return $self.addMatrixReaction($2,$3,$4);",
                },
                {
                    match: /async function \i\((\i)\)\{(?=let\{channelId:(\i),messageId:(\i),emoji:(\i),location:)/,
                    replace: "$&if($self.isMatrixChannelId($1.channelId))return $self.removeMatrixReaction($1.channelId,$1.messageId,$1.emoji);",
                },
            ],
        },
    ],

    flux: {
        CHANNEL_SELECT({ channelId }: { channelId?: string; }) {
            queueMicrotask(() => activateMatrixChannel(channelId));
        },
        CONNECTION_OPEN() {
            reapplyMatrixProjectionAfterConnectionOpen();
        },
        CONNECTION_OPEN_SUPPLEMENTAL() {
            reapplyMatrixProjectionAfterConnectionOpen(false);
        },
        BULK_ACK({ channels }: { channels?: Array<{ channelId: string; messageId?: string; }>; }) {
            for (const { channelId, messageId } of channels ?? []) {
                if (messageId && isMatrixChannelId(channelId)) void matrixReceipt(channelId, messageId);
            }
        },
    },

    async onBeforeMessageSend(channelId, message, options, props) {
        if (!isMatrixChannelId(channelId)) return;
        // Once a Matrix channel is recognized, every exit must remain
        // fail-closed. MessageEvents deliberately treats an uncaught listener
        // error as "continue with Discord's normal send", which would be the
        // wrong privacy behavior here.
        try {

            const stickerIds = Array.isArray(options.stickerIds) ? options.stickerIds : [];
        if (props.hasStickers || stickerIds.length > 0) {
            if (props.hasAttachments) {
                showToast("Send a Matrix sticker by itself, without attachments.", Toasts.Type.FAILURE);
                return { cancel: true };
            }
            if (stickerIds.length !== 1) {
                showToast("Matrix can send one sticker at a time.", Toasts.Type.FAILURE);
                return { cancel: true };
            }
            if (typeof message.content !== "string" || message.content.length > 0) {
                showToast("Send a Matrix sticker by itself, without text.", Toasts.Type.FAILURE);
                return { cancel: true };
            }

            const stickerId = stickerIds[0];
            const sticker = getStickerForMatrix(stickerId);
            const stickerName = typeof sticker?.name === "string" && sticker.name.length <= 100
                ? sticker.name
                    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
                    .replace(/\s+/gu, " ")
                    .trim()
                : "";
            if (
                !sticker
                || sticker.id !== stickerId
                || !stickerName
            ) {
                showToast("Discord could not resolve that sticker for Matrix.", Toasts.Type.FAILURE);
                return { cancel: true };
            }

            const formatType = sticker.format_type;
            if (
                formatType !== StickerFormatType.PNG
                && formatType !== StickerFormatType.APNG
                && formatType !== StickerFormatType.GIF
            ) {
                showToast("This sticker format is not supported on Matrix yet.", Toasts.Type.FAILURE);
                return { cancel: true };
            }

            const reference = options.messageReference as any;
            const sent = await sendMatrixSticker(channelId, {
                id: sticker.id,
                name: stickerName,
                formatType,
            }, reference?.message_id ?? reference?.messageId);
            if (sent) {
                FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
                FluxDispatcher.dispatch({
                    type: "CLEAR_STICKER_PREVIEW",
                    channelId,
                    draftType: DraftType.ChannelMessage
                });
            }
            return { cancel: true, shouldClear: sent };
        }

        if (props.hasAttachments) {
            if (activeAttachmentBatches.has(channelId)) {
                showToast("A Matrix attachment batch is already uploading.", Toasts.Type.FAILURE);
                return { cancel: true };
            }
            activeAttachmentBatches.add(channelId);
            try {
                if (tombstoneSafetyLock) {
                    showToast(
                        "Matrix attachment sending is locked because Discord could not safely clean an earlier sent draft.",
                        Toasts.Type.FAILURE
                    );
                    return { cancel: true };
                }
                let draftUploads = UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
                for (const upload of draftUploads) {
                    if (upload.status === "REMOVED_FROM_MSG_DRAFT") rememberConsumedUpload(channelId, upload);
                }
                if (tombstoneSafetyLock) {
                    showToast(
                        "Matrix attachment sending is locked because Discord could not safely clean an earlier sent draft.",
                        Toasts.Type.FAILURE
                    );
                    return { cancel: true };
                }
                if (!retryConsumedUploadCleanup(channelId, draftUploads)) {
                    showToast(
                        "A previously sent Matrix attachment is still in the Discord draft. Remove it before retrying.",
                        Toasts.Type.FAILURE
                    );
                    return { cancel: true };
                }
                draftUploads = UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
                if (draftUploads.length < 1) {
                    showToast("There are no unsent Matrix attachments left in this draft.", Toasts.Type.FAILURE);
                    return { cancel: true };
                }
                if (draftUploads.length > MAX_MATRIX_ATTACHMENT_COUNT) {
                    showToast(`Matrix sends up to ${MAX_MATRIX_ATTACHMENT_COUNT} attachments at once.`, Toasts.Type.FAILURE);
                    return { cancel: true };
                }

                let aggregateBytes = 0;
                const uploads: Array<{ upload: MatrixComposerUpload; file: File; }> = [];
                for (const upload of draftUploads) {
                    const file = upload?.item?.file;
                    if (!(file instanceof File)) {
                        showToast("Discord could not read an attachment for Matrix.", Toasts.Type.FAILURE);
                        return { cancel: true };
                    }
                    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_MATRIX_ATTACHMENT_BYTES) {
                        showToast("Each Matrix attachment must be between 1 byte and 25 MiB.", Toasts.Type.FAILURE);
                        return { cancel: true };
                    }
                    aggregateBytes += file.size;
                    if (aggregateBytes > MAX_MATRIX_ATTACHMENT_BATCH_BYTES) {
                        showToast("A Matrix attachment batch can be at most 100 MiB.", Toasts.Type.FAILURE);
                        return { cancel: true };
                    }
                    uploads.push({ upload, file });
                }

                const reference = options.messageReference as any;
                const result = await sendMatrixAttachmentBatch(
                    channelId,
                    uploads,
                    typeof message.content === "string" && message.content ? message.content : undefined,
                    reference?.message_id ?? reference?.messageId
                );
                if (result.cleanupFailed) {
                    showToast(
                        "Matrix sent a file, but Discord could not remove it from the draft. Remove that sent file before retrying.",
                        Toasts.Type.FAILURE
                    );
                } else if (!result.complete && result.sent > 0) {
                    showToast(
                        `Matrix sent ${result.sent} of ${result.total} attachments. Unsent files remain in the draft.`,
                        Toasts.Type.FAILURE
                    );
                }
                if (result.contentConsumed) {
                    FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
                }
                return { cancel: true, shouldClear: result.contentConsumed };
            } catch {
                showToast("Discord could not prepare the Matrix attachment batch.", Toasts.Type.FAILURE);
                return { cancel: true };
            } finally {
                activeAttachmentBatches.delete(channelId);
            }
        }
            const reference = options.messageReference as any;
            const sent = await sendMatrixMessage(channelId, message.content, reference?.message_id ?? reference?.messageId);
            if (sent) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
            return { cancel: true, shouldClear: sent };
        } catch {
            try {
                showToast("Matrix blocked this send after an unexpected local error.", Toasts.Type.FAILURE);
            } catch {
                // Cancellation must survive a broken toast subsystem.
            }
            return { cancel: true };
        }
    },

    async onBeforeMessageEdit(channelId, messageId, message) {
        if (!isMatrixChannelId(channelId)) return;
        try {
            const edited = await editMatrixMessage(channelId, messageId, message.content);
            return { cancel: true, shouldClear: edited };
        } catch {
            try {
                showToast("Matrix blocked this edit after an unexpected local error.", Toasts.Type.FAILURE);
            } catch {
                // Cancellation must survive a broken toast subsystem.
            }
            return { cancel: true };
        }
    },

    start() {
        const lifecycleGeneration = ++pluginLifecycleGeneration;
        installRestGuard();
        installReadStateProjection();
        startMatrixAccessRequestUx();
        window.addEventListener("keydown", onMatrixSearchShortcut, true);
        if (!SettingsPlugin.customEntries.some(entry => entry.key === MATRIX_SETTINGS_ENTRY_KEY)) {
            SettingsPlugin.customEntries.push({
                key: MATRIX_SETTINGS_ENTRY_KEY,
                title: "Matrix",
                panelTitle: "Matrix Bridge",
                Component: MatrixSettings,
                Icon: MatrixIcon,
            });
        }
        void pendingPluginShutdown.then(async () => {
            if (lifecycleGeneration !== pluginLifecycleGeneration) return;
            try {
                await setEncryptedRoomProviderPreviewsPolicy(settings.store.encryptedRoomProviderPreviews);
            } catch {
                // Preview policy synchronization must never prevent Matrix
                // startup. Every later native request still re-reads the
                // authoritative main-process setting.
            }
            if (lifecycleGeneration === pluginLifecycleGeneration) return startBridge();
        });
    },

    stop() {
        pluginLifecycleGeneration++;
        attachmentGroupAssignments.clear();
        window.removeEventListener("keydown", onMatrixSearchShortcut, true);
        removeFromArray(SettingsPlugin.customEntries, entry => entry.key === MATRIX_SETTINGS_ENTRY_KEY);
        pendingPluginShutdown = suspendBridge().catch(() => undefined);
        stopMatrixAccessRequestUx();
        removeReadStateProjection();
        removeRestGuard();
    },

    toolboxActions: {
        "Open Matrix settings": openMatrixSettings,
        "Reconnect Matrix": () => void restartBridge(),
    },

    isMatrixChannelId,
    isMatrixGuildId,
    isMatrixMediaUrl,
    getMatrixVideoPosterUrl,
    hasMatrixRecipients,
    openMatrixPrivateChannel,
    renderMatrixGroupChatHeaderButton,
    renderMatrixToolbar,
    renderMatrixReadOnlyTitle,
    fetchMatrixMessages,
    deleteMatrixMessage,
    addMatrixReaction,
    removeMatrixReaction,
    matrixTyping,
    matrixReceipt,
    matrixMessageUpdateReactions,
});
