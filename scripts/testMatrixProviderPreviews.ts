/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync("src/plugins/matrixBridge/matrixBackend.ts", "utf8");
const bridge = readFileSync("src/plugins/matrixBridge/bridge.ts", "utf8");
const index = readFileSync("src/plugins/matrixBridge/index.tsx", "utf8");
const native = readFileSync("src/plugins/matrixBridge/native.ts", "utf8");
const secureView = readFileSync("src/plugins/matrixBridge/secureView.ts", "utf8");
const settings = readFileSync("src/plugins/matrixBridge/settings.tsx", "utf8");
const types = readFileSync("src/plugins/matrixBridge/types.ts", "utf8");
const workerPreload = readFileSync("src/plugins/matrixBridge/workerPreload.ts", "utf8");
const workerProtocol = readFileSync("src/plugins/matrixBridge/workerProtocol.ts", "utf8");

function section(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.ok(endIndex > startIndex, `missing end marker after ${start}: ${end}`);
    return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, markers: string[], message: string): void {
    let previous = -1;
    for (const marker of markers) {
        const current = source.indexOf(marker);
        assert.ok(current > previous, `${message}: ${marker}`);
        previous = current;
    }
}

function quotedValues(source: string): string[] {
    return Array.from(source.matchAll(/"([^"]+)"/gu), match => match[1]);
}

