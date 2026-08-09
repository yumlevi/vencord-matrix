/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
    Native,
    openMatrixDirect,
    openMatrixRoom,
    openMatrixSpace,
    refreshSnapshot,
    restartBridge,
} from "./bridge";
import { matrixErrorCode } from "./errorCode";
import type {
    MatrixCreateSpaceResult,
    MatrixMemberDTO,
    MatrixPublicRoomDirectoryDTO,
    MatrixPublicRoomDTO,
    MatrixRoomDTO,
    MatrixSpaceHierarchyDTO,
    MatrixSpaceHierarchyRoomDTO,
} from "./types";

type AuthMode = "login" | "register";
type SettingsTab = "rooms" | "discover" | "account";
type MatrixRoomLike = MatrixRoomDTO | MatrixSpaceHierarchyRoomDTO;
type MatrixSpaceVisibility = "private" | "public";
type MatrixSpaceCreationPhase = "idle" | "creating" | "syncing" | "checking";

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
    const detail = status.error?.message ?? status.error ?? status.message;
    return [state, code, detail].filter(Boolean).join(" - ") || "Not configured";
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
                    {kind === "dm" ? "Direct message" : kind === "space" ? "Space" : "Room"}
                </span>
            </div>
            <div className="vc-matrix-room-id">{room.roomId}</div>
            {room.topic && <Paragraph>{room.topic}</Paragraph>}
        </div>
    );
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
    onCreationAmbiguous,
    onCreationFailed,
    onCreationStarted,
    onCreated,
}: {
    modalProps: RenderModalProps;
    onCreationAmbiguous(name: string): Promise<boolean>;
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
            });
        } catch (caught) {
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
            title="Create a Matrix server"
            subtitle="It will appear beside your Discord servers while its messages stay on Matrix."
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
                                label: "Private - invitation only",
                                value: "private" as const,
                            },
                            {
                                label: "Public - discoverable and open to anyone",
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
                            ? "Private servers can only be joined by people you invite."
                            : "Public servers are listed by your provider and can be joined by anyone, subject to its policies."}
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
                                ? "Start with an encrypted #general for server members; members see messages from when they join."
                                : "Start with a public #general that is not listed separately; members see messages from when they join."}
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
    const [notice, setNoticeText] = useState("");
    const [noticeTone, setNoticeTone] = useState<"success" | "warning">("success");
    const [error, setError] = useState("");
    const [roomSearch, setRoomSearch] = useState("");
    const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(() => new Set());
    const [spaceLoading, setSpaceLoading] = useState<string>();
    const [spaceCreationPending, setSpaceCreationPending] = useState(matrixSpaceCreationInFlight);
    const [spaceCreationNeedsRefresh, setSpaceCreationNeedsRefresh] = useState(matrixSpaceCreationNeedsRefresh);
    const [spaceHierarchies, setSpaceHierarchies] = useState<Record<string, MatrixSpaceHierarchyDTO>>({});
    const [spaceErrors, setSpaceErrors] = useState<Record<string, string>>({});
    const [dmSpaceId, setDmSpaceId] = useState("");
    const [dmUserId, setDmUserId] = useState("");
    const [dmMembersLoading, setDmMembersLoading] = useState(false);
    const [dmMembersError, setDmMembersError] = useState("");
    const directoryRequest = useRef(0);

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

    async function reload() {
        try {
            const [nextStatus, nextConfig] = await Promise.all([
                Native.getStatus(),
                Native.getConfig(),
            ]);
            setStatus(nextStatus);
            setConfig(nextConfig);
            if (nextConfig?.homeserver) setHomeserver(nextConfig.homeserver);
            setRooms(snapshotRooms());
            return { config: nextConfig, status: nextStatus };
        } catch (caught) {
            setError(errorMessage(caught));
        }
    }

    async function loadPublicRooms(): Promise<MatrixPublicRoomDirectoryDTO | undefined> {
        const requestId = ++directoryRequest.current;
        setDirectoryBusy(true);
        setDirectoryLoaded(false);
        setDirectoryError("");
        try {
            const directory = await Native.publicRooms();
            if (requestId !== directoryRequest.current) return;
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

    async function loadRooms(includeDirectory = false) {
        const snapshot = await refreshSnapshot();
        const nextRooms = (snapshot.rooms ?? []) as MatrixRoomDTO[];
        setRooms(nextRooms);
        const directory = includeDirectory ? await loadPublicRooms() : undefined;
        return { rooms: nextRooms, directory };
    }

    useEffect(() => {
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
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await action();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            await reload();
            setBusy(false);
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
                    setNotice(`Matrix rooms and ${directory.rooms.length} published listings refreshed.`);
                } else {
                    setWarning("Matrix rooms refreshed, but the published directory refresh failed.");
                }
            });
        } finally {
            setRefreshBusy(false);
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
            await action();
            clearSecrets();
            await restartBridge();
            await loadRooms(true);
            setTab("rooms");
            setNotice("Matrix is connected.");
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
        if (!homeserver.trim() || (!accessToken && (!username.trim() || !password))) {
            setError(accessToken
                ? "A homeserver is required."
                : "Homeserver, username, and password are required.");
            return;
        }

        await finishAuthentication(() => Native.login(accessToken
            ? {
                homeserver: normalizedHomeserver(homeserver),
                method: "access_token",
                accessToken,
            }
            : {
                homeserver: normalizedHomeserver(homeserver),
                method: "password",
                username: username.trim(),
                password,
            }));
    }

    async function registerAccount() {
        if (!homeserver.trim() || !username.trim() || !password || !registrationToken) {
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
            registrationToken,
        }));
    }

    function resetAccountUi() {
        directoryRequest.current++;
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
        setExpandedSpaces(new Set());
        setSpaceHierarchies({});
        setTab("account");
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

    async function joinPublicRoom(room: MatrixPublicRoomDTO) {
        await run(async () => {
            await Native.joinRoom(room.roomId);
            const deadline = Date.now() + 20_000;
            let opened = false;
            do {
                try {
                    const snapshot = await beforeDeadline(refreshSnapshot(), deadline);
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
            } while (Date.now() < deadline);

            if (opened) {
                setTab("rooms");
                setNotice(room.roomType === "m.space"
                    ? "Space joined and opened as a Discord server."
                    : "Room joined and opened in Discord.");
            } else {
                setWarning(`${room.name} was joined, but it is still syncing. Use Refresh rooms & directory in a moment.`);
            }
        });
    }

    async function joinRoomByAddress() {
        const address = roomAddress.trim();
        if (!address) {
            setAddressError("Enter a full Matrix room alias or room ID.");
            return;
        }
        if (!/^[#!][^\s:]+:[^\s]+$/u.test(address)) {
            setAddressError("Use a full address such as #general:example.org or !room-id:example.org.");
            return;
        }

        setAddressBusy(true);
        setAddressError("");
        setNotice("");
        try {
            const result = await Native.joinRoomAddress(address);
            setRoomAddress("");
            setPendingAddressRoomId(result.roomId);
            setNotice("Room joined. Waiting for Matrix to sync it...");
            try {
                await loadRooms(false);
            } catch {
                // The bridge poll will pick up a successful join after /sync.
            }
        } catch (caught) {
            setAddressBusy(false);
            setAddressError(errorMessage(caught));
        }
    }

    async function refreshSpaceHierarchy(spaceId: string) {
        try {
            const hierarchy = await Native.spaceChildren(spaceId, 200, 8);
            setSpaceHierarchies(current => ({ ...current, [spaceId]: hierarchy }));
            setSpaceErrors(current => ({ ...current, [spaceId]: "" }));
        } catch (caught) {
            setSpaceErrors(current => ({ ...current, [spaceId]: errorMessage(caught) }));
        }
    }

    async function acceptInvite(roomId: string, spaceId?: string) {
        await run(async () => {
            await Native.acceptInvite(roomId);
            await loadRooms(false);
            if (spaceId) await refreshSpaceHierarchy(spaceId);
            setNotice("Invitation accepted.");
        });
    }

    async function rejectInvite(roomId: string, spaceId?: string) {
        await run(async () => {
            await Native.rejectInvite(roomId);
            await loadRooms(false);
            if (spaceId) await refreshSpaceHierarchy(spaceId);
            setNotice("Invitation declined.");
        });
    }

    async function joinHierarchyRoom(spaceId: string, room: MatrixSpaceHierarchyRoomDTO) {
        await run(async () => {
            const hierarchy = await Native.spaceChildren(spaceId, 200, 8);
            setSpaceHierarchies(current => ({ ...current, [spaceId]: hierarchy }));
            const freshRoom = hierarchy.rooms.find(candidate => candidate.roomId === room.roomId);
            const freshMembership = freshRoom && roomMembership(freshRoom);
            if (!freshRoom
                || !isHierarchyChild(hierarchy, freshRoom.roomId)
                || freshMembership === "join"
                || freshMembership === "invite"
                || !canJoinFromHierarchy(freshRoom)) {
                throw new Error("This room is no longer available to join from the selected space.");
            }
            await Native.joinRoom(room.roomId);
            await loadRooms(false);
            await refreshSpaceHierarchy(spaceId);
            setNotice(`${roomName(room)} joined and added to Discord.`);
        });
    }

    async function finishCreatedSpace(result: MatrixCreateSpaceResult, name: string) {
        const deadline = Date.now() + 20_000;
        const linkedGeneralRoomId = result.partial?.code === "MATRIX_GENERAL_ROOM_LINK_FAILED"
            ? undefined
            : result.generalRoomId;
        let opened = false;
        setError("");

        try {
            do {
                try {
                    const snapshot = await beforeDeadline(refreshSnapshot(), deadline);
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
            } while (Date.now() < deadline);
        } finally {
            setSpaceCreationPending(false);
            setSpaceCreationNeedsRefresh(!opened);
            setBusy(false);
        }

        if (result.partial) {
            setWarning(result.partial.code === "MATRIX_GENERAL_ROOM_CREATE_FAILED"
                ? `${name} was created, but its general chat could not be created. Use Refresh if the server has not appeared; do not create it again.`
                : `${name} and its general chat were created, but the chat could not be added to the server. The chat remains under Chats; do not create the server again.`);
        } else if (!opened) {
            setWarning(`${name} was created, but it is still syncing. Use Refresh in a moment; do not create it again.`);
        } else {
            setNotice(`${name} was created and selected in your Discord server list.`);
        }
        return opened;
    }

    async function resolveAmbiguousSpaceCreation(name: string, existingSpaceIds: Set<string>) {
        let resolved = false;
        try {
            const snapshot = await beforeDeadline(refreshSnapshot(), Date.now() + 20_000);
            const nextRooms = (snapshot.rooms ?? []) as MatrixRoomDTO[];
            setRooms(nextRooms);
            const createdSpace = nextRooms.find(room => !existingSpaceIds.has(room.roomId)
                && roomMembership(room) === "join"
                && roomKind(room) === "space"
                && roomName(room) === name);
            resolved = Boolean(createdSpace && openMatrixSpace(createdSpace.roomId));
        } catch {
            // The request may still have reached the homeserver. Keep creation
            // blocked until the user explicitly refreshes and inspects the list.
        } finally {
            setSpaceCreationPending(false);
            setSpaceCreationNeedsRefresh(!resolved);
            setBusy(false);
        }

        if (resolved) {
            setNotice(`${name} was created and selected in your Discord server list.`);
        } else {
            setWarning(`The request for ${name} timed out and may have succeeded. Refresh and check your server list before trying again.`);
        }
        return resolved;
    }

    function openCreateMatrixServer() {
        setError("");
        setNotice("");
        const existingSpaceIds = new Set(joinedSpaces.map(space => space.roomId));
        openModal(modalProps => (
            <CreateMatrixServerModal
                modalProps={modalProps}
                onCreationAmbiguous={name => resolveAmbiguousSpaceCreation(name, existingSpaceIds)}
                onCreationFailed={() => {
                    setSpaceCreationPending(false);
                    setBusy(false);
                }}
                onCreationStarted={() => {
                    setSpaceCreationPending(true);
                    setBusy(true);
                }}
                onCreated={finishCreatedSpace}
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
            setError("Choose a space and one of its joined members.");
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
                        GIF and X video cards may load media directly from KLIPY or Twitter&apos;s media CDN when the homeserver cannot proxy it. Those providers can see your IP address and request timing; encrypted-room link previews stay disabled.
                    </Paragraph>
                </div>

                {!config?.configured ? (
                    <div className="vc-matrix-card vc-matrix-auth-card">
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
                            <TabBar.Item id="register">Create account</TabBar.Item>
                        </TabBar>

                        <label>
                            <Heading tag="h5">Homeserver</Heading>
                            <TextInput
                                disabled={busy}
                                value={homeserver}
                                placeholder="matrix.example.org"
                                onChange={setHomeserver}
                            />
                        </label>
                        <label>
                            <Heading tag="h5">Username</Heading>
                            <TextInput
                                disabled={busy || !!accessToken}
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
                                    Access-token login can start a session without the prior device&apos;s encryption state. Encrypted history may remain unavailable unless Matrix recovery or compatible device state is present.
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
                            {mode === "register" ? "Create account" : "Sign in"}
                        </Button>
                        <Button
                            disabled={busy}
                            variant="secondary"
                            onClick={() => void logout()}
                        >
                            Clear local Matrix data
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
                            <Button disabled={busy || addressBusy} variant="dangerSecondary" onClick={() => void logout()}>
                                Disconnect
                            </Button>
                        </div>

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
                            </div>
                        )}

                        {sessionResetRequired && (
                            <div className="vc-matrix-card vc-matrix-auth-card">
                                <div>
                                    <Heading tag="h4">Matrix session ended</Heading>
                                    <Paragraph role="alert">
                                        The homeserver did not authorize safe same-device repair. Disconnect this account above to clear its locally stored session and device data, then sign in again with a new session.
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

    function renderSpace(space: MatrixRoomDTO) {
        const expanded = expandedSpaces.has(space.roomId);
        const hierarchy = spaceHierarchies[space.roomId];
        const children = hierarchyRows(hierarchy, space.roomId);
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
                        <Button disabled={busy} variant="dangerSecondary" onClick={() => confirmLeave(space)}>
                            Leave
                        </Button>
                    </div>
                </div>
                {expanded && (
                    <div className="vc-matrix-hierarchy">
                        {spaceLoading === space.roomId && <Paragraph>Loading this space...</Paragraph>}
                        {spaceErrors[space.roomId] && (
                            <Paragraph style={{ color: "var(--text-danger)" }}>
                                Could not load this space: {spaceErrors[space.roomId]}
                            </Paragraph>
                        )}
                        {hierarchy && children.length === 0 && <Paragraph>This space has no visible rooms.</Paragraph>}
                        {hierarchy && children.map(({ room, depth }) =>
                            renderHierarchyRoom(space.roomId, hierarchy, room, depth))}
                    </div>
                )}
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
                            <Paragraph>Accept or decline rooms and spaces that invited your Matrix account.</Paragraph>
                        </div>
                        <div className="vc-matrix-card-list">{invites.map(renderInvite)}</div>
                    </section>
                )}

                <section>
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-actions">
                        <div>
                            <Heading tag="h3">Spaces</Heading>
                            <Paragraph>Each space appears like a server in Discord and can contain multiple chats.</Paragraph>
                        </div>
                        <Button
                            disabled={busy || spaceCreationPending || spaceCreationNeedsRefresh}
                            variant="positive"
                            onClick={openCreateMatrixServer}
                        >
                            {spaceCreationPending
                                ? "Creating Matrix server..."
                                : spaceCreationNeedsRefresh ? "Refresh before creating" : "Create Matrix server"}
                        </Button>
                    </div>
                    <div className="vc-matrix-card-list">
                        {joinedSpaces.map(renderSpace)}
                        {!joinedSpaces.length && <Paragraph>No joined spaces.</Paragraph>}
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
                        {visibleChats.map(room => (
                            <div className="vc-matrix-room-card" key={room.roomId}>
                                <RoomIdentity room={room} />
                                <div className="vc-matrix-row-actions">
                                    <Button disabled={busy} variant="secondary" onClick={() => openMatrixRoom(room.roomId)}>
                                        Open
                                    </Button>
                                    <Button disabled={busy} variant="dangerSecondary" onClick={() => confirmLeave(room)}>
                                        Leave
                                    </Button>
                                </div>
                            </div>
                        ))}
                        {!visibleChats.length && (
                            <Paragraph>{joinedChats.length ? "No chats match that search." : "No joined chats."}</Paragraph>
                        )}
                    </div>
                </section>

                <section className="vc-matrix-card vc-matrix-dm-card">
                    <div className="vc-matrix-section-heading">
                        <Heading tag="h3">Start a direct message</Heading>
                        <Paragraph>Choose a joined member from one of your spaces.</Paragraph>
                    </div>
                    <label>
                        <Heading tag="h5">Space</Heading>
                        <Select
                            placeholder={joinedSpaces.length ? "Choose a space" : "Join a space first"}
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
                        {dmMembersLoading && <Paragraph>Loading space members...</Paragraph>}
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
                        <Heading tag="h3">Join by room address</Heading>
                        <Paragraph>
                            Enter a full alias or room ID on {accountServer ?? "this account's Matrix server"}.
                        </Paragraph>
                    </div>
                    <label>
                        <Heading tag="h5">Matrix room alias or ID</Heading>
                        <TextInput
                            disabled={busy || addressBusy || !!pendingAddressRoomId}
                            value={roomAddress}
                            placeholder={`#general:${accountServer ?? "example.org"}`}
                            onChange={value => {
                                setRoomAddress(value);
                                setAddressError("");
                            }}
                        />
                    </label>
                    <Button
                        disabled={busy || addressBusy || !!pendingAddressRoomId || !roomAddress.trim()}
                        variant="positive"
                        onClick={() => void joinRoomByAddress()}
                    >
                        {addressBusy || pendingAddressRoomId ? "Waiting for Matrix sync..." : "Join room"}
                    </Button>
                    {addressError && <Paragraph style={{ color: "var(--text-danger)" }}>{addressError}</Paragraph>}
                </section>

                <section>
                    <div className="vc-matrix-section-heading vc-matrix-heading-with-actions">
                        <div>
                            <Heading tag="h3">Published chats & spaces</Heading>
                            <Paragraph>
                                Listings published by your homeserver. Public rooms that are not published cannot be discovered automatically.
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
                                    ? "Fetching every published directory page from this homeserver..."
                                    : directoryLoaded
                                        ? `${publicRooms.length} supported listings: ${publicChatCount} chats and ${publicSpaceCount} spaces.`
                                        : "The published directory has not been loaded yet."}
                            </Paragraph>
                            {!directoryBusy && directoryTotalEstimate != null && (
                                <Paragraph>Homeserver estimate: {directoryTotalEstimate} total published entries.</Paragraph>
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
                            placeholder="Search published chats & spaces"
                            onChange={setDirectorySearch}
                        />
                    </div>
                    <div className="vc-matrix-card-list">
                        {visiblePublicRooms.map(room => {
                            const knownRoom = knownRoomsById.get(room.roomId);
                            const membership = knownRoom && roomMembership(knownRoom);
                            const isSpace = room.roomType === "m.space";
                            return (
                                <div className="vc-matrix-room-card" key={room.roomId}>
                                    <div className="vc-matrix-room-identity">
                                        <div className="vc-matrix-room-heading">
                                            <Heading tag="h5">{room.name || room.alias || room.roomId}</Heading>
                                            <span className={`vc-matrix-kind${isSpace ? " vc-matrix-kind-space" : ""}`}>
                                                {isSpace ? "Space" : "Chat"}
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
                                    ) : (
                                        <Button
                                            disabled={busy || addressBusy || directoryBusy || room.joinRule === "knock"}
                                            variant="positive"
                                            onClick={() => void joinPublicRoom(room)}
                                        >
                                            {room.joinRule === "knock" ? "Request required" : isSpace ? "Join server" : "Join"}
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                        {directoryLoaded && !directoryBusy && !publicRooms.length && !directoryError && (
                            <Paragraph>No supported published chats or spaces were found.</Paragraph>
                        )}
                        {directoryLoaded && !directoryBusy && publicRooms.length > 0 && !visiblePublicRooms.length && (
                            <Paragraph>No published chats or spaces match that search.</Paragraph>
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
                    setError("");
                    setNotice("");
                }}
            >
                <TabBar.Item id="rooms">Chats & spaces{invites.length ? ` (${invites.length})` : ""}</TabBar.Item>
                <TabBar.Item id="discover">Find rooms</TabBar.Item>
                <TabBar.Item id="account">Account</TabBar.Item>
            </TabBar>

            {error && <Paragraph style={{ color: "var(--text-danger)" }}>{error}</Paragraph>}
            {notice && <Paragraph className={`vc-matrix-notice vc-matrix-notice-${noticeTone}`}>{notice}</Paragraph>}

            {visibleTab === "rooms" ? renderRooms() : visibleTab === "discover" ? renderDiscover() : renderAccount()}
        </div>
    );
}
