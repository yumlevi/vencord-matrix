/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Current Discord attachment-media factory. Its stock poster helper appends a
 * CDN transform query to proxy_url, which cannot be used with an exact Blob.
 * Captures intentionally preserve every mangled local except the expression
 * that chooses the poster.
 */
export const MATRIX_VIDEO_POSTER_PATCH = /if\("VIDEO"===(\i)&&(\i)&&null!=(\i)\)\{let (\i)=(\i)\.poster\?\?(\i)\(\3\);/;

export const MATRIX_VIDEO_POSTER_REPLACEMENT = 'if("VIDEO"===$1&&$2&&null!=$3){let $4=$self.getMatrixVideoPosterUrl($3)??$5.poster??$6($3);';

/** Current inline attachment/mosaic projection, before the player mounts. */
export const MATRIX_INLINE_VIDEO_POSTER_PATCH = /if\((\i)\)\{let (\i)=(\i)\.A\.toURLSafe\((\i)\);if\(null==\2\)return null;\2\.searchParams\.append\("format","webp"\),(\i)=\2\.toString\(\)\}/;

export const MATRIX_INLINE_VIDEO_POSTER_REPLACEMENT = 'if($1){let $2=$self.getMatrixVideoPosterUrl($4);if(null!=$2)$5=$2;else if(null==($2=$3.A.toURLSafe($4)))return null;else $2.searchParams.append("format","webp"),$5=$2.toString()}';

// The marker lets the poster boundary fail safe even during the short gap
// between Discord retaining a parsed attachment and the bridge rebuilding its
// media cache. It never changes the Blob resource selected by a <video>.
export const MATRIX_VIDEO_RENDER_FRAGMENT = "#matrix-video";

// A passive, opaque #1e1f22 PNG. Discord's ImageLoaderUtils deliberately
// returns data:image URLs unchanged, so this cannot acquire a CDN query or be
// invalidated by URL.revokeObjectURL().
export const MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY5CTV/oPAAIdAV8tFib0AAAAAElFTkSuQmCC";

export function matrixVideoObjectUrlBase(value: unknown) {
    if (typeof value !== "string" || !value.startsWith("blob:")) return undefined;
    const suffix = value.search(/[?#]/u);
    return suffix === -1 ? value : value.slice(0, suffix);
}

export function isMarkedMatrixVideoUrl(value: unknown) {
    return typeof value === "string"
        && matrixVideoObjectUrlBase(value) != null
        && value.slice(value.indexOf("#") + 1).split("?", 1)[0] === MATRIX_VIDEO_RENDER_FRAGMENT.slice(1);
}

export function matrixVideoFallbackPoster(value: unknown) {
    return isMarkedMatrixVideoUrl(value) ? MATRIX_VIDEO_FALLBACK_POSTER_DATA_URL : undefined;
}
