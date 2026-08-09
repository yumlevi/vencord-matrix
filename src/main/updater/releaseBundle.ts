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

import { Unzip, UnzipInflate } from "fflate";

import { sha256Hex } from "./releaseTrust";
import {
    MAX_RUNTIME_BYTES,
    RELEASE_RUNTIME_FILES,
    ReleaseManifest,
    ReleaseValidationError
} from "./releaseTypes";

export type ExtractedRelease = ReadonlyMap<string, Buffer>;

export function extractReleaseBundle(bundle: Uint8Array, manifest: ReleaseManifest): ExtractedRelease {
    if (bundle.byteLength !== manifest.bundle.size || sha256Hex(bundle) !== manifest.bundle.sha256)
        throw new ReleaseValidationError("The downloaded release bundle does not match its signed manifest.");

    const expected = new Map(manifest.files.map(file => [file.path, file]));
    const extracted = new Map<string, Buffer>();
    const seenCaseInsensitive = new Set<string>();
    let extractedBytes = 0;
    let extractionError: unknown;

    const unzipper = new Unzip(file => {
        if (extractionError != null) {
            file.terminate();
            return;
        }

        try {
            const canonicalName = file.name.toLowerCase();
            const expectedFile = expected.get(file.name);
            if (expectedFile == null || seenCaseInsensitive.has(canonicalName)
                || file.name.includes("\\") || file.name.includes(":") || file.name.startsWith("/")
                || file.name.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
                throw new ReleaseValidationError("The release archive contains an unexpected path.");
            }
            if (file.compression !== 0 && file.compression !== 8)
                throw new ReleaseValidationError("The release archive uses an unsupported compression method.");
            if (file.originalSize != null && file.originalSize !== expectedFile.size)
                throw new ReleaseValidationError("The release archive contains an invalid file size.");

            seenCaseInsensitive.add(canonicalName);
            const chunks: Buffer[] = [];
            let fileBytes = 0;
            file.ondata = (error, chunk, final) => {
                try {
                    if (error != null)
                        throw error;
                    fileBytes += chunk.byteLength;
                    extractedBytes += chunk.byteLength;
                    if (fileBytes > expectedFile.size || extractedBytes > MAX_RUNTIME_BYTES)
                        throw new ReleaseValidationError("The release archive expands beyond its signed bounds.");
                    chunks.push(Buffer.from(chunk));
                    if (!final) return;

                    const contents = Buffer.concat(chunks, fileBytes);
                    if (contents.byteLength !== expectedFile.size || sha256Hex(contents) !== expectedFile.sha256)
                        throw new ReleaseValidationError("A release file does not match its signed digest.");
                    extracted.set(file.name, contents);
                } catch (error) {
                    extractionError ??= error;
                    file.terminate();
                }
            };
            file.start();
        } catch (error) {
            extractionError ??= error;
            file.terminate();
        }
    });
    unzipper.register(UnzipInflate);

    try {
        // Small input chunks keep the streaming inflater's transient output bounded.
        for (let offset = 0; offset < bundle.byteLength && extractionError == null; offset += 16 * 1024) {
            const end = Math.min(offset + 16 * 1024, bundle.byteLength);
            unzipper.push(bundle.subarray(offset, end), end === bundle.byteLength);
        }
    } catch (error) {
        extractionError ??= error;
    }

    if (extractionError != null) {
        if (extractionError instanceof ReleaseValidationError)
            throw extractionError;
        throw new ReleaseValidationError("The release archive could not be decoded safely.");
    }
    if (extracted.size !== RELEASE_RUNTIME_FILES.length
        || RELEASE_RUNTIME_FILES.some(path => !extracted.has(path))) {
        throw new ReleaseValidationError("The release archive is missing required files.");
    }

    return extracted;
}
