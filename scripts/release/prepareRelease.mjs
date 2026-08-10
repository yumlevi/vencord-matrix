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

import { createHash, createPublicKey } from "crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

import { unzipSync, zipSync } from "fflate";

const MANIFEST_NAME = "disorder-manifest.json";
const RUNTIME_NAME = "disorder-runtime.zip";
const INSTALLER_NAME = "Install-Disorder.ps1";
const INSTALLER_LAUNCHER_NAME = "Install-Disorder.cmd";
const PORTABLE_INSTALLER_NAME = "Install-Disorder.sh";
const SETUP_ARCHIVE_NAME = "Disorder-Setup.zip";
const RUNTIME_SOURCES = Object.freeze([
    ["LICENSE", "LICENSE"],
    ["fflate.LICENSE", "node_modules/fflate/LICENSE"],
    ["matrix-js-sdk.LICENSE", "node_modules/matrix-js-sdk/LICENSE"],
    ["matrixBridgePreload.js", "dist/matrixBridgePreload.js"],
    ["matrixBridgeWorker.js", "dist/matrixBridgeWorker.js"],
    ["matrixBridgeWorker.js.LEGAL.txt", "dist/matrixBridgeWorker.js.LEGAL.txt"],
    ["matrixSecureView.css", "dist/matrixSecureView.css"],
    ["matrixSecureView.js", "dist/matrixSecureView.js"],
    ["matrixSecureViewPreload.js", "dist/matrixSecureViewPreload.js"],
    ["matrix_sdk_crypto_wasm.LICENSE", "node_modules/@matrix-org/matrix-sdk-crypto-wasm/LICENSE"],
    ["matrix_sdk_crypto_wasm_bg.wasm", "dist/matrix_sdk_crypto_wasm_bg.wasm"],
    ["package.json", "dist/package.json"],
    ["patcher.js", "dist/patcher.js"],
    ["patcher.js.LEGAL.txt", "dist/patcher.js.LEGAL.txt"],
    ["preload.js", "dist/preload.js"],
    ["renderer.css", "dist/renderer.css"],
    ["renderer.js", "dist/renderer.js"],
    ["renderer.js.LEGAL.txt", "dist/renderer.js.LEGAL.txt"],
]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// ZIP stores a timezone-free DOS timestamp. Constructing the Date in local
// time keeps the encoded components deterministic in every runner timezone.
const FIXED_ZIP_TIME = new Date(2000, 0, 1, 0, 0, 0, 0);

const { values } = parseArgs({
    options: {
        output: { type: "string" },
        repository: { type: "string" },
        commit: { type: "string" },
        sequence: { type: "string" },
        "published-at": { type: "string" },
        "public-key": { type: "string", default: "release/update-public-key.json" }
    },
    strict: true
});

function abort(message) {
    throw new Error(`Release preparation failed: ${message}`);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function readRequiredFile(path, maximum = 16 * 1024 * 1024) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
        abort(`required release input is invalid: ${path.replaceAll("\\", "/")}`);
    const bytes = await readFile(path);
    if (bytes.length !== stat.size) abort("a release input changed while it was read");
    return bytes;
}

function replaceOnce(source, token, replacement) {
    const first = source.indexOf(token);
    if (first < 0 || source.indexOf(token, first + token.length) >= 0)
        abort(`template token ${token} must occur exactly once`);
    return source.slice(0, first) + replacement + source.slice(first + token.length);
}

async function readPublicKey(path) {
    const raw = await readRequiredFile(path, 16 * 1024);
    let jwk;
    try {
        jwk = JSON.parse(raw.toString("utf8"));
    } catch {
        abort("the update public key is not valid JSON");
    }
    if (!exactKeys(jwk, ["kty", "n", "e", "alg", "use"])
        || jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig"
        || typeof jwk.n !== "string" || jwk.n.length < 256 || jwk.n.length > 1024 || !BASE64URL.test(jwk.n)
        || typeof jwk.e !== "string" || jwk.e !== "AQAB")
        abort("the update public key does not match the required RSA JWK schema");
    let key;
    try {
        key = createPublicKey({ key: jwk, format: "jwk" });
    } catch {
        abort("the update public key cannot be imported");
    }
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== "rsa" || modulusLength < 3072 || modulusLength > 4096
        || Buffer.from(jwk.n, "base64url").toString("base64url") !== jwk.n)
        abort("the update public key must be canonical 3072-4096 bit RSA with exponent 65537");
    const spki = key.export({ format: "der", type: "spki" });
    const spkiPem = key.export({ format: "pem", type: "spki" });
    return { jwk, fingerprint: sha256(spki), spkiPem };
}

