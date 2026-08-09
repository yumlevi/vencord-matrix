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
    acknowledgeMatrixGroupChatCreate,
    createMatrixGroupChat,
    getCurrentMatrixGroupChatCreateContext,
    getMatrixGroupChatCreateContext,
    type MatrixGroupChatCandidate,
    type MatrixGroupChatCreateContext,
    type MatrixGroupChatCreateResult,
    openMatrixGroupChat,
    reconcileMatrixGroupChatCreate,
    registerMatrixManagementModal,
    searchMatrixGroupChatCandidates,
    subscribeMatrixSpaceProjection,
    unregisterMatrixManagementModal,
    waitForMatrixGroupChatProjection,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";

const SEARCH_LIMIT = 25;
const MAX_RECIPIENTS = 9;
const MIN_RECIPIENTS = 2;
const PROVENANCE_REFRESH_MS = 4 * 60_000 + 45_000;
const BIDI_FORMATTING_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_VISIBLE_TEXT_PATTERN = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
let activeGroupChatCreateModalKey: string | undefined;

interface SelectedCandidate extends MatrixGroupChatCandidate {
    provenanceAt: number;
}

type SearchCandidate = SelectedCandidate;

type Phase = "checking" | "pick" | "review" | "unconfirmed" | "result";

function sameBinding(
    left: MatrixGroupChatCreateContext,
    right: MatrixGroupChatCreateContext | undefined
) {
    return Boolean(right)
        && left.expectedAccountId === right!.expectedAccountId
        && left.generation === right!.generation;
}

function currentBoundContext(expected: MatrixGroupChatCreateContext) {
    const current = getCurrentMatrixGroupChatCreateContext(expected);
    return sameBinding(expected, current) ? current : undefined;
}

function useProjectionRevision() {
    const [, setRevision] = useState(0);
    useEffect(() => subscribeMatrixSpaceProjection(() => setRevision(value => value + 1)), []);
}

function visibleProvider(value: string) {
    return value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").slice(0, 255) || "your account provider";
}

function visibleDisplayName(candidate: MatrixGroupChatCandidate) {
    return candidate.displayName.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").trim() || "Account";
}

function visibleUserId(value: string) {
    return value.replace(BIDI_FORMATTING_CONTROL_PATTERN, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function initial(displayName: string) {
    return Array.from(displayName.trim())[0]?.toLocaleUpperCase() || "?";
}

function cleanName(value: string) {
    return value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").trim().slice(0, 100);
}

function cleanQuery(value: string) {
    return value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").slice(0, 256);
}

function publicSearchError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_GROUP_CHAT_SEARCH_BUSY") {
        return "Another account search is still running. Wait for it to finish, then search again.";
    }
    if (code === "MATRIX_USER_DIRECTORY_RATE_LIMITED" || code === "M_LIMIT_EXCEEDED") {
        return "Your account provider is receiving too many searches. Wait a moment and try again.";
    }
    return "Your account provider could not search its user directory. Try again.";
}

function publicCreateError(error: unknown) {
    const code = matrixErrorCode(error);
    if (code === "MATRIX_GROUP_CHAT_CANDIDATE_STALE") {
        return "Those search results expired. Search again and reselect people. No group chat was created.";
    }
    if (code === "MATRIX_CREATE_GROUP_CHAT_REJECTED") {
        return "The account provider rejected this group chat. No group chat was created.";
    }
    if (code === "MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED") {
        return "The account provider cannot create a compatible group chat. No group chat was created.";
    }
    if (code === "MATRIX_REMOTE_USER_REJECTED" || code === "MATRIX_GROUP_CHAT_SELF"
        || code === "MATRIX_INVALID_ARGUMENT") {
        return "One or more selected accounts are not eligible for this group. Search again and reselect people. No group chat was created.";
    }
    if (code === "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS"
        || code === "MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED") {
        return "The provider could not confirm whether the group chat was created. Check its status before doing anything else.";
    }
    if (code === "MATRIX_CREATE_GROUP_CHAT_IN_PROGRESS"
        || code === "MATRIX_CREATE_GROUP_CHAT_RECONCILE_IN_PROGRESS") {
        return "Another window is already handling group chat creation. Check its status and your chat list before any new attempt.";
    }
    if (code === "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT"
        || code === "MATRIX_CREATE_GROUP_CHAT_STATE_WRITE_FAILED") {
        return "Creation safety state could not be verified. Inspect your chat list and check status before any new attempt.";
    }
    return "The account provider could not create this group chat. Try again.";
}

