#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod settings;
use ai_config_core::{ConfigView, Error, HistoryEntry, NativeVault, SaveRequest, Store};
use serde::Serialize;
use settings::{Settings, SettingsState};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tauri_plugin_autostart::ManagerExt;

type Core = Arc<Store>;
type Preferences = Arc<Mutex<SettingsState>>;
fn error(code: &str, message: &str) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}
async fn blocking<T, F>(work: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, Error> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| error("WORKER_FAILED", "Background operation failed"))?
}
#[tauri::command]
async fn config_read(store: State<'_, Core>) -> Result<ConfigView, Error> {
    let store = store.inner().clone();
    blocking(move || store.load()).await
}
#[tauri::command]
async fn config_save(store: State<'_, Core>, request: SaveRequest) -> Result<ConfigView, Error> {
    let store = store.inner().clone();
    blocking(move || store.save(request)).await
}
#[tauri::command]
async fn config_check(store: State<'_, Core>) -> Result<(), Error> {
    let store = store.inner().clone();
    blocking(move || store.validate_secret()).await
}
#[tauri::command]
async fn history_list(store: State<'_, Core>) -> Result<Vec<HistoryEntry>, Error> {
    let store = store.inner().clone();
    blocking(move || store.history()).await
}
#[derive(Serialize)]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    autostart: bool,
    autostart_known: bool,
    version: String,
    platform: String,
    tray_available: bool,
    warnings: Vec<String>,
}
fn settings_view(app: &tauri::AppHandle) -> Result<SettingsView, Error> {
    let state = app.state::<Preferences>();
    let state = state
        .lock()
        .map_err(|_| error("SETTINGS_LOCK", "Preferences are busy"))?;
    let mut warnings = state.warnings.clone();
    let (autostart, autostart_known) = match app.autolaunch().is_enabled() {
        Ok(value) => (value, true),
        Err(_) => {
            warnings.push("AUTOSTART_UNKNOWN: Cannot read OS login registration; displayed status is not confirmed.".into());
            (false, false)
        }
    };
    Ok(SettingsView {
        settings: state.settings.clone(),
        autostart,
        autostart_known,
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        tray_available: state.tray_available,
        warnings,
    })
}
#[tauri::command]
async fn settings_read(app: tauri::AppHandle) -> Result<SettingsView, Error> {
    blocking(move || settings_view(&app)).await
}
#[tauri::command]
async fn settings_save(app: tauri::AppHandle, settings: Settings) -> Result<SettingsView, Error> {
    let other = app.clone();
    blocking(move || {
        other
            .state::<Preferences>()
            .lock()
            .map_err(|_| error("SETTINGS_LOCK", "Preferences are busy"))?
            .save(settings)
            .map_err(|m| error("SETTINGS_SAVE", &m))
    })
    .await?;
    // Native menu mutation is marshalled by Tauri to the UI thread.
    let language = app
        .state::<Preferences>()
        .lock()
        .map_err(|_| error("SETTINGS_LOCK", "Preferences are busy"))?
        .settings
        .language
        .clone();
    if let Some(tray) = app.tray_by_id("main-tray") {
        let refreshed =
            tray_menu(&app, &language).and_then(|menu| tray.set_menu(Some(menu)).map(|_| ()));
        if refreshed.is_err() {
            // The preferences are already committed. Record why the visible tray
            // still shows the previous language instead of only returning an error
            // that disappears with the next navigation.
            if let Ok(mut state) = app.state::<Preferences>().lock() {
                if !state
                    .warnings
                    .iter()
                    .any(|w| w.starts_with("TRAY_MENU_STALE"))
                {
                    state.warnings.push("TRAY_MENU_STALE: Preferences were saved, but the tray menu could not be rebuilt. Tray labels may still show the previous language until the app restarts.".into());
                }
            }
            return Err(error(
                "TRAY_MENU",
                "Preferences saved, but tray menu could not be refreshed",
            ));
        }
    }
    blocking(move || settings_view(&app)).await
}
#[tauri::command]
async fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, Error> {
    blocking(move || {
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|_| error("AUTOSTART_UPDATE", "Could not update OS login registration"))?;
        let actual = manager
            .is_enabled()
            .map_err(|_| error("AUTOSTART_QUERY", "Could not verify OS login registration"))?;
        if actual != enabled {
            return Err(error(
                "AUTOSTART_MISMATCH",
                "OS login registration did not match the requested setting",
            ));
        }
        Ok(actual)
    })
    .await
}
#[tauri::command]
fn window_hide(app: tauri::AppHandle) -> Result<(), Error> {
    let available = app
        .state::<Preferences>()
        .lock()
        .map_err(|_| error("SETTINGS_LOCK", "Preferences are busy"))?
        .tray_available;
    if !available {
        return Err(error(
            "TRAY_UNAVAILABLE",
            "Cannot hide this window because the system tray is unavailable",
        ));
    }
    app.get_webview_window("main")
        .ok_or_else(|| error("WINDOW_MISSING", "Main window is missing"))?
        .hide()
        .map_err(|_| error("WINDOW_HIDE", "Could not hide window"))
}
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
    StartDragging,
    IsMaximized,
}
#[tauri::command]
fn window_control(window: tauri::WebviewWindow, action: WindowAction) -> Result<bool, Error> {
    let result = match action {
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => window.is_maximized().and_then(|maximized| {
            if maximized {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }),
        // Use the normal close request so close-to-tray remains authoritative.
        WindowAction::Close => window.close(),
        WindowAction::StartDragging => window.start_dragging(),
        WindowAction::IsMaximized => Ok(()),
    };
    result.map_err(|_| error("WINDOW_CONTROL", "Could not update the window"))?;
    if matches!(
        action,
        WindowAction::Close | WindowAction::Minimize | WindowAction::StartDragging
    ) {
        return Ok(false);
    }
    window
        .is_maximized()
        .map_err(|_| error("WINDOW_CONTROL", "Could not read the window state"))
}
fn tray_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = if lang == "en" {
        ["Show", "Hide", "Settings", "Quit"]
    } else {
        ["显示窗口", "隐藏窗口", "设置", "退出"]
    };
    let show = MenuItem::with_id(app, "show", labels[0], true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", labels[1], true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", labels[2], true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", labels[3], true, None::<&str>)?;
    Menu::with_items(app, &[&show, &hide, &settings, &quit])
}
// Linux may create a tray handle even when the desktop has no tray host.
// A conservative host check prevents an unreachable silent application.
fn tray_host_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(connection) = zbus::blocking::Connection::session() else {
            return false;
        };
        let Ok(proxy) = zbus::blocking::Proxy::new(
            &connection,
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.kde.StatusNotifierWatcher",
        ) else {
            return false;
        };
        proxy
            .get_property::<bool>("IsStatusNotifierHostRegistered")
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
fn main() {
    tauri::Builder::default()
        // Register first: a second launch exits and restores the existing window,
        // including when the first instance is minimized or hidden in the tray.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--silent"])))
        .setup(|app| {
            let store = Store::new(Store::default_path()?, Arc::new(NativeVault::new()));
            app.manage(Arc::new(store));
            let path = app.path().app_config_dir()?.join("settings.json");
            let mut preferences = SettingsState::load(path);
            let menu = tray_menu(app.handle(), &preferences.settings.language);
            let tray = menu.and_then(|menu| {
                TrayIconBuilder::with_id("main-tray")
                    .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
                    .tooltip("AI Config Manager").menu(&menu).show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show(app), "hide" => { let _ = window_hide(app.clone()); },
                        "settings" => { show(app); let _ = app.emit("navigate", "settings"); },
                        "quit" => app.exit(0), _ => {}
                    }).build(app)
            });
            preferences.tray_available = tray.is_ok() && tray_host_available();
            if !preferences.tray_available { preferences.warnings.push("TRAY_UNAVAILABLE: System tray creation or host detection failed; silent start and hide-to-tray are disabled for this session.".into()); }
            let silent = std::env::args().any(|a| a == "--silent") || preferences.settings.silent_start;
            let visible = !silent || !preferences.tray_available || !preferences.warnings.is_empty();
            app.manage(Arc::new(Mutex::new(preferences)));
            if visible { show(app.handle()); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<Preferences>();
                if let Ok(state) = state.lock() {
                    if state.settings.close_to_tray && state.tray_available {
                        if window.hide().is_ok() { api.prevent_close(); }
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![config_read, config_save, config_check, history_list, settings_read, settings_save, autostart_set, window_hide, window_control])
        .run(tauri::generate_context!())
        .expect("AI Config Manager could not start");
}
