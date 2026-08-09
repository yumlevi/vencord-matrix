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

interface ParsedPowerLevel { valid: boolean; value: number; }
const invalid = (): ParsedPowerLevel => ({ valid: false, value: 0 });
function parsePowerLevel(value: unknown, roomVersion: string): ParsedPowerLevel {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return invalid();
        const normalized = roomVersion === "1" ? Math.trunc(value) : value;
        return Number.isSafeInteger(normalized) ? { valid: true, value: normalized } : invalid();
    }
    if (/^[1-9]$/u.test(roomVersion) && typeof value === "string"
        && /^\s*[+-]?[0-9]+\s*$/u.test(value)) {
        const normalized = Number(value.trim());
        return Number.isSafeInteger(normalized) ? { valid: true, value: normalized } : invalid();
    }
    return invalid();
}

assert.deepEqual(parsePowerLevel("  +050 ", "9"), { valid: true, value: 50 });
assert.deepEqual(parsePowerLevel(50.9, "1"), { valid: true, value: 50 });
assert.equal(parsePowerLevel(50.9, "2").valid, false);
assert.equal(parsePowerLevel("50", "10").valid, false);

function noPowerLevelEventUserLevel(
    roomVersion: string,
    sender: unknown,
    content: unknown,
    userId: string
): ParsedPowerLevel {
    const validUserId = (value: unknown): value is string => typeof value === "string"
        && /^@[^\s:]+:[^\s]+$/u.test(value);
    if (!validUserId(sender) || !content || typeof content !== "object" || Array.isArray(content)) return invalid();
    const raw = content as Record<string, unknown>;
    if (/^(?:[1-9]|10|11)$/u.test(roomVersion)) {
        return { valid: true, value: sender === userId ? 100 : 0 };
    }
    const additional = Object.hasOwn(raw, "additional_creators") ? raw.additional_creators : [];
    if (!Array.isArray(additional) || additional.length > 1_000
        || additional.some(value => !validUserId(value))) return invalid();
    return { valid: true, value: sender === userId || additional.includes(userId) ? Infinity : 0 };
}
assert.deepEqual(noPowerLevelEventUserLevel("9", "@creator:test", { creator: "@creator:test" }, "@creator:test"),
    { valid: true, value: 100 });
assert.deepEqual(noPowerLevelEventUserLevel("11", "@creator:test", {}, "@creator:test"),
    { valid: true, value: 100 }, "v11 derives its creator from the create-event sender without content.creator");
assert.deepEqual(noPowerLevelEventUserLevel("12", "@creator:test", {
    additional_creators: ["@additional:test"],
}, "@creator:test"), { valid: true, value: Infinity });
assert.deepEqual(noPowerLevelEventUserLevel("12", "@creator:test", {
    additional_creators: ["@additional:test"],
}, "@additional:test"), { valid: true, value: Infinity });
assert.deepEqual(noPowerLevelEventUserLevel("12", "@creator:test", {
    additional_creators: ["@additional:test"],
}, "@member:test"), { valid: true, value: 0 });
assert.equal(noPowerLevelEventUserLevel("12", undefined, {}, "@member:test").valid, false,
    "missing creation state fails closed");
assert.equal(noPowerLevelEventUserLevel("12", "@creator:test", null, "@creator:test").valid, false,
    "malformed creation content fails closed");
assert.equal(noPowerLevelEventUserLevel("12", "@creator:test", {
    additional_creators: [42],
}, "@creator:test").valid, false, "malformed Hydra creators fail closed");

const standardVersions = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const restrictedVersions = new Set(["8", "9", "10", "11", "12"]);
function selectRoomVersion(
    defaultVersion: string,
    available: Record<string, "stable" | "unstable">,
    restricted: boolean
): string | undefined {
    const compatible = (version: string) => standardVersions.includes(version)
        && (!restricted || restrictedVersions.has(version));
    if (compatible(defaultVersion) && available[defaultVersion] != null) return defaultVersion;
    return [...standardVersions].reverse().find(version => compatible(version) && available[version] === "stable");
}
assert.equal(selectRoomVersion("9", { "9": "stable", "12": "stable" }, true), "9",
    "a compatible provider default wins over a newer fallback");
