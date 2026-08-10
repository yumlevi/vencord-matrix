/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const template = readFileSync("scripts/release/Install-Disorder.sh.template", "utf8");
const pythonStartMarker = "exec \"$PYTHON_BIN\" - <<'PY'\n";
const pythonStart = template.indexOf(pythonStartMarker);
const pythonEnd = template.lastIndexOf("\nPY\n");

assert.equal(template.startsWith("#!/bin/sh\n"), true);
assert.notEqual(pythonStart, -1, "the installer must use a quoted local Python heredoc");
assert.ok(pythonEnd > pythonStart, "the embedded Python heredoc must terminate exactly once");
assert.match(template, /Python 3\.9 or newer is required/u);

const tokens = [
    "__DISORDER_REPOSITORY__",
    "__DISORDER_UPDATE_PUBLIC_KEY_PEM_BASE64__",
    "__DISORDER_PUBLIC_KEY_FINGERPRINT__",
    "__DISORDER_STABLE_PATCHER_BASE64__"
];
for (const token of tokens)
    assert.equal(template.split(token).length - 1, 1, `${token} must occur exactly once`);

let python = template.slice(pythonStart + pythonStartMarker.length, pythonEnd);
python = python
    .replace("__DISORDER_REPOSITORY__", "example/disorder")
    .replace("__DISORDER_UPDATE_PUBLIC_KEY_PEM_BASE64__", "QQ==")
    .replace("__DISORDER_PUBLIC_KEY_FINGERPRINT__", "0".repeat(64))
    .replace("__DISORDER_STABLE_PATCHER_BASE64__", "bW9kdWxlLmV4cG9ydHMgPSB7fTsK");

const pythonExecutable = process.platform === "win32" ? "python" : "python3";
const compiled = spawnSync(
    pythonExecutable,
    ["-c", "import sys; compile(sys.stdin.read(), '<Install-Disorder.sh>', 'exec')"],
    { input: python, encoding: "utf8", timeout: 20_000, windowsHide: true }
);
assert.equal(compiled.status, 0, compiled.stderr || "the embedded Python must compile");

const signatureCall = python.indexOf("manifest_bytes = verify_manifest_signature(");
const manifestParseCall = python.indexOf("manifest, files = parse_manifest(manifest_bytes)", signatureCall);
assert.ok(signatureCall >= 0 && manifestParseCall > signatureCall, "the manifest must be verified before it is parsed");

assert.match(python, /RELEASE_ASSET_NAMES = \([\s\S]*MANIFEST_NAME,[\s\S]*SIGNATURE_NAME,[\s\S]*RUNTIME_NAME,[\s\S]*"Install-Disorder\.ps1",[\s\S]*"Install-Disorder\.cmd",[\s\S]*"Disorder-Setup\.zip",[\s\S]*\)/u);
assert.match(python, /if tuple\(sorted\(assets\)\) != tuple\(sorted\(RELEASE_ASSET_NAMES\)\)/u);
assert.match(python, /asset\.get\("state"\) != "uploaded"/u);
assert.doesNotMatch(python, /VencordInstaller\.MacOS/u);
assert.doesNotMatch(python, /\[.*(?:"sudo"|"spctl"|"xattr").*\]/u);
assert.match(python, /LINUX_INSTALLER_SHA256 = "815917a79391a4426022b395cc1d8e41ae80130edab98cbfbe08fbbe67cd2b28"/u);
assert.match(python, /system == "Linux" and machine not in \("x86_64", "amd64"\)/u);

