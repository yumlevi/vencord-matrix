/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import type { RenderModalProps } from "@vencord/discord-types";
import { Button, closeModal, Modal, openModal, Tooltip, useEffect, useRef, useState } from "@webpack/common";

import {
    getMatrixAccessRequestContext,
    getMatrixSpaceAccessRequests,
    isMatrixAccessRequestContextCurrent,
    type MatrixAccessRequest,
    type MatrixAccessRequestContext,
    type MatrixAccessRequestDecision,
    type MatrixAccessRequestList,
    resolveMatrixSpaceAccessRequest,
    subscribeMatrixAccessRequestProjection,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";

const projectionRenderListeners = new Set<() => void>();
const baselineCounts = new Map<string, { count: number; complete: boolean; }>();
const modalKeys = new Set<string>();
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
let unsubscribeProjection: (() => void) | undefined;

function bindingKey(context: MatrixAccessRequestContext) {
    return [
        context.generation,
        context.expectedAccountId,
        context.spaceId,
        context.guildId,
    ].join("\0");
}

function sameBinding(left: MatrixAccessRequestContext, right: MatrixAccessRequestContext | undefined) {
    return Boolean(right)
        && left.generation === right!.generation
        && left.expectedAccountId === right!.expectedAccountId
        && left.spaceId === right!.spaceId
        && left.guildId === right!.guildId;
}

function currentBoundContext(expected: MatrixAccessRequestContext) {
    const current = getMatrixAccessRequestContext(expected.guildId);
    return sameBinding(expected, current) && isMatrixAccessRequestContextCurrent(expected)
        ? current
        : undefined;
}

function isEligible(context: MatrixAccessRequestContext | undefined) {
    return Boolean(context?.canApprove || context?.canDeny);
}

function emitProjectionRender() {
    for (const listener of projectionRenderListeners) listener();
}

function observeProjection(contexts: readonly MatrixAccessRequestContext[]) {
    const liveKeys = new Set<string>();
    for (const context of contexts) {
        const key = bindingKey(context);
        liveKeys.add(key);
        const previous = baselineCounts.get(key);
        baselineCounts.set(key, { count: context.count, complete: context.countComplete });
        // A new binding is a baseline, including first startup, reconnects,
        // account switches, and a Space that has only just become projected.
        // An explicit complete-member load changes incomplete -> complete and
        // is reconciliation, not a live increase. Within a stable completeness
        // state, however, newly synced knocks are genuine live observations.
        if (previous == null
            || previous.complete !== context.countComplete
            || context.count <= previous.count
            || !isEligible(context)) continue;
        const increase = context.count - previous.count;
        void showNotification({
            title: `Access requests in ${context.label}`,
            body: increase === 1
                ? "One new request is waiting for review."
                : `${increase} new requests are waiting for review.`,
            color: "var(--brand-500)",
            noPersist: true,
            onClick: () => openMatrixAccessRequests(context.guildId, context),
        });
    }
    for (const key of baselineCounts.keys()) {
        if (!liveKeys.has(key)) baselineCounts.delete(key);
    }
    emitProjectionRender();
}

function useProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => {
        const listener = () => setRevision(value => value + 1);
        projectionRenderListeners.add(listener);
        return () => {
            projectionRenderListeners.delete(listener);
        };
    }, []);
}

function safeRequesterDisplayName(value: string | undefined) {
    return value?.replace(BIDI_FORMATTING_CONTROL_PATTERN, "").trim() || undefined;
}

function visibleRequesterUserId(value: string) {
    return value.replace(BIDI_FORMATTING_CONTROL_PATTERN, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function avatarGlyph(displayName: string | undefined, userId: string) {
    const label = displayName || userId;
    const first = Array.from(label)[0] ?? Array.from(userId)[1] ?? "?";
    return first.toLocaleUpperCase();
}

function AccessRequestsIcon() {
    return (
        <svg aria-hidden="true" width={24} height={24} viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7.5-1a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2 21a1 1 0 0 1-1-1c0-4 2.8-6.5 8-6.5 1.4 0 2.6.2 3.6.6a6.7 6.7 0 0 0-1.8 6.1c.1.3.1.5.2.8H2Zm15.5-8a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2v-2a1 1 0 0 1 1-1Z"
            />
        </svg>
    );
}

function accessRequestCountLabel(context: MatrixAccessRequestContext) {
    if (!context.countComplete) return "\u2026";
    return context.count > 99 ? "99+" : String(context.count);
}

export function MatrixAccessRequestsToolbarButton({ guildId }: { guildId: string; }) {
    useProjectionRevision();
    const context = getMatrixAccessRequestContext(guildId);
    if (!isEligible(context)) return null;
    const label = context!.countComplete
        ? `Access requests (${context!.count >= 200 ? "200+" : context!.count})`
        : "Access requests (loading count)";
    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className="vc-matrix-search-button vc-matrix-access-requests-button"
                    aria-label={label}
                    onClick={() => openMatrixAccessRequests(guildId, context)}
                >
                    <AccessRequestsIcon />
                    <span className="vc-matrix-access-requests-badge" aria-hidden="true">
                        {accessRequestCountLabel(context!)}
                    </span>
                </button>
            )}
        </Tooltip>
    );
}

