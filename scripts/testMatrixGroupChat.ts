/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const protocol = readFileSync("src/plugins/matrixBridge/workerProtocol.ts", "utf8");
const secureProtocol = readFileSync("src/plugins/matrixBridge/secureViewProtocol.ts", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");

function functionSlice(source: string, name: string, nextName: string): string {
    const start = source.indexOf(`${name}(`);
    const end = source.indexOf(`${nextName}(`, start + name.length + 1);
    assert.notEqual(start, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${nextName} must follow ${name}`);
    return source.slice(start, end);
}

assert.match(types, /interface MatrixCreateGroupChatRequest[\s\S]*name: string;[\s\S]*userIds: string\[\];/u);
assert.match(types, /MatrixGroupChatInvitationStatus = "invited" \| "joined" \| "rejected" \| "ambiguous"/u);
assert.match(types, /MatrixReconcileGroupChatCreateResult[\s\S]*status: "none"[\s\S]*status: "pending"[\s\S]*status: "resolved"/u);
assert.match(types, /interface MatrixRoomDTO[\s\S]*groupChat\?: true;[\s\S]*creatorId\?: string;/u);
assert.match(protocol, /type: "searchGroupChatCandidates"/u);
assert.match(protocol, /type: "createGroupChat"; request: MatrixCreateGroupChatRequest; creationMarker: string/u);
assert.match(protocol, /type: "reconcileGroupChatCreate";[\s\S]*creationMarker: string;[\s\S]*userIds: string\[\]/u);

const backendSearch = functionSlice(backend, "async function searchGroupChatCandidates", "async function inviteUserToSpace");
assert.match(backendSearch, /searchUserDirectory\(\{ term: request\.query, limit: request\.limit \}\)/u);
assert.match(backendSearch, /emptyUserDirectoryQueryUnsupported/u);
assert.match(backendSearch, /localServerUserId\(raw\.user_id\)/u);
assert.match(backendSearch, /userId === activeCredentials\.userId/u);
assert.match(backendSearch, /unique\.has\(userId\)/u);
assert.match(backendSearch, /rememberGroupChatDirectoryCandidate\(userId\)/u);
assert.match(backendSearch, /complete: false/u);

const backendCreate = functionSlice(backend, "async function createGroupChat", "async function reconcileGroupChatCreate");
assert.match(backendCreate, /requireCurrentGroupChatDirectoryCandidates\(request\.userIds\)/u);
assert.ok(backendCreate.indexOf("selectCreationRoomVersion(false)") < backendCreate.indexOf("mutationDispatched()"),
    "capability preflight must finish before the mutation boundary");
assert.ok(backendCreate.indexOf("mutationDispatched()") < backendCreate.indexOf("matrixClient.createRoom"),
    "the mutation boundary must immediately precede createRoom dispatch");
assert.match(backendCreate, /preset: Preset\.PrivateChat/u);
assert.doesNotMatch(backendCreate, /TrustedPrivateChat/u);
assert.match(backendCreate, /creation_content: \{[\s\S]*"m\.federate": false,[\s\S]*\[GROUP_CHAT_CREATION_CONTENT_KEY\]: creationMarker[\s\S]*\}/u);
assert.match(backendCreate, /EventType\.RoomJoinRules[\s\S]*JoinRule\.Invite/u);
assert.match(backendCreate, /EventType\.RoomHistoryVisibility[\s\S]*HistoryVisibility\.Joined/u);
assert.match(backendCreate, /EventType\.RoomGuestAccess[\s\S]*GuestAccess\.Forbidden/u);
assert.match(backendCreate, /EventType\.RoomEncryption[\s\S]*m\.megolm\.v1\.aes-sha2/u);
assert.match(backendCreate, /GROUP_CHAT_CREATION_EVENT_TYPE/u);
assert.match(backendCreate, /power_level_content_override: roomCreationPowerLevels\(roomVersion\)/u);
assert.ok(backendCreate.indexOf("attestCreatedGroupChatState(roomId, roomVersion, creationMarker)")
    < backendCreate.indexOf("inviteGroupChatUsers(roomId, request.userIds)"),
"the exact created-room contract must be attested before any invitations are dispatched");
assert.doesNotMatch(backendCreate, /is_direct|EventType\.Direct|addDirectRoom|SpaceChild|SpaceParent/u);
assert.match(backendCreate, /inviteGroupChatUsers\(roomId, request\.userIds\)/u);
assert.match(backendCreate, /MATRIX_CREATE_GROUP_CHAT_REJECTED/u);
assert.match(backendCreate, /MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS/u);

const creationPowerLevels = functionSlice(
    backend,
    "function roomCreationPowerLevels",
    "function validateGroupChatCreationMarker"
);
assert.match(creationPowerLevels, /const users: Record<string, number> = roomVersion === "12"[\s\S]*\? \{\}[\s\S]*activeCredentials!\.userId\]: 100/u);
assert.match(creationPowerLevels, /const events: Record<string, number> = roomVersion === "12"[\s\S]*RoomTombstone\]: 150[\s\S]*: \{\}/u,
    "client overrides must replace homeserver-generated event/user maps deterministically");

const backendReconcile = functionSlice(backend, "async function reconcileGroupChatCreate", "async function createSpace");
assert.match(backendReconcile, /rooms\.length > 10_000/u);
assert.match(backendReconcile, /matches\.length > 1/u);
assert.match(backendReconcile, /attestedGroupChatRoom/u);
assert.match(backendReconcile, /exactOwnJoinedRoom/u);
assert.match(backendReconcile, /"ambiguous"/u);
assert.doesNotMatch(backendReconcile, /matrixClient!?\.invite|inviteGroupChatUser/u,
    "marker reconciliation must never resend an unconfirmed invitation");

const powerLevelContract = functionSlice(
    backend,
    "function exactGroupChatPowerLevelContent",
    "function exactGroupChatPowerLevels"
);
for (const [key, level] of [
    ["users_default", 0], ["events_default", 0], ["state_default", 50],
    ["invite", 50], ["kick", 50], ["ban", 50], ["redact", 50]
] as const) {
    assert.match(powerLevelContract, new RegExp(`"${key}", ${level}`, "u"));
}
assert.match(powerLevelContract, /roomVersion === "12"[\s\S]*Object\.hasOwn\(users, creatorId\)[\s\S]*parsed\.value > 0/u);
assert.match(powerLevelContract, /Object\.keys\(events\)\.length !== 1/u);
assert.match(powerLevelContract, /EventType\.RoomTombstone[\s\S]*tombstone\.value === 150/u);

const identity = functionSlice(backend, "function groupChatRoomIdentity", "function groupChatRoomContract");
assert.match(identity, /room\.isSpaceRoom\(\)/u);
assert.match(identity, /exactGroupChatCreationContent\(creation, roomVersion\)/u);
assert.match(identity, /Object\.hasOwn\(creation, GROUP_CHAT_CREATION_CONTENT_KEY\)/u);
assert.match(identity, /validGroupChatCreationMarker\(creation\[GROUP_CHAT_CREATION_CONTENT_KEY\]\)/u);
assert.match(identity, /groupChatStateMarker\(room, creatorId\)/u,
    "older bridge rooms retain a creator-sent marker-event identity fallback");
assert.doesNotMatch(identity, /RoomEncryption|RoomJoinRules|RoomPowerLevels/u,
    "permanent group identity must not depend on mutable privacy or power-level state");

const strictContract = functionSlice(backend, "function groupChatRoomContract", "function attestedGroupChatRoom");
assert.match(strictContract, /groupChatRoomIdentity\(room\)/u);
assert.match(strictContract, /m\.megolm\.v1\.aes-sha2/u);
assert.match(strictContract, /JoinRule\.Invite/u);
assert.match(strictContract, /HistoryVisibility\.Joined/u);
assert.match(strictContract, /GuestAccess\.Forbidden/u);
assert.match(strictContract, /groupChatStateMarker\(room, identity\.creatorId\) !== identity\.creationMarker/u);
assert.match(strictContract, /exactGroupChatPowerLevels/u);

const attestation = functionSlice(backend, "function attestedGroupChatRoom", "function projectableSpaceChildren");
assert.match(attestation, /room\.getMyMembership\(\) !== "join"/u);
assert.match(attestation, /groupChatRoomContract\(room\)/u);
assert.match(attestation, /contract\?\.creatorId === activeCredentials\.userId/u);
assert.match(attestation, /contract\.creationMarker === creationMarker/u);

const rawAttestation = functionSlice(backend, "async function attestCreatedGroupChatState", "async function createGroupChat");
assert.match(rawAttestation, /matrixClient\.roomState\(roomId\)/u);
assert.match(rawAttestation, /create\.sender !== activeCredentials\.userId/u);
assert.match(rawAttestation, /create\.content\[GROUP_CHAT_CREATION_CONTENT_KEY\] !== creationMarker/u);
assert.match(rawAttestation, /marker\?\.sender === create\.sender/u);
assert.match(rawAttestation, /exactGroupChatPowerLevelContent/u);
assert.match(rawAttestation, /ownMembership\?\.content\.membership === "join"/u);

assert.match(backend, /function roomKind[\s\S]*groupChatRoomIdentity\(room\)[\s\S]*function roomDirectUserId[\s\S]*groupChatRoomIdentity\(room\)/u);
assert.match(backend, /const groupChat = groupChatRoomIdentity\(room\) != null;[\s\S]*if \(groupChat\) result\.groupChat = true;/u);
assert.match(backend, /function projectableSpaceChildren[\s\S]*!groupChatRoomIdentity\(childRoom\)/u);
assert.match(backend, /async function openDirectMessage[\s\S]*\|\| groupChatRoomIdentity\(room\)\) continue;/u);

const nativeCreate = functionSlice(native, "async function createGroupChat", "function validateProtocolReconcileGroupChatCreateResult");
assert.match(nativeCreate, /expectedUserId: string/u);
assert.match(nativeCreate, /withExpectedMatrixAccount\(expectedUserId/u);
assert.match(nativeCreate, /createGroupChatInFlight/u);
assert.ok(nativeCreate.indexOf("saveGroupChatCreateState()") < nativeCreate.indexOf("callWorker<MatrixCreateGroupChatResult>"),
    "the durable marker must be saved before worker dispatch");
assert.match(nativeCreate, /MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED/u);
assert.match(nativeCreate, /MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS/u);
assert.match(nativeCreate, /validateProtocolCreateGroupChatResult/u);
assert.match(nativeCreate, /persistResolvedGroupChatCreate/u);
assert.doesNotMatch(
    nativeCreate.slice(nativeCreate.indexOf("await persistResolvedGroupChatCreate")),
    /clearPendingGroupChatCreate/u,
    "a successful create receipt must remain durable until explicit acknowledgement");

const nativeReconcile = functionSlice(native, "async function reconcileGroupChatCreate", "async function acknowledgeGroupChatCreate");
assert.match(nativeReconcile, /expectedUserId: string/u);
assert.match(nativeReconcile, /withExpectedMatrixAccount\(expectedUserId/u);
assert.match(nativeReconcile, /groupChatReconciliationsInFlight/u);
assert.match(nativeReconcile, /status: "none"/u);
assert.match(nativeReconcile, /pending\.resolved/u);
assert.match(nativeReconcile, /persistResolvedGroupChatCreate/u);
assert.doesNotMatch(nativeReconcile, /clearPendingGroupChatCreate/u,
    "reconciliation must return the same durable receipt until acknowledgement");

const nativeAcknowledge = functionSlice(native, "async function acknowledgeGroupChatCreate", "function validateCreateSpaceChildRequest");
assert.match(nativeAcknowledge, /expectedUserId: string/u);
assert.match(nativeAcknowledge, /withExpectedMatrixAccount\(expectedUserId/u);
assert.match(nativeAcknowledge, /callWorker<MatrixReconcileGroupChatCreateResult>/u,
    "acknowledgement must re-attest the strict room contract even for a cached receipt");
assert.match(nativeAcknowledge, /pending\.resolved\.roomId !== reconciliation\.result\.roomId/u);
assert.ok(nativeAcknowledge.indexOf("reconciliation.result.roomId !== targetRoomId")
    < nativeAcknowledge.indexOf("clearPendingGroupChatCreate(binding, pending)"),
"only an exact, freshly attested room receipt may be cleared");
assert.match(native, /function groupChatCreateLatchKey[\s\S]*return binding\.userId;/u,
    "delegated homeserver URLs must not bypass a canonical-MXID latch");
assert.match(native, /case "createGroupChat"[\s\S]*MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS/u);
assert.match(native, /commandType === "createGroupChat"[\s\S]*GROUP_CHAT_CREATE_TIMEOUT_MS/u);
assert.match(native, /commandType === "createSpaceChild" \|\| commandType === "createGroupChat"/u);

assert.match(secureProtocol, /searchGroupChatCandidates:[\s\S]*MatrixGroupChatCandidateSearchResult/u);
assert.match(secureProtocol, /interface MatrixShellRoom[\s\S]*groupChat\?: true;/u);
assert.match(secureProtocol, /createGroupChat:[\s\S]*MatrixCreateGroupChatResult/u);
assert.match(secureProtocol, /reconcileGroupChatCreate:[\s\S]*MatrixReconcileGroupChatCreateResult/u);
assert.match(secureProtocol, /acknowledgeGroupChatCreate:[\s\S]*roomId: string[\s\S]*output: void/u);
assert.match(native, /case "createGroupChat": return await runPrivateCreateMutation/u);
assert.match(native, /case "reconcileGroupChatCreate"[\s\S]*result\.status === "resolved"[\s\S]*bestEffortMutationRefresh/u);
assert.match(native, /case "acknowledgeGroupChatCreate"[\s\S]*secureViewExpectedUserId\(state\)/u);
assert.match(native, /function projectShellRoom[\s\S]*room\.groupChat === true \? \{ groupChat: true as const \}/u);

const cleanup = functionSlice(native, "async function clearNativeAccountStorage", "function publish");
assert.match(cleanup, /resolve\(DATA_DIR\)/u);
assert.match(cleanup, /target !== expected \|\| target === dataRoot/u);
assert.match(cleanup, /rm\(target, \{ recursive: true, force: true/u);
assert.match(cleanup, /ambiguousSpaceChildCreates\.clear\(\)/u);
assert.match(cleanup, /ambiguousGroupChatCreates\.clear\(\)/u);
assert.match(native, /async function logout[\s\S]*clearWorkerStorage\(\)[\s\S]*clearNativeAccountStorage\(\)/u);
assert.match(native, /async function start[\s\S]*if \(!account\)[\s\S]*clearNativeAccountStorage\(\)/u);

const forbiddenNameControls = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
assert.equal(forbiddenNameControls.test("friends"), false);
assert.equal(forbiddenNameControls.test("safe\u202eevil"), true);
assert.match(backend, /GROUP_CHAT_CREATION_MARKER_PATTERN = \/\^vcgroup_\[0-9a-f\]\{64\}\$\//u);
assert.match(backend, /GROUP_CHAT_CREATION_CONTENT_KEY = "dev\.vencord\.matrix_bridge\.group_chat_marker"/u);
assert.match(backend, /getStateEvents\(EventType\.RoomCreate, ""\)[\s\S]*optionalUserId\(createEvent\.getSender\(\)\)[\s\S]*result\.creatorId = creatorId/u,
    "room creators must come from the create-event sender in every room version");
assert.match(native, /raw\.creatorId != null\) room\.creatorId = protocolUserId\(raw\.creatorId\)/u);
const nativeGroupProjection = functionSlice(native, "function validateProtocolRoom", "function validateProtocolSnapshot");
assert.match(nativeGroupProjection, /raw\.groupChat !== true \|\| kind !== "room"/u);
assert.match(nativeGroupProjection, /raw\.creatorId == null[\s\S]*raw\.roomType != null[\s\S]*raw\.directUserId != null/u);
assert.doesNotMatch(nativeGroupProjection, /raw\.groupChat[\s\S]{0,160}raw\.encrypted !== true/u,
    "stable group identity must not depend on mutable privacy state at the native boundary");

console.log("Matrix group-chat fixtures passed.");
