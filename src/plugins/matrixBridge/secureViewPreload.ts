/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer } from "electron";

import {
    MATRIX_SECURE_VIEW_BOOTSTRAP,
    MATRIX_SECURE_VIEW_EVENT,
    MATRIX_SECURE_VIEW_READY,
    MATRIX_SECURE_VIEW_REQUEST,
    type MatrixSecureViewEvent,
    type MatrixSecureViewEventEnvelope,
    type MatrixSecureViewHost,
    type MatrixSecureViewRequest,
    type MatrixSecureViewRequestEnvelope,
    type MatrixSecureViewRequestType,
    type MatrixSecureViewResult
} from "./secureViewProtocol";

// WebContents renderer processes may be reused, which makes command-line
// `additionalArguments` unreliable. Main returns the token only to the exact
// registered secure-view WebContents and its top frame; it never reaches page
// JavaScript and remains captured in this isolated preload closure.
const generation: unknown = ipcRenderer.sendSync(MATRIX_SECURE_VIEW_BOOTSTRAP);

if (typeof generation !== "string" || !/^[a-f0-9]{64}$/u.test(generation)) {
    throw new Error("Matrix secure view generation is missing or invalid.");
}

const host: MatrixSecureViewHost = Object.freeze({
    request<Type extends MatrixSecureViewRequestType>(request: MatrixSecureViewRequest<Type>) {
        const envelope: MatrixSecureViewRequestEnvelope = { generation, request };
        const result = ipcRenderer.invoke(MATRIX_SECURE_VIEW_REQUEST, envelope) as Promise<MatrixSecureViewResult<Type>>;
        return result.finally(() => {
            if (request.type === "importRoomKeys") request.passphrase = "";
        });
    },
    onEvent(callback: (event: MatrixSecureViewEvent) => void) {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, envelope: MatrixSecureViewEventEnvelope) => {
            if (envelope?.generation === generation && envelope.event && typeof envelope.event === "object") {
                callback(envelope.event);
            }
        };
        ipcRenderer.on(MATRIX_SECURE_VIEW_EVENT, listener);
        return () => ipcRenderer.removeListener(MATRIX_SECURE_VIEW_EVENT, listener);
    },
    ready() {
        ipcRenderer.send(MATRIX_SECURE_VIEW_READY, generation);
    }
});

contextBridge.exposeInMainWorld("MatrixSecureViewHost", host);