function MatrixAccessRequestsModal({
    expected,
    modalProps,
}: {
    expected: MatrixAccessRequestContext;
    modalProps: RenderModalProps;
}) {
    useProjectionRevision();
    const [list, setList] = useState<MatrixAccessRequestList>();
    const [loading, setLoading] = useState(true);
    const [activeAction, setActiveAction] = useState<string>();
    const [error, setError] = useState<string>();
    const operation = useRef(0);
    const context = currentBoundContext(expected);

    useEffect(() => {
        const requestGeneration = ++operation.current;
        const before = currentBoundContext(expected);
        if (!before || !isEligible(before)) {
            setLoading(false);
            setError("This server or account changed. Close this window and try again.");
            return;
        }
        setLoading(true);
        setError(undefined);
        void getMatrixSpaceAccessRequests(before).then(next => {
            if (requestGeneration !== operation.current) return;
            const after = currentBoundContext(expected);
            if (!after || !isEligible(after)) {
                setError("This server or account changed. Close this window and try again.");
                return;
            }
            setList(next);
        }, () => {
            if (requestGeneration !== operation.current) return;
            setError(currentBoundContext(expected)
                ? "Requests could not be loaded. Try again."
                : "This server or account changed. Close this window and try again.");
        }).finally(() => {
            if (requestGeneration === operation.current) setLoading(false);
        });
        return () => {
            operation.current++;
        };
    }, [expected.expectedAccountId, expected.generation, expected.guildId, expected.spaceId]);

    async function resolveRequest(request: MatrixAccessRequest, decision: MatrixAccessRequestDecision) {
        if (loading || activeAction) return;
        const before = currentBoundContext(expected);
        const allowedByProjection = decision === "approve" ? before?.canApprove : before?.canDeny;
        const allowedByList = decision === "approve" ? list?.canApprove : list?.canDeny;
        const allowedForTarget = decision === "approve" ? request.canApprove : request.canDeny;
        if (!before || !allowedByProjection || !allowedByList || !allowedForTarget) {
            setError("You no longer have permission to perform that action.");
            return;
        }

        const requestGeneration = ++operation.current;
        const actionKey = `${decision}\0${request.userId}`;
        setActiveAction(actionKey);
        setError(undefined);
        let resolutionSucceeded = false;
        let resolutionMembership: "invite" | "join" | "leave" | undefined;
        let resolutionAmbiguous = false;
        try {
            try {
                if (!currentBoundContext(expected)) throw new Error();
                const result = await resolveMatrixSpaceAccessRequest(before, request.userId, decision);
                if (requestGeneration !== operation.current || !currentBoundContext(expected)) return;
                resolutionSucceeded = true;
                resolutionMembership = result.membership;
            } catch (error) {
                if (requestGeneration !== operation.current) return;
                if (!currentBoundContext(expected)) {
                    setError("This server or account changed. Close this window and try again.");
                    return;
                }
                resolutionAmbiguous = matrixErrorCode(error) === "MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS";
            }

            const refreshContext = currentBoundContext(expected);
            if (!refreshContext || !isEligible(refreshContext)) {
                setError("This server or account changed. Close this window and try again.");
                return;
            }
            try {
                const next = await getMatrixSpaceAccessRequests(refreshContext);
                if (requestGeneration !== operation.current || !currentBoundContext(expected)) return;
                setList(next);
                setError(resolutionSucceeded
                    ? decision === "approve"
                        ? resolutionMembership === "join"
                            ? "Access approved; the requester is already joined."
                            : "Access approved; the invitation is ready."
                        : "Access request denied."
                    : resolutionAmbiguous
                        ? "The server could not confirm the change. It may already be resolved; the list has been refreshed."
                        : "That request could not be updated. The list has been refreshed.");
            } catch {
                if (requestGeneration !== operation.current) return;
                setError(currentBoundContext(expected)
                    ? resolutionSucceeded
                        ? "The request was updated, but the list could not be refreshed. Reopen this window."
                        : resolutionAmbiguous
                            ? "The server could not confirm the change, and the list could not be refreshed. It may already be resolved."
                            : "That request could not be updated, and the list could not be refreshed. Try again."
                    : "This server or account changed. Close this window and try again.");
            }
        } finally {
            if (requestGeneration === operation.current) setActiveAction(undefined);
        }
    }

    if (!context || !isEligible(context)) {
        return (
            <Modal {...modalProps} title="Access requests unavailable">
                This server or account changed. Close this window and try again.
            </Modal>
        );
    }

    const pendingLabel = list
        ? `${list.requests.length} pending request${list.requests.length === 1 ? "" : "s"}`
        : loading ? "Loading requests..." : "Requests unavailable";
    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Access requests - ${context.label}`}
            subtitle={pendingLabel}
            actions={[{
                text: "Close",
                variant: "secondary",
                onClick: modalProps.onClose,
            }]}
        >
            <div className="vc-matrix-access-requests">
                <div className="vc-matrix-access-requests-status" role="status" aria-live="polite">
                    {error ?? (list?.truncated ? "Showing the first 200 pending requests." : "")}
                </div>
                {!loading && list && !list.requests.length && (
                    <div className="vc-matrix-access-requests-empty">There are no pending requests.</div>
                )}
                <div className="vc-matrix-access-requests-list" role="list">
                    {list?.requests.map(request => {
                        const canApprove = context.canApprove && list.canApprove && request.canApprove;
                        const canDeny = context.canDeny && list.canDeny && request.canDeny;
                        const approveKey = `approve\0${request.userId}`;
                        const denyKey = `deny\0${request.userId}`;
                        const requesterName = safeRequesterDisplayName(request.displayName);
                        const requesterUserId = visibleRequesterUserId(request.userId);
                        return (
                            <div className="vc-matrix-access-request" role="listitem" key={request.userId}>
                                <div className="vc-matrix-access-request-avatar" aria-hidden="true">
                                    {avatarGlyph(requesterName, requesterUserId)}
                                </div>
                                <div className="vc-matrix-access-request-identity">
                                    <strong>{requesterName || requesterUserId}</strong>
                                    <code dir="ltr">{requesterUserId}</code>
                                </div>
                                <div className="vc-matrix-access-request-actions">
                                    {canApprove && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            color={Button.Colors.PRIMARY}
                                            disabled={Boolean(activeAction) || loading}
                                            onClick={() => void resolveRequest(request, "approve")}
                                        >
                                            {activeAction === approveKey ? "Approving..." : "Approve"}
                                        </Button>
                                    )}
                                    {canDeny && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            color={Button.Colors.RED}
                                            disabled={Boolean(activeAction) || loading}
                                            onClick={() => void resolveRequest(request, "deny")}
                                        >
                                            {activeAction === denyKey ? "Denying..." : "Deny"}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Modal>
    );
}

export function openMatrixAccessRequests(
    guildId: string,
    expectedContext = getMatrixAccessRequestContext(guildId)
) {
    const context = expectedContext && currentBoundContext(expectedContext);
    if (!context || !isEligible(context)) return false;
    let modalKey = "";
    modalKey = openModal(
        modalProps => <MatrixAccessRequestsModal expected={context} modalProps={modalProps} />,
        { onCloseCallback: () => modalKeys.delete(modalKey) }
    );
    modalKeys.add(modalKey);
    return true;
}

export function startMatrixAccessRequestUx() {
    unsubscribeProjection?.();
    baselineCounts.clear();
    unsubscribeProjection = subscribeMatrixAccessRequestProjection(observeProjection);
}

export function stopMatrixAccessRequestUx() {
    unsubscribeProjection?.();
    unsubscribeProjection = undefined;
    baselineCounts.clear();
    for (const modalKey of modalKeys) closeModal(modalKey);
    modalKeys.clear();
    emitProjectionRender();
}
