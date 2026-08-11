/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Match both Discord's stock edited-message converter and Matrix's composable reaction rewrite. */
export const EDITED_MESSAGE_TRANSFORM_PATCH = /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:.{1,300}?,interactionData:(\i)\.interactionData\}\)/;

export function patchEditedMessageTransform(match: string, existing: string): string {
    return `Object.assign(${match},{ deleted:${existing}.deleted, editHistory:${existing}.editHistory, firstEditTimestamp:${existing}.firstEditTimestamp })`;
}
