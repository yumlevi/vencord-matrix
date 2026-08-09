/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const index = readFileSync("src/plugins/matrixBridge/index.tsx", "utf8");
const invite = readFileSync("src/plugins/matrixBridge/invite.tsx", "utf8");
const create = readFileSync("src/plugins/matrixBridge/spaceCreate.tsx", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const secureView = readFileSync("src/plugins/matrixBridge/secureView.ts", "utf8");
const suggested = readFileSync("src/plugins/matrixBridge/suggestedChannels.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");

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

const guildPatch = section(index, "const matrixGuildCreateMenuPatch", "const matrixCategoryCreateMenuPatch");
assertOrdered(guildPatch, [
    "if (!guild?.id || !isMatrixGuildId(guild.id)) return;",
    "stockIds: [\"invite-people\"]",
    "stockIds: [\"create-channel\"]",
    "stockIds: [\"create-category\"]",
]);
assert.match(index, /"guild-context": matrixGuildCreateMenuPatch/u);
assert.match(index, /"guild-header-popout": matrixGuildCreateMenuPatch/u);
assert.match(index, /"channel-context": matrixCategoryCreateMenuPatch/u);
assert.match(index, /"user-context": matrixUserInviteToServerMenuPatch/u);
assert.match(index, /"create-text-channel", "create-channel"/u);
assert.match(index, /removeMatrixMenuItems\(children, \["create-voice-channel"\]\)/u);
assert.match(index, /const prefix = "invite-to-server--"/u);
assert.match(index, /typeof nested === "function"/u);
assert.match(index, /filterMatrixMenuTree\(rendered, predicate\)/u);

const replacement = section(index, "function replaceMatrixMenuAction", "function matrixPermissionMenuLabel");
assert.match(replacement, /removeMatrixMenuItems\(children, ids\)/u);
assert.match(replacement, /<Menu\.MenuItem/u);
assert.match(replacement, /icon=\{anchor\?\.props\?\.icon\}/u);
assert.doesNotMatch(replacement, /cloneElement|\.\.\.anchor\??\.props/u,
    "A stock menu element must never carry undocumented callbacks into the replacement.");
assert.match(replacement, /action=\{disabled \? undefined : action\}/u);

for (const label of ["Invite People", "Create Channel", "Create Category"]) {
    assert.ok(guildPatch.includes(`matrixPermissionMenuLabel("${label}"`), `Missing menu label: ${label}`);
}
assert.doesNotMatch(guildPatch, /Create Matrix/u);

const inviteContext = section(bridge, "export interface MatrixInviteContext", "export type MatrixInviteCandidateMembership");
for (const field of ["guildId", "spaceId", "expectedAccountId", "generation", "canInvite", "permission"]) {
    assert.match(inviteContext, new RegExp(`\\b${field}:`, "u"));
}
const inviteBinding = section(bridge, "function sameInviteBinding", "export function getMatrixInviteContext");
for (const field of ["guildId", "spaceId", "expectedAccountId", "generation"]) {
    assert.match(inviteBinding, new RegExp(`left\\.${field} === right!\\.${field}`, "u"));
}
const searchWrapper = section(bridge, "export async function searchMatrixSpaceInviteCandidates", "export async function inviteMatrixUserToSpace");
assertOrdered(searchWrapper, [
    "getCurrentMatrixInviteContext(context)",
    "await Native.searchSpaceInviteCandidates",
    "context.expectedAccountId",
    "getCurrentMatrixInviteContext(context)",
]);
const inviteWrapper = section(bridge, "export async function inviteMatrixUserToSpace", "export async function leaveMatrixGuild");
assertOrdered(inviteWrapper, [
    "getCurrentMatrixInviteContext(context)",
    "await Native.inviteUserToSpace",
    "context.expectedAccountId",
    "getCurrentMatrixInviteContext(context)",
]);
assert.match(bridge, /complete: false,/u);
assert.match(bridge, /queryRequired: response\.queryRequired/u);
assert.match(bridge, /for \(const modalKey of \[\.\.\.matrixManagementModalKeys\]\) closeModal\(modalKey\)/u);
assert.match(bridge, /visibleUserLabel \|\| "Account"/u);
const projectedOwner = section(bridge, "function fallbackGuildOwner", "function rememberSpaceMember");
assert.match(projectedOwner, /while \(id === currentDiscordUserId\)/u);
assert.match(projectedOwner, /protectSyntheticId\(id\)/u);
assert.match(projectedOwner, /username: "server_bridge_placeholder"/u);
assert.match(projectedOwner, /global_name: "Server bridge placeholder"/u);
assert.match(projectedOwner, /bot: true/u);
assert.doesNotMatch(projectedOwner, /rawCurrentUser\(\).*user:|projectedGuildOwner/u);
assert.match(bridge, /const owner = fallbackGuildOwner\(space\)/u);
assert.doesNotMatch(bridge, /owner_id: rawCurrentUser\(\)\.id/u,
    "A projected guild must never grant Discord's implicit owner bypass to the local account.");
const projectedPermissions = section(bridge, "function matrixGuildPermissions", "function accountUserId");
assert.doesNotMatch(projectedPermissions, /ADMINISTRATOR|MANAGE_GUILD|MANAGE_CHANNELS|CREATE_/u);
const localRest = section(bridge, "function localSyntheticRestBody", "function localRestSuccess");
assert.doesNotMatch(localRest, /invites|guilds\/[^\n]*\/channels/u,
    "Synthetic create/invite routes must never be treated as local Discord REST successes.");
const restGuard = section(bridge, "export function installRestGuard", "export function removeRestGuard");
assert.match(restGuard, /containsSyntheticId\(request\)/u);
assert.match(restGuard, /blocked an unsupported synthetic REST request/u);

assert.match(invite, /const \[submittedSearch, setSubmittedSearch\]/u);
assert.match(invite, /disabled=\{Boolean\(contextError\) \|\| loading \|\| Boolean\(activeUserId\)\}/u);
assert.doesNotMatch(invite, /SEARCH_DEBOUNCE|setTimeout\(/u,
    "Typing must not launch overlapping directory requests.");
assert.match(invite, /localState === "ambiguous"/u);
assert.match(invite, /\|\| localState === "ambiguous"/u);
assert.match(invite, /localState === "ambiguous" \? "Unconfirmed"/u);
assert.doesNotMatch(invite, /Check status/u,
    "An ambiguous invite must not expose a second mutation as a status check.");
assert.match(invite, /visibleUserId\(candidate\.userId\)/u);
const visibleDisplayName = section(invite, "function visibleDisplayName", "function MatrixInvitePeopleModal");
assert.match(visibleDisplayName, /UNSAFE_DISPLAY_NAME_PATTERN/u);
assert.match(visibleDisplayName, /\.trim\(\)/u);
assert.doesNotMatch(visibleDisplayName, /candidate\.userId/u);
assert.match(invite, /<strong dir="auto">\{displayName\}<\/strong>/u);
assert.match(invite, /Discord and installed client plugins can read them/u);
assert.match(invite, /registerMatrixManagementModal\(modalKey\)/u);
assert.match(invite, /unregisterMatrixManagementModal\(modalKey\)/u);
assert.doesNotMatch(invite.toLocaleLowerCase("en-US"), /all registered users/u);

const createContext = section(bridge, "export interface MatrixSpaceCreateContext", "export interface MatrixInviteContext");
for (const field of ["guildId", "categoryId", "parentSpaceId", "expectedAccountId", "generation", "permission"]) {
    assert.match(createContext, new RegExp(`\\b${field}\\??:`, "u"));
}
assert.match(create, /expected: MatrixSpaceCreateContext/u);
assert.match(create, /refreshSnapshot\(expected\.generation\)/u);
assert.match(create, /Native\.createSpaceChild\([\s\S]*expected\.expectedAccountId\)/u);
assert.match(create, /Native\.reconcileSpaceChildCreate\([\s\S]*expected\.expectedAccountId/u);
assert.match(create, /Native\.repairSpaceChildLink\([\s\S]*expected\.expectedAccountId/u);
assert.match(create, /registerMatrixManagementModal\(modalKey\)/u);
assert.match(create, /unregisterMatrixManagementModal\(modalKey\)/u);
assert.match(create, /Private channels use end-to-end encryption\./u);
assert.doesNotMatch(create, /New channels use end-to-end encryption/u);
assert.match(create, /MATRIX_CREATE_ROOM_VERSION_UNSUPPORTED/u);
assert.match(create, /cannot create a compatible channel or category\. No item was created\./u);

const settingsAccept = section(settings, "async function acceptInvite", "async function rejectInvite");
assertOrdered(settingsAccept, [
    "const expectedUserId = config?.userId",
    "isCurrentAccount(expectedUserId)",
    "await Native.acceptInvite(roomId, expectedUserId)",
    "accepted = true",
    "isCurrentAccount(expectedUserId)",
    "loadRooms(false, expectedUserId)",
    "if (!accepted || !isCurrentAccount(expectedUserId)) return",
    "setNotice(\"Invitation accepted.\")",
    "warnings.push(\"Rooms could not be refreshed yet",
]);
assert.match(settingsAccept, /MATRIX_DM_CLASSIFICATION_FAILED/u);
assertOrdered(settingsAccept, [
    "await Native.acceptInvite(roomId, expectedUserId)",
    "accepted = true",
    "loadSuggestedChannelPlan(roomId, expectedUserId)",
    "openSuggestedChannelsModal",
]);
const settingsReject = section(settings, "async function rejectInvite", "async function joinHierarchyRoom");
assertOrdered(settingsReject, [
    "const expectedUserId = config?.userId",
    "isCurrentAccount(expectedUserId)",
    "await Native.rejectInvite(roomId, expectedUserId)",
    "declined = true",
    "isCurrentAccount(expectedUserId)",
    "loadRooms(false, expectedUserId)",
    "if (!declined || !isCurrentAccount(expectedUserId)) return",
    "setNotice(\"Invitation declined.\")",
    "Invitation was declined, but rooms could not be refreshed yet",
]);
const secureAccept = section(secureView, "async function acceptInvite", "async function rejectInvite");
assertOrdered(secureAccept, [
    "const expectedUserId = config?.userId",
    "isCurrentSecureAccount(expectedUserId)",
    "await host.request({ type: \"acceptInvite\", roomId })",
    "isCurrentSecureAccount(expectedUserId)",
    "await refresh(false, false, false)",
    "isCurrentSecureAccount(expectedUserId)",
    "Invitation was accepted, but rooms could not be refreshed yet",
    "MATRIX_DM_CLASSIFICATION_FAILED",
    "showSuggestedChannels(roomId, expectedUserId, true)",
]);
const secureReject = section(secureView, "async function rejectInvite", "async function leaveRoom");
assertOrdered(secureReject, [
    "const expectedUserId = config?.userId",
    "isCurrentSecureAccount(expectedUserId)",
    "await host.request({ type: \"rejectInvite\", roomId })",
    "isCurrentSecureAccount(expectedUserId)",
    "await refresh(false, false, false)",
    "isCurrentSecureAccount(expectedUserId)",
    "Invitation was declined, but rooms could not be refreshed yet",
]);
const privateInviteMutation = section(native, "async function runPrivateRoomInviteMutation", "function secureViewSecurityState");
assertOrdered(privateInviteMutation, [
    "const result = await mutation()",
    "await bestEffortMutationRefresh(event, state)",
    "return result",
]);

const settingsJoin = section(settings, "async function joinPublicRoom", "async function joinRoomByAddress");
assertOrdered(settingsJoin, [
    "const expectedUserId = config?.userId",
    "isCurrentAccount(expectedUserId)",
    "await Native.joinRoom(room.roomId, expectedUserId)",
    "joined = true",
    "isCurrentAccount(expectedUserId)",
]);
const settingsAddressJoin = section(settings, "async function joinRoomByAddress", "async function requestAccess");
assertOrdered(settingsAddressJoin, [
    "const expectedUserId = config?.userId",
    "isCurrentAccount(expectedUserId)",
    "await Native.joinRoomAddress(address, expectedUserId)",
    "isCurrentAccount(expectedUserId)",
    "loadRooms(false, expectedUserId)",
]);
assert.match(settings, /MATRIX_ROOM_ADDRESS_PATTERN/u);
assert.match(settingsAddressJoin, /address\.length > 512/u);
assert.match(settings, /domainless room ID such as !opaque/u);
const settingsHierarchyJoin = section(settings, "async function joinHierarchyRoom", "async function finishCreatedSpace");
assertOrdered(settingsHierarchyJoin, [
    "const expectedUserId = config?.userId",
    "isCurrentAccount(expectedUserId)",
    "await Native.joinRoom(room.roomId, expectedUserId)",
    "joined = true",
    "isCurrentAccount(expectedUserId)",
    "loadRooms(false, expectedUserId)",
]);
assert.doesNotMatch(settings, /Native\.joinRoom(?:Address)?\([^,\n]+\)/u,
    "Every generic join mutation must include a captured expected account.");
const settingsCreateServer = section(settings, "async function createServer", "return (");
assertOrdered(settingsCreateServer, [
    "isCurrentAccount(expectedUserId)",
    "await Native.createSpace",
    "expectedUserId",
    "isCurrentAccount(expectedUserId)",
]);
assert.match(settings, /MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS/u);
assert.match(settings, /general chat result could not be confirmed and an unlinked chat may exist/u);
const ambiguousRootCreate = section(settings, "async function resolveAmbiguousSpaceCreation", "function openCreateMatrixServer");
assert.match(ambiguousRootCreate, /setSpaceCreationNeedsRefresh\(true\)/u);
assert.match(ambiguousRootCreate, /matching names do not confirm which server was created/u);
assert.match(ambiguousRootCreate, /return false/u);
assert.doesNotMatch(ambiguousRootCreate, /existingSpaceIds|roomName\(|openMatrixSpace\(|createdSpace/u,
    "An ambiguous root creation must never be resolved from a same-name Space appearing in sync.");

const secureJoin = section(secureView, "async function joinRoom", "async function joinAddress");
assertOrdered(secureJoin, [
    "const expectedUserId = config?.userId",
    "isCurrentSecureAccount(expectedUserId)",
    "await host.request({ type: \"joinRoom\", roomId })",
    "isCurrentSecureAccount(expectedUserId)",
    "await refresh(false, false, false)",
]);
assert.match(secureJoin, /MATRIX_ROOM_JOIN_AMBIGUOUS/u);
const secureAddressJoin = section(secureView, "async function joinAddress", "function clearSuggestedChannelOverlayState");
assertOrdered(secureAddressJoin, [
    "const expectedUserId = config?.userId",
    "isCurrentSecureAccount(expectedUserId)",
    "await host.request({ type: \"joinRoomAddress\"",
    "isCurrentSecureAccount(expectedUserId)",
    "await refresh(false, false, false)",
]);
assert.match(secureAddressJoin, /MATRIX_ROOM_ADDRESS_PATTERN\.test\(normalizedAddress\)/u);
assert.match(secureView, /address\.maxLength = 512/u);
const secureCreateServer = section(secureView, "function renderCreateSpaceOverlay", "function setSelectOptions");
assertOrdered(secureCreateServer, [
    "const expectedUserId = config?.userId",
    "isCurrentSecureAccount(expectedUserId)",
    "type: \"createSpace\"",
    "isCurrentSecureAccount(expectedUserId)",
]);
assert.match(secureCreateServer, /may have been created, but the result could not be confirmed/u);
assert.match(secureCreateServer, /MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS/u);
assert.match(secureCreateServer, /general chat result is unconfirmed and an unlinked chat may exist/u);
assert.match(secureView, /renderSuggestedChannelsOverlay\(\)/u);
assert.match(secureView, /overlay === "directMessage" \? renderDirectMessageOverlay\(\) : renderSuggestedChannelsOverlay\(\)/u);
assert.match(secureView, /renderModal\("Join Suggested Channels\?", body, \[submit\], suggestedChannelJoinBusy\)/u);

assert.match(suggested, /\\u0000-\\u001f\\u007f\\u061c/u);
assert.match(suggested, /Already joined \$\{kindLabel/u);
assert.match(suggested, /bounded provider suggestion list, not a complete server channel list/u);
const planWait = section(suggested, "export async function waitForSuggestedChannelPlan", "export function safeSuggestedChannelText");
assertOrdered(planWait, [
    "const deadline = Date.now() + SUGGESTED_PLAN_SYNC_TIMEOUT_MS",
    "const remaining = deadline - Date.now()",
    "const operation = Promise.resolve().then(load)",
    "Promise.race",
    "setTimeout(() => resolve(undefined), remaining)",
    "void operation.catch(() => undefined)",
]);
assert.match(settings, /MATRIX_ROOM_NOT_JOINED/u);
assert.match(settings, /Suggested Channels/u);

console.log("Matrix invite/create renderer contracts passed.");
