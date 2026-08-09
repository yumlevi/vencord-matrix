/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const accessRequests = readFileSync("src/plugins/matrixBridge/accessRequests.tsx", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");

const joinNamePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
for (const value of ["a", "0", "space", "a.b", "a_b", "a-b", "a".repeat(64)]) {
    assert.equal(joinNamePattern.test(value), true, `${value} must be a valid Space join name`);
}
for (const value of ["", "A", "-a", "a-", ".a", "a.", "a:b", "a b", "a".repeat(65)]) {
    assert.equal(joinNamePattern.test(value), false, `${value} must be rejected as a Space join name`);
}
assert.match(backend, /const SPACE_JOIN_NAME_PATTERN = \/\^\[a-z0-9\]/u);
assert.match(native, /const SPACE_JOIN_NAME_PATTERN = \/\^\[a-z0-9\]/u);

type JoinRule = "public" | "invite" | "knock" | "restricted" | "knock_restricted" | "private";
const accessMode = (joinRule: JoinRule) => joinRule === "public"
    ? "public"
    : joinRule === "knock" || joinRule === "knock_restricted" ? "request" : "invite";
assert.equal(accessMode("public"), "public");
assert.equal(accessMode("knock"), "request");
assert.equal(accessMode("knock_restricted"), "request");
for (const rule of ["invite", "restricted", "private"] as const) assert.equal(accessMode(rule), "invite");

interface ParsedPowerLevel { valid: boolean; value: number; }
function parsePowerLevel(value: unknown, roomVersion: string): ParsedPowerLevel {
    if (typeof value === "number" && Number.isFinite(value)) {
        const normalized = roomVersion === "1" ? Math.trunc(value) : value;
        return Number.isSafeInteger(normalized) ? { valid: true, value: normalized } : { valid: false, value: 0 };
    }
    if (/^[1-9]$/u.test(roomVersion) && typeof value === "string" && /^\s*[+-]?[0-9]+\s*$/u.test(value)) {
        const normalized = Number(value.trim());
        if (Number.isSafeInteger(normalized)) return { valid: true, value: normalized };
    }
    return { valid: false, value: 0 };
}
function permissions(
    content: Record<string, unknown>,
    sender: string,
    target?: string,
    roomVersion = "11",
    hydraTarget = false
) {
    const field = (key: string, fallback: number) => Object.hasOwn(content, key)
        ? parsePowerLevel(content[key], roomVersion)
        : { valid: true, value: fallback };
    const usersDefault = field("users_default", 0);
    const users = Object.hasOwn(content, "users") && content.users && typeof content.users === "object"
        && !Array.isArray(content.users) ? content.users as Record<string, unknown> : undefined;
    const level = (userId: string) => !usersDefault.valid
        ? usersDefault
        : users && Object.hasOwn(users, userId) ? parsePowerLevel(users[userId], roomVersion) : usersDefault;
    const senderLevel = level(sender);
    const targetLevel = target == null ? undefined : hydraTarget ? { valid: true, value: Infinity } : level(target);
    const invite = field("invite", 0);
    const kick = field("kick", 50);
    if (!senderLevel.valid || !invite.valid || !kick.valid || targetLevel?.valid === false) {
        return { approve: false, deny: false };
    }
    return {
        approve: senderLevel.value >= invite.value,
        deny: senderLevel.value >= kick.value
            && (targetLevel == null || senderLevel.value > targetLevel.value)
    };
}
assert.deepEqual(permissions({}, "@moderator:test", "@target:test"), { approve: true, deny: false });
assert.deepEqual(
    permissions({ users: { "@moderator:test": 50 } }, "@moderator:test", "@target:test"),
    { approve: true, deny: true }
);
assert.equal(
    permissions({ users: { "@moderator:test": 50, "@target:test": 50 } }, "@moderator:test", "@target:test").deny,
    false,
    "a sender at the target's level must not deny the target"
);
assert.deepEqual(
    permissions({ invite: 75, kick: 80, users: { "@moderator:test": 70 } }, "@moderator:test", "@target:test"),
    { approve: false, deny: false }
);
assert.deepEqual(
    permissions({ invite: "050", kick: "50", users: { "@moderator:test": "  +050 " } }, "@moderator:test", "@target:test", "9"),
    { approve: true, deny: true },
    "legacy integer strings must retain an administrator's authority"
);
assert.deepEqual(
    permissions({ invite: "50", users_default: "0" }, "@regular:test", undefined, "9"),
    { approve: false, deny: false },
    "legacy strings must not fall back to the permissive absent invite default"
);
assert.deepEqual(
    permissions({ invite: "50", users: { "@moderator:test": "100" } }, "@moderator:test", undefined, "10"),
    { approve: false, deny: false },
    "modern room versions must reject string-valued power levels"
);
assert.deepEqual(
    permissions({ invite: "invalid", users: { "@moderator:test": 100 } }, "@moderator:test"),
    { approve: false, deny: false },
    "present-invalid fields must fail closed rather than use absent defaults"
);
assert.deepEqual(
    permissions({ invite: 50.57, users: { "@moderator:test": 50 } }, "@moderator:test", undefined, "1"),
    { approve: true, deny: true },
    "room v1 finite floats are truncated toward zero"
);
assert.deepEqual(
    permissions({ invite: 50.57, users: { "@moderator:test": 100 } }, "@moderator:test", undefined, "2"),
    { approve: false, deny: false },
    "room v2+ fractional values are invalid"
);
assert.equal(
    permissions({ users: { "@moderator:test": 100, "@creator:test": 0 } }, "@moderator:test", "@creator:test", "12", true).deny,
    false,
    "a Hydra creator's effective Infinity power level must prevent denial"
);
const powerPermissions = backend.slice(
    backend.indexOf("interface ParsedMatrixPowerLevel"),
    backend.indexOf("function canConfigureSpaceAccess(")
);
assert.match(powerPermissions, /roomVersion === "1" \? Math\.trunc\(value\) : value/u);
assert.match(powerPermissions, /\^\[1-9\]\$/u);
assert.match(powerPermissions, /Object\.hasOwn\(content, key\)/u);
assert.match(powerPermissions, /powerLevel === Infinity/u);
assert.match(powerPermissions, /targetLevel\?\.valid === false/u);

const configurableStateTypes = [
    "m.room.join_rules",
    "m.room.history_visibility",
    "m.room.guest_access",
    "m.room.canonical_alias",
] as const;
function canConfigureAccess(
    content: Record<string, unknown>,
    sender: string,
    roomVersion = "11",
    hydraSender = false
): boolean {
    const field = (source: Record<string, unknown>, key: string, fallback: number) => Object.hasOwn(source, key)
        ? parsePowerLevel(source[key], roomVersion)
        : { valid: true, value: fallback };
    const senderLevel = hydraSender
        ? { valid: true, value: Infinity }
        : (() => {
            const usersDefault = field(content, "users_default", 0);
            if (!usersDefault.valid) return usersDefault;
            if (!Object.hasOwn(content, "users")) return usersDefault;
            const { users } = content;
            if (!users || typeof users !== "object" || Array.isArray(users)) return { valid: false, value: 0 };
            const levels = users as Record<string, unknown>;
            return Object.hasOwn(levels, sender) ? parsePowerLevel(levels[sender], roomVersion) : usersDefault;
        })();
    const stateDefault = field(content, "state_default", 50);
    if (!senderLevel.valid || !stateDefault.valid) return false;
    let events: Record<string, unknown> | undefined;
    if (Object.hasOwn(content, "events")) {
        const rawEvents = content.events;
        if (!rawEvents || typeof rawEvents !== "object" || Array.isArray(rawEvents)) return false;
        events = rawEvents as Record<string, unknown>;
    }
    return configurableStateTypes.every(type => {
        const required = events && Object.hasOwn(events, type)
            ? parsePowerLevel(events[type], roomVersion)
            : stateDefault;
        return required.valid && senderLevel.value >= required.value;
    });
}
assert.equal(canConfigureAccess({
    state_default: 50,
    users: { "@admin:test": 75 },
    events: { "m.room.canonical_alias": "80" },
}, "@admin:test", "9"), false,
"a valid legacy string event override must not be ignored in favor of state_default");
assert.equal(canConfigureAccess({
    state_default: "50",
    users: { "@admin:test": "75" },
    events: { "m.room.canonical_alias": "70" },
}, "@admin:test", "9"), true,
"legacy string sender, default, and event levels must be evaluated exactly");
assert.equal(canConfigureAccess({
    state_default: 50,
    users: { "@admin:test": 100 },
    events: { "m.room.canonical_alias": "50" },
}, "@admin:test", "10"), false,
"a present string event override in a modern room must fail closed");
assert.equal(canConfigureAccess({
    state_default: 50,
    users: { "@admin:test": 100 },
    events: [],
}, "@admin:test", "10"), false,
"a malformed events object must fail closed");
assert.equal(canConfigureAccess({ state_default: 100 }, "@creator:test", "12", true), true,
"a joined Hydra creator's Infinity level must satisfy finite state-event thresholds");
const configurePermissionCheck = backend.slice(
    backend.indexOf("function canConfigureSpaceAccess("),
    backend.indexOf("function currentSpaceAccessRequestCount(")
);
assert.doesNotMatch(configurePermissionCheck, /maySendStateEvent/u);
assert.match(configurePermissionCheck, /sender\.powerLevel === Infinity/u);
assert.match(configurePermissionCheck, /defaultedMatrixPowerLevel\(powerLevels, "state_default", 50, roomVersion\)/u);
assert.match(configurePermissionCheck, /Object\.hasOwn\(eventLevels, type\)/u);
assert.match(configurePermissionCheck, /parseMatrixPowerLevel\(eventLevels\[type\], roomVersion\)/u);

const configure = backend.slice(
    backend.indexOf("async function configureSpaceAccess("),
    backend.indexOf("function validateResolveSpaceAccessRequest(")
);
assert.match(
    configure,
    /request\.joinName \?\? \(request\.mode === "request" \? initial\.joinName : undefined\)/u,
    "only request mode must reuse or require a join alias"
);
assert.match(configure, /if \(request\.mode === "request" && !joinName\)/u);
assert.match(configure, /if \(alias != null\) \{[\s\S]*ensureSpaceAlias/u);
assert.match(configure, /if \(alias != null && await runStep\("canonical_alias"/u);
assert.match(configure, /actual = await readSpaceAccessSummary\(space\)/u);
assert.match(configure, /accessConfirmed: exactReadSucceeded/u);
assert.match(configure, /const failedStep = exactReadSucceeded[\s\S]*\? mismatch == null[\s\S]*\? undefined[\s\S]*: aliasRollbackUnconfirmed[\s\S]*failure\?\.step \?\? mismatch/u,
    "an exact desired re-read must supersede an ambiguous write failure");

type AliasReservation = "preexisting" | "created" | "ambiguous";
function canonicalFailureFixture(reservation: AliasReservation) {
    return reservation === "preexisting"
        ? { deleted: false, failedStep: "canonical_alias" }
        : { deleted: false, failedStep: "alias_rollback" };
}
assert.deepEqual(
    canonicalFailureFixture("created"),
    { deleted: false, failedStep: "alias_rollback" },
    "a newly-created alias must be reported without an unsafe unconditional delete"
);
assert.deepEqual(
    canonicalFailureFixture("ambiguous"),
    { deleted: false, failedStep: "alias_rollback" },
    "an ambiguously-created alias must remain explicitly unconfirmed"
);
assert.deepEqual(
    canonicalFailureFixture("preexisting"),
    { deleted: false, failedStep: "canonical_alias" },
    "a preexisting same-room alias must never be deleted"
);
const aliasLifecycle = backend.slice(
    backend.indexOf("type SpaceAliasReservation ="),
    backend.indexOf("async function ensureSpaceStateValue(")
);
assert.doesNotMatch(aliasLifecycle, /deleteAlias/u, "automatic alias cleanup must not race an external rebind");
assert.match(aliasLifecycle, /SpaceAliasReservationUnresolvedError/u);
assert.match(aliasLifecycle, /!isDefinitiveMatrixMutationRejection\(error\)/u);
assert.ok(aliasLifecycle.indexOf("MATRIX_SPACE_ALIAS_IN_USE") < aliasLifecycle.indexOf("mutationDispatched()"),
    "a preexisting alias conflict must fail before any possible-mutation marker");
assert.match(configure, /aliasReservation && aliasReservation !== "preexisting"/u);
assert.match(configure, /failure = \{ step: "alias_rollback", error: failure\.error \}/u);
assert.match(configure, /aliasRollbackUnconfirmed && !canonicalAliasConfirmed \? "alias_rollback" : mismatch/u,
    "a proven canonical alias must not hide a real later-step mismatch");
const configuredFailureStep = (
    mismatch: "canonical_alias" | "history_visibility" | undefined,
    aliasRollbackUnconfirmed: boolean,
    canonicalAliasConfirmed: boolean
) => mismatch == null
    ? undefined
    : aliasRollbackUnconfirmed && !canonicalAliasConfirmed ? "alias_rollback" : mismatch;
assert.equal(configuredFailureStep("canonical_alias", true, false), "alias_rollback");
assert.equal(configuredFailureStep("history_visibility", true, true), "history_visibility");
const configurationReadFailure = (confirmedMutation: boolean, possibleMutation: boolean) =>
    !confirmedMutation && !possibleMutation ? "throw" : "unconfirmed_partial";
assert.equal(configurationReadFailure(false, true), "unconfirmed_partial",
    "a lost first write plus failed final read must never become an ordinary failure");
assert.equal(configurationReadFailure(false, false), "throw",
    "a definitive pre-mutation rejection may remain an ordinary failure");
assert.match(configure, /markMutationDispatched[\s\S]*mutationPossible = true/u);
assert.match(configure, /dispatched && isDefinitiveMatrixMutationRejection\(error\)[\s\S]*previousMutationPossible/u);
assert.match(configure, /!mutated && !mutationPossible/u);
assert.match(configure, /failure \?\?= \{ step: "verification", error \}/u);

class SuppressionFixture {
    private readonly entries = new Set<string>();

    constructor(private readonly maximum: number) { }

    reserve(key: string): void {
        assert.equal(this.entries.has(key), false, "a resolved request cannot be reserved twice");
        assert.ok(this.entries.size < this.maximum, "capacity must fail without evicting an unresolved entry");
        this.entries.add(key);
    }

    clear(key: string): void {
        this.entries.delete(key);
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }
}
const suppression = new SuppressionFixture(1);
suppression.reserve("!space:test\0@one:test");
assert.throws(() => suppression.reserve("!space:test\0@two:test"));
assert.equal(suppression.has("!space:test\0@one:test"), true, "capacity failure must not evict the first entry");
suppression.clear("!space:test\0@one:test");
suppression.reserve("!space:test\0@two:test");

const reserve = backend.slice(
    backend.indexOf("function reserveResolvedSpaceAccessRequest("),
    backend.indexOf("function forgetResolvedSpaceAccessRequest(")
);
assert.match(reserve, /size >= MAX_RESOLVED_SPACE_ACCESS_REQUESTS[\s\S]*fail\(/u);
assert.doesNotMatch(reserve, /\.delete\(/u, "suppression capacity must never evict an unresolved entry");
const resolveRequest = backend.slice(
    backend.indexOf("async function resolveSpaceAccessRequest("),
    backend.indexOf("async function requestSpaceAccess(")
);
assert.ok(
    resolveRequest.indexOf("reserveResolvedSpaceAccessRequest") < resolveRequest.indexOf("matrixClient!.invite"),
    "suppression capacity must be reserved before an invite mutation"
);
assert.match(resolveRequest, /catch \(error\) \{[\s\S]*forgetResolvedSpaceAccessRequest/u);
assert.match(backend, /RoomMemberEvent\.Membership[\s\S]*forgetResolvedSpaceAccessRequest\(member\.roomId, member\.userId\)/u);
assert.match(backend, /member\.membership !== "knock" \|\| isResolvedSpaceAccessRequest/u);

const normalizeRoom = backend.slice(
    backend.indexOf("function normalizeRoom("),
    backend.indexOf("function publicRoomText(")
);
assert.match(normalizeRoom, /result\.accessRequestCountComplete = room\.membersLoaded\(\);/u);
assert.doesNotMatch(normalizeRoom, /loadMembersIfNeeded|queueSpaceAccessMemberHydration/u,
    "ordinary snapshots must never trigger a full member download");
assert.doesNotMatch(backend, /MAX_SPACE_ACCESS_MEMBER_HYDRATIONS|queueSpaceAccessMemberHydration/u,
    "the access feature must not retain a background full-member queue");
const hydration = backend.slice(
    backend.indexOf("function spaceAccessMembersLoading("),
    backend.indexOf("function recentRoomMessages(")
);
assert.match(hydration, /matrixClient === entry\.client && clientGeneration === entry\.generation/u);
assert.match(hydration, /room\.loadMembersIfNeeded\(\)[\s\S]*safeListener\(\(\) => emitRoom\(room\)\)/u);
assert.match(hydration, /spaceAccessMemberLoads\.set\(room, entry\)[\s\S]*spaceAccessMemberLoads\.delete\(room\)/u);
assert.match(backend, /async function disposeClient[\s\S]*disposeSpaceAccessMemberHydrations\(\);/u);
assert.match(backend, /RoomMemberEvent\.Membership[\s\S]*forgetResolvedSpaceAccessRequest[\s\S]*!spaceAccessMembersLoading\(room\)/u);
assert.match(backend, /RoomMemberEvent\.Name[\s\S]*!spaceAccessMembersLoading\(room\)/u);
assert.match(backend, /RoomMemberEvent\.PowerLevel[\s\S]*!spaceAccessMembersLoading\(room\)/u);
const spaceChildren = backend.slice(
    backend.indexOf("async function spaceChildren("),
    backend.indexOf("function requireMembership(")
);
assert.doesNotMatch(spaceChildren, /loadMembersIfNeeded|loadSpaceAccessMembers/u);
const openDirect = backend.slice(
    backend.indexOf("async function openDirectMessage("),
    backend.indexOf("async function sendText(")
);
const openDirectSpaceCheck = openDirect.slice(0, openDirect.indexOf("const direct = directAccountData()"));
assert.doesNotMatch(openDirectSpaceCheck, /loadMembersIfNeeded|loadSpaceAccessMembers/u);
assert.match(openDirectSpaceCheck, /getStateEvent\(space\.roomId, EventType\.RoomMember, userId\)/u);
assert.equal(backend.match(/await loadSpaceAccessMembers\(space\)/gu)?.length, 1,
    "only explicit access-request list opening may hydrate a full Space member list");

const shouldNotify = (
    previous: { count: number; complete: boolean; } | undefined,
    next: { count: number; complete: boolean; }
) => previous != null && previous.complete === next.complete && next.count > previous.count;
assert.equal(shouldNotify(undefined, { count: 1, complete: false }), false, "the initial binding is a baseline");
assert.equal(shouldNotify({ count: 1, complete: false }, { count: 3, complete: false }), true,
    "known live knocks can increase an incomplete lower bound");
assert.equal(shouldNotify({ count: 1, complete: false }, { count: 3, complete: true }), false,
    "explicit hydration is reconciliation, not a notification");
assert.equal(shouldNotify({ count: 1, complete: true }, { count: 2, complete: true }), true);
assert.equal(shouldNotify({ count: 1, complete: true }, { count: 2, complete: false }), false,
    "loss of completeness starts a new reconciliation baseline");
assert.match(accessRequests, /previous\.complete !== context\.countComplete/u);

const accessUserIdValidator = bridge.slice(
    bridge.indexOf("function normalizedAccessRequestUserId("),
    bridge.indexOf("function normalizedAccessRequestDisplayName(")
);
const structuralUserId = /^@[^\s:\u0000-\u001f\u007f]+:[^\s\u0000-\u001f\u007f]+$/u;
const bidiUserId = "@review\u202Erequester:test";
assert.equal(structuralUserId.test(bidiUserId), true);
assert.doesNotMatch(accessUserIdValidator, /\u061c|\u200e|\u202a|BIDI/u,
    "valid raw Matrix action IDs must not be rejected for visible bidi controls");
assert.match(accessUserIdValidator, /return value/u, "the unmodified structural ID is the action target");

const listAccessRequests = backend.slice(
    backend.indexOf("async function getSpaceAccessRequests("),
    backend.indexOf("function accessRequestCountWithout(")
);
const firstPermissionCheck = listAccessRequests.indexOf("!permissions.canApprove && !permissions.canDeny");
const hydrateMembers = listAccessRequests.indexOf("await loadSpaceAccessMembers(space)");
const secondPermissionCheck = listAccessRequests.indexOf(
    "!permissions.canApprove && !permissions.canDeny",
    firstPermissionCheck + 1
);
assert.ok(firstPermissionCheck >= 0 && hydrateMembers > firstPermissionCheck && secondPermissionCheck > hydrateMembers,
    "pending identities require authority both before and after asynchronous member hydration");

const requestAccess = backend.slice(
    backend.indexOf("function validateSpaceAliasResolution("),
    backend.indexOf("function validateCreateSpaceRequest(")
);
assert.match(requestAccess, /input\.servers\.length > 100/u);
assert.match(requestAccess, /servers\.slice\(0, 3\)/u);
assert.ok(
    requestAccess.indexOf("attestRequestEnabledSpace(joinAlias, roomId, viaServers)")
        < requestAccess.lastIndexOf("knockRoom(roomId"),
    "pre-join summary attestation must complete before knock mutation"
);
assert.match(requestAccess, /validateRoomId\(summary\.room_id\) !== roomId/u);
assert.match(requestAccess, /summary\.room_type !== RoomType\.Space/u);
assert.match(requestAccess, /summaryJoinRule !== JoinRule\.Knock/u);
assert.match(requestAccess, /matrixErrorCode\(error\) !== "M_UNRECOGNIZED"/u);
const localTypeCheck = requestAccess.lastIndexOf("localRoom && !localRoom.isSpaceRoom()");
const localMembershipCheck = requestAccess.lastIndexOf("const currentMembership = localRoom?.getMyMembership()");
assert.ok(localTypeCheck >= 0 && localTypeCheck < localMembershipCheck,
    "a cached ordinary room must be rejected before any membership early return");
assert.match(requestAccess, /currentMembership === "knock"\)[\s\S]*await attestRequestEnabledSpace/u,
    "a cached knock must still re-attest request-enabled Space state");
assert.match(requestAccess, /summary\.membership/u);
assert.match(requestAccess, /getMyMembership\(\)/u);
assert.match(requestAccess, /exactRoomMembership\(roomId, userId\)/u);
assert.match(requestAccess, /MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS/u);
assert.match(requestAccess, /isDefinitiveMatrixMutationRejection\(error\)/u);
assert.doesNotMatch(requestAccess, /reason\s*:/u, "Space knocks must not attach a reason or password-like field");

const resolveOutcome = backend.slice(
    backend.indexOf("async function resolveSpaceAccessRequest("),
    backend.indexOf("function validateSpaceAliasResolution(")
);
assert.ok(resolveOutcome.indexOf("reserveResolvedSpaceAccessRequest") < resolveOutcome.indexOf("matrixClient!.invite"));
assert.match(resolveOutcome, /actualMembership === "invite" \|\| actualMembership === "join"/u);
assert.match(resolveOutcome, /actualMembership === "leave"/u);
assert.match(resolveOutcome, /MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS/u);
assert.match(resolveOutcome, /forgetResolvedSpaceAccessRequest[\s\S]*isDefinitiveMatrixMutationRejection/u);

const definitiveMutationRejection = (value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const error = value as { httpStatus?: unknown; errcode?: unknown; };
    return typeof error.errcode === "string" && Number.isSafeInteger(error.httpStatus)
        && Number(error.httpStatus) >= 400 && Number(error.httpStatus) < 500;
};
assert.equal(definitiveMutationRejection({ httpStatus: 403, errcode: "M_FORBIDDEN" }), true);
assert.equal(definitiveMutationRejection({ httpStatus: 503, errcode: "M_UNKNOWN" }), false);
assert.equal(definitiveMutationRejection({ httpStatus: 403 }), false);

const summary = backend.slice(
    backend.indexOf("async function readSpaceAccessSummary("),
    backend.indexOf("async function getSpaceAccess(")
);
assert.match(summary, /optionalRoomState\(space\.roomId, EventType\.RoomJoinRules\)/u);
assert.match(summary, /getRoomDirectoryVisibility\(space\.roomId\)/u);
assert.match(summary, /await resolveRoomAlias\(alias\.joinAlias\) === space\.roomId/u);

const configureValidator = native.slice(
    native.indexOf("function validateProtocolConfigureSpaceAccessResult("),
    native.indexOf("function validateProtocolRequestSpaceAccessResult(")
);
assert.match(configureValidator, /\["spaceId", "requestedMode", "access", "accessConfirmed", "complete"\]/u);
assert.match(configureValidator, /typeof raw\.accessConfirmed !== "boolean"/u);
assert.match(configureValidator, /raw\.complete && !raw\.accessConfirmed/u);
const privateAccessMutation = native.slice(
    native.indexOf("function ambiguousAccessMutationError("),
    native.indexOf("function secureViewSecurityState(")
);
assert.match(privateAccessMutation, /shellSnapshotDirty = true/u);
assert.match(privateAccessMutation, /const result = await mutation\(\)[\s\S]*await bestEffortAccessMutationRefresh[\s\S]*return result/u);
assert.match(privateAccessMutation, /MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS/u);
assert.match(privateAccessMutation, /MATRIX_SPACE_ACCESS_REQUEST_AMBIGUOUS/u);
assert.match(privateAccessMutation, /MATRIX_SPACE_ACCESS_RESOLUTION_AMBIGUOUS/u);
const workerInterruption = native.slice(
    native.indexOf("function interruptedAccessMutationError("),
    native.indexOf("function startupTimeoutError(")
);
assert.match(workerInterruption, /request\.started[\s\S]*interruptedAccessMutationError/u);
assert.match(workerInterruption, /!queued \? interruptedAccessMutationError\(commandType\)/u);

const loadSpaceAccessUi = settings.slice(
    settings.indexOf("async function loadSpaceAccess("),
    settings.indexOf("function toggleSpaceAccess(")
);
const saveSpaceAccessUi = settings.slice(
    settings.indexOf("async function saveSpaceAccess("),
    settings.indexOf("async function resolveAccessRequest(")
);
assert.doesNotMatch(loadSpaceAccessUi, /MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS/u,
    "read-only access loading must not handle mutation ambiguity");
assert.match(saveSpaceAccessUi, /MATRIX_SPACE_ACCESS_CONFIGURATION_AMBIGUOUS/u,
    "the save path must reconcile an ambiguous access mutation");
assert.ok(
    saveSpaceAccessUi.indexOf("setSpaceAccessConfirmed") < saveSpaceAccessUi.indexOf("Native.getSpaceAccess"),
    "an ambiguous save must become visibly unconfirmed before reconciliation"
);
assert.match(saveSpaceAccessUi, /delete next\[spaceId\]/u,
    "failed reconciliation must discard the stale save draft");
