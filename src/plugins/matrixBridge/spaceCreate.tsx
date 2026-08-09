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
    useEffect,
    useRef,
    useState,
} from "@webpack/common";

import {
    getCurrentMatrixSpaceCreateContext,
    type MatrixSpaceCreateContext,
    Native,
    refreshSnapshot,
    registerMatrixManagementModal,
    subscribeMatrixSpaceProjection,
    unregisterMatrixManagementModal,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";
import type {
    MatrixCreateSpaceChildResult,
    MatrixSpaceChildKind,
} from "./types";

type CreationPhase = "idle" | "creating" | "refreshing" | "reconciling" | "repairing";

let childCreationInFlight = false;

const SPACE_CHILD_PERMISSION_ERROR = "You do not have permission to add channels or categories to this server.";
const CONTEXT_CHANGED_ERROR = "This server or signed-in account changed. Close this window and try again.";
const CREATED_CHILD_SYNC_TIMEOUT_MS = 20_000;
const CREATED_CHILD_REFRESH_INTERVAL_MS = 750;

function publicError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_RENDERER_CONTEXT_CHANGED") return CONTEXT_CHANGED_ERROR;
    if (code === "MATRIX_SPACE_CHILD_FORBIDDEN") return SPACE_CHILD_PERMISSION_ERROR;
    if (code === "MATRIX_CREATE_SPACE_CHILD_REJECTED") {
        return "The account provider rejected creation. No channel or category was created.";
    }
    if (code === "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED") {
        return "Your account provider cannot create a compatible channel or category. No item was created.";
    }
    if (code === "MATRIX_CREATE_SPACE_CHILD_STATE_WRITE_FAILED") {
        return "The server could not safely record this creation. No retry was started.";
    }
    return "The server could not create or link this item. Try again.";
}

function contextChangedError() {
    const error = new Error(CONTEXT_CHANGED_ERROR);
    error.name = "MATRIX_RENDERER_CONTEXT_CHANGED";
    return error;
}

function currentContext(expected: MatrixSpaceCreateContext, requirePermission = false) {
    const current = getCurrentMatrixSpaceCreateContext(expected);
    if (!current || requirePermission && !current.canManageSpaceChildren) return undefined;
    return current;
}

function requireCurrentContext(expected: MatrixSpaceCreateContext, requirePermission = false) {
    const current = currentContext(expected, requirePermission);
    if (!current) throw contextChangedError();
    return current;
}

function useProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
}

