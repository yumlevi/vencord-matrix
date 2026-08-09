/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MATRIX_ERROR_CODE_PATTERN = /^(?:MATRIX_|M_|ORG[._])[A-Z0-9._]+$/u;
const WRAPPED_MATRIX_ERROR_CODE_PATTERN = /(?:^|:\s)((?:MATRIX_|M_|ORG[._])[A-Z0-9._]+)(?=:)/u;

/**
 * Electron's invoke boundary replaces a native Error's custom `name` with
 * `Error invoking remote method ...`, but keeps the original code prefix in
 * the message. Decode only our strictly bounded error-code grammar so normal
 * prose can never be mistaken for control flow.
 */
export function matrixErrorCode(value: unknown): string | undefined {
    const candidate = value && typeof value === "object"
        ? value as { code?: unknown; name?: unknown; message?: unknown; }
        : undefined;
    for (const code of [candidate?.code, candidate?.name]) {
        if (typeof code === "string" && MATRIX_ERROR_CODE_PATTERN.test(code)) return code;
    }
    const message = typeof candidate?.message === "string"
        ? candidate.message
        : typeof value === "string" ? value : undefined;
    return message?.match(WRAPPED_MATRIX_ERROR_CODE_PATTERN)?.[1];
}
