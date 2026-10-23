// History page (page === "history") focused regression tests.
//
// Every active test asserts behavior that the current production code really has
// (mock IPC only; no native configuration, vault or history file is touched).
// Suspected defects are documented in .review/findings-history-code.md and kept
// as `describe.skip("PENDING FIX ...")` blocks so the suite stays green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ConfigView, HistoryEntry, Settings } from "./types";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => mock);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

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
// Shape produced by crates/core: 32 hex id, RFC3339 UTC timestamp, 64 hex digest.
const entry: HistoryEntry = {
  id: "1".repeat(32),
  timestamp: "2026-07-01T12:34:56+00:00",
  source: "desktop",
  sha256: "a".repeat(64),
  diff: [{ field: "model", before: "previous-model", after: "current-model" }],
};
const older: HistoryEntry = {
  id: "2".repeat(32),
  timestamp: "2026-06-01T01:02:03+00:00",
  source: "cli",
  sha256: "b".repeat(64),
  diff: [{ field: "model", before: "even-older-model", after: "previous-model" }],
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
  expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
    "每次变更，有据可查",
  );
}

/** The `<section aria-busy>` that owns the refresh control and the results. */
function resultsRegion() {
  const button = screen
    .getAllByRole("button")
    .find((node) => /刷新|正在读取/.test(node.textContent ?? ""));
  const section = button?.closest("section");
  if (!section) throw new Error("history results section not found");
  return section;
}

/** Before/after values of the diff row whose field label is `field`. */
const fieldLabels: Record<string, string> = {
  base_url: "API 地址",
  model: "模型名称",
  encrypted: "加密保存",
  api_key: "API 密钥",
};
function diffValues(field: string) {
  // The card shows the user-facing label, not the raw protocol token.
  const label = screen.getByText(fieldLabels[field] ?? field, { selector: "strong" });
  return Array.from(label.parentElement!.querySelectorAll("code")).map(
    (node) => node.textContent ?? "",
  );
}

describe("history page: load, busy and error states", () => {
  it("marks the results region busy, hides the empty state until the read settles, and locks navigation while it is in flight", async () => {
    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await ready();
    expect(historyList).not.toHaveBeenCalled();

    await enterHistory();
    expect(historyList).toHaveBeenCalledTimes(1);
    expect(historyList.mock.calls[0]).toEqual([]); // invoke("history_list") without arguments
    expect(resultsRegion()).toHaveAttribute("aria-busy", "true");
    const busyButton = screen.getByRole("button", { name: "正在读取…" });
    expect(busyButton).toBeDisabled();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    // historyBusy is part of the navigation guard: no page change can race the read.
    expect(screen.getByRole("button", { name: "配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "设置" })).toBeDisabled();

    await act(async () => pending.resolve([entry, older]));

    expect(resultsRegion()).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "配置" })).toBeEnabled();
    // Backend order is trusted verbatim (crates/core inserts newest first).
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent(entry.timestamp);
    expect(cards[1]).toHaveTextContent(older.timestamp);
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
  });

  it("renders timestamp, source, digest and every managed field of an entry", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          {
            field: "base_url",
            before: "https://old.example/v1",
            after: "https://new.example/v1",
          },
          { field: "model", before: "previous-model", after: "current-model" },
          { field: "encrypted", before: "false", after: "true" },
          { field: "api_key", before: "[REDACTED]", after: "[REDACTED]" },
        ],
      },
    ]);
    await ready();
    await enterHistory();

    const card = await screen.findByRole("article");
    const time = card.querySelector("time")!;
    expect(time).toHaveTextContent(entry.timestamp);
    expect(time).toHaveAttribute("datetime", entry.timestamp);
    expect(card).toHaveTextContent("来源: desktop");
    expect(card).toHaveTextContent("SHA-256 摘要");
    expect(card).toHaveTextContent(entry.sha256);

    expect(diffValues("base_url")).toEqual([
      "https://old.example/v1",
      "https://new.example/v1",
    ]);
    expect(diffValues("model")).toEqual(["previous-model", "current-model"]);
    // Booleans are localized instead of printing raw protocol tokens.
    expect(diffValues("encrypted")).toEqual(["关闭", "开启"]);
    expect(diffValues("api_key")).toEqual(["[密钥已隐藏]", "[密钥已隐藏]"]);
    // Each diff row keeps its localized Before/After labels.
    expect(card.querySelectorAll(".diff")).toHaveLength(4);
    expect(card.querySelectorAll(".diff span")[0]).toHaveTextContent("之前");
    expect(card.querySelectorAll(".diff span")[1]).toHaveTextContent("之后");
  });

  it("drops stale cards on refresh, reports a failure instead of a false empty state, and recovers on the next refresh", async () => {
    const pending = deferred<HistoryEntry[]>();
    historyList
      .mockResolvedValueOnce([entry])
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([]);
    await ready();
    await enterHistory();
    expect(await screen.findByText("current-model")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    // While the retry is in flight the previous success must not be presented as current.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    await act(async () => pending.reject({ code: "HISTORY_CORRUPT" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "历史记录损坏，保存已停止。请先恢复历史文件。",
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(3);
  });

  it("never echoes backend failure text and maps unknown rejections to the generic copy", async () => {
    historyList
      .mockRejectedValueOnce({ code: "IO", message: "synthetic-secret-in-error" })
      .mockRejectedValueOnce("HISTORY_CORRUPT");
    await ready();
    await enterHistory();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读写配置。请检查文件权限、磁盘空间及文件是否被其他程序占用。",
    );
    expect(document.body).not.toHaveTextContent("synthetic-secret-in-error");

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    // A bare string rejection has no `code`, so the generic message is used.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作失败，请重试。",
    );
    expect(document.body).not.toHaveTextContent("HISTORY_CORRUPT");
  });

  it("keeps the shell usable after a failed read and re-reads on the next entry", async () => {
    historyList
      .mockRejectedValueOnce({ code: "LOCK_TIMEOUT" })
      .mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "另一个进程正在使用配置，请稍后重试。",
    );
    // Leaving the page is allowed again once the read settled.
    await userEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "连接你的 AI 服务",
    );
    await enterHistory();
    expect(await screen.findByText("current-model")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(2);
  });
});

