// Config page (`page === "config"`) regression tests.
// Every IPC call is mocked and every credential below is synthetic: these tests never
// read or write a real configuration file and never touch the system credential store.
//
// The `PENDING FIX` block at the bottom is intentionally skipped. It encodes the
// behaviour the findings file (.review/findings-config-code.md) asks for; each of those
// tests currently fails against src/App.tsx, so it must stay skipped until the fix lands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ConfigView } from "./types";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

type SaveRequest = {
  base_url: string;
  model: string;
  api_key: string | null;
  encrypt: boolean;
  expected_revision: string;
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

const saved: ConfigView = {
  exists: true,
  base_url: "https://review.example/v1",
  model: "review-model",
  key_present: true,
  encrypted: true,
  revision: "revision-1",
};

/** What the mock backend would read back from disk. */
let disk: ConfigView;
/** Error code thrown by `config_read` (undefined = success). */
let readError: string | undefined;
/** Error code thrown by `config_save` (undefined = success). */
let saveError: string | undefined;
/** Error code thrown by `config_check` (undefined = success). */
let checkError: string | undefined;
/** Requests that reached `config_save`, in submission order. */
let saves: SaveRequest[];
/** Number of `config_save` results already produced, used to mint revisions. */
let commits: number;
/** Optional gate that keeps `settings_read` pending (simulates a slow native preference read). */
let settingsGate: Promise<void> | undefined;

beforeEach(() => {
  disk = { ...saved };
  readError = saveError = checkError = undefined;
  saves = [];
  commits = 0;
  settingsGate = undefined;
  ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(
    async (command: string, args?: { request: SaveRequest }) => {
      if (command === "settings_read") {
        if (settingsGate) await settingsGate;
        return preferences;
      }
      if (command === "history_list") return [];
      if (command === "config_read") {
        if (readError) throw { code: readError, message: "synthetic-detail" };
        return { ...disk };
      }
      if (command === "config_check") {
        if (checkError) throw { code: checkError, message: "synthetic-detail" };
        return null;
      }
      if (command === "config_save") {
        const request = args!.request;
        saves.push({ ...request });
        if (saveError) throw { code: saveError, message: "synthetic-detail" };
        if (request.expected_revision !== disk.revision)
          throw { code: "CONFLICT", message: "synthetic-detail" };
        commits += 1;
        disk = {
          exists: true,
          base_url: request.base_url,
          model: request.model,
          key_present: true,
          encrypted: request.encrypt,
          revision: `revision-${commits + 1}`,
        };
        return { ...disk };
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const urlField = () => screen.getByLabelText("API 地址");
const modelField = () => screen.getByLabelText("模型名称");
const keyField = () => screen.getByLabelText("API 密钥");
const encryptionSwitch = () => screen.getByRole("switch");
const statusline = () => document.querySelector(".status") as HTMLElement;
const badge = () => document.querySelector(".badge") as HTMLElement;

async function ready() {
  render(<App />);
  await waitFor(() => expect(button("保存配置")).toBeEnabled());
}

function change(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

async function submit() {
  await userEvent.click(button("保存配置"));
}

describe("config page: frontend/backend validation parity", () => {
  it("sends a base URL whose query or fragment delimiter is empty", async () => {
    await ready();
    for (const value of ["https://review.example/v1?", "https://review.example/v1#"]) {
      saves = [];
      change(urlField(), value);
      await submit();
      await waitFor(() => expect(saves).toHaveLength(1));
      // new URL("…?")/("…#") exposes search/hash as "" so the guard passes, but
      // crates/core/src/config.rs validate() sees Some(query)/Some(fragment) and
      // answers INVALID_URL. The user sees the "no credentials/query/fragment" copy.
      expect(saves[0].base_url).toBe(value);
      await waitFor(() => expect(button("保存配置")).toBeEnabled());
    }
  });

  it("sends a base URL with an interior tab that the core rejects as a control character", async () => {
    await ready();
    change(urlField(), "https://exa\tmple.com/v1");
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    // `new URL` strips tabs, so the browser-side guard accepts; Rust checks
    // `url.chars().any(char::is_control)` on the raw string and rejects INVALID_URL.
    expect(saves[0].base_url).toBe("https://exa\tmple.com/v1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("normalizes the API key exactly like the URL and model", async () => {
    await ready();
    change(modelField(), "  spaced-model  ");
    change(keyField(), "  synthetic-spaced-key  ");
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].model).toBe("spaced-model");
    // CFG-04 fixed: a key that picked up paste padding is trimmed, so the value
    // sent upstream by any Store::with_secret consumer stays usable.
    expect(saves[0].api_key).toBe("synthetic-spaced-key");
  });

  it("raises the first-time 'required' notice for a whitespace-only key", async () => {
    disk = {
      exists: false,
      base_url: "",
      model: "",
      key_present: false,
      encrypted: false,
      revision: "missing",
    };
    await ready();
    change(urlField(), "https://review.example/v1");
    change(modelField(), "review-model");
    change(keyField(), "   ");
    await submit();
    // CFG-04 fixed: a whitespace-only first key is "missing", so the localized
    // required copy is used instead of a generic backend invalid-field message.
    expect(saves).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/请填写地址、模型及首次使用的密钥/);
  });

  it("rejects a model consisting only of a zero-width space", async () => {
    await ready();
    change(modelField(), "​");
    await submit();
    // CFG-06 fixed: invisible format characters count as blank, so nothing is sent.
    expect(saves).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/请填写地址、模型/);
  });
});

describe("config page: form submission", () => {
  it("reports an unparseable URL through the app's own localized validation", async () => {
    await ready();
    change(urlField(), "review.example/v1");
    await submit();
    // CFG-01 fixed: the form is noValidate, so the app's own check runs and the
    // localized message reaches the live region instead of a browser bubble.
    expect(saves).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/请输入不含凭据、查询参数或片段的 HTTP\(S\) 地址/);
    expect(ipc.invoke.mock.calls.filter(([c]) => c === "config_save")).toHaveLength(0);
  });
});

describe("config page: dirty tracking and revision handling", () => {
  it("treats a trailing-space edit as dirty and normalizes it away on save", async () => {
    await ready();
    expect(button("取消更改")).toBeDisabled();
    expect(badge()).toHaveTextContent("密钥加密");
    change(modelField(), "review-model ");
    expect(badge()).toHaveTextContent("未保存");
    expect(button("取消更改")).toBeEnabled();
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].model).toBe("review-model");
    await waitFor(() => expect(button("取消更改")).toBeDisabled());
  });

  it("saves a clean form (revision churn with an empty history diff)", async () => {
    await ready();
    expect(saves).toHaveLength(0);
    await submit();
    await screen.findByText("配置已安全提交。");
    expect(saves[0]).toEqual({
      base_url: "https://review.example/v1",
      model: "review-model",
      api_key: null,
      encrypt: true,
      expected_revision: "revision-1",
    });
  });

  it("requires reload after CONFLICT, then discards against the refreshed baseline", async () => {
    await ready();
    change(modelField(), "draft-model");
    disk = { ...disk, model: "external-model", revision: "revision-external" };
    await submit();
    await screen.findByText(/配置已被其他进程修改/);
    expect(modelField()).toHaveValue("draft-model");
    // CFG-03 fixed: a conflicting draft can never silently overwrite the external
    // revision, and the refreshed baseline keeps the badge truthful.
    expect(button("保存配置")).toBeDisabled();
    expect(button("验证密钥读取")).toBeDisabled();
    expect(badge()).toHaveTextContent("未保存");

    // Discarding now restores the file that is actually on disk, so the editor is
    // clean AND saveable instead of looking synced against a stale revision.
    await userEvent.click(button("取消更改"));
    await userEvent.click(button("继续"));
    expect(modelField()).toHaveValue("external-model");
    expect(button("取消更改")).toBeDisabled();
    expect(button("保存配置")).toBeEnabled();
    expect(badge()).toHaveTextContent("密钥加密");

    saves = [];
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].expected_revision).toBe("revision-external");
  });

  it("keeps the draft when a pre-write failure races an external edit", async () => {
    await ready();
    change(modelField(), "draft-model");
    change(keyField(), "synthetic-unsaved-key");
    // VAULT_UNAVAILABLE is documented as "the configuration was not replaced".
    saveError = "VAULT_UNAVAILABLE";
    disk = { ...disk, model: "external-model", revision: "revision-external" };
    await submit();
    await screen.findByText(/系统凭据存储不可用/);
    // CFG-02 fixed: a failure that provably wrote nothing keeps the user's work and
    // does not claim the commit outcome is unknown.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/无法确认此次提交是否完成/);
    expect(keyField()).toHaveValue("synthetic-unsaved-key");
    expect(modelField()).toHaveValue("draft-model");
    expect(button("取消更改")).toBeEnabled();
    expect(button("保存配置")).toBeDisabled();
  });

  it("shows no key-state badge after a failed reload instead of claiming 'no saved key'", async () => {
    await ready();
    change(keyField(), "synthetic-unsaved-key");
    readError = "IO";
    await userEvent.click(button("重新加载"));
    await userEvent.click(button("继续"));
    await screen.findByText(/无法读写配置/);
    // config === null: the form is disabled and the discarded replacement key is
    // cleared. CFG-08 fixed: with nothing known, the badge makes no claim at all.
    // CFG-09 fixed: a failed read clears the editor instead of showing a stale
    // snapshot as the current configuration.
    expect(modelField()).toHaveValue("");
    expect(modelField()).toBeDisabled();
    expect(keyField()).toHaveValue("");
    expect(document.querySelector(".badge")).toBeNull();
    expect(button("保存配置")).toBeDisabled();
  });

  it("ignores a second submit while a save is in flight", async () => {
    await ready();
    change(modelField(), "draft-model");
    let finish!: (value: ConfigView) => void;
    ipc.invoke.mockImplementationOnce(
      (command: string, args: { request: SaveRequest }) => {
        saves.push({ ...args.request });
        return new Promise<ConfigView>((resolve) => (finish = resolve));
      },
    );
    await submit();
    expect(button("正在保存…")).toBeDisabled();
    fireEvent.submit(modelField().closest("form")!);
    await act(async () => {
      finish({ ...disk, model: "draft-model", revision: "revision-2" });
    });
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(saves).toHaveLength(1);
    expect(modelField()).toHaveValue("draft-model");
  });

  it("blocks 'verify key access' while a save is in flight", async () => {
    await ready();
    let finish!: (value: ConfigView) => void;
    ipc.invoke.mockImplementationOnce(
      (command: string, args: { request: SaveRequest }) => {
        saves.push({ ...args.request });
        return new Promise<ConfigView>((resolve) => (finish = resolve));
      },
    );
    await submit();
    expect(button("验证密钥读取")).toBeDisabled();
    await act(async () => {
      finish({ ...disk });
    });
    await waitFor(() => expect(button("验证密钥读取")).toBeEnabled());
    expect(
      ipc.invoke.mock.calls.filter(([command]) => command === "config_check"),
    ).toHaveLength(0);
  });
});

