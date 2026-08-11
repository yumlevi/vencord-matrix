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
