/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { IpcEvents } from "@shared/IpcEvents";
import { randomBytes, timingSafeEqual } from "crypto";
import { BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { markCurrentReleaseHealthy } from "./releaseState";

const HEALTH_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const DISCORD_RENDERER_HOSTS = new Set([
    "discord.com",
    "canary.discord.com",
    "ptb.discord.com",
    "development.discord.com",
    "discordapp.com",
    "canary.discordapp.com",
    "ptb.discordapp.com"
]);

interface PendingHealthReport {
    senderId: number;
    token: string;
    expiresAt: number;
    timer: NodeJS.Timeout;
}

let pending: PendingHealthReport | undefined;

function clearPending() {
    if (pending != null)
        clearTimeout(pending.timer);
    pending = undefined;
}

function isTrustedDiscordUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            && url.username === "" && url.password === "" && url.port === ""
            && DISCORD_RENDERER_HOSTS.has(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function senderIsDiscordMainWindow(event: IpcMainEvent | IpcMainInvokeEvent) {
    const { sender, senderFrame } = event;
    if (sender.isDestroyed() || senderFrame == null || senderFrame !== sender.mainFrame
        || !isTrustedDiscordUrl(senderFrame.url)) {
        return false;
    }
    const owner = BrowserWindow.fromWebContents(sender);
    if (owner == null || owner.isDestroyed() || owner.webContents !== sender || owner.getParentWindow() != null)
        return false;

    const firstDiscordWindow = BrowserWindow.getAllWindows()
        .filter(window => !window.isDestroyed() && window.getParentWindow() == null
            && !window.webContents.isDestroyed() && isTrustedDiscordUrl(window.webContents.getURL()))
        .sort((left, right) => left.webContents.id - right.webContents.id)[0];
    return firstDiscordWindow === owner;
}

function tokensMatch(left: string, right: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(left) || !/^[A-Za-z0-9_-]{43}$/.test(right))
        return false;
    const leftBytes = Buffer.from(left, "ascii");
    const rightBytes = Buffer.from(right, "ascii");
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

ipcMain.on(IpcEvents.PRELOAD_GET_RELEASE_HEALTH_TOKEN, event => {
    let reply: string | null = null;
    if (process.env.VENCORD_RELEASE_ROOT != null
        && process.env.VENCORD_RELEASE_ID != null
        && process.env.VENCORD_RELEASE_SEQUENCE != null
        && senderIsDiscordMainWindow(event)) {
        if (pending?.senderId === event.sender.id && pending.expiresAt > Date.now()) {
            reply = pending.token;
        } else if (pending == null || pending.expiresAt <= Date.now() || event.sender.isDestroyed()) {
            clearPending();
            const token = randomBytes(32).toString("base64url");
            const expiresAt = Date.now() + HEALTH_TOKEN_LIFETIME_MS;
            const timer = setTimeout(clearPending, HEALTH_TOKEN_LIFETIME_MS);
            timer.unref();
            pending = { senderId: event.sender.id, token, expiresAt, timer };
            event.sender.once("destroyed", () => {
                if (pending?.senderId === event.sender.id)
                    clearPending();
            });
            reply = token;
        }
    }
    event.returnValue = reply;
});

ipcMain.handle(IpcEvents.RELEASE_HEALTHY, async (event, token: unknown) => {
    const expected = pending;
    if (expected == null || expected.expiresAt <= Date.now()
        || expected.senderId !== event.sender.id || typeof token !== "string"
        || !tokensMatch(token, expected.token) || !senderIsDiscordMainWindow(event)) {
        return false;
    }

    const healthy = await markCurrentReleaseHealthy();
    if (healthy)
        clearPending();
    return healthy;
});
