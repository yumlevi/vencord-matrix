#!/usr/bin/node
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

// @ts-check

import { copyFile, mkdir, readdir } from "fs/promises";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";

import { BUILD_TIMESTAMP, commonOpts, exists, globPlugins, IS_DEV, IS_REPORTER, IS_ANTI_CRASH_TEST, IS_STANDALONE, IS_UPDATER_DISABLED, resolvePluginName, UPDATE_RSA_EXPONENT, UPDATE_RSA_MODULUS, VERSION, commonRendererPlugins, watch, buildOrWatchAll, stringifyValues } from "./common.mjs";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
if (IS_STANDALONE && !IS_UPDATER_DISABLED) {
    const modulus = Buffer.from(UPDATE_RSA_MODULUS, "base64url");
    const modulusBits = modulus.length === 0 ? 0 : (modulus.length - 1) * 8 + 32 - Math.clz32(modulus[0]);
    if (!BASE64URL.test(UPDATE_RSA_MODULUS) || modulus.toString("base64url") !== UPDATE_RSA_MODULUS
        || modulus.length < 384 || modulus.length > 512 || modulusBits < 3072 || modulusBits > 4096)
        throw new Error("Updater-enabled standalone builds require a valid VENCORD_UPDATE_RSA_MODULUS");
    if (UPDATE_RSA_EXPONENT !== "AQAB")
        throw new Error("Updater-enabled standalone builds require a valid VENCORD_UPDATE_RSA_EXPONENT");
}

const defines = stringifyValues({
    IS_STANDALONE,
    IS_DEV,
    IS_REPORTER,
    IS_ANTI_CRASH_TEST,
    IS_UPDATER_DISABLED,
    IS_WEB: false,
    IS_EXTENSION: false,
    IS_USERSCRIPT: false,
    VERSION,
    BUILD_TIMESTAMP,
    UPDATE_RSA_MODULUS,
    UPDATE_RSA_EXPONENT
});

if (defines.IS_STANDALONE === "false") {
    // If this is a local build (not standalone), optimize
    // for the specific platform we're on
    defines["process.platform"] = JSON.stringify(process.platform);
}

/**
 * @type {import("esbuild").BuildOptions}
 */
const nodeCommonOpts = {
    ...commonOpts,
    define: defines,
    format: "cjs",
    platform: "node",
    target: ["esnext"],
    // @ts-expect-error this is never undefined
    external: ["electron", "original-fs", "~pluginNatives", ...commonOpts.external]
};

const sourceMapFooter = s => watch ? "" : `//# sourceMappingURL=vencord://${s}.js.map`;
const sourcemap = watch ? "inline" : "external";

const require = createRequire(import.meta.url);
const matrixCryptoEntry = require.resolve("@matrix-org/matrix-sdk-crypto-wasm");
const matrixCryptoWasm = join(dirname(matrixCryptoEntry), "pkg", "matrix_sdk_crypto_wasm_bg.wasm");
await mkdir("dist", { recursive: true });
await copyFile(matrixCryptoWasm, "dist/matrix_sdk_crypto_wasm_bg.wasm");

/**
 * @type {import("esbuild").Plugin}
 */
const globNativesPlugin = {
    name: "glob-natives-plugin",
    setup: build => {
        const filter = /^~pluginNatives$/;
        build.onResolve({ filter }, args => {
            return {
                namespace: "import-natives",
                path: args.path
            };
        });

        build.onLoad({ filter, namespace: "import-natives" }, async () => {
            const pluginDirs = ["plugins", "userplugins"];
            let code = "";
            let natives = "\n";
            let i = 0;
            /**
             * @type {string[]}
             */
            const watchFiles = [];
            for (const dir of pluginDirs) {
                const dirPath = join("src", dir);
                if (!await exists(dirPath)) continue;
                const plugins = await readdir(dirPath, { withFileTypes: true });
                for (const file of plugins) {
                    const fileName = file.name;
                    const nativePath = join(dirPath, fileName, "native.ts");
                    const indexNativePath = join(dirPath, fileName, "native/index.ts");

                    watchFiles.push(resolve(nativePath), resolve(indexNativePath));

                    if (!(await exists(nativePath)) && !(await exists(indexNativePath)))
                        continue;

                    const pluginName = await resolvePluginName(dirPath, file);

                    const mod = `p${i}`;
                    code += `import * as ${mod} from "./${dir}/${fileName}/native";\n`;
                    natives += `${JSON.stringify(pluginName)}:${mod},\n`;
                    i++;
                }
            }
            code += `export default {${natives}};`;
            return {
                contents: code,
                resolveDir: "./src",
                watchDirs: pluginDirs.map(d => resolve("src", d)),
                watchFiles,
            };
        });
    }
};

