//! Credential-safe configuration storage. No command should serialize Secret or ConfigSnapshot.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
mod config;
mod crypto;
mod filesystem;
mod history;
mod platform;
use config::*;
pub use crypto::{NativeVault, Secret, SecretKey, Vault};
use filesystem::*;
use history::*;
const MAX_FILE: u64 = 2 * 1024 * 1024;
const AAD: &[u8] = b"ai-config-manager:api-key:v1";
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Error {
    pub code: String,
    pub message: String,
}
fn err(code: &str) -> Error {
    Error {
        code: code.into(),
        message: match code {
            "IO" => "Storage could not be read or written. Check access permissions and available disk space, then reload before retrying.",
            "LOCK_TIMEOUT" => "Another process is using this configuration. Wait for it to finish, then retry.",
            "HISTORY_PENDING" => "Configuration was replaced, but history finalization or durability confirmation is pending. Reload configuration and read history to recover before another save.",
            "COMMIT_UNCERTAIN" => "The save outcome could not be verified. Reload and inspect the configuration before retrying; do not assume it was unchanged.",
            "ENCRYPT_FAILED" => "Credential encryption failed. The configuration was not replaced; retry after checking the credential vault.",
            "INVALID_SOURCE" => "The history source must be desktop, cli, skill, or test.",
            "CONFLICT" => "Configuration changed; reload before saving.",
            "VAULT_UNAVAILABLE" => "The system credential vault is unavailable or locked.",
            "KEY_MISSING" => "The encryption key is missing from the credential vault.",
            "HISTORY_CORRUPT" => "History requires recovery before saving.",
            "UNSAFE_PATH" => "A configuration path is not a safe regular file or directory.",
            "INVALID_CONFIG" => "Configuration format is invalid or ambiguous.",
            "INVALID_URL" => {
                "Use an HTTP or HTTPS base URL without credentials, query, or fragment."
            }
            "INVALID_MODEL" => "A nonempty model is required.",
            "INVALID_KEY" => "A nonempty API key is required.",
            "DECRYPT_FAILED" => "The saved credential could not be decrypted.",
            "TOO_LARGE" => "Configuration exceeds the supported size limit.",
            _ => "The configuration operation could not be completed.",
        }
        .into(),
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigView {
    pub exists: bool,
    pub base_url: String,
    pub model: String,
    pub key_present: bool,
    pub encrypted: bool,
    pub revision: String,
}
#[derive(Deserialize)]
pub struct SaveRequest {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub encrypt: bool,
    pub expected_revision: String,
}
impl std::fmt::Debug for SaveRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SaveRequest")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("encrypt", &self.encrypt)
            .finish()
    }
}
impl Drop for SaveRequest {
    fn drop(&mut self) {
        if let Some(k) = self.api_key.as_mut() {
            k.zeroize()
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDiff {
    pub field: String,
    pub before: String,
    pub after: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEntry {
    pub id: String,
    pub timestamp: String,
    pub diff: Vec<FieldDiff>,
    pub sha256: String,
    pub source: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    before_revision: String,
    after_revision: String,
    before_history_revision: String,
    history: Vec<HistoryEntry>,
}
pub struct ConfigSnapshot {
    pub base_url: String,
    pub model: String,
    secret: Secret,
}
impl ConfigSnapshot {
    pub fn with_secret<T>(&self, f: impl FnOnce(&str) -> T) -> T {
        self.secret.expose(f)
    }
}
pub struct Store {
    path: PathBuf,
    vault: Arc<dyn Vault>,
}
impl Store {
    pub fn new(path: PathBuf, vault: Arc<dyn Vault>) -> Self {
        let path = if path.is_relative() {
            std::env::current_dir()
                .map(|dir| dir.join(&path))
                .unwrap_or(path)
        } else {
            path
        };
        Self { path, vault }
    }
    pub fn default_path() -> Result<PathBuf> {
        dirs::home_dir()
            .map(|p| p.join(".config/ai.yml"))
            .ok_or_else(|| err("IO"))
    }
    fn side(&self, suffix: &str) -> PathBuf {
        let mut s = self.path.as_os_str().to_os_string();
        s.push(suffix);
        PathBuf::from(s)
    }
    fn lock(&self) -> Result<File> {
        let parent = self.path.parent().ok_or_else(|| err("UNSAFE_PATH"))?;
        safe_ancestors(parent)?;
        fs::create_dir_all(parent).map_err(|_| err("IO"))?;
        safe_ancestors(parent)?;
        let p = self.side(".lock");
        safe_file(&p)?;
        let f = platform::open_private(&p, false)?;
        lock_bounded(&f)?;
        Ok(f)
    }
    fn document(&self) -> Result<(Value, String, bool)> {
        match read_bounded(&self.path)? {
            None => Ok((Value::Mapping(Mapping::new()), "missing".into(), false)),
            Some(raw) => {
                let revision = hash(&raw);
                let text =
                    Zeroizing::new(String::from_utf8(raw).map_err(|_| err("INVALID_CONFIG"))?);
                let value = parse(&text)?;
                Ok((value, revision, true))
            }
        }
    }
    pub fn load(&self) -> Result<ConfigView> {
        let _lock = self.lock()?;
        let (doc, revision, exists) = self.document()?;
        view(&doc, revision, exists)
    }
    pub fn with_config<T>(&self, f: impl FnOnce(&ConfigSnapshot) -> T) -> Result<T> {
        let _lock = self.lock()?;
        let (doc, rev, exists) = self.document()?;
        let v = view(&doc, rev, exists)?;
        let s = self.decrypt(key_text(&doc)?)?;
        validate(&v.base_url, &v.model, &s.0)?;
        let snapshot = ConfigSnapshot {
            base_url: v.base_url,
            model: v.model,
            secret: s,
        };
        drop(_lock);
        Ok(f(&snapshot))
    }
    pub fn with_secret<T>(&self, f: impl FnOnce(&str) -> T) -> Result<T> {
        self.with_config(|c| c.with_secret(f))
    }
    pub fn validate_secret(&self) -> Result<()> {
        self.with_secret(|_| ())
    }
    pub fn history(&self) -> Result<Vec<HistoryEntry>> {
        let _lock = self.lock()?;
        self.recover()?;
        self.read_history()
    }
    fn read_history(&self) -> Result<Vec<HistoryEntry>> {
        self.read_history_snapshot().map(|(history, _)| history)
    }
    fn read_history_snapshot(&self) -> Result<(Vec<HistoryEntry>, String)> {
        let (history, revision) = match read_bounded(&self.side(".history.json"))? {
            None => (vec![], "missing".into()),
            Some(raw) => (
                serde_json::from_slice(&raw).map_err(|_| err("HISTORY_CORRUPT"))?,
                hash(&raw),
            ),
        };
        validate_history(&history)?;
        Ok((history, revision))
    }
    fn history_revision(&self) -> Result<String> {
        Ok(read_bounded(&self.side(".history.json"))?
            .map(|bytes| hash(&bytes))
            .unwrap_or_else(|| "missing".into()))
    }
    fn recover(&self) -> Result<()> {
        let p = self.side(".pending.json");
        if let Some(raw) = read_bounded(&p)? {
            let j: Journal = serde_json::from_slice(&raw).map_err(|_| err("HISTORY_CORRUPT"))?;
            validate_history(&j.history)?;
            let valid_hash =
                |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
            if !valid_hash(&j.after_revision)
                || !(j.before_revision == "missing" || valid_hash(&j.before_revision))
                || !(j.before_history_revision == "missing"
                    || valid_hash(&j.before_history_revision))
                || j.history.is_empty()
            {
                return Err(err("HISTORY_CORRUPT"));
            }
            let (_, rev, _) = self.document()?;
            if j.before_revision == j.after_revision {
                return Err(err("HISTORY_CORRUPT"));
            }
            let intended =
                serde_json::to_vec_pretty(&j.history).map_err(|_| err("HISTORY_CORRUPT"))?;
            let current_history_revision = self.history_revision()?;
            if rev == j.after_revision {
                if current_history_revision == hash(&intended) {
                    // Already committed: only remove the journal.
                } else if current_history_revision == j.before_history_revision {
                    write_atomic(&self.side(".history.json"), &intended)?;
                } else {
                    return Err(err("HISTORY_CORRUPT"));
                }
            } else {
                // The configuration was not replaced by this transaction, so the journal
                // is a stale intent: the save failed before replacement, and the file may
                // since have been rewritten by another writer. History bytes are only ever
                // written after a confirmed replacement, so they cannot belong to this
                // journal and must not be touched here. Dropping the stale journal is the
                // only action that cannot destroy committed evidence and cannot deadlock
                // the next save with a misleading HISTORY_CORRUPT.
                debug_assert_ne!(rev, j.after_revision);
            }
            fs::remove_file(p).map_err(|_| err("IO"))?;
            sync_parent(&self.path)?;
        }
        Ok(())
    }
    pub fn save(&self, request: SaveRequest) -> Result<ConfigView> {
        self.save_with_source(request, "desktop")
    }
    pub fn save_with_source(&self, mut request: SaveRequest, source: &str) -> Result<ConfigView> {
        if !matches!(source, "desktop" | "cli" | "skill" | "test") {
            return Err(err("INVALID_SOURCE"));
        }
        let _lock = self.lock()?;
        self.recover()?;
        // Compare revisions before reading history: a stale expected revision is a caller
        // conflict, and must not be reported as a history problem. Recover still runs first
        // because it may need to finalize an already-committed transaction.
        let (mut doc, revision, exists) = self.document()?;
        if revision != request.expected_revision {
            return Err(err("CONFLICT"));
        }
        let (mut history, before_history_revision) = self.read_history_snapshot()?;
        let old = view(&doc, revision.clone(), exists)?;
        let old_key = key_text(&doc)?;
        let changed = request.api_key.is_some();
        let secret = if let Some(k) = request.api_key.take() {
            Secret(k)
        } else {
            self.decrypt(old_key)?
        };
        validate(&request.base_url, &request.model, &secret.0)?;
        let stored = if request.encrypt {
            self.encrypt(&secret)?
        } else {
            secret.0.clone()
        };
        set_fields(&mut doc, &request.base_url, &request.model, &stored)?;
        let canonical = canonical_hash(&doc, &secret)?;
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        let id: String = id_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut serialized = Zeroizing::new(format!("# ai-config-manager transaction: {id}\n"));
        serialized.push_str(&serde_yaml::to_string(&doc).map_err(|_| err("INVALID_CONFIG"))?);
        if serialized.len() as u64 > MAX_FILE {
            return Err(err("TOO_LARGE"));
        }
        let after_revision = hash(serialized.as_bytes());
        let mut diff = Vec::new();
        for (field, before, after) in [
            ("base_url", old.base_url, request.base_url.clone()),
            ("model", old.model, request.model.clone()),
            (
                "encrypted",
                old.encrypted.to_string(),
                request.encrypt.to_string(),
            ),
        ] {
            if before != after {
                diff.push(FieldDiff {
                    field: field.into(),
                    before: if before.len() > 8192 {
                        "[VALUE EXCEEDS LIMIT]".into()
                    } else {
                        before
                    },
                    after,
                })
            }
        }
        if changed || !old.key_present {
            diff.push(FieldDiff {
                field: "api_key".into(),
                before: if old.key_present {
                    "[REDACTED]"
                } else {
                    "[EMPTY]"
                }
                .into(),
                after: "[REDACTED]".into(),
            })
        }
        history.insert(
            0,
            HistoryEntry {
                id,
                timestamp: chrono::Utc::now().to_rfc3339(),
                diff,
                sha256: canonical,
                source: source.into(),
            },
        );
        history.truncate(10);
        validate_history(&history)?;
        let journal = Journal {
            before_revision: revision.clone(),
            after_revision: after_revision.clone(),
            before_history_revision: before_history_revision.clone(),
            history,
        };
        let journal_bytes = serde_json::to_vec_pretty(&journal).map_err(|_| err("IO"))?;
        write_atomic(&self.side(".pending.json"), &journal_bytes)?;
        let (_, current, _) = self.document()?;
        if current != revision || self.history_revision()? != before_history_revision {
            fs::remove_file(self.side(".pending.json")).map_err(|_| err("IO"))?;
            return Err(err("CONFLICT"));
        }
        if let Err(error) = write_atomic(&self.path, serialized.as_bytes()) {
            return match self.document() {
                Ok((_, current, _)) if current == after_revision => Err(err("HISTORY_PENDING")),
                Ok((_, current, _)) if current == revision => Err(error),
                _ => Err(err("COMMIT_UNCERTAIN")),
            };
        }
        // Once replacement succeeds the durable journal is authoritative. Recovery is idempotent.
        if self.recover().is_err() {
            return Err(err("HISTORY_PENDING"));
        }
        view(&doc, after_revision, true)
    }
}

#[cfg(test)]
mod commit_tests {
    use super::*;
    struct UnusedVault;
    impl Vault for UnusedVault {
        fn get_key(&self) -> Result<Option<SecretKey>> {
            panic!("plaintext test must not use vault")
        }
        fn create_key(&self) -> Result<SecretKey> {
            panic!("plaintext test must not use vault")
        }
    }
    #[test]
    fn config_write_failures_preserve_history_and_report_commit_boundary() {
        for after_replace in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().canonicalize().unwrap().join("ai.yml");
            let store = Store::new(path.clone(), Arc::new(UnusedVault));
            let request = |revision: String| SaveRequest {
                base_url: "https://example.com/v1".into(),
                model: "test".into(),
                api_key: Some("secret".into()),
                encrypt: false,
                expected_revision: revision,
            };
            let first = store.save(request("missing".into())).unwrap();
            let history_before = fs::read(store.side(".history.json")).unwrap();
            filesystem::FAIL_WRITE.with(|f| *f.borrow_mut() = Some((path.clone(), after_replace)));
            let error = store.save(request(first.revision.clone())).unwrap_err();
            assert_eq!(
                error.code,
                if after_replace {
                    "HISTORY_PENDING"
                } else {
                    "IO"
                }
            );
            assert_eq!(
                fs::read(store.side(".history.json")).unwrap(),
                history_before
            );
            assert_eq!(
                store.load().unwrap().revision == first.revision,
                !after_replace
            );
            assert_eq!(
                store.history().unwrap().len(),
                if after_replace { 2 } else { 1 }
            );
        }
    }
}