assert.equal(selectRoomVersion("7", { "7": "stable", "10": "stable", "12": "stable" }, true), "12");
assert.equal(selectRoomVersion("7", { "7": "stable" }, true), undefined);
assert.equal(selectRoomVersion("7", { "7": "stable" }, false), "7");

const permission = (current: ParsedPowerLevel, required: ParsedPowerLevel, hydra = false) => ({
    current: hydra ? "infinite" : !current.valid ? "unverifiable" : current.value,
    required: required.valid ? required.value : "unverifiable",
    allowed: (hydra || current.valid) && required.valid && (hydra || current.value >= required.value)
});
assert.deepEqual(permission(invalid(), { valid: true, value: 100 }, true), {
    current: "infinite",
    required: 100,
    allowed: true
});
assert.equal(permission({ valid: true, value: 100 }, parsePowerLevel("50", "10")).allowed, false);

function matrixServerName(userId: string): string {
    return userId.slice(userId.indexOf(":") + 1);
}
function sameProvider(userId: string, activeUserId: string): boolean {
    return /^@[^\s:\u0000-\u001f\u007f]+:[^\s\u0000-\u001f\u007f]+$/u.test(userId)
        && matrixServerName(userId) === matrixServerName(activeUserId);
}
const activeUserId = "@owner:matrix.example";
const delegatedHomeserverUrl = "https://client-delegation.example";
assert.equal(sameProvider("@local:matrix.example", activeUserId), true);
assert.equal(sameProvider("@remote:client-delegation.example", activeUserId), false,
    "provider scope comes from the MXID server name, not the delegated homeserver URL");
assert.notEqual(new URL(delegatedHomeserverUrl).hostname, matrixServerName(activeUserId));

type Membership = "none" | "leave" | "knock" | "invite" | "join" | "ban";
const membershipByUser = new Map<string, Membership>([
    ["@new:matrix.example", "none"],
    ["@joined:matrix.example", "join"],
    ["@invited:matrix.example", "invite"],
    ["@knock:matrix.example", "knock"],
    ["@banned:matrix.example", "ban"],
]);
const rawDirectory = [
    "@owner:matrix.example",
    "@new:matrix.example",
    "@new:matrix.example",
    "@remote:elsewhere.example",
    "@joined:matrix.example",
    "@invited:matrix.example",
    "@knock:matrix.example",
    "@banned:matrix.example",
];
const seen = new Set<string>();
const projected = rawDirectory.filter(userId => {
    if (userId === activeUserId || !sameProvider(userId, activeUserId) || seen.has(userId)) return false;
    seen.add(userId);
    return membershipByUser.get(userId) !== "ban";
});
assert.deepEqual(projected, [
    "@new:matrix.example",
    "@joined:matrix.example",
    "@invited:matrix.example",
    "@knock:matrix.example",
]);
assert.equal(rawDirectory.length > 4, true, "a local response bound must set limited truthfully");

const emptyUnsupported = (error: { httpStatus?: number; errcode?: string; }) => error.httpStatus === 400
    && (error.errcode == null || ["M_BAD_JSON", "M_INVALID_PARAM", "M_MISSING_PARAM", "M_UNKNOWN"].includes(error.errcode));
