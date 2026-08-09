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
import { readFile } from "fs/promises";

const publishable = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
}).split("\0").filter(Boolean))].sort();

const forbiddenPaths = [
    /(^|\/)\.codex(\/|$)/iu,
    /(^|\/)\.env(?:\.|$)/iu,
    /(^|\/)(?:matrix|synthetic-guild)-[^/]*\.(?:png|jpe?g|webp)$/iu,
    /(^|\/)live-[^/]*\.json$/iu,
    /(^|\/)[^/]*-live\.json$/iu,
    /^scripts\/.*\.cdp\.js$/iu,
    /^scripts\/cdp[^/]*\.mjs$/iu,
    /^MATRIX_BRIDGE_AUDIT\.md$/u,
    /(?:^|\/)(?:logs?|screenshots?|diagnostics?)(?:\/|$)/iu,
    /\.(?:har|log)$/iu
];
const sensitiveText = [
    /[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/u,
    /\/(?:Users|home)\/[^/\s"']+/u,
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/u,
    /\bsyt_[A-Za-z0-9_-]{20,}\b/u,
    /https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|matrix\.to\/#\/![^\s"']+)/iu
];

const failures = [];
for (const path of publishable) {
    if (forbiddenPaths.some(pattern => pattern.test(path))) {
        failures.push(`${path}: forbidden diagnostic or private artifact path`);
        continue;
    }
    let bytes;
    try {
        bytes = await readFile(path);
    } catch {
        failures.push(`${path}: publishable file could not be inspected`);
        continue;
    }
    if (bytes.length > 4 * 1024 * 1024) {
        failures.push(`${path}: publishable file exceeds the privacy scanner limit`);
        continue;
    }
    if (bytes.includes(0)) continue;
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        // Non-text files are outside this content scanner. Their paths are
        // still checked against the private-artifact denylist above.
        continue;
    }
    if (sensitiveText.some(pattern => pattern.test(text)))
        failures.push(`${path}: possible credential or machine-local identifier`);
}

if (failures.length !== 0) {
    console.error("Public-release privacy gate failed. Matches are not printed; inspect only the named files locally.");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`Public-release privacy gate passed for ${publishable.length} tracked or otherwise publishable files.`);
}
