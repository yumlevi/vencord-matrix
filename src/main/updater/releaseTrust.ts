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

import { constants, createHash, createPublicKey, KeyObject, verify } from "crypto";

import { MAX_SIGNATURE_BYTES, ReleaseValidationError } from "./releaseTypes";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeCanonicalBase64(value: string) {
    if (!BASE64_PATTERN.test(value))
        throw new ReleaseValidationError("The release signature is not canonical base64.");
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value)
        throw new ReleaseValidationError("The release signature is not canonical base64.");
    return decoded;
}

function decodeCanonicalBase64Url(value: string) {
    if (!BASE64URL_PATTERN.test(value))
        throw new ReleaseValidationError("The embedded release public key is invalid.");
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
    if (decoded.toString("base64url") !== value)
        throw new ReleaseValidationError("The embedded release public key is invalid.");
    return decoded;
}

export function parseReleaseSignature(raw: Uint8Array) {
    if (raw.byteLength === 0 || raw.byteLength > MAX_SIGNATURE_BYTES)
        throw new ReleaseValidationError("The release signature has an invalid size.");

    const bytes = Buffer.from(raw);
    if (bytes.includes(0x0a) || bytes.includes(0x0d)
        || [...bytes].some(byte => byte > 0x7f)) {
        throw new ReleaseValidationError("The release signature is not canonical base64.");
    }

    return decodeCanonicalBase64(bytes.toString("ascii"));
}

export function createReleasePublicKey(modulus: string, exponent: string): KeyObject {
    const modulusBytes = decodeCanonicalBase64Url(modulus);
    if (modulusBytes.byteLength < 384 || modulusBytes.byteLength > 512 || exponent !== "AQAB")
        throw new ReleaseValidationError("The embedded release public key is invalid.");

    let key: KeyObject;
    try {
        key = createPublicKey({
            format: "jwk",
            key: { kty: "RSA", n: modulus, e: exponent }
        });
    } catch {
        throw new ReleaseValidationError("The embedded release public key is invalid.");
    }
    if (key.asymmetricKeyType !== "rsa"
        || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
        throw new ReleaseValidationError("The embedded release public key is too small.");
    }
    return key;
}

export function verifyReleaseSignatureWithKey(
    manifestBytes: Uint8Array,
    signatureBytes: Uint8Array,
    modulus: string,
    exponent: string
) {
    const signature = parseReleaseSignature(signatureBytes);
    const key = createReleasePublicKey(modulus, exponent);
    if (signature.byteLength * 8 < 3072
        || !verify("RSA-SHA256", manifestBytes, {
            key,
            padding: constants.RSA_PKCS1_PADDING
        }, signature)) {
        throw new ReleaseValidationError("The release signature is not trusted.");
    }
}

export function verifyReleaseSignature(manifestBytes: Uint8Array, signatureBytes: Uint8Array) {
    verifyReleaseSignatureWithKey(
        manifestBytes,
        signatureBytes,
        UPDATE_RSA_MODULUS,
        UPDATE_RSA_EXPONENT
    );
}

export function sha256Hex(value: Uint8Array) {
    return createHash("sha256").update(value).digest("hex");
}
