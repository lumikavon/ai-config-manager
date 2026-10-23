// Explicit mocked IPC component tests; production contains no demo backend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => mock);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
const config = {
  exists: true,
  base_url: "https://example.com/v1",
  model: "model-a",
  key_present: true,
  encrypted: true,
  revision: "revision-1",
};
const settings = {
  silent_start: false,
  close_to_tray: true,
  language: "zh",
  autostart: false,
  version: "0.1.0",
  platform: "linux",
  tray_available: true,
};
beforeEach(() => {
  mock.isTauri.mockReturnValue(true);
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (command: string) => {
    if (command === "config_read" || command === "config_save") return config;
    if (command === "settings_read" || command === "settings_save")
      return settings;
    if (command === "history_list") return [];
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function ready() {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
}
describe("native configuration interface", () => {
  it("minimizes, toggles maximize/restore, and closes through native window control", async () => {
    mock.invoke.mockImplementation(async (command: string, args?: { action: string }) => {
      if (command === "config_read") return config;
      if (command === "settings_read") return settings;
      if (command === "window_control") return args?.action === "toggle_maximize";
      return [];
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(mock.invoke).toHaveBeenCalledWith("window_control", { action: "minimize" });
    await userEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(await screen.findByRole("button", { name: "还原窗口" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    expect(mock.invoke).toHaveBeenCalledWith("window_control", { action: "close" });
  });
  it("keeps a dirty draft when closing is cancelled", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "changed");
    await userEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("有未保存的更改");
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(mock.invoke).not.toHaveBeenCalledWith("window_control", { action: "close" });
    expect(screen.getByLabelText("模型名称")).toHaveValue("model-achanged");
    await userEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("window_control", { action: "close" }));
  });
  it("does not provide fake browser configuration", () => {
    mock.isTauri.mockReturnValue(false);
    render(<App />);
    expect(screen.getByText("请在桌面应用中打开")).toBeInTheDocument();
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it("never repopulates saved key and passes null to retain it", async () => {
    await ready();
    expect(screen.getByLabelText("API 密钥")).toHaveValue("");
    await userEvent.click(screen.getByText("保存配置"));
    await waitFor(() =>
      expect(mock.invoke).toHaveBeenCalledWith("config_save", {
        request: {
          base_url: config.base_url,
          model: config.model,
          api_key: null,
          encrypt: true,
          expected_revision: "revision-1",
        },
      }),
    );
  });
  it("keeps encryption on when plaintext warning is declined", async () => {
    await ready();
    vi.mocked(window.confirm).mockReturnValue(false);
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("dialog")).toHaveTextContent("明文");
    await userEvent.click(screen.getByText("返回"));
    expect(screen.getByRole("switch")).toBeChecked();
  });
  it("protects dirty configuration from reload", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "changed");
    vi.mocked(window.confirm).mockReturnValue(false);
    const reads = mock.invoke.mock.calls.filter(
      ([c]) => c === "config_read",
    ).length;
    await userEvent.click(screen.getByText("重新加载"));
    await userEvent.click(screen.getByText("返回"));
    expect(screen.getByLabelText("模型名称")).toHaveValue("model-achanged");
    expect(
      mock.invoke.mock.calls.filter(([c]) => c === "config_read"),
    ).toHaveLength(reads);
  });
  it("clears newly entered key after successful save", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("API 密钥"), "test-only-secret");
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(screen.getByLabelText("API 密钥")).toHaveValue("");
  });
  it("shows decryption failure without displaying backend message", async () => {
    await ready();
    mock.invoke.mockRejectedValueOnce({
      code: "DECRYPT_FAILED",
      message: "test-only-secret",
    });
    await userEvent.click(screen.getByText("验证密钥读取"));
    await screen.findByText(/无法解密密钥/);
    expect(screen.queryByText("test-only-secret")).not.toBeInTheDocument();
  });
  it("shows autostart error and re-reads actual state", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    mock.invoke.mockRejectedValueOnce({
      code: "AUTOSTART_FAILED",
      message: "denied",
    });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText(/无法确认开机启动变更/);
    expect(screen.getByRole("switch", { name: /开机启动/ })).not.toBeChecked();
  });
  it("disables save when initial read fails", async () => {
    mock.invoke.mockImplementation(async (c: string) => {
      if (c === "config_read") throw { code: "IO" };
      return settings;
    });
    render(<App />);
    await screen.findByText(/无法读取配置/);
    expect(screen.getByText("保存配置")).toBeDisabled();
  });
  it("switches interface language", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await userEvent.selectOptions(screen.getByLabelText("界面语言"), "en");
    expect(screen.getByText("Make it work your way")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });
  it("redacts key changes defensively", async () => {
    await ready();
    mock.invoke.mockResolvedValueOnce([
      {
        id: "1",
        timestamp: "2026-10-21",
        source: "app",
        sha256: "abc",
        diff: [{ field: "api_key", before: "old-secret", after: "new-secret" }],
      },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /历史记录/ }));
    expect(await screen.findAllByText("[密钥已隐藏]")).toHaveLength(2);
    expect(screen.queryByText("new-secret")).not.toBeInTheDocument();
  });
  it("allows plaintext only after explicit confirmation", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toBeChecked();
    await userEvent.click(screen.getByText("继续"));
    expect(screen.getByRole("switch")).not.toBeChecked();
  });
  it("retains user edits after failed save", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "edited");
    mock.invoke.mockRejectedValueOnce({ code: "CONFLICT" });
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/配置已被其他进程修改/);
    expect(screen.getByLabelText("模型名称")).toHaveValue("model-aedited");
  });
  it("shows unknown autostart state rather than claiming it is disabled", async () => {
    mock.invoke.mockImplementation(async (c: string) =>
      c === "config_read" ? config : { ...settings, autostart_known: false },
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    expect(screen.getByText("未知（无法读取系统状态）")).toBeInTheDocument();
  });
  it("rejects credentials in base URL before IPC save", async () => {
    await ready();
    await userEvent.clear(screen.getByLabelText("API 地址"));
    await userEvent.type(
      screen.getByLabelText("API 地址"),
      "https://user:password@example.com",
    );
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/请输入不含凭据/);
    expect(mock.invoke.mock.calls.some(([c]) => c === "config_save")).toBe(
      false,
    );
  });
  it("defaults missing core configuration to encrypted first save", async () => {
    mock.invoke.mockImplementation(async (command: string) =>
      command === "config_read"
        ? {
            exists: false,
            base_url: "",
            model: "",
            key_present: false,
            encrypted: false,
            revision: "",
          }
        : command === "settings_read"
          ? settings
          : config,
    );
    render(<App />);
    await screen.findByText("还没有配置。填写下方信息开始使用。");
    expect(screen.getByRole("switch")).toBeChecked();
    await userEvent.type(
      screen.getByLabelText("API 地址"),
      "https://example.com/v1",
    );
    await userEvent.type(screen.getByLabelText("模型名称"), "model-a");
    await userEvent.type(screen.getByLabelText("API 密钥"), "test-only-secret");
    await userEvent.click(screen.getByText("保存配置"));
    await waitFor(() =>
      expect(mock.invoke).toHaveBeenCalledWith("config_save", {
        request: {
          base_url: config.base_url,
          model: config.model,
          api_key: "test-only-secret",
          encrypt: true,
          expected_revision: "",
        },
      }),
    );
  });
  it("marks autostart unknown when mutation and reconciliation fail", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    mock.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_FAILED" })
      .mockRejectedValueOnce({ code: "QUERY_FAILED" });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await screen.findByText("未知（无法读取系统状态）");
    // SET-08 fixed: the unknown state also becomes a persistent warning, so the
    // banner explains it as well as the transient status line.
    expect(document.querySelector(".status")).toHaveTextContent(
      "系统状态可能已改变",
    );
    expect(document.querySelector(".system-warning")).toHaveTextContent(
      "无法读取系统开机启动状态",
    );
  });
  it("reconciles changed OS state after failed autostart confirmation", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    mock.invoke
      .mockRejectedValueOnce({ code: "AUTOSTART_FAILED" })
      .mockResolvedValueOnce({
        ...settings,
        autostart: true,
        autostart_known: true,
      });
    await userEvent.click(screen.getByRole("switch", { name: /开机启动/ }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /开机启动/ })).toBeChecked(),
    );
  });
  it("reconciles committed configuration after HISTORY_PENDING without retaining secret", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("API 密钥"), "test-only-secret");
    mock.invoke
      .mockRejectedValueOnce({ code: "HISTORY_PENDING" })
      .mockResolvedValueOnce({ ...config, revision: "committed-revision" });
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/配置已保存，历史记录仍待恢复核对/);
    expect(screen.getByLabelText("API 密钥")).toHaveValue("");
    await userEvent.click(screen.getByText("保存配置"));
    await waitFor(() =>
      expect(mock.invoke).toHaveBeenCalledWith("config_save", {
        request: {
          base_url: config.base_url,
          model: config.model,
          api_key: null,
          encrypt: true,
          expected_revision: "committed-revision",
        },
      }),
    );
  });
  it("disables configuration saving if committed state cannot be reread", async () => {
    await ready();
    mock.invoke
      .mockRejectedValueOnce({ code: "HISTORY_PENDING" })
      .mockRejectedValueOnce({ code: "IO" });
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/当前状态无法读取/);
    expect(screen.getByText("保存配置")).toBeDisabled();
  });
  it("reconciles settings saved before tray failure while keeping warning", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    mock.invoke
      .mockRejectedValueOnce({ code: "TRAY_MENU" })
      .mockResolvedValueOnce({ ...settings, silent_start: true });
    await userEvent.click(screen.getByText("保存设置"));
    // A committed save with a stale tray menu is reported as such, not as an
    // unconfirmed write.
    await screen.findByText(/托盘菜单未能刷新/);
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByText("取消更改")).toBeDisabled();
  });
  it("preserves unsaved settings draft when failed save did not commit", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await userEvent.click(screen.getByRole("switch", { name: /静默启动/ }));
    mock.invoke
      .mockRejectedValueOnce({ code: "IO" })
      .mockResolvedValueOnce(settings);
    await userEvent.click(screen.getByText("保存设置"));
    await screen.findByText(/设置保存未完全确认/);
    expect(screen.getByRole("switch", { name: /静默启动/ })).toBeChecked();
    expect(screen.getByText("取消更改")).toBeEnabled();
  });
  it("shows recovery guidance for missing encryption key", async () => {
    await ready();
    mock.invoke.mockRejectedValueOnce({ code: "KEY_MISSING" });
    await userEvent.click(screen.getByText("验证密钥读取"));
    await screen.findByText(/加密密钥在系统凭据存储中缺失/);
  });
  it("reconciles changed config revision after an explicitly uncertain failure", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("API 密钥"), "test-only-secret");
    // COMMIT_UNCERTAIN is the only configuration code that may have committed.
    mock.invoke.mockRejectedValueOnce({ code: "COMMIT_UNCERTAIN" }).mockResolvedValueOnce({
      ...config,
      model: "committed-model",
      revision: "new-revision",
    });
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/磁盘配置已变化/);
    expect(screen.getByLabelText("API 密钥")).toHaveValue("");
    expect(screen.getByLabelText("模型名称")).toHaveValue("committed-model");
  });
  it("keeps the draft and key when a pre-write failure races an external edit", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "-draft");
    await userEvent.type(screen.getByLabelText("API 密钥"), "test-only-secret");
    // IO from config_save means the file was not replaced; the external revision
    // change is reported by the refreshed baseline, not by discarding the draft.
    mock.invoke.mockRejectedValueOnce({ code: "IO" }).mockResolvedValueOnce({
      ...config,
      model: "external-model",
      revision: "external-revision",
    });
    await userEvent.click(screen.getByText("保存配置"));
    await screen.findByText(/无法读写配置/);
    expect(screen.getByLabelText("API 密钥")).toHaveValue("test-only-secret");
    expect(screen.getByLabelText("模型名称")).toHaveValue("model-a-draft");
    // The baseline moved, so the next save must not silently overwrite it.
    expect(screen.getByText("保存配置")).toBeDisabled();
    expect(screen.getByText("未保存")).toBeInTheDocument();
  });
  it.each([
    ["IO", "请检查文件权限"],
    ["LOCK_TIMEOUT", "另一个进程正在使用配置"],
    ["UNSAFE_PATH", "配置路径不安全"],
    ["TOO_LARGE", "2 MiB"],
    ["ENCRYPT_FAILED", "未自动降级为明文"],
  ])(
    "renders safe localized recovery for initial %s failure",
    async (code, expected) => {
      mock.invoke.mockImplementation(async (command: string) => {
        if (command === "config_read")
          throw { code, message: "test-secret-never-display" };
        return settings;
      });
      render(<App />);
      await screen.findByText(new RegExp(expected));
      expect(
        screen.queryByText(/test-secret-never-display/),
      ).not.toBeInTheDocument();
      expect(screen.getByText("保存配置")).toBeDisabled();
    },
  );
  it("localizes durability warning without rendering raw backend text", async () => {
    mock.invoke.mockImplementation(async (command: string) =>
      command === "config_read"
        ? config
        : {
            ...settings,
            warnings: [
              "SETTINGS_DURABILITY_UNCERTAIN: test-secret-never-display",
            ],
          },
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await screen.findByText(/无法确认已持久写入磁盘/);
    expect(
      screen.queryByText(/test-secret-never-display/),
    ).not.toBeInTheDocument();
  });
  it("does not claim full settings save success when durability is uncertain", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    mock.invoke.mockResolvedValueOnce({
      ...settings,
      warnings: ["SETTINGS_DURABILITY_UNCERTAIN: raw details"],
    });
    await userEvent.click(screen.getByText("保存设置"));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByText(/无法确认已持久写入磁盘/)).toHaveLength(2);
    expect(screen.queryByText("设置已保存。")).not.toBeInTheDocument();
  });
});
