/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    Modal,
    openModal,
    Select,
    showToast,
    TextArea,
    TextInput,
    Toasts,
    useRef,
    useState,
} from "@webpack/common";

import { canManageMatrixSpaceChildren, Native, refreshSnapshot } from "./bridge";
import { matrixErrorCode } from "./errorCode";
import type {
    MatrixCreateSpaceChildResult,
    MatrixSpaceChildKind,
} from "./types";

type CreationPhase = "idle" | "creating" | "refreshing" | "reconciling" | "repairing";

let childCreationInFlight = false;

const SPACE_CHILD_PERMISSION_ERROR = "You do not have Matrix permission to add channels or categories to this Space.";
const CREATED_CHILD_SYNC_TIMEOUT_MS = 20_000;
const CREATED_CHILD_REFRESH_INTERVAL_MS = 750;

function publicError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_SPACE_CHILD_FORBIDDEN") return SPACE_CHILD_PERMISSION_ERROR;
    if (code === "MATRIX_CREATE_SPACE_CHILD_REJECTED") {
        return "The homeserver rejected room creation. No Matrix room was created.";
    }
    return error instanceof Error ? error.message : "Matrix could not create this item.";
}

function creationLabel(kind: MatrixSpaceChildKind) {
    return kind === "space" ? "category" : "channel";
}

function snapshotContainsCreatedChild(
    snapshot: Awaited<ReturnType<typeof refreshSnapshot>>,
    parentSpaceId: string,
    childRoomId: string,
    kind: MatrixSpaceChildKind
) {
    const child = snapshot.rooms?.find(room => room.roomId === childRoomId);
    const parent = snapshot.rooms?.find(room => room.roomId === parentSpaceId);
    if (!child || child.membership !== "join") return false;
    if (kind === "space" ? child.kind !== "space" : child.kind === "space") return false;
    return child.parentIds?.includes(parentSpaceId)
        || parent?.childIds?.includes(childRoomId)
        || parent?.spaceChildren?.some(candidate => candidate.roomId === childRoomId)
        || false;
}

