// Independent settings review: synthetic IPC only; no OS registration or user files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { Settings } from "./types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ipc);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
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
  platform: "linux",
  warnings: [],
};
let actual: Settings;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function count(command: string) {
  return ipc.invoke.mock.calls.filter(([name]) => name === command).length;
}
async function ready() {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await screen.findByLabelText("界面语言");
}
beforeEach(() => {
  actual = { ...initial, warnings: [] };
  ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(async (command: string, args?: { settings?: Partial<Settings>; enabled?: boolean }) => {
    if (command === "config_read") return config;
    if (command === "settings_read") return { ...actual };
    if (command === "settings_save") {
      actual = { ...actual, ...args?.settings };
      return { ...actual };
    }
    if (command === "autostart_set") {
      actual = { ...actual, autostart: !!args?.enabled, autostart_known: true };
      return actual.autostart;
    }
    if (command === "history_list") return [];
    if (command === "window_hide") return;
    throw new Error(`Unexpected mock IPC: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("independent settings behavior review", () => {
  it("previews language without saving and restores language only after confirmed cancellation", async () => {
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    expect(document.documentElement.lang).toBe("en");
    expect(count("settings_save")).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("界面语言")).toHaveValue("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(count("settings_save")).toBe(0);
  });

  it("saves only preference fields and keeps saved language after navigation and reload", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("switch", { name: /关闭窗口后/ }));
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");
    expect(ipc.invoke).toHaveBeenCalledWith("settings_save", {
      settings: { silent_start: true, close_to_tray: false, language: "en" },
    });
    expect(count("autostart_set")).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: /Configuration/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Settings/ }));
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(screen.getByRole("switch", { name: /Start silently/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Keep running/ })).not.toBeChecked();
  });

  it("protects unsaved language on reload and navigation", async () => {
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    const reads = count("settings_read");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(count("settings_read")).toBe(reads);
    await userEvent.click(screen.getByRole("button", { name: /Configuration/ }));
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("界面语言");
    expect(count("settings_read")).toBe(reads + 1);
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("recovers from initial settings load failure through explicit retry", async () => {
    const normal = ipc.invoke.getMockImplementation()!;
    let reads = 0;
    ipc.invoke.mockImplementation((command, args) => {
      if (command === "settings_read" && reads++ === 0)
        return Promise.reject({ code: "SETTINGS_LOCK", message: "private-backend-detail" });
      return normal(command, args);
    });
    render(<App />);
    await screen.findByDisplayValue(config.base_url);
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await screen.findByText("无法读取设置，请重试。");
    expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();
    expect(screen.queryByText(/private-backend-detail/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByLabelText("界面语言");
    expect(screen.queryByText("无法读取设置，请重试。")).not.toBeInTheDocument();
  });

  it("disables silent/tray controls and hide action when native tray is unavailable", async () => {
    actual = { ...actual, tray_available: false, warnings: ["TRAY_UNAVAILABLE: private detail"] };
    await ready();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /关闭窗口后/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "隐藏到托盘" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("系统托盘不可用");
    expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
  });

  it("keeps immediate OS autostart change when cancelling unsaved preference edits", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText("开机启动状态已更新。");
    await userEvent.click(screen.getByRole("button", { name: "取消更改" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("switch", { name: /静默启动/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    expect(count("autostart_set")).toBe(1);
    expect(count("settings_save")).toBe(0);
  });

  it("reconciles failed autostart mutation while preserving preference draft", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke.mockRejectedValueOnce({ code: "AUTOSTART_QUERY" }).mockResolvedValueOnce({ ...actual, autostart: true });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(/无法确认开机启动变更/);
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "取消更改" })).toBeEnabled();
  });

  it.each([false, true])("reconciles settings failure with committed=%s and keeps language preview", async (committed) => {
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    ipc.invoke.mockRejectedValueOnce({ code: committed ? "TRAY_MENU" : "SETTINGS_SAVE" }).mockResolvedValueOnce({ ...actual, language: committed ? "en" : "zh" });
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    // A committed-but-tray-stale save and a definite write failure are different
    // outcomes and must not share the "may have been written" copy.
    await screen.findByText(committed ? /tray menu could not be rebuilt/ : /Saving settings failed/);
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(document.documentElement.lang).toBe("en");
    if (committed) expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    else expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });

  it("prevents a pending reload from overwriting a newly confirmed autostart change", async () => {
    await ready();
    const pending = deferred<Settings>();
    const stale = { ...actual };
    ipc.invoke.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    const changedWhileReading = count("autostart_set") > 0;
    if (changedWhileReading) {
      await screen.findByText("开机启动状态已更新。");
      expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    }
    await act(async () => { pending.resolve(stale); await pending.promise; });
    if (!changedWhileReading) {
      await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
      await screen.findByText("开机启动状态已更新。");
    }
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    expect(actual.autostart).toBe(true);
  });

  it("preserves a language edit made after reload began or defers editing until reload finishes", async () => {
    await ready();
    const pending = deferred<Settings>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    const select = screen.getByRole("combobox");
    const editingBlocked = select.hasAttribute("disabled");
    if (!editingBlocked) await userEvent.selectOptions(select, "en");
    await act(async () => { pending.resolve({ ...actual }); await pending.promise; });
    if (editingBlocked) await userEvent.selectOptions(screen.getByRole("combobox"), "en");
    expect(screen.getByRole("combobox")).toHaveValue("en");
    expect(document.documentElement.lang).toBe("en");
    expect(count("settings_save")).toBe(0);
  });

  it("prevents duplicate settings saves and navigation while save is pending", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    const pending = deferred<Settings>();
    ipc.invoke.mockReturnValueOnce(pending.promise);
    await userEvent.dblClick(screen.getByRole("button", { name: "保存设置" }));
    expect(count("settings_save")).toBe(1);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /配置$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeDisabled();
    await act(async () => { pending.resolve({ ...actual, silent_start: true }); await pending.promise; });
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
  });

  it("calls the native hide command and safely reports rejection", async () => {
    await ready();
    ipc.invoke.mockRejectedValueOnce({ code: "TRAY_UNAVAILABLE", message: "private-native-detail" });
    await userEvent.click(screen.getByRole("button", { name: "隐藏到托盘" }));
    await screen.findByText(/系统托盘不可用/);
    expect(ipc.invoke).toHaveBeenCalledWith("window_hide");
    expect(screen.queryByText(/private-native-detail/)).not.toBeInTheDocument();
  });

  it("blocks blind settings resubmission after both save and state reconciliation fail", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    ipc.invoke.mockRejectedValueOnce({ code: "TRAY_MENU" }).mockRejectedValueOnce({ code: "SETTINGS_LOCK" });
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText(/托盘菜单未能刷新/);
    await waitFor(() => expect(screen.getByRole("button", { name: "重新加载" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    if (screen.queryByRole("dialog")) await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
  });

  it("clears only obsolete autostart unknown warning after OS verification succeeds", async () => {
    actual = { ...actual, autostart_known: false, warnings: ["AUTOSTART_UNKNOWN: unavailable", "TRAY_UNAVAILABLE: unavailable"], tray_available: false };
    await ready();
    expect(screen.getByText("未知（无法读取系统状态）")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText("开机启动状态已更新。");
    expect(screen.queryByText("未知（无法读取系统状态）")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("系统托盘不可用");
    expect(screen.getByRole("alert")).not.toHaveTextContent("无法读取系统开机启动状态");
  });
});
