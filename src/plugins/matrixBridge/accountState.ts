/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    MatrixSessionCredentials,
    MatrixStoredAccount,
    MatrixStoredSignedOutAccount
} from "./workerProtocol";

export function preserveSignedOutDevice(account: MatrixStoredAccount): MatrixStoredSignedOutAccount {
    return {
        schema: 2,
        homeserver: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        storageKey: account.storageKey
    };
}

export function restorePreservedDevice(
    preserved: MatrixStoredSignedOutAccount,
    credentials: MatrixSessionCredentials
): MatrixStoredAccount | undefined {
    if (credentials.homeserver !== preserved.homeserver
        || credentials.userId !== preserved.userId
        || credentials.deviceId !== preserved.deviceId) return undefined;
    return {
        schema: 1,
        homeserver: preserved.homeserver,
        userId: preserved.userId,
        deviceId: preserved.deviceId,
        accessToken: credentials.accessToken,
        ...(credentials.refreshToken == null ? {} : { refreshToken: credentials.refreshToken }),
        storageKey: preserved.storageKey
    };
}

export function matrixUserLocalpart(userId: string): string | undefined {
    const separator = userId.indexOf(":", 1);
    return userId.startsWith("@") && separator > 1 ? userId.slice(1, separator) : undefined;
}
