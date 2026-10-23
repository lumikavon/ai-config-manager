# Native desktop integration and release gates

The Tauri 2 shell is real native integration, not browser mocks. Its production frontend is the local `dist` bundle. Browser preview intentionally cannot prove credential-vault, tray, startup or installer behavior.

## Implemented behavior

- `config_read`, `config_save`, `config_check` and `history_list` call the shared Rust core on blocking workers. Keychain prompts and disk operations do not block the webview event thread. No API returns a decrypted credential to JavaScript.
- One hidden `main` window is created, then shown after preferences and tray initialization unless silent mode is safe. Default language is Chinese; preferences are `silent_start: false`, `close_to_tray: true`.
- Preferences reside at Tauri's platform app-config directory (`dev.aiconfig.manager/settings.json`), separate from provider YAML. Schema version 1 is validated. Missing preferences use defaults. Malformed, unsupported or unreadable preferences generate a visible warning and remain untouched until an explicit preferences save. Saves write a temporary file in the same directory, fsync it, atomically replace the destination, and fsync the directory on Unix. Unix preference files are 0600. If replacement succeeds but directory synchronization fails, the new values become active in memory and the returned view includes `SETTINGS_DURABILITY_UNCERTAIN`; the application does not pretend the replacement rolled back or automatically repeat it. Preferences contain no credentials. External editing of preferences while the app is running is not supported: `settings_read` returns the current in-process state; restart to load external edits.
- The localized tray offers Show, Hide, Settings and Quit. Settings restores the window and emits `navigate` with string payload `settings`. Language changes rebuild the native menu. Quit calls `app.exit(0)` rather than hiding the window.
- Closing hides only when the preference is enabled and a usable tray is known. Hide requests fail with `TRAY_UNAVAILABLE` otherwise. `--silent` or stored silent mode hides only after successful tray creation. Initialization warnings always force the window visible.
- Linux additionally requires a session-bus StatusNotifierWatcher reporting `IsStatusNotifierHostRegistered=true`. This deliberately falls back to a visible window on desktops without a verified tray host, including GNOME sessions without a suitable extension. A tray object alone is not treated as proof of a usable Linux tray.
- The official single-instance plugin is registered first. A second launch restores and focuses the existing main window instead of starting another editor.
- Autostart uses the official Tauri plugin, with `--silent`. Windows uses OS login registration; macOS explicitly selects LaunchAgent; Linux uses the plugin's desktop autostart mechanism. Reading settings queries actual OS registration; there is no local boolean pretending to be registration. Failed queries return `autostart_known: false` and an `AUTOSTART_UNKNOWN` warning, so the UI must display Unknown rather than Disabled. Enable/disable commands query the OS again and fail on mismatch. Autostart is not enabled automatically.
- IPC is allowed only for the local main window's eight application commands and event listen/unlisten. No generic filesystem, shell, process, remote-origin, or plugin-autostart JavaScript permissions are granted. Native code owns the narrowly scoped startup changes. Production CSP disallows external scripts, remote API connections, frames, objects and forms. No provider API requests are made by this shell.

## Build requirements

Rust 1.90+; Node/npm as pinned by project configuration; Tauri platform prerequisites from https://v2.tauri.app/start/prerequisites/. Build on each release platform, not only via cross-platform Rust checking. Linux requires GTK/WebKitGTK/appindicator development dependencies and the Secret Service stack. Windows needs the appropriate Microsoft build tools and WebView2. macOS builds require Xcode command-line tools and signing/notarization for distribution.

`cargo check --target ...` proves type checking only. It does not prove that a desktop tray appears, an installer works, a keychain authorization prompt succeeds, or an OS login entry actually starts the installed binary. Do not describe these as passed without recording native evidence.

## Required native acceptance gates (not claimed as tested by source generation)

Run on installed packaged builds on Windows, macOS and a supported Linux desktop, using a disposable OS account/profile and test-only credentials:

1. Fresh launch shows Chinese UI; switching language updates UI and native tray immediately and survives restart. Malformed settings force a visible warning, preserve original bytes and recover after explicit save.
2. With the tray present, normal launch is visible; stored silent mode and `--silent` are hidden. Show restores and focuses; Settings opens the settings panel; Hide hides; Quit removes the process. Close-to-tray off exits when the only window is closed. A second process launch reveals the first instance.
3. Without a Linux tray host (and under injected tray-creation failure on other platforms), silent launch remains visible, hide is refused, close is not intercepted, and a diagnostic is displayed. Also test tray-host disappearance after startup: host-loss recovery is not currently monitored and is a known limitation.
4. Toggle login startup on, verify the actual OS entry targets the installed binary with `--silent`, sign out/in or reboot, verify one hidden instance with an accessible tray. Toggle off, verify the entry is removed and next login does not launch. macOS test must inspect the LaunchAgent. Permission denial and unsupported session must be surfaced without a false success state.
5. Save a disposable API key, restart, validate decryptability through the native core; inspect YAML/history/diagnostics for no plaintext. Deny or lock the OS keychain, and verify errors without exposing values. Try concurrent GUI/CLI updates and a stale revision conflict.
6. Build/install/uninstall all intended installer formats; check icons, high DPI, keyboard navigation, signing and platform-specific packaging. No production signing credentials are included.
7. Exercise remote navigation and malformed IPC attempts: only the shipped local main webview may invoke the documented commands, and arbitrary shell/filesystem operations must remain unavailable.

The automated settings tests cover missing-file defaults, persistence round-trip, malformed-file preservation, unknown schema handling and invalid-language rejection, unknown-field rejection, failed-save state preservation, and injected post-replacement directory-sync failure with matching disk/cache state and a durability warning. Run `cargo test --manifest-path src-tauri/settings-tests/Cargo.toml` to execute the production preferences module without GUI dependencies. Core tests provide separate evidence for storage and encryption. Automated test completion is recorded by the top-level verification report, not inferred here.

## Official references

- Autostart: https://v2.tauri.app/plugin/autostart/
- Single instance: https://v2.tauri.app/plugin/single-instance/
- System tray: https://v2.tauri.app/learn/system-tray/
- Application command permissions: https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html
- Capabilities and IPC: https://v2.tauri.app/security/capabilities/

Icons are original geometric slider controls drawn locally, with no third-party logo assets. PNG/ICO/ICNS variants are included for native packaging.
