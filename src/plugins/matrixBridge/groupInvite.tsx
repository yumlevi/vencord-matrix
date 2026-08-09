/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RenderModalProps } from "@vencord/discord-types";
import {
    Button,
    Modal,
    openModal,
    showToast,
    TextInput,
    Toasts,
    useEffect,
    useRef,
    useState,
} from "@webpack/common";

import {
    acknowledgeMatrixGroupChatInvite,
    getCurrentMatrixGroupInviteContext,
    getMatrixGroupInviteContext,
    getMatrixGroupInviteContextForRoom,
    inviteMatrixUserToGroupChat,
    type MatrixGroupInviteCandidate,
    type MatrixGroupInviteContext,
    type MatrixGroupInviteResult,
    overrideMatrixGroupChatInviteAmbiguity,
    reconcileMatrixGroupChatInvite,
    registerMatrixManagementModal,
    searchMatrixGroupInviteCandidates,
    subscribeMatrixSpaceProjection,
    unregisterMatrixManagementModal,
    waitForMatrixGroupInviteProjection,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";

const SEARCH_LIMIT = 25;
const PROVENANCE_REFRESH_MS = 4 * 60_000 + 45_000;
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_VISIBLE_TEXT_PATTERN = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SAFE_BARE_LOCALPART_PATTERN = /^[a-z0-9._=\-/+]+$/u;
let activeGroupInviteModalKey: string | undefined;

interface SearchCandidate extends MatrixGroupInviteCandidate {
    provenanceAt: number;
}

type Phase = "checking" | "search" | "pending" | "result";

function sameBinding(left: MatrixGroupInviteContext, right: MatrixGroupInviteContext | undefined) {
    return Boolean(right)
        && left.channelId === right!.channelId
        && left.roomId === right!.roomId
        && left.expectedAccountId === right!.expectedAccountId
        && left.generation === right!.generation;
}

function currentBoundContext(expected: MatrixGroupInviteContext) {
    const current = getCurrentMatrixGroupInviteContext(expected);
    return sameBinding(expected, current) ? current : undefined;
}

function useProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
}

function visibleText(value: string, fallback: string, limit: number) {
    return value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, " ").replace(/\s+/gu, " ").trim().slice(0, limit) || fallback;
}