if (typeof values.output !== "string") abort("--output is required");
if (typeof values.repository !== "string" || !REPOSITORY.test(values.repository)) abort("--repository must be owner/repository");
if (typeof values.commit !== "string" || !COMMIT.test(values.commit)) abort("--commit must be a full lowercase Git commit");
if (typeof values.sequence !== "string" || !/^[1-9][0-9]{0,15}$/.test(values.sequence)) abort("--sequence is invalid");
const sequence = Number(values.sequence);
if (!Number.isSafeInteger(sequence)) abort("--sequence must be a safe integer");
if (typeof values["published-at"] !== "string") abort("--published-at is required");
const publishedAt = new Date(values["published-at"]);
if (!Number.isFinite(publishedAt.valueOf()) || publishedAt.toISOString() !== values["published-at"])
    abort("--published-at must be a canonical UTC ISO timestamp");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(values.output);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) abort("--output must be an empty directory");

const packageJson = JSON.parse((await readRequiredFile(join(repositoryRoot, "package.json"), 1024 * 1024)).toString("utf8"));
const version = `${packageJson.version}-r${sequence}`;
if (!VERSION.test(version)) abort("the generated display version is invalid");
const { jwk, fingerprint, spkiPem } = await readPublicKey(resolve(values["public-key"]));

const runtimeBytes = new Map();
for (const [path, source] of RUNTIME_SOURCES) {
    runtimeBytes.set(path, await readRequiredFile(join(repositoryRoot, source)));
}
const files = RUNTIME_SOURCES.map(([path]) => {
    const bytes = runtimeBytes.get(path);
    return { path, size: bytes.length, sha256: sha256(bytes) };
});
if (files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024)
    abort("the total uncompressed runtime exceeds 64 MiB");
const zipEntries = {};
for (const [path] of RUNTIME_SOURCES) {
    zipEntries[path] = [new Uint8Array(runtimeBytes.get(path)), {
        level: 9,
        mtime: FIXED_ZIP_TIME,
        os: 3,
        attrs: 0o644 << 16
    }];
}
const runtime = Buffer.from(zipSync(zipEntries, { level: 9, mtime: FIXED_ZIP_TIME, os: 3 }));
const unpacked = unzipSync(new Uint8Array(runtime));
if (JSON.stringify(Object.keys(unpacked).sort()) !== JSON.stringify(RUNTIME_SOURCES.map(([path]) => path).sort()))
    abort("the runtime archive did not round-trip its fixed allowlist");
for (const file of files) {
    const bytes = Buffer.from(unpacked[file.path]);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
        abort("the runtime archive did not round-trip its payload hashes");
}

