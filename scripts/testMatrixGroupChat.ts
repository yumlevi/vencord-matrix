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
assert.match(types, /MatrixReconcileGroupChatInviteResult[\s\S]*status: "pending"; roomId: string; userId: string[\s\S]*status: "resolved"/u);
assert.match(types, /MatrixGroupChatInviteCandidateSearchResult[\s\S]*participantCount: number;[\s\S]*maxParticipants: 10;[\s\S]*full: boolean;/u);
assert.match(types, /MatrixInviteUserToGroupChatResult[\s\S]*delivery: "accepted" \| "existing";[\s\S]*observedMembership\?: "invite" \| "join";/u);
assert.match(types, /interface MatrixRoomDTO[\s\S]*groupChat\?: true;[\s\S]*creatorId\?: string;/u);
assert.match(protocol, /type: "searchGroupChatCandidates"/u);
assert.match(protocol, /type: "createGroupChat"; request: MatrixCreateGroupChatRequest; creationMarker: string/u);
assert.match(protocol, /type: "reconcileGroupChatCreate";[\s\S]*creationMarker: string;[\s\S]*userIds: string\[\]/u);
assert.match(protocol, /type: "searchGroupChatInviteCandidates"/u);
assert.match(protocol, /type: "inviteUserToGroupChat"/u);
assert.match(protocol, /type: "reconcileGroupChatInvite"/u);
assert.match(protocol, /type: "joinedRoomIds"/u);

const backendSearch = functionSlice(backend, "async function searchGroupChatCandidates", "async function inviteUserToSpace");
assert.match(backend, /searchUserDirectory\(\{[\s\S]*term: exactUserId \?\? request\.query,[\s\S]*limit: request\.limit[\s\S]*\}\)/u);
assert.match(backend, /emptyUserDirectoryQueryUnsupported/u);
assert.match(backend, /localServerUserId\(raw\.user_id\)/u);
assert.match(backend, /userId === activeCredentials\.userId/u);
assert.match(backend, /unique\.has\(userId\)/u);
assert.match(backend, /rememberGroupChatDirectoryCandidate\(userId\)/u);
assert.match(backend, /complete: false/u);
assert.match(backendSearch, /MATRIX_GROUP_CHAT_FULL/u);
assert.match(backendSearch, /delivery: "accepted"[\s\S]*observedMembership/u);
assert.match(backendSearch, /exactGroupChatMembershipSnapshot/u);
assert.match(backendSearch, /exactGroupChatInvitePermission/u);
assert.ok(backendSearch.indexOf("exactGroupChatMembershipSnapshot(room)")
    < backendSearch.indexOf("exactGroupChatInvitePermission(room)"),
"the exact current privacy/PL snapshot must be the last authorization read before invite dispatch");
assert.ok(backendSearch.indexOf("exactGroupChatInvitePermission(room)") < backendSearch.indexOf("mutationDispatched()"));
assert.match(backendSearch, /reconcileGroupChatInvite[\s\S]*exactSpaceInviteMembership\(request\.roomId, request\.userId\)/u);
assert.doesNotMatch(
    backendSearch.slice(backendSearch.indexOf("async function reconcileGroupChatInvite")),
    /joinedInvitableGroupChat|groupChatPrivacyContract/,
    "read-only invite reconciliation must survive a later leave or mutable privacy change"
);

