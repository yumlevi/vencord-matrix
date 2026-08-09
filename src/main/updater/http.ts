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

import { IpcEvents } from "@shared/IpcEvents";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { ipcMain } from "electron";

import gitRemote from "~git-remote";

import { serializeErrors } from "./common";
import {
    activateRelease,
    getReleaseRoot,
    isInstalledRelease,
    observeReleasePointer,
    readReleaseState,
    StagedRelease,
    stageRelease } from "./releaseState";
import { sha256Hex, verifyReleaseSignature } from "./releaseTrust";
import {
    MAX_BUNDLE_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_SIGNATURE_BYTES,
    parseReleaseManifest,
    RELEASE_BOOTSTRAP_NAME,
    RELEASE_BOOTSTRAP_WRAPPER_NAME,
    RELEASE_BUNDLE_NAME,
    RELEASE_MANIFEST_NAME,
    RELEASE_SETUP_BUNDLE_NAME,
    RELEASE_SIGNATURE_NAME,
    ReleasePointer,
    releasePointer,
    ReleaseValidationError
} from "./releaseTypes";

const GITHUB_REMOTE_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))$/;
const REDIRECT_HOSTS = new Set([
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com"
]);
const RELEASE_ASSET_NAMES = new Set([
    RELEASE_MANIFEST_NAME,
    RELEASE_SIGNATURE_NAME,
    RELEASE_BUNDLE_NAME,
    RELEASE_BOOTSTRAP_NAME,
    RELEASE_BOOTSTRAP_WRAPPER_NAME,
    RELEASE_SETUP_BUNDLE_NAME
]);
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

interface GitHubReleaseAsset {
    name: string;
    browserDownloadUrl: string;
    size: number;
}

interface UpdateCandidate {
    manifestBytes: Buffer;
    signatureBytes: Buffer;
    pointer: ReleasePointer;
    version: string;
    bundleUrl: string;
}

function serializeReleaseErrors<T extends (...args: any[]) => any>(callback: T) {
    return async function (...args: Parameters<T>) {
        try {
            return { ok: true, value: await callback(...args) };
        } catch (error) {
            return {
                ok: false,
                error: {
                    name: "ReleaseUpdateError",
                    message: error instanceof ReleaseValidationError
                        ? error.message
                        : "The signed update could not be applied safely."
                }
            };
        }
    };
}

const remoteMatch = GITHUB_REMOTE_PATTERN.exec(gitRemote);
if (remoteMatch == null || [remoteMatch[1], remoteMatch[2]].some(part => part === "." || part === ".."))
    throw new ReleaseValidationError("The embedded update repository is invalid.");
const [, repositoryOwner, repositoryName] = remoteMatch;
const repositoryPath = `${repositoryOwner}/${repositoryName}`;
const repositoryUrl = `https://github.com/${repositoryPath}`;
const latestReleaseUrl = `https://api.github.com/repos/${repositoryPath}/releases/latest`;

let candidate: UpdateCandidate | undefined;
let staged: StagedRelease | undefined;
let operation = Promise.resolve<unknown>(undefined);

function exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const current = operation.then(callback, callback);
    operation = current.then(() => undefined, () => undefined);
    return current;
}

function assertSafeHttpsUrl(value: string | URL) {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ReleaseValidationError("The update service returned an invalid URL.");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
        || url.port !== "" || !REDIRECT_HOSTS.has(url.hostname.toLowerCase())) {
        throw new ReleaseValidationError("The update service returned an untrusted URL.");
    }
    return url;
}

function assertReleaseAssetUrl(value: string, assetName: string) {
    const url = assertSafeHttpsUrl(value);
    if (url.hostname.toLowerCase() !== "github.com")
        throw new ReleaseValidationError("The release asset URL has an untrusted origin.");
    const prefix = `/${repositoryPath}/releases/download/`;
    const suffix = `/${assetName}`;
    const releaseTag = url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix)
        ? url.pathname.slice(prefix.length, -suffix.length)
        : "";
    if (releaseTag.length === 0 || releaseTag.length > 256 || releaseTag.includes("/")
        || url.search !== "" || url.hash !== "") {
        throw new ReleaseValidationError("The release asset URL does not match the configured repository.");
    }
    return url.toString();
}