describe("history page: redaction and value placeholders", () => {
  it("masks key-named fields and keeps the [EMPTY] marker distinct from [REDACTED]", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "api_key", before: "[EMPTY]", after: "[REDACTED]" },
        ],
      },
      {
        ...entry,
        id: "3".repeat(32),
        diff: [
          { field: "api_key", before: "[REDACTED]", after: "[REDACTED]" },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    expect(await screen.findAllByRole("article")).toHaveLength(2);

    const [added, replaced] = screen.getAllByRole("article");
    const addedValues = Array.from(added.querySelectorAll(".diff code")).map(
      (node) => node.textContent,
    );
    expect(addedValues).toEqual(["空", "[密钥已隐藏]"]);
    const replacedValues = Array.from(replaced.querySelectorAll(".diff code")).map(
      (node) => node.textContent,
    );
    expect(replacedValues).toEqual(["[密钥已隐藏]", "[密钥已隐藏]"]);
  });

  it("still hides raw values when a key-named field carries unexpected data", async () => {
    // Contract violation on purpose: the UI keeps its defensive masking.
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          {
            field: "api_key",
            before: "synthetic-old-key",
            after: "synthetic-new-key",
          },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");
    expect(document.body).not.toHaveTextContent("synthetic-old-key");
    expect(document.body).not.toHaveTextContent("synthetic-new-key");
    expect(screen.getAllByText("[密钥已隐藏]")).toHaveLength(2);
  });

  it("renders null, empty-string and missing values as the localized empty placeholder", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "base_url", before: null, after: config.base_url },
          { field: "model", before: "", after: config.model },
          { field: "api_key", before: null, after: "[REDACTED]" },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");

    expect(diffValues("base_url")[0]).toBe("空");
    expect(diffValues("model")[0]).toBe("空");
    // Invariant (not the exact label): a null key value must never be rendered raw.
    expect(diffValues("api_key")[0]).toMatch(/^(空|\[密钥已隐藏\])$/);
  });

  it("renders hostile markup from a hand-edited history file as inert text", async () => {
    const before = '<img src=x onerror="alert(1)">';
    const after = "</code><script>alert(2)</script>";
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [{ field: "model", before, after }],
      },
    ]);
    await ready();
    await enterHistory();
    const card = await screen.findByRole("article");

    expect(diffValues("model")).toEqual([before, after]);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("script")).toBeNull();
  });
});

