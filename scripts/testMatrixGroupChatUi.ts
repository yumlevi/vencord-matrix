/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const groupCreate = readFileSync("src/plugins/matrixBridge/groupCreate.tsx", "utf8");
const index = readFileSync("src/plugins/matrixBridge/index.tsx", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const protocol = readFileSync("src/plugins/matrixBridge/secureViewProtocol.ts", "utf8");
const secureView = readFileSync("src/plugins/matrixBridge/secureView.ts", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");

function section(source: string, start: string, end: string) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(from, -1, `Missing section start: ${start}`);
    assert.notEqual(to, -1, `Missing section end: ${end}`);
    return source.slice(from, to);
}

function assertOrdered(source: string, needles: string[]) {
    let cursor = -1;
    for (const needle of needles) {
        const next = source.indexOf(needle, cursor + 1);
        assert.notEqual(next, -1, `Missing ordered source contract: ${needle}`);
        assert.ok(next > cursor, `Out-of-order source contract: ${needle}`);
        cursor = next;
    }
}

for (const contract of [
    "MatrixGroupChatCandidateSearchRequest",
    "MatrixGroupChatCandidateSearchResult",
    "MatrixCreateGroupChatRequest",
    "MatrixCreateGroupChatResult",
    "MatrixReconcileGroupChatCreateResult",
]) assert.match(types, new RegExp(`export (?:interface|type) ${contract}\\b`, "u"));
assert.match(types, /creatorId\?: string/u);
assert.match(types, /groupChat\?: true/u);
assert.match(types, /Two to nine unique same-provider users/u);
assert.match(types, /complete: false/u);

const context = section(bridge, "export interface MatrixGroupChatCreateContext", "export interface MatrixGroupChatCandidate");
for (const field of ["expectedAccountId", "generation", "providerLabel"]) {
    assert.match(context, new RegExp(`\\b${field}:`, "u"));
}
const binding = section(bridge, "function sameGroupChatCreateBinding", "function sameInviteBinding");
assert.match(binding, /left\.expectedAccountId === right!\.expectedAccountId/u);
assert.match(binding, /left\.generation === right!\.generation/u);

const searchWrapper = section(bridge, "export async function searchMatrixGroupChatCandidates", "export async function createMatrixGroupChat");
assertOrdered(searchWrapper, [
    "getCurrentMatrixGroupChatCreateContext(context)",
    "await Native.searchGroupChatCandidates",
    "context.expectedAccountId",
    "getCurrentMatrixGroupChatCreateContext(context)",
]);
assert.match(searchWrapper, /if \(!query/u, "The renderer must never enumerate the directory with an empty query.");
const createWrapper = section(bridge, "export async function createMatrixGroupChat", "export async function reconcileMatrixGroupChatCreate");
assertOrdered(createWrapper, [
    "getCurrentMatrixGroupChatCreateContext(context)",
    "await Native.createGroupChat",
    "context.expectedAccountId",
    "getCurrentMatrixGroupChatCreateContext(context)",
]);
const reconcileWrapper = section(bridge, "export async function reconcileMatrixGroupChatCreate", "function projectedMatrixGroupChat");
assertOrdered(reconcileWrapper, [
    "getCurrentMatrixGroupChatCreateContext(context)",
    "await Native.reconcileGroupChatCreate(context.expectedAccountId)",
    "getCurrentMatrixGroupChatCreateContext(context)",
]);
const acknowledgeWrapper = section(bridge, "export async function acknowledgeMatrixGroupChatCreate", "function projectedMatrixGroupChat");
assertOrdered(acknowledgeWrapper, [
    "projectedMatrixGroupChat(roomId)",
    "getCurrentMatrixGroupChatCreateContext(context)",
    "await Native.acknowledgeGroupChatCreate(roomId, context.expectedAccountId)",
    "getCurrentMatrixGroupChatCreateContext(context)",
]);
assert.match(bridge, /value\.length < 2 \|\| value\.length > 9/u);
assert.match(bridge, /matrixUserServerName\(userId\) !== expectedServer/u);
assert.match(bridge, /result\.complete !== complete/u);
const spaceGraph = section(bridge, "function matrixSpaceGraph", "function reachableSpaces");
assert.match(spaceGraph, /childRoom\.groupChat === true/u);
assert.match(bridge, /isSpaceRoom\(room\) \|\| room\.groupChat === true/u);

const groupOwner = section(bridge, "function fallbackGroupChatOwner", "function privateChannel");
assert.match(groupOwner, /while \(id === currentDiscordUserId\)/u);
assert.match(groupOwner, /protectSyntheticId\(id\)/u);
assert.match(groupOwner, /username: "group_bridge_placeholder"/u);
assert.match(groupOwner, /bot: true/u);
assert.match(groupOwner, /room\.creatorId/u);
assert.match(groupOwner, /room\.members\?\.find/u);
const privateChannel = section(bridge, "function privateChannel", "function guildChannel");
assert.match(privateChannel, /room\.groupChat !== true && room\.directUserId/u);
assert.match(privateChannel, /const owner = directMember \? undefined : groupChatOwner\(room\)/u);
assert.match(privateChannel, /owner_id: owner\?\.id/u);
assert.doesNotMatch(privateChannel, /owner_id: directMember \? undefined : rawCurrentUser\(\)\.id/u);
const leaveContext = section(bridge, "export interface MatrixGroupLeaveContext", "export async function leaveMatrixGroup");
assert.match(leaveContext, /isCreator: boolean/u);
assert.match(leaveContext, /injected\.room\.creatorId === accountUserId\(latestSnapshot\)/u);

const headerPatch = section(index, "patches: [", "Discord's lazy-image experiment");
assert.match(headerPatch, /find: '"clean-up-inactive-gdms"'/u);
assert.match(headerPatch, /subscribeToGlobalHotkey:!0/u);
assert.match(headerPatch, /\$self\.renderMatrixGroupChatHeaderButton\(\),/u);
assert.doesNotMatch(headerPatch, /openPrivateChannel|replace:.*Create Message/u,
    "The provider action must be inserted beside, not replace, Discord's stock action.");
assert.match(index, /if \(!context\) return null/u,
    "The provider action must not render without an active account binding.");
assert.match(index, /aria-label="Create Group Chat"/u);
const leaveConfirmation = section(index, "function confirmLeaveMatrixGroup", "type MatrixMenuChildren");
assert.match(leaveConfirmation, /isCreator: boolean/u);
assert.match(leaveConfirmation, /removes the only invite and admin authority/u);
assert.match(leaveConfirmation, /cannot be invited back unless you first transferred that authority/u);
assert.match(index, /label="Leave Group"/u);
assert.match(index, /context\.isCreator/u);

const groupMenu = section(index, "const MATRIX_GROUP_MUTATION_MENU_IDS", "function onMatrixSearchShortcut");
for (const id of [
    "add-recipient",
    "remove-recipient",
    "make-owner",
    "transfer-ownership",
    "change-icon",
    "change-name",
    "invite-people",
]) assert.ok(groupMenu.includes(`"${id}"`), `Missing projected-group menu guard: ${id}`);
assert.match(index, /"gdm-context": matrixGroupLeaveMenuPatch/u);
assert.match(index, /"user-context": matrixUserInviteToServerMenuPatch/u);
assert.match(groupMenu, /removeMatrixMenuItemsWhere\(children, isMatrixGroupMutationMenuItem\)/u);
const groupRestShims = section(index, "find: \"},closePrivateChannel(\"", "find: '\"MessageActionCreators\"'");
assert.doesNotMatch(groupRestShims, /addRecipient[\s\S]*Promise\.resolve|removeRecipient:[\s\S]*Promise\.resolve|setDMOwner:[\s\S]*Promise\.resolve/u,
    "Projected group mutations must fail closed rather than lie about success.");
assert.match(groupRestShims, /Group membership changes are unavailable here/u);
assert.match(groupRestShims, /Group ownership changes are unavailable here/u);
assert.match(groupRestShims, /Group name changes are unavailable here/u);
assert.match(groupRestShims, /Group icon changes are unavailable here/u);

assert.match(groupCreate, /const \[candidates, setCandidates\] = useState<SearchCandidate\[\]>/u);
assert.match(groupCreate, /const nextCandidates = response\.candidates\.map\(candidate => \(\{ \.\.\.candidate, provenanceAt \}\)\)/u);
const toggle = section(groupCreate, "function toggleCandidate", "function review");
assert.match(toggle, /next\.set\(candidate\.userId, candidate\)/u);
assert.doesNotMatch(toggle, /Date\.now/u, "Selecting an old row must not refresh its backend provenance lease.");
assert.match(groupCreate, /setCandidates\(\[\]\);[\s\S]*setSearched\(false\);/u);
assert.match(groupCreate, /Object\.freeze\(\[\.\.\.selected\.keys\(\)\]\)/u);
assert.match(groupCreate, /selected\.size < MIN_RECIPIENTS/u);
assert.match(groupCreate, /next\.size < MAX_RECIPIENTS/u);
assert.match(groupCreate, /activeGroupChatCreateModalKey/u);
assert.match(groupCreate, /Create Group Chat is already open/u);
assert.match(groupCreate, /if \(createLock\.current \|\| ackLock\.current[\s\S]*resultReceiptLocked\) return/u);
assert.match(groupCreate, /if \(shouldReconcile && operationCurrent\(serial\)\) void reconcile/u);
assert.match(groupCreate, /Discord and installed client plugins can read them/u);
assert.match(groupCreate, /configured account provider&apos;s directory/u);
assert.match(groupCreate, /\$\{provider\} account domain/u);
assert.match(groupCreate, /provider can still see the group name/u);
assert.match(groupCreate, /Participants can see one another&apos;s full account IDs/u);
assert.match(groupCreate, /visibleUserId\(candidate\.userId\)/u);
assert.match(groupCreate, /visibleDisplayName\(candidate\)/u);
assert.doesNotMatch(groupCreate, /<img|src=\{candidate\.avatarUrl\}/u);
assert.doesNotMatch(groupCreate, /searchMatrixGroupChatCandidates\([^)]*""/u);
assert.match(groupCreate, /MATRIX_GROUP_CHAT_CANDIDATE_STALE/u);
assert.match(groupCreate, /MATRIX_CREATE_GROUP_CHAT_AMBIGUOUS/u);
assert.match(groupCreate, /MATRIX_CREATE_GROUP_CHAT_RECONCILE_REQUIRED/u);
assert.match(groupCreate, /MATRIX_CREATE_GROUP_CHAT_STATE_WRITE_FAILED/u);
const projectionWait = section(groupCreate, "function beginProjectionWait", "async function reconcile");
assert.doesNotMatch(projectionWait, /acknowledgeMatrixGroupChatCreate/u,
    "A result receipt must not be acknowledged merely because projection refresh started or finished.");
const acknowledgeResult = section(groupCreate, "async function acknowledgeResult", "const provider =");
assert.match(acknowledgeResult, /!projectionReady/u,
    "The exact projected chat must be visible before its durable receipt is acknowledged.");
assertOrdered(acknowledgeResult, [
    "ackLock.current",
    "ackLock.current = true",
    "await acknowledgeMatrixGroupChatCreate",
    "ackLock.current = false",
]);
assertOrdered(acknowledgeResult, [
    "await acknowledgeMatrixGroupChatCreate(before, result.roomId)",
    "setAcknowledged(true)",
    "openMatrixGroupChat(result.roomId)",
]);
assert.match(groupCreate, /function closeForNow|const closeForNow/u);
assert.match(groupCreate, /text: "Close for now"[\s\S]*onClick: closeForNow/u,
    "Closing an unprojected result must leave its durable receipt intact.");

assert.match(settings, /<Heading tag="h3">Create a group chat<\/Heading>/u);
assert.match(settings, /openMatrixGroupChatCreate\(\)/u);
const settingsLogout = section(settings, "function confirmLogout", "async function joinPublicRoom");
assert.match(settingsLogout, /<ConfirmModal/u);
assert.match(settingsLogout, /unacknowledged room or[\s\S]*server creation receipt/u);
assert.match(settingsLogout, /can no longer be reconciled/u);
assert.match(settingsLogout, /onConfirm=\{\(\) => void logout\(\)\}/u);
assert.match(settings, /onClick=\{confirmLogout\}/u);

assert.match(protocol, /searchGroupChatCandidates:[\s\S]*createGroupChat:[\s\S]*reconcileGroupChatCreate:/u);
assert.match(protocol, /acknowledgeGroupChatCreate: \{ input: \{ roomId: string; \}; output: void; \}/u);
const shellRoom = section(protocol, "export interface MatrixShellRoom", "export interface MatrixShellSnapshot");
assert.match(shellRoom, /groupChat\?: true/u);
const shellProjection = section(native, "function projectShellRoom", "function projectShellSnapshot");
assert.match(shellProjection, /room\.groupChat === true \? \{ groupChat: true as const \}/u);
const secureGroup = section(secureView, "function setSecureGroupChatResult", "function openSearch");
assert.match(secureGroup, /isCurrentSecureAccount\(expectedUserId\)/u);
assert.match(secureGroup, /type: "searchGroupChatCandidates"/u);
assert.match(secureGroup, /type: "createGroupChat"/u);
assert.match(secureGroup, /type: "reconcileGroupChatCreate"/u);
assert.match(secureGroup, /type: "acknowledgeGroupChatCreate"/u);
assert.match(secureGroup, /!roomById\(result\.roomId\)/u);
assertOrdered(secureGroup, [
    "groupChatAckBusy",
    "groupChatAckBusy = true",
    'type: "acknowledgeGroupChatCreate"',
]);
assert.match(secureGroup, /if \(!query\)/u);
assert.match(secureGroup, /Object\.freeze\(request\.userIds\)/u);
assert.match(secureGroup, /groupChatCandidates = \[\]/u);
assert.match(secureGroup, /groupChatAmbiguityLocked = true/u);
assert.match(secureView, /groupChatCreateBusy \|\| groupChatReconcileBusy/u);
assert.match(secureView, /groupChatResult && !groupChatResultAcknowledged/u);
assert.match(secureView, /makeButton\("Close for now"[\s\S]*clearGroupChatOverlayState/u);
assert.match(secureView, /makeButton\("Close for now"[\s\S]*if \(groupChatAckBusy\) return/u);
assert.match(secureView, /Discord and installed client plugins can read them/u);
assert.match(secureView, /account ID must use the \$\{accountDomain\} domain/u);
assert.match(secureView, /provider can still see the group name|provider still sees the group name/u);
assert.match(secureView, /room\.groupChat === true \? "Group chat"/u);
assert.match(secureView, /overlay === "groupChat" \? renderGroupChatOverlay\(\)/u);
assert.match(secureView, /makeButton\("Create Group Chat"[\s\S]*openGroupChatOverlay/u);
const secureLogout = section(secureView, "async function logout", "function renderAccountMain");
assert.match(secureLogout, /window\.confirm/u);
assert.match(secureLogout, /unacknowledged room or server creation receipt/u);
assert.match(secureLogout, /can no longer be reconciled/u);

assert.match(native, /case "searchGroupChatCandidates":\s*return await searchGroupChatCandidates\(event, request\.request, secureViewExpectedUserId\(state\)\)/u);
assert.match(native, /case "createGroupChat": return await runPrivateCreateMutation\(event, state, \(\) =>\s*createGroupChat\(event, request\.request, secureViewExpectedUserId\(state\)\)\)/u);
assert.match(native, /case "acknowledgeGroupChatCreate":\s*return await acknowledgeGroupChatCreate\(\s*event,\s*request\.roomId,\s*secureViewExpectedUserId\(state\)/u);

console.log("Matrix group-chat renderer contracts passed.");