const exactLookup = functionSlice(backend, "function exactLocalProfileUserId", "function consumeGroupChatExactLookup");
assert.match(exactLookup, /BARE_MATRIX_LOCALPART_PATTERN\.test\(localpart\)/u);
assert.match(exactLookup, /serverName === activeServerName\(\)/u);
assert.match(exactLookup, /TextEncoder\(\)\.encode\(query\)\.byteLength <= 255/u);
const candidateSearch = functionSlice(backend, "async function groupChatCandidateSearch", "async function searchGroupChatCandidates");
assert.ok(candidateSearch.indexOf("exactLocalProfileUserId(request.query)")
    < candidateSearch.indexOf("matrixClient.searchUserDirectory"),
"exact local identity must be canonicalized before any directory/profile network request");
assert.match(candidateSearch, /matrixClient\.getProfileInfo\(exactUserId\)/u);
assert.match(candidateSearch, /MATRIX_GROUP_CHAT_EXACT_LOOKUP_RATE_LIMITED|consumeGroupChatExactLookup/u);
assert.match(candidateSearch, /not_found_or_unavailable/u);

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
assert.match(backend, /const MIN_GROUP_CHAT_INVITEES = 0;/u);
assert.match(backend, /const MAX_GROUP_CHAT_INVITEES = 9;/u);

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

const identity = functionSlice(backend, "function groupChatRoomIdentity", "function groupChatPrivacyContract");
assert.match(identity, /room\.isSpaceRoom\(\)/u);
assert.match(identity, /exactGroupChatCreationContent\(creation, roomVersion\)/u);
assert.match(identity, /Object\.hasOwn\(creation, GROUP_CHAT_CREATION_CONTENT_KEY\)/u);
assert.match(identity, /validGroupChatCreationMarker\(creation\[GROUP_CHAT_CREATION_CONTENT_KEY\]\)/u);
assert.match(identity, /groupChatStateMarker\(room, creatorId\)/u,
    "older bridge rooms retain a creator-sent marker-event identity fallback");
assert.doesNotMatch(identity, /RoomEncryption|RoomJoinRules|RoomPowerLevels/u,
    "permanent group identity must not depend on mutable privacy or power-level state");

