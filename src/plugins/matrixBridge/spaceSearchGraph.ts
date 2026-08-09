/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MatrixSpaceSearchGraphRoom {
    roomId: string;
    space: boolean;
    declaredChildIds: string[];
    parentIds: string[];
}

export interface MatrixSpaceSearchGraphResult {
    roomIds: string[];
    limited: boolean;
}

/** Traverse declared child edges plus valid joined child-side parent edges. */
export function searchMatrixSpaceGraph(
    rootSpaceId: string,
    rooms: MatrixSpaceSearchGraphRoom[],
    maximumRooms: number,
    maximumSpaces: number,
    maximumDepth: number
): MatrixSpaceSearchGraphResult {
    const byId = new Map(rooms.map(room => [room.roomId, room]));
    const inferredChildren = new Map<string, string[]>();
    for (const room of rooms) {
        for (const parentId of room.parentIds) {
            if (!byId.has(parentId)) continue;
            const children = inferredChildren.get(parentId) ?? [];
            if (!children.includes(room.roomId)) children.push(room.roomId);
            inferredChildren.set(parentId, children);
        }
    }
    for (const children of inferredChildren.values()) {
        children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    }

    const childrenOf = (room: MatrixSpaceSearchGraphRoom): string[] => {
        const result: string[] = [];
        for (const childId of [...room.declaredChildIds, ...(inferredChildren.get(room.roomId) ?? [])]) {
            if (byId.has(childId) && !result.includes(childId)) result.push(childId);
        }
        return result;
    };

    const root = byId.get(rootSpaceId);
    if (!root?.space) return { roomIds: [], limited: false };
    const roomIds: string[] = [];
    const includedRooms = new Set<string>();
    const visitedSpaces = new Set([root.roomId]);
    const pending: Array<{ room: MatrixSpaceSearchGraphRoom; depth: number; }> = [{ room: root, depth: 0 }];
    let limited = false;
    while (pending.length) {
        const current = pending.shift()!;
        const children = childrenOf(current.room);
        if (current.depth >= maximumDepth) {
            if (children.length) limited = true;
            continue;
        }
        for (const childId of children) {
            const child = byId.get(childId)!;
            if (child.space) {
                if (!visitedSpaces.has(child.roomId)) {
                    if (visitedSpaces.size >= maximumSpaces) {
                        limited = true;
                        continue;
                    }
                    visitedSpaces.add(child.roomId);
                    pending.push({ room: child, depth: current.depth + 1 });
                }
                continue;
            }
            if (includedRooms.has(child.roomId)) continue;
            includedRooms.add(child.roomId);
            roomIds.push(child.roomId);
            if (roomIds.length >= maximumRooms) {
                limited = true;
                return { roomIds, limited };
            }
        }
    }
    return { roomIds, limited };
}
