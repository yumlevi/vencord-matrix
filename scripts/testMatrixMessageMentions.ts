/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    introducedMatrixMentionUserIds,
    materializeOutboundMatrixMentions,
    projectInboundMatrixMentions,
    projectOutboundMatrixMentions
} from "../src/plugins/matrixBridge/messageMentions";

const outboundUsers = new Map([
    ["111", "@self:example.test"],
    ["222", "@friend:example.test"],
]);
const outbound = projectOutboundMatrixMentions(
    "Hello <@111> and <@!222>, again <@222>; literal <@999>.",
    userId => outboundUsers.get(userId)
);
assert.equal(materializeOutboundMatrixMentions(outbound.body, outbound.userIds),
    "Hello @self:example.test and @friend:example.test, again @friend:example.test; literal @999."
);
assert.deepEqual(outbound.userIds, ["@self:example.test", "@friend:example.test"]);
assert.equal(materializeOutboundMatrixMentions(outbound.body, []), undefined);

const identities = new Map([
    ["@self:example.test", { matrixUserId: "@self:example.test", localUserId: "444", displayText: "Self" }],
    ["@friend:example.test", { matrixUserId: "@friend:example.test", localUserId: "555", displayText: "Friend" }],
]);
const inbound = projectInboundMatrixMentions(
    "Hello @self:example.test and @friend:example.test; old <@333>; unknown <@999>.",
    ["@self:example.test", "@friend:example.test", "@friend:example.test", "@absent:example.test"],
    userId => identities.get(userId),
    syntheticUserId => syntheticUserId === "333" ? identities.get("@friend:example.test") : undefined
);
assert.equal(inbound.body, "Hello <@444> and <@555>; old <@555>; unknown @999.");
assert.deepEqual(inbound.matrixUserIds, ["@friend:example.test", "@self:example.test"]);
assert.deepEqual(inbound.localUserIds, ["555", "444"]);

const legacyDisplayOnly = projectInboundMatrixMentions(
    "Old bridge token <@333>",
    [],
    userId => identities.get(userId),
    syntheticUserId => syntheticUserId === "333" ? identities.get("@friend:example.test") : undefined
);
assert.equal(legacyDisplayOnly.body, "Old bridge token @Friend");
assert.deepEqual(legacyDisplayOnly.matrixUserIds, []);
assert.deepEqual(legacyDisplayOnly.localUserIds, []);

const semanticOnly = projectInboundMatrixMentions(
    "A display name without an MXID token",
    ["@self:example.test"],
    userId => identities.get(userId),
    () => undefined
);
assert.equal(semanticOnly.body, "A display name without an MXID token");
assert.deepEqual(semanticOnly.localUserIds, ["444"]);

const boundarySafe = projectInboundMatrixMentions(
    "https://example.test/@self:example.test/path "
        + "https://example.test/#@self:example.test "
        + "https://example.test?user=@self:example.test "
        + "matrix:@self:example.test "
        + "foo@self:example.test",
    ["@self:example.test"],
    userId => identities.get(userId),
    () => undefined
);
assert.equal(
    boundarySafe.body,
    "https://example.test/@self:example.test/path "
        + "https://example.test/#@self:example.test "
        + "https://example.test?user=@self:example.test "
        + "matrix:@self:example.test "
        + "foo@self:example.test"
);
assert.deepEqual(boundarySafe.localUserIds, ["444"]);

assert.deepEqual(
    introducedMatrixMentionUserIds(["@self:example.test"], ["@self:example.test", "@friend:example.test"]),
    ["@friend:example.test"]
);
assert.deepEqual(
    introducedMatrixMentionUserIds(["@self:example.test", "@friend:example.test"], ["@self:example.test"]),
    []
);
assert.deepEqual(introducedMatrixMentionUserIds(["@self:example.test"], ["@self:example.test"]), []);

const backend = readFileSync(new URL("../src/plugins/matrixBridge/matrixBackend.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/plugins/matrixBridge/bridge.ts", import.meta.url), "utf8");
const native = readFileSync(new URL("../src/plugins/matrixBridge/native.ts", import.meta.url), "utf8");
assert.match(backend, /content\["m\.mentions"\]\s*=\s*\{ user_ids: mentionedUserIds \}/u);
assert.match(backend, /message\.mentionedUserIds = mentionedUserIds/u);
assert.match(backend, /"m\.mentions": introducedMentionUserIds\.length \? \{ user_ids: introducedMentionUserIds \} : \{\}/u);
assert.match(backend, /newContent\["m\.mentions"\] = mentionedUserIds\.length \? \{ user_ids: mentionedUserIds \} : \{\}/u);
assert.match(bridge, /mentions: projectedMentions\.users/u);
assert.match(bridge, /projectOutboundMatrixMentions\(withoutSelfMention,/u);
assert.match(native, /message\.mentionedUserIds = raw\.mentionedUserIds\.map\(protocolUserId\)/u);

console.log("Matrix message mention projection fixtures passed.");
