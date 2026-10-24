import { useCallback, useEffect, useRef, useState } from "react";
import TitleBar from "./TitleBar";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { messages } from "./i18n";
import type { ConfigView, Settings, HistoryEntry, Language } from "./types";
import "./styles.css";
const empty: ConfigView = {
  exists: false,
  base_url: "",
  model: "",
  key_present: false,
  encrypted: true,
  revision: "missing",
};
type Page = "config" | "history" | "settings";
function safeEditorView(value: ConfigView): ConfigView {
  return value.key_present ? value : { ...value, encrypted: true };
}
/// `isTauri()` reports the `window.isTauri` marker, which a host can set while the
/// IPC bridge itself is missing. Require the bridge before treating the app as native,
/// otherwise every command throws instead of showing the desktop-only screen.
function hasNativeBridge() {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }
  ).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}
/// A field that only contains whitespace or invisible format characters is blank,
/// even though `String.prototype.trim` keeps zero-width characters.
function isBlank(value: string) {
  return !value.replace(/[\s​-‍﻿]/g, "");
}
/// Committed-but-unfinished saves. Every other failure is rejected before the file is
/// replaced (documented per code in crates/core/src/lib.rs), so the draft is safe to keep.
const UNCERTAIN_CODES = new Set(["history_pending", "commit_uncertain"]);
function codeOf(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code).toLowerCase()
    : "";
}
/// Field names that always hide their value, including non-contract names a
/// hand-edited sidecar may contain ("credential", "auth_header", "pass"+"word").
const SENSITIVE_FIELD = /key|secret|token|credential|auth|pass|bearer/i;
/// Credential material can arrive through a non-secret field (a key pasted into the
/// model or a token in a URL path). The history page promises "keys are never
/// displayed", so scrub values that look like credentials before rendering them.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(sk|rk|pk|ghp|gho|ghs|ghu|glpat|xox[abprs]|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // Opaque runs that mix case and digits (hex/base32/base64url API keys) but carry
  // no spaces or separators. Short model ids and words never reach this length.
  /\b(?=[A-Za-z0-9_~+=-]*\d)(?=[A-Za-z0-9_~+=-]*[A-Za-z])[A-Za-z0-9_~+=-]{28,}\b/g,
];
function scrubValue(value: string) {
  let out = value.replace(
    /(:\/\/)([^/@\s]+)@/g,
    (_match, scheme: string) => `${scheme}[REDACTED]@`,
  );
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
/// Normalize an unauthenticated sidecar payload: a malformed entry must degrade to a
/// visible error, never to a render crash that unmounts the whole app.
function normalizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) throw { code: "IO" };
  const text = (input: unknown, fallback = "") =>
    typeof input === "string" ? input : input == null ? fallback : String(input);
  return value.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const diff = Array.isArray(entry.diff) ? entry.diff : [];
    return {
      id: text(entry.id, `entry-${index}`),
      timestamp: text(entry.timestamp),
      sha256: text(entry.sha256),
      source: text(entry.source),
      diff: diff
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          field: text(item.field),
          before: typeof item.before === "string" ? item.before : null,
          after: typeof item.after === "string" ? item.after : null,
        })),
    };
  });
}
export default function App() {
  const [page, setPage] = useState<Page>("config"),
    [language, setLanguage] = useState<Language>("zh");
  const [config, setConfig] = useState<ConfigView | null>(null),
    [draft, setDraft] = useState(empty),
    [key, setKey] = useState("");
  // True when the file changed under an unsaved, conflicting draft. Saving would
  // overwrite an external edit the user has not seen, so reload/discard is required.
  const [configStale, setConfigStale] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null),
    [settingsBase, setSettingsBase] = useState<Settings | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false),
    [settingsUncertain, setSettingsUncertain] = useState(false);
  const settingsLoading = useRef(false);
  const historyLoading = useRef(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]),
    [busy, setBusy] = useState(false),
    [historyBusy, setHistoryBusy] = useState(false),
    [status, setStatus] = useState(""),
    [failed, setFailed] = useState(false),
    [settingsError, setSettingsError] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
  } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmationPending = useRef<((value: boolean) => void) | null>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  function confirm(message: string) {
    if (confirmationPending.current) return Promise.resolve(false);
    confirmationTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise<boolean>((resolve) => {
      confirmationPending.current = resolve;
      setConfirmation({ message });
    });
  }
  function resolveConfirmation(value: boolean) {
    const resolve = confirmationPending.current;
    confirmationPending.current = null;
    dialogRef.current?.close();
    setConfirmation(null);
    resolve?.(value);
  }
  useEffect(() => {
    if (!confirmation) return;
    dialogRef.current?.showModal();
    const trigger = confirmationTrigger.current;
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [confirmation]);
  const t = messages[language],
    supported = isTauri() && hasNativeBridge();
  const configDirty =
    !!config &&
    (draft.base_url !== config.base_url ||
      draft.model !== config.model ||
      draft.encrypted !== config.encrypted ||
      !!key.trim());
  const settingsDirty =
    !!settings &&
    !!settingsBase &&
    (settings.silent_start !== settingsBase.silent_start ||
      settings.close_to_tray !== settingsBase.close_to_tray ||
      settings.language !== settingsBase.language);
  const dirty = configDirty || settingsDirty;
  const uiBusy = busy || settingsBusy;
  function notice(message: string, error = false) {
    setStatus(message);
    setFailed(error);
  }
  function errorText(error: unknown) {
    const code = codeOf(error);
    const specific: Record<string, string> = {
      io: t.ioError,
      lock_timeout: t.lockError,
      unsafe_path: t.unsafePath,
      too_large: t.tooLarge,
      encrypt_failed: t.encryptError,
      invalid_url: t.urlInvalid,
      invalid_model: t.invalidModel,
      invalid_key: t.invalidKey,
      invalid_config: t.invalidError,
      tray_unavailable: t.trayWarning,
      tray_menu: t.settingsTraySync,
    };
    if (specific[code]) return specific[code];
    return code === "commit_uncertain"
      ? t.commitUncertain
      : code === "key_missing"
        ? t.keyMissing
        : code.includes("vault")
          ? t.vaultError
          : code.includes("history")
            ? t.historyError
            : code.includes("invalid_url")
              ? t.urlInvalid
              : code.includes("invalid")
                ? t.invalidError
                : code.includes("decrypt") || code.includes("credential")
                  ? t.decryptError
                  : code.includes("conflict")
                    ? t.conflictError
                    : t.error;
  }
  function restore() {
    if (config) setDraft(config);
    setKey("");
    setConfigStale(false);
    if (settingsBase) {
      setSettings(settingsBase);
      setLanguage(settingsBase.language);
    }
  }
  async function navigate(next: Page) {
    if (next === page || uiBusy || historyBusy || confirmationPending.current) return;
    if (dirty && !(await confirm(t.dirtyPrompt))) return;
    restore();
    setPage(next);
    notice("");
    if (next === "history") void loadHistory();
  }
  async function loadConfig() {
    setBusy(true);
    setKey("");
    notice(t.loading);
    try {
      const loaded = await invoke<ConfigView>("config_read");
      const value = loaded.key_present
        ? loaded
        : { ...loaded, encrypted: true };
      setConfig(value);
      setDraft(value);
      setKey("");
      notice(value.exists ? "" : t.empty);
      setConfigStale(false);
    } catch (error) {
      // Nothing is known about the file any more: never present the previous
      // snapshot as if it were the current configuration.
      setConfig(null);
      setDraft(empty);
      setKey("");
      setConfigStale(false);
      notice(`${errorText(error)} ${t.loadFailure}`, true);
    } finally {
      setBusy(false);
    }
  }
  async function loadSettings(clearStatus = false) {
    if (settingsLoading.current) return;
    settingsLoading.current = true;
    setSettingsBusy(true);
    setSettingsError(false);
    // A read the user asked for must be announced: the settings card renders a
    // loading state, and the shared live region reports the same progress.
    if (clearStatus) notice(t.loading);
    try {
      const value = await invoke<Settings>("settings_read");
      setSettings(value);
      setSettingsBase(value);
      setLanguage(value.language);
      setSettingsUncertain(false);
      // Clear the progress notice once the read the user asked for has settled.
      if (clearStatus) notice("");
    } catch {
      setSettingsError(true);
    } finally {
      settingsLoading.current = false;
      setSettingsBusy(false);
    }
  }
  async function loadHistory() {
    // One gesture, one read: the button is disabled while busy, but a double click
    // or an event replay can still dispatch twice, and overlapping reads are unordered.
    if (historyLoading.current) return;
    historyLoading.current = true;
    setHistoryBusy(true);
    setHistory([]);
    notice(t.loading);
    try {
      const entries = normalizeHistory(await invoke<unknown>("history_list"));
      setHistory(entries);
      notice(entries.length ? t.historyLoadedCount(entries.length) : t.historyLoaded);
    } catch (error) {
      const code = codeOf(error);
      // `TOO_LARGE` here is about the history sidecar, not the configuration file.
      notice(code === "too_large" ? t.historyTooLarge : errorText(error), true);
    } finally {
      historyLoading.current = false;
      setHistoryBusy(false);
    }
  }
  useEffect(() => {
    if (supported) {
      void loadConfig();
      void loadSettings();
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  useEffect(() => {
    if (!supported) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    // `listen` can also throw synchronously when the IPC bridge is gone; the
    // subscription is a convenience, never a reason to unmount the app.
    try {
      void listen<string>("navigate", (event) => {
        if (event.payload === "settings") void navigateRef.current("settings");
      })
        .then((fn) => {
          if (stopped) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      /* no menu event channel available */
    }
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [supported]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!config || uiBusy || configStale) return;
    // The API key is the one field where a stray byte silently breaks the credential,
    // so normalize it exactly like the other two fields before validating or sending it.
    const secret = key.trim();
    if (
      isBlank(draft.base_url) ||
      isBlank(draft.model) ||
      (!config.key_present && isBlank(secret))
    ) {
      notice(t.required, true);
      return;
    }
    try {
      const url = new URL(draft.base_url.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
    } catch {
      notice(t.urlInvalid, true);
      return;
    }
    setBusy(true);
    setConfigSaving(true);
    notice(t.saving);
    try {
      const value = await invoke<ConfigView>("config_save", {
        request: {
          base_url: draft.base_url.trim(),
          model: draft.model.trim(),
          api_key: secret || null,
          encrypt: draft.encrypted,
          expected_revision: config.revision,
        },
      });
      setConfig(value);
      setDraft(value);
      setKey("");
      notice(t.saved);
    } catch (error) {
      const code = codeOf(error);
      if (code === "history_pending") {
        // The config write committed; never retry with a stale revision or retain the submitted secret.
        setKey("");
        notice(t.historyPending, true);
        try {
          const actual = safeEditorView(
            await invoke<ConfigView>("config_read"),
          );
          setConfig(actual);
          setDraft(actual);
          setConfigStale(false);
        } catch {
          setConfig(null);
          notice(`${t.historyPending} ${t.reloadRequired}`, true);
        }
      } else if (UNCERTAIN_CODES.has(code)) {
        // The outcome is unknown: adopt disk truth if it differs, otherwise keep the draft.
        notice(errorText(error), true);
        try {
          const actual = safeEditorView(
            await invoke<ConfigView>("config_read"),
          );
          if (actual.revision !== config.revision) {
            setKey("");
            setConfig(actual);
            setDraft(actual);
            setConfigStale(false);
            notice(t.configReconciled, true);
          }
        } catch {
          setKey("");
          setConfig(null);
          notice(`${errorText(error)} ${t.reloadRequired}`, true);
        }
      } else {
        // Every other code is rejected before the file is replaced. Keep the draft and
        // the typed key, and refresh only the saved baseline so the next attempt uses a
        // live revision instead of a stale one.
        notice(errorText(error), true);
        try {
          const actual = safeEditorView(
            await invoke<ConfigView>("config_read"),
          );
          setConfig(actual);
          setConfigStale(actual.revision !== config.revision);
        } catch {
          // Keep the draft: a failed read does not prove the save was rejected, but the
          // notification above already says the operation failed.
        }
      }
    } finally {
      setBusy(false);
      setConfigSaving(false);
    }
  }
  async function check() {
    if (uiBusy || configStale || !config?.key_present) return;
    setBusy(true);
    notice(t.checking);
    try {
      await invoke("config_check");
      notice(t.checked);
    } catch (error) {
      notice(errorText(error), true);
    } finally {
      setBusy(false);
    }
  }
  async function saveSettings() {
    if (!settings || uiBusy || settingsUncertain) return;
    setBusy(true);
    notice(t.saving);
    try {
      const value = await invoke<Settings>("settings_save", {
        settings: {
          silent_start: settings.silent_start,
          close_to_tray: settings.close_to_tray,
          language: settings.language,
        },
      });
      setSettings(value);
      setSettingsBase(value);
      setLanguage(value.language);
      setSettingsUncertain(false);
      const durabilityUncertain = value.warnings?.some((warning) =>
        warning.startsWith("SETTINGS_DURABILITY_UNCERTAIN"),
      );
      notice(
        durabilityUncertain
          ? messages[value.language].settingsDurability
          : messages[value.language].settingsSaved,
        !!durabilityUncertain,
      );
    } catch (error) {
      // The preferences were committed before only the tray integration can fail.
      // `TRAY_MENU` therefore means "saved, tray stale"; `SETTINGS_SAVE` and
      // `SETTINGS_LOCK` prove nothing was replaced. Only unknown codes are genuinely
      // uncertain, so the copy must not claim a possible write for a definite failure.
      const code = codeOf(error);
      if (code === "tray_menu") {
        try {
          const actual = await invoke<Settings>("settings_read");
          setSettings(actual);
          setSettingsBase(actual);
          setLanguage(actual.language);
          setSettingsUncertain(false);
        } catch {
          setSettingsUncertain(true);
        }
        notice(t.settingsTraySync, true);
        return;
      }
      if (code === "settings_save" || code === "settings_lock") {
        notice(t.settingsSaveFailed, true);
        try {
          const actual = await invoke<Settings>("settings_read");
          setSettingsBase(actual);
        } catch {
          // Keep the draft; the failure above is already definitive about the write.
        }
        return;
      }
      // Unknown outcome: reconcile disk truth but preserve the user's editable values.
      notice(t.settingsUncertain, true);
      try {
        const actual = await invoke<Settings>("settings_read");
        setSettingsBase(actual);
        setSettings((current) =>
          current
            ? {
                ...actual,
                silent_start: current.silent_start,
                close_to_tray: current.close_to_tray,
                language: current.language,
              }
            : actual,
        );
      } catch {
        setSettingsUncertain(true);
        notice(`${t.settingsUncertain} ${t.reloadRequired}`, true);
      }
    } finally {
      setBusy(false);
    }
  }
  async function toggleAuto(enabled: boolean) {
    if (!settings || uiBusy) return;
    setBusy(true);
    try {
      const actual = await invoke<boolean>("autostart_set", { enabled });
      const update = (s: Settings | null) =>
        s
          ? {
              ...s,
              autostart: actual,
              autostart_known: true,
              warnings: s.warnings?.filter(
                (warning) => !warning.startsWith("AUTOSTART_UNKNOWN"),
              ),
            }
          : s;
      setSettings(update);
      setSettingsBase(update);
      notice(
        actual === enabled ? t.autoSaved : t.autoFailure,
        actual !== enabled,
      );
    } catch {
      // A failed post-write query does not prove the OS mutation was rolled back.
      // Record the unknown state as a warning too, so the banner still explains
      // it when the follow-up reconciliation read also fails.
      const unknown = (s: Settings | null) =>
        s
          ? {
              ...s,
              autostart_known: false,
              warnings: [
                ...new Set([
                  ...(s.warnings ?? []),
                  "AUTOSTART_UNKNOWN: The launch-at-login state could not be confirmed.",
                ]),
              ],
            }
          : s;
      setSettings(unknown);
      setSettingsBase(unknown);
      notice(t.autoFailure, true);
      try {
        const actual = await invoke<Settings>("settings_read");
        const update = (s: Settings | null) =>
          s
            ? {
                ...s,
                autostart: actual.autostart,
                autostart_known: actual.autostart_known,
                warnings: actual.warnings,
              }
            : s;
        setSettings(update);
        setSettingsBase(update);
      } catch {
        // Remain explicitly unknown if reconciliation is unavailable.
      }
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (uiBusy || confirmationPending.current) return;
    if (configDirty && !(await confirm(t.dirtyPrompt))) return;
    void loadConfig();
  }
  function historyValue(field: string, value: string | null) {
    // `[EMPTY]` is the backend's "there was no value" sentinel for every field, and
    // `[VALUE EXCEEDS LIMIT]` means the old value was too large to journal.
    if (SENSITIVE_FIELD.test(field)) {
      // A sensitive field reveals nothing beyond "there was no value".
      return value === "[EMPTY]" || value === "" ? t.removed : t.keyRedacted;
    }
    if (value === null || value === "" || value === "[EMPTY]") return t.removed;
    if (value === "[VALUE EXCEEDS LIMIT]") return t.tooLongValue;
    if (field === "encrypted") return value === "true" ? t.on : t.off;
    return scrubValue(value);
  }
  /// Contract fields are protocol tokens; the history card shows user-facing names.
  function historyField(field: string) {
    const labels: Record<string, string> = {
      base_url: t.fieldBaseUrl,
      model: t.fieldModel,
      encrypted: t.fieldEncrypted,
      api_key: t.fieldKey,
    };
    return labels[field] ?? field;
  }
  const toggle = (
    label: string,
    help: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    disabled = false,
    unknown = false,
  ) => (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{help}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={uiBusy || disabled}
        data-unknown={unknown || undefined}
      />
    </label>
  );
  const windowError = useCallback(() => {
    setStatus(messages[language].windowError);
    setFailed(true);
  }, [language]);
  async function closeWindow() {
    if (dirty && !(await confirm(t.dirtyPrompt))) return;
    void invoke("window_control", { action: "close" }).catch(windowError);
  }
  if (!supported)
    return (
      <main className="unsupported">
        <div className="logo">◈</div>
        <h1>{t.unsupported}</h1>
        <p>{t.unsupportedHelp}</p>
      </main>
    );
  return (
    <div className="app">
      <TitleBar language={language} onClose={() => void closeWindow()} onError={windowError} />
      <aside>
        <div className="branding">
          <div className="logo" aria-hidden="true">
            ◈
          </div>
          <div>
            <strong>{t.brand}</strong>
            <small>{t.tagline}</small>
          </div>
        </div>
        <nav aria-label={t.brand}>
          {(["config", "history", "settings"] as Page[]).map((p, index) => (
            <button
              key={p}
              className={page === p ? "active" : ""}
              aria-current={page === p ? "page" : undefined}
              onClick={() => navigate(p)}
              disabled={uiBusy || historyBusy}
            >
              <span aria-hidden="true">{["⚙", "↺", "☷"][index]}</span>
              {t[p]}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" />
          {t.local}
        </div>
      </aside>
      <div className="content-scroll">
      <main>
        <header>
          <div className="eyebrow">{t[page]}</div>
          <h1>
            {page === "config"
              ? t.configTitle
              : page === "history"
                ? t.historyTitle
                : t.settingsTitle}
          </h1>
          <p>
            {page === "config"
              ? t.configIntro
              : page === "history"
                ? t.historyIntro
                : t.settingsIntro}
          </p>
        </header>
        <div
          className={`status ${failed ? "error" : ""}`}
          role={failed ? "alert" : "status"}
          aria-live={failed ? "assertive" : "polite"}
        >
          {status}
        </div>
        {page === "config" && (
          <>
            <section className="card">
              <div className="card-top">
                <h2>{t.config}</h2>
                {config && (
                  <span className={`badge ${!draft.encrypted ? "warning" : ""}`}>
                    {configStale || configDirty
                      ? t.unsaved
                      : config.key_present
                        ? draft.encrypted
                          ? t.protected
                          : t.plaintext
                        : t.noKey}
                  </span>
                )}
              </div>
              {/* The app owns URL validation (`save()` reports t.urlInvalid through the
                  live region). Native `type=url` constraint validation would otherwise
                  swallow the submit event and show an untranslated browser bubble. */}
              <form onSubmit={save} noValidate>
                <fieldset disabled={uiBusy || !config}>
                  <label htmlFor="base-url">{t.baseUrl}</label>
                  <input
                    id="base-url"
                    type="url"
                    value={draft.base_url}
                    onChange={(e) =>
                      setDraft({ ...draft, base_url: e.target.value })
                    }
                    aria-describedby="base-help"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small id="base-help">{t.baseHelp}</small>
                  <label htmlFor="api-key">{t.key}</label>
                  <input
                    id="api-key"
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="new-password"
                    aria-describedby="key-help"
                    spellCheck={false}
                  />
                  <small id="key-help">
                    {config?.key_present ? t.keySaved : t.keyNew}
                  </small>
                  <label htmlFor="model">{t.model}</label>
                  <input
                    id="model"
                    value={draft.model}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value })
                    }
                    aria-describedby="model-help"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small id="model-help">{t.modelHelp}</small>
                  {toggle(
                    t.encrypt,
                    t.encryptHelp,
                    draft.encrypted,
                    async (checked) => {
                      if (!checked && !(await confirm(t.plainPrompt))) return;
                      setDraft({ ...draft, encrypted: checked });
                    },
                  )}
                </fieldset>
                <div className="actions">
                  <button
                    ref={saveRef}
                    className="primary"
                    type="submit"
                    disabled={uiBusy || !config || configStale}
                  >
                    {configSaving ? t.saving : t.save}
                  </button>
                  <button type="button" onClick={reload} disabled={uiBusy}>
                    {t.reload}
                  </button>
                  <button
                    type="button"
                    disabled={(!configDirty && !configStale) || uiBusy}
                    onClick={async () => {
                      if (await confirm(t.dirtyPrompt)) {
                        setDraft(config!);
                        setKey("");
                        setConfigStale(false);
                        notice("");
                        // The trigger disappears from the tab order once the draft is
                        // clean, so hand focus to a control that still exists.
                        saveRef.current?.focus();
                      }
                    }}
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="button"
                    onClick={() => void check()}
                    disabled={uiBusy || !config?.key_present || configStale}
                  >
                    {t.check}
                  </button>
                </div>
              </form>
            </section>
            <section className="note">
              <strong>{t.security}</strong>
              <p>{t.securityHelp}</p>
            </section>
          </>
        )}
        {page === "history" && (
          <section
            aria-label={t.history}
            aria-busy={historyBusy}
            aria-live="off"
            className="history-section"
          >
            <div className="section-actions">
              <button onClick={() => void loadHistory()} disabled={historyBusy}>
                {historyBusy ? t.loading : t.refresh}
              </button>
            </div>
            {!historyBusy && history.length === 0 && !failed && (
              <div className="card empty">
                <span aria-hidden="true">↺</span>
                <h2>{t.noHistory}</h2>
                <p>{t.noHistoryHelp}</p>
              </div>
            )}
            <ul className="history-list" role="list">
              {history.map((entry, index) => (
                <li key={`${entry.id}-${index}`}>
              <article
                className="card history-entry"
                aria-label={`${entry.timestamp || t.noHistory} · ${t.source}: ${entry.source}`}
              >
                <div className="card-top">
                  <time dateTime={entry.timestamp || undefined}>
                    {entry.timestamp}
                  </time>
                  <span className="badge">
                    {t.source}: {entry.source}
                  </span>
                </div>
                {entry.diff.length === 0 && (
                  <p className="diff-empty">{t.noFieldChanges}</p>
                )}
                {entry.diff.map((diff, i) => (
                  <div className="diff" key={`${diff.field}-${i}`}>
                    <strong data-field={diff.field}>{historyField(diff.field)}</strong>
                    <div>
                      <span>{t.before}</span>
                      <code>
                        {historyValue(diff.field, diff.before)}
                      </code>
                    </div>
                    <div>
                      <span>{t.after}</span>
                      <code>
                        {historyValue(diff.field, diff.after)}
                      </code>
                    </div>
                  </div>
                ))}
                <div className="digest">
                  <small>{t.digest}</small>
                  <code>{entry.sha256}</code>
                </div>
              </article>
                </li>
              ))}
            </ul>
          </section>
        )}
        {page === "settings" && (
          <>
            {settingsError ? (
              <div className="card">
                <p role="alert">{t.settingsFailure}</p>
                <button onClick={() => void loadSettings(true)} disabled={uiBusy}>
                  {t.reload}
                </button>
              </div>
            ) : !settings ? (
              <p role="status">{t.loading}</p>
            ) : (
              <>
                <section className="card settings-card" aria-label={t.settings}>
                  <div className="card-top">
                    <h2>{t.settings}</h2>
                    {settingsDirty && <span className="badge warning">{t.unsaved}</span>}
                  </div>
                  {settingsUncertain && (
                    <p className="system-warning" role="status">
                      {t.settingsUncertain}
                    </p>
                  )}
                  <label htmlFor="language">{t.language}</label>
                  <select
                    id="language"
                    value={settings.language}
                    disabled={uiBusy}
                    onChange={(e) => {
                      const value = e.target.value as Language;
                      setSettings({ ...settings, language: value });
                      setLanguage(value);
                      // Keep the reason Save is disabled; only clear a resolved notice.
                      if (!settingsUncertain) notice("");
                    }}
                  >
                    <option value="zh">{t.chinese}</option>
                    <option value="en">{t.english}</option>
                  </select>
                  {toggle(
                    t.silent,
                    t.silentHelp,
                    settings.silent_start,
                    (value) => {
                      setSettings({ ...settings, silent_start: value });
                      // A new edit makes any previous "saved" confirmation stale.
                      if (!settingsUncertain) notice("");
                    },
                    !settings.tray_available,
                  )}
                  {toggle(
                    t.tray,
                    t.trayHelp,
                    settings.close_to_tray,
                    (value) => {
                      setSettings({ ...settings, close_to_tray: value });
                      if (!settingsUncertain) notice("");
                    },
                    !settings.tray_available,
                  )}
                  {toggle(
                    t.auto,
                    settings.autostart_known === false ? t.unknown : t.autoHelp,
                    settings.autostart,
                    (value) => void toggleAuto(value),
                    // An unconfirmed OS state must not read as a definite "off" switch,
                    // but the switch stays usable so the user can set it explicitly.
                    false,
                    settings.autostart_known === false,
                  )}
                  {!!settings.warnings?.length && (
                    <p className="system-warning" role="alert">
                      {[
                        ...new Set(
                          settings.warnings!.map((warning) =>
                            warning.startsWith("SETTINGS_DURABILITY_UNCERTAIN")
                              ? t.settingsDurability
                              : warning.startsWith("TRAY_UNAVAILABLE")
                                ? t.trayWarning
                                : warning.startsWith("AUTOSTART_UNKNOWN")
                                  ? t.autoWarning
                                  : warning.startsWith("SETTINGS_INVALID")
                                    ? t.settingsInvalid
                                    : warning.startsWith("SETTINGS_UNREADABLE")
                                      ? t.settingsUnreadable
                                      : warning.startsWith("TRAY_MENU_STALE")
                                        ? t.settingsTraySync
                                        : t.warning,
                          ),
                        ),
                      ].join(" ")}
                    </p>
                  )}
                  <div className="actions">
                    <button
                      className="primary"
                      onClick={() => void saveSettings()}
                      disabled={uiBusy || settingsUncertain}
                    >
                      {t.saveSettings}
                    </button>
                    <button
                      disabled={uiBusy}
                      onClick={async () => {
                        if (!settingsDirty || (await confirm(t.dirtyPrompt)))
                          await loadSettings(true);
                      }}
                    >
                      {t.reload}
                    </button>
                    <button
                      onClick={async () => {
                        if (!settingsDirty || (await confirm(t.dirtyPrompt))) {
                          setSettings(settingsBase);
                          setLanguage(settingsBase!.language);
                          notice("");
                        }
                      }}
                      disabled={uiBusy || !settingsDirty}
                    >
                      {t.cancel}
                    </button>
                    {settings.tray_available && (
                      <button
                        onClick={() => {
                          void invoke("window_hide")
                            .then(() => notice(""))
                            .catch((error) => notice(errorText(error), true));
                        }}
                        disabled={uiBusy}
                      >
                        {t.hide}
                      </button>
                    )}
                  </div>
                </section>
                <section className="card metadata" aria-label={t.version}>
                  <div>
                    <small>{t.version}</small>
                    <strong>{settings.version}</strong>
                  </div>
                  <div>
                    <small>{t.platform}</small>
                    <strong>{settings.platform}</strong>
                  </div>
                  <div>
                    <small>{t.trayAvailable}</small>
                    <strong>
                      {settings.tray_available ? t.available : t.unavailable}
                    </strong>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </main>
      </div>
      {confirmation && (
        <dialog
          ref={dialogRef}
          onCancel={(event) => {
            event.preventDefault();
            resolveConfirmation(false);
          }}
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
        >
          <h2 id="confirm-title">{t.confirmTitle}</h2>
          <p id="confirm-message">{confirmation.message}</p>
          <div className="actions">
            <button autoFocus onClick={() => resolveConfirmation(false)}>
              {t.keep}
            </button>
            <button
              className="primary"
              onClick={() => resolveConfirmation(true)}
            >
              {t.continue}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
