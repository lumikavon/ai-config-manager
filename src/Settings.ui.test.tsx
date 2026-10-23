// Settings page UI verification: real DOM (jsdom) + synthetic IPC only.
// No disk, credential, autostart or network writes are performed by this file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { readFile } from "node:fs/promises";
import type { Settings } from "./types";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ipc);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const config = {
  exists: true,
  base_url: "https://review.example/v1",
  model: "review-model",
  key_present: true,
  encrypted: true,
  revision: "review-revision",
};
const initial: Settings = {
  silent_start: false,
  close_to_tray: true,
  language: "zh",
  autostart: false,
  autostart_known: true,
  tray_available: true,
  version: "0.1.0",
  platform: "windows",
  warnings: [],
};
const zh = {
  eyebrow: "设置",
  title: "按你的方式运行",
  intro: "启动行为、系统集成和界面语言。",
  language: "界面语言",
  save: "保存设置",
  reload: "重新加载",
  cancel: "取消更改",
  hide: "隐藏到托盘",
  silent: "静默启动",
  silentHelp: "启动时保留在后台，不显示主窗口。",
  tray: "关闭窗口后保留在托盘",
  trayHelp: "窗口关闭不退出应用，可从托盘重新打开。",
  auto: "开机启动",
  autoHelp: "登录系统后自动运行此应用。",
  unknown: "未知（无法读取系统状态）",
  settingsSaved: "设置已保存。",
  autoSaved: "开机启动状态已更新。",
  autoFailure:
    "无法确认开机启动变更。系统状态可能已改变，请检查系统设置。",
  settingsUncertain:
    "设置保存未完全确认，可能已写入磁盘，但系统集成未完成。请检查当前状态。",
  durability:
    "设置已更新，但无法确认已持久写入磁盘。请检查磁盘权限、空间并重新保存。",
  trayWarning:
    "系统托盘不可用，本次运行已停用静默启动、关闭到托盘和隐藏到托盘。",
  autoWarning: "无法读取系统开机启动状态，请检查系统登录项设置。",
  invalid:
    "设置文件格式无效或来自不支持的版本，当前使用默认设置。修复或移走该文件前无法保存设置。",
  unreadable:
    "无法读取设置文件，当前使用默认设置。恢复文件可读性前无法保存设置。",
  settingsSaveFailed: "设置保存失败，原有设置仍然生效。请检查磁盘权限和空间后重试。",
  settingsTraySync:
    "设置已保存，但托盘菜单未能刷新，托盘文字可能仍是旧语言，重启应用后恢复。",
  generic: "系统集成存在问题，请检查设置或系统权限。",
  ioError:
    "无法读写配置。请检查文件权限、磁盘空间及文件是否被其他程序占用。",
};

let actual: Settings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function count(command: string) {
  return ipc.invoke.mock.calls.filter(([name]) => name === command).length;
}

async function sync(command: string, args?: unknown) {
  if (command === "config_read") return structuredClone(config);
  if (command === "settings_read") return structuredClone(actual);
  if (command === "settings_save") {
    const request = args as { settings?: Partial<Settings> } | undefined;
    actual = { ...actual, ...request?.settings };
    return structuredClone(actual);
  }
  if (command === "autostart_set") {
    const request = args as { enabled?: boolean } | undefined;
    actual = {
      ...actual,
      autostart: !!request?.enabled,
      autostart_known: true,
    };
    return actual.autostart;
  }
  if (command === "history_list") return [];
  if (command === "window_hide") return;
  throw new Error(`Unexpected mock IPC: ${command}`);
}

async function enterSettings(language: "zh" | "en" = "zh") {
  const label = language === "zh" ? "设置" : "Settings";
  const nav = await screen.findByRole("button", { name: label });
  await waitFor(() => expect(nav).toBeEnabled());
  await userEvent.click(nav);
  await screen.findByLabelText(
    language === "zh" ? "界面语言" : "Interface language",
  );
}

async function ready(language: "zh" | "en" = "zh") {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
  await enterSettings(language);
}

async function switchLanguage(value: "zh" | "en") {
  const select = screen.getByLabelText(
    value === "en" ? "界面语言" : "Interface language",
  );
  await userEvent.selectOptions(select, value);
}