function assertDirectFetchHardening(source: string, label: string): void {
    assert.match(source, /credentials: "omit"/u, `${label} must omit credentials`);
    assert.match(source, /redirect: "error"/u, `${label} must reject redirects`);
    assert.match(source, /referrerPolicy: "no-referrer"/u, `${label} must omit the referrer`);
    assert.match(source, /signal: controller\.signal/u, `${label} must be abortable`);
    assert.match(source, /response\.url !==/u, `${label} must verify the final URL`);
    assert.match(source, /readBoundedMedia\(/u, `${label} must bound response bytes`);
}

// The compatibility default is enabled for both an unset preference and the
// explicit default. Only an explicit false disables provider-direct previews.
const previewSetting = section(index, "    encryptedRoomProviderPreviews: {", "    matrix: {");
assert.match(previewSetting, /default: true,/u);
assert.match(previewSetting, /onChange: enabled =>[\s\S]*setEncryptedRoomProviderPreviewsPolicy\(enabled\)/u);
const accountPreference = section(
    settings,
    "Supported encrypted-room GIF, Tenor, and X previews",
    "                {!config?.configured"
);
assert.match(accountPreference, /value=\{matrixBridgeSettings\.encryptedRoomProviderPreviews !== false\}/u);
assert.match(accountPreference, /matrixBridgeSettings\.encryptedRoomProviderPreviews = enabled;/u);
for (const provider of [
    "klipy.com",
    "static.klipy.com",
    "static2.klipy.com",
    "tenor.com",
    "media.tenor.com",
    "media1.tenor.com",
    "api.fxtwitter.com",
    "pbs.twimg.com",
    "video.twimg.com"
]) {
    assert.ok(accountPreference.includes(provider), `account privacy copy must name ${provider}`);
}

// Main process settings are authoritative. Renderer input may request a sync,
// but it cannot mint an allow bit for worker or native network egress.
const mainPredicate = section(
    native,
    "function encryptedRoomProviderPreviewsEnabled()",
    "function responseHeader("
);
assert.match(mainPredicate, /RendererSettings\.store\.plugins\?\.MatrixBridge/u);
assert.match(mainPredicate, /settings\?\.enabled !== false/u);
assert.match(mainPredicate, /settings\?\.encryptedRoomProviderPreviews !== false/u);
const nativeDownload = section(native, "async function downloadMedia(", "function validatePreviewMedia(");
const nativePreview = section(native, "async function urlPreview(", "async function sendText(");
for (const command of [nativeDownload, nativePreview]) {
    assert.match(command, /allowDirectMedia: encryptedRoomProviderPreviewsEnabled\(\)/u);
}
const nativePolicy = section(
    native,
    "async function setEncryptedRoomProviderPreviews(",
    "// Discord-native mode deliberately receives"
);
assert.match(nativePolicy, /_: IpcMainInvokeEvent,[\s\S]*enabled: boolean/u);
assert.match(nativePolicy, /enabled !== encryptedRoomProviderPreviewsEnabled\(\)/u);
assert.match(nativePolicy, /await applyProviderPreviewPolicy\(enabled\)/u);
assert.match(nativePolicy, /RendererSettings\.addChangeListener\("plugins\.MatrixBridge\.enabled"/u);
assert.match(nativePolicy, /RendererSettings\.addChangeListener\([\s\S]*encryptedRoomProviderPreviews/u);

assert.match(workerProtocol, /type: "providerPreviewPolicy"; allowDirectMedia: boolean;/u);
assert.match(workerProtocol, /type: "downloadMedia";[\s\S]*allowDirectMedia: boolean;/u);
assert.match(workerProtocol, /type: "urlPreview";[\s\S]*allowDirectMedia: boolean;/u);
for (const provider of ["KLIPY", "TENOR"]) {
    assert.match(workerProtocol, new RegExp(`MATRIX_WORKER_FETCH_${provider}_PREVIEW`, "u"));
    assert.match(workerPreload, new RegExp(`MATRIX_WORKER_FETCH_${provider}_PREVIEW`, "u"));
}
assert.match(workerProtocol, /MATRIX_WORKER_FETCH_X_STATUS/u);
assert.match(workerPreload, /MATRIX_WORKER_FETCH_X_STATUS/u);
assert.match(workerProtocol, /fetchXStatus\(url: string\): Promise<string \| undefined>/u);

// Local echoes cannot be used to ask native/worker code to hydrate arbitrary
// media. Both Discord projection paths accept canonical Matrix event IDs only.
const bridgeCandidates = section(bridge, "function mediaCandidates(", "function prepareRoomMedia(");
assert.match(bridgeCandidates, /if \(!message\.eventId\.startsWith\("\$"\)\) continue;/u);
const secureQueueMedia = section(secureView, "function queueMedia(", "function queueMediaAutomatically(");
const secureAutomaticMedia = section(secureView, "function queueMediaAutomatically(", "function mediaEntryForRender(");
const securePreview = section(secureView, "function queuePreview(", "function setSecureGroupChatResult(");
assert.match(secureQueueMedia, /!eventId\.startsWith\("\$"\)/u);
assert.match(secureAutomaticMedia, /!eventId\.startsWith\("\$"\)/u);
assert.match(securePreview, /!message\.eventId\.startsWith\("\$"\)/u);

// Freeze the exact provider origins. Equality checks (rather than suffix
// matching) reject credential tricks, lookalike hosts, and subdomain smuggling.
const klipyHosts = section(backend, "const KLIPY_MEDIA_HOSTS", "const TENOR_MEDIA_HOSTS");
const tenorHosts = section(backend, "const TENOR_MEDIA_HOSTS", "const X_POSTER_HOST");
const socialHosts = section(backend, "const PROJECTED_SOCIAL_HOSTS", "const FIRST_HTTP_URL");
assert.deepEqual(quotedValues(klipyHosts), ["static.klipy.com", "static2.klipy.com"]);
assert.deepEqual(quotedValues(tenorHosts), ["media.tenor.com", "media1.tenor.com"]);
assert.deepEqual(quotedValues(socialHosts), [
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com"
]);

const firstPreviewUrl = section(backend, "function firstPreviewUrl(", "function klipyShareUrl(");
assert.doesNotMatch(firstPreviewUrl, /api\.fxtwitter|PROJECTED_SOCIAL_HOSTS|hostname\s*=/u,
    "the source/display URL must not be rewritten");
const klipyShare = section(backend, "function klipyShareUrl(", "function tenorShareUrl(");
const tenorShare = section(backend, "function tenorShareUrl(", "function xStatusApiUrl(");
const xApi = section(backend, "function xStatusApiUrl(", "function xVideoUrl(");
assert.match(klipyShare, /url\.protocol !== "https:" \|\| url\.hostname !== "klipy\.com"/u);
assert.match(klipyShare, /url\.username \|\| url\.password \|\| url\.port \|\| url\.search \|\| url\.hash/u);
assert.match(klipyShare, /\^\\\/gifs\\\//u);
assert.match(tenorShare, /url\.hostname !== "tenor\.com" && url\.hostname !== "www\.tenor\.com"/u);
assert.match(tenorShare, /url\.hostname = "tenor\.com"/u);
assert.match(tenorShare, /-gif-\[1-9\]/u);
assert.match(xApi, /!PROJECTED_SOCIAL_HOSTS\.has\(url\.hostname\)/u);
assert.match(xApi, /\\\/status\\\/\(\\d\{2,20\}\)/u);
assert.match(xApi, /url: `https:\/\/api\.fxtwitter\.com\/2\/status\/\$\{match\[1\]\}`/u);
assert.match(xApi, /statusId: match\[1\]/u);

const klipyMedia = section(backend, "function klipyMediaUrl(", "async function fetchKlipyGif(");
const xPoster = section(backend, "function xPosterUrl(", "async function fetchXPoster(");
const tenorMedia = section(backend, "function tenorMediaUrl(", "async function fetchTenorMedia(");
assert.match(klipyMedia, /!KLIPY_MEDIA_HOSTS\.has\(url\.hostname\)/u);
assert.match(klipyMedia, /endsWith\("\.gif"\)/u);
assert.match(xPoster, /url\.hostname !== X_POSTER_HOST/u);
assert.match(xPoster, /media\|tweet_video_thumb\|ext_tw_video_thumb\|amplify_video_thumb/u);
assert.match(xPoster, /name === "format"[\s\S]*name === "name"/u);
assert.match(tenorMedia, /!TENOR_MEDIA_HOSTS\.has\(url\.hostname\)/u);
assert.match(tenorMedia, /\^\\\/m\\\//u);
assert.match(tenorMedia, /gif\|webp\|mp4/u);
const xVideo = section(backend, "function xVideoUrl(", "function previewText(");
assert.match(xVideo, /url\.hostname !== "video\.twimg\.com"/u);
assert.match(xVideo, /endsWith\("\.mp4"\)/u);

const nativeKlipyValidator = section(native, "function validateKlipyShareUrl(", "function validateFxTwitterStatusUrl(");
const nativeXValidator = section(native, "function validateFxTwitterStatusUrl(", "function validateTenorShareUrl(");
const nativeTenorValidator = section(native, "function validateTenorShareUrl(", "function encryptedRoomProviderPreviewsEnabled(");
assert.match(nativeKlipyValidator, /url\.hostname !== "klipy\.com"/u);
assert.match(nativeXValidator, /url\.hostname !== "api\.fxtwitter\.com"/u);
assert.match(nativeXValidator, /\^\\\/2\\\/status\\\/\\d\{2,20\}\$/u);
assert.match(nativeTenorValidator, /url\.hostname !== "tenor\.com"/u);
for (const validator of [nativeKlipyValidator, nativeXValidator, nativeTenorValidator]) {
    assert.match(validator, /url\.username \|\| url\.password \|\| url\.port/u);
    assert.match(validator, /url\.search \|\| url\.hash/u);
    assert.match(validator, /url\.href !== input/u);
}

const providerRequest = section(native, "function requestProviderPreview(", "function assertSecureStorage(");
for (const marker of [
    "partition: WORKER_PARTITION",
    "bypassCustomProtocolHandlers: true",
    'credentials: "omit"',
    "useSessionCookies: false",
    'redirect: "error"',
    'referrerPolicy: "no-referrer"'
]) {
    assert.ok(providerRequest.includes(marker), `provider document request is missing ${marker}`);
}
assert.match(providerRequest, /response\.statusCode !== 200/u);
assert.match(providerRequest, /MAX_PROVIDER_PREVIEW_DOCUMENT_BYTES/u);
assert.match(providerRequest, /format === "json" \? "application\/json" : "text\/html"/u);

assertDirectFetchHardening(
    section(backend, "async function fetchPreviewVideo(", "function klipyMediaUrl("),
    "X video"
);
assertDirectFetchHardening(
    section(backend, "async function fetchKlipyGif(", "function xPosterUrl("),
    "KLIPY media"
);
assertDirectFetchHardening(
    section(backend, "async function fetchXPoster(", "function tenorMediaUrl("),
    "X poster"
);
assertDirectFetchHardening(
    section(backend, "async function fetchTenorMedia(", "function discordStickerCdnUrl("),
    "Tenor media"
);

// In encrypted rooms the direct allowlist is tried first and the worker returns
// before the homeserver preview API. Provider media URLs stay worker-private.
const urlPreview = section(backend, "async function urlPreview(", "function validDirectPreviewCache(");
assert.match(urlPreview, /const allowDirectMedia = command\.allowDirectMedia && directPreviewPolicyAllowed;/u);
assertOrdered(urlPreview, [
    "const klipyUrl = klipyShareUrl(sourceUrl);",
    "const tenorUrl = tenorShareUrl(sourceUrl);",
    "const xStatusRequest = xStatusApiUrl(sourceUrl);",
    "if (allowDirectMedia && (klipyUrl || tenorUrl || xStatusRequest))",
    "directPreview.preview.url = sourceUrl;",
    "if (encrypted) return undefined;",
    "matrixClient!.getUrlPreview(sourceUrl, event.getTs())"
], "encrypted previews must never fall through to the homeserver");
for (const constructor of ["klipyUrlPreview", "tenorUrlPreview", "xUrlPreview"]) {
    assert.match(urlPreview, new RegExp(constructor, "u"));
}
const xConstructor = section(backend, "function fxTwitterRecord(", "async function tenorUrlPreview(");
for (const contract of [
    /fetchXStatus\(request\.url\)/u,
    /JSON\.parse\(raw\)/u,
    /response\?\.code !== 200/u,
    /status\?\.type !== "status"/u,
    /status\.id !== request\.statusId/u,
    /status\.provider !== "twitter"/u,
    /status\.embed_card !== "player"/u,
    /videos\.length === 0 \|\| videos\.length > 16/u,
    /candidate\.type !== "video" \|\| candidate\.format !== "video\/mp4"/u,
    /xVideoUrl\(candidate\.url\)/u,
    /xPosterUrl\(candidate\.thumbnail_url\)/u,
    /previewDimensions\(candidate\.width, candidate\.height\)/u,
    /url: sourceUrl/u
]) {
    assert.match(xConstructor, contract, `FxTwitter v2 schema contract is missing ${contract}`);
}
const previewDto = section(types, "export interface MatrixUrlPreviewDTO", "export interface MatrixReactionDTO");
assert.doesNotMatch(previewDto, /imageUrl|videoUrl|fxtwitter|twimg|klipy|tenor/iu,
    "provider media URLs must not cross into the renderer DTO");
assert.doesNotMatch(bridge, /projectSocialUrl|projectMatrixContent|api\.fxtwitter\.com/u,
    "Discord-visible Matrix content must keep the original URL");

// Revocation invalidates cached authority, aborts both worker fetch and native
// provider document requests, and refreshes both renderer surfaces.
const directCacheValidator = section(backend, "function validDirectPreviewCache(", "async function downloadMedia(");
for (const validator of ["klipyShareUrl", "klipyMediaUrl", "tenorShareUrl", "tenorMediaUrl", "xStatusApiUrl", "xPosterUrl", "xVideoUrl"]) {
    assert.match(directCacheValidator, new RegExp(validator, "u"));
}
const workerDownload = section(backend, "async function downloadMedia(", "function updateProviderPreviewPolicy(");
assert.match(workerDownload, /command\.allowDirectMedia && directPreviewPolicyAllowed/u);
assert.match(workerDownload, /preview\.directProvider && \(!allowDirectMedia \|\| !validDirectPreviewCache\(preview\)\)/u);
const workerPolicy = section(backend, "function updateProviderPreviewPolicy(", "async function handleCommand(");
assert.match(workerPolicy, /directPreviewPolicyAllowed = command\.allowDirectMedia;/u);
assert.match(workerPolicy, /if \(preview\.directProvider\) urlPreviewMedia\.delete\(key\);/u);
assert.match(workerPolicy, /if \(!directPreviewPolicyAllowed\)[\s\S]*activeDirectPreviewControllers[\s\S]*controller\.abort\(\)/u);
assert.match(backend, /if \(request\.command\.type === "providerPreviewPolicy"\)[\s\S]*updateProviderPreviewPolicy/u,
    "policy revocation must bypass queued media work");

assert.match(nativePolicy, /if \(!enabled\)[\s\S]*activeProviderPreviewRequests[\s\S]*request\.abort\(\)/u);
assert.match(nativePolicy, /callWorker\(\{ type: "providerPreviewPolicy", allowDirectMedia: enabled \}\)/u);
assert.match(nativePolicy, /broadcastSecureViewEvent\(\{ type: "security", security: secureViewSecurityState\(\) \}\)/u);
const rendererPolicy = section(
    bridge,
    "export async function setEncryptedRoomProviderPreviewsPolicy(",
    "function resolvedAttachment("
);
assert.match(rendererPolicy, /try \{[\s\S]*await Native\.setEncryptedRoomProviderPreviews\(enabled\);[\s\S]*\} finally \{[\s\S]*clearMediaHydration\(\);/u,
    "renderer preview caches must clear even when native policy synchronization fails");
assertOrdered(rendererPolicy, [
    "await Native.setEncryptedRoomProviderPreviews(enabled);",
    "clearMediaHydration();",
    "prepareRoomMedia(active.room);",
    "reinjectRoomTimelines(active.room.roomId);"
], "Discord projection must refresh only after native applies the policy");
const lifecycle = section(index, "    start() {", "    toolboxActions:");
assert.match(lifecycle, /setEncryptedRoomProviderPreviewsPolicy\(settings\.store\.encryptedRoomProviderPreviews\)/u);
assert.match(lifecycle, /catch \{[\s\S]*authoritative main-process setting/u,
    "startup must rely on per-request main authority if policy synchronization fails");
assert.match(lifecycle, /pendingPluginShutdown = suspendBridge\(\)\.catch/u);

const clearSecureMedia = section(secureView, "function clearMedia()", "function clearSensitiveUiState(");
assert.match(clearSecureMedia, /mediaGeneration\+\+;/u);
assert.match(clearSecureMedia, /URL\.revokeObjectURL/u);
for (const cache of ["mediaCache", "mediaTombstones", "previewCache", "previewLoading", "pendingMedia"]) {
    assert.match(clearSecureMedia, new RegExp(`${cache}\\.clear\\(\\)`, "u"));
}
const securityEvent = section(secureView, '        case "security":', '        case "fatal":');
assertOrdered(securityEvent, [
    "security?.encryptedRoomProviderPreviews",
    "!== event.security.encryptedRoomProviderPreviews",
    "clearMedia();",
    "security = event.security;",
    "scheduleRender();"
], "secure view must invalidate stale preview state on either policy transition");

// Provider URLs and fetched documents are sensitive request metadata. The direct
// preview path must fail silently without sending either through diagnostics.
const providerBackend = section(backend, "const PROJECTED_SOCIAL_HOSTS", "interface LaneWaiter");
const providerNativeHandlers = section(
    native,
    "ipcMain.handle(MATRIX_WORKER_FETCH_KLIPY_PREVIEW",
    "async function ensureWorker("
);
const nativeKlipyHandler = section(
    native,
    "ipcMain.handle(MATRIX_WORKER_FETCH_KLIPY_PREVIEW",
    "ipcMain.handle(MATRIX_WORKER_FETCH_TENOR_PREVIEW"
);
const nativeTenorHandler = section(
    native,
    "ipcMain.handle(MATRIX_WORKER_FETCH_TENOR_PREVIEW",
    "ipcMain.handle(MATRIX_WORKER_FETCH_X_STATUS"
);
const nativeXHandler = section(
    native,
    "ipcMain.handle(MATRIX_WORKER_FETCH_X_STATUS",
    "async function ensureWorker("
);
for (const [handler, validator] of [
    [nativeKlipyHandler, "validateKlipyShareUrl"],
    [nativeTenorHandler, "validateTenorShareUrl"],
    [nativeXHandler, "validateFxTwitterStatusUrl"]
] as const) {
    assert.match(handler, /event\.sender !== workerWindow\.webContents/u);
    assert.equal(
        Array.from(handler.matchAll(/!encryptedRoomProviderPreviewsEnabled\(\)/gu)).length,
        2,
        `${validator} egress must re-check the main setting after validation`
    );
    assert.match(handler, new RegExp(validator, "u"));
}
assert.match(nativeXHandler, /requestProviderPreview\(url, "json"\)/u);
for (const sensitivePath of [providerBackend, providerRequest, providerNativeHandlers, nativePolicy]) {
    assert.doesNotMatch(sensitivePath, /\b(?:console|logger)\./u);
}

console.log("Matrix provider preview privacy fixtures passed.");
