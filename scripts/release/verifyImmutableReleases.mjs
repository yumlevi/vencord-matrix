/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { execFileSync } from "child_process";
import { parseArgs } from "util";

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const { values } = parseArgs({
    options: { repository: { type: "string" } },
    strict: true
});

if (typeof values.repository !== "string" || !REPOSITORY.test(values.repository))
    throw new Error("--repository must be owner/repository");

let raw;
try {
    raw = execFileSync("gh", [
        "api",
        "-H", "Accept: application/vnd.github+json",
        "-H", "X-GitHub-Api-Version: 2026-03-10",
        `repos/${values.repository}/immutable-releases`
    ], {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
    });
} catch {
    throw new Error("GitHub did not confirm immutable releases. Authenticate gh as a repository administrator, enable the setting, and retry.");
}

let response;
try {
    response = JSON.parse(raw);
} catch {
    throw new Error("GitHub returned an invalid immutable-releases response.");
}
if (response == null || typeof response !== "object" || Array.isArray(response) || response.enabled !== true)
    throw new Error("GitHub did not report immutable releases as enabled.");

console.log("GitHub confirmed that future releases in this repository will be immutable.");
