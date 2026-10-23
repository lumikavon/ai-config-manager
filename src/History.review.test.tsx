// Review uses synthetic data and mocked IPC only; no native configuration is accessed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ConfigView, HistoryEntry, Settings } from "./types";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => mock);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const config: ConfigView = {
  exists: true, base_url: "https://example.com/v1", model: "review-model",
  key_present: true, encrypted: true, revision: "synthetic-revision",
};
const settings: Settings = {
  silent_start: false, close_to_tray: true, language: "zh", autostart: false,
  autostart_known: true, version: "0.1.0", platform: "windows", tray_available: true,
};
const entry: HistoryEntry = {
  id: "1".repeat(32), timestamp: "2026-07-01T12:34:56+00:00", source: "desktop",
  sha256: "a".repeat(64), diff: [{ field: "model", before: "previous-model", after: "current-model" }],
};
let historyList: ReturnType<typeof vi.fn>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready() {
  render(<App />);
  await screen.findByDisplayValue(config.base_url);
}
async function enterHistory() {
  await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("每次变更，有据可查");
}
const fieldLabels: Record<string, string> = {
  base_url: "API 地址",
  model: "模型名称",
  encrypted: "加密保存",
  api_key: "API 密钥",
};
function diffValues(field: string) {
  // The card shows a user-facing label; the protocol token stays in data-field.
  const row = document
    .querySelector(`.diff strong[data-field="${field}"]`)!
    .parentElement!;
  return Array.from(row.querySelectorAll("code"));
}

describe("history independent behavior review", () => {
  it("loads on entry, shows loading, prevents duplicate refresh, and shows empty only after success", async () => {
    const pending = deferred<HistoryEntry[]>();
    historyList.mockReturnValueOnce(pending.promise);
    await ready();
    expect(historyList).not.toHaveBeenCalled();
    await enterHistory();
    expect(screen.getByRole("button", { name: "正在读取…" })).toBeDisabled();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([]));
    expect(await screen.findByText("暂无变更记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "历史记录" })).toHaveAttribute("aria-current", "page");
  });

  it("renders full timestamp, source, digest, managed field changes, and backend order", async () => {
    const older: HistoryEntry = {
      ...entry, id: "2".repeat(32), timestamp: "2026-06-01T01:02:03+00:00",
      source: "cli", sha256: "b".repeat(64), diff: [],
    };
    historyList.mockResolvedValueOnce([{ ...entry, diff: [
      ...entry.diff,
      { field: "base_url", before: "https://old.example/v1", after: "https://new.example/v1" },
      { field: "encrypted", before: "false", after: "true" },
    ] }, older]);
    await ready();
    await enterHistory();
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText(entry.timestamp)).toBeInTheDocument();
    expect(within(cards[0]).getByText("来源: desktop")).toBeInTheDocument();
    expect(within(cards[0]).getByText(entry.sha256)).toBeInTheDocument();
    expect(within(cards[1]).getByText(older.timestamp)).toBeInTheDocument();
    expect(within(cards[1]).getByText(older.sha256)).toBeInTheDocument();
    expect(diffValues("model").map((node) => node.textContent)).toEqual(["previous-model", "current-model"]);
    expect(diffValues("base_url").map((node) => node.textContent)).toEqual(["https://old.example/v1", "https://new.example/v1"]);
    expect(diffValues("encrypted").map((node) => node.textContent)).toEqual(["关闭", "开启"]);
  });

  it.each(["HISTORY_CORRUPT", "IO", "LOCK_TIMEOUT"])("shows a safe %s failure and refresh retries successfully", async (code) => {
    historyList.mockRejectedValueOnce({ code, message: "synthetic-secret-in-error" }).mockResolvedValueOnce([entry]);
    await ready();
    await enterHistory();
    expect(await screen.findByRole("alert")).not.toBeEmptyDOMElement();
    expect(document.body).not.toHaveTextContent("synthetic-secret-in-error");
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("current-model")).toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refresh replaces old results and a later empty success removes all cards", async () => {
    historyList.mockResolvedValueOnce([entry]).mockResolvedValueOnce([{ ...entry, diff: [{ field: "model", before: "current-model", after: "refreshed-model" }] }]).mockResolvedValueOnce([]);
    await ready();
    await enterHistory();
    await screen.findByText("current-model");
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("refreshed-model");
    expect(screen.queryByText("previous-model")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("暂无变更记录");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("preserves the safe EMPTY distinction for a newly added API key", async () => {
    historyList.mockResolvedValueOnce([{ ...entry, diff: [{ field: "api_key", before: "[EMPTY]", after: "[REDACTED]" }] }]);
    await ready();
    await enterHistory();
    await screen.findByText("API 密钥");
    const [before, after] = diffValues("api_key");
    expect(before).toHaveTextContent(/^空$/);
    expect(after).toHaveTextContent(/^\[密钥已隐藏\]$/);
  });

  it("gives empty strings from the Rust String contract a visible empty placeholder", async () => {
    historyList.mockResolvedValueOnce([{ ...entry, diff: [
      { field: "base_url", before: "", after: config.base_url },
      { field: "model", before: "", after: config.model },
    ] }]);
    await ready();
    await enterHistory();
    await screen.findByText("API 地址");
    expect(diffValues("base_url")[0]).toHaveTextContent("空");
    expect(diffValues("model")[0]).toHaveTextContent("空");
  });

  it("continues to hide unexpected raw API key values defensively", async () => {
    // This intentionally violates the backend value contract to retain the existing UI defense.
    historyList.mockResolvedValueOnce([{ ...entry, diff: [{ field: "api_key", before: "synthetic-old-key", after: "synthetic-new-key" }] }]);
    await ready();
    await enterHistory();
    expect(await screen.findAllByText("[密钥已隐藏]")).toHaveLength(2);
    expect(document.body).not.toHaveTextContent("synthetic-old-key");
    expect(document.body).not.toHaveTextContent("synthetic-new-key");
  });

  it.each(["refresh", "re-entry"])("does not present cached records as current after failed %s", async (trigger) => {
    const pending = deferred<HistoryEntry[]>();
    historyList.mockResolvedValueOnce([entry]).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
    await ready();
    await enterHistory();
    await screen.findByText("current-model");
    if (trigger === "refresh") {
      await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: "配置" }));
      await enterHistory();
    }
    expect(screen.getByRole("button", { name: "正在读取…" })).toBeDisabled();
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await act(async () => pending.reject({ code: "IO" }));
    await screen.findByRole("alert");
    expect(historyList).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("暂无变更记录")).not.toBeInTheDocument();
    expect(screen.queryByText("current-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("暂无变更记录");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(historyList).toHaveBeenCalledTimes(3);
  });

  it("protects unsaved configuration before entering history, and re-queries on later entry", async () => {
    await ready();
    await userEvent.type(screen.getByLabelText("模型名称"), "-draft");
    await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("有未保存的更改");
    expect(historyList).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue("review-model-draft");
    await userEvent.click(screen.getByRole("button", { name: "历史记录" }));
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await screen.findByText("暂无变更记录");
    await userEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue(config.model);
    await enterHistory();
    await waitFor(() => expect(historyList).toHaveBeenCalledTimes(2));
  });
});