function invitationLabel(status: MatrixGroupChatCreateResult["invitations"][number]["status"]) {
    switch (status) {
        case "invited": return "Invitation requested";
        case "joined": return "Joined";
        case "rejected": return "Invitation rejected";
        case "ambiguous": return "Invitation unconfirmed";
    }
}

function resultSummary(result: MatrixGroupChatCreateResult) {
    const counts = new Map<string, number>();
    for (const invitation of result.invitations) {
        const label = invitationLabel(invitation.status).toLocaleLowerCase();
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => `${count} ${label}`).join(", ");
}

function CandidateIdentity({ candidate }: { candidate: MatrixGroupChatCandidate; }) {
    const displayName = visibleDisplayName(candidate);
    return (
        <>
            <div className="vc-matrix-group-chat-avatar" aria-hidden="true">{initial(displayName)}</div>
            <div className="vc-matrix-group-chat-identity">
                <strong dir="auto">{displayName}</strong>
                <code dir="ltr">{visibleUserId(candidate.userId)}</code>
            </div>
        </>
    );
}

function MatrixGroupChatCreateModal({
    expected,
    modalProps,
}: {
    expected: MatrixGroupChatCreateContext;
    modalProps: RenderModalProps;
}) {
    useProjectionRevision();
    const context = currentBoundContext(expected);
    const mounted = useRef(false);
    const searchSerial = useRef(0);
    const mutationSerial = useRef(0);
    const createLock = useRef(false);
    const ackLock = useRef(false);
    const ambiguityLock = useRef(false);
    const [phase, setPhase] = useState<Phase>("checking");
    const [name, setName] = useState("");
    const [query, setQuery] = useState("");
    const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
    const [selected, setSelected] = useState<Map<string, SelectedCandidate>>(() => new Map());
    const [searching, setSearching] = useState(false);
    const [checking, setChecking] = useState(true);
    const [creating, setCreating] = useState(false);
    const [limited, setLimited] = useState(false);
    const [searched, setSearched] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<MatrixGroupChatCreateResult>();
    const [projectionReady, setProjectionReady] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [acknowledging, setAcknowledging] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            searchSerial.current++;
            mutationSerial.current++;
        };
    }, []);

    useEffect(() => {
        if (context) return;
        searchSerial.current++;
        mutationSerial.current++;
        setCandidates([]);
        setSelected(new Map());
        setSearching(false);
        setChecking(false);
        setCreating(false);
        setError("The signed-in account changed. Close this window and try again.");
    }, [context?.expectedAccountId, context?.generation]);

    useEffect(() => {
        if (!selected.size) return;
        const earliestExpiry = Math.min(...[...selected.values()]
            .map(candidate => candidate.provenanceAt + PROVENANCE_REFRESH_MS));
        const timer = setTimeout(() => {
            const now = Date.now();
            setSelected(current => {
                const next = new Map([...current].filter(([, candidate]) =>
                    now - candidate.provenanceAt < PROVENANCE_REFRESH_MS));
                if (next.size !== current.size) {
                    setPhase("pick");
                    setError("Some selected search results expired. Search again and reselect those people.");
                }
                return next;
            });
        }, Math.max(0, earliestExpiry - Date.now()));
        return () => clearTimeout(timer);
    }, [selected]);

    useEffect(() => {
        if (!candidates.length) return;
        const earliestExpiry = Math.min(...candidates
            .map(candidate => candidate.provenanceAt + PROVENANCE_REFRESH_MS));
        const timer = setTimeout(() => {
            const now = Date.now();
            setCandidates(current => {
                const next = current.filter(candidate =>
                    now - candidate.provenanceAt < PROVENANCE_REFRESH_MS);
                if (next.length !== current.length) {
                    setError("Search results expired. Search again before selecting people.");
                }
                return next;
            });
        }, Math.max(0, earliestExpiry - Date.now()));
        return () => clearTimeout(timer);
    }, [candidates]);

    function operationCurrent(serial: number) {
        return mounted.current
            && mutationSerial.current === serial
            && Boolean(currentBoundContext(expected));
    }

    function beginProjectionWait(nextResult: MatrixGroupChatCreateResult, serial: number) {
        setResult(nextResult);
        setAcknowledged(false);
        setProjectionReady(false);
        setSyncing(true);
        setPhase("result");
        setError("");
        void waitForMatrixGroupChatProjection(expected, nextResult.roomId).then(
            channelId => {
                if (!operationCurrent(serial)) return;
                setProjectionReady(Boolean(channelId));
                setSyncing(false);
            },
            () => {
                if (!operationCurrent(serial)) return;
                setProjectionReady(false);
                setSyncing(false);
            }
        );
    }

    async function reconcile(serial: number, afterAmbiguity: boolean) {
        setChecking(true);
        setError("");
        try {
            const reconciled = await reconcileMatrixGroupChatCreate(expected);
            if (!operationCurrent(serial)) return;
            if (reconciled.status === "resolved") {
                ambiguityLock.current = false;
                beginProjectionWait(reconciled.result, serial);
                return;
            }
            if (reconciled.status === "pending" || afterAmbiguity || ambiguityLock.current) {
                ambiguityLock.current = true;
                setPhase("unconfirmed");
                setError("Creation is still unconfirmed. Check again later and inspect your chat list before any new attempt.");
                return;
            }
            setPhase("pick");
        } catch {
            if (!operationCurrent(serial)) return;
            if (afterAmbiguity) ambiguityLock.current = true;
            setPhase("unconfirmed");
            setError(afterAmbiguity
                ? "Creation is unconfirmed and its status could not be checked. Inspect your chat list and check again later."
                : "The provider could not verify whether an earlier group chat creation is pending. Check again before creating one.");
        } finally {
            if (operationCurrent(serial)) setChecking(false);
        }
    }

    useEffect(() => {
        const serial = ++mutationSerial.current;
        void reconcile(serial, false);
    }, [expected.expectedAccountId, expected.generation]);

    function submitSearch() {
        const before = currentBoundContext(expected);
        const submittedQuery = cleanQuery(query).trim();
        if (!before || searching || creating || !submittedQuery) {
            if (!submittedQuery) setError("Enter a name or full account ID to search.");
            return;
        }
        const serial = ++searchSerial.current;
        setSearching(true);
        setSearched(true);
        setError("");
        void searchMatrixGroupChatCandidates(before, submittedQuery, SEARCH_LIMIT).then(response => {
            if (!mounted.current || searchSerial.current !== serial || !currentBoundContext(expected)) return;
            const provenanceAt = Date.now();
            const nextCandidates = response.candidates.map(candidate => ({ ...candidate, provenanceAt }));
            setCandidates(nextCandidates);
            setLimited(response.limited || response.directoryLimited);
            setSelected(current => {
                const next = new Map(current);
                for (const candidate of nextCandidates) {
                    if (next.has(candidate.userId)) next.set(candidate.userId, candidate);
                }
                return next;
            });
        }).catch(caught => {
            if (!mounted.current || searchSerial.current !== serial || !currentBoundContext(expected)) return;
            setCandidates([]);
            setLimited(false);
            setError(publicSearchError(caught));
        }).finally(() => {
            if (mounted.current && searchSerial.current === serial) setSearching(false);
        });
    }

    function toggleCandidate(candidate: SearchCandidate) {
        if (!currentBoundContext(expected) || searching || creating) return;
        setSelected(current => {
            const next = new Map(current);
            if (next.has(candidate.userId)) {
                next.delete(candidate.userId);
            } else if (next.size < MAX_RECIPIENTS) {
                next.set(candidate.userId, candidate);
            } else {
                setError(`A group chat can include at most ${MAX_RECIPIENTS} other people.`);
            }
            return next;
        });
    }

    function review() {
        if (!currentBoundContext(expected)) return;
        const nextName = cleanName(name);
        if (!nextName) {
            setError("Enter a group chat name.");
            return;
        }
        if (selected.size < MIN_RECIPIENTS) {
            setError("Select at least two people.");
            return;
        }
        const now = Date.now();
        if ([...selected.values()].some(candidate => now - candidate.provenanceAt >= PROVENANCE_REFRESH_MS)) {
            setPhase("pick");
            setError("Some selected search results expired. Search again and reselect those people.");
            return;
        }
        setName(nextName);
        setError("");
        setPhase("review");
    }

    async function create() {
        const before = currentBoundContext(expected);
        if (!before || createLock.current || ambiguityLock.current || selected.size < MIN_RECIPIENTS) return;
        const now = Date.now();
        if ([...selected.values()].some(candidate => now - candidate.provenanceAt >= PROVENANCE_REFRESH_MS)) {
            setPhase("pick");
            setError("Those search results expired. Search again and reselect people.");
            return;
        }
        const exactName = cleanName(name);
        const exactUserIds = Object.freeze([...selected.keys()]);
        const serial = ++mutationSerial.current;
        let shouldReconcile = false;
        createLock.current = true;
        setCreating(true);
        setError("");
        try {
            const nextResult = await createMatrixGroupChat(before, exactName, exactUserIds);
            if (!operationCurrent(serial)) return;
            beginProjectionWait(nextResult, serial);
        } catch (caught) {
            if (!operationCurrent(serial)) return;
            const code = matrixErrorCode(caught);
            if (code === "MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS"
                || code === "MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED"
                || code === "MATRIX_CREATE_GROUP_CHAT_IN_PROGRESS"
                || code === "MATRIX_CREATE_GROUP_CHAT_RECONCILE_IN_PROGRESS"
                || code === "MATRIX_CREATE_GROUP_CHAT_STATE_CORRUPT"
                || code === "MATRIX_CREATE_GROUP_CHAT_STATE_WRITE_FAILED") {
                ambiguityLock.current = true;
                setPhase("unconfirmed");
                setError(publicCreateError(caught));
                shouldReconcile = true;
            } else if (code === "MATRIX_GROUP_CHAT_CANDIDATE_STALE"
                || code === "MATRIX_REMOTE_USER_REJECTED"
                || code === "MATRIX_GROUP_CHAT_SELF"
                || code === "MATRIX_INVALID_ARGUMENT") {
                setSelected(new Map());
                setCandidates([]);
                setSearched(false);
                setPhase("pick");
                setError(publicCreateError(caught));
            } else {
                setError(publicCreateError(caught));
            }
        } finally {
            createLock.current = false;
            if (operationCurrent(serial)) setCreating(false);
        }
        if (shouldReconcile && operationCurrent(serial)) void reconcile(serial, true);
    }

    function checkStatus() {
        if (checking || creating || !currentBoundContext(expected)) return;
        const serial = ++mutationSerial.current;
        void reconcile(serial, ambiguityLock.current);
    }

    async function acknowledgeResult(openAfter: boolean) {
        const before = currentBoundContext(expected);
        if (!before || !result || !projectionReady || syncing || ackLock.current) return;
        if (acknowledged) {
            if (!openAfter || openMatrixGroupChat(result.roomId)) modalProps.onClose();
            return;
        }
        const serial = ++mutationSerial.current;
        ackLock.current = true;
        setAcknowledging(true);
        setError("");
        try {
            await acknowledgeMatrixGroupChatCreate(before, result.roomId);
            if (!operationCurrent(serial)) return;
            setAcknowledged(true);
            if (!openAfter) {
                modalProps.onClose();
                return;
            }
            if (openMatrixGroupChat(result.roomId)) {
                modalProps.onClose();
                return;
            }
            showToast("Group chat created and confirmed. Refresh Chats to open it.", Toasts.Type.MESSAGE);
            modalProps.onClose();
        } catch {
            if (!operationCurrent(serial)) return;
            setError("The group chat was created, but its local creation receipt could not be confirmed as cleared. Keep this result open and try Done or Open Group Chat again. Do not create another group chat.");
        } finally {
            ackLock.current = false;
            if (operationCurrent(serial)) setAcknowledging(false);
        }
    }

    const provider = visibleProvider(expected.providerLabel);
    const selectedCandidates = [...selected.values()];
    const contextError = context ? "" : "The signed-in account changed. Close this window and try again.";
    const status = contextError || error;
    const resultReceiptLocked = phase === "result" && Boolean(result) && !acknowledged;
    const close = () => {
        if (createLock.current || ackLock.current || creating || checking || acknowledging || resultReceiptLocked) return;
        modalProps.onClose();
    };
    const closeForNow = () => {
        if (!ackLock.current) modalProps.onClose();
    };
    const actions = phase === "pick" ? [{
        text: "Cancel",
        variant: "secondary" as const,
        disabled: creating || checking,
        onClick: close,
    }, {
        text: "Review",
        variant: "primary" as const,
        disabled: !context || searching || creating || !cleanName(name) || selected.size < MIN_RECIPIENTS,
        onClick: review,
    }] : phase === "review" ? [{
        text: "Back",
        variant: "secondary" as const,
        disabled: creating || checking,
        onClick: () => setPhase("pick"),
    }, {
        text: creating ? "Creating..." : "Create Group Chat",
        variant: "primary" as const,
        disabled: !context || creating || ambiguityLock.current,
        onClick: () => void create(),
    }] : phase === "unconfirmed" ? [{
        text: "Close",
        variant: "secondary" as const,
        disabled: creating || checking,
        onClick: close,
    }, {
        text: checking ? "Checking..." : "Check Status",
        variant: "primary" as const,
        disabled: !context || checking || creating,
        onClick: checkStatus,
    }] : phase === "result" ? [{
        text: "Close for now",
        variant: "secondary" as const,
        disabled: acknowledging,
        onClick: closeForNow,
    }, {
        text: acknowledging ? "Confirming..." : "Done",
        variant: "secondary" as const,
        disabled: !context || !projectionReady || syncing || acknowledging,
        onClick: () => void acknowledgeResult(false),
    }, {
        text: syncing ? "Syncing..." : acknowledging ? "Confirming..." : "Open Group Chat",
        variant: "primary" as const,
        disabled: !context || !projectionReady || syncing || acknowledging,
        onClick: () => void acknowledgeResult(true),
    }] : [{
        text: "Close",
        variant: "secondary" as const,
        disabled: creating || checking,
        onClick: close,
    }];

    return (
        <Modal
            {...modalProps}
            onClose={close}
            title="Create Group Chat"
            subtitle={`Private group chats require accounts in the ${provider} account domain.`}
            actions={actions}
        >
            <div className="vc-matrix-group-chat-create">
                {status && <div className="vc-matrix-error" role="alert">{status}</div>}
                {phase === "checking" && !status && (
                    <div className="vc-matrix-group-chat-empty" role="status">Checking for an unfinished group chat...</div>
                )}
                {(phase === "pick" || phase === "review") && (
                    <label>
                        <strong>Group name</strong>
                        <TextInput
                            autoFocus={phase === "pick"}
                            disabled={!context || searching || creating || phase === "review"}
                            value={name}
                            placeholder="New group"
                            maxLength={100}
                            onChange={value => {
                                setName(value.replace(UNSAFE_VISIBLE_TEXT_PATTERN, "").slice(0, 100));
                                setError("");
                            }}
                        />
                    </label>
                )}
                {phase === "pick" && (
                    <>
                        <div className="vc-matrix-group-chat-search">
                            <TextInput
                                disabled={!context || searching || creating}
                                value={query}
                                placeholder="Search by name or full account ID"
                                maxLength={256}
                                onChange={value => {
                                    setQuery(cleanQuery(value));
                                    setError("");
                                }}
                                onKeyDown={event => {
                                    if (event.key === "Enter") submitSearch();
                                }}
                            />
                            <Button disabled={!context || searching || creating || !cleanQuery(query).trim()} onClick={submitSearch}>
                                {searching ? "Searching..." : "Search"}
                            </Button>
                        </div>
                        <p className="vc-matrix-group-chat-scope">
                            Results come from your configured account provider&apos;s directory and may be incomplete.
                            That provider can observe searches. Search text and results are displayed inside Discord,
                            where Discord and installed client plugins can read them.
                        </p>
                        <p className="vc-matrix-group-chat-scope">
                            This private, encrypted group does not connect to other account domains. Everyone&apos;s full account ID
                            must use the {provider} domain. Search results expire after five minutes.
                        </p>
                        <p className="vc-matrix-group-chat-scope">
                            Message contents and media are end-to-end encrypted. The configured account provider can still see the group name,
                            participant accounts, membership, and traffic timing and size. Participants can see one another&apos;s full account IDs.
                        </p>
                        <section aria-labelledby="vc-matrix-group-chat-selected-heading">
                            <div className="vc-matrix-group-chat-section-heading" id="vc-matrix-group-chat-selected-heading">
                                Selected people ({selected.size} of {MAX_RECIPIENTS})
                            </div>
                            {selectedCandidates.length ? (
                                <div className="vc-matrix-group-chat-list" role="list" aria-label="Selected people">
                                    {selectedCandidates.map(candidate => (
                                        <div className="vc-matrix-group-chat-candidate" role="listitem" key={candidate.userId}>
                                            <CandidateIdentity candidate={candidate} />
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                disabled={!context || searching || creating}
                                                onClick={() => toggleCandidate(candidate)}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="vc-matrix-group-chat-empty">Select at least two people.</div>
                            )}
                        </section>
                        {limited && !searching && (
                            <div className="vc-matrix-group-chat-notice" role="status">
                                More accounts may match. Refine your search to narrow the results.
                            </div>
                        )}
                        {searching && <div className="vc-matrix-group-chat-empty" role="status">Searching...</div>}
                        {!searching && searched && !candidates.length && !status && (
                            <div className="vc-matrix-group-chat-empty" role="status">No matching accounts were found.</div>
                        )}
                        {!searching && candidates.length > 0 && (
                            <div className="vc-matrix-group-chat-list" role="list" aria-label="Account search results">
                                {candidates.map(candidate => {
                                    const isSelected = selected.has(candidate.userId);
                                    return (
                                        <div className="vc-matrix-group-chat-candidate" role="listitem" key={candidate.userId}>
                                            <CandidateIdentity candidate={candidate} />
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                disabled={!context || creating || !isSelected && selected.size >= MAX_RECIPIENTS}
                                                onClick={() => toggleCandidate(candidate)}
                                            >
                                                {isSelected ? "Remove" : "Add"}
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
                {phase === "review" && (
                    <>
                        <div className="vc-matrix-group-chat-notice" role="status">
                            Review the exact people below. Creating the group requests an invitation for each account;
                            it does not mean they have joined or received it.
                        </div>
                        <div className="vc-matrix-group-chat-list" role="list" aria-label="People to invite">
                            {selectedCandidates.map(candidate => (
                                <div className="vc-matrix-group-chat-candidate" role="listitem" key={candidate.userId}>
                                    <CandidateIdentity candidate={candidate} />
                                    <span>Will be invited</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}
                {phase === "unconfirmed" && (
                    <div className="vc-matrix-group-chat-notice" role="status">
                        Do not submit another group chat while this result is unconfirmed. Checking status never creates a new group.
                    </div>
                )}
                {phase === "result" && result && (
                    <>
                        <div className="vc-matrix-group-chat-notice" role="status">
                            Group chat created. {resultSummary(result)}.
                            {!result.complete && " Some invitations were rejected or could not be confirmed."}
                            {syncing && " The new chat is still syncing into Discord."}
                            {!syncing && !projectionReady && " The new chat has not appeared in Discord yet. Close for now keeps its recovery receipt; reopen Create Group Chat or refresh Chats later."}
                        </div>
                        <div className="vc-matrix-group-chat-list" role="list" aria-label="Invitation results">
                            {result.invitations.map(invitation => {
                                const candidate = selected.get(invitation.userId) ?? {
                                    userId: invitation.userId,
                                    displayName: "Account",
                                };
                                return (
                                    <div className="vc-matrix-group-chat-candidate" role="listitem" key={invitation.userId}>
                                        <CandidateIdentity candidate={candidate} />
                                        <span>{invitationLabel(invitation.status)}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openMatrixGroupChatCreate(
    expectedContext = getMatrixGroupChatCreateContext()
) {
    const context = expectedContext && currentBoundContext(expectedContext);
    if (!context) return false;
    if (activeGroupChatCreateModalKey) {
        showToast("Create Group Chat is already open.", Toasts.Type.MESSAGE);
        return true;
    }
    let modalKey = "";
    modalKey = openModal(
        modalProps => <MatrixGroupChatCreateModal expected={context} modalProps={modalProps} />,
        {
            onCloseCallback: () => {
                unregisterMatrixManagementModal(modalKey);
                if (activeGroupChatCreateModalKey === modalKey) activeGroupChatCreateModalKey = undefined;
            },
        }
    );
    activeGroupChatCreateModalKey = modalKey;
    registerMatrixManagementModal(modalKey);
    return true;
}