const manifest = {
    schema: 1,
    product: "disorder-vencord",
    channel: "stable",
    sequence,
    version,
    commit: values.commit,
    publishedAt: values["published-at"],
    bundle: { name: RUNTIME_NAME, size: runtime.length, sha256: sha256(runtime) },
    files,
    changes: []
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (manifestBytes.length > 128 * 1024) abort("the release manifest exceeds 128 KiB");
if (runtime.length > 64 * 1024 * 1024) abort("the compressed runtime exceeds 64 MiB");

let stablePatcher = (await readRequiredFile(join(repositoryRoot, "scripts/release/stablePatcher.cjs"), 1024 * 1024)).toString("utf8");
stablePatcher = replaceOnce(stablePatcher, "__DISORDER_UPDATE_RSA_MODULUS__", jwk.n);
stablePatcher = replaceOnce(stablePatcher, "__DISORDER_UPDATE_RSA_EXPONENT__", jwk.e);
if (stablePatcher.includes("__DISORDER_")) abort("the stable patcher contains an unresolved template token");

let installer = (await readRequiredFile(join(repositoryRoot, "scripts/release/Install-Disorder.ps1.template"), 1024 * 1024)).toString("utf8");
installer = replaceOnce(installer, "__DISORDER_REPOSITORY__", values.repository);
installer = replaceOnce(installer, "__DISORDER_UPDATE_RSA_MODULUS__", jwk.n);
installer = replaceOnce(installer, "__DISORDER_UPDATE_RSA_EXPONENT__", jwk.e);
installer = replaceOnce(installer, "__DISORDER_PUBLIC_KEY_FINGERPRINT__", fingerprint);
installer = replaceOnce(installer, "__DISORDER_STABLE_PATCHER_BASE64__", Buffer.from(stablePatcher, "utf8").toString("base64"));
if (/__DISORDER_[A-Z0-9_]+__/.test(installer)) abort("the installer contains an unresolved template token");
installer = installer.replace(/\r?\n/g, "\r\n");
if (Buffer.byteLength(installer) > 1024 * 1024) abort("the generated installer exceeds 1 MiB");
const installerLauncher = (await readRequiredFile(join(repositoryRoot, "scripts/release/Install-Disorder.cmd"), 16 * 1024))
    .toString("utf8")
    .replace(/\r?\n/g, "\r\n");
if (Buffer.byteLength(installerLauncher) > 16 * 1024) abort("the generated launcher exceeds 16 KiB");
let portableInstaller = (await readRequiredFile(join(repositoryRoot, "scripts/release/Install-Disorder.sh.template"), 1024 * 1024))
    .toString("utf8");
portableInstaller = replaceOnce(portableInstaller, "__DISORDER_REPOSITORY__", values.repository);
portableInstaller = replaceOnce(
    portableInstaller,
    "__DISORDER_UPDATE_PUBLIC_KEY_PEM_BASE64__",
    Buffer.from(spkiPem, "ascii").toString("base64")
);
portableInstaller = replaceOnce(portableInstaller, "__DISORDER_PUBLIC_KEY_FINGERPRINT__", fingerprint);
portableInstaller = replaceOnce(
    portableInstaller,
    "__DISORDER_STABLE_PATCHER_BASE64__",
    Buffer.from(stablePatcher, "utf8").toString("base64")
);
if (/__DISORDER_[A-Z0-9_]+__/.test(portableInstaller)) abort("the portable installer contains an unresolved template token");
portableInstaller = portableInstaller.replace(/\r\n/g, "\n");
if (!portableInstaller.startsWith("#!/bin/sh\n") || Buffer.byteLength(portableInstaller) > 1024 * 1024)
    abort("the generated portable installer is invalid");
const setupEntries = {
    [INSTALLER_LAUNCHER_NAME]: [new Uint8Array(Buffer.from(installerLauncher, "utf8")), {
        level: 9, mtime: FIXED_ZIP_TIME, os: 3, attrs: 0o644 << 16
    }],
    [INSTALLER_NAME]: [new Uint8Array(Buffer.from(installer, "utf8")), {
        level: 9, mtime: FIXED_ZIP_TIME, os: 3, attrs: 0o644 << 16
    }],
    [PORTABLE_INSTALLER_NAME]: [new Uint8Array(Buffer.from(portableInstaller, "utf8")), {
        level: 9, mtime: FIXED_ZIP_TIME, os: 3, attrs: 0o755 << 16
    }]
};
const setupArchive = Buffer.from(zipSync(setupEntries, { level: 9, mtime: FIXED_ZIP_TIME, os: 3 }));
const unpackedSetup = unzipSync(new Uint8Array(setupArchive));
if (JSON.stringify(Object.keys(unpackedSetup)) !== JSON.stringify([
    INSTALLER_LAUNCHER_NAME, INSTALLER_NAME, PORTABLE_INSTALLER_NAME
])
    || !Buffer.from(unpackedSetup[INSTALLER_LAUNCHER_NAME]).equals(Buffer.from(installerLauncher, "utf8"))
    || !Buffer.from(unpackedSetup[INSTALLER_NAME]).equals(Buffer.from(installer, "utf8"))
    || !Buffer.from(unpackedSetup[PORTABLE_INSTALLER_NAME]).equals(Buffer.from(portableInstaller, "utf8"))
    || setupArchive.length > 2 * 1024 * 1024)
    abort("the one-download setup archive failed its exact-content check");

await writeFile(join(output, MANIFEST_NAME), manifestBytes, { flag: "wx" });
await writeFile(join(output, RUNTIME_NAME), runtime, { flag: "wx" });
await writeFile(join(output, INSTALLER_NAME), installer, { encoding: "utf8", flag: "wx" });
await writeFile(join(output, INSTALLER_LAUNCHER_NAME), installerLauncher, { encoding: "utf8", flag: "wx" });
await writeFile(join(output, SETUP_ARCHIVE_NAME), setupArchive, { flag: "wx" });
await writeFile(join(output, "update-public-key.spki.sha256"), `${fingerprint}\n`, { encoding: "ascii", flag: "wx" });

console.log(`Prepared fixed release inputs for ${manifest.version}:`);
console.log(`- ${MANIFEST_NAME}: ${manifestBytes.length} bytes`);
console.log(`- ${RUNTIME_NAME}: ${runtime.length} bytes`);
console.log(`- ${INSTALLER_NAME}: ${Buffer.byteLength(installer)} bytes`);
console.log(`- ${INSTALLER_LAUNCHER_NAME}: ${Buffer.byteLength(installerLauncher)} bytes`);
console.log(`- ${PORTABLE_INSTALLER_NAME} (inside ${SETUP_ARCHIVE_NAME}): ${Buffer.byteLength(portableInstaller)} bytes`);
console.log(`- ${SETUP_ARCHIVE_NAME}: ${setupArchive.length} bytes`);
console.log(`- public-key SPKI SHA-256: ${fingerprint}`);
