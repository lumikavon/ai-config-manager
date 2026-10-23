import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { messages } from "./i18n";
import type { Language } from "./types";

export default function TitleBar({ language, onClose, onError }: {
  language: Language;
  onClose: () => void;
  onError: () => void;
}) {
  const t = messages[language];
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    const update = () => {
      void invoke<boolean>("window_control", { action: "is_maximized" })
        .then((value) => { if (active) setMaximized(!!value); })
        .catch(() => {});
    };
    update();
    // Window events are delivered per window: a global app listener never sees the
    // resize, which leaves the maximize/restore glyph stale after snapping or
    // dragging. The module is imported lazily so a host without the window bridge
    // (browser preview, component tests) simply keeps the last known state.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onResized(update))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      active = false;
      cancelled = true;
      unlisten?.();
    };
  }, []);
  function control(action: string) {
    void invoke<boolean>("window_control", { action })
      .then((value) => {
        if (action === "toggle_maximize") setMaximized(!!value);
      }).catch(onError);
  }
  return (
    <div className="titlebar">
      <div className="titlebar-drag"
        onMouseDown={(event) => {
          if (event.button === 0 && event.detail === 1) control("start_dragging");
        }}
        onDoubleClick={() => control("toggle_maximize")}>
        <span aria-hidden="true" className="titlebar-mark">◈</span>
        <span>{t.brand}</span>
      </div>
      <div className="window-controls" role="group" aria-label={t.windowControls}>
        <button type="button" aria-label={t.minimize} title={t.minimize}
          onClick={() => control("minimize")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
        </button>
        <button type="button" aria-label={maximized ? t.restore : t.maximize}
          title={maximized ? t.restore : t.maximize} onClick={() => control("toggle_maximize")}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {maximized ? <path d="M5 5V3h8v8h-2M3 5h8v8H3z" /> : <path d="M3 3h10v10H3z" />}
          </svg>
        </button>
        <button type="button" className="window-close" aria-label={t.closeWindow}
          title={t.closeWindow} onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg>
        </button>
      </div>
    </div>
  );
}