assert.match(python, /parent = home \/ "Library" \/ "Application Support"/u);
assert.match(python, /parent = home \/ "\.config"/u);
assert.match(python, /os\.geteuid\(\) == 0[\s\S]*SUDO_USER[\s\S]*SUDO_UID/u);
assert.match(python, /MAC_CONFIRMATION = "MODIFY DISCORD"/u);
assert.match(python, /MAC_SHARED_CONFIRMATION = "MODIFY SHARED DISCORD"/u);
assert.match(python, /bundle\.parent == Path\("\/Applications"\)[\s\S]*return MAC_SHARED_CONFIRMATION/u);
assert.match(python, /under \/Applications and may be shared by local accounts[\s\S]*binding the shared app to this account[\s\S]*unusable to other local accounts/u);
assert.match(python, /CFBundleIdentifier/u);
assert.match(python, /files\.get\("Resources\/app\.asar"\)[\s\S]*entry\.get\("hash2"\)/u);
assert.doesNotMatch(python, /DISORDER_ORIGINAL_ASAR/u);
assert.match(template, /ASAR writer is ported from Vencord Installer v1\.4\.0/u);
assert.match(python, /def mac_patcher_asar\(base: Path\)[\s\S]*struct\.pack\("<IIII", 4, aligned_size \+ 8, aligned_size \+ 4, header_size\)/u);
assert.ok(python.includes("package_json = b'{\\n\\t\"name\": \"discord\",\\n\\t\"main\": \"index.js\"\\n}'"));
assert.match(python, /atomic_write\(dist \/ "package\.json", b"\{\}\\n"\)/u);
assert.match(python, /"status": "pending"[\s\S]*app_asar\.rename\(original\)[\s\S]*staging\.rename\(app_asar\)[\s\S]*"status": "installed"/u);
assert.match(python, /remove_recoverable_mac_staging[\s\S]*path\.unlink\(\)[\s\S]*fsync_directory\(path\.parent\)/u);
const macMutationSection = python.slice(python.indexOf("def go_json_string("), python.indexOf("def run_linux_installer("));
assert.doesNotMatch(macMutationSection, /shutil\.rmtree/u);
assert.match(python, /System \.deb paths and Snap installs are unsupported; this installer will not use sudo\./u);
assert.match(python, /version check against GitHub, with vencord\.dev as fallback/u);
assert.match(python, /request exposes your IP address and User-Agent; dev-install mode prevents self-update and runtime download/u);

assert.match(python, /raw\["pendingBoot"\] is False and raw\["bootAttempts"\] != 0/u);
assert.match(python, /previous\["sequence"\] >= current\["sequence"\]/u);
assert.match(python, /len\(\{item\["sequence"\] for item in identities\}\) != len\(identities\)/u);
assert.match(python, /identity\["sequence"\] > raw\["highestSeenSequence"\]/u);

