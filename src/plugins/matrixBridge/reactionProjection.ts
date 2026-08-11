/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Preserve Discord's stock partial-update rule outside Matrix projections. */
export function selectProjectedMessageReactions(
    matrixChannel: boolean,
    existing: unknown,
    incoming: unknown
): unknown {
    return matrixChannel && incoming != null ? incoming : existing ?? incoming;
}

export const MATRIX_EDITED_REACTION_UPDATE_PATCH = /(null!=(\i)\.edited_timestamp\)return (?:Object\.assign\()?(\i)\(\2,\{)reactions:(\i)\.reactions,interactionData:\4\.interactionData/;
export const MATRIX_PARTIAL_REACTION_UPDATE_PATCH = /null!=(\i)\.reactions&&\((\i)=\2\.set\("reactions",(\i)\((\i)\.reactions\?\?\1\.reactions\)\)\)/;

export function patchEditedMatrixReactionUpdate(
    _match: string,
    prefix: string,
    incoming: string,
    _convert: string,
    existing: string
): string {
    return `${prefix}reactions:$self.matrixMessageUpdateReactions(${incoming}.channel_id,${existing}.reactions,${incoming}.reactions),interactionData:${existing}.interactionData`;
}

export function patchPartialMatrixReactionUpdate(
    _match: string,
    incoming: string,
    message: string,
    convert: string,
    existing: string
): string {
    return `null!=${incoming}.reactions&&(${message}=${message}.set("reactions",${convert}($self.matrixMessageUpdateReactions(${incoming}.channel_id,${existing}.reactions,${incoming}.reactions))))`;
}
