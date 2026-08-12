/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalizeMatch } from "../src/utils/patches";
import { sniffVideoContainerMetadata } from "../src/plugins/matrixBridge/videoContainerMetadata";
import {
    isMarkedMatrixVideoUrl,
    MATRIX_INLINE_VIDEO_POSTER_PATCH,
    MATRIX_INLINE_VIDEO_POSTER_REPLACEMENT,
    MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL,
    MATRIX_VIDEO_POSTER_PATCH,
    MATRIX_VIDEO_POSTER_REPLACEMENT,
    MATRIX_VIDEO_RENDER_FRAGMENT,
    matrixVideoFallbackPoster,
    matrixVideoObjectUrlBase,
} from "../src/plugins/matrixBridge/videoPosterPatch";

function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function ascii(value: string): Uint8Array {
    return Uint8Array.from(value, character => character.charCodeAt(0));
}

function uint32(value: number): Uint8Array {
    return Uint8Array.of(value >>> 24, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff);
}

function isoBox(type: string, payload: Uint8Array): Uint8Array {
    return bytes(uint32(payload.byteLength + 8), ascii(type), payload);
}

function trackHeader(width: number, height: number, rotated = false): Uint8Array {
    const payload = new Uint8Array(84);
    const view = new DataView(payload.buffer);
    const matrixOffset = 40;
    view.setInt32(matrixOffset, rotated ? 0 : 65_536);
    view.setInt32(matrixOffset + 4, rotated ? 65_536 : 0);
    view.setInt32(matrixOffset + 12, rotated ? -65_536 : 0);
    view.setInt32(matrixOffset + 16, rotated ? 0 : 65_536);
    view.setInt32(matrixOffset + 32, 0x4000_0000);
    view.setUint32(76, width * 65_536);
    view.setUint32(80, height * 65_536);
    return isoBox("tkhd", payload);
}

function isoVideo(brand: string, width: number, height: number, rotated = false): Uint8Array {
    const fileType = isoBox("ftyp", bytes(ascii(brand), uint32(0), ascii(brand), ascii("isom")));
    const handler = isoBox("hdlr", bytes(new Uint8Array(8), ascii("vide")));
    const media = isoBox("mdia", handler);
    const movie = isoBox("moov", isoBox("trak", bytes(trackHeader(width, height, rotated), media)));
    // A passive box before ftyp and media data before moov exercise bounded
    // top-level traversal rather than the old bytes[4..8] shortcut.
    return bytes(isoBox("free", new Uint8Array(16)), fileType, isoBox("mdat", new Uint8Array(32)), movie);
}

function ebmlSize(value: number): Uint8Array {
    assert.ok(value >= 0 && value <= 0x3fff);
    return value < 0x7f
        ? Uint8Array.of(0x80 | value)
        : Uint8Array.of(0x40 | value >>> 8, value & 0xff);
}

function ebmlElement(id: number[], payload: Uint8Array): Uint8Array {
    return bytes(id, ebmlSize(payload.byteLength), payload);
}

function ebmlUnsigned(id: number[], value: number): Uint8Array {
    const payload = value <= 0xff
        ? Uint8Array.of(value)
        : value <= 0xffff
            ? Uint8Array.of(value >>> 8, value & 0xff)
            : uint32(value);
    return ebmlElement(id, payload);
}

function webmVideo(width: number, height: number): Uint8Array {
    const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], ebmlElement([0x42, 0x82], ascii("webm")));
    const video = ebmlElement([0xe0], bytes(
        ebmlUnsigned([0xb0], width),
        ebmlUnsigned([0xba], height)
    ));
    const track = ebmlElement([0xae], bytes(ebmlUnsigned([0x83], 1), video));
    const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], track);
    return bytes(header, ebmlElement([0x18, 0x53, 0x80, 0x67], tracks));
}

assert.deepEqual(
    sniffVideoContainerMetadata(isoVideo("mp42", 1_920, 1_080)),
    { mimeType: "video/mp4", width: 1_920, height: 1_080 },
    "an MP4 must recover dimensions even when Matrix info.w/h is absent"
);
assert.deepEqual(
    sniffVideoContainerMetadata(isoVideo("qt  ", 1_920, 1_080, true)),
    { mimeType: "video/quicktime", width: 1_080, height: 1_920 },
    "a rotated QuickTime upload must become an inline portrait video"
);
assert.deepEqual(
    sniffVideoContainerMetadata(webmVideo(1_280, 720)),
    { mimeType: "video/webm", width: 1_280, height: 720 },
    "a WebM must recover dimensions without trusting its filename"
);

