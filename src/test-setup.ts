import "@testing-library/jest-dom/vitest";

HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};

// jsdom has no Tauri host. The app requires the IPC bridge in addition to the
// `isTauri()` marker (a host can advertise the marker while the bridge is missing),
// so provide an inert bridge here. Suites that exercise the desktop-only screen mock
// `isTauri` to false, and every command itself is still mocked per test file.
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  configurable: true,
  writable: true,
  value: { invoke: async () => undefined },
});