async function fetchBounded(
    value: string | URL,
    maximumBytes: number,
    timeoutMs: number,
    accept: string
) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let url = assertSafeHttpsUrl(value);
    try {
        for (let redirects = 0; ; redirects++) {
            let response: Response;
            try {
                response = await fetch(url, {
                    cache: "no-store",
                    credentials: "omit",
                    redirect: "manual",
                    signal: controller.signal,
                    headers: {
                        Accept: accept,
                        "User-Agent": VENCORD_USER_AGENT,
                        "X-GitHub-Api-Version": "2022-11-28"
                    }
                });
            } catch {
                throw new ReleaseValidationError("The signed update service could not be reached.");
            }

            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (redirects >= MAX_REDIRECTS)
                    throw new ReleaseValidationError("The update download redirected too many times.");
                const location = response.headers.get("location");
                if (location == null)
                    throw new ReleaseValidationError("The update download returned an invalid redirect.");
                url = assertSafeHttpsUrl(new URL(location, url));
                continue;
            }
            if (!response.ok || response.body == null)
                throw new ReleaseValidationError("The signed update service returned an error.");

            const contentLength = response.headers.get("content-length");
            if (contentLength != null && (!/^(?:0|[1-9][0-9]{0,15})$/.test(contentLength)
                || Number(contentLength) > maximumBytes)) {
                throw new ReleaseValidationError("The update download exceeds its allowed size.");
            }

            const chunks: Uint8Array[] = [];
            let length = 0;
            const reader = response.body.getReader();
            while (true) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                length += chunk.byteLength;
                if (length > maximumBytes) {
                    await reader.cancel();
                    throw new ReleaseValidationError("The update download exceeds its allowed size.");
                }
                chunks.push(chunk);
            }
            return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
        }
    } catch (error) {
        if (error instanceof ReleaseValidationError)
            throw error;
        throw new ReleaseValidationError("The signed update download did not complete safely.");
    } finally {
        clearTimeout(timeout);
    }
}

function parseReleaseAssets(raw: Buffer) {
    let value: unknown;
    try {
        value = JSON.parse(raw.toString("utf8"));
    } catch {
        throw new ReleaseValidationError("The update service returned invalid release metadata.");
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)
        || !("draft" in value) || value.draft !== false
        || !("prerelease" in value) || value.prerelease !== false
        || !("assets" in value) || !Array.isArray(value.assets) || value.assets.length > 100) {
        throw new ReleaseValidationError("The update service returned invalid release metadata.");
    }

    const assets = new Map<string, GitHubReleaseAsset>();
    for (const item of value.assets) {
        if (item == null || typeof item !== "object" || Array.isArray(item)
            || !("name" in item) || typeof item.name !== "string"
            || !("browser_download_url" in item) || typeof item.browser_download_url !== "string"
            || !("size" in item) || !Number.isSafeInteger(item.size) || (item.size as number) <= 0) {
            throw new ReleaseValidationError("The update service returned invalid asset metadata.");
        }
        if (!RELEASE_ASSET_NAMES.has(item.name) || assets.has(item.name))
            throw new ReleaseValidationError("The release contains an unexpected or duplicate asset.");
        const maximumSize = item.name === RELEASE_MANIFEST_NAME ? MAX_MANIFEST_BYTES
            : item.name === RELEASE_SIGNATURE_NAME ? MAX_SIGNATURE_BYTES
                : item.name === RELEASE_BUNDLE_NAME ? MAX_BUNDLE_BYTES
                    : item.name === RELEASE_BOOTSTRAP_NAME ? 1024 * 1024
                        : item.name === RELEASE_BOOTSTRAP_WRAPPER_NAME ? 16 * 1024
                            : 2 * 1024 * 1024;
        if ((item.size as number) > maximumSize)
            throw new ReleaseValidationError("A release asset exceeds its allowed size.");
        assets.set(item.name, {
            name: item.name,
            browserDownloadUrl: assertReleaseAssetUrl(item.browser_download_url, item.name),
            size: item.size as number
        });
    }
    if (assets.size !== RELEASE_ASSET_NAMES.size)
        throw new ReleaseValidationError("The release is missing a required asset.");
    return assets;
}