const m4a = isoBox("ftyp", bytes(ascii("M4A "), uint32(0), ascii("M4A "), ascii("isom")));
assert.deepEqual(sniffVideoContainerMetadata(m4a, "audio/mp4"), { mimeType: "audio/mp4" });
assert.equal(
    sniffVideoContainerMetadata(isoBox("ftyp", bytes(ascii("evil"), uint32(0), ascii("evil"))), "video/mp4"),
    undefined,
    "a declared MIME alone must not activate an unknown ISO-BMFF container"
);
const avif = isoBox("ftyp", bytes(ascii("avif"), uint32(0), ascii("avif"), ascii("av01"), ascii("isom")));
assert.equal(
    sniffVideoContainerMetadata(avif, "image/avif"),
    undefined,
    "an AVIF still's ambiguous codec/ISO brands must not activate it as video"
);
assert.equal(
    sniffVideoContainerMetadata(avif, "video/mp4", "video/mp4"),
    undefined,
    "false sender/server video MIME must not promote AVIF still bytes"
);
const heif = isoBox("ftyp", bytes(ascii("mif1"), uint32(0), ascii("heic"), ascii("hvc1"), ascii("isom")));
assert.equal(
    sniffVideoContainerMetadata(heif, "video/mp4", "video/mp4"),
    undefined,
    "false sender/server video MIME must not promote HEIF still bytes"
);
const bareIsom = isoBox("ftyp", bytes(ascii("isom"), uint32(0), ascii("isom"), ascii("av01")));
assert.equal(
    sniffVideoContainerMetadata(bareIsom, "video/mp4", "video/mp4"),
    undefined,
    "a bare ISO/codec brand without trak/mdia/hdlr=vide must remain passive"
);
assert.equal(
    sniffVideoContainerMetadata(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x84], ascii("webm"))),
    undefined,
    "a byte substring must not impersonate a structured WebM header"
);
assert.doesNotThrow(() => sniffVideoContainerMetadata(bytes(uint32(0xffff_ffff), ascii("ftyp"))));
const tinyBoxes = bytes(...Array.from({ length: 9_000 }, () => isoBox("free", new Uint8Array())));
const scanStarted = performance.now();
assert.equal(sniffVideoContainerMetadata(tinyBoxes), undefined);
assert.ok(performance.now() - scanStarted < 1_000, "adversarial tiny boxes must stop at the global traversal bound");

const backend = readFileSync(new URL("../src/plugins/matrixBridge/matrixBackend.ts", import.meta.url), "utf8");
const native = readFileSync(new URL("../src/plugins/matrixBridge/native.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/plugins/matrixBridge/bridge.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/plugins/matrixBridge/index.tsx", import.meta.url), "utf8");

assert.match(backend, /const videoContainer = sniffVideoContainerMetadata\(bytes, declared, server\);[\s\S]*if \(videoContainer\) return videoContainer;/u);
assert.match(backend, /const videoDimensions = sniffed\.mimeType\.startsWith\("video\/"\)[\s\S]*attachment\.width != null && attachment\.height != null/u,
    "trusted container dimensions must fall back to valid Matrix info dimensions");
