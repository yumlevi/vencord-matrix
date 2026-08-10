# Public releases and automatic updates

This repository contains a release path for a public, credential-free Disorder Vencord build. It is intentionally disabled until the source tree has been reviewed, an update key has been created, and the branch-restricted GitHub signing environment is configured. Nothing in this setup creates a repository, key, secret, or release automatically.

## Trust model

- GitHub Actions builds a fixed 18-file runtime from a clean checkout. Source maps, diagnostics, screenshots, logs, and installer caches are not release inputs.
- A protected signing job receives a base64 PKCS#8 RSA key, but checks out no repository code and has read-only repository permission. It signs only the already-validated raw manifest.
- A separate job has release-write permission but cannot access the signing environment or private key. The workflow uses unique tags and refuses reuse; repository-level immutable releases must be enabled before publishing so released tags and assets cannot later be replaced.
- The downloaded installer embeds the public RSA trust root. It verifies the detached manifest signature, runtime ZIP hash, exact file allowlist, sizes, and per-file hashes before writing anything persistent.
- The stable loader re-verifies the signed manifest and every runtime file on every Discord start. A new release must boot successfully; two failed boots roll back to the last verified release without lowering the anti-rollback watermark.
- Windows uses the upstream Vencord Installer CLI pinned to v1.4.0 and its complete SHA-256 from the [official checksum file](https://github.com/Vencord/Installer/releases/download/v1.4.0/checksums.sha256): `466d2a0be1f380ddffed052df3cc132125fa34dc1af29312e14f13f358c8d2a2`.
- Linux x86_64 uses the corresponding pinned `VencordInstallerCli-linux` only after verifying its complete SHA-256: `815917a79391a4426022b395cc1d8e41ae80130edab98cbfbe08fbbe67cd2b28`.
- macOS does not download or execute the unsigned upstream installer. The local shell verifies the original Discord bundle and its sealed `app.asar`, requires an exact interactive warning acknowledgement, and then replaces it with a locally generated, upstream-compatible loader ASAR without elevation or a Gatekeeper bypass.

The first installer download is trust-on-first-use. Send the setup ZIP SHA-256 and public-key SPKI SHA-256 to recipients through a separate trusted conversation so they can compare them with the release page before running it.

## Before making the source public

Use a fresh clone or clean worktree for the public push. Do not use `git add .` in a development checkout containing diagnostics.

1. Configure a deliberate pseudonymous GitHub noreply commit identity if personal attribution is unwanted.
2. Enable the local privacy hook:

   ```powershell
   node scripts/release/enablePrivacyHook.mjs
   ```

3. Run the same scan manually and inspect everything Git considers publishable:

   ```powershell
   node scripts/release/checkPublicTree.mjs
   git status --short --ignored
   ```

4. Review commit history as well as the current tree for credentials, chat/account identifiers, machine-local paths, screenshots, logs, and diagnostic output. The scanner is a guardrail, not a substitute for review.
5. Require the `privacy-audit` job for pull requests and disallow direct pushes to `main`. The workflow runs that job for every pull request and every `main` push, without a path filter.

The public repository and release must retain the project GPL license and provide corresponding source. Runtime packages also include the MIT `fflate` license and Apache-2.0 licenses for `matrix-js-sdk` and Matrix crypto WASM.

## One-time signing setup (after the privacy audit)

Generate the private output outside this repository. This command is provided for the future setup; it has not been run by this change:

```powershell
$privateKey = Join-Path ([IO.Path]::GetTempPath()) "disorder-update-key.pkcs8.b64"
node scripts/release/generateReleaseKey.mjs --private-out "$privateKey"
```

The command writes the public JWK to `release/update-public-key.json` and refuses to overwrite either file. Commit only the public JWK. Never commit or paste the private output into an issue, log, workflow file, repository variable, or command line.

In GitHub:

1. Create an environment named `disorder-release-signing` with deployment restricted to protected `main`. Do not add a required reviewer if every green `main` push should publish automatically.
2. Add environment secret `DISORDER_UPDATE_SIGNING_KEY_PKCS8_B64` from the private file using GitHub's secret UI or a stdin-based `gh secret set` invocation. Do not use `--body`, which can expose the key in a process command line.
3. Remove the temporary private file after the secret is confirmed. Keep an offline encrypted recovery copy only if key recovery is required.
4. Before the first release, enable GitHub's [repository-level immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) setting. It applies only to releases published after it is enabled. Verify it once with an administrator-authenticated GitHub CLI session:

   ```powershell
   node scripts/release/verifyImmutableReleases.mjs --repository OWNER/REPOSITORY
   ```

   The workflow creates a draft, attaches every asset, and only then publishes it. It also checks the published release's public `immutable` field and deletes a mutable release before failing.
5. Allow GitHub Actions to create releases, and set repository variable `DISORDER_PUBLIC_RELEASES_ENABLED` to `true` only after branch protection, immutable releases, and the signing environment are active.

Changing `release/update-public-key.json` after users install a build is a trust-root rotation and requires a separately verified reinstall. Do not rotate it as an ordinary update.

## Publishing

With releases enabled, a push to protected `main` builds, signs, and publishes a new `disorder-r<sequence>-<commit>` release automatically. The one-time administrator check confirms the setting before releases are enabled; every publication then verifies that GitHub reports the concrete release immutable. Re-running an older workflow or reusing an existing tag is rejected.

If the post-publication check ever fails, the workflow hides or removes that release but deliberately retains its tag as a sequence tombstone. Investigate the repository setting and start a new workflow run; do not rerun the failed sequence.

Keep this repository's latest non-draft GitHub release reserved for this channel. Installers and automatic updates deliberately reject a latest release that has unrelated or extra attached assets.

The release contains exactly:

- `disorder-manifest.json`
- `disorder-manifest.sig`
- `disorder-runtime.zip`
- `Install-Disorder.ps1`
- `Install-Disorder.cmd`
- `Disorder-Setup.zip`

`Disorder-Setup.zip` contains exactly `Install-Disorder.cmd`, `Install-Disorder.ps1`, and `Install-Disorder.sh`; the shell remains inside the ZIP so the release still has exactly six assets.

Release notes are static and privacy-safe: no generated changelog, commit author, or commit message is included. They disclose the Windows installer and launcher hashes, the embedded macOS/Linux shell hash, the one-download ZIP hash, and the public-key fingerprint.

## Friend installation

1. Download `Disorder-Setup.zip` from the latest release as a file. Do not use `irm | iex`, `curl | powershell`, `curl | sh`, or any other pipe-to-shell command.
2. Compare its SHA-256 with the release notes and, ideally, with the value sent through a separate trusted conversation:

   ```powershell
   Get-FileHash .\Disorder-Setup.zip -Algorithm SHA256
   ```

   On macOS use `shasum -a 256 Disorder-Setup.zip`; on Linux use `sha256sum Disorder-Setup.zip`.
3. Extract all three files from the ZIP and fully quit Discord, including its tray or menu-bar process.
4. Run the local installer for the platform:
   - Windows: double-click `Install-Disorder.cmd`.
   - macOS or Linux: install Python 3.9 or newer and OpenSSL, open a terminal in the extracted folder, and run `sh ./Install-Disorder.sh` as the normal desktop user. The shell accepts no arguments and rejects root, `sudo`, or an already-elevated environment.
5. Reopen Discord when setup asks.

Linux support is x86_64 only. The shell verifies the exact pinned v1.4.0 Linux CLI before starting its interactive Discord selection. This non-elevating bootstrap supports only user-writable Discord installs and user Flatpak; root-owned system or `.deb` installs, system Flatpak, and Snap are unsupported.

macOS support is experimental on arm64 and x86_64. The shell offers only official Discord, PTB, Canary, or Development apps in `/Applications` or `~/Applications`, and refuses a bundle whose `Contents/Resources` directory is not writable. After checking the original Apple signature and sealed `app.asar`, it explains the change and requires exactly `MODIFY DISCORD` for a per-user app or `MODIFY SHARED DISCORD` for an app under `/Applications`. It retains the original as `_app.asar` and writes a deterministic, upstream-compatible loader ASAR to `Discord.app/Contents/Resources/app.asar`.

The generated loader embeds the installing account's private Vencord data path. Modifying a shared `/Applications` bundle therefore binds that machine-wide app to this local account and may make it unusable to other local accounts. Prefer a per-user copy under `~/Applications` on a multi-user Mac.

This deliberate macOS modification invalidates Discord's sealed code signature. macOS may report the app as modified or damaged, and the changed identity may affect privacy prompts or Keychain access. Setup does not use `sudo`, re-sign Discord, remove quarantine attributes, invoke `xattr` or `spctl`, or disable Gatekeeper. Rerun the same verified setup after Discord replaces or updates its app bundle. Reinstall Discord to restore the stock bundle and signature.

Platform data roots are `%APPDATA%\Vencord` on Windows, `~/Library/Application Support/Vencord` on macOS, and `${XDG_CONFIG_HOME:-$HOME/.config}/Vencord` on Linux. Matrix account storage and settings remain outside immutable release directories and are not cleared by updates.

The Windows launcher never elevates, downloads, or evaluates text; it only starts the adjacent downloaded PowerShell file. The project's PowerShell and POSIX bootstraps use small fixed HTTPS host allowlists, follow redirects manually, enforce byte and time limits, verify the signed package, and serialize concurrent installs. Windows and Linux then start a pinned, verified upstream installer; macOS performs the attested direct injection described above. The Linux CLI makes its own GitHub version-check request, with a `vencord.dev` fallback, exposing the recipient's IP address and its User-Agent to those services. In this development-install path it neither self-updates nor downloads the upstream Vencord runtime. Automatic in-app updates use the signed Disorder release channel and anti-rollback checks and require a normal Discord restart to activate.

If setup stops after the runtime is staged or the macOS injection begins, leave the signed runtime, release state, and macOS recovery journal in place, fully quit Discord, and run setup again. Do not delete `release-state.json` or an injection journal to force a retry or downgrade.
