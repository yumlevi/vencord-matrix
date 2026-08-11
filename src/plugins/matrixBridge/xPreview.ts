/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const X_POSTER_HOST = "pbs.twimg.com";
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 33_554_432;
const EMBED_CARDS = new Set(["tweet", "summary", "summary_large_image", "player"]);

export type XPreviewImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ParsedXPreviewImage {
    url: string;
    mimeType: XPreviewImageMime;
    width: number;
    height: number;
}

export interface ParsedXPreviewVideo {
    url: string;
    width: number;
    height: number;
}

export interface ParsedXPreview {
    title: string;
    description?: string;
    image?: ParsedXPreviewImage;
    video?: ParsedXPreviewVideo;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value != null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function previewText(value: unknown, maximum: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
        .trim()
        .slice(0, maximum)
        .trim();
    return text || undefined;
}

function dimensions(widthValue: unknown, heightValue: unknown): { width: number; height: number; } | undefined {
    const numeric = (value: unknown) => typeof value === "string" && /^[1-9]\d{0,5}$/u.test(value)
        ? Number(value)
        : value;
    const width = numeric(widthValue);
    const height = numeric(heightValue);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || Number(width) <= 0 || Number(height) <= 0
        || Number(width) > MAX_IMAGE_DIMENSION || Number(height) > MAX_IMAGE_DIMENSION
        || Number(width) * Number(height) > MAX_IMAGE_PIXELS) return undefined;
    return { width: Number(width), height: Number(height) };
}

export function xPosterUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== X_POSTER_HOST
            || url.username || url.password || url.port || url.hash || url.href !== value
            || !/^\/(?:media|tweet_video_thumb|ext_tw_video_thumb|amplify_video_thumb)\/[A-Za-z0-9_./-]{1,1024}$/u.test(url.pathname)) {
            return undefined;
        }
        const parameters = Array.from(url.searchParams.entries());
        if (parameters.some(([name, parameter]) =>
            name === "format"
                ? !/^(?:jpe?g|png|webp)$/iu.test(parameter)
                : name === "name"
                    ? !/^[A-Za-z0-9_]{1,32}$/u.test(parameter)
                    : true)
            || new Set(parameters.map(([name]) => name)).size !== parameters.length) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

export function xVideoUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "video.twimg.com"
            || url.username || url.password || url.port || url.hash || url.href !== value
            || !url.pathname.toLowerCase().endsWith(".mp4")) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

function imageMime(value: unknown, urlValue: string): XPreviewImageMime | undefined {
    const url = new URL(urlValue);
    const urlFormat = url.searchParams.get("format")?.toLowerCase();
    const inferred = urlFormat === "jpg" || urlFormat === "jpeg" || /\.jpe?g$/iu.test(url.pathname)
        ? "image/jpeg"
        : urlFormat === "png" || /\.png$/iu.test(url.pathname)
            ? "image/png"
            : urlFormat === "webp" || /\.webp$/iu.test(url.pathname)
                ? "image/webp"
                : undefined;
    if (value == null) return inferred;
    const format = typeof value === "string" ? value.toLowerCase() : "";
    const declared = format === "jpg" || format === "jpeg" || format === "image/jpeg"
        ? "image/jpeg"
        : format === "png" || format === "image/png"
            ? "image/png"
            : format === "webp" || format === "image/webp"
                ? "image/webp"
                : undefined;
    if (!declared) return undefined;
    return inferred != null && inferred !== declared ? undefined : declared;
}

/** Parse and sanitize the bounded FxTwitter v2 shape without exposing request URLs. */
export function parseFxTwitterStatus(value: unknown, statusId: string): ParsedXPreview | undefined {
    if (!/^\d{2,20}$/u.test(statusId)) return undefined;
    const response = record(value);
    const status = record(response?.status);
    const author = record(status?.author);
    const mediaValue = status?.media;
    const media = record(mediaValue);
    const photos = media?.photos;
    const videos = media?.videos;
    const screenName = author?.screen_name;
    const authorName = author?.name;
    const text = status?.text;
    if (response?.code !== 200 || status?.type !== "status" || status.id !== statusId
        || status.provider !== "twitter" || !EMBED_CARDS.has(String(status.embed_card))
        || author?.type !== "profile"
        || typeof screenName !== "string" || !/^[A-Za-z0-9_]{1,15}$/u.test(screenName)
        || (authorName != null && (typeof authorName !== "string" || authorName.length > 256))
        || typeof text !== "string" || text.length > 65_536
        || (mediaValue != null && !media)
        || (photos != null && (!Array.isArray(photos) || photos.length > 4))
        || (videos != null && (!Array.isArray(videos) || videos.length > 16))) {
        return undefined;
    }

    const title = previewText(authorName ? `${authorName} (@${screenName})` : `@${screenName}`, 512);
    if (!title) return undefined;
    const preview: ParsedXPreview = { title };
    const description = previewText(text, 4_096);
    if (description) preview.description = description;

    for (const value of Array.isArray(videos) ? videos : []) {
        const candidate = record(value);
        if (!candidate || (candidate.type !== "video" && candidate.type !== "gif")
            || candidate.format !== "video/mp4") continue;
        const url = xVideoUrl(candidate.url);
        const posterUrl = xPosterUrl(candidate.thumbnail_url);
        const posterMimeType = posterUrl ? imageMime(candidate.thumbnail_format, posterUrl) : undefined;
        const size = dimensions(candidate.width, candidate.height);
        if (!url || !posterUrl || !posterMimeType || !size) continue;
        preview.image = { url: posterUrl, mimeType: posterMimeType, ...size };
        preview.video = { url, ...size };
        return preview;
    }

    for (const value of Array.isArray(photos) ? photos : []) {
        const candidate = record(value);
        if (!candidate || (candidate.type !== "photo" && candidate.type !== "gif")) continue;
        const url = xPosterUrl(candidate.url);
        const mimeType = url ? imageMime(candidate.format, url) : undefined;
        const size = dimensions(candidate.width, candidate.height);
        if (!url || !mimeType || !size) continue;
        preview.image = { url, mimeType, ...size };
        break;
    }
    return preview;
}

export function validXPreviewMediaCache(input: {
    imageUrl?: string;
    videoUrl?: string;
    hasImage: boolean;
    hasVideo: boolean;
}): boolean {
    if (input.hasImage !== (input.imageUrl != null) || input.hasVideo !== (input.videoUrl != null)
        || input.hasVideo && !input.hasImage) return false;
    return (input.imageUrl == null || xPosterUrl(input.imageUrl) === input.imageUrl)
        && (input.videoUrl == null || xVideoUrl(input.videoUrl) === input.videoUrl);
}
