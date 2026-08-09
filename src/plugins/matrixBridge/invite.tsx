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
    TextInput,
    useEffect,
    useRef,
    useState,
} from "@webpack/common";

import {
    getCurrentMatrixInviteContext,
    getMatrixInviteContext,
    inviteMatrixUserToSpace,
    type MatrixInviteCandidate,
    type MatrixInviteContext,
    registerMatrixManagementModal,
    searchMatrixSpaceInviteCandidates,
    subscribeMatrixSpaceProjection,
    unregisterMatrixManagementModal,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";

const SEARCH_LIMIT = 25;
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_DISPLAY_NAME_PATTERN = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

type RowState = "invited" | "joined" | "ambiguous";

function sameBinding(left: MatrixInviteContext, right: MatrixInviteContext | undefined) {
    return Boolean(right)
        && left.guildId === right!.guildId
        && left.spaceId === right!.spaceId
        && left.expectedAccountId === right!.expectedAccountId
        && left.generation === right!.generation;
}

function currentBoundContext(expected: MatrixInviteContext) {
    const current = getCurrentMatrixInviteContext(expected);
    return sameBinding(expected, current) ? current : undefined;
}

function useProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
}

function providerLabel(accountId: string) {
    const separator = accountId.indexOf(":");
    return (separator === -1 ? "this homeserver" : accountId.slice(separator + 1))
        .replace(BIDI_FORMATTING_CONTROL_PATTERN, "")
        .slice(0, 255) || "this homeserver";
}

function publicSearchError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_SPACE_INVITE_FORBIDDEN") {
        return "You no longer have permission to invite people to this server.";
    }
    if (code === "MATRIX_USER_DIRECTORY_RATE_LIMITED" || code === "M_LIMIT_EXCEEDED") {
        return "Your account provider is receiving too many searches. Wait a moment and try again.";
    }
    return "Your account provider could not search its user directory. Try again.";
}

function publicInviteError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_SPACE_INVITE_FORBIDDEN") {
        return "You no longer have permission to invite people to this server.";
    }
    if (code === "MATRIX_SPACE_INVITE_REJECTED") {
        return "The account provider rejected this invite.";
    }
    if (code === "MATRIX_SPACE_INVITE_AMBIGUOUS") {
        return "The server could not confirm whether this invite was sent. Refresh later before retrying.";
    }
    return "The server could not send this invite. Try again.";
}

function permissionMessage(context: MatrixInviteContext) {
    const { current, required } = context.permission;
    if (current === "unverifiable" || required === "unverifiable") {
        return "The server could not verify your invite permission.";
    }
    const currentLabel = current === "infinite" ? "\u221e" : current;
    return `Your server permission level is ${currentLabel}; inviting requires ${required}.`;
}

