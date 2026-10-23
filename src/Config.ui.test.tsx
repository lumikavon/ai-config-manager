// Config route UI/functional verification (all IPC and credentials are synthetic).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ConfigView, Language } from "./types";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ipc);
vi.mock("@tauri-apps/api/event", () => ipc);

type SaveRequest = {
  base_url: string;
  model: string;
  api_key: string | null;
  encrypt: boolean;
  expected_revision: string;
};

const saved: ConfigView = {
  exists: true,
  base_url: "https://app.example/v1",
  model: "model-a",
  key_present: true,
  encrypted: true,
  revision: "rev-1",
};
const firstRun: ConfigView = {
  exists: false,
  base_url: "",
  model: "",
  key_present: false,
  encrypted: true,
  revision: "missing",
};

let disk: ConfigView;
let prefs: {
  silent_start: boolean;
  close_to_tray: boolean;
  language: Language;
  autostart: boolean;
  autostart_known: boolean;
  version: string;
  platform: string;
  tray_available: boolean;
};
let readError: string | undefined;
let saveError: string | undefined;
let checkError: string | undefined;
let gateRead: boolean;
let releaseRead: (() => void) | null;
let gateSave: boolean;
let releaseSave: (() => void) | null;

beforeEach(() => {
  disk = { ...saved };
  prefs = {
    silent_start: false,
    close_to_tray: true,
    language: "zh",
    autostart: false,
    autostart_known: true,
    version: "0.1.0",
    platform: "windows",
    tray_available: true,
  };
  readError = saveError = checkError = undefined;
  gateRead = false;
  gateSave = false;
  releaseRead = null;
  releaseSave = null;
  ipc.isTauri.mockReturnValue(true);
  ipc.invoke.mockReset();
  ipc.listen.mockReset();
  ipc.listen.mockImplementation(async () => () => {});
  ipc.invoke.mockImplementation(
    async (command: string, args?: { request: SaveRequest }) => {
      if (command === "settings_read") return { ...prefs };
      if (command === "history_list") return [];
      if (command === "config_read") {
        if (readError) throw { code: readError };
        if (gateRead) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return { ...disk };
      }
      if (command === "config_check") {
        if (checkError) throw { code: checkError };
        return undefined;
      }
      if (command === "config_save") {
        const request = args!.request;
        if (saveError) throw { code: saveError };
        if (gateSave) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        disk = {
          ...disk,
          exists: true,
          base_url: request.base_url,
          model: request.model,
          key_present: disk.key_present || !!request.api_key,
          encrypted: request.encrypt,
          revision: "rev-2",
        };
        return { ...disk };
      }
      throw new Error(`unexpected IPC command: ${command}`);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const field = (label: string) => screen.getByLabelText(label);
const statusLine = () => document.querySelector(".status") as HTMLElement;
const badge = () => document.querySelector(".badge") as HTMLElement;
const keyInput = () => field("API 密钥") as HTMLInputElement;
const saveCalls = () =>
  ipc.invoke.mock.calls.filter(([command]) => command === "config_save");
const readCalls = () =>
  ipc.invoke.mock.calls.filter(([command]) => command === "config_read");
const savedRequest = (index = 0) => (saveCalls()[index][1] as { request: SaveRequest }).request;

async function ready() {
  render(<App />);
  await waitFor(() =>
    expect(document.querySelector("main .actions button[type=submit]")).toBeEnabled(),
  );
}

async function changeModel(value = "draft-model") {
  const model = field("模型名称");
  await userEvent.clear(model);
  await userEvent.type(model, value);
}

describe("config route shell", () => {
  it("renders the sidebar navigation, header and empty status line", async () => {
    await ready();
    const nav = screen.getByRole("navigation");
    const items = within(nav).getAllByRole("button");
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "⚙配置",
      "↺历史记录",
      "☷设置",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "page");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[2]).not.toHaveAttribute("aria-current");
    expect(items.every((item) => !(item as HTMLButtonElement).disabled)).toBe(
      true,
    );

    expect(document.querySelector(".eyebrow")).toHaveTextContent(/^配置$/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "连接你的 AI 服务",
    );
    expect(document.querySelector("header p")).toHaveTextContent(
      "统一管理本地模型连接，密钥始终留在你的设备上。",
    );
    expect(statusLine()).toHaveTextContent(/^$/);
    expect(statusLine()).toHaveAttribute("role", "status");
    expect(statusLine()).toHaveAttribute("aria-live", "polite");
  });

  it("renders the card heading, badge and security note", async () => {
    await ready();
    expect(document.querySelector(".card-top h2")).toHaveTextContent(/^配置$/);
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    expect(badge().className).not.toContain("warning");
    expect(document.querySelector(".note strong")).toHaveTextContent(/^安全提示$/);
    expect(document.querySelector(".note p")).toHaveTextContent(
      "界面不会显示已存密钥；请勿将配置文件中的敏感内容分享给他人。",
    );
  });

  it("exposes the documented input semantics and helper text", async () => {
    await ready();
    const url = field("API 地址") as HTMLInputElement;
    expect(url).toHaveAttribute("type", "url");
    expect(url).toHaveAttribute("aria-describedby", "base-help");
    expect(url).toHaveAttribute("autocomplete", "off");
    expect(url).toHaveAttribute("spellcheck", "false");
    expect(url).toHaveValue(saved.base_url);
    const baseHelp = document.getElementById("base-help")!;
    expect(baseHelp).toHaveTextContent(
      "输入完整 HTTP(S) 地址，例如 https://api.example.com/v1",
    );

    const key = keyInput();
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "new-password");
    expect(key).toHaveAttribute("aria-describedby", "key-help");
    expect(key).toHaveValue("");
    expect(key.getAttribute("value") ?? "").toBe("");
    expect(document.getElementById("key-help")).toHaveTextContent(
      "密钥已保存。留空以保留现有密钥。",
    );

    const model = field("模型名称") as HTMLInputElement;
    expect(model).toHaveAttribute("aria-describedby", "model-help");
    expect(model).toHaveValue(saved.model);
    expect(document.getElementById("model-help")).toHaveTextContent(
      "填写服务支持的准确模型标识。",
    );

    expect(url.getAttribute("aria-describedby")).toBe(baseHelp.id);
    expect(model.getAttribute("aria-describedby")).toBe(
      document.getElementById("model-help")!.id,
    );
  });

  it("renders the encryption switch, action buttons and security note", async () => {
    await ready();
    const toggle = screen.getByRole("switch", { name: /加密保存密钥/ });
    expect(toggle).toBeChecked();
    expect(toggle.parentElement).toHaveTextContent(
      "推荐开启。关闭后密钥将以明文写入本地配置。",
    );

    const actions = [...document.querySelectorAll("main .actions button")];
    expect(actions.map((item) => item.textContent?.trim())).toEqual([
      "保存配置",
      "重新加载",
      "取消更改",
      "验证密钥读取",
    ]);
    expect(actions[0]).toHaveAttribute("type", "submit");
    expect(actions[2]).toBeDisabled();
    expect(actions[3]).toBeEnabled();
  });

  it("renders English copy for the whole config route when settings say en", async () => {
    prefs.language = "en";
    await ready();
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Connect your AI service",
    );
    expect(document.querySelector(".eyebrow")).toHaveTextContent(
      /^Configuration$/,
    );
    expect(document.querySelector("header p")).toHaveTextContent(
      "Manage local model connections. Your credentials stay on your device.",
    );
    expect(document.querySelector(".card-top h2")).toHaveTextContent(
      /^Configuration$/,
    );
    expect(badge()).toHaveTextContent(/^Key encrypted$/);
    expect(screen.getByLabelText("API base URL")).toHaveValue(saved.base_url);
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Model name")).toHaveValue(saved.model);
    expect(document.getElementById("base-help")).toHaveTextContent(
      "Enter a full HTTP(S) URL, such as https://api.example.com/v1",
    );
    expect(document.getElementById("key-help")).toHaveTextContent(
      "A key is saved. Leave blank to keep it.",
    );
    expect(document.getElementById("model-help")).toHaveTextContent(
      "Use the exact model identifier supported by your service.",
    );
    expect(screen.getByRole("switch", { name: /Encrypt stored key/ })).toBeChecked();
    const actions = [...document.querySelectorAll("main .actions button")];
    expect(actions.map((item) => item.textContent?.trim())).toEqual([
      "Save configuration",
      "Reload",
      "Discard changes",
      "Verify key access",
    ]);
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map(
      (item) => item.textContent?.trim(),
    )).toEqual(["⚙Configuration", "↺History", "☷Settings"]);
    expect(document.querySelector(".note strong")).toHaveTextContent(
      /^Security note$/,
    );
  });

  it("renders only the unsupported screen outside Tauri", async () => {
    ipc.isTauri.mockReturnValue(false);
    render(<App />);
    expect(screen.getByText("请在桌面应用中打开")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^请在桌面应用中打开$/,
    );
    expect(
      screen.getByText(
        "此界面需要 Tauri 原生后端。浏览器预览不会读取或写入你的配置。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});

describe("config badge and encryption preference", () => {
  it("flips the badge to unsaved while editing and back after saving", async () => {
    await ready();
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    await changeModel();
    expect(badge()).toHaveTextContent(/^未保存$/);
    expect(button("取消更改")).toBeEnabled();
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    expect(button("取消更改")).toBeDisabled();
  });

  it("shows plaintext storage for a saved plaintext config and edits back to encrypted", async () => {
    disk = { ...saved, encrypted: false };
    await ready();
    expect(badge()).toHaveTextContent(/^明文存储$/);
    expect(badge().className).toContain("warning");
    const toggle = screen.getByRole("switch", { name: /加密保存密钥/ });
    expect(toggle).not.toBeChecked();
    // Enabling encryption is the safe direction: no confirmation needed.
    await userEvent.click(toggle);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(badge()).toHaveTextContent(/^未保存$/);
    expect(badge().className).not.toContain("warning");
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    expect(savedRequest().encrypt).toBe(true);
  });

  it("shows the no-key badge and first-time helper without a saved key", async () => {
    disk = { ...saved, key_present: false };
    await ready();
    expect(badge()).toHaveTextContent(/^尚未保存密钥$/);
    expect(document.getElementById("key-help")).toHaveTextContent(
      "输入服务提供商签发的 API 密钥。",
    );
    expect(button("验证密钥读取")).toBeDisabled();
    expect(screen.getByRole("switch", { name: /加密保存密钥/ })).toBeChecked();
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请填写地址、模型及首次使用的密钥。",
    );
    expect(saveCalls()).toHaveLength(0);
  });

  it("keeps the safe encrypted default when the backend reports no key and plaintext", async () => {
    disk = { ...saved, key_present: false, encrypted: false };
    await ready();
    expect(screen.getByRole("switch", { name: /加密保存密钥/ })).toBeChecked();
    expect(badge()).toHaveTextContent(/^尚未保存密钥$/);
  });

  it("requires a confirmation to turn encryption off and keeps it on when declined", async () => {
    await ready();
    const toggle = screen.getByRole("switch", { name: /加密保存密钥/ });
    await userEvent.click(toggle);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "关闭加密将把 API 密钥以明文保存在磁盘，其他有文件访问权限的程序可能读取它。确定继续吗？",
    );
    expect(toggle).toBeChecked();
    await userEvent.click(button("返回"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    expect(saveCalls()).toHaveLength(0);

    await userEvent.click(toggle);
    await userEvent.click(button("继续"));
    expect(toggle).not.toBeChecked();
    expect(badge()).toHaveTextContent(/^未保存$/);
  });

  it("submits plaintext and clears the typed key after saving", async () => {
    await ready();
    await userEvent.type(keyInput(), "synthetic-plaintext-key");
    await userEvent.click(screen.getByRole("switch", { name: /加密保存密钥/ }));
    await userEvent.click(button("继续"));
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(savedRequest()).toMatchObject({
      api_key: "synthetic-plaintext-key",
      encrypt: false,
      expected_revision: "rev-1",
    });
    expect(keyInput()).toHaveValue("");
    expect(badge()).toHaveTextContent(/^明文存储$/);
    expect(button("取消更改")).toBeDisabled();
  });
});

describe("config status line", () => {
  it("shows the loading status and disables every control while reading", async () => {
    await ready();
    gateRead = true;
    await userEvent.click(button("重新加载"));
    expect(statusLine()).toHaveTextContent("正在读取…");
    expect(statusLine()).toHaveAttribute("role", "status");
    expect(button("保存配置")).toBeDisabled();
    expect(button("重新加载")).toBeDisabled();
    expect(field("API 地址")).toBeDisabled();
    expect(keyInput()).toBeDisabled();
    for (const item of within(screen.getByRole("navigation")).getAllByRole(
      "button",
    )) {
      expect(item).toBeDisabled();
    }
    gateRead = false;
    await act(async () => releaseRead?.());
    await waitFor(() => expect(statusLine()).toHaveTextContent(/^$/));
    expect(field("API 地址")).toBeEnabled();
  });

  it("reports a revision conflict as an alert without losing the draft", async () => {
    await ready();
    await changeModel();
    await userEvent.type(keyInput(), "synthetic-conflict-key");
    saveError = "CONFLICT";
    await userEvent.click(button("保存配置"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "配置已被其他进程修改。请重新加载后再编辑。",
    );
    expect(field("模型名称")).toHaveValue("draft-model");
    expect(keyInput()).toHaveValue("synthetic-conflict-key");
    expect(badge()).toHaveTextContent(/^未保存$/);
    expect(saveCalls()).toHaveLength(1);
  });

  it("reports read failures with an alert role and recovers through reload", async () => {
    readError = "IO";
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "无法读写配置。请检查文件权限、磁盘空间及文件是否被其他程序占用。 无法读取配置。请重试；读取成功前不会覆盖现有配置。",
    );
    expect(alert.className).toContain("error");
    expect(button("保存配置")).toBeDisabled();
    expect(keyInput()).toBeDisabled();
    expect(button("重新加载")).toBeEnabled();
    readError = undefined;
    await userEvent.click(button("重新加载"));
    await waitFor(() => expect(field("模型名称")).toHaveValue(saved.model));
    expect(statusLine()).toHaveTextContent(/^$/);
    expect(statusLine()).toHaveAttribute("role", "status");
  });

  it("maps key verification failures to localized alerts and returns to status", async () => {
    await ready();
    checkError = "KEY_MISSING";
    await userEvent.click(button("验证密钥读取"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "加密密钥在系统凭据存储中缺失。请恢复原凭据存储，或输入新的 API 密钥并保存。",
    );
    checkError = undefined;
    await userEvent.click(button("验证密钥读取"));
    await screen.findByText("密钥可正常读取。");
    expect(statusLine()).toHaveAttribute("role", "status");
  });

  it.each([
    ["DECRYPT_FAILED", "无法解密密钥。请检查系统凭据存储，或输入新密钥后保存。"],
    ["VAULT_LOCKED", "系统凭据存储不可用。请解锁或启用系统钥匙串后重试。"],
    ["UNMAPPED_CODE", "操作失败，请重试。"],
  ])("maps %s to its copy", async (code, copy) => {
    await ready();
    checkError = code;
    await userEvent.click(button("验证密钥读取"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy);
    expect(alert).not.toHaveTextContent(code);
  });

  it("reports saving state on the submit button and blocks controls", async () => {
    await ready();
    await changeModel();
    gateSave = true;
    await userEvent.click(button("保存配置"));
    expect(button("正在保存…")).toBeDisabled();
    expect(statusLine()).toHaveTextContent("正在保存…");
    expect(button("重新加载")).toBeDisabled();
    expect(button("取消更改")).toBeDisabled();
    expect(button("设置")).toBeDisabled();
    expect(field("模型名称")).toBeDisabled();
    gateSave = false;
    await act(async () => releaseSave?.());
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    await screen.findByText("配置已安全提交。");
  });
});

describe("config dirty guard and dialog", () => {
  it("keeps the draft when navigation is declined and restores saved values when accepted", async () => {
    await ready();
    await changeModel();
    await userEvent.type(keyInput(), "synthetic-guard-key");
    const reads = readCalls().length;
    await userEvent.click(button("历史记录"));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "有未保存的更改，确定放弃吗？",
    );
    await userEvent.click(button("返回"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(field("模型名称")).toHaveValue("draft-model");
    expect(keyInput()).toHaveValue("synthetic-guard-key");
    expect(readCalls()).toHaveLength(reads);

    await userEvent.click(button("历史记录"));
    await userEvent.click(button("继续"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "每次变更，有据可查",
      ),
    );
    await userEvent.click(button("配置"));
    await waitFor(() => expect(field("模型名称")).toHaveValue(saved.model));
    expect(keyInput()).toHaveValue("");
    expect(badge()).toHaveTextContent(/^密钥加密$/);
  });

  it("does not prompt when the already active nav item is clicked", async () => {
    await ready();
    await changeModel();
    await userEvent.type(keyInput(), "synthetic-guard-key");
    const reads = readCalls().length;
    await userEvent.click(button("配置"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(field("模型名称")).toHaveValue("draft-model");
    expect(keyInput()).toHaveValue("synthetic-guard-key");
    expect(readCalls()).toHaveLength(reads);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "连接你的 AI 服务",
    );
  });

  it("guards reload and cancel-changes behind the same prompt", async () => {
    await ready();
    await changeModel();
    const reads = readCalls().length;
    await userEvent.click(button("重新加载"));
    await userEvent.click(button("返回"));
    expect(readCalls()).toHaveLength(reads);
    expect(field("模型名称")).toHaveValue("draft-model");

    await userEvent.type(keyInput(), "synthetic-cancel-key");
    await userEvent.click(button("取消更改"));
    await userEvent.click(button("继续"));
    expect(field("模型名称")).toHaveValue(saved.model);
    expect(keyInput()).toHaveValue("");
    expect(button("取消更改")).toBeDisabled();
    expect(saveCalls()).toHaveLength(0);
  });

  it("marks the confirmation as a modal labelled dialog with 返回 autofocused", async () => {
    await ready();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    await userEvent.click(screen.getByRole("switch", { name: /加密保存密钥/ }));
    const dialog = screen.getByRole("dialog");
    expect(showModal).toHaveBeenCalled();
    expect(dialog).toHaveAttribute("aria-labelledby", "confirm-title");
    expect(document.getElementById("confirm-title")).toHaveTextContent(
      /^请确认$/,
    );
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((item) => item.textContent?.trim())).toEqual([
      "返回",
      "继续",
    ]);
    expect(button("返回")).toHaveFocus();
  });

  it("cancels with Escape and returns focus to the triggering control", async () => {
    await ready();
    await changeModel();
    await userEvent.click(button("历史记录"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-labelledby", "confirm-title");
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button("历史记录")).toHaveFocus();
    expect(field("模型名称")).toHaveValue("draft-model");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "连接你的 AI 服务",
    );
  });

  it("returns focus to the encryption switch after declining the plaintext prompt", async () => {
    await ready();
    const toggle = screen.getByRole("switch", { name: /加密保存密钥/ });
    await userEvent.click(toggle);
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(toggle).toHaveFocus();
    expect(toggle).toBeChecked();
  });
});

describe("config validation", () => {
  it("requires url, model and the first key without calling config_save", async () => {
    disk = { ...firstRun };
    await ready();
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请填写地址、模型及首次使用的密钥。",
    );
    expect(saveCalls()).toHaveLength(0);

    await userEvent.type(field("API 地址"), "https://ui.example/v1");
    await userEvent.type(field("模型名称"), "ui-model");
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请填写地址、模型及首次使用的密钥。",
    );
    expect(saveCalls()).toHaveLength(0);
  });

  it("sends the trimmed first-run values with the missing revision", async () => {
    disk = { ...firstRun };
    await ready();
    await userEvent.type(field("API 地址"), "https://ui.example/v1");
    await userEvent.type(field("模型名称"), "  ui-model  ");
    await userEvent.type(keyInput(), "synthetic-first-key");
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(savedRequest()).toEqual({
      base_url: "https://ui.example/v1",
      model: "ui-model",
      api_key: "synthetic-first-key",
      encrypt: true,
      expected_revision: "missing",
    });
    expect(keyInput()).toHaveValue("");
    expect(badge()).toHaveTextContent(/^密钥加密$/);
    expect(button("验证密钥读取")).toBeEnabled();
  });

  it.each([
    "https://user:password@app.example/v1",
    "https://app.example/v1?token=1",
    "https://app.example/v1#fragment",
    "ftp://app.example/v1",
    "javascript:alert(1)",
  ])("rejects the prohibited url %s before any IPC save", async (url) => {
    await ready();
    await userEvent.clear(field("API 地址"));
    await userEvent.type(field("API 地址"), url);
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请输入不含凭据、查询参数或片段的 HTTP(S) 地址。",
    );
    expect(saveCalls()).toHaveLength(0);
  });

  it("rejects an empty url even when the model is filled in", async () => {
    await ready();
    await userEvent.clear(field("API 地址"));
    await userEvent.click(button("保存配置"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请填写地址、模型及首次使用的密钥。",
    );
    expect(saveCalls()).toHaveLength(0);
  });

  it("never pre-fills the saved key and nulls api_key when the field is blank", async () => {
    await ready();
    expect(keyInput()).toHaveValue("");
    expect(keyInput().getAttribute("value") ?? "").toBe("");
    const savedKey = "saved-key-value-never-rendered";
    expect(document.body.innerHTML).not.toContain(savedKey);
    await userEvent.click(button("保存配置"));
    await screen.findByText("配置已安全提交。");
    expect(savedRequest()).toMatchObject({
      api_key: null,
      expected_revision: "rev-1",
    });
    expect(keyInput()).toHaveValue("");
  });
});

describe("config key verification", () => {
  it("shows the verifying state and the success copy without saving", async () => {
    await ready();
    await changeModel();
    await userEvent.type(keyInput(), "synthetic-unsaved-key");
    let releaseCheck: (() => void) | null = null;
    ipc.invoke.mockImplementationOnce(
      (command: string) =>
        command === "config_check"
          ? new Promise<void>((resolve) => {
              releaseCheck = resolve;
            })
          : Promise.resolve(undefined),
    );
    await userEvent.click(button("验证密钥读取"));
    expect(statusLine()).toHaveTextContent("正在验证…");
    expect(button("验证密钥读取")).toBeDisabled();
    await act(async () => releaseCheck?.());
    await screen.findByText("密钥可正常读取。");
    expect(ipc.invoke).toHaveBeenCalledWith("config_check");
    expect(saveCalls()).toHaveLength(0);
    expect(field("模型名称")).toHaveValue("draft-model");
    expect(keyInput()).toHaveValue("synthetic-unsaved-key");
  });
});

// Documented defects: these assertions describe the expected behavior and fail
// on the current implementation, so the suite keeps them skipped.
describe("dialog focus restoration after discarding", () => {
  it("keeps focus inside the form when the trigger becomes disabled", async () => {
    await ready();
    await changeModel();
    await userEvent.click(button("取消更改"));
    await userEvent.click(button("继续"));
    expect(field("模型名称")).toHaveValue(saved.model);
    // CFGUI-01 fixed: the trigger is disabled once the draft is clean, so focus is
    // handed to a control that still exists instead of falling to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(button("保存配置"));
  });
});

describe("CFGUI-02 badge after a failed read", () => {
  it("does not claim there is no saved key when config_read failed", async () => {
    readError = "IO";
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.queryByText("尚未保存密钥")).not.toBeInTheDocument();
  });
});

describe("CFGUI-04 alert urgency", () => {
  it("does not downgrade an alert to polite", async () => {
    readError = "IO";
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveAttribute("aria-live", "polite");
  });
});