/** @type {import("esbuild").BuildOptions[]} */
const buildConfigs = ([
    // Discord Desktop main & renderer & preload
    {
        ...nodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/patcher.js",
        footer: { js: "//# sourceURL=file:///VencordPatcher\n" + sourceMapFooter("patcher") },
        sourcemap,
        plugins: [
            // @ts-ignore this is never undefined
            ...nodeCommonOpts.plugins,
            globNativesPlugin
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        ...commonOpts,
        entryPoints: ["src/Vencord.ts"],
        outfile: "dist/renderer.js",
        format: "iife",
        target: ["esnext"],
        footer: { js: "//# sourceURL=file:///VencordRenderer\n" + sourceMapFooter("renderer") },
        globalName: "Vencord",
        sourcemap,
        plugins: [
            globPlugins("discordDesktop"),
            ...commonRendererPlugins
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/preload.ts"],
        outfile: "dist/preload.js",
        footer: { js: "//# sourceURL=file:///VencordPreload\n" + sourceMapFooter("preload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },

    // Vencord Desktop main & renderer & preload
    {
        ...nodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/vencordDesktopMain.js",
        footer: { js: "//# sourceURL=file:///VencordDesktopMain\n" + sourceMapFooter("vencordDesktopMain") },
        sourcemap,
        plugins: [
            ...nodeCommonOpts.plugins,
            globNativesPlugin
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    },
    {
        ...commonOpts,
        entryPoints: ["src/Vencord.ts"],
        outfile: "dist/vencordDesktopRenderer.js",
        format: "iife",
        target: ["esnext"],
        footer: { js: "//# sourceURL=file:///VencordDesktopRenderer\n" + sourceMapFooter("vencordDesktopRenderer") },
        globalName: "Vencord",
        sourcemap,
        plugins: [
            globPlugins("vesktop"),
            ...commonRendererPlugins
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/preload.ts"],
        outfile: "dist/vencordDesktopPreload.js",
        footer: { js: "//# sourceURL=file:///VencordPreload\n" + sourceMapFooter("vencordDesktopPreload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    },

    // Sandboxed Matrix backend and its minimal preload. These are shared by
    // Discord Desktop and Vencord Desktop builds.
    {
        ...commonOpts,
        entryPoints: ["src/plugins/matrixBridge/matrixBackend.ts"],
        outfile: "dist/matrixBridgeWorker.js",
        format: "esm",
        platform: "browser",
        target: ["esnext"],
        footer: { js: "//# sourceURL=file:///MatrixBridgeWorker\n" + sourceMapFooter("matrixBridgeWorker") },
        sourcemap,
        // matrix-js-sdk intentionally uses the browser `events` polyfill, whose
        // package name also matches a Node builtin. Browser-platform resolution
        // bundles that polyfill; the normal renderer builtin ban cannot be used.
        plugins: commonOpts.plugins,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/plugins/matrixBridge/workerPreload.ts"],
        outfile: "dist/matrixBridgePreload.js",
        footer: { js: "//# sourceURL=file:///MatrixBridgePreload\n" + sourceMapFooter("matrixBridgePreload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },

    // Matrix message plaintext is rendered only inside this isolated view.
    // Its renderer intentionally has no Discord/Vencord or network imports.
    {
        ...commonOpts,
        entryPoints: ["src/plugins/matrixBridge/secureView.ts"],
        outfile: "dist/matrixSecureView.js",
        format: "iife",
        platform: "browser",
        target: ["esnext"],
        inject: [],
        external: [],
        footer: { js: "//# sourceURL=file:///MatrixSecureView\n" + sourceMapFooter("matrixSecureView") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        logLevel: commonOpts.logLevel,
        bundle: true,
        minify: commonOpts.minify,
        sourcemap,
        entryPoints: ["src/plugins/matrixBridge/secureView.css"],
        outfile: "dist/matrixSecureView.css"
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/plugins/matrixBridge/secureViewPreload.ts"],
        outfile: "dist/matrixSecureViewPreload.js",
        inject: [],
        footer: { js: "//# sourceURL=file:///MatrixSecureViewPreload\n" + sourceMapFooter("matrixSecureViewPreload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    }
]);

await buildOrWatchAll(buildConfigs);