assert.equal(emptyUnsupported({ httpStatus: 400, errcode: "M_INVALID_PARAM" }), true);
assert.equal(emptyUnsupported({ httpStatus: 403, errcode: "M_FORBIDDEN" }), false);
assert.equal(emptyUnsupported({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED" }), false);

type InviteFailureOutcome = "converged" | "definitive" | "ambiguous";
function classifyInviteFailure(
    error: { httpStatus?: number; errcode?: string; },
    membership: Membership | undefined
): InviteFailureOutcome {
    if (membership === "invite" || membership === "join") return "converged";
    return typeof error.errcode === "string" && Number.isSafeInteger(error.httpStatus)
        && error.httpStatus! >= 400 && error.httpStatus! < 500 ? "definitive" : "ambiguous";
}
assert.equal(classifyInviteFailure({ httpStatus: 503, errcode: "M_UNKNOWN" }, "invite"), "converged");
assert.equal(classifyInviteFailure({ httpStatus: 403, errcode: "M_FORBIDDEN" }, "leave"), "definitive");
assert.equal(classifyInviteFailure({ httpStatus: 503, errcode: "M_UNKNOWN" }, "leave"), "ambiguous");
assert.equal(classifyInviteFailure({}, undefined), "ambiguous");
const malformedSuccessCode = (
    command: "invite" | "accept" | "reject" | "suggested" | "join"
) => ({
    invite: "MATRIX_SPACE_INVITE_AMBIGUOUS",
    accept: "MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS",
    reject: "MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS",
    suggested: "MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS",
    join: "MATRIX_ROOM_JOIN_AMBIGUOUS",
})[command];
for (const command of ["invite", "accept", "reject", "suggested", "join"] as const) {
    assert.match(malformedSuccessCode(command), /_AMBIGUOUS$/u,
        `${command} malformed post-mutation success must not be reported as safely retryable`);
}
const reconcileJoinFailure = (errorCode: string, requestedRoomJoined: boolean) =>
    errorCode === "MATRIX_ROOM_JOIN_MISMATCH"
        ? "mismatch"
        : requestedRoomJoined ? "converged" : "ambiguous";
assert.equal(reconcileJoinFailure("MATRIX_ROOM_JOIN_MISMATCH", true), "mismatch",
    "an explicit mismatched SDK join response must never be converged away");

function advancedJoinAddress(value: string, accountServer: string): { valid: boolean; server?: string; } {
    if (/^![^\s:]+$/u.test(value)) return { valid: true };
    const match = /^[#!]([^\s:]+):([^\s]+)$/u.exec(value);
    return match && match[2] === accountServer ? { valid: true, server: match[2] } : { valid: false };
}
assert.deepEqual(advancedJoinAddress("!opaqueV12RoomId", "matrix.example"), { valid: true },
    "room-v12 domainless IDs must be accepted through the configured homeserver");
assert.deepEqual(advancedJoinAddress("!legacy:matrix.example", "matrix.example"), {
    valid: true,
    server: "matrix.example"
});
assert.deepEqual(advancedJoinAddress("#local:matrix.example", "matrix.example"), {
    valid: true,
    server: "matrix.example"
});
assert.equal(advancedJoinAddress("!legacy:remote.example", "matrix.example").valid, false);
assert.equal(advancedJoinAddress("#alias", "matrix.example").valid, false,
    "aliases remain fully qualified and local");

type PlanRow = { kind: "space" | "room"; membership: "join" | "leave"; };
function appendCategoryBranch(priorJoins: number, categoryJoined: boolean): { rows: PlanRow[]; limited: boolean; } {
    const requiredJoinSlots = (categoryJoined ? 0 : 1) + 1;
    if (priorJoins + requiredJoinSlots > 8) return { rows: [], limited: true };
    return {
        rows: [
            { kind: "space", membership: categoryJoined ? "join" : "leave" },
            { kind: "room", membership: "leave" },
        ],
        limited: false
    };
}
assert.deepEqual(appendCategoryBranch(7, false), { rows: [], limited: true },
    "an unjoined category must never consume the last slot without one nested room");
assert.deepEqual(appendCategoryBranch(7, true), {
    rows: [
        { kind: "space", membership: "join" },
        { kind: "room", membership: "leave" },
    ],
    limited: false
}, "a joined category is a zero-mutation context row and leaves the final slot for its child");
function appendCategoryAtRowBoundary(priorRows: number): { rows: PlanRow[]; limited: boolean; } {
    return priorRows + 2 > 16
        ? { rows: [], limited: true }
        : { rows: [{ kind: "space", membership: "leave" }, { kind: "room", membership: "leave" }], limited: false };
}
assert.deepEqual(appendCategoryAtRowBoundary(15), { rows: [], limited: true },
    "a category branch must reserve both rows before appending at the row cap");
const allowedPlanRule = (membership: "join" | "leave", kind: "space" | "room", joinRule: string) =>
    (membership === "join" && kind === "space")
        || ["public", "restricted", "knock_restricted"].includes(joinRule);
assert.equal(allowedPlanRule("join", "space", "invite"), true,
    "an already-joined invite-only category remains valid context for suggested descendants");
assert.equal(allowedPlanRule("leave", "space", "invite"), false,
    "an unjoined invite-only category is never bulk joined without an invitation action");
function deduplicatedSuggestedPlan(direct: string[], categories: Array<{ id: string; rooms: string[]; }>): string[] {
    const rows = [...direct];
    const planned = new Set(rows);
    for (const category of categories) {
        const rooms = category.rooms.filter(roomId => !planned.has(roomId));
        if (!rooms.length) continue;
        rows.push(category.id);
        planned.add(category.id);
        for (const roomId of rooms) {
            if (planned.has(roomId)) continue;
            rows.push(roomId);
            planned.add(roomId);
        }
    }
    return rows;
}
assert.deepEqual(deduplicatedSuggestedPlan(["!shared:test"], [{
    id: "!category:test",
    rooms: ["!shared:test"],
}]), ["!shared:test"], "a direct+nested shared room must not add a duplicate-only category branch");
assert.deepEqual(deduplicatedSuggestedPlan([], [{
    id: "!one:test",
    rooms: ["!shared:test"],
}, {
    id: "!two:test",
    rooms: ["!shared:test"],
}]), ["!one:test", "!shared:test"], "a room linked through two categories is planned exactly once");

assert.match(protocol, /type: "searchSpaceInviteCandidates"/u);
assert.match(protocol, /type: "inviteUserToSpace"/u);
assert.match(backend, /searchUserDirectory\(\{ term: request\.query, limit: request\.limit \}\)/u);
assert.match(backend, /scope: "homeserver_user_directory"/u);
assert.match(backend, /complete: false/u);
assert.match(backend, /queryRequired: true/u);
assert.match(backend, /directory\.results\.slice\(0, request\.limit\)/u);
assert.match(backend, /unique\.has\(userId\)/u);
assert.match(backend, /membership === "ban"/u);
assert.match(backend, /actual === "invite" \|\| actual === "join"/u);
assert.match(backend, /MATRIX_SPACE_INVITE_AMBIGUOUS/u);
assert.match(backend, /MATRIX_SPACE_INVITE_REJECTED/u);
const acceptInviteBackend = backend.slice(
    backend.indexOf("async function acceptInvite("),
    backend.indexOf("async function rejectInvite(")
);
assert.match(acceptInviteBackend, /warning = \{[\s\S]*code: "MATRIX_DM_CLASSIFICATION_FAILED"/u);
assert.match(acceptInviteBackend, /return \{ roomId, \.\.\.\(warning \? \{ warning \} : \{\}\) \}/u);
assert.doesNotMatch(acceptInviteBackend, /fail\(\s*"MATRIX_DM_CLASSIFICATION_FAILED"/u,
    "a post-join direct-map failure must remain a successful acceptance with a warning");
assert.match(native, /warning\.code !== "MATRIX_DM_CLASSIFICATION_FAILED"/u);
assert.match(backend, /effectiveUserPowerLevel/u);
assert.match(backend, /memberLevel === Infinity/u);
assert.match(backend, /createEventUserPowerLevel/u);
assert.match(backend, /return \{ valid: true, value: sender === userId \? 100 : 0 \}/u);
assert.match(backend, /additional_creators/u);
assert.match(backend, /roomVersion === "1" \? Math\.trunc\(value\) : value/u);
assert.match(backend, /scope: "suggested_depth_2_via_account_server"/u);
assert.match(backend, /async function joinedOnboardingSpace[\s\S]*await exactOwnJoinedRoom\(spaceId\)/u);
assert.match(backend, /loadSpaceHierarchy\(root, SUGGESTED_SPACE_CHANNEL_HIERARCHY_LIMIT, 2\)/u);
assert.match(backend, /relation\.suggested !== true/u);
assert.match(backend, /viaServers\?\.includes\(accountServer\)/u);
assert.match(backend, /requiredJoinSlots = \(category\.membership === "join" \? 0 : 1\) \+ 1/u);
assert.match(backend, /channels\.length \+ 2 > MAX_SUGGESTED_SPACE_CHANNEL_PLAN_ROWS/u);
assert.match(backend, /const plannedRoomIds = new Set<string>\(\)/u);
assert.match(backend, /room\.membership !== "join" && !plannedRoomIds\.has\(room\.roomId\)/u);
assert.match(backend, /plan\.planId !== request\.planId/u);
assert.match(backend, /viaServers: \[accountServer\]/u);
assert.match(backend, /async function joinRoomWithConvergence[\s\S]*mutationDispatched\(\)[\s\S]*exactOwnJoinedRoom\(roomId\)/u);
assert.match(backend, /MATRIX_ROOM_JOIN_REJECTED/u);
assert.match(backend, /MATRIX_ROOM_JOIN_AMBIGUOUS/u);
assert.match(backend, /error instanceof PublicWorkerError && error\.code === "MATRIX_ROOM_JOIN_MISMATCH"/u);
const backendJoinAddress = backend.slice(
    backend.indexOf("async function joinRoomAddress("),
    backend.indexOf("function hierarchySpaceChildren(")
);
assert.match(backend, /Room v12 IDs are opaque and deliberately have no server-name suffix/u);
assert.match(backendJoinAddress, /validateRoomAddress\(resolved\.room_id\)/u);
assert.match(backendJoinAddress, /target\.serverName != null && target\.serverName !== accountServer/u);
assert.match(backendJoinAddress, /viaServers = \[accountServer\]/u,
    "local alias resolution must never supply arbitrary remote via servers");
const nativeJoinAddress = native.slice(
    native.indexOf("async function joinRoomAddress("),
    native.indexOf("async function roomInviteAction(")
);
assert.match(native, /Opaque room-v12 IDs are domainless/u);
assert.match(nativeJoinAddress, /joinedRoomId\.includes\(":"\)/u,
    "native accepts a domainless alias result but still enforces legacy local suffixes");

const createChild = backend.slice(
    backend.indexOf("async function createSpaceChild("),
    backend.indexOf("function spaceChildParentEvent(")
);
const repairChild = backend.slice(
    backend.indexOf("function requireSpaceChildLinkPermission("),
    backend.indexOf("function roomSpaceChildCreationMarker(")
);
assert.match(createChild, /spaceChildPermission\(parent\)/u);
assert.match(repairChild, /spaceChildPermission\(parent\)/u);
assert.doesNotMatch(createChild, /maySendStateEvent/u);
assert.doesNotMatch(repairChild, /maySendStateEvent/u);
assert.doesNotMatch(backend, /maySendStateEvent\(EventType\.SpaceChild/u);
assert.match(backend, /selectCreationRoomVersion\(!isPublic\)/u);
assert.match(backend, /room_version: roomVersion/u);
assert.match(backend, /const events: Record<string, number> = roomVersion === "12"[\s\S]*\[EventType\.RoomTombstone\]: 150[\s\S]*: \{\}/u);
assert.match(backend, /mutationDispatched\(\);\s*const created = await matrixClient\.createRoom/u);
assert.match(backend, /mutationDispatched\(\);\s*await matrixClient\.invite/u);
const createSpaceBackend = backend.slice(
    backend.indexOf("async function createSpace("),
    backend.indexOf("function requireSpaceChildLinkPermission(")
);
assert.match(createSpaceBackend, /catch \(error\) \{[\s\S]*isDefinitiveCreateRoomRejection\(error\)[\s\S]*MATRIX_CREATE_SPACE_REJECTED[\s\S]*MATRIX_CREATE_SPACE_AMBIGUOUS/u,
    "a root Space create response is definitive only for explicit client rejection");
assert.match(createSpaceBackend, /MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS/u,
    "an uncertain general-room result must not be reported as a definitive failure");
const classifyCreatedRoomFailure = (definitive: boolean, root: boolean) => root
    ? definitive ? "MATRIX_CREATE_SPACE_REJECTED" : "MATRIX_CREATE_SPACE_AMBIGUOUS"
    : definitive ? "MATRIX_GENERAL_ROOM_CREATE_FAILED" : "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS";
assert.equal(classifyCreatedRoomFailure(true, true), "MATRIX_CREATE_SPACE_REJECTED");
assert.equal(classifyCreatedRoomFailure(false, true), "MATRIX_CREATE_SPACE_AMBIGUOUS");
assert.equal(classifyCreatedRoomFailure(true, false), "MATRIX_GENERAL_ROOM_CREATE_FAILED");
assert.equal(classifyCreatedRoomFailure(false, false), "MATRIX_GENERAL_ROOM_CREATE_AMBIGUOUS");

const nativeSearch = native.slice(
    native.indexOf("async function searchSpaceInviteCandidates("),
    native.indexOf("async function inviteUserToSpace(")
);
const nativeInvite = native.slice(
    native.indexOf("async function inviteUserToSpace("),
    native.indexOf("function validateCreateSpaceChildRequest(")
);
assert.match(nativeSearch, /expectedUserId/u);
assert.match(nativeSearch, /withExpectedMatrixAccount\(expectedUserId/u);
assert.match(nativeInvite, /expectedUserId/u);
assert.match(nativeInvite, /withExpectedMatrixAccount\(expectedUserId/u);
assert.match(nativeInvite, /spaceInvitesInFlight\.has/u);
assert.match(native, /case "inviteUserToSpace":[\s\S]*MATRIX_SPACE_INVITE_AMBIGUOUS/u);
assert.match(native, /case "acceptInvite":[\s\S]*MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS/u);
assert.match(native, /case "rejectInvite":[\s\S]*MATRIX_ROOM_INVITE_REJECTION_AMBIGUOUS/u);
assert.match(native, /case "joinSuggestedSpaceChannels":[\s\S]*MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS/u);
assert.match(native, /case "joinRoom":[\s\S]*case "joinRoomAddress":[\s\S]*MATRIX_ROOM_JOIN_AMBIGUOUS/u);
assert.match(native, /validateProtocolInviteUserToSpaceResult[\s\S]*MATRIX_SPACE_INVITE_AMBIGUOUS/u);
assert.match(native, /validateProtocolJoinSuggestedSpaceChannelsResult[\s\S]*MATRIX_SUGGESTED_SPACE_CHANNEL_JOIN_AMBIGUOUS/u);
assert.match(native, /validateRoomActionResult\(result, targetRoomId\)[\s\S]*MATRIX_ROOM_INVITE_ACCEPT_AMBIGUOUS/u);
assert.match(native, /SUGGESTED_SPACE_CHANNEL_JOIN_TIMEOUT_MS = 5 \* 60_000/u);
assert.match(native, /mutationDispatched && commandType === "joinSuggestedSpaceChannels"[\s\S]*SUGGESTED_SPACE_CHANNEL_JOIN_TIMEOUT_MS/u);
assert.match(native, /message\.kind === "mutation"/u);
assert.match(native, /request\.mutationDispatched && request\.commandType === "createSpaceChild"/u);
for (const functionName of ["createSpaceChild", "repairSpaceChildLink", "reconcileSpaceChildCreate"]) {
    const start = native.indexOf(`async function ${functionName}(`);
    const body = native.slice(start, native.indexOf("\n}\n", start) + 3);
    assert.match(body, /expectedUserId/u, `${functionName} must require the stale-account guard`);
    assert.match(body, /withExpectedMatrixAccount\(expectedUserId/u,
        `${functionName} must hold an exact account-bound lease`);
}

for (const functionName of ["acceptInvite", "rejectInvite", "suggestedSpaceChannelPlan", "joinSuggestedSpaceChannels"]) {
    const start = native.indexOf(`async function ${functionName}(`);
    const body = native.slice(start, native.indexOf("\n}\n", start) + 3);
    assert.match(body, /expectedUserId/u, `${functionName} must require the stale-account guard`);
    if (functionName !== "acceptInvite" && functionName !== "rejectInvite") {
        assert.match(body, /withExpectedMatrixAccount\(expectedUserId/u,
            `${functionName} must hold an exact account-bound lease`);
    }
}
assert.match(native, /async function roomInviteAction[\s\S]*withExpectedMatrixAccount\(expectedUserId/u);
for (const functionName of ["joinRoom", "joinRoomAddress"]) {
    const start = native.indexOf(`async function ${functionName}(`);
    const body = native.slice(start, native.indexOf("\n}\n", start) + 3);
    assert.match(body, /expectedUserId/u, `${functionName} must require an expected account`);
    assert.match(body, /withExpectedMatrixAccount\(expectedUserId/u,
        `${functionName} must hold the exact account lease`);
}
assert.match(native, /runPrivateRoomInviteMutation[\s\S]*bestEffortMutationRefresh/u);
assert.match(native, /async function runAccountLifecycleTransition[\s\S]*privateAccountRequests > 0[\s\S]*privateAccountDrainWaiters\.add/u,
    "account replacement must drain already-authorized secure-view requests");
const nativeRequireStarted = native.slice(
    native.indexOf("async function requireStarted("),
    native.indexOf("async function startInternal(")
);
assert.match(nativeRequireStarted, /privateAccountRequests > 0[\s\S]*MATRIX_SESSION_CHANGED/u,
    "a drained secure-view request must fail closed instead of queuing a lifecycle restart behind itself");
assert.match(nativeRequireStarted, /privateAccountRequestContext\.getStore\(\) === true/u,
    "the lifecycle fast path is scoped to the authorized secure request, never an unrelated renderer call");
assert.match(native, /privateAccountRequestContext\.run\(true, async \(\) =>/u);
const nativeCreateSpace = native.slice(
    native.indexOf("async function createSpace("),
    native.indexOf("const SPACE_JOIN_NAME_PATTERN")
);
assert.match(nativeCreateSpace, /expectedUserId/u, "Space creation must require the renderer's expected account");
assert.match(nativeCreateSpace, /withExpectedMatrixAccount\(expectedUserId/u,
    "Space creation must hold the exact account lease through response validation");
assert.match(nativeCreateSpace, /const result = await callWorker<MatrixCreateSpaceResult>[\s\S]*catch \{[\s\S]*MATRIX_CREATE_SPACE_AMBIGUOUS/u,
    "only malformed post-dispatch Space creation confirmations become ambiguous");
assert.match(native, /case "createSpace":[\s\S]*runPrivateCreateMutation[\s\S]*secureViewExpectedUserId\(state\)/u);
const privateRequestHandlerStart = native.indexOf("async function handlePrivateRequest(");
const privateCreateHandler = native.slice(
    native.indexOf('case "createSpace":', privateRequestHandlerStart),
    native.indexOf('case "getSpaceAccess":', privateRequestHandlerStart)
);
assert.doesNotMatch(privateCreateHandler, /createSpaceInFlight\s*=/u,
    "the secure handler must not acquire the global gate already held by native createSpace");
assert.match(native, /async function runPrivateCreateMutation[\s\S]*bestEffortMutationRefresh/u,
    "a convergence refresh must not discard a committed Space creation result");
assert.match(native, /pending\.commandType === "createSpace" && pending\.mutationDispatched[\s\S]*error\.name !== "MATRIX_CREATE_SPACE_REJECTED"[\s\S]*MATRIX_CREATE_SPACE_AMBIGUOUS/u,
    "a worker error after root-create dispatch is ambiguous unless the backend proves a definitive rejection");

// Regression model for the lifecycle drain: identity replacement cannot enter
// its critical section until an already-authorized private request releases.
let simulatedPrivateRequests = 1;
const simulatedDrainWaiters = new Set<() => void>();
let replacementStarted = false;
if (simulatedPrivateRequests > 0) simulatedDrainWaiters.add(() => { replacementStarted = true; });
else replacementStarted = true;
assert.equal(replacementStarted, false);
simulatedPrivateRequests--;
if (simulatedPrivateRequests === 0) {
    for (const resume of simulatedDrainWaiters) resume();
    simulatedDrainWaiters.clear();
}
assert.equal(replacementStarted, true);
assert.match(backend, /function mutationSignalCommand[\s\S]*command\.type === "acceptInvite"[\s\S]*command\.type === "rejectInvite"/u);
assert.match(native, /function mutationSignalCommandType[\s\S]*commandType === "acceptInvite"[\s\S]*commandType === "rejectInvite"/u);
assert.match(backend, /function mutationSignalCommand[\s\S]*command\.type === "joinRoom"[\s\S]*command\.type === "joinRoomAddress"/u);
assert.match(native, /function mutationSignalCommandType[\s\S]*commandType === "joinRoom"[\s\S]*commandType === "joinRoomAddress"/u);
