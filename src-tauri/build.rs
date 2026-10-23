fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "config_read",
            "config_save",
            "config_check",
            "history_list",
            "settings_read",
            "settings_save",
            "autostart_set",
            "window_hide",
            "window_control",
        ]),
    ))
    .expect("Tauri build configuration is invalid");
}