function visibleUserId(value: string) {
    return value.replace(BIDI_FORMATTING_CONTROL_PATTERN, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function visibleDisplayName(candidate: MatrixInviteCandidate) {
    return candidate.displayName
        .replace(UNSAFE_DISPLAY_NAME_PATTERN, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 100) || "Account";
}

function initial(displayName: string) {
    return Array.from(displayName)[0]?.toLocaleUpperCase() || "?";
}

function MatrixInvitePeopleModal({
    expected,
    modalProps,
}: {
    expected: MatrixInviteContext;
    modalProps: RenderModalProps;
}) {
    useProjectionRevision();
    const [query, setQuery] = useState("");
    const [submittedSearch, setSubmittedSearch] = useState({ query: "", serial: 0 });
    const [candidates, setCandidates] = useState<MatrixInviteCandidate[]>([]);
    const [loading, setLoading] = useState(true);
    const [queryRequired, setQueryRequired] = useState(false);
    const [limited, setLimited] = useState(false);
    const [error, setError] = useState("");
    const [activeUserId, setActiveUserId] = useState<string>();
    const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
    const searchOperation = useRef(0);
    const mounted = useRef(true);
    const context = currentBoundContext(expected);

    useEffect(() => () => {
        mounted.current = false;
        searchOperation.current++;
    }, []);

    useEffect(() => {
        const operation = ++searchOperation.current;
        const before = currentBoundContext(expected);
        if (!before) {
            setLoading(false);
            setError("This server or signed-in account changed. Close this window and try again.");
            return;
        }
        if (!before.canInvite) {
            setLoading(false);
            setError(permissionMessage(before));
            return;
        }
        setLoading(true);
        setCandidates([]);
        setError("");
        void searchMatrixSpaceInviteCandidates(before, submittedSearch.query, SEARCH_LIMIT).then(result => {
            if (!mounted.current || operation !== searchOperation.current || !currentBoundContext(expected)) return;
            setCandidates(result.candidates);
            setLimited(result.limited);
            setQueryRequired(result.queryRequired);
        }, caught => {
            if (!mounted.current || operation !== searchOperation.current) return;
            setCandidates([]);
            setLimited(false);
            setQueryRequired(false);
            setError(currentBoundContext(expected)
                ? publicSearchError(caught)
                : "This server or signed-in account changed. Close this window and try again.");
        }).finally(() => {
            if (mounted.current && operation === searchOperation.current) setLoading(false);
        });
        return () => {
            if (operation === searchOperation.current) searchOperation.current++;
        };
    }, [
        expected.expectedAccountId,
        expected.generation,
        expected.guildId,
        expected.spaceId,
        submittedSearch.query,
        submittedSearch.serial,
    ]);

    function submitSearch() {
        if (loading || contextError) return;
        setSubmittedSearch(previous => ({ query: query.trim(), serial: previous.serial + 1 }));
    }

    async function invite(candidate: MatrixInviteCandidate) {
        if (activeUserId || candidate.membership === "join" || candidate.membership === "invite") return;
        const before = currentBoundContext(expected);
        if (!before?.canInvite) {
            setError(before ? permissionMessage(before) : "This server or signed-in account changed. Close this window and try again.");
            return;
        }
        setActiveUserId(candidate.userId);
        setError("");
        setRowErrors(previous => {
            const next = { ...previous };
            delete next[candidate.userId];
            return next;
        });
        try {
            const result = await inviteMatrixUserToSpace(before, candidate.userId);
            if (!mounted.current || !currentBoundContext(expected)) return;
            setRowStates(previous => ({
                ...previous,
                [candidate.userId]: result.membership === "join" ? "joined" : "invited",
            }));
        } catch (caught) {
            if (!mounted.current) return;
            if (!currentBoundContext(expected)) {
                setError("This server or signed-in account changed. Close this window and try again.");
                return;
            }
            const ambiguous = matrixErrorCode(caught) === "MATRIX_SPACE_INVITE_AMBIGUOUS";
            if (ambiguous) {
                setRowStates(previous => ({ ...previous, [candidate.userId]: "ambiguous" }));
            }
            setRowErrors(previous => ({ ...previous, [candidate.userId]: publicInviteError(caught) }));
        } finally {
            if (mounted.current) setActiveUserId(undefined);
        }
    }

    const provider = providerLabel(expected.expectedAccountId);
    const contextError = !context
        ? "This server or signed-in account changed. Close this window and try again."
        : !context.canInvite ? permissionMessage(context) : "";
    const status = contextError || error;

    return (
        <Modal
            {...modalProps}
            title={`Invite People - ${expected.label}`}
            subtitle={`Search accounts provided by ${provider}.`}
            actions={[{
                text: "Close",
                variant: "secondary",
                onClick: modalProps.onClose,
            }]}
        >
            <div className="vc-matrix-invite-people">
                <div className="vc-matrix-invite-search">
                    <TextInput
                        autoFocus
                        disabled={Boolean(contextError) || Boolean(activeUserId)}
                        value={query}
                        placeholder="Search by name or account ID"
                        maxLength={256}
                        onChange={value => {
                            setQuery(value.slice(0, 256));
                            setError("");
                        }}
                        onKeyDown={event => {
                            if (event.key === "Enter") submitSearch();
                        }}
                    />
                    <Button disabled={Boolean(contextError) || loading || Boolean(activeUserId)} onClick={submitSearch}>
                        {loading ? "Searching..." : "Search"}
                    </Button>
                </div>
                <p className="vc-matrix-invite-scope">
                    Results come from the {provider} account provider directory and may be incomplete.
                    Your provider can observe directory searches.
                    Search text and results are displayed inside Discord, where Discord and installed client plugins can read them.
                </p>
                {status && <div className="vc-matrix-error" role="alert">{status}</div>}
                {!status && limited && (
                    <div className="vc-matrix-invite-notice" role="status">
                        More accounts may match. Refine your search to narrow the results.
                    </div>
                )}
                {!status && loading && (
                    <div className="vc-matrix-invite-empty" role="status">Searching...</div>
                )}
                {!status && !loading && candidates.length === 0 && (
                    <div className="vc-matrix-invite-empty" role="status">
                        {queryRequired || !query.trim()
                            ? "Search by name or account ID to find people you can invite."
                            : "No matching accounts were found."}
                    </div>
                )}
                {!status && !loading && candidates.length > 0 && (
                    <div className="vc-matrix-invite-list" role="list" aria-label="Invite candidates">
                        {candidates.map(candidate => {
                            const displayName = visibleDisplayName(candidate);
                            const active = activeUserId === candidate.userId;
                            const localState = rowStates[candidate.userId];
                            const membershipState = candidate.membership === "join"
                                ? "joined"
                                : candidate.membership === "invite" ? "invited" : localState;
                            const unavailable = membershipState === "joined"
                                || membershipState === "invited"
                                || localState === "ambiguous";
                            const buttonLabel = active
                                ? "Inviting..."
                                : membershipState === "joined"
                                    ? "Joined"
                                    : membershipState === "invited"
                                        ? "Invited"
                                        : localState === "ambiguous" ? "Unconfirmed" : "Invite";
                            return (
                                <div className="vc-matrix-invite-candidate" role="listitem" key={candidate.userId}>
                                    <div className="vc-matrix-invite-avatar" aria-hidden="true">{initial(displayName)}</div>
                                    <div className="vc-matrix-invite-identity">
                                        <strong dir="auto">{displayName}</strong>
                                        <code dir="ltr">{visibleUserId(candidate.userId)}</code>
                                        {candidate.membership === "knock" && <span>Requested access</span>}
                                        {rowErrors[candidate.userId] && (
                                            <span className="vc-matrix-invite-row-error" role="alert">
                                                {rowErrors[candidate.userId]}
                                            </span>
                                        )}
                                    </div>
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        disabled={Boolean(activeUserId) || unavailable || !context?.canInvite}
                                        onClick={() => void invite(candidate)}
                                    >
                                        {buttonLabel}
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openMatrixInvitePeople(
    guildId: string,
    expectedContext = getMatrixInviteContext(guildId)
) {
    const context = expectedContext && currentBoundContext(expectedContext);
    if (!context?.canInvite) return false;
    let modalKey = "";
    modalKey = openModal(
        modalProps => <MatrixInvitePeopleModal expected={context} modalProps={modalProps} />,
        { onCloseCallback: () => unregisterMatrixManagementModal(modalKey) }
    );
    registerMatrixManagementModal(modalKey);
    return true;
}