async function fetchCandidate(): Promise<UpdateCandidate | undefined> {
    const metadata = await fetchBounded(
        latestReleaseUrl,
        MAX_RELEASE_METADATA_BYTES,
        30_000,
        "application/vnd.github+json"
    );
    const assets = parseReleaseAssets(metadata);
    const [manifestBytes, signatureBytes] = await Promise.all([
        fetchBounded(
            assets.get(RELEASE_MANIFEST_NAME)!.browserDownloadUrl,
            MAX_MANIFEST_BYTES,
            30_000,
            "application/octet-stream"
        ),
        fetchBounded(
            assets.get(RELEASE_SIGNATURE_NAME)!.browserDownloadUrl,
            MAX_SIGNATURE_BYTES,
            30_000,
            "application/octet-stream"
        )
    ]);
    if (manifestBytes.byteLength !== assets.get(RELEASE_MANIFEST_NAME)!.size
        || signatureBytes.byteLength !== assets.get(RELEASE_SIGNATURE_NAME)!.size) {
        throw new ReleaseValidationError("A release asset changed while it was downloaded.");
    }
    verifyReleaseSignature(manifestBytes, signatureBytes);
    const manifest = parseReleaseManifest(manifestBytes);
    if (assets.get(RELEASE_BUNDLE_NAME)!.size !== manifest.bundle.size)
        throw new ReleaseValidationError("The release bundle size does not match its signed manifest.");
    const pointer = releasePointer(manifest, sha256Hex(manifestBytes));
    const releaseRoot = getReleaseRoot();
    const state = await observeReleasePointer(releaseRoot, pointer);
    if (isInstalledRelease(state, pointer)) {
        candidate = undefined;
        staged = undefined;
        return;
    }
    if (pointer.sequence <= state.current.sequence)
        throw new ReleaseValidationError("The signed release is not newer than the active release.");

    return candidate = {
        manifestBytes,
        signatureBytes,
        pointer,
        version: manifest.version,
        bundleUrl: assets.get(RELEASE_BUNDLE_NAME)!.browserDownloadUrl
    };
}

async function calculateChanges() {
    const update = await fetchCandidate();
    if (update == null) return [];
    return [{
        hash: update.pointer.commit.slice(0, 7),
        author: "Disorder",
        message: `Signed release ${update.version}`
    }];
}

async function downloadAndStage() {
    const update = candidate ?? await fetchCandidate();
    if (update == null) return false;

    const state = await readReleaseState(getReleaseRoot());
    if (isInstalledRelease(state, update.pointer)) return false;
    const bundleBytes = await fetchBounded(
        update.bundleUrl,
        MAX_BUNDLE_BYTES,
        120_000,
        "application/octet-stream"
    );
    staged = await stageRelease(
        getReleaseRoot(),
        update.manifestBytes,
        update.signatureBytes,
        bundleBytes
    );
    return true;
}

async function activateStaged() {
    if (staged == null)
        throw new ReleaseValidationError("No verified update is staged for activation.");
    await activateRelease(getReleaseRoot(), staged.pointer);
    staged = undefined;
    candidate = undefined;
    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => repositoryUrl));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeReleaseErrors(() => exclusive(calculateChanges)));
ipcMain.handle(IpcEvents.UPDATE, serializeReleaseErrors(() => exclusive(downloadAndStage)));
ipcMain.handle(IpcEvents.BUILD, serializeReleaseErrors(() => exclusive(activateStaged)));