assert.match(backend, /const bytes = encryptedFile \? await decryptMedia\(downloaded\.bytes, encryptedFile\) : downloaded\.bytes;[\s\S]*sniffedMedia\(bytes/u,
    "encrypted uploads must be decrypted before container sniffing");
assert.match(backend, /event\.getType\(\) !== EventType\.RoomMessage[\s\S]*content\.msgtype !== expectedMessageType/u,
    "transaction replay must verify that a local/remote echo retained its video message type");
assert.match(native, /const width = result\.width == null \? undefined : Number\(result\.width\);[\s\S]*\(width == null\) !== \(height == null\)/u,
    "the native DTO boundary must continue requiring a complete dimension pair");
assert.match(bridge, /if \(!message\.eventId\.startsWith\("\$"\)\) continue;[\s\S]*Native\.downloadMedia\(message\.roomId, message\.eventId, 0\)/u,
    "local echoes must wait for their canonical remote event before media download");

// Current Discord uses attachment.proxy_url for the video source, then derives
// the poster by adding ?format=webp to that same URL. Queries are valid on its
// CDN, but they change a Blob URL's exact resource key.
const videoBlob = "blob:https://discord.com/00000000-0000-4000-8000-000000000000#";
const transformedPoster = new URL(videoBlob);
transformedPoster.searchParams.append("format", "webp");
const blobResourceKey = (value: string) => {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
};
assert.notEqual(blobResourceKey(transformedPoster.toString()), blobResourceKey(videoBlob),
    "Discord's stock poster transform invalidates an exact local video Blob");

// Keep this factory-shaped fixture aligned with Discord's current minified
// media renderer. The production patch substitutes only the poster expression;
// proxy_url remains the player source.
const currentDiscordVideoFactory = 'if("VIDEO"===M&&F&&null!=v){let e=p.poster??O(v);if(null==e)return null;return player({src:k,poster:e,disableArrowKeySeek:!0})}';
const currentFactoryPoster = canonicalizeMatch(MATRIX_VIDEO_POSTER_PATCH);
assert.equal(currentDiscordVideoFactory.match(currentFactoryPoster)?.length, 7,
    "the narrow poster patch must match Discord's current video factory exactly once");
const patchedFactory = currentDiscordVideoFactory.replace(
    currentFactoryPoster,
    MATRIX_VIDEO_POSTER_REPLACEMENT
);
assert.match(patchedFactory, /src:k,poster:e/u, "the player source and poster arguments must remain distinct");
assert.match(patchedFactory, /getMatrixVideoPosterUrl\(v\)\?\?p\.poster\?\?O\(v\)/u,
    "only an owned Matrix poster may override Discord's CDN poster derivation");
assert.doesNotThrow(() => new Function(patchedFactory),
    "the media-viewer replacement must remain valid JavaScript");

// The normal chat timeline uses a separate attachment/mosaic projection before
// the media-viewer factory above. This was the live path that still generated
// blob:?format=webp and the delayed LazyImage failure.
const currentDiscordInlineFactory = 'let _=isVideo,E=isThumbnail,A=n??i;if(_){let e=f.A.toURLSafe(n);if(null==e)return null;e.searchParams.append("format","webp"),A=e.toString()}return{type:"attachment",src:A,contentScanVersion:u,alt:r,isVideo:_,isThumbnail:E,srcUnfurledMediaItem:x}';
const currentInlinePoster = canonicalizeMatch(MATRIX_INLINE_VIDEO_POSTER_PATCH);
assert.equal(currentDiscordInlineFactory.match(currentInlinePoster)?.length, 6,
    "the inline poster patch must match Discord's current mosaic projection exactly once");
const patchedInlineFactory = currentDiscordInlineFactory.replace(
    currentInlinePoster,
    MATRIX_INLINE_VIDEO_POSTER_REPLACEMENT
);
assert.match(patchedInlineFactory, /getMatrixVideoPosterUrl\(n\)[\s\S]*A=e[\s\S]*toURLSafe\(n\)[\s\S]*searchParams\.append\("format","webp"\)/u,
    "inline Matrix videos must use the safe poster while Discord videos retain the stock transform");
assert.doesNotThrow(() => new Function(patchedInlineFactory),
    "the inline mosaic replacement must remain valid JavaScript");
assert.match(index, /find: "disableArrowKeySeek:!0"[\s\S]*match: MATRIX_VIDEO_POSTER_PATCH,[\s\S]*replace: MATRIX_VIDEO_POSTER_REPLACEMENT,/u,
    "the production patch must target the current video factory and preserve its stock fallback");
assert.match(index, /find: "srcUnfurledMediaItem:"[\s\S]*match: MATRIX_INLINE_VIDEO_POSTER_PATCH,[\s\S]*replace: MATRIX_INLINE_VIDEO_POSTER_REPLACEMENT,/u,
    "the production patch must also cover the normal inline attachment timeline");

assert.match(bridge, /function passiveLocalVideoPoster\(\): LocalVideoPoster \{[\s\S]*renderUrl: MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL,[\s\S]*byteLength: MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL\.length \* 2,/u,
    "every local video poster must be the fixed, content-independent passive image");
assert.match(bridge, /const poster = needsLocalVideoPoster && result\.mimeType\.toLowerCase\(\)\.startsWith\("video\/"\)[\s\S]*\? passiveLocalVideoPoster\(\)[\s\S]*: undefined;/u,
    "only sniffed direct videos may allocate the fixed passive poster");
assert.doesNotMatch(bridge, /materializeVideoPoster|canvasVideoPoster|boundedVideoPosterDataUrl|FileReader|readAsDataURL|drawImage|\.toBlob\(|data:image\/jpeg/u,
    "poster construction must never decode or embed a private video frame");
assert.match(bridge, /Native\.downloadMedia\(message\.roomId, message\.eventId, 0\) as MatrixMediaDownloadDto,\s*true\s*\)/u,
    "direct uploaded media must explicitly request a local video poster");
assert.doesNotMatch(bridge, /video\.downloadIndex\) as MatrixMediaDownloadDto,\s*true/u,
    "provider videos already have an explicit preview image and must not allocate a redundant poster");
assert.match(bridge, /byteLength: MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL\.length \* 2/u,
    "poster accounting must include the worst-case JavaScript string storage");
assert.match(bridge, /entry\.objectUrl = media\.objectUrl;[\s\S]*entry\.posterUrl = media\.posterUrl;/u,
    "the video and its non-revocable data poster must enter the cache atomically");
assert.doesNotMatch(bridge, /posterObjectUrl/u,
    "a poster must never regain an independently revocable Blob lifecycle");
assert.match(bridge, /if \(entry\.objectUrl\) URL\.revokeObjectURL\(entry\.objectUrl\);[\s\S]*hydratedMediaBytes = Math\.max\(0, hydratedMediaBytes - \(entry\.byteLength \?\? 0\)\);[\s\S]*entry\.posterUrl = undefined;/u,
    "cache release must account for the poster string without trying to revoke it");
assert.match(bridge, /projectionNeedsRefresh \|\|= entry\.state === "ready"[\s\S]*projectionNeedsRefresh = true;[\s\S]*if \(projectionNeedsRefresh\) scheduleMediaSnapshotRefresh\(\);/u,
    "eviction and revisit hydration must promptly remove stale Blob URLs from Discord's retained message rows");
assert.match(bridge, /export function getMatrixVideoPosterUrl[\s\S]*matrixVideoObjectUrlBase\(value\)[\s\S]*entry\.objectUrl === objectUrl[\s\S]*return matrixVideoFallbackPoster\(value\);/u,
    "poster substitution must normalize owned object URLs and fail safe for a marked retained row");
assert.match(bridge, /needsLocalVideoPoster && normalizedMimeType\.startsWith\("video\/"\)[\s\S]*MATRIX_VIDEO_RENDER_FRAGMENT/u,
    "only direct hydrated videos may receive the cache-gap marker");

const markedVideoBlob = `${blobResourceKey(videoBlob)}${MATRIX_VIDEO_RENDER_FRAGMENT}`;
assert.equal(matrixVideoObjectUrlBase(markedVideoBlob), blobResourceKey(videoBlob));
assert.equal(isMarkedMatrixVideoUrl(markedVideoBlob), true);
assert.equal(matrixVideoFallbackPoster(markedVideoBlob), MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL,
    "a marked Matrix video must receive a valid poster even after an exact cache lookup misses");
assert.equal(matrixVideoFallbackPoster(`${blobResourceKey(videoBlob)}#`), undefined,
    "an unmarked Blob must retain Discord's normal behavior");

// Discord build 591432's ImageLoaderUtils exits before adding format/size
// queries for data:image. Model that exact branch as an executable contract.
const currentDiscordImageLoader = (src: string) => src.startsWith("data:image")
    ? src
    : `${src}?format=webp`;
assert.equal(
    currentDiscordImageLoader(MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL),
    MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL,
    "Discord must not rewrite the passive fallback image"
);

// Its LazyImage component also does not reset ERROR when only src changes.
// A revoked Blob poster therefore stays broken, while a self-contained data
// image remains usable by both the retained row and its replacement mount.
type LazyImageState = "LOADING" | "READY" | "ERROR";
const currentDiscordLazyImagePropUpdate = (state: LazyImageState, _nextSrc: string): LazyImageState => state;
assert.equal(currentDiscordLazyImagePropUpdate("ERROR", MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL), "ERROR");
assert.ok(MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL.startsWith("data:image/png;base64,"));
const fallbackPosterPayload = MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL.slice("data:image/png;base64,".length);
const fallbackPosterBytes = Buffer.from(fallbackPosterPayload, "base64");
assert.equal(fallbackPosterBytes.toString("base64"), fallbackPosterPayload,
    "the passive fallback must contain canonical base64");
assert.deepEqual([...fallbackPosterBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the passive fallback must contain a real PNG signature");
assert.equal(fallbackPosterBytes.toString("ascii", 12, 16), "IHDR");
assert.equal(fallbackPosterBytes.readUInt32BE(16), 1);
assert.equal(fallbackPosterBytes.readUInt32BE(20), 1);

console.log("Matrix uploaded-video fixture passed.");
