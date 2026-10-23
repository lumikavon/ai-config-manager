use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Preferences are a few hundred bytes; refuse anything that is not plausibly a
/// preferences document instead of buffering an arbitrary file into memory.
const MAX_SETTINGS_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub silent_start: bool,
    pub close_to_tray: bool,
    pub language: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            silent_start: false,
            close_to_tray: true,
            language: "zh".into(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskSettings {
    schema_version: u32,
    #[serde(flatten)]
    settings: Settings,
}

/// Replacement and durability are separate: the new file can be visible even
/// when the directory cannot be flushed. Never report that case as no write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    Durable,
    ReplacedDurabilityUncertain,
}

pub struct SettingsState {
    pub path: PathBuf,
    pub settings: Settings,
    pub warnings: Vec<String>,
    pub tray_available: bool,
    /// Set when the preferences file exists but cannot be honoured. Writing would
    /// silently downgrade a newer schema (or destroy an unreadable file), so
    /// `save` refuses until the file is repaired or removed.
    pub blocked: Option<String>,
}
impl SettingsState {
    pub fn load(path: PathBuf) -> Self {
        let mut warnings = vec![];
        let mut blocked = None;
        let settings = match read_settings(&path) {
            Ok(Some(bytes)) => match serde_json::from_slice::<DiskSettings>(&bytes) {
                Ok(v) if v.schema_version == 1 && valid(&v.settings) => v.settings,
                _ => {
                    warnings.push("SETTINGS_INVALID: Local preferences are invalid or come from an unsupported schema version; defaults are in use and saving is blocked until the file is repaired or removed.".into());
                    blocked = Some(
                        "The preferences file is invalid or uses an unsupported schema version"
                            .to_string(),
                    );
                    Settings::default()
                }
            },
            Ok(None) => Settings::default(),
            Err(_) => {
                warnings.push("SETTINGS_UNREADABLE: Local preferences could not be read; defaults are in use and saving is blocked until the file is readable again.".into());
                blocked = Some("The preferences file could not be read".to_string());
                Settings::default()
            }
        };
        Self {
            path,
            settings,
            warnings,
            tray_available: false,
            blocked,
        }
    }
    pub fn save(&mut self, settings: Settings) -> Result<CommitOutcome, String> {
        if let Some(reason) = &self.blocked {
            return Err(format!(
                "{reason}. Refusing to overwrite it; repair or remove the file, then restart."
            ));
        }
        self.save_with_sync(settings, sync_parent)
    }
    fn save_with_sync(
        &mut self,
        settings: Settings,
        sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<CommitOutcome, String> {
        if !valid(&settings) {
            return Err("Language must be zh or en".into());
        }
        let outcome = atomic_write(&self.path, &settings, sync_directory).map_err(|_| {
            "Could not atomically save preferences; the previous preferences remain active"
                .to_string()
        })?;
        // persist succeeded in BOTH outcomes. Reflect the visible disk contents,
        // including in settings_read and close-to-tray behavior, without retrying.
        self.settings = settings;
        // A successful replacement means the file on disk is now ours and readable.
        self.blocked = None;
        self.warnings.retain(|w| !w.starts_with("SETTINGS_"));
        if outcome == CommitOutcome::ReplacedDurabilityUncertain {
            self.warnings.push("SETTINGS_DURABILITY_UNCERTAIN: Preferences were replaced and are active, but directory synchronization failed. Their survival across a system crash is not confirmed. Do not assume the save was rolled back.".into());
        }
        Ok(outcome)
    }
}
/// Read the preferences file without trusting its size. `Ok(None)` means the file
/// does not exist yet; any other failure is an unreadable file, not a fresh install.
fn read_settings(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(std::io::Error::other(
            "preferences file exceeds the supported size limit",
        ));
    }
    Ok(Some(bytes))
}
fn valid(s: &Settings) -> bool {
    matches!(s.language.as_str(), "zh" | "en")
}
fn atomic_write(
    path: &Path,
    settings: &Settings,
    sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<CommitOutcome> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing parent"))?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let data = serde_json::to_vec_pretty(&DiskSettings {
        schema_version: 1,
        settings: settings.clone(),
    })?;
    tmp.write_all(&data)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(match sync_directory(parent) {
        Ok(()) => CommitOutcome::Durable,
        Err(_) => CommitOutcome::ReplacedDurabilityUncertain,
    })
}
fn sync_parent(parent: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut state = SettingsState::load(path.clone());
        assert_eq!(state.settings.language, "zh");
        let chosen = Settings {
            language: "en".into(),
            silent_start: true,
            close_to_tray: false,
        };
        state.save(chosen.clone()).unwrap();
        assert_eq!(SettingsState::load(path).settings, chosen);
    }
    #[test]
    fn malformed_preserved_and_warned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{bad").unwrap();
        let state = SettingsState::load(path.clone());
        assert_eq!(state.settings, Settings::default());
        assert_eq!(state.warnings.len(), 1);
        assert_eq!(fs::read_to_string(path).unwrap(), "{bad");
    }
    #[test]
    fn rejects_unknown_version_and_language() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"schema_version":2,"silent_start":true,"close_to_tray":false,"language":"en"}"#,
        )
        .unwrap();
        let mut state = SettingsState::load(path);
        assert!(!state.warnings.is_empty());
        assert!(state
            .save(Settings {
                language: "xx".into(),
                ..Settings::default()
            })
            .is_err());
    }
    #[test]
    fn rejects_unknown_fields_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let bytes = r#"{"schema_version":1,"silent_start":true,"close_to_tray":false,"language":"en","surprise":true}"#;
        fs::write(&path, bytes).unwrap();
        let state = SettingsState::load(path.clone());
        assert_eq!(state.settings, Settings::default());
        assert_eq!(state.warnings.len(), 1);
        assert_eq!(fs::read_to_string(path).unwrap(), bytes);
    }
    #[test]
    fn failed_save_preserves_current_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("directory-not-file");
        fs::create_dir(&path).unwrap();
        let mut state = SettingsState::load(path);
        assert!(state
            .save(Settings {
                language: "en".into(),
                ..Settings::default()
            })
            .is_err());
        assert_eq!(state.settings, Settings::default());
    }
    #[test]
    fn post_replace_sync_failure_reconciles_cache_and_reports_uncertainty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut state = SettingsState::load(path.clone());
        state.save(Settings::default()).unwrap();
        state.warnings.push("TRAY_UNAVAILABLE: test".into());
        let chosen = Settings {
            language: "en".into(),
            silent_start: true,
            close_to_tray: false,
        };
        let outcome = state
            .save_with_sync(chosen.clone(), |_| {
                Err(std::io::Error::other("injected directory sync failure"))
            })
            .unwrap();
        assert_eq!(outcome, CommitOutcome::ReplacedDurabilityUncertain);
        assert_eq!(state.settings, chosen);
        assert_eq!(SettingsState::load(path).settings, chosen);
        assert!(state
            .warnings
            .iter()
            .any(|w| w.starts_with("SETTINGS_DURABILITY_UNCERTAIN:")));
        assert!(state
            .warnings
            .iter()
            .any(|w| w.starts_with("TRAY_UNAVAILABLE:")));
        assert_eq!(state.save(chosen).unwrap(), CommitOutcome::Durable);
        assert!(!state
            .warnings
            .iter()
            .any(|w| w.starts_with("SETTINGS_DURABILITY_UNCERTAIN:")));
    }
}
