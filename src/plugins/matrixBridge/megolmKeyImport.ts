/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Matrix encrypted room-key export limits. Keep these in sync with native file loading. */
export const MAX_MEGOLM_KEY_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_MEGOLM_KEY_EXPORT_SESSIONS = 100_000;
export const MAX_MEGOLM_KEY_PASSPHRASE_BYTES = 4_096;
export const MIN_MEGOLM_KEY_EXPORT_ROUNDS = 100_000;
export const MAX_MEGOLM_KEY_EXPORT_ROUNDS = 5_000_000;

const ARMOR_HEADER = "-----BEGIN MEGOLM SESSION DATA-----";
const ARMOR_FOOTER = "-----END MEGOLM SESSION DATA-----";
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 16;
const ROUNDS_BYTES = 4;
const MAC_BYTES = 32;
const PREFIX_BYTES = 1 + SALT_BYTES + IV_BYTES + ROUNDS_BYTES;
const MIN_BINARY_BYTES = PREFIX_BYTES + 2 + MAC_BYTES;

export class MegolmKeyImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MegolmKeyImportError";
    }
}

function rejectFormat(): never {
    throw new MegolmKeyImportError("The selected file is not a valid encrypted Matrix room-key export.");
}

function validateArmoredSize(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)
        || bytes.byteLength < ARMOR_HEADER.length + ARMOR_FOOTER.length + MIN_BINARY_BYTES
        || bytes.byteLength > MAX_MEGOLM_KEY_EXPORT_BYTES) {
        rejectFormat();
    }
}

function decodeBase64(encoded: string): Uint8Array {
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
        rejectFormat();
    }
    const firstPadding = encoded.indexOf("=");
    if (firstPadding >= 0 && firstPadding < encoded.length - (encoded.endsWith("==") ? 2 : 1)) rejectFormat();
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const decodedLength = encoded.length / 4 * 3 - padding;
    if (decodedLength < MIN_BINARY_BYTES || decodedLength > MAX_MEGOLM_KEY_EXPORT_BYTES) rejectFormat();

    let binary: string;
    try {
        binary = atob(encoded);
    } catch {
        rejectFormat();
    }
    if (binary.length !== decodedLength) rejectFormat();
    const decoded = new Uint8Array(decodedLength);
    for (let index = 0; index < binary.length; index++) decoded[index] = binary.charCodeAt(index);
    binary = "";
    return decoded;
}

function decodeArmor(bytes: Uint8Array): Uint8Array {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/gu, "\n");
    } catch {
        rejectFormat();
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length < 3 || lines[0] !== ARMOR_HEADER || lines.at(-1) !== ARMOR_FOOTER) rejectFormat();
    const payloadLines = lines.slice(1, -1);
    if (payloadLines.some(line => !line.length || !/^[A-Za-z0-9+/=]+$/u.test(line))) rejectFormat();
    const encoded = payloadLines.join("");
    text = "";
    return decodeBase64(encoded);
}

function boundedString(value: unknown, maximum: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validateSession(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) rejectFormat();
    const session = value as Record<string, unknown>;
    if (Object.keys(session).length > 16
        || session.algorithm !== "m.megolm.v1.aes-sha2"
        || !boundedString(session.room_id, 1_024)
        || !session.room_id.startsWith("!")
        || !boundedString(session.sender_key, 4_096)
        || !boundedString(session.session_id, 4_096)
        || !boundedString(session.session_key, 65_536)) {
        rejectFormat();
    }
    const chain = session.forwarding_curve25519_key_chain;
    if (!Array.isArray(chain) || chain.length > 256
        || chain.some(key => !boundedString(key, 4_096))) rejectFormat();
    const claimed = session.sender_claimed_keys;
    if (!claimed || typeof claimed !== "object" || Array.isArray(claimed)) rejectFormat();
    const claimedEntries = Object.entries(claimed as Record<string, unknown>);
    if (!claimedEntries.length || claimedEntries.length > 16
        || claimedEntries.some(([name, key]) => !boundedString(name, 256) || !boundedString(key, 4_096))) {
        rejectFormat();
    }
    if (session.first_known_index != null
        && (!Number.isSafeInteger(session.first_known_index) || Number(session.first_known_index) < 0)) rejectFormat();
    if (session.untrusted != null && typeof session.untrusted !== "boolean") rejectFormat();
    if (session.shared_history != null && typeof session.shared_history !== "boolean") rejectFormat();
}