function visibleUserId(value: string) {
    return value.replace(BIDI_FORMATTING_CONTROL_PATTERN, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function displayName(candidate: MatrixGroupInviteCandidate) {
    return visibleText(candidate.displayName, "Account", 100);
}

function initial(value: string) {
    return Array.from(value)[0]?.toLocaleUpperCase() || "?";
}

function cleanQuery(value: string) {
    return value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").slice(0, 256);
}

function isExplicitExactQuery(value: string, accountId: string) {
    const separator = accountId.indexOf(":");
    if (separator <= 1) return false;
    const server = accountId.slice(separator + 1);
    if (SAFE_BARE_LOCALPART_PATTERN.test(value)) {
        return new TextEncoder().encode(`@${value}:${server}`).byteLength <= 255;
    }
    if (!value.startsWith("@") || new TextEncoder().encode(value).byteLength > 255) return false;
    const querySeparator = value.indexOf(":", 1);
    return querySeparator > 1
        && SAFE_BARE_LOCALPART_PATTERN.test(value.slice(1, querySeparator))
        && value.slice(querySeparator + 1) === server;
}

function permissionMessage(context: MatrixGroupInviteContext) {
    const { current, required } = context.permission;
    if (current === "unverifiable" || required === "unverifiable") {
        return "The server could not verify your permission to invite people.";
    }
    const currentLabel = current === "infinite" ? "\u221e" : current;
    return `Your server permission level is ${currentLabel}; inviting requires ${required}.`;
}

function publicSearchError(error: unknown) {
    switch (matrixErrorCode(error)) {
        case "MATRIX_GROUP_CHAT_SEARCH_BUSY":
            return "Another account search is still running. Wait for it to finish, then search again.";
        case "MATRIX_GROUP_CHAT_EXACT_LOOKUP_INVALID":
            return "Enter an exact lowercase local username or full account ID on this account domain.";
        case "MATRIX_GROUP_CHAT_EXACT_LOOKUP_RATE_LIMITED":
        case "MATRIX_USER_DIRECTORY_RATE_LIMITED":
        case "M_LIMIT_EXCEEDED":
            return "Your account provider is receiving too many searches. Wait a moment and try again.";
        case "MATRIX_GROUP_CHAT_INVITE_FORBIDDEN":
            return "You no longer have permission to invite people to this group.";
        case "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE":
            return "The server could not verify your permission to invite people.";
        default:
            return "Your account provider could not search its user directory. Try again.";
    }
}

function publicInviteError(error: unknown) {
    switch (matrixErrorCode(error)) {
        case "MATRIX_GROUP_CHAT_CANDIDATE_STALE":
            return "That search result expired. Search again before inviting. No new invite was sent.";
        case "MATRIX_GROUP_CHAT_INVITE_FORBIDDEN":
            return "You no longer have permission to invite people to this group.";
        case "MATRIX_GROUP_CHAT_INVITE_PERMISSION_UNVERIFIABLE":
            return "The server could not verify your permission to invite people.";
        case "MATRIX_GROUP_CHAT_FULL":
            return "This group already has the maximum of 10 participants and pending invites.";
        case "MATRIX_GROUP_CHAT_INVITE_SELF":
        case "MATRIX_GROUP_CHAT_INVITE_BANNED":
        case "MATRIX_REMOTE_USER_REJECTED":
            return "That account is not eligible for this group. No new invite was sent.";
        case "MATRIX_GROUP_CHAT_INVITE_REJECTED":
            return "The account provider rejected this invite. No new invite was sent.";
        case "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS":
        case "MATRIX_GROUP_CHAT_INVITE_RECONCILE_REQUIRED":
            return "The provider could not confirm whether the invite was sent. Check its status before any retry.";
        case "MATRIX_GROUP_CHAT_INVITE_IN_PROGRESS":
        case "MATRIX_GROUP_CHAT_INVITE_RECONCILE_IN_PROGRESS":
            return "Another window is already handling an invite for this group. Check its status before any retry.";
        default:
            return "The account provider could not send this invite. Try again.";
    }
}

function candidateStatus(candidate: MatrixGroupInviteCandidate) {
    switch (candidate.membership) {
        case "join": return "Already joined";
        case "invite": return "Already invited";
        case "ban": return "Unavailable";
        case "knock": return "Requested access";
        default: return "";
    }
}

function CandidateIdentity({ candidate }: { candidate: MatrixGroupInviteCandidate; }) {
    const name = displayName(candidate);
    return (
        <>
            <div className="vc-matrix-invite-avatar" aria-hidden="true">{initial(name)}</div>
            <div className="vc-matrix-invite-identity">
                <strong dir="auto">{name}</strong>
                <code dir="ltr">{visibleUserId(candidate.userId)}</code>
                {candidateStatus(candidate) && <span>{candidateStatus(candidate)}</span>}
            </div>
        </>
    );
}

function MatrixGroupInviteModal({
    expected,
    modalProps,
}: {
    expected: MatrixGroupInviteContext;
    modalProps: RenderModalProps;
}) {
    useProjectionRevision();
    const context = currentBoundContext(expected);
    const mounted = useRef(false);
    const searchSerial = useRef(0);
    const operationSerial = useRef(0);
    const inviteLock = useRef(false);
    const reconcileLock = useRef(false);
    const acknowledgeLock = useRef(false);
    const overrideLock = useRef(false);
    const [phase, setPhase] = useState<Phase>("checking");
    const [query, setQuery] = useState("");
    const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [limited, setLimited] = useState(false);
    const [exactLookup, setExactLookup] = useState<"not_requested" | "resolved" | "not_found_or_unavailable">("not_requested");
    const [checking, setChecking] = useState(true);
    const [inviting, setInviting] = useState(false);
    const [acknowledging, setAcknowledging] = useState(false);
    const [overriding, setOverriding] = useState(false);
    const [overrideArmed, setOverrideArmed] = useState(false);
    const [pendingUserId, setPendingUserId] = useState<string>();
    const [result, setResult] = useState<MatrixGroupInviteResult>();
    const [projectionReady, setProjectionReady] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [participantCount, setParticipantCount] = useState(expected.participantCount);
    const [full, setFull] = useState(expected.full);
    const [error, setError] = useState("");

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            searchSerial.current++;
            operationSerial.current++;
        };
    }, []);

    useEffect(() => {
        if (!context) {
            searchSerial.current++;
            operationSerial.current++;
            setCandidates([]);
            setError("This group or signed-in account changed. Close this window and try again.");
            return;
        }
        setParticipantCount(context.participantCount);
        setFull(context.full);
    }, [context?.expectedAccountId, context?.generation, context?.participantCount, context?.full]);

    useEffect(() => {
        if (!candidates.length) return;
        const expiry = Math.min(...candidates.map(candidate => candidate.provenanceAt + PROVENANCE_REFRESH_MS));
        const timer = setTimeout(() => {
            setCandidates([]);
            setSearched(false);
            setError("Search results expired. Search again before inviting anyone.");
        }, Math.max(0, expiry - Date.now()));
        return () => clearTimeout(timer);
    }, [candidates]);

    function operationCurrent(serial: number) {
        return mounted.current
            && operationSerial.current === serial
            && Boolean(currentBoundContext(expected));
    }

    function beginProjectionWait(nextResult: MatrixGroupInviteResult, serial: number) {
        setResult(nextResult);
        setPendingUserId(nextResult.userId);
        setProjectionReady(false);
        setSyncing(true);
        setOverrideArmed(false);
        setPhase("result");
        setError("");
        void waitForMatrixGroupInviteProjection(expected, nextResult.userId).then(membership => {
            if (!operationCurrent(serial)) return;
            setProjectionReady(Boolean(membership));
            setSyncing(false);
        }, () => {
            if (!operationCurrent(serial)) return;
            setProjectionReady(false);
            setSyncing(false);
        });
    }

    async function reconcile(serial: number, afterAmbiguity: boolean) {
        if (reconcileLock.current) return;
        reconcileLock.current = true;
        setChecking(true);
        setError("");
        try {
            const reconciled = await reconcileMatrixGroupChatInvite(expected);
            if (!operationCurrent(serial)) return;
            if (reconciled.status === "resolved") {
                beginProjectionWait(reconciled.result, serial);
            } else if (reconciled.status === "pending") {
                setPendingUserId(reconciled.userId);
                setOverrideArmed(false);
                setPhase("pending");
                setError("This invite is still unconfirmed. Checking status never sends it again.");
            } else if (afterAmbiguity) {
                setPhase("pending");
                setError("The invite is still unconfirmed. Inspect the participant list and check again before any retry.");
            } else {
                setPendingUserId(undefined);
                setPhase("search");
            }
        } catch {
            if (!operationCurrent(serial)) return;
            setPhase("pending");
            setError(afterAmbiguity
                ? "The invite is unconfirmed and its status could not be checked. Check again later; do not retry it yet."
                : "The provider could not check for an unfinished invite. Check again before inviting anyone.");
        } finally {
            reconcileLock.current = false;
            if (operationCurrent(serial)) setChecking(false);
        }
    }

    useEffect(() => {
        const serial = ++operationSerial.current;
        void reconcile(serial, false);
    }, [expected.channelId, expected.expectedAccountId, expected.generation, expected.roomId]);

    function submitSearch() {
        const submittedQuery = cleanQuery(query).trim();
        const before = currentBoundContext(expected);
        if (!before || searching || inviting || checking || !submittedQuery) {
            if (!submittedQuery) setError("Enter a display name, full account ID, or exact local username.");
            return;
        }
        if (!before.canInvite) {
            setError(permissionMessage(before));
            return;
        }
        if (before.full || full) {
            setError("This group already has the maximum of 10 participants and pending invites.");
            return;
        }
        const serial = ++searchSerial.current;
        const exact = isExplicitExactQuery(submittedQuery, expected.expectedAccountId);
        setSearching(true);
        setSearched(true);
        setError("");
        void searchMatrixGroupInviteCandidates(before, submittedQuery, SEARCH_LIMIT, exact).then(response => {
            if (!mounted.current || searchSerial.current !== serial || !currentBoundContext(expected)) return;
            const provenanceAt = Date.now();
            setCandidates(response.candidates.map(candidate => ({ ...candidate, provenanceAt })));
            setLimited(response.limited || response.directoryLimited);
            setExactLookup(response.exactLookup);
            setParticipantCount(response.participantCount);
            setFull(response.full);
        }).catch(caught => {
            if (!mounted.current || searchSerial.current !== serial || !currentBoundContext(expected)) return;
            setCandidates([]);
            setLimited(false);
            setExactLookup("not_requested");
            setError(publicSearchError(caught));
        }).finally(() => {
            if (mounted.current && searchSerial.current === serial) setSearching(false);
        });
    }

    async function invite(candidate: SearchCandidate) {
        const before = currentBoundContext(expected);
        if (!before || inviteLock.current || checking || candidate.membership === "join"
            || candidate.membership === "invite" || candidate.membership === "ban") return;
        if (!before.canInvite) {
            setError(permissionMessage(before));
            return;
        }
        if (before.full || full) {
            setError("This group already has the maximum of 10 participants and pending invites.");
            return;
        }
        if (Date.now() - candidate.provenanceAt >= PROVENANCE_REFRESH_MS) {
            setCandidates([]);
            setSearched(false);
            setError("That search result expired. Search again before inviting anyone.");
            return;
        }
        const serial = ++operationSerial.current;
        let shouldReconcile = false;
        inviteLock.current = true;
        setInviting(true);
        setPendingUserId(candidate.userId);
        setError("");
        try {
            const nextResult = await inviteMatrixUserToGroupChat(before, candidate.userId);
            if (!operationCurrent(serial)) return;
            beginProjectionWait(nextResult, serial);
        } catch (caught) {
            if (!operationCurrent(serial)) return;
            const code = matrixErrorCode(caught);
            if (code === "MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS"
                || code === "MATRIX_GROUP_CHAT_INVITE_RECONCILE_REQUIRED"
                || code === "MATRIX_GROUP_CHAT_INVITE_IN_PROGRESS"
                || code === "MATRIX_GROUP_CHAT_INVITE_RECONCILE_IN_PROGRESS") {
                setPhase("pending");
                setError(publicInviteError(caught));
                shouldReconcile = true;
            } else if (code === "MATRIX_GROUP_CHAT_CANDIDATE_STALE") {
                setCandidates([]);
                setSearched(false);
                setError(publicInviteError(caught));
            } else {
                setError(publicInviteError(caught));
            }
        } finally {
            inviteLock.current = false;
            if (operationCurrent(serial)) setInviting(false);
        }
        if (shouldReconcile && operationCurrent(serial)) void reconcile(serial, true);
    }

    function checkStatus() {
        if (checking || inviting || reconcileLock.current || !currentBoundContext(expected)) return;
        const serial = ++operationSerial.current;
        void reconcile(serial, true);
    }

    async function overridePendingInvite() {
        const before = currentBoundContext(expected);
        if (!before || !pendingUserId || !overrideArmed || overrideLock.current) return;
        const serial = ++operationSerial.current;
        overrideLock.current = true;
        setOverriding(true);
        setError("");
        try {
            await overrideMatrixGroupChatInviteAmbiguity(before, pendingUserId);
            if (!operationCurrent(serial)) return;
            setCandidates([]);
            setSearched(false);
            setPendingUserId(undefined);
            setOverrideArmed(false);
            setPhase("search");
            setError("The unconfirmed invite receipt was cleared after a fresh status check. Search for the account again before deciding whether to retry.");
        } catch {
            if (!operationCurrent(serial)) return;
            setError("The provider could not safely clear this unconfirmed invite. Check its status again later; do not retry it yet.");
        } finally {
            overrideLock.current = false;
            if (operationCurrent(serial)) setOverriding(false);
        }
    }

    async function acknowledgeResult() {
        const before = currentBoundContext(expected);
        if (!before || !result || syncing || acknowledgeLock.current) return;
        const serial = ++operationSerial.current;
        acknowledgeLock.current = true;
        setAcknowledging(true);
        setError("");
        try {
            await acknowledgeMatrixGroupChatInvite(before, result.userId);
            if (!operationCurrent(serial)) return;
            modalProps.onClose();
        } catch {
            if (!operationCurrent(serial)) return;
            setError("The invite was confirmed, but its local recovery receipt could not be cleared. Keep this result or close for now; do not send another invite to this account.");
        } finally {
            acknowledgeLock.current = false;
            if (operationCurrent(serial)) setAcknowledging(false);
        }
    }

    const currentCount = Math.max(participantCount, context?.participantCount ?? 0);
    const currentFull = full || context?.full === true || currentCount >= 10;
    const remaining = Math.max(0, 10 - currentCount);
    const contextError = !context
        ? "This group or signed-in account changed. Close this window and try again."
        : !context.canInvite ? permissionMessage(context) : "";
    const status = contextError || error;
    const busy = searching || inviting || checking || acknowledging || overriding;
    const close = () => {
        if (inviteLock.current || reconcileLock.current || acknowledgeLock.current || overrideLock.current || busy
            || phase === "result" && Boolean(result)) return;
        modalProps.onClose();
    };
    const closeForNow = () => {
        if (!inviteLock.current && !reconcileLock.current && !acknowledgeLock.current && !overrideLock.current) {
            modalProps.onClose();
        }
    };
    const actions = phase === "pending" ? overrideArmed ? [{
        text: "Keep waiting",
        variant: "secondary" as const,
        disabled: busy,
        onClick: () => setOverrideArmed(false),
    }, {
        text: overriding ? "Checking and clearing..." : "Clear unconfirmed invite",
        variant: "danger" as const,
        disabled: !context || busy || !pendingUserId,
        onClick: () => void overridePendingInvite(),
    }] : [{
        text: "Close for now",
        variant: "secondary" as const,
        disabled: busy,
        onClick: closeForNow,
    }, {
        text: "Review retry safety",
        variant: "secondary" as const,
        disabled: busy || !pendingUserId,
        onClick: () => setOverrideArmed(true),
    }, {
        text: checking ? "Checking..." : "Check Status",
        variant: "primary" as const,
        disabled: !context || busy,
        onClick: checkStatus,
    }] : phase === "result" ? [{
        text: "Close for now",
        variant: "secondary" as const,
        disabled: acknowledging,
        onClick: closeForNow,
    }, {
        text: acknowledging ? "Confirming..." : "Done",
        variant: "primary" as const,
        disabled: !context || syncing || acknowledging,
        onClick: () => void acknowledgeResult(),
    }] : [{
        text: "Close",
        variant: "secondary" as const,
        disabled: busy,
        onClick: close,
    }];

    return (
        <Modal
            {...modalProps}
            onClose={close}
            title={`Add People - ${visibleText(expected.label, "Group chat", 100)}`}
            subtitle={`${currentCount} of 10 places used; ${remaining} remaining.`}
            actions={actions}
        >
            <div className="vc-matrix-invite-people">
                {status && <div className="vc-matrix-error" role="alert">{status}</div>}
                {phase === "checking" && !status && (
                    <div className="vc-matrix-invite-empty" role="status">Checking for an unfinished invite...</div>
                )}
                {phase === "search" && (
                    <>
                        <div className="vc-matrix-invite-search">
                            <TextInput
                                autoFocus
                                disabled={Boolean(contextError) || busy || currentFull}
                                value={query}
                                placeholder="Display name, @username:domain, or exact local username"
                                maxLength={256}
                                onChange={value => {
                                    setQuery(cleanQuery(value));
                                    setError("");
                                }}
                                onKeyDown={event => {
                                    if (event.key === "Enter") submitSearch();
                                }}
                            />
                            <Button
                                disabled={Boolean(contextError) || busy || currentFull || !cleanQuery(query).trim()}
                                onClick={submitSearch}
                            >
                                {searching ? "Searching..." : "Search"}
                            </Button>
                        </div>
                        <p className="vc-matrix-invite-scope">
                            Display-name results come from your configured account provider&apos;s directory and may be incomplete.
                            A full account ID or safe lowercase local username performs an exact same-domain lookup, which can probe whether an account exists outside those limited results.
                        </p>
                        <p className="vc-matrix-invite-scope">
                            The provider can observe searches. Search text and results are displayed inside Discord, where Discord and installed client plugins can read them.
                            Everyone must use the {visibleText(expected.providerLabel, "same", 255)} account domain.
                        </p>
                        {currentFull && (
                            <div className="vc-matrix-invite-notice" role="status">
                                This group already has the maximum of 10 participants and pending invites.
                            </div>
                        )}
                        {limited && !searching && (
                            <div className="vc-matrix-invite-notice" role="status">
                                More display-name matches may exist. Refine the search or use an exact account ID.
                            </div>
                        )}
                        {searching && <div className="vc-matrix-invite-empty" role="status">Searching...</div>}
                        {!searching && searched && !candidates.length && !status && (
                            <div className="vc-matrix-invite-empty" role="status">
                                {exactLookup === "not_found_or_unavailable"
                                    ? "That exact local account was not found or could not be verified. Check the spelling and account domain."
                                    : "No display-name matches were returned. The directory can omit accounts; try the exact @username:domain or exact lowercase local username."}
                            </div>
                        )}
                        {!searching && candidates.length > 0 && (
                            <div className="vc-matrix-invite-list" role="list" aria-label="Accounts available to invite">
                                {candidates.map(candidate => {
                                    const unavailable = candidate.membership === "join"
                                        || candidate.membership === "invite"
                                        || candidate.membership === "ban";
                                    return (
                                        <div className="vc-matrix-invite-candidate" role="listitem" key={candidate.userId}>
                                            <CandidateIdentity candidate={candidate} />
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                disabled={busy || currentFull || unavailable || !context?.canInvite}
                                                onClick={() => void invite(candidate)}
                                            >
                                                {candidate.membership === "join"
                                                    ? "Joined"
                                                    : candidate.membership === "invite"
                                                        ? "Invited"
                                                        : candidate.membership === "ban" ? "Unavailable" : inviting ? "Inviting..." : "Invite"}
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
                {phase === "pending" && (
                    <div className="vc-matrix-invite-notice" role="status">
                        {pendingUserId && <>Unconfirmed account: <code dir="ltr">{visibleUserId(pendingUserId)}</code>. </>}
                        {overrideArmed
                            ? "Clearing this warning does not cancel an invite that may already have landed or that the recipient may already have declined. The provider checks once more, then only clears the local receipt; it never retries the invite. Inspect the participant list first."
                            : "Do not send this invite again while its outcome is unconfirmed. Close for now or check status later."}
                    </div>
                )}
                {phase === "result" && result && (
                    <div className="vc-matrix-invite-notice" role="status">
                        The provider {result.delivery === "accepted"
                            ? "accepted an invite request for "
                            : result.observedMembership === "join" ? "found already joined: " : "found an existing invite for "}
                        <code dir="ltr">{visibleUserId(result.userId)}</code>.
                        {syncing && " The participant list is still syncing into Discord."}
                        {!syncing && !projectionReady && " Discord did not display a current invite or membership; the person may already have declined or left."}
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openMatrixGroupInvite(
    channelId: string,
    expectedContext = getMatrixGroupInviteContext(channelId)
) {
    const context = expectedContext && currentBoundContext(expectedContext);
    if (!context) return false;
    if (activeGroupInviteModalKey) {
        showToast("Add People is already open.", Toasts.Type.MESSAGE);
        return true;
    }
    let modalKey = "";
    modalKey = openModal(
        modalProps => <MatrixGroupInviteModal expected={context} modalProps={modalProps} />,
        {
            onCloseCallback: () => {
                unregisterMatrixManagementModal(modalKey);
                if (activeGroupInviteModalKey === modalKey) activeGroupInviteModalKey = undefined;
            },
        }
    );
    activeGroupInviteModalKey = modalKey;
    registerMatrixManagementModal(modalKey);
    return true;
}

export function openMatrixGroupInviteForRoom(roomId: string) {
    const context = getMatrixGroupInviteContextForRoom(roomId);
    return context ? openMatrixGroupInvite(context.channelId, context) : false;
}