describe("config page: page-local busy state", () => {
  it("locks config editing while an unrelated settings read is still pending", async () => {
    let open!: () => void;
    settingsGate = new Promise<void>((resolve) => (open = resolve));
    render(<App />);
    await screen.findByDisplayValue("https://review.example/v1");
    // uiBusy = busy || settingsBusy: the config form, its actions and the nav all wait
    // for a native preferences read that has nothing to do with the configuration.
    expect(button("保存配置")).toBeDisabled();
    expect(modelField()).toBeDisabled();
    expect(encryptionSwitch()).toBeDisabled();
    await act(async () => {
      open();
      await settingsGate;
    });
    await waitFor(() => expect(button("保存配置")).toBeEnabled());
    expect(modelField()).toBeEnabled();
  });
});

describe("config page: credential handling", () => {
  it("never sends a key the user did not type, and never repopulates the field", async () => {
    await ready();
    expect(keyField()).toHaveValue("");
    change(modelField(), "review-model-2");
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].api_key).toBeNull();
    expect(keyField()).toHaveValue("");
  });

  it("keeps the typed key inside the password field and after a definite failure", async () => {
    await ready();
    const secret = "synthetic-leak-canary";
    change(keyField(), secret);
    saveError = "KEY_MISSING";
    await submit();
    await screen.findByRole("alert");
    expect(keyField()).toHaveValue(secret);
    // The value attribute of the password field itself is expected; nothing
    // else in the rendered page (status, badge, notes) may echo the secret.
    const withoutField = document.body.innerHTML.replace(
      keyField().outerHTML,
      "",
    );
    expect(withoutField).not.toContain(secret);
    expect(screen.getByRole("alert")).not.toHaveTextContent(secret);
    expect(screen.getByRole("alert")).not.toHaveTextContent("synthetic-detail");
    expect(screen.getByRole("alert")).toHaveTextContent(/加密密钥在系统凭据存储中缺失/);
  });

  it("writes a new key in plaintext without asking when the toggle is untouched", async () => {
    disk = { ...disk, encrypted: false };
    await ready();
    expect(encryptionSwitch()).not.toBeChecked();
    expect(badge()).toHaveTextContent("明文存储");
    change(keyField(), "synthetic-plaintext-key");
    await submit();
    await waitFor(() => expect(saves).toHaveLength(1));
    // t.plainPrompt only runs on the switch transition, so a configuration that is
    // already plaintext on disk persists new secrets without any confirmation step.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saves[0]).toMatchObject({
      encrypt: false,
      api_key: "synthetic-plaintext-key",
    });
  });

  it("clears the key after a committed save and after HISTORY_PENDING", async () => {
    await ready();
    change(keyField(), "synthetic-first-key");
    await submit();
    await screen.findByText("配置已安全提交。");
    expect(keyField()).toHaveValue("");

    change(keyField(), "synthetic-second-key");
    saveError = "HISTORY_PENDING";
    await submit();
    await screen.findByText(/配置已保存，历史记录仍待恢复核对/);
    expect(keyField()).toHaveValue("");
  });
});