function validateSessions(json: string): number {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        rejectFormat();
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_MEGOLM_KEY_EXPORT_SESSIONS) rejectFormat();
    for (const session of parsed) validateSession(session);
    return parsed.length;
}

function webCrypto(): SubtleCrypto {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new MegolmKeyImportError("Encrypted Matrix room-key import is unavailable on this system.");
    return subtle;
}

/**
 * Decrypts the standard Matrix/Element encrypted Megolm export and confines the
 * plaintext JSON lifetime to the supplied callback. Mutable secret buffers are
 * erased before this promise settles, including on authentication failures.
 */
export async function importEncryptedMegolmKeyExport<T>(
    armoredBytes: Uint8Array,
    passphrase: string,
    importer: (json: string, sessionCount: number) => Promise<T>
): Promise<{ sessionCount: number; value: T; }> {
    validateArmoredSize(armoredBytes);
    if (typeof passphrase !== "string") rejectFormat();
    const passphraseBytes = new TextEncoder().encode(passphrase);
    if (!passphraseBytes.byteLength || passphraseBytes.byteLength > MAX_MEGOLM_KEY_PASSPHRASE_BYTES) {
        passphraseBytes.fill(0);
        throw new MegolmKeyImportError("Enter the passphrase used when the Matrix room keys were exported.");
    }

    let decoded: Uint8Array | undefined;
    let derived: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    let keyJson = "";
    try {
        decoded = decodeArmor(armoredBytes);
        if (decoded[0] !== FORMAT_VERSION) rejectFormat();
        const rounds = new DataView(decoded.buffer, decoded.byteOffset + 1 + SALT_BYTES + IV_BYTES, ROUNDS_BYTES)
            .getUint32(0, false);
        if (rounds < MIN_MEGOLM_KEY_EXPORT_ROUNDS || rounds > MAX_MEGOLM_KEY_EXPORT_ROUNDS) {
            throw new MegolmKeyImportError("The Matrix room-key export uses an unsupported passphrase work factor.");
        }

        const salt = decoded.slice(1, 1 + SALT_BYTES);
        const iv = decoded.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
        if ((iv[8] & 0x80) !== 0) rejectFormat();
        const authenticated = decoded.slice(0, decoded.length - MAC_BYTES);
        const expectedMac = decoded.slice(decoded.length - MAC_BYTES);
        const ciphertext = decoded.slice(PREFIX_BYTES, decoded.length - MAC_BYTES);
        const subtle = webCrypto();
        const material = await subtle.importKey("raw", passphraseBytes, "PBKDF2", false, ["deriveBits"]);
        derived = new Uint8Array(await subtle.deriveBits({
            name: "PBKDF2",
            hash: "SHA-512",
            salt,
            iterations: rounds
        }, material, 512));
        const macKey = await subtle.importKey(
            "raw",
            derived.slice(32),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"]
        );
        const authenticatedFile = await subtle.verify("HMAC", macKey, expectedMac, authenticated);
        if (!authenticatedFile) {
            throw new MegolmKeyImportError("The passphrase is incorrect or the Matrix room-key export is damaged.");
        }
        const encryptionKey = await subtle.importKey("raw", derived.slice(0, 32), "AES-CTR", false, ["decrypt"]);
        plaintext = new Uint8Array(await subtle.decrypt(
            { name: "AES-CTR", counter: iv, length: 64 },
            encryptionKey,
            ciphertext
        ));
        try {
            keyJson = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        } catch {
            rejectFormat();
        }
        const sessionCount = validateSessions(keyJson);
        const value = await importer(keyJson, sessionCount);
        return { sessionCount, value };
    } finally {
        passphraseBytes.fill(0);
        decoded?.fill(0);
        derived?.fill(0);
        plaintext?.fill(0);
        keyJson = "";
    }
}
