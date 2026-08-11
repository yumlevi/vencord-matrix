/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_VIDEO_DIMENSION = 16_384;
const MAX_VIDEO_PIXELS = 33_554_432;
const MAX_EBML_INTEGER_BYTES = 4;
const MAX_CONTAINER_ELEMENTS = 8_192;

export type SniffedVideoContainerMimeType = "video/mp4" | "video/quicktime" | "video/webm";

export interface SniffedContainerMetadata {
    mimeType: SniffedVideoContainerMimeType | "audio/mp4";
    width?: number;
    height?: number;
}

interface ByteRange {
    start: number;
    end: number;
}

interface ScanBudget {
    remaining: number;
}

interface IsoBox extends ByteRange {
    type: string;
    dataStart: number;
}

interface EbmlElement extends ByteRange {
    id: number;
    dataStart: number;
}

const ISO_VIDEO_BRANDS = new Set([
    "3g2a", "3g2b", "3g2c", "3ge6", "3ge7", "3ge9", "3gf9", "3gg6", "3gp1", "3gp2", "3gp3",
    "3gp4", "3gp5", "3gp6", "3gp7", "3gp8", "3gp9", "3gr6", "3gs6", "F4P ", "F4V ", "M4V ",
    "M4VH", "M4VP", "MSNV", "av01", "avc1", "dash", "hev1", "hvc1", "iso2", "iso3", "iso4", "iso5",
    "iso6", "iso7", "iso8", "iso9", "isom", "mp41", "mp42", "msdh", "msix"
]);
const ISO_AUDIO_BRANDS = new Set(["F4A ", "F4B ", "M4A ", "M4B "]);
const QUICKTIME_BRAND = "qt  ";

const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_SEGMENT_ID = 0x18538067;
const EBML_TRACKS_ID = 0x1654ae6b;
const EBML_TRACK_ENTRY_ID = 0xae;
const EBML_TRACK_TYPE_ID = 0x83;
const EBML_VIDEO_ID = 0xe0;
const EBML_PIXEL_WIDTH_ID = 0xb0;
const EBML_PIXEL_HEIGHT_ID = 0xba;
const EBML_DOC_TYPE_ID = 0x4282;

function ascii(bytes: Uint8Array, offset: number, length: number): string | undefined {
    if (offset < 0 || length < 0 || offset + length > bytes.byteLength) return undefined;
    let result = "";
    for (let index = 0; index < length; index++) {
        const byte = bytes[offset + index];
        if (byte < 0x20 || byte > 0x7e) return undefined;
        result += String.fromCharCode(byte);
    }
    return result;
}

function dimensions(widthValue: number, heightValue: number): { width: number; height: number; } | undefined {
    const width = Math.round(widthValue);
    const height = Math.round(heightValue);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > MAX_VIDEO_DIMENSION || height > MAX_VIDEO_DIMENSION
        || width * height > MAX_VIDEO_PIXELS) return undefined;
    return { width, height };
}