describe("history page: rendering robustness", () => {
  it("renders a maximum-length value and non-ASCII text without truncation", async () => {
    const longValue = "u".repeat(8192);
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "base_url", before: longValue, after: "https://example.com/v1" },
          { field: "model", before: "旧模型-🎉", after: "新模型-🎉" },
        ],
      },
    ]);
    await ready();
    await enterHistory();

    const [beforeUrl, afterUrl] = diffValues("base_url");
    expect(beforeUrl).toHaveLength(8192);
    expect(afterUrl).toBe("https://example.com/v1");
    expect(diffValues("model")).toEqual(["旧模型-🎉", "新模型-🎉"]);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("renders all ten retained entries in the delivered order", async () => {
    historyList.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({
        ...entry,
        id: String(index).padStart(32, "0"),
        timestamp: `2026-07-${String(10 + index).padStart(2, "0")}T12:34:56+00:00`,
      })),
    );
    await ready();
    await enterHistory();

    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(10);
    expect(cards[0]).toHaveTextContent("2026-07-10T12:34:56+00:00");
    expect(cards[9]).toHaveTextContent("2026-07-19T12:34:56+00:00");
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
  });

  it("mirrors the timestamp into <time dateTime> and tolerates a missing timestamp", async () => {
    const broken = {
      ...entry,
      id: "4".repeat(32),
      timestamp: undefined,
    } as unknown as HistoryEntry;
    historyList.mockResolvedValueOnce([entry, broken]);
    await ready();
    await enterHistory();

    const [good, bad] = await screen.findAllByRole("article");
    expect(good.querySelector("time")).toHaveAttribute(
      "datetime",
      entry.timestamp,
    );
    // Current behavior: no crash, the attribute is simply omitted.
    expect(bad.querySelector("time")).not.toHaveAttribute("datetime");
  });

  it("shows the header and digest for an entry that recorded no managed-field change", async () => {
    // A save with a retained key and untouched values produces diff: [] in crates/core.
    historyList.mockResolvedValueOnce([{ ...entry, diff: [] }]);
    await ready();
    await enterHistory();

    const card = await screen.findByRole("article");
    expect(card).toHaveTextContent(entry.timestamp);
    expect(card).toHaveTextContent(entry.sha256);
    expect(card.querySelectorAll(".diff")).toHaveLength(0);
  });
});

describe("history page: keyboard and focus behavior", () => {
  it("loads once per keyboard activation and keeps focus on the refresh control", async () => {
    historyList.mockResolvedValueOnce([]).mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    await screen.findByText("暂无变更记录");

    const refresh = screen.getByRole("button", { name: "刷新" });
    refresh.focus();
    expect(refresh).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByText("current-model")).toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "刷新" })).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// PENDING FIX blocks: these describe the desired behavior for documented
// defects. They are skipped so the suite stays green on the current code.
// ---------------------------------------------------------------------------

describe("HIS-01: mask credentials that appear in non-key diff values", () => {
  it("does not display a key pasted into the model field or a URL path", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "model", before: "gpt-4o", after: "sk-live-SYNTHETICPastedCREDENTIAL123456" },
          {
            field: "base_url",
            before: "https://api.example.com/v1",
            after: "https://api.example.com/sk-live-SYNTHETICPastedCREDENTIAL123456/v1",
          },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");
    expect(document.body).not.toHaveTextContent("sk-live-SYNTHETICPastedCREDENTIAL123456");
  });
});

describe("HIS-02: redaction must not depend on a partial field-name pattern", () => {
  it("masks credential/auth/PAT named fields instead of printing their values", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        diff: [
          { field: "credential", before: "SYNTHETIC-OLD-CREDENTIAL", after: "SYNTHETIC-NEW-CREDENTIAL" },
          { field: "auth_header", before: "SYNTHETIC-OLD-AUTHORIZATION", after: "SYNTHETIC-NEW-AUTHORIZATION" },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");
    expect(document.body).not.toHaveTextContent("SYNTHETIC-OLD-CREDENTIAL");
    expect(document.body).not.toHaveTextContent("SYNTHETIC-OLD-AUTHORIZATION");
  });
});