async function waitForCreatedChild(
    parentSpaceId: string,
    childRoomId: string,
    kind: MatrixSpaceChildKind
) {
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const polling = (async () => {
        while (!stopped) {
            try {
                const snapshot = await refreshSnapshot();
                if (snapshotContainsCreatedChild(snapshot, parentSpaceId, childRoomId, kind)) return true;
            } catch {
                // /createRoom already succeeded. Keep waiting for the normal
                // sync/event projection instead of turning refresh into a
                // false create failure that invites a duplicate.
            }
            if (!stopped) {
                await new Promise(resolve => setTimeout(resolve, CREATED_CHILD_REFRESH_INTERVAL_MS));
            }
        }
        return false;
    })();
    const deadline = new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), CREATED_CHILD_SYNC_TIMEOUT_MS);
    });
    try {
        return await Promise.race([polling, deadline]);
    } finally {
        stopped = true;
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

function CreateSpaceChildModal({
    modalProps,
    parentLabel,
    parentSpaceId,
    initialKind,
    lockKind,
}: {
    modalProps: RenderModalProps;
    parentLabel: string;
    parentSpaceId: string;
    initialKind: MatrixSpaceChildKind;
    lockKind: boolean;
}) {
    const [kind, setKind] = useState<MatrixSpaceChildKind>(initialKind);
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [phase, setPhase] = useState<CreationPhase>("idle");
    const [error, setError] = useState("");
    const [needsReconcile, setNeedsReconcile] = useState(false);
    const [pendingRepairRoomId, setPendingRepairRoomId] = useState<string>();
    const started = useRef(false);
    const cleanName = name.trim();
    const busy = phase !== "idle";
    const canManageSpaceChildren = canManageMatrixSpaceChildren(parentSpaceId);
    const formLocked = busy || needsReconcile || Boolean(pendingRepairRoomId) || !canManageSpaceChildren;

    async function refreshAndClose(
        successMessage: string,
        childRoomId: string,
        childKind: MatrixSpaceChildKind
    ) {
        setPhase("refreshing");
        let projected = false;
        try {
            projected = await waitForCreatedChild(parentSpaceId, childRoomId, childKind);
        } finally {
            childCreationInFlight = false;
            modalProps.onClose();
        }

        showToast(
            projected
                ? successMessage
                : `${successMessage} Matrix is still syncing it into Discord; do not create a duplicate.`,
            projected ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
        );
    }

    async function reconcileCreation() {
        if (busy || childCreationInFlight) return;
        childCreationInFlight = true;
        setPhase("reconciling");
        setError("");
        try {
            const result = await Native.reconcileSpaceChildCreate(parentSpaceId);
            if (!result.resolved) {
                setPhase("idle");
                setError("Matrix has not found the created room yet. Check again later; do not create a replacement.");
                return;
            }
            setNeedsReconcile(false);
            await refreshAndClose("Recovered and linked the Matrix item.", result.roomId, kind);
        } catch (caught) {
            setPhase("idle");
            setError(publicError(caught));
        } finally {
            childCreationInFlight = false;
        }
    }

    async function repairChildLink(roomId = pendingRepairRoomId, operationAlreadyOwned = false) {
        if (!roomId || (!operationAlreadyOwned && (busy || childCreationInFlight))) return;
        if (!operationAlreadyOwned) childCreationInFlight = true;
        setPhase("repairing");
        setError("");
        try {
            await Native.repairSpaceChildLink(parentSpaceId, roomId);
            setPendingRepairRoomId(undefined);
            await refreshAndClose(
                `Created and linked the Matrix ${creationLabel(kind)} "${cleanName}".`,
                roomId,
                kind
            );
        } catch (caught) {
            setPhase("idle");
            setError(`The item exists, but its Space link still needs repair. ${publicError(caught)}`);
        } finally {
            childCreationInFlight = false;
        }
    }

    async function createChild() {
        if (!cleanName || busy || started.current) return;
        if (!canManageMatrixSpaceChildren(parentSpaceId)) {
            setError(SPACE_CHILD_PERMISSION_ERROR);
            return;
        }
        if (childCreationInFlight) {
            setError("Another Matrix channel or category is already being created.");
            return;
        }

        started.current = true;
        childCreationInFlight = true;
        setError("");
        setPhase("creating");
        let result: MatrixCreateSpaceChildResult;
        try {
            result = await Native.createSpaceChild({
                parentSpaceId,
                kind,
                name: cleanName,
                topic: topic.trim() || undefined,
            });
        } catch (caught) {
            const code = matrixErrorCode(caught);
            if (code === "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS"
                || code === "MATRIX_CREATE_SPACE_CHILD_RECONCILE_REQUIRED") {
                started.current = false;
                setNeedsReconcile(true);
                setPhase("reconciling");
                try {
                    const reconciled = await Native.reconcileSpaceChildCreate(parentSpaceId);
                    if (reconciled.resolved) {
                        setNeedsReconcile(false);
                        await refreshAndClose("Recovered and linked the Matrix item.", reconciled.roomId, kind);
                    } else {
                        setPhase("idle");
                        setError("Creation may have succeeded, but Matrix has not found it yet. Check again later; do not create a replacement.");
                    }
                } catch (reconcileError) {
                    setPhase("idle");
                    setError(publicError(reconcileError));
                } finally {
                    childCreationInFlight = false;
                }
                return;
            }

            started.current = false;
            childCreationInFlight = false;
            setPhase("idle");
            setError(publicError(caught));
            return;
        }

        const label = creationLabel(kind);
        if (result.partial) {
            setPendingRepairRoomId(result.roomId);
            started.current = false;
            setPhase("idle");
            await repairChildLink(result.roomId, true);
        } else {
            await refreshAndClose(`Created Matrix ${label} "${cleanName}".`, result.roomId, kind);
        }
    }

    return (
        <Modal
            {...modalProps}
            title="Create in Matrix Space"
            subtitle={`Add a channel or category to ${parentLabel}.`}
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
                        : phase === "refreshing"
                            ? "Refreshing..."
                            : phase === "reconciling"
                                ? "Checking..."
                                : phase === "repairing"
                                    ? "Repairing..."
                                    : pendingRepairRoomId
                                        ? "Repair link"
                                        : needsReconcile ? "Check creation" : "Create",
                    variant: "primary",
                    disabled: !canManageSpaceChildren
                        || busy
                        || (!cleanName && !pendingRepairRoomId && !needsReconcile),
                    onClick: () => {
                        if (pendingRepairRoomId) void repairChildLink();
                        else if (needsReconcile) void reconcileCreation();
                        else void createChild();
                    },
                },
            ]}
        >
            <div className="vc-matrix-create-server">
                <label>
                    <Heading tag="h5">Type</Heading>
                    {lockKind
                        ? <TextInput disabled value={kind === "space" ? "Category" : "Text channel"} />
                        : (
                            <Select
                                options={[
                                    { label: "Text channel", value: "room" as const },
                                    { label: "Category", value: "space" as const },
                                ]}
                                closeOnSelect={true}
                                select={value => {
                                    setKind(value);
                                    setError("");
                                }}
                                isSelected={value => value === kind}
                                serialize={value => value}
                                isDisabled={formLocked}
                            />
                        )}
                </label>
                <label>
                    <Heading tag="h5">Name</Heading>
                    <TextInput
                        autoFocus
                        disabled={formLocked}
                        value={name}
                        placeholder={kind === "space" ? "New category" : "new-channel"}
                        maxLength={100}
                        onChange={value => {
                            setName(value.slice(0, 100));
                            setError("");
                        }}
                        onKeyDown={event => {
                            if (event.key === "Enter") void createChild();
                        }}
                    />
                </label>
                <label>
                    <Heading tag="h5">Description <span className="vc-matrix-optional">Optional</span></Heading>
                    <TextArea
                        autosize
                        disabled={formLocked}
                        value={topic}
                        placeholder={kind === "space" ? "What belongs in this category?" : "What is this channel for?"}
                        maxLength={1_024}
                        onChange={value => {
                            setTopic(value.slice(0, 1_024));
                            setError("");
                        }}
                    />
                </label>
                <p className="vc-matrix-create-security">
                    Access is inherited from the parent Matrix Space. Private channels are encrypted;
                    categories are nested Matrix Spaces.
                </p>
                {!canManageSpaceChildren && !error && (
                    <div className="vc-matrix-error" role="alert">{SPACE_CHILD_PERMISSION_ERROR}</div>
                )}
                {error && <div className="vc-matrix-error" role="alert">{error}</div>}
            </div>
        </Modal>
    );
}

export function openMatrixSpaceChildModal(
    parentSpaceId: string,
    parentLabel: string,
    initialKind: MatrixSpaceChildKind = "room",
    lockKind = false
) {
    openModal(modalProps => (
        <CreateSpaceChildModal
            modalProps={modalProps}
            parentLabel={parentLabel}
            parentSpaceId={parentSpaceId}
            initialKind={initialKind}
            lockKind={lockKind}
        />
    ));
}