const fixtureStart = python.indexOf("\ntry:\n    main()\n");
assert.notEqual(fixtureStart, -1);
const fixtureSource = `${python.slice(0, fixtureStart)}

def expect_install_failure(callback):
    try:
        callback()
    except InstallFailure:
        return
    raise AssertionError("expected InstallFailure")

if os.name == "nt":
    fsync_directory = lambda _path: None

with tempfile.TemporaryDirectory(prefix="disorder-unix-fixture-") as fixture_raw:
    fixture = Path(fixture_raw)
    state_path = fixture / "release-state.json"
    current = {"id":"r2-" + "2" * 12, "sequence":2, "commit":"2" * 40, "manifestSha256":"b" * 64}
    previous = {"id":"r1-" + "1" * 12, "sequence":1, "commit":"1" * 40, "manifestSha256":"a" * 64}
    valid_state = {
        "schema":1, "current":current, "previous":previous,
        "highestSeenSequence":2, "highestSeenManifestSha256":"b" * 64,
        "pendingBoot":False, "bootAttempts":0,
    }
    state_path.write_text(json.dumps(valid_state), encoding="utf8")
    assert parse_state(state_path) == valid_state

    invalid_attempts = {**valid_state, "bootAttempts":1}
    state_path.write_text(json.dumps(invalid_attempts), encoding="utf8")
    expect_install_failure(lambda: parse_state(state_path))

    invalid_previous = {**valid_state, "previous":current}
    state_path.write_text(json.dumps(invalid_previous), encoding="utf8")
    expect_install_failure(lambda: parse_state(state_path))

    invalid_watermark = {**valid_state, "highestSeenManifestSha256":"c" * 64}
    state_path.write_text(json.dumps(invalid_watermark), encoding="utf8")
    expect_install_failure(lambda: parse_state(state_path))

    expect_install_failure(lambda: strict_json(b'{"a":1,"a":2}', "DUPLICATE"))

    assert mac_confirmation_for_bundle(Path("/Applications/Discord.app")) == MAC_SHARED_CONFIRMATION
    assert mac_confirmation_for_bundle(Path("/fixtures/x/Applications/Discord.app")) == MAC_CONFIRMATION

    # Golden independently generated with Vencord Installer v1.4.0 app_asar.go.
    asar_base = PurePosixPath("/fixtures/x/<&>\u2028/Library/Application Support/Vencord")
    patched = mac_patcher_asar(asar_base)
    assert len(patched) == 246
    assert sha256_bytes(patched) == "9cb1ee26da0cb191a4baa372757ced1580266a8df2231371ee76daf19e3ac3da"
    data_size, header_size, header_object_size, header_json_size = struct.unpack("<IIII", patched[:16])
    assert data_size == 4
    assert header_size == ((header_json_size + 3) & ~3) + 8
    assert header_object_size == ((header_json_size + 3) & ~3) + 4
    header_end = 16 + ((header_json_size + 3) & ~3)
    header = json.loads(patched[16:16 + header_json_size].decode("utf8"))
    assert list(header["files"]) == ["index.js", "package.json"]
    index_size = header["files"]["index.js"]["size"]
    package_size = header["files"]["package.json"]["size"]
    assert header_json_size == 88 and index_size == 99 and package_size == 43
    assert patched[header_end:header_end + index_size].decode("utf8") == "require(" + go_json_string(str(asar_base / "dist" / "patcher.js")) + ")"
    assert patched[-package_size:] == b'{\\n\\t"name": "discord",\\n\\t"main": "index.js"\\n}'
    assert go_json_string("<&>\u2028\u2029") == '"\\\\u003c\\\\u0026\\\\u003e\\\\u2028\\\\u2029"'

    partial = fixture / (".disorder-app-asar-staging-" + "0" * 32)
    record = {"patchedSize":len(patched), "patchedSha256":sha256_bytes(patched)}
    partial.write_bytes(patched[:3])
    assert recoverable_mac_staging(partial, record, patched)
    stage_mac_asar(partial, record, patched)
    assert partial.read_bytes() == patched
    remove_recoverable_mac_staging(partial, record, patched)
    assert not partial.exists()

    archive = fixture / "runtime.zip"
    expected_files = {}
    with zipfile.ZipFile(archive, "w") as output:
        for name in RUNTIME_FILES:
            contents = ("fixture:" + name).encode("utf8")
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = 0o644 << 16
            output.writestr(info, contents)
            expected_files[name] = {"path":name, "size":len(contents), "sha256":sha256_bytes(contents)}
    manifest_path = fixture / MANIFEST_NAME
    signature_path = fixture / SIGNATURE_NAME
    manifest_path.write_bytes(b"manifest")
    signature_path.write_bytes(b"signature")
    extracted = fixture / "extracted"
    extract_runtime(archive, extracted, expected_files, manifest_path, signature_path)
    assert {entry.name for entry in extracted.iterdir()} == set(RUNTIME_FILES) | {MANIFEST_NAME, SIGNATURE_NAME}

print("Unix release installer trust, state, archive, and recovery fixtures passed.")
`;

const fixtures = spawnSync(pythonExecutable, ["-"], {
    input: fixtureSource,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
});
assert.equal(fixtures.status, 0, fixtures.stderr || fixtures.stdout);
assert.match(fixtures.stdout, /Unix release installer trust, state, archive, and recovery fixtures passed\./u);

console.log("Unix release installer template and executable fixtures passed.");
