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

export const RELEASE_MANIFEST_NAME = "disorder-manifest.json";
export const RELEASE_SIGNATURE_NAME = "disorder-manifest.sig";
export const RELEASE_BUNDLE_NAME = "disorder-runtime.zip";
export const RELEASE_BOOTSTRAP_NAME = "Install-Disorder.ps1";
export const RELEASE_BOOTSTRAP_WRAPPER_NAME = "Install-Disorder.cmd";
export const RELEASE_SETUP_BUNDLE_NAME = "Disorder-Setup.zip";

export const RELEASE_PRODUCT = "disorder-vencord";
export const RELEASE_CHANNEL = "stable";
export const RELEASE_SCHEMA = 1;
export const RELEASE_STATE_SCHEMA = 1;

export const MAX_MANIFEST_BYTES = 128 * 1024;
export const MAX_SIGNATURE_BYTES = 2 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;

export const RELEASE_ID_PATTERN = /^r[1-9][0-9]{0,15}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

export const RELEASE_RUNTIME_FILES = Object.freeze([
    "LICENSE",
    "fflate.LICENSE",
    "matrix-js-sdk.LICENSE",
    "matrixBridgePreload.js",
    "matrixBridgeWorker.js",
    "matrixBridgeWorker.js.LEGAL.txt",
    "matrixSecureView.css",
    "matrixSecureView.js",
    "matrixSecureViewPreload.js",
    "matrix_sdk_crypto_wasm.LICENSE",
    "matrix_sdk_crypto_wasm_bg.wasm",
    "package.json",
    "patcher.js",
    "patcher.js.LEGAL.txt",
    "preload.js",
    "renderer.css",
    "renderer.js",
    "renderer.js.LEGAL.txt"
] as const);

const RELEASE_RUNTIME_FILE_SET = new Set<string>(RELEASE_RUNTIME_FILES);

export interface ReleaseFile {
    path: string;
    size: number;
    sha256: string;
}

export interface ReleaseManifest {
    schema: 1;
    product: typeof RELEASE_PRODUCT;
    channel: typeof RELEASE_CHANNEL;
    sequence: number;
    version: string;
    commit: string;
    publishedAt: string;
    bundle: {
        name: typeof RELEASE_BUNDLE_NAME;
        size: number;
        sha256: string;
    };
    files: ReleaseFile[];
    changes: [];
}

export interface ReleasePointer {
    id: string;
    sequence: number;
    commit: string;
    manifestSha256: string;
}

export interface ReleaseState {
    schema: 1;
    current: ReleasePointer;
    previous?: ReleasePointer;
    failed?: ReleasePointer;
    highestSeenSequence: number;
    highestSeenManifestSha256: string;
    pendingBoot: boolean;
    bootAttempts: number;
}

export class ReleaseValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReleaseValidationError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
    const keys = Object.keys(value).sort();
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.hasOwn(value, key))
        && keys.every(key => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseFile(value: unknown): ReleaseFile {
    if (!isRecord(value) || !hasExactKeys(value, ["path", "size", "sha256"]))
        throw new ReleaseValidationError("The release contains an invalid file entry.");

    const { path, size, sha256 } = value;
    if (typeof path !== "string" || !RELEASE_RUNTIME_FILE_SET.has(path))
        throw new ReleaseValidationError("The release contains an unexpected file path.");
    if (!isPositiveSafeInteger(size) || size > MAX_RUNTIME_FILE_BYTES)
        throw new ReleaseValidationError("The release contains an invalid file size.");
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))
        throw new ReleaseValidationError("The release contains an invalid file digest.");

    return { path, size, sha256 };
}

export function parseReleaseManifest(raw: Uint8Array): ReleaseManifest {
    if (raw.byteLength === 0 || raw.byteLength > MAX_MANIFEST_BYTES)
        throw new ReleaseValidationError("The signed release manifest has an invalid size.");

    let value: unknown;
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        value = JSON.parse(text);
    } catch {
        throw new ReleaseValidationError("The signed release manifest is not valid UTF-8 JSON.");
    }

    if (!isRecord(value) || !hasExactKeys(value, [
        "schema", "product", "channel", "sequence", "version", "commit",
        "publishedAt", "bundle", "files", "changes"
    ])) {
        throw new ReleaseValidationError("The signed release manifest has an invalid shape.");
    }

    const { schema, product, channel, sequence, version, commit, publishedAt, bundle, files, changes } = value;
    if (schema !== RELEASE_SCHEMA || product !== RELEASE_PRODUCT || channel !== RELEASE_CHANNEL)
        throw new ReleaseValidationError("The signed release manifest targets an unsupported product.");
    if (!isPositiveSafeInteger(sequence))
        throw new ReleaseValidationError("The signed release sequence is invalid.");
    if (typeof version !== "string" || !VERSION_PATTERN.test(version))
        throw new ReleaseValidationError("The signed release version is invalid.");
    if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit))
        throw new ReleaseValidationError("The signed release commit is invalid.");
    if (typeof publishedAt !== "string" || publishedAt.length > 32) {
        throw new ReleaseValidationError("The signed release timestamp is invalid.");
    }
    try {
        if (new Date(publishedAt).toISOString() !== publishedAt)
            throw new Error();
    } catch {
        throw new ReleaseValidationError("The signed release timestamp is invalid.");
    }
    if (!isRecord(bundle) || !hasExactKeys(bundle, ["name", "size", "sha256"])
        || bundle.name !== RELEASE_BUNDLE_NAME
        || !isPositiveSafeInteger(bundle.size) || bundle.size > MAX_BUNDLE_BYTES
        || typeof bundle.sha256 !== "string" || !SHA256_PATTERN.test(bundle.sha256)) {
        throw new ReleaseValidationError("The signed release bundle metadata is invalid.");
    }
    if (!Array.isArray(files) || files.length !== RELEASE_RUNTIME_FILES.length)
        throw new ReleaseValidationError("The signed release file list is incomplete.");
    if (!Array.isArray(changes) || changes.length !== 0)
        throw new ReleaseValidationError("The signed release includes unsupported change metadata.");

    const parsedFiles = files.map(parseFile);
    const paths = parsedFiles.map(file => file.path);
    if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length
        || paths.some((path, index) => path !== RELEASE_RUNTIME_FILES[index])) {
        throw new ReleaseValidationError("The signed release file list is not canonical.");
    }
    if (parsedFiles.reduce((total, file) => total + file.size, 0) > MAX_RUNTIME_BYTES)
        throw new ReleaseValidationError("The signed release is too large.");

    return {
        schema: RELEASE_SCHEMA,
        product: RELEASE_PRODUCT,
        channel: RELEASE_CHANNEL,
        sequence,
        version,
        commit,
        publishedAt,
        bundle: {
            name: RELEASE_BUNDLE_NAME,
            size: bundle.size,
            sha256: bundle.sha256
        },
        files: parsedFiles,
        changes: []
    };
}