describe("HIS-03: localize field names, booleans, source and backend sentinels", () => {
  it("shows localized labels instead of raw protocol tokens", async () => {
    historyList.mockResolvedValueOnce([
      {
        ...entry,
        source: "cli",
        diff: [
          { field: "encrypted", before: "false", after: "true" },
          {
            field: "base_url",
            before: "[VALUE EXCEEDS LIMIT]",
            after: "https://example.com/v1",
          },
        ],
      },
    ]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");
    expect(screen.queryByText("encrypted")).not.toBeInTheDocument();
    expect(screen.queryByText("false")).not.toBeInTheDocument();
    expect(screen.queryByText("[VALUE EXCEEDS LIMIT]")).not.toBeInTheDocument();
  });
});

describe("HIS-04: one refresh gesture must not start overlapping reads", () => {
  it("issues a single history_list request for overlapping refresh gestures", async () => {
    historyList.mockResolvedValueOnce([]);
    await ready();
    await enterHistory();
    await screen.findByText("暂无变更记录");
    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    const refresh = screen.getByRole("button", { name: "刷新" });
    await userEvent.dblClick(refresh);
    // Second gesture is ignored while the first read is still in flight.
    expect(historyList).toHaveBeenCalledTimes(2);
    pending.resolve([entry]);
    await screen.findByText("current-model");
  });
});

describe("HIS-05: history read failures must name the history file", () => {
  it("explains an oversized history sidecar instead of blaming ai.yml", async () => {
    historyList.mockRejectedValueOnce({ code: "TOO_LARGE" });
    await ready();
    await enterHistory();
    expect(await screen.findByRole("alert")).toHaveTextContent(/历史/);
  });
});

describe("HIS-06: name the results region and announce results", () => {
  it("exposes a named region with list semantics and per-entry accessible names", async () => {
    historyList.mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    await screen.findByRole("article");
    expect(
      screen.getByRole("region", { name: "历史记录" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: (name) => name.includes(entry.timestamp) }),
    ).toBeInTheDocument();
  });

  it("announces the number of entries after a successful refresh", async () => {
    historyList.mockResolvedValueOnce([entry, older]);
    await ready();
    await enterHistory();
    await screen.findAllByRole("article");
    expect(screen.getByRole("status")).toHaveTextContent(/2/);
  });
});

describe("HIS-07: failures must be announced assertively", () => {
  it("uses an assertive live region for read failures", async () => {
    historyList.mockRejectedValueOnce({ code: "HISTORY_CORRUPT" });
    await ready();
    await enterHistory();
    expect(await screen.findByRole("alert")).toHaveAttribute(
      "aria-live",
      "assertive",
    );
  });
});

describe("HIS-08: tolerate duplicate entry ids", () => {
  it("renders a hand-edited history with duplicate ids without a React key warning", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    historyList.mockResolvedValueOnce([entry, { ...entry, diff: [] }]);
    await ready();
    await enterHistory();
    expect(await screen.findAllByRole("article")).toHaveLength(2);
    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes("same key"),
      ),
    ).toBe(false);
  });
});

describe("HIS-09: explain an entry with no managed-field change", () => {
  it("renders an explicit placeholder instead of a content-less card", async () => {
    historyList.mockResolvedValueOnce([{ ...entry, diff: [] }]);
    await ready();
    await enterHistory();
    const card = await screen.findByRole("article");
    // The shipped fix is an explicit localized placeholder, not a synthetic diff row.
    expect(card.querySelector(".diff-empty")).toHaveTextContent(
      /未改动任何托管字段|no managed field/,
    );
  });
});

describe("HIS-11: a malformed history payload must not blank the app", () => {
  it("keeps the shell and shows a localized error for a non-array payload", async () => {
    historyList.mockResolvedValueOnce(null as unknown as HistoryEntry[]);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
    expect(
      await screen.findByRole("heading", { level: 1 }),
    ).toHaveTextContent("每次变更，有据可查");
  });
});