describe("config page: error mapping", () => {
  it.each([
    ["IO", /无法读写配置/],
    ["LOCK_TIMEOUT", /另一个进程正在使用配置/],
    ["UNSAFE_PATH", /配置路径不安全/],
    ["TOO_LARGE", /2 MiB/],
    ["ENCRYPT_FAILED", /未自动降级为明文/],
    ["INVALID_CONFIG", /配置格式或字段无效/],
    ["INVALID_URL", /不含凭据/],
    ["INVALID_MODEL", /模型名称无效/],
    ["INVALID_KEY", /API 密钥无效/],
    ["HISTORY_CORRUPT", /历史记录损坏/],
    ["COMMIT_UNCERTAIN", /无法确认配置写入结果/],
    ["WORKER_FAILED", /操作失败，请重试/],
    ["SOMETHING_NEW", /操作失败，请重试/],
  ])("localizes config_read %s without echoing backend text", async (code, expected) => {
    readError = code;
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert).not.toHaveTextContent("synthetic-detail");
    expect(button("保存配置")).toBeDisabled();
  });

  it.each([
    ["VAULT_UNAVAILABLE", /系统凭据存储不可用/],
    ["KEY_MISSING", /加密密钥在系统凭据存储中缺失/],
    ["DECRYPT_FAILED", /无法解密密钥/],
  ])("maps config_check %s to credential recovery copy", async (code, expected) => {
    await ready();
    checkError = code;
    await userEvent.click(button("验证密钥读取"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert).not.toHaveTextContent("synthetic-detail");
  });
});