function permissionMessage(context: MatrixSpaceCreateContext) {
    const { current, required } = context.permission;
    if (current === "unverifiable" || required === "unverifiable") {
        return "The server could not verify permission to add channels or categories.";
    }
    const currentLabel = current === "infinite" ? "\u221e" : current;
    return `Your server permission level is ${currentLabel}; adding channels or categories requires ${required}.`;
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
    expected: MatrixSpaceCreateContext,
    childRoomId: string,
    kind: MatrixSpaceChildKind
) {
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const polling = (async () => {
        while (!stopped) {
            requireCurrentContext(expected);
            try {
                const snapshot = await refreshSnapshot(expected.generation);
                requireCurrentContext(expected);
                if (snapshotContainsCreatedChild(snapshot, expected.parentSpaceId, childRoomId, kind)) return true;
            } catch (error) {
                if (!currentContext(expected)) throw contextChangedError();
                // /createRoom already succeeded. Keep waiting for the normal
                // sync/event projection instead of turning refresh into a
                // false create failure that invites a duplicate.
            }
            if (!stopped) {
                await new Promise(resolve => setTimeout(resolve, CREATED_CHILD_REFRESH_INTERVAL_MS));
                requireCurrentContext(expected);
            }
        }
        return false;
    })();
    const deadline = new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), CREATED_CHILD_SYNC_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([polling, deadline]);
        requireCurrentContext(expected);
        return result;
    } finally {
        stopped = true;
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

function CreateSpaceChildModal({
    modalProps,
    expected,
    initialKind,
    lockKind,
}: {
    modalProps: RenderModalProps;
    expected: MatrixSpaceCreateContext;
    initialKind: MatrixSpaceChildKind;
    lockKind: boolean;
}) {
    useProjectionRevision();
    const [kind, setKind] = useState<MatrixSpaceChildKind>(initialKind);
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [phase, setPhase] = useState<CreationPhase>("idle");
    const [error, setError] = useState("");
    const [needsReconcile, setNeedsReconcile] = useState(false);
    const [pendingRepairRoomId, setPendingRepairRoomId] = useState<string>();
    const started = useRef(false);
    const mounted = useRef(true);
    const cleanName = name.trim();
    const busy = phase !== "idle";
    const context = currentContext(expected);
    const canManageSpaceChildren = context?.canManageSpaceChildren === true;
    const formLocked = busy || needsReconcile || Boolean(pendingRepairRoomId) || !canManageSpaceChildren;

    useEffect(() => () => {
        mounted.current = false;
    }, []);

    async function refreshAndClose(
        successMessage: string,
        childRoomId: string,
        childKind: MatrixSpaceChildKind
    ) {
        if (mounted.current) setPhase("refreshing");
        let projected = false;
        try {
            projected = await waitForCreatedChild(expected, childRoomId, childKind);
            requireCurrentContext(expected);
        } finally {
            childCreationInFlight = false;
            if (mounted.current) modalProps.onClose();
        }
        if (!currentContext(expected)) return;
        showToast(
            projected
                ? successMessage
                : `${successMessage} The server is still syncing it; do not create a duplicate.`,
            projected ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
        );
    }

    async function reconcileCreation() {
        if (busy || childCreationInFlight) return;
        if (!currentContext(expected, true)) {
            setError(context ? permissionMessage(context) : CONTEXT_CHANGED_ERROR);
            return;
        }
        childCreationInFlight = true;
        setPhase("reconciling");
        setError("");
        try {
            requireCurrentContext(expected, true);
            const result = await Native.reconcileSpaceChildCreate(
                expected.parentSpaceId,
                expected.expectedAccountId
            );
            requireCurrentContext(expected);
            if (!result.resolved) {
                if (mounted.current) {
                    setPhase("idle");
                    setError("The server has not found the created item yet. Check again later; do not create a replacement.");
                }
                return;
            }
            if (mounted.current) setNeedsReconcile(false);
            await refreshAndClose("Recovered and linked the item.", result.roomId, kind);
            requireCurrentContext(expected);
        } catch (caught) {
            if (mounted.current) {
                setPhase("idle");
                setError(publicError(caught));
            }
        } finally {
            childCreationInFlight = false;
        }
    }

    async function repairChildLink(roomId = pendingRepairRoomId, operationAlreadyOwned = false) {
        if (!roomId || (!operationAlreadyOwned && (busy || childCreationInFlight))) return;
        if (!currentContext(expected, true)) {
            if (mounted.current) setError(context ? permissionMessage(context) : CONTEXT_CHANGED_ERROR);
            return;
        }
        if (!operationAlreadyOwned) childCreationInFlight = true;
        if (mounted.current) {
            setPhase("repairing");
            setError("");
        }
        try {
            requireCurrentContext(expected, true);
            await Native.repairSpaceChildLink(
                expected.parentSpaceId,
                roomId,
                expected.expectedAccountId
            );
            requireCurrentContext(expected);
            if (mounted.current) setPendingRepairRoomId(undefined);
            await refreshAndClose(
                `Created and linked the ${creationLabel(kind)} "${cleanName}".`,
                roomId,
                kind
            );
            requireCurrentContext(expected);
        } catch (caught) {
            if (mounted.current) {
                setPhase("idle");
                setError(`The item exists, but its Space link still needs repair. ${publicError(caught)}`);
            }
        } finally {
            childCreationInFlight = false;
        }
    }

    async function createChild() {
        if (!cleanName || busy || started.current) return;
        const before = currentContext(expected);
        if (!before) {
            setError(CONTEXT_CHANGED_ERROR);
            return;
        }
        if (!before.canManageSpaceChildren) {
            setError(permissionMessage(before));
            return;
        }
        if (childCreationInFlight) {
            setError("Another channel or category is already being created.");
            return;
        }

        started.current = true;
        childCreationInFlight = true;
        setError("");
        setPhase("creating");
        let result: MatrixCreateSpaceChildResult;
        try {
            requireCurrentContext(expected, true);
            result = await Native.createSpaceChild({
                parentSpaceId: expected.parentSpaceId,
                kind,
                name: cleanName,
                topic: topic.trim() || undefined,
            }, expected.expectedAccountId);
            requireCurrentContext(expected);
        } catch (caught) {
            const code = matrixErrorCode(caught);
            if ((code === "MATRIX_CREATE_SPACE_CHILD_AMBIGUOUS"
                || code === "MATRIX_CREATE_SPACE_CHILD_RECONCILE_REQUIRED")
                && currentContext(expected)) {
                started.current = false;
                if (mounted.current) {
                    setNeedsReconcile(true);
                    setPhase("reconciling");
                }
                try {
                    requireCurrentContext(expected, true);
                    const reconciled = await Native.reconcileSpaceChildCreate(
                        expected.parentSpaceId,
                        expected.expectedAccountId
                    );
                    requireCurrentContext(expected);
                    if (reconciled.resolved) {
                        if (mounted.current) setNeedsReconcile(false);
                        await refreshAndClose("Recovered and linked the item.", reconciled.roomId, kind);
                        requireCurrentContext(expected);
                    } else if (mounted.current) {
                        setPhase("idle");
                        setError("Creation may have succeeded, but the server has not found it yet. Check again later; do not create a replacement.");
                    }
                } catch (reconcileError) {
                    if (mounted.current) {
                        setPhase("idle");
                        setError(publicError(reconcileError));
                    }
                } finally {
                    childCreationInFlight = false;
                }
                return;
            }

            started.current = false;
            childCreationInFlight = false;
            if (mounted.current) {
                setPhase("idle");
                setError(publicError(caught));
            }
            return;
        }

        const label = creationLabel(kind);
        if (result.partial) {
            if (mounted.current) {
                setPendingRepairRoomId(result.roomId);
                started.current = false;
                setPhase("idle");
            }
            await repairChildLink(result.roomId, true);
            requireCurrentContext(expected);
        } else {
            await refreshAndClose(`Created ${label} "${cleanName}".`, result.roomId, kind);
            requireCurrentContext(expected);
        }
    }

    const permissionError = !context
        ? CONTEXT_CHANGED_ERROR
        : !context.canManageSpaceChildren ? permissionMessage(context) : "";

    return (
        <Modal
            {...modalProps}
            onClose={busy ? () => undefined : modalProps.onClose}
            title={kind === "space" ? "Create Category" : "Create Channel"}
            subtitle={`Add it to ${expected.parentLabel}.`}
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
                    Access is inherited from the parent server. Private channels use end-to-end encryption.
                </p>
                {permissionError && !error && (
                    <div className="vc-matrix-error" role="alert">{permissionError}</div>
                )}
                {error && <div className="vc-matrix-error" role="alert">{error}</div>}
            </div>
        </Modal>
    );
}

export function openMatrixSpaceChildModal(
    expectedContext: MatrixSpaceCreateContext,
    initialKind: MatrixSpaceChildKind = "room",
    lockKind = false
) {
    const context = getCurrentMatrixSpaceCreateContext(expectedContext);
    if (!context) return false;
    let modalKey = "";
    modalKey = openModal(
        modalProps => (
            <CreateSpaceChildModal
                modalProps={modalProps}
                expected={context}
                initialKind={initialKind}
                lockKind={lockKind}
            />
        ),
        { onCloseCallback: () => unregisterMatrixManagementModal(modalKey) }
    );
    registerMatrixManagementModal(modalKey);
    return true;
}