function parseReleasePointer(value: unknown): ReleasePointer {
    if (!isRecord(value) || !hasExactKeys(value, ["id", "sequence", "commit", "manifestSha256"]))
        throw new ReleaseValidationError("The local release pointer is invalid.");

    const { id, sequence, commit, manifestSha256 } = value;
    if (typeof id !== "string" || !RELEASE_ID_PATTERN.test(id)
        || !isPositiveSafeInteger(sequence)
        || typeof commit !== "string" || !COMMIT_PATTERN.test(commit)
        || typeof manifestSha256 !== "string" || !SHA256_PATTERN.test(manifestSha256)
        || id !== releaseId(sequence, commit)) {
        throw new ReleaseValidationError("The local release pointer is invalid.");
    }

    return { id, sequence, commit, manifestSha256 };
}

export function parseReleaseState(value: unknown): ReleaseState {
    if (!isRecord(value) || !hasExactKeys(value, [
        "schema", "current", "highestSeenSequence", "highestSeenManifestSha256",
        "pendingBoot", "bootAttempts"
    ], ["previous", "failed"])) {
        throw new ReleaseValidationError("The local release state is invalid.");
    }

    const {
        schema, current, previous, failed, highestSeenSequence, highestSeenManifestSha256,
        pendingBoot, bootAttempts
    } = value;
    if (schema !== RELEASE_STATE_SCHEMA
        || !isPositiveSafeInteger(highestSeenSequence)
        || typeof highestSeenManifestSha256 !== "string" || !SHA256_PATTERN.test(highestSeenManifestSha256)
        || typeof pendingBoot !== "boolean"
        || !isNonNegativeSafeInteger(bootAttempts) || bootAttempts > 2) {
        throw new ReleaseValidationError("The local release state is invalid.");
    }

    const parsedCurrent = parseReleasePointer(current);
    const parsedPrevious = previous == null ? undefined : parseReleasePointer(previous);
    const parsedFailed = failed == null ? undefined : parseReleasePointer(failed);
    if ([parsedCurrent, parsedPrevious, parsedFailed].some(pointer => pointer != null
        && (highestSeenSequence < pointer.sequence
            || (highestSeenSequence === pointer.sequence
                && highestSeenManifestSha256 !== pointer.manifestSha256)))) {
        throw new ReleaseValidationError("The local release watermark is invalid.");
    }
    const pointerIds = [parsedCurrent, parsedPrevious, parsedFailed]
        .filter(pointer => pointer != null)
        .map(pointer => pointer.id);
    const pointerSequences = [parsedCurrent, parsedPrevious, parsedFailed]
        .filter(pointer => pointer != null)
        .map(pointer => pointer.sequence);
    if (new Set(pointerIds).size !== pointerIds.length
        || new Set(pointerSequences).size !== pointerSequences.length
        || (parsedPrevious != null && parsedPrevious.sequence >= parsedCurrent.sequence)
        || (!pendingBoot && bootAttempts !== 0)) {
        throw new ReleaseValidationError("The local release pointers are not distinct.");
    }

    return {
        schema: RELEASE_STATE_SCHEMA,
        current: parsedCurrent,
        ...(parsedPrevious == null ? {} : { previous: parsedPrevious }),
        ...(parsedFailed == null ? {} : { failed: parsedFailed }),
        highestSeenSequence,
        highestSeenManifestSha256,
        pendingBoot,
        bootAttempts
    };
}

export function releaseId(sequence: number, commit: string) {
    if (!isPositiveSafeInteger(sequence) || !COMMIT_PATTERN.test(commit))
        throw new ReleaseValidationError("Cannot derive an invalid release identifier.");
    return `r${sequence}-${commit.slice(0, 12)}`;
}

export function releasePointer(manifest: ReleaseManifest, manifestSha256: string): ReleasePointer {
    if (!SHA256_PATTERN.test(manifestSha256))
        throw new ReleaseValidationError("Cannot create a release pointer without a valid manifest digest.");
    return {
        id: releaseId(manifest.sequence, manifest.commit),
        sequence: manifest.sequence,
        commit: manifest.commit,
        manifestSha256
    };
}