const strictContract = functionSlice(backend, "function groupChatPrivacyContract", "function groupChatRoomContract");
assert.match(strictContract, /groupChatRoomIdentity\(room\)/u);
assert.match(strictContract, /m\.megolm\.v1\.aes-sha2/u);
assert.match(strictContract, /JoinRule\.Invite/u);
assert.match(strictContract, /HistoryVisibility\.Joined/u);
assert.match(strictContract, /GuestAccess\.Forbidden/u);
assert.match(strictContract, /groupChatStateMarker\(room, identity\.creatorId\) !== identity\.creationMarker/u);
assert.match(backend, /function groupChatRoomContract[\s\S]*exactGroupChatPowerLevels/u);

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
assert.match(backend, /const groupChat = groupChatRoomIdentity\(room\) != null;[\s\S]*if \(groupChat\) \{[\s\S]*result\.groupChat = true;/u);
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

const nativeGroupInvite = functionSlice(native, "async function inviteUserToGroupChat", "async function reconcileGroupChatInvite");
assert.match(nativeGroupInvite, /expectedUserId: string/u);
assert.match(nativeGroupInvite, /withExpectedMatrixAccount\(expectedUserId/u);
assert.ok(nativeGroupInvite.indexOf("createPendingGroupChatInvite(binding, validatedRequest)")
    < nativeGroupInvite.indexOf('type: "inviteUserToGroupChat"'),
"the durable per-room invite receipt must be committed before worker dispatch");
assert.match(native, /MATRIX_GROUP_CHAT_INVITE_RECONCILE_REQUIRED/u);
assert.match(nativeGroupInvite, /persistResolvedGroupChatInvite/u);
assert.match(nativeGroupInvite, /MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS/u);
const nativeInviteReconcile = functionSlice(
    native,
    "async function reconcileGroupChatInvite",
    "async function acknowledgeGroupChatInvite"
);
assert.match(nativeInviteReconcile, /roomId: string,[\s\S]*expectedUserId: string/u,
    "reopen recovery must locate the target from a room-scoped native receipt");
assert.match(nativeInviteReconcile, /pending\.resolved/u);
assert.match(nativeInviteReconcile, /status: "none"/u);
assert.match(nativeInviteReconcile, /persistResolvedGroupChatInvite/u);
assert.match(native, /status: "pending", roomId: pending\.roomId, userId: pending\.userId/u);
const nativeInviteAck = functionSlice(
    native,
    "async function acknowledgeGroupChatInvite",
    "async function overrideGroupChatInviteAmbiguity"
);
assert.match(nativeInviteAck, /pending\.userId !== validatedRequest\.userId/u);
assert.match(nativeInviteAck, /if \(!pending\.resolved\)[\s\S]*MATRIX_GROUP_CHAT_INVITE_ACK_NOT_READY/u);
assert.match(nativeInviteAck, /clearPendingGroupChatInvite\(binding, pending\)/u);
const nativeInviteOverride = functionSlice(
    native,
    "async function overrideGroupChatInviteAmbiguity",
    "async function inviteUserToSpace"
);
assert.match(nativeInviteOverride, /type: "reconcileGroupChatInvite"/u);
assert.match(nativeInviteOverride, /MATRIX_GROUP_CHAT_INVITE_OVERRIDE_NOT_ALLOWED/u);
assert.ok(nativeInviteOverride.indexOf('type: "reconcileGroupChatInvite"')
    < nativeInviteOverride.indexOf("clearPendingGroupChatInvite(binding, pending)"),
"explicit ambiguity override must perform one fresh read and must never send an invite");
assert.doesNotMatch(nativeInviteOverride, /type: "inviteUserToGroupChat"/u);
assert.match(native, /schema: 3,[\s\S]*invites: \[\.\.\.ambiguousGroupChatInvites\.values\(\)\]/u);
assert.match(native, /raw\.schema !== 2 && raw\.schema !== 3/u,
    "deployed schema-2 group-create receipts must migrate without corruption");
assert.match(native, /encrypted\.byteLength > MAX_GROUP_CHAT_STATE_FILE_BYTES/u,
    "the writer and loader must share a durable encrypted-file size bound");
assert.match(native, /pending\.commandType === "inviteUserToGroupChat" && pending\.mutationDispatched[\s\S]*MATRIX_GROUP_CHAT_INVITE_AMBIGUOUS/u);
assert.match(native, /commandType === "inviteUserToGroupChat"/u);
assert.match(backend, /async function exactJoinedRoomIds[\s\S]*matrixClient!\.getJoinedRooms\(\)[\s\S]*duplicate joined-room state[\s\S]*roomIds\.sort\(\)/u);
const receiptPrune = functionSlice(
    native,
    "async function pruneUnjoinedGroupChatInviteReceipts",
    "async function captureGroupChatInviteReceipts"
);
assert.match(receiptPrune, /for \(const \[key, pending\] of captured\)/u);
assert.match(receiptPrune, /ambiguousGroupChatInvites\.get\(key\) !== pending/u);
assert.match(receiptPrune, /groupChatInviteOperationsInFlight\.has\(key\)/u);
assert.match(receiptPrune, /await saveGroupChatCreateState\(\)/u);
assert.match(receiptPrune, /catch \(error\)[\s\S]*ambiguousGroupChatInvites\.set\(key, pending\)/u,
    "failed exact-membership pruning must restore every durable receipt");
assert.match(native, /async function bestEffortPruneUnjoinedGroupChatInviteReceipts[\s\S]*captureGroupChatInviteReceipts\(binding\)[\s\S]*type: "joinedRoomIds"[\s\S]*beginAccountBoundOperation\(binding\)[\s\S]*pruneUnjoinedGroupChatInviteReceipts\(binding, captured,[\s\S]*transient \/joined_rooms failure must retain every ambiguity receipt/u);
assert.match(native, /function scheduleUnjoinedGroupChatInviteReceiptPrune[\s\S]*setTimeout\(\(\) => \{[\s\S]*void bestEffortPruneUnjoinedGroupChatInviteReceipts\(binding, expectedWorker\)[\s\S]*async function startInternal/u);
assert.match(native, /groupChatInvitePruneScheduledWorkers\.has\(expectedWorker\)[\s\S]*groupChatInvitePruneScheduledWorkers\.add\(expectedWorker\)/u,
    "receipt housekeeping must be single-flight once per exact worker");
assert.match(native, /async function startInternal[\s\S]*activeWorkerBinding = binding;[\s\S]*scheduleUnjoinedGroupChatInviteReceiptPrune\(binding\);[\s\S]*return finalized/u);
assert.doesNotMatch(native, /await bestEffortPruneUnjoinedGroupChatInviteReceipts/u);
assert.equal(native.match(/scheduleUnjoinedGroupChatInviteReceiptPrune\(binding\);/gu)?.length, 1,
    "ordinary snapshot refreshes must not poll /joined_rooms for receipt pruning");
const nativeLeave = functionSlice(native, "async function leaveRoom", "function validateCreateSpaceRequest");
assert.ok(nativeLeave.indexOf("validateRoomActionResult(result, targetRoomId)")
    < nativeLeave.indexOf("clearPendingGroupChatInvite(binding, pending)"),
"normal leave may clear a receipt only after an authoritative success result");
assert.match(nativeLeave, /groupChatInviteOperationsInFlight/u,
    "leave and invite/reconcile must serialize on the same room receipt key");

assert.match(secureProtocol, /searchGroupChatCandidates:[\s\S]*MatrixGroupChatCandidateSearchResult/u);
assert.match(secureProtocol, /interface MatrixShellRoom[\s\S]*groupChat\?: true;/u);
assert.match(secureProtocol, /createGroupChat:[\s\S]*MatrixCreateGroupChatResult/u);
assert.match(secureProtocol, /reconcileGroupChatCreate:[\s\S]*MatrixReconcileGroupChatCreateResult/u);
assert.match(secureProtocol, /acknowledgeGroupChatCreate:[\s\S]*roomId: string[\s\S]*output: void/u);
assert.match(secureProtocol, /searchGroupChatInviteCandidates:[\s\S]*MatrixGroupChatInviteCandidateSearchResult/u);
assert.match(secureProtocol, /inviteUserToGroupChat:[\s\S]*MatrixInviteUserToGroupChatResult/u);
assert.match(secureProtocol, /reconcileGroupChatInvite:[\s\S]*roomId: string[\s\S]*MatrixReconcileGroupChatInviteResult/u);
assert.match(secureProtocol, /acknowledgeGroupChatInvite:[\s\S]*MatrixInviteUserToGroupChatRequest[\s\S]*output: void/u);
assert.match(secureProtocol, /overrideGroupChatInviteAmbiguity:[\s\S]*MatrixInviteUserToGroupChatRequest[\s\S]*output: void/u);
assert.match(native, /case "createGroupChat": return await runPrivateCreateMutation/u);
assert.match(native, /case "reconcileGroupChatCreate"[\s\S]*result\.status === "resolved"[\s\S]*bestEffortMutationRefresh/u);
assert.match(native, /case "acknowledgeGroupChatCreate"[\s\S]*secureViewExpectedUserId\(state\)/u);
assert.match(native, /function projectShellRoom[\s\S]*room\.groupChat === true \? \{ groupChat: true as const \}/u);
assert.match(native, /function projectShellRoom[\s\S]*room\.invitePermission \? \{ invitePermission: \{ \.\.\.room\.invitePermission \} \}/u);

const cleanup = functionSlice(native, "async function clearNativeAccountStorage", "function publish");
assert.match(cleanup, /resolve\(DATA_DIR\)/u);
assert.match(cleanup, /target !== expected \|\| target === dataRoot/u);
assert.match(cleanup, /rm\(target, \{ recursive: true, force: true/u);
assert.match(cleanup, /ambiguousSpaceChildCreates\.clear\(\)/u);
assert.match(cleanup, /ambiguousGroupChatCreates\.clear\(\)/u);
assert.match(cleanup, /ambiguousGroupChatInvites\.clear\(\)/u);
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