describe("config page: accessibility", () => {
  it("points every described-by id at a rendered help node and names the switch", async () => {
    await ready();
    for (const [field, help] of [
      [urlField(), "base-help"],
      [keyField(), "key-help"],
      [modelField(), "model-help"],
    ] as const) {
      expect(field).toHaveAttribute("aria-describedby", help);
      expect(document.getElementById(help)).toHaveTextContent(/\S/);
    }
    expect(encryptionSwitch()).toHaveAccessibleName(/加密保存密钥/);
    expect(encryptionSwitch()).toBeChecked();
    expect(keyField()).toHaveAttribute("autoComplete", "new-password");
    expect(keyField()).toHaveAttribute("type", "password");
  });

  it("names the confirmation dialog and exposes the message as its description", async () => {
    await ready();
    await userEvent.click(encryptionSwitch());
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("请确认");
    // CFG-11 fixed: the question itself is the dialog's accessible description.
    expect(dialog).toHaveAttribute("aria-describedby", "confirm-message");
    expect(dialog).toHaveAccessibleDescription(/明文/);
  });

  it("returns focus to the encryption switch when the dialog is cancelled with Escape", async () => {
    await ready();
    await userEvent.click(encryptionSwitch());
    // jsdom does not dispatch the browser's native cancel event itself.
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(encryptionSwitch()).toBeChecked();
    expect(encryptionSwitch()).toHaveFocus();
  });

  it("announces errors assertively while ordinary status stays polite", async () => {
    await ready();
    expect(statusline()).toHaveAttribute("role", "status");
    expect(statusline()).toHaveAttribute("aria-live", "polite");
    saveError = "IO";
    await submit();
    await waitFor(() => expect(statusline()).toHaveAttribute("role", "alert"));
    // CFG-10 fixed: an explicit aria-live="polite" used to override role="alert"'s
    // implicit assertive politeness, downgrading every failure announcement.
    expect(statusline()).toHaveAttribute("aria-live", "assertive");
    expect(statusline()).toHaveTextContent(/无法读写配置/);
  });
});