function unsigned32(bytes: Uint8Array, offset: number): number | undefined {
    if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function signed32(bytes: Uint8Array, offset: number): number | undefined {
    if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}

function isoBox(bytes: Uint8Array, offset: number, parentEnd: number): IsoBox | undefined {
    if (offset < 0 || parentEnd > bytes.byteLength || offset + 8 > parentEnd) return undefined;
    const smallSize = unsigned32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (smallSize == null || !type) return undefined;

    let headerSize = 8;
    let size = smallSize;
    if (smallSize === 1) {
        if (offset + 16 > parentEnd) return undefined;
        const high = unsigned32(bytes, offset + 8);
        const low = unsigned32(bytes, offset + 12);
        if (high == null || low == null || high > 0x1f_ffff) return undefined;
        size = high * 0x1_0000_0000 + low;
        headerSize = 16;
    } else if (smallSize === 0) {
        size = parentEnd - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || size > parentEnd - offset) return undefined;
    return {
        type,
        start: offset,
        dataStart: offset + headerSize,
        end: offset + size
    };
}

function consume(budget: ScanBudget): boolean {
    if (budget.remaining < 1) return false;
    budget.remaining--;
    return true;
}

function isoChildren(bytes: Uint8Array, range: ByteRange, budget: ScanBudget): IsoBox[] | undefined {
    const children: IsoBox[] = [];
    for (let offset = range.start; offset + 8 <= range.end;) {
        if (!consume(budget)) return undefined;
        const child = isoBox(bytes, offset, range.end);
        if (!child) return undefined;
        children.push(child);
        if (child.end <= offset) return undefined;
        offset = child.end;
    }
    return range.end - (children.at(-1)?.end ?? range.start) < 8 ? children : undefined;
}

function trackHeaderDimensions(bytes: Uint8Array, box: IsoBox): { width: number; height: number; } | undefined {
    // Both version 0 and version 1 tkhd boxes end in a 3x3 transform matrix
    // followed by unsigned 16.16 width and height fields.
    const version = bytes[box.dataStart];
    const minimumLength = version === 0 ? 84 : version === 1 ? 96 : undefined;
    if (!minimumLength || box.end - box.dataStart < minimumLength) return undefined;
    const rawWidth = unsigned32(bytes, box.end - 8);
    const rawHeight = unsigned32(bytes, box.end - 4);
    if (rawWidth == null || rawHeight == null) return undefined;
    let result = dimensions(rawWidth / 65_536, rawHeight / 65_536);
    if (!result) return undefined;

    const matrixOffset = box.end - 44;
    const a = signed32(bytes, matrixOffset);
    const b = signed32(bytes, matrixOffset + 4);
    const c = signed32(bytes, matrixOffset + 12);
    const d = signed32(bytes, matrixOffset + 16);
    const quarterTurn = a === 0 && d === 0
        && Math.abs(b ?? 0) === 65_536 && Math.abs(c ?? 0) === 65_536;
    if (quarterTurn) result = { width: result.height, height: result.width };
    return result;
}

function videoHandler(bytes: Uint8Array, media: IsoBox, budget: ScanBudget): boolean | undefined {
    const children = isoChildren(bytes, { start: media.dataStart, end: media.end }, budget);
    if (!children) return undefined;
    const handler = children.find(child => child.type === "hdlr");
    if (!handler || handler.end - handler.dataStart < 12) return false;
    return ascii(bytes, handler.dataStart + 8, 4) === "vide";
}

function isoVideoTrack(
    bytes: Uint8Array,
    moov: IsoBox,
    budget: ScanBudget
): { found: boolean; dimensions?: { width: number; height: number; }; } | undefined {
    let best: { width: number; height: number; } | undefined;
    let found = false;
    const tracks = isoChildren(bytes, { start: moov.dataStart, end: moov.end }, budget);
    if (!tracks) return undefined;
    for (const track of tracks) {
        if (track.type !== "trak") continue;
        const trackChildren = isoChildren(bytes, { start: track.dataStart, end: track.end }, budget);
        if (!trackChildren) return undefined;
        const media = trackChildren.find(child => child.type === "mdia");
        if (!media) continue;
        const isVideo = videoHandler(bytes, media, budget);
        if (isVideo == null) return undefined;
        if (!isVideo) continue;
        found = true;
        const header = trackChildren.find(child => child.type === "tkhd");
        const candidate = header ? trackHeaderDimensions(bytes, header) : undefined;
        if (candidate && (!best || candidate.width * candidate.height > best.width * best.height)) best = candidate;
    }
    return { found, dimensions: best };
}

function isoMetadata(bytes: Uint8Array): SniffedContainerMetadata | undefined {
    const budget: ScanBudget = { remaining: MAX_CONTAINER_ELEMENTS };
    let fileType: IsoBox | undefined;
    let movie: IsoBox | undefined;
    for (let offset = 0; offset + 8 <= bytes.byteLength;) {
        if (!consume(budget)) return undefined;
        const box = isoBox(bytes, offset, bytes.byteLength);
        if (!box) return undefined;
        if (box.type === "ftyp" && box.start <= 65_536 && !fileType) fileType = box;
        if (box.type === "moov" && !movie) movie = box;
        if (fileType && movie) break;
        offset = box.end;
    }
    if (!fileType || fileType.end - fileType.dataStart < 8
        || (fileType.end - fileType.dataStart - 8) % 4 !== 0) return undefined;

    const brands: string[] = [];
    const majorBrand = ascii(bytes, fileType.dataStart, 4);
    if (!majorBrand) return undefined;
    brands.push(majorBrand);
    for (let offset = fileType.dataStart + 8; offset + 4 <= fileType.end; offset += 4) {
        const brand = ascii(bytes, offset, 4);
        if (!brand) return undefined;
        brands.push(brand);
    }

    const quickTime = brands.includes(QUICKTIME_BRAND);
    const videoBrand = quickTime || brands.some(brand => ISO_VIDEO_BRANDS.has(brand));
    const audioBrand = brands.some(brand => ISO_AUDIO_BRANDS.has(brand));
    const videoTrack = movie ? isoVideoTrack(bytes, movie, budget) : { found: false };
    if (!videoTrack) return undefined;

    // ftyp alone is not enough to turn arbitrary ISO-BMFF bytes into active
    // content. An AVIF/HEIF still may advertise an av01/hvc1/isom compatible
    // brand. Sender and homeserver MIME fields are untrusted, so only a
    // verified trak/mdia/hdlr=vide hierarchy may activate ISO video bytes.
    // Explicit audio brands stay audio unless a real video track disproves
    // that classification.
    if (audioBrand && !videoTrack.found) return { mimeType: "audio/mp4" };
    if (videoBrand && videoTrack.found) {
        return {
            mimeType: quickTime ? "video/quicktime" : "video/mp4",
            ...videoTrack.dimensions
        };
    }
    return undefined;
}

function ebmlVint(
    bytes: Uint8Array,
    offset: number,
    maximumLength: number,
    preserveMarker: boolean
): { length: number; value: number; unknown: boolean; } | undefined {
    if (offset < 0 || offset >= bytes.byteLength) return undefined;
    const first = bytes[offset];
    let length = 1;
    let marker = 0x80;
    while (length <= maximumLength && (first & marker) === 0) {
        length++;
        marker >>= 1;
    }
    if (length > maximumLength || offset + length > bytes.byteLength) return undefined;

    let value = preserveMarker ? first : first & (marker - 1);
    let unknown = !preserveMarker && (first & (marker - 1)) === marker - 1;
    for (let index = 1; index < length; index++) {
        value = value * 256 + bytes[offset + index];
        unknown &&= bytes[offset + index] === 0xff;
        if (!Number.isSafeInteger(value)) return undefined;
    }
    return { length, value, unknown };
}

function ebmlElement(bytes: Uint8Array, offset: number, parentEnd: number): EbmlElement | undefined {
    if (offset < 0 || parentEnd > bytes.byteLength || offset >= parentEnd) return undefined;
    const id = ebmlVint(bytes, offset, 4, true);
    if (!id) return undefined;
    const size = ebmlVint(bytes, offset + id.length, 8, false);
    if (!size) return undefined;
    const dataStart = offset + id.length + size.length;
    const end = size.unknown ? parentEnd : dataStart + size.value;
    if (dataStart > parentEnd || !Number.isSafeInteger(end) || end < dataStart || end > parentEnd) return undefined;
    return { id: id.value, start: offset, dataStart, end };
}

function ebmlChildren(bytes: Uint8Array, range: ByteRange, budget: ScanBudget): EbmlElement[] | undefined {
    const children: EbmlElement[] = [];
    for (let offset = range.start; offset < range.end;) {
        if (!consume(budget)) return undefined;
        const child = ebmlElement(bytes, offset, range.end);
        if (!child) return undefined;
        children.push(child);
        if (child.end <= offset) return undefined;
        if (child.end === range.end) break;
        offset = child.end;
    }
    return children;
}

function ebmlUnsigned(bytes: Uint8Array, element: EbmlElement): number | undefined {
    const length = element.end - element.dataStart;
    if (length < 1 || length > MAX_EBML_INTEGER_BYTES) return undefined;
    let value = 0;
    for (let offset = element.dataStart; offset < element.end; offset++) value = value * 256 + bytes[offset];
    return Number.isSafeInteger(value) ? value : undefined;
}

function ebmlVideoTrack(
    bytes: Uint8Array,
    tracks: EbmlElement,
    budget: ScanBudget
): { found: boolean; dimensions?: { width: number; height: number; }; } | undefined {
    let best: { width: number; height: number; } | undefined;
    let found = false;
    const entries = ebmlChildren(bytes, { start: tracks.dataStart, end: tracks.end }, budget);
    if (!entries) return undefined;
    for (const entry of entries) {
        if (entry.id !== EBML_TRACK_ENTRY_ID) continue;
        const fields = ebmlChildren(bytes, { start: entry.dataStart, end: entry.end }, budget);
        if (!fields) return undefined;
        const trackType = fields.find(field => field.id === EBML_TRACK_TYPE_ID);
        const video = fields.find(field => field.id === EBML_VIDEO_ID);
        if (!trackType || ebmlUnsigned(bytes, trackType) !== 1 || !video) continue;
        found = true;
        const videoFields = ebmlChildren(bytes, { start: video.dataStart, end: video.end }, budget);
        if (!videoFields) return undefined;
        const widthElement = videoFields.find(field => field.id === EBML_PIXEL_WIDTH_ID);
        const heightElement = videoFields.find(field => field.id === EBML_PIXEL_HEIGHT_ID);
        const width = widthElement ? ebmlUnsigned(bytes, widthElement) : undefined;
        const height = heightElement ? ebmlUnsigned(bytes, heightElement) : undefined;
        const candidate = width != null && height != null ? dimensions(width, height) : undefined;
        if (candidate && (!best || candidate.width * candidate.height > best.width * best.height)) best = candidate;
    }
    return { found, dimensions: best };
}

function webmMetadata(bytes: Uint8Array): SniffedContainerMetadata | undefined {
    const budget: ScanBudget = { remaining: MAX_CONTAINER_ELEMENTS };
    if (!consume(budget)) return undefined;
    const header = ebmlElement(bytes, 0, bytes.byteLength);
    if (!header || header.id !== EBML_HEADER_ID) return undefined;
    const headerChildren = ebmlChildren(bytes, { start: header.dataStart, end: header.end }, budget);
    if (!headerChildren) return undefined;
    const docType = headerChildren.find(child => child.id === EBML_DOC_TYPE_ID);
    const type = docType ? ascii(bytes, docType.dataStart, docType.end - docType.dataStart) : undefined;
    if (type !== "webm") return undefined;

    if (!consume(budget)) return undefined;
    const segment = ebmlElement(bytes, header.end, bytes.byteLength);
    if (!segment || segment.id !== EBML_SEGMENT_ID) return undefined;
    const segmentChildren = ebmlChildren(bytes, { start: segment.dataStart, end: segment.end }, budget);
    if (!segmentChildren) return undefined;
    const tracks = segmentChildren.find(child => child.id === EBML_TRACKS_ID);
    if (!tracks) return undefined;
    const video = ebmlVideoTrack(bytes, tracks, budget);
    return video?.found ? { mimeType: "video/webm", ...video.dimensions } : undefined;
}

/**
 * Sniff passive media bytes into only the video/audio container types Discord
 * can safely hand to its native media renderer. Sender filenames never decide
 * the result, and untrusted sender/server MIME metadata cannot promote bytes
 * which do not contain a verified video track.
 */
export function sniffVideoContainerMetadata(
    bytes: Uint8Array,
    _declaredMimeType?: string,
    _serverMimeType?: string
): SniffedContainerMetadata | undefined {
    return isoMetadata(bytes) ?? webmMetadata(bytes);
}