beforeEach(() => {
  actual = { ...initial, warnings: [] };
  ipc.isTauri.mockReturnValue(true);
  ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(sync);
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Settings page inventory", () => {
  it("renders the localized header, aria-current nav, language, switches, actions and metadata", async () => {
    await ready();

    expect(screen.getByText(zh.eyebrow, { selector: ".eyebrow" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: zh.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(zh.intro)).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "配置" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("button", { name: "历史记录" })).not.toHaveAttribute(
      "aria-current",
    );

    const select = screen.getByLabelText(zh.language);
    expect(select).toHaveAttribute("id", "language");
    expect(select).toHaveValue("zh");
    expect(within(select).getByRole("option", { name: "中文" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "English" })).toBeInTheDocument();

    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /关闭窗口后/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /开机启动/ })).not.toBeChecked();
    expect(screen.getByText(zh.silentHelp)).toBeInTheDocument();
    expect(screen.getByText(zh.trayHelp)).toBeInTheDocument();
    expect(screen.getByText(zh.autoHelp)).toBeInTheDocument();

    expect(screen.getByRole("button", { name: zh.save })).toBeEnabled();
    expect(screen.getByRole("button", { name: zh.reload })).toBeEnabled();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.hide })).toBeEnabled();
    expect(document.querySelector(".system-warning")).toBeNull();

    expect(screen.getByText("版本")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("平台")).toBeInTheDocument();
    expect(screen.getByText("windows")).toBeInTheDocument();
    expect(screen.getByText("托盘能力")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
  });

  it("renders the English shell and settings copy from the saved language", async () => {
    actual.language = "en";
    await ready("en");

    expect(
      screen.getByText("Settings", { selector: ".eyebrow" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Make it work your way" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Startup behavior, system integration, and interface language.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hide to tray" })).toBeEnabled();
    expect(
      screen.getByRole("switch", { name: /Start silently/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Keep running/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Launch at login/ }),
    ).not.toBeChecked();
    expect(screen.getByText("System tray")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("previews language immediately without saving and restores the saved language only after confirmed cancel", async () => {
    await ready();
    await switchLanguage("en");

    expect(
      screen.getByRole("heading", { level: 1, name: "Make it work your way" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Settings", { selector: ".eyebrow" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
    expect(screen.queryByText(zh.silentHelp)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Stay in the background at startup without showing a window.",
      ),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(count("settings_save")).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Discard your unsaved changes?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(count("settings_save")).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(screen.getByLabelText("界面语言")).toHaveValue("zh");
    expect(screen.getByRole("button", { name: "取消更改" })).toBeDisabled();
    expect(count("settings_save")).toBe(0);
  });

  it("restores an English saved baseline when a previewed Chinese language is cancelled", async () => {
    actual.language = "en";
    await ready("en");

    await switchLanguage("zh");
    expect(
      screen.getByRole("heading", { level: 1, name: "按你的方式运行" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消更改" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Interface language")).toHaveValue("en"),
    );
    expect(document.documentElement.lang).toBe("en");
    expect(count("settings_save")).toBe(0);
  });

  it("binds silent and close-to-tray switches to settings, leaves them editable and tracks dirtiness", async () => {
    actual.silent_start = true;
    actual.close_to_tray = false;
    await ready();

    const silent = screen.getByRole("switch", { name: /静默启动/ });
    const tray = screen.getByRole("switch", { name: /关闭窗口后/ });
    expect(silent).toBeChecked();
    expect(tray).not.toBeChecked();
    expect(screen.getByText(zh.silentHelp)).toBeInTheDocument();
    expect(screen.getByText(zh.trayHelp)).toBeInTheDocument();

    await userEvent.click(silent);
    expect(silent).not.toBeChecked();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeEnabled();
    expect(count("settings_save")).toBe(0);

    await userEvent.click(tray);
    expect(tray).toBeChecked();
    await userEvent.click(silent);
    expect(silent).toBeChecked();
  });

  it("disables silent/tray controls and hides the tray action when the native tray is unavailable", async () => {
    actual.tray_available = false;
    actual.warnings = ["TRAY_UNAVAILABLE: private-backend-detail"];
    await ready();

    const silent = screen.getByRole("switch", { name: /静默启动/ });
    const tray = screen.getByRole("switch", { name: /关闭窗口后/ });
    expect(silent).toBeDisabled();
    expect(tray).toBeDisabled();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: zh.hide })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.save })).toBeEnabled();

    const warning = document.querySelector(".system-warning");
    expect(warning).toHaveClass("system-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(zh.trayWarning);
    expect(screen.queryByText(/private-backend-detail/)).not.toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
  });

  it("saves exactly the three preference fields and reports success in the saved language", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("switch", { name: /关闭窗口后/ }));
    await switchLanguage("en");

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");

    expect(ipc.invoke).toHaveBeenCalledWith("settings_save", {
      settings: {
        silent_start: true,
        close_to_tray: false,
        language: "en",
      },
    });
    expect(count("settings_save")).toBe(1);
    expect(count("autostart_set")).toBe(0);
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Start silently/ })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Keep running/ }),
    ).not.toBeChecked();
    expect(document.documentElement.lang).toBe("en");
    expect(actual).toMatchObject({
      silent_start: true,
      close_to_tray: false,
      language: "en",
    });
  });

  it("preserves the draft after a failed save, then succeeds on retry", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      .mockRejectedValueOnce({ code: "SETTINGS_SAVE", message: "private" })
      .mockResolvedValueOnce(structuredClone(actual));

    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    // SETUI-10 fixed: a definite write failure is reported as failed, not as a
    // possible commit, while the draft is preserved for a retry.
    await screen.findByText(zh.settingsSaveFailed);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(zh.settingsUncertain)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeEnabled();
    expect(screen.getByRole("button", { name: zh.save })).toBeEnabled();
    expect(actual.silent_start).toBe(false);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findByText(zh.settingsSaved);
    expect(actual.silent_start).toBe(true);
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
  });

  it("blocks blind resubmission when both save and reconciliation fail, then recovers through reload", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      // An unrecognized outcome is the only genuinely uncertain case.
      .mockRejectedValueOnce({ code: "SETTINGS_UNKNOWN_OUTCOME" })
      .mockRejectedValueOnce({ code: "SETTINGS_LOCK" });

    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findByText(
      `${zh.settingsUncertain} 当前状态无法读取，请重新加载后再操作。`,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("当前状态无法读取");
    expect(screen.getByRole("button", { name: zh.save })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.reload })).toBeEnabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: zh.save })).toBeEnabled(),
    );
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
  });

  it("does not claim a full save when durability is uncertain", async () => {
    actual.warnings = ["SETTINGS_DURABILITY_UNCERTAIN: private"];
    await ready();
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      zh.durability,
    );

    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findAllByText(zh.durability);

    expect(screen.queryByText(zh.settingsSaved)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByText(zh.durability)).toHaveLength(2);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.save })).toBeEnabled();
  });

  it("toggles launch-at-login immediately, outside Save, and shows success", async () => {
    await ready();
    const auto = screen.getByRole("switch", { name: /开机启动/ });
    expect(auto).not.toBeChecked();
    expect(screen.getByText(zh.autoHelp)).toBeInTheDocument();

    await userEvent.click(auto);
    await screen.findByText(zh.autoSaved);
    expect(ipc.invoke).toHaveBeenCalledWith("autostart_set", { enabled: true });
    expect(count("autostart_set")).toBe(1);
    expect(count("settings_save")).toBe(0);
    expect(auto).toBeChecked();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
    expect(actual.autostart).toBe(true);
  });

  it("shows the unknown autostart helper and clears only the obsolete autostart warning on success", async () => {
    actual.autostart_known = false;
    actual.warnings = ["AUTOSTART_UNKNOWN: private detail"];
    await ready();

    expect(screen.getByText(zh.unknown)).toBeInTheDocument();
    expect(document.querySelector(".system-warning")).toHaveTextContent(zh.autoWarning);
    expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(zh.autoSaved);
    expect(screen.queryByText(zh.unknown)).not.toBeInTheDocument();
    expect(screen.getByText(zh.autoHelp)).toBeInTheDocument();
    expect(document.querySelector(".system-warning")).toBeNull();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
  });

  it("reports autostart failure safely and reconciles the OS state", async () => {
    await ready();
    ipc.invoke.mockRejectedValueOnce({
      code: "AUTOSTART_UPDATE",
      message: "private-native-detail",
    });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));

    await screen.findByText(zh.autoFailure);
    expect(document.querySelector(".status")).toHaveTextContent(zh.autoFailure);
    // Reconciliation succeeded, so the state is known again and no persistent
    // warning is left behind.
    expect(document.querySelector(".system-warning")).toBeNull();
    expect(screen.getByRole("switch", { name: /开机启动/ })).not.toBeChecked();
    expect(count("autostart_set")).toBe(1);
    expect(count("settings_save")).toBe(0);
    expect(count("settings_read")).toBe(2);
    expect(screen.queryByText(/private-native-detail/)).not.toBeInTheDocument();
  });

  it("keeps autostart explicitly unknown when both mutation and reconciliation fail", async () => {
    await ready();
    ipc.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_UPDATE" })
      .mockRejectedValueOnce({ code: "AUTOSTART_QUERY" });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));

    await screen.findByText(zh.autoFailure);
    expect(screen.getByText(zh.unknown)).toBeInTheDocument();
    expect(document.querySelector(".status")).toHaveTextContent(zh.autoFailure);
    // SET-08 fixed: with no readable OS state, the banner keeps explaining it.
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      zh.autoWarning,
    );
    expect(screen.getByRole("switch", { name: /开机启动/ })).not.toBeChecked();
  });

  it("keeps an immediate autostart change when unsaved preference edits are discarded", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(zh.autoSaved);

    await userEvent.click(screen.getByRole("button", { name: zh.cancel }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    expect(count("autostart_set")).toBe(1);
    expect(count("settings_save")).toBe(0);
  });

  it("localizes, de-duplicates and falls back for warning prefixes; hides the banner when empty", async () => {
    actual.autostart_known = false;
    actual.warnings = [
      "TRAY_UNAVAILABLE: raw-tray-one",
      "TRAY_UNAVAILABLE: raw-tray-two",
      "AUTOSTART_UNKNOWN: raw-auto",
      "SETTINGS_INVALID: raw-invalid",
      "SETTINGS_UNREADABLE: raw-unreadable",
      "SETTINGS_DURABILITY_UNCERTAIN: raw-durability",
      "SOMETHING_NEW: raw-unknown",
    ];
    await ready();

    const banner = document.querySelector(".system-warning");
    expect(banner).toHaveAttribute("role", "alert");
    const text = banner?.textContent ?? "";
    expect(text).toContain(zh.trayWarning);
    expect(text).toContain(zh.autoWarning);
    expect(text).toContain(zh.invalid);
    expect(text).toContain(zh.unreadable);
    expect(text).toContain(zh.durability);
    expect(text).toContain(zh.generic);
    expect(text.match(/系统托盘不可用/g)).toHaveLength(1);
    expect(screen.queryByText(/raw-/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    actual.warnings = [];
    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    await waitFor(() =>
      expect(document.querySelector(".system-warning")).toBeNull(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reloads clean preferences immediately and raises the discard confirmation when dirty", async () => {
    await ready();
    const reads = count("settings_read");
    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    await waitFor(() => expect(count("settings_read")).toBe(reads + 1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await switchLanguage("en");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Discard your unsaved changes?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(count("settings_read")).toBe(reads + 1);
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(count("settings_read")).toBe(reads + 2));
    await waitFor(() =>
      expect(screen.getByLabelText("界面语言")).toHaveValue("zh"),
    );
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
  });

  it("disables discard when clean and restores baseline values and language when confirmed", async () => {
    await ready();
    const discard = screen.getByRole("button", { name: zh.cancel });
    expect(discard).toBeDisabled();

    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("switch", { name: /关闭窗口后/ }));
    await switchLanguage("en");
    expect(
      screen.getByRole("button", { name: "Discard changes" }),
    ).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByRole("switch", { name: /Start silently/ })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Keep running/ }),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /关闭窗口后/ })).toBeChecked();
    expect(screen.getByLabelText("界面语言")).toHaveValue("zh");
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
  });

  it("guards navigation with the dirty dialog and keeps the page when declined", async () => {
    await ready();
    await switchLanguage("en");

    await userEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Discard your unsaved changes?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Make it work your way" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");

    await userEvent.click(screen.getByRole("button", { name: "Configuration" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "连接你的 AI 服务" });
    expect(screen.getByRole("button", { name: "配置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
  });

  it("invokes hide-to-tray and maps its failure without exposing backend text", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: zh.hide }));
    expect(ipc.invoke).toHaveBeenCalledWith("window_hide");

    ipc.invoke.mockRejectedValueOnce({
      code: "IO",
      message: "private-native-detail",
    });
    await userEvent.click(screen.getByRole("button", { name: zh.hide }));
    await screen.findByText(zh.ioError);
    expect(screen.getByRole("alert")).toHaveTextContent(zh.ioError);
    expect(screen.queryByText(/private-native-detail/)).not.toBeInTheDocument();
  });

  it("shows the loading state after a failed read and recovers through the reload button", async () => {
    const normal = ipc.invoke.getMockImplementation()!;
    let reads = 0;
    ipc.invoke.mockImplementation(
      async (command: string, args?: unknown) => {
        if (command === "settings_read" && reads++ === 0) {
          throw { code: "IO", message: "private-backend-detail" };
        }
        return normal(command, args);
      },
    );

    render(<App />);
    await screen.findByDisplayValue(config.base_url);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByText("无法读取设置，请重试。");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法读取设置，请重试。",
    );
    expect(
      screen.queryByRole("button", { name: zh.save }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.reload })).toBeEnabled();
    expect(screen.queryByText(/private-backend-detail/)).not.toBeInTheDocument();

    const pending = deferred<Settings>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    // Both the page-level loading node and the shared live region report progress,
    // and the control that started the read stays disabled until it settles.
    expect(screen.getAllByText("正在读取…").length).toBeGreaterThan(0);
    expect(document.querySelector(".status")).toHaveTextContent("正在读取…");
    expect(screen.queryByText("无法读取设置，请重试。")).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(structuredClone(actual));
      await pending.promise;
    });
    await screen.findByLabelText(zh.language);
    expect(screen.queryByText("正在读取…")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(count("settings_read")).toBe(2);
  });

  it("disables every settings control and navigation while a save is pending", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    const pending = deferred<Settings>();
    ipc.invoke.mockReturnValueOnce(pending.promise);

    await userEvent.dblClick(screen.getByRole("button", { name: zh.save }));
    expect(count("settings_save")).toBe(1);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /关闭窗口后/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "历史记录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "设置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.save })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.reload })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
    expect(screen.getByRole("button", { name: zh.hide })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在保存…");

    actual = { ...actual, silent_start: true };
    await act(async () => {
      pending.resolve(structuredClone(actual));
      await pending.promise;
    });
    await screen.findByText(zh.settingsSaved);
    expect(screen.getByRole("button", { name: zh.save })).toBeEnabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByRole("button", { name: zh.cancel })).toBeDisabled();
  });

  it("associates labels and exposes the dialog title and safe default focus", async () => {
    await ready();
    const select = screen.getByLabelText(zh.language) as HTMLSelectElement;
    expect(select.labels?.[0]).toHaveTextContent(zh.language);
    for (const [name, help] of [
      [/静默启动/, zh.silentHelp],
      [/关闭窗口后/, zh.trayHelp],
      [/开机启动/, zh.autoHelp],
    ] as const) {
      const control = screen.getByRole("switch", { name }) as HTMLInputElement;
      expect(control).toHaveAttribute("role", "switch");
      expect(control.labels?.[0]).toHaveTextContent(help);
    }
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");

    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-labelledby", "confirm-title");
    expect(
      screen.getByRole("heading", { name: "请确认", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toHaveFocus();
    expect(dialog).toHaveTextContent("有未保存的更改，确定放弃吗？");
  });

  it("shows only the desktop-app fallback when Tauri is not available", async () => {
    ipc.isTauri.mockReturnValue(false);
    render(<App />);

    expect(screen.getByText("请在桌面应用中打开")).toBeInTheDocument();
    expect(screen.getByText(/需要 Tauri 原生后端/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});

describe("SETUI-02 — low-contrast helper/metadata/intro text", () => {
  const luminance = (hex: string) => {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  it("keeps the shipped secondary palette at or above WCAG AA", async () => {
    const css = await readFile("src/styles.css", "utf8");
    const token = (name: string) => {
      const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
      if (!match) throw new Error(`missing token --${name}`);
      return match[1];
    };
    // Secondary copy sits on the page (#f4f6f8) and card (#ffffff) surfaces.
    for (const name of ["muted", "nav", "accent-text"]) {
      expect(contrast(token(name), "#f4f6f8")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(name), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token("badge-text"), "#edf6f1")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("warn-text"), "#fff1dd")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("warn-text"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("SETUI-03 — language preview / navigation erases unresolved errors", () => {
  it("keeps the uncertainty explanation while Save is disabled", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      // Only an unrecognized outcome is genuinely uncertain now.
      .mockRejectedValueOnce({ code: "SETTINGS_UNKNOWN_OUTCOME" })
      .mockRejectedValueOnce({ code: "SETTINGS_LOCK" });
    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findByText(/当前状态无法读取/);
    await switchLanguage("en");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      "Settings were not fully confirmed",
    );
  });
});

describe("SETUI-04 — stale status after edits / successful hide", () => {
  it("clears 设置已保存。 as soon as a preference becomes dirty", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findByText(zh.settingsSaved);
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: zh.cancel })).toBeEnabled();
  });

  it("clears the previous hide error when the next hide succeeds", async () => {
    await ready();
    ipc.invoke.mockRejectedValueOnce({ code: "IO" });
    await userEvent.click(screen.getByRole("button", { name: zh.hide }));
    await screen.findByText(zh.ioError);
    await userEvent.click(screen.getByRole("button", { name: zh.hide }));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SETUI-05 — loading state is not announced", () => {
  it("announces a settings read through the shared live region", async () => {
    await ready();
    const pending = deferred<Settings>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: zh.reload }));
    // The read is in flight: the shared region reports progress and the control
    // that started it is disabled until the promise settles.
    expect(screen.getByRole("status")).toHaveTextContent("正在读取…");
    expect(screen.getByRole("button", { name: zh.reload })).toBeDisabled();
    await act(async () => {
      pending.resolve(structuredClone(actual));
      await pending.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: zh.reload })).toBeEnabled(),
    );
  });
});

describe("SETUI-06 — alert is overridden to polite", () => {
  it("keeps assertive live semantics for error status", async () => {
    await ready();
    ipc.invoke.mockRejectedValueOnce({ code: "AUTOSTART_UPDATE" });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(zh.autoFailure);
    expect(screen.getByRole("alert")).toHaveAttribute(
      "aria-live",
      "assertive",
    );
  });
});

describe("SETUI-07 — unnamed settings and metadata regions", () => {
  it("gives the two page sections accessible names", async () => {
    await ready();
    const sections = [...document.querySelectorAll("section")];
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const labelled =
        section.hasAttribute("aria-label") ||
        section.hasAttribute("aria-labelledby") ||
        !!section.querySelector("h2, h3");
      expect(labelled).toBe(true);
    }
  });
});

describe("SETUI-08 — generic hide failure for tray errors", () => {
  it("uses the tray-specific warning for TRAY_UNAVAILABLE", async () => {
    await ready();
    ipc.invoke.mockRejectedValueOnce({ code: "TRAY_UNAVAILABLE" });
    await userEvent.click(screen.getByRole("button", { name: zh.hide }));
    await screen.findByText(zh.trayWarning);
  });
});

describe("SETUI-09 — tray warning omits close-to-tray / stored true cannot be cleared", () => {
  it("explains why the close-to-tray switch is disabled too", async () => {
    actual.tray_available = false;
    actual.warnings = ["TRAY_UNAVAILABLE: raw-tray"];
    await ready();
    expect(
      screen.getByRole("switch", { name: /关闭窗口后/ }),
    ).toBeDisabled();
    // The copy names the two affected switches, and the page shows both.
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      "关闭到托盘",
    );
    expect(screen.getByText(zh.tray)).toBeInTheDocument();
  });
});

describe("SETUI-10 — definite save failure framed as uncertain", () => {
  it("does not claim a failed SETTINGS_SAVE may have been written after reconciliation proves it was not", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      .mockRejectedValueOnce({ code: "SETTINGS_SAVE" })
      .mockResolvedValueOnce(structuredClone(actual));
    await userEvent.click(screen.getByRole("button", { name: zh.save }));
    await screen.findByText(zh.settingsSaveFailed);
    expect(actual.silent_start).toBe(false);
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      zh.settingsUncertain,
    );
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
  });
});
