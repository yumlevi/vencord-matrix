/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderModalProps } from "@vencord/discord-types";
import { Button, Modal, openModal, showToast, TextInput, Toasts, useRef, useState } from "@webpack/common";

import {
    getMatrixSearchContext,
    openMatrixSearchResult,
    registerMatrixSearchModal,
    searchMatrixMessages,
    unregisterMatrixSearchModal,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";
import type {
    MatrixMessageSearchCoverage,
    MatrixMessageSearchResultDTO,
} from "./types";

function resultTimestamp(timestamp: number) {
    if (!Number.isFinite(timestamp)) return "Unknown time";
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return "Unknown time";
    }
}

function coverageText(coverage: MatrixMessageSearchCoverage | undefined, limited: boolean, includesEncrypted: boolean) {
    if (!coverage) {
        return includesEncrypted
            ? "Encrypted rooms are searched from locally decrypted history. Results may be incomplete."
            : "Search stays on your Matrix homeserver and in locally decrypted history.";
    }
    const source = coverage === "local"
        ? "Searched locally decrypted history."
        : coverage === "mixed"
            ? "Combined homeserver and locally decrypted results."
            : "Searched on your Matrix homeserver.";
    return limited ? `${source} More matches or encrypted history may not be available.` : source;
}

function MatrixSearchModal({ channelId, modalProps }: { channelId: string; modalProps: RenderModalProps; }) {
    const context = getMatrixSearchContext(channelId);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<MatrixMessageSearchResultDTO[]>([]);
    const [cursor, setCursor] = useState<string>();
    const [coverage, setCoverage] = useState<MatrixMessageSearchCoverage>();
    const [limited, setLimited] = useState(false);
    const [searched, setSearched] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const requestGeneration = useRef(0);

    if (!context) {
        return <Modal {...modalProps} title="Search unavailable">This chat is no longer available.</Modal>;
    }

    async function runSearch(nextCursor?: string) {
        const cleanQuery = query.trim();
        if (!cleanQuery || loading) return;
        const generation = ++requestGeneration.current;
        setLoading(true);
        setError(undefined);
        try {
            let append = Boolean(nextCursor);
            let response;
            try {
                response = await searchMatrixMessages(channelId, cleanQuery, nextCursor);
            } catch (searchError) {
                if (generation !== requestGeneration.current) return;
                if (!nextCursor || matrixErrorCode(searchError) !== "MATRIX_STALE_CURSOR") throw searchError;
                append = false;
                try {
                    response = await searchMatrixMessages(channelId, cleanQuery);
                } catch {
                    throw new Error("Those search results expired and could not be refreshed. Try searching again.");
                }
            }
            if (generation !== requestGeneration.current) return;
            setResults(current => {
                const merged = new Map((append ? current : []).map(result => [
                    `${result.roomId}\0${result.message.eventId}`,
                    result,
                ]));
                for (const result of response.results) {
                    merged.set(`${result.roomId}\0${result.message.eventId}`, result);
                }
                return [...merged.values()];
            });
            setCursor(response.cursor);
            setCoverage(response.coverage);
            setLimited(response.limited);
            setSearched(true);
        } catch (searchError) {
            if (generation !== requestGeneration.current) return;
            setError(searchError instanceof Error ? searchError.message : "Search failed.");
        } finally {
            if (generation === requestGeneration.current) setLoading(false);
        }
    }

    function jumpToResult(result: MatrixMessageSearchResultDTO) {
        if (!openMatrixSearchResult(result)) {
            showToast("That message is no longer available.", Toasts.Type.FAILURE);
            return;
        }
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={`Search ${context.label}`}
            subtitle={coverageText(coverage, limited, context.includesEncryptedRooms)}
            actions={[
                {
                    text: "Close",
                    variant: "secondary",
                    onClick: modalProps.onClose,
                },
                {
                    text: loading ? "Searching..." : "Search",
                    variant: "primary",
                    disabled: loading || !query.trim(),
                    onClick: () => void runSearch(),
                },
            ]}
        >
            <div className="vc-matrix-search">
                <label className="vc-matrix-search-label" htmlFor="vc-matrix-search-input">Search messages</label>
                <TextInput
                    id="vc-matrix-search-input"
                    autoFocus
                    value={query}
                    placeholder="Search messages"
                    onChange={value => {
                        requestGeneration.current++;
                        setQuery(value.slice(0, 256));
                        setResults([]);
                        setCursor(undefined);
                        setCoverage(undefined);
                        setLimited(false);
                        setSearched(false);
                        setLoading(false);
                        setError(undefined);
                    }}
                    onKeyDown={event => {
                        if (event.key === "Enter") void runSearch();
                    }}
                />

                <div className="vc-matrix-search-status" role="status" aria-live="polite">
                    {error ?? (loading ? "Searching..." : searched ? `${results.length} result${results.length === 1 ? "" : "s"}` : "")}
                </div>

                <div className="vc-matrix-search-results" role="list" aria-label="Message search results">
                    {!loading && searched && !results.length && !error && (
                        <div className="vc-matrix-search-empty">No messages matched your search.</div>
                    )}
                    {results.map(result => (
                        <button
                            type="button"
                            role="listitem"
                            className="vc-matrix-search-result"
                            key={`${result.roomId}:${result.message.eventId}`}
                            aria-label={`Jump to message from ${result.message.senderName ?? result.message.senderId}`}
                            onClick={() => jumpToResult(result)}
                        >
                            <span className="vc-matrix-search-result-heading">
                                <strong>{result.message.senderName ?? result.message.senderId}</strong>
                                <span>{result.roomName}</span>
                                <time>{resultTimestamp(result.message.timestamp)}</time>
                            </span>
                            <span className="vc-matrix-search-result-body">
                                {result.message.body || result.message.attachments?.[0]?.name || "Attachment"}
                            </span>
                        </button>
                    ))}
                </div>

                {cursor && (
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={loading}
                        onClick={() => void runSearch(cursor)}
                    >
                        Load more
                    </Button>
                )}
            </div>
        </Modal>
    );
}

export function openMatrixSearch(channelId: string) {
    if (!getMatrixSearchContext(channelId)) return false;
    let modalKey = "";
    modalKey = openModal(
        modalProps => <MatrixSearchModal channelId={channelId} modalProps={modalProps} />,
        { onCloseCallback: () => unregisterMatrixSearchModal(modalKey) }
    );
    registerMatrixSearchModal(modalKey);
    return true;
}
