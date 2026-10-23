// History page UI verification. Synthetic data and mocked IPC only; no native
// configuration, credential store, autostart entry, or history file is touched.
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
import type { ConfigView, HistoryEntry, Settings } from "./types";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => mock);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const config: ConfigView = {
  exists: true,
  base_url: "https://example.com/v1",
  model: "review-model",
  key_present: true,
  encrypted: true,
  revision: "synthetic-revision",
};
const settings: Settings = {
  silent_start: false,
  close_to_tray: true,
  language: "zh",
  autostart: false,
  autostart_known: true,
  version: "0.1.0",
  platform: "windows",
  tray_available: true,
};
const entry: HistoryEntry = {
  id: "1".repeat(32),
  timestamp: "2026-07-01T12:34:56+00:00",
  source: "desktop",
  sha256: "a".repeat(64),
  diff: [
    {
      field: "model",
      before: "previous-model",
      after: "current-model",
    },
  ],
};

let historyList: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  historyList = vi.fn().mockResolvedValue([]);
  mock.isTauri.mockReturnValue(true);
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (command: string) => {
    if (command === "config_read") return config;
    if (command === "settings_read") return settings;
    if (command === "history_list") return historyList();
    throw new Error(`Unexpected mocked command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function ready() {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
}

async function enterHistory() {
  await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "每次变更，有据可查",
    }),
  ).toBeInTheDocument();
}

function historySection() {
  const section = document.querySelector("section[aria-busy]");
  if (!section) throw new Error("history section not rendered");
  return section;
}

function diffValues(field: string, scope: ParentNode = document) {
  const row = scope.querySelector(
    `.diff strong[data-field="${field}"]`,
  )?.parentElement;
  const target =
    row ??
    Array.from(scope.querySelectorAll(".diff strong")).find(
      (node) => node.textContent === field,
    )?.parentElement;
  if (!target) throw new Error(`diff row not found: ${field}`);
  return Array.from(target.querySelectorAll("code")).map(
    (node) => node.textContent,
  );
}

describe("history page UI inventory", () => {
  it("renders the active nav state, localized header, and refresh control", async () => {
    historyList.mockResolvedValueOnce([]);
    await ready();

    expect(screen.getByRole("button", { name: "配置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "历史记录" }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "设置" })).not.toHaveAttribute(
      "aria-current",
    );

    await enterHistory();

    expect(screen.getByText("历史记录", { selector: ".eyebrow" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "每次变更，有据可查" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("仅展示脱敏差异与完整性摘要，不展示密钥。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "历史记录" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "配置" })).not.toHaveAttribute(
      "aria-current",
    );

    // A successful empty load is the only state that shows the empty card.
    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(
      screen.getByText("保存配置后，记录将出现在这里。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(historySection()).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("exposes a busy section, a disabled loading refresh button, and disabled nav while history loads", async () => {
    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await ready();
    await enterHistory();

    expect(screen.getByRole("button", { name: "正在读取…" })).toBeDisabled();
    for (const name of ["配置", "历史记录", "设置"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(historySection()).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve([]));

    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(historySection()).toHaveAttribute("aria-busy", "false");
    for (const name of ["配置", "历史记录", "设置"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("re-invokes history_list from refresh and replaces the prior results", async () => {
    historyList.mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    await screen.findByText("current-model");
    expect(historyList).toHaveBeenCalledTimes(1);

    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(screen.getByRole("button", { name: "正在读取…" })).toBeDisabled();
    expect(historySection()).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("current-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(2);

    await act(async () =>
      pending.resolve([
        {
          ...entry,
          id: "9".repeat(32),
          diff: [
            {
              field: "model",
              before: "current-model",
              after: "refreshed-model",
            },
          ],
        },
      ]),
    );

    expect(await screen.findByText("refreshed-model")).toBeInTheDocument();
    expect(screen.queryByText("previous-model")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(historySection()).toHaveAttribute("aria-busy", "false");
  });

  it("renders one keyed article per entry with time, source badge, diff blocks, and digest", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          {
            field: "base_url",
            before: "https://old.example/v1",
            after: "https://new.example/v1",
          },
          {
            field: "model",
            before: "previous-model",
            after: "current-model",
          },
          {
            field: "api_key",
            before: "[REDACTED]",
            after: "[REDACTED]",
          },
        ],
      },
    ]);
    await ready();
    await enterHistory();

    const article = await screen.findByRole("article");
    expect(article.tagName).toBe("ARTICLE");
    expect(article).toHaveClass("card", "history-entry");
    expect(screen.getAllByRole("article")).toHaveLength(1);

    const time = article.querySelector("time");
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute("datetime", entry.timestamp);
    expect(time).toHaveTextContent(entry.timestamp);

    expect(
      within(article).getByText(/来源:\s*desktop/),
    ).toBeInTheDocument();
    expect(article.querySelectorAll(".diff")).toHaveLength(3);
    expect(diffValues("base_url", article)).toEqual([
      "https://old.example/v1",
      "https://new.example/v1",
    ]);
    expect(diffValues("model", article)).toEqual([
      "previous-model",
      "current-model",
    ]);
    expect(diffValues("api_key", article)).toEqual([
      "[密钥已隐藏]",
      "[密钥已隐藏]",
    ]);

    expect(within(article).getByText("SHA-256 摘要")).toBeInTheDocument();
    const digest = article.querySelector(".digest code");
    expect(digest).not.toBeNull();
    expect(digest).toHaveTextContent(entry.sha256);
    expect(entry.sha256).toHaveLength(64);
  });

  it("localizes empty, null, [EMPTY], and sensitive values", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "base_url", before: null, after: "" },
          { field: "model", before: "", after: "m" },
          { field: "api_key", before: "[EMPTY]", after: "[REDACTED]" },
          { field: "api_secret", before: "raw-secret-value", after: null },
          { field: "encrypted", before: null, after: "true" },
        ],
      },
    ]);
    await ready();
    await enterHistory();

    const article = await screen.findByRole("article");
    expect(diffValues("base_url", article)).toEqual(["空", "空"]);
    expect(diffValues("model", article)).toEqual(["空", "m"]);
    expect(diffValues("api_key", article)).toEqual([
      "空",
      "[密钥已隐藏]",
    ]);
    // Any non-[EMPTY] value of a sensitive field is redacted, including null.
    expect(diffValues("api_secret", article)).toEqual([
      "[密钥已隐藏]",
      "[密钥已隐藏]",
    ]);
    expect(diffValues("encrypted", article)).toEqual(["空", "开启"]);
    expect(document.body).not.toHaveTextContent("raw-secret-value");
    expect(document.body).not.toHaveTextContent("[REDACTED]");
  });

  it("shows the mapped IO failure as an alert without stale entries or the empty card, then recovers", async () => {
    historyList
      .mockRejectedValueOnce({ code: "IO", message: "raw-backend-detail" })
      .mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读写配置");
    expect(alert).not.toHaveTextContent("raw-backend-detail");
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(historySection()).toHaveAttribute("aria-busy", "false");

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("current-model")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // HISUI-04 fixed: a successful refresh is announced instead of leaving the live
    // region silent.
    expect(screen.getByRole("status").textContent).toBe("已读取 1 条记录。");
    expect(historyList).toHaveBeenCalledTimes(2);
  });

  it("clears old entries before a failed refresh and keeps the empty card hidden", async () => {
    historyList.mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    await screen.findByText("current-model");

    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.queryByText("current-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();

    await act(async () => pending.reject({ code: "IO" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读写配置",
    );
    expect(screen.queryByText("current-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
  });

  it("shows the empty card after a failed load is followed by a successful empty load", async () => {
    historyList
      .mockRejectedValueOnce({ code: "IO" })
      .mockResolvedValueOnce([]);
    await ready();
    await enterHistory();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读写配置",
    );
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("历史记录已更新。");
  });

  it("shows the corrupt-history message for HISTORY_CORRUPT", async () => {
    historyList.mockRejectedValueOnce({
      code: "HISTORY_CORRUPT",
      message: "raw-corrupt-detail",
    });
    await ready();
    await enterHistory();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "历史记录损坏，保存已停止。请先恢复历史文件。",
    );
    expect(alert).not.toHaveTextContent("raw-corrupt-detail");
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
  });

  it("renders the English page copy and placeholders when the saved language is en", async () => {
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "config_read") return config;
      if (command === "settings_read")
        return { ...settings, language: "en" as const };
      if (command === "history_list")
        return [
          {
            ...entry,
            diff: [
              { field: "api_key", before: "[EMPTY]", after: "[REDACTED]" },
              {
                field: "base_url",
                before: "",
                after: "https://example.com/v1",
              },
            ],
          },
        ];
      throw new Error(`Unexpected mocked command: ${command}`);
    });
    render(<App />);
    await screen.findByDisplayValue(config.base_url);
    await userEvent.click(screen.getByRole("button", { name: "History" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Every change, accounted for",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Redacted changes and integrity digests only. Keys are never displayed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("History", { selector: ".eyebrow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(document.documentElement.lang).toBe("en");

    const article = await screen.findByRole("article");
    expect(within(article).getByText(/Source:\s*desktop/)).toBeInTheDocument();
    expect(within(article).getAllByText("Before")).toHaveLength(2);
    expect(within(article).getAllByText("After")).toHaveLength(2);
    expect(
      within(article).getByText("SHA-256 digest"),
    ).toBeInTheDocument();
    expect(diffValues("api_key", article)).toEqual([
      "Empty",
      "[Key hidden]",
    ]);
    expect(diffValues("base_url", article)).toEqual([
      "Empty",
      "https://example.com/v1",
    ]);
    expect(screen.queryByText("[REDACTED]")).not.toBeInTheDocument();
  });

  it("keeps full long values and the 64-character digest in the DOM", async () => {
    const longUrl = `https://example.com/${"very-long-".repeat(500)}tail`;
    const longModel = `model-${"x".repeat(3000)}`;
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "base_url", before: "", after: longUrl },
          { field: "model", before: null, after: longModel },
        ],
      },
    ]);
    await ready();
    await enterHistory();

    const article = await screen.findByRole("article");
    const values = diffValues("base_url", article).concat(
      diffValues("model", article),
    );
    expect(values[1]).toBe(longUrl);
    expect(values[3]).toBe(longModel);
    expect(values[1]).toHaveLength(longUrl.length);
    expect(values[3]).toHaveLength(longModel.length);

    const digest = article.querySelector(".digest code");
    expect(digest?.textContent).toHaveLength(64);
    expect(digest?.textContent).toBe(entry.sha256);
  });

  it("renders ten entries in returned order and leaves focus navigation untrapped", async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      ...entry,
      id: String(index).padStart(32, "0"),
      timestamp: `2026-07-${String(21 - index).padStart(2, "0")}T01:00:00+00:00`,
      diff: [
        {
          field: "model",
          before: `model-${index}`,
          after: `model-${index + 1}`,
        },
      ],
    }));
    historyList.mockResolvedValueOnce(entries);
    await ready();
    await enterHistory();

    const articles = await screen.findAllByRole("article");
    expect(articles).toHaveLength(10);
    expect(articles.map((article) => article.querySelector("time")?.textContent)).toEqual(
      entries.map((item) => item.timestamp),
    );

    for (const article of articles) {
      expect(article.tabIndex).toBe(-1);
      expect(
        article.querySelectorAll(
          "a, button, input, select, textarea, [tabindex]",
        ),
      ).toHaveLength(0);
    }

    screen.getByRole("button", { name: "设置" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "刷新" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    await userEvent.tab();
    expect(document.activeElement?.closest("article")).toBeNull();
  });

  it("disables the sidebar while a configuration save is in flight", async () => {
    const pending = deferred<ConfigView>();
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "config_read") return config;
      if (command === "settings_read") return settings;
      if (command === "config_save") return pending.promise;
      if (command === "history_list") return [];
      throw new Error(`Unexpected mocked command: ${command}`);
    });
    await ready();
    expect(screen.getByRole("button", { name: "配置" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    for (const name of ["配置", "历史记录", "设置"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();

    await act(async () => pending.resolve(config));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "配置" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "历史记录" })).toBeEnabled();
  });

  it("disables the sidebar while the initial configuration read is in flight", async () => {
    const pending = deferred<ConfigView>();
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "config_read") return pending.promise;
      if (command === "settings_read") return settings;
      if (command === "history_list") return [];
      throw new Error(`Unexpected mocked command: ${command}`);
    });
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "配置" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "历史记录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "设置" })).toBeDisabled();

    await act(async () => pending.resolve(config));
    await screen.findByDisplayValue(config.base_url);
    expect(screen.getByRole("button", { name: "历史记录" })).toBeEnabled();
  });

  it("disables the sidebar while a settings save is in flight", async () => {
    const pending = deferred<Settings>();
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "config_read") return config;
      if (command === "settings_read") return settings;
      if (command === "settings_save") return pending.promise;
      if (command === "history_list") return [];
      throw new Error(`Unexpected mocked command: ${command}`);
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByText("按你的方式运行");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));

    for (const name of ["配置", "历史记录", "设置"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }

    await act(async () => pending.resolve(settings));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "历史记录" })).toBeEnabled(),
    );
  });

  it("disables the sidebar while settings load in flight", async () => {
    const pending = deferred<Settings>();
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "config_read") return config;
      if (command === "settings_read") return pending.promise;
      if (command === "history_list") return [];
      throw new Error(`Unexpected mocked command: ${command}`);
    });
    await ready();
    expect(screen.getByRole("button", { name: "历史记录" })).toBeDisabled();
    await act(async () => pending.resolve(settings));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "历史记录" })).toBeEnabled(),
    );
  });

  it("guards navigation from dirty configuration and restores the draft on continue", async () => {
    historyList.mockResolvedValueOnce([]);
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "-draft");
    await userEvent.click(screen.getByRole("button", { name: "历史记录" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("有未保存的更改");
    expect(historyList).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue(
      "review-model-draft",
    );
    expect(screen.getByRole("button", { name: "配置" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue(config.model);
  });

  it("shows only the desktop-app fallback when Tauri is unavailable", () => {
    mock.isTauri.mockReturnValue(false);
    render(<App />);

    expect(screen.getByText("请在桌面应用中打开")).toBeInTheDocument();
    expect(screen.getByText(/此界面需要 Tauri 原生后端/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(mock.invoke).not.toHaveBeenCalled();
  });
});

describe("HISUI-01 credential-looking values in non-sensitive fields", () => {
  it("never prints credentials from base_url or model", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          {
            field: "base_url",
            before: "https://old.example/v1",
            after: "https://user:credential-leak-canary@host/v1",
          },
          {
            field: "model",
            before: "sk-live-raw-value",
            after: "model-2",
          },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByText("API 地址");

    expect(document.body).not.toHaveTextContent("credential-leak-canary");
    expect(document.body).not.toHaveTextContent("sk-live-raw-value");
  });
});

describe("HISUI-02 unnamed history region and entries", () => {
  it("gives the busy results region and each history entry an accessible name", async () => {
    historyList.mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");

    expect(historySection()).toHaveAccessibleName();
    expect(screen.getByRole("article")).toHaveAccessibleName();
  });
});

describe("HISUI-04 history status announcements", () => {
  it("announces loading and the result state in the live status region", async () => {
    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await ready();
    await enterHistory();

    expect(screen.getByRole("status")).toHaveTextContent("正在读取");
    await act(async () => pending.resolve([entry]));
    await screen.findByRole("article");
    expect(screen.getByRole("status").textContent).not.toBe("");
  });
});

describe("HISUI-03 [EMPTY] sentinel outside sensitive fields", () => {
  it("localizes [EMPTY] for every diff field, not only sensitive ones", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "base_url", before: "[EMPTY]", after: "https://example.com/v1" },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByText("API 地址");

    expect(diffValues("base_url")[0]).toBe("空");
  });
});
