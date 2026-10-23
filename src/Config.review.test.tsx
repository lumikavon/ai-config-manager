// Independent config review: all IPC and credentials below are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ConfigView } from "./types";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  navigate: undefined as undefined | ((event: { payload: string }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => {
    ipc.navigate = callback;
    return () => { if (ipc.navigate === callback) ipc.navigate = undefined; };
  }),
}));
const initial: ConfigView = {
  exists: true,
  base_url: "https://review.example/v1",
  model: "original-model",
  key_present: true,
  encrypted: true,
  revision: "revision-1",
};
const preferences = {
  silent_start: false,
  close_to_tray: true,
  language: "zh",
  autostart: false,
  autostart_known: true,
  version: "0.1.0",
  platform: "windows",
  tray_available: true,
};
let disk: ConfigView;
let readError: string | undefined;
let saveError: string | undefined;
let checkError: string | undefined;

beforeEach(() => {
  disk = { ...initial };
  readError = saveError = checkError = undefined;
  ipc.invoke.mockReset();
  ipc.navigate = undefined;
  ipc.invoke.mockImplementation(async (command: string, args?: {
    request: { base_url: string; model: string; api_key: string | null; encrypt: boolean; expected_revision: string };
  }) => {
    if (command === "settings_read") return preferences;
    if (command === "history_list") return [];
    if (command === "config_read") {
      if (readError) throw { code: readError, message: "synthetic-private-error" };
      return { ...disk };
    }
    if (command === "config_check") {
      if (checkError) throw { code: checkError, message: "synthetic-private-error" };
      return;
    }
    if (command === "config_save") {
      if (saveError) throw { code: saveError, message: "synthetic-private-error" };
      const request = args!.request;
      if (request.expected_revision !== disk.revision) throw { code: "CONFLICT" };
      disk = { ...disk, exists: true, base_url: request.base_url, model: request.model,
        key_present: true, encrypted: request.encrypt, revision: "revision-saved" };
      return { ...disk };
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const button = (name: string) => screen.getByRole("button", { name });
const model = () => screen.getByLabelText("模型名称");
const key = () => screen.getByLabelText("API 密钥");
const saves = () => ipc.invoke.mock.calls.filter(([command]) => command === "config_save");
const reads = () => ipc.invoke.mock.calls.filter(([command]) => command === "config_read");
async function ready() {
  render(<App />);
  await waitFor(() => expect(button("保存配置")).toBeEnabled());
}
async function changeModel(value = "draft-model") {
  await userEvent.clear(model());
  await userEvent.type(model(), value);
}

describe("config independent behavior review", () => {
  it("preserves the unsaved model and replacement key after a real revision conflict", async () => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-replacement-key");
    disk = { ...disk, model: "external-model", revision: "revision-2" };
    await userEvent.click(button("保存配置"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/配置已被其他进程修改/),
    );
    expect(model()).toHaveValue("draft-model");
    expect(key()).toHaveValue("synthetic-replacement-key");
    // CFG-03: the baseline is refreshed on CONFLICT, so Save must not silently
    // overwrite a revision the user has not inspected yet.
    expect(button("保存配置")).toBeDisabled();
    expect(button("取消更改")).toBeEnabled();
    await userEvent.click(button("取消更改"));
    await userEvent.click(button("继续"));
    expect(model()).toHaveValue("external-model");
    expect(key()).toHaveValue("");
    expect(button("保存配置")).toBeEnabled();
    // A discarded conflict leaves a truthful, saveable baseline.
    disk = { ...disk, model: "second-external-model", revision: "revision-3" };
    await userEvent.click(button("重新加载"));
    await waitFor(() => expect(model()).toHaveValue("second-external-model"));
  });

  it("does not navigate away beneath an unresolved plaintext confirmation", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("dialog")).toHaveTextContent("明文");
    act(() => ipc.navigate?.({ payload: "settings" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("连接你的 AI 服务");
    await userEvent.click(button("返回"));
    expect(screen.getByRole("switch", { name: /加密保存密钥/ })).toBeChecked();
    expect(saves()).toHaveLength(0);
  });

  it("does not replace a pending reload confirmation with native navigation", async () => {
    await ready();
    await changeModel();
    await userEvent.click(button("重新加载"));
    act(() => ipc.navigate?.({ payload: "settings" }));
    await userEvent.click(button("继续"));
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("连接你的 AI 服务");
    expect(model()).toHaveValue(initial.model);
  });

  it("uses the native missing revision for first save and defaults encryption on", async () => {
    disk = { exists: false, base_url: "", model: "", key_present: false, encrypted: false, revision: "missing" };
    await ready();
    expect(screen.getByRole("switch")).toBeChecked();
    expect(button("验证密钥读取")).toBeDisabled();
    await userEvent.type(screen.getByLabelText("API 地址"), initial.base_url);
    await userEvent.type(model(), initial.model);
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent("首次使用的密钥");
    expect(saves()).toHaveLength(0);
    await userEvent.type(key(), "synthetic-first-key");
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(saves()[0][1]).toEqual({ request: {
      base_url: initial.base_url, model: initial.model, api_key: "synthetic-first-key",
      encrypt: true, expected_revision: "missing",
    } });
    expect(key()).toHaveValue("");
    expect(button("取消更改")).toBeDisabled();
  });

  it.each(["https://user:password@review.example/v1", "https://review.example/v1?x=1", "https://review.example/v1#part", "ftp://review.example/v1"])(
    "rejects prohibited URL %s before saving", async (url) => {
      await ready();
      await userEvent.clear(screen.getByLabelText("API 地址"));
      await userEvent.type(screen.getByLabelText("API 地址"), url);
      await userEvent.click(button("保存配置"));
      expect(screen.getByRole("alert")).toHaveTextContent("HTTP(S)");
      expect(saves()).toHaveLength(0);
    },
  );

  it.each(["取消更改", "重新加载", "历史记录", "设置"])(
    "protects edits when declining %s", async (action) => {
      await ready();
      await changeModel();
      await userEvent.type(key(), "synthetic-unsaved-key");
      await userEvent.click(button(action));
      expect(screen.getByRole("dialog")).toHaveTextContent("有未保存的更改");
      await userEvent.click(button("返回"));
      expect(model()).toHaveValue("draft-model");
      expect(key()).toHaveValue("synthetic-unsaved-key");
      expect(reads()).toHaveLength(1);
      expect(saves()).toHaveLength(0);
    },
  );

  it("Escape cancels plaintext confirmation; explicit continue permits plaintext save", async () => {
    await ready();
    await userEvent.click(screen.getByRole("switch"));
    // jsdom does not dispatch the browser's native Escape cancel event itself.
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByRole("switch")).toHaveFocus();
    await userEvent.click(screen.getByRole("switch"));
    await userEvent.click(button("继续"));
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(saves()[0][1].request).toMatchObject({ encrypt: false, api_key: null });
  });

  it("confirmed cancellation restores the saved fields and clears the replacement key", async () => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-unsaved-key");
    await userEvent.click(button("取消更改"));
    await userEvent.click(button("继续"));
    expect(model()).toHaveValue(initial.model);
    expect(key()).toHaveValue("");
    expect(button("取消更改")).toBeDisabled();
    expect(saves()).toHaveLength(0);
  });

  it("recovers from initial read failure using reload", async () => {
    readError = "IO";
    render(<App />);
    await screen.findByRole("alert");
    expect(button("保存配置")).toBeDisabled();
    expect(key()).toBeDisabled();
    expect(screen.queryByText("synthetic-private-error")).not.toBeInTheDocument();
    readError = undefined;
    await userEvent.click(button("重新加载"));
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(model()).toHaveValue(initial.model);
    expect(reads()).toHaveLength(2);
  });

  it("preserves editable draft after vault failure without downgrading encryption", async () => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-replacement-key");
    saveError = "VAULT_UNAVAILABLE";
    await userEvent.click(button("保存配置"));
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("系统凭据存储不可用");
    expect(model()).toHaveValue("draft-model");
    expect(key()).toHaveValue("synthetic-replacement-key");
    expect(screen.getByRole("switch")).toBeChecked();
    saveError = undefined;
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(key()).toHaveValue("");
  });

  it("verifies saved key access without submitting or discarding the draft", async () => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-unsaved-key");
    await userEvent.click(button("验证密钥读取"));
    await screen.findByText("密钥可正常读取。");
    expect(ipc.invoke).toHaveBeenCalledWith("config_check");
    expect(saves()).toHaveLength(0);
    expect(model()).toHaveValue("draft-model");
    expect(key()).toHaveValue("synthetic-unsaved-key");
  });

  it.each(["KEY_MISSING", "DECRYPT_FAILED"])(
    "allows replacing an inaccessible saved key after %s", async (code) => {
      await ready();
      checkError = code;
      await userEvent.click(button("验证密钥读取"));
      await screen.findByRole("alert");
      expect(screen.queryByText("synthetic-private-error")).not.toBeInTheDocument();
      await userEvent.type(key(), "synthetic-recovery-key");
      await userEvent.click(button("保存配置"));
      await screen.findByText("配置已安全提交。");
      expect(saves()[0][1].request).toMatchObject({ api_key: "synthetic-recovery-key", expected_revision: "revision-1" });
      expect(key()).toHaveValue("");
    },
  );

  it("keeps the draft when the already active configuration navigation item is clicked", async () => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-unsaved-key");
    await userEvent.click(button("配置"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(model()).toHaveValue("draft-model");
    expect(key()).toHaveValue("synthetic-unsaved-key");
    expect(reads()).toHaveLength(1);
  });

  it("clears the discarded replacement key even if the confirmed reload fails", async () => {
    await ready();
    await userEvent.type(key(), "synthetic-discarded-key");
    readError = "IO";
    await userEvent.click(button("重新加载"));
    await userEvent.click(button("继续"));
    await screen.findByRole("alert");
    expect(button("保存配置")).toBeDisabled();
    expect(key()).toHaveValue("");
    readError = undefined;
    await userEvent.click(button("重新加载"));
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(key()).toHaveValue("");
    expect(saves()).toHaveLength(0);
  });

  it("blocks navigation and duplicate saves while the save IPC is pending", async () => {
    await ready();
    await changeModel();
    let finishSave!: (value: ConfigView) => void;
    ipc.invoke.mockImplementationOnce(() => new Promise<ConfigView>((resolve) => { finishSave = resolve; }));
    await userEvent.click(button("保存配置"));
    expect(button("正在保存…")).toBeDisabled();
    expect(button("重新加载")).toBeDisabled();
    expect(button("取消更改")).toBeDisabled();
    expect(button("设置")).toBeDisabled();
    expect(model()).toBeDisabled();
    act(() => ipc.navigate?.({ payload: "settings" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("连接你的 AI 服务");
    await userEvent.click(button("正在保存…"));
    expect(saves()).toHaveLength(1);
    await act(async () => finishSave({ ...initial, model: "draft-model", revision: "revision-saved" }));
    expect(button("保存配置")).toBeEnabled();
    expect(button("取消更改")).toBeDisabled();
  });

  it.each(["历史记录", "设置"])("discards drafts only after confirming navigation to %s", async (page) => {
    await ready();
    await changeModel();
    await userEvent.type(key(), "synthetic-unsaved-key");
    await userEvent.click(button(page));
    expect(model()).toHaveValue("draft-model");
    await userEvent.click(button("继续"));
    await userEvent.click(button("配置"));
    expect(model()).toHaveValue(initial.model);
    expect(key()).toHaveValue("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saves()).toHaveLength(0);
  });

  it("requires reload after committed history failure cannot be reconciled", async () => {
    await ready();
    await userEvent.type(key(), "synthetic-committed-key");
    saveError = "HISTORY_PENDING";
    readError = "IO";
    await userEvent.click(button("保存配置"));
    await screen.findByText(/当前状态无法读取/);
    expect(key()).toHaveValue("");
    expect(button("保存配置")).toBeDisabled();
    disk = { ...disk, model: "committed-model", revision: "committed-revision" };
    saveError = readError = undefined;
    await userEvent.click(button("重新加载"));
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(model()).toHaveValue("committed-model");
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(saves()[1][1].request).toMatchObject({ api_key: null, expected_revision: "committed-revision" });
  });
});
