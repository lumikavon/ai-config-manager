// Settings-page focused review tests: synthetic IPC only. No OS registration,
// no real preference files, no vault. Every active test asserts current behavior;
// suspected defects are parked in describe.skip("PENDING FIX SET-xx").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { messages } from "./i18n";
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
  base_url: "https://settings.example/v1",
  model: "settings-model",
  key_present: true,
  encrypted: true,
  revision: "settings-revision",
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

// Simulated in-process backend state; settings_read always reflects disk truth.
let backend: Settings;

function count(command: string) {
  return ipc.invoke.mock.calls.filter(([name]) => name === command).length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openSettings() {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await screen.findByLabelText("界面语言");
}

function statusLine() {
  return document.querySelector(".status") as HTMLElement;
}

beforeEach(() => {
  backend = { ...initial, warnings: [] };
  ipc.isTauri.mockReturnValue(true);
  ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(
    async (
      command: string,
      args?: { settings?: Partial<Settings>; enabled?: boolean },
    ) => {
      if (command === "config_read") return config;
      if (command === "settings_read") return { ...backend };
      if (command === "settings_save") {
        backend = { ...backend, ...args?.settings };
        return { ...backend };
      }
      if (command === "autostart_set") {
        backend = {
          ...backend,
          autostart: !!args?.enabled,
          autostart_known: true,
        };
        return backend.autostart;
      }
      if (command === "history_list") return [];
      if (command === "window_hide") return;
      throw new Error(`Unexpected mock IPC: ${command}`);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("settings draft, baseline and persistence", () => {
  it("stages silent/tray changes as a draft and only persists them on Save", async () => {
    await openSettings();
    await userEvent.click(
      screen.getByRole("switch", { name: /静默启动/ }),
    );

    // Draft only: nothing was written and the simulated disk is unchanged.
    expect(count("settings_save")).toBe(0);
    expect(backend.silent_start).toBe(false);
    expect(screen.getByRole("button", { name: "取消更改" })).toBeEnabled();
    // SET-02 fixed: the settings card now shows the same unsaved marker as the
    // configuration card, so a draft is never silently presented as saved.
    expect(screen.getByText("未保存")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText("设置已保存。");
    expect(ipc.invoke).toHaveBeenCalledWith("settings_save", {
      settings: { silent_start: true, close_to_tray: true, language: "zh" },
    });
    expect(backend.silent_start).toBe(true);
    // Saved baseline moved: the card is no longer dirty.
    expect(screen.getByRole("button", { name: "取消更改" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
  });

  // Status quo for SET-02: this active assertion documents the current
  // always-enabled Save; the skipped SET-02 test describes the intended gate.
  it("currently allows a redundant save when nothing changed", async () => {
    await openSettings();
    const save = screen.getByRole("button", { name: "保存设置" });
    expect(save).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消更改" })).toBeDisabled();

    await userEvent.click(save);
    await screen.findByText("设置已保存。");
    expect(count("settings_save")).toBe(1);
  });

  it("keeps a preference draft dirty when an autostart failure re-reads the saved baseline", async () => {
    await openSettings();
    await userEvent.click(
      screen.getByRole("switch", { name: /静默启动/ }),
    );
    ipc.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_UPDATE" })
      .mockResolvedValueOnce({ ...backend, autostart: false });

    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(/无法确认开机启动变更/);

    // Reconciliation must not copy the draft into the saved baseline.
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(backend.silent_start).toBe(false);
    expect(screen.getByRole("button", { name: "取消更改" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "取消更改" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(count("settings_save")).toBe(0);
  });
});

describe("tray capability gating", () => {
  it("disables silent/tray switches but keeps autostart usable when the tray is unavailable", async () => {
    backend = {
      ...backend,
      silent_start: true,
      close_to_tray: true,
      tray_available: false,
      warnings: ["TRAY_UNAVAILABLE: raw native detail"],
    };
    await openSettings();

    const silent = screen.getByRole("switch", { name: /静默启动/ });
    const tray = screen.getByRole("switch", { name: /关闭窗口后/ });
    expect(silent).toBeDisabled();
    expect(tray).toBeDisabled();
    // The stored preference is still rendered as checked even though the
    // current session forces a visible window.
    expect(silent).toBeChecked();
    expect(tray).toBeChecked();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "隐藏到托盘" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("系统托盘不可用");
    expect(screen.queryByText(/raw native detail/)).toBeNull();

    // A language-only save re-persists the unchangeable "checked" values.
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");
    expect(ipc.invoke).toHaveBeenCalledWith("settings_save", {
      settings: { silent_start: true, close_to_tray: true, language: "en" },
    });
  });
});

describe("autostart uncertainty", () => {
  it("marks an unknown autostart state as unconfirmed instead of a definite off switch", async () => {
    backend = {
      ...backend,
      autostart: false,
      autostart_known: false,
      warnings: ["AUTOSTART_UNKNOWN: raw native detail"],
    };
    await openSettings();

    const auto = screen.getByRole("switch", { name: /开机启动/ });
    // SET-05 fixed: still usable, but visually marked as unconfirmed so the knob
    // cannot be read as a verified "off".
    expect(auto).toBeEnabled();
    expect(auto).not.toBeChecked();
    expect(auto).toHaveAttribute("data-unknown", "true");
    expect(screen.getByText("未知（无法读取系统状态）")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法读取系统开机启动状态",
    );
    expect(screen.queryByText(/raw native detail/)).toBeNull();
  });

  it("allows only one autostart mutation while the first request is pending", async () => {
    await openSettings();
    const pending = deferred<boolean>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    const auto = screen.getByRole("switch", { name: /开机启动/ });

    await userEvent.dblClick(auto);
    expect(count("autostart_set")).toBe(1);
    expect(auto).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    await screen.findByText("开机启动状态已更新。");
    expect(auto).toBeChecked();
    expect(screen.getByRole("combobox")).toBeEnabled();
  });

  it("fails closed to Unknown when the autostart mutation and reconciliation both fail", async () => {
    await openSettings();
    ipc.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_UPDATE" })
      .mockRejectedValueOnce({ code: "SETTINGS_LOCK" });

    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText("未知（无法读取系统状态）");

    expect(screen.getByRole("switch", { name: /开机启动/ })).not.toBeChecked();
    // SET-08 fixed: the unknown state is recorded as a warning, so the banner also
    // explains it when the reconciliation read fails.
    expect(document.querySelector(".status")).toHaveTextContent(
      "无法确认开机启动变更",
    );
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      "无法读取系统开机启动状态，请检查系统登录项设置。",
    );
  });
});

describe("settings warnings", () => {
  it("localizes, deduplicates and orders known warning codes without leaking native text", async () => {
    backend = {
      ...backend,
      warnings: [
        "FUTURE_CODE: private detail",
        "TRAY_UNAVAILABLE: raw tray detail",
        "TRAY_UNAVAILABLE: duplicate tray detail",
        "FUTURE_CODE: another private detail",
      ],
    };
    await openSettings();

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toBe(
      `${messages.zh.warning} ${messages.zh.trayWarning}`,
    );
    expect(banner.textContent).not.toMatch(/private detail|raw tray detail/);
  });

  it("previews the warning text in the selected language and reverts it on discard", async () => {
    backend = { ...backend, warnings: ["TRAY_UNAVAILABLE: raw detail"] };
    await openSettings();

    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The system tray is unavailable",
    );
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
    expect(count("settings_save")).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Discard your unsaved changes?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("界面语言")).toHaveValue("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByRole("alert")).toHaveTextContent("系统托盘不可用");
  });

  it("renders stored silent/tray preferences and the tray capability in the metadata card", async () => {
    backend = { ...backend, tray_available: true };
    await openSettings();
    expect(screen.getByText("版本")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("windows")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
  });
});

describe("save failures are classified before they are reported", () => {
  it("reports a definite write failure as failed instead of 'may have been written'", async () => {
    await openSettings();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      .mockRejectedValueOnce({ code: "SETTINGS_SAVE" })
      .mockResolvedValueOnce({ ...backend });

    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText(/设置保存失败，原有设置仍然生效/);

    // SET-01 fixed: the backend proved the file was not replaced, so the copy
    // must not claim that the write may have landed.
    expect(statusLine()).not.toHaveTextContent("可能已写入磁盘");
    expect(backend.silent_start).toBe(false);
    expect(screen.getByRole("button", { name: "取消更改" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });

  it("explains an unresolved uncertain save inline and keeps the reason after navigation", async () => {
    await openSettings();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke
      .mockRejectedValueOnce({ code: "SETTINGS_UNKNOWN_OUTCOME" })
      .mockRejectedValueOnce({ code: "SETTINGS_LOCK" });

    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText(/当前状态无法读取/);
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(
      document.querySelector(".system-warning"),
    ).toHaveTextContent(/设置保存未完全确认/);

    await userEvent.click(screen.getByRole("button", { name: /配置/ }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));

    // SET-03 fixed: the blocking reason is part of the page, not only the
    // transient status line, so it survives navigation.
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      /设置保存未完全确认/,
    );
  });
});

describe.skip("PENDING FIX SET-06: tray-unavailable switches keep a stale checked value", () => {
  it("does not show a checked preference that this session refuses to honor", async () => {
    backend = {
      ...backend,
      silent_start: true,
      tray_available: false,
      warnings: ["TRAY_UNAVAILABLE: raw detail"],
    };
    await openSettings();
    const silent = screen.getByRole("switch", { name: /静默启动/ });
    expect(silent).toBeDisabled();
    // Current: checked=true even though silent start cannot take effect and the
    // user has no way to clear the stored preference.
    expect(silent).not.toBeChecked();
  });
});

describe("SET-08: autostart double failure surfaces its warning", () => {
  it("keeps an AUTOSTART_UNKNOWN warning when reconciliation fails too", async () => {
    await openSettings();
    ipc.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_UPDATE" })
      .mockRejectedValueOnce({ code: "SETTINGS_LOCK" });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText("未知（无法读取系统状态）");
    expect(
      screen.getByText("无法读取系统开机启动状态，请检查系统登录项设置。"),
    ).toBeInTheDocument();
  });
});
