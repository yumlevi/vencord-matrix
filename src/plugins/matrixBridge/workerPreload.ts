/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer } from "electron";

import {
    MATRIX_WORKER_COMMAND,
    MATRIX_WORKER_FETCH_KLIPY_PREVIEW,
    MATRIX_WORKER_FETCH_TENOR_PREVIEW,
    MATRIX_WORKER_FETCH_X_STATUS,
    MATRIX_WORKER_MESSAGE,
    MATRIX_WORKER_SAVE_CREDENTIALS,
    type MatrixCredentialUpdate,
    type MatrixWorkerHost,
    type MatrixWorkerMessage,
    type MatrixWorkerRequest
} from "./workerProtocol";

const host: MatrixWorkerHost = Object.freeze({
    onCommand(callback: (request: MatrixWorkerRequest) => void) {
        ipcRenderer.on(MATRIX_WORKER_COMMAND, (_event, request: MatrixWorkerRequest) => callback(request));
    },
    respond(message: MatrixWorkerMessage) {
        ipcRenderer.send(MATRIX_WORKER_MESSAGE, message);
    },
    ready() {
        ipcRenderer.send(MATRIX_WORKER_MESSAGE, { kind: "ready" } satisfies MatrixWorkerMessage);
    },
    saveCredentials(credentials: MatrixCredentialUpdate) {
        return ipcRenderer.invoke(MATRIX_WORKER_SAVE_CREDENTIALS, credentials);
    },
    fetchKlipyPreview(url: string) {
        return ipcRenderer.invoke(MATRIX_WORKER_FETCH_KLIPY_PREVIEW, url);
    },
    fetchTenorPreview(url: string) {
        return ipcRenderer.invoke(MATRIX_WORKER_FETCH_TENOR_PREVIEW, url);
    },
    fetchXStatus(url: string) {
        return ipcRenderer.invoke(MATRIX_WORKER_FETCH_X_STATUS, url);
    }
});

contextBridge.exposeInMainWorld("MatrixBridgeWorkerHost", host);
