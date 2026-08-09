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

import { createHash, generateKeyPairSync } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const { values } = parseArgs({
    options: {
        "public-out": { type: "string", default: "release/update-public-key.json" },
        "private-out": { type: "string" }
    },
    strict: true
});

if (typeof values["private-out"] !== "string" || !isAbsolute(values["private-out"]))
    throw new Error("--private-out must be an absolute path outside the repository");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicPath = resolve(values["public-out"]);
const privatePath = resolve(values["private-out"]);
const relativePrivatePath = relative(repositoryRoot, privatePath);
if (relativePrivatePath === "" || (!relativePrivatePath.startsWith("..\\") && !relativePrivatePath.startsWith("../") && relativePrivatePath !== ".."))
    throw new Error("the private key output must remain outside the repository");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001
});
const exportedJwk = publicKey.export({ format: "jwk" });
const publicJwk = {
    kty: "RSA",
    n: exportedJwk.n,
    e: exportedJwk.e,
    alg: "RS256",
    use: "sig"
};
const privateDerBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicSpki = publicKey.export({ format: "der", type: "spki" });
const fingerprint = createHash("sha256").update(publicSpki).digest("hex");

await mkdir(dirname(publicPath), { recursive: true });
await mkdir(dirname(privatePath), { recursive: true });
await writeFile(publicPath, `${JSON.stringify(publicJwk, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
await writeFile(privatePath, privateDerBase64, { encoding: "ascii", flag: "wx", mode: 0o600 });

console.log(`Public-key SPKI SHA-256: ${fingerprint}`);
console.log("Protected GitHub environment secret: DISORDER_UPDATE_SIGNING_KEY_PKCS8_B64");
console.log("Keep the private output outside the repository and remove it after configuring that secret.");
