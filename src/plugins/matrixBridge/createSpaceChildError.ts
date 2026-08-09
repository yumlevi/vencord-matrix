/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * A received 4xx response is a definitive rejection of /createRoom. Missing
 * responses, connection failures, aborts, and 5xx responses remain ambiguous
 * because the non-idempotent request may have committed before failing.
 */
export function isDefinitiveCreateRoomRejection(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const status = (error as { httpStatus?: unknown; }).httpStatus;
    return Number.isSafeInteger(status) && Number(status) >= 400 && Number(status) < 500;
}
