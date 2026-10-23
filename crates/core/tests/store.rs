use ai_config_core::*;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Mock(Mutex<Option<[u8; 32]>>);
impl Vault for Mock {
    fn get_key(&self) -> Result<Option<SecretKey>> {
        Ok(self.0.lock().unwrap().map(SecretKey::new))
    }
    fn create_key(&self) -> Result<SecretKey> {
        let mut k = self.0.lock().unwrap();
        Ok(SecretKey::new(*k.get_or_insert([42; 32])))
    }
}
fn setup() -> (tempfile::TempDir, Store, Arc<Mock>, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().canonicalize().unwrap().join("ai.yml");
    let v = Arc::new(Mock::default());
    let s = Store::new(p.clone(), v.clone());
    (d, s, v, p)
}
fn request(rev: &str, key: Option<&str>, encrypt: bool) -> SaveRequest {
    SaveRequest {
        base_url: "https://example.com/v1".into(),
        model: "test-model".into(),
        api_key: key.map(String::from),
        encrypt,
        expected_revision: rev.into(),
    }
}
#[test]
fn missing_and_plain_roundtrip() {
    let (_d, s, _, p) = setup();
    let v = s.load().unwrap();
    assert!(!v.exists);
    assert_eq!(v.revision, "missing");
    let v = s
        .save(request(&v.revision, Some("test-secret"), false))
        .unwrap();
    assert!(v.key_present);
    assert!(!v.encrypted);
    assert_eq!(s.with_secret(str::to_string).unwrap(), "test-secret");
    let text = serde_json::to_string(&v).unwrap();
    assert!(!text.contains("test-secret"));
    let h = s.history().unwrap();
    assert_eq!(h.len(), 1);
    assert!(!serde_json::to_string(&h).unwrap().contains("test-secret"));
    assert!(fs::read_to_string(p).unwrap().contains("test-secret"));
}
#[test]
fn encrypt_preserve_and_stable_digest() {
    let (_d, s, _, p) = setup();
    let first = s
        .save(request("missing", Some("supersecret"), true))
        .unwrap();
    let bytes1 = fs::read(&p).unwrap();
    let digest = s.history().unwrap()[0].sha256.clone();
    let second = s.save(request(&first.revision, None, true)).unwrap();
    assert_ne!(first.revision, second.revision);
    assert_ne!(bytes1, fs::read(&p).unwrap());
    assert_eq!(s.history().unwrap()[0].sha256, digest);
    assert_eq!(s.with_secret(str::to_string).unwrap(), "supersecret");
    assert!(!fs::read_to_string(p).unwrap().contains("supersecret"));
}
#[test]
fn encrypted_to_plain_preserves_hash() {
    let (_d, s, _, _) = setup();
    let a = s.save(request("missing", Some("secret"), true)).unwrap();
    let hash = s.history().unwrap()[0].sha256.clone();
    let b = s.save(request(&a.revision, None, false)).unwrap();
    assert!(!b.encrypted);
    assert_eq!(hash, s.history().unwrap()[0].sha256);
}
#[test]
fn vault_missing_does_not_replace_key() {
    let (_d, s, v, _) = setup();
    s.save(request("missing", Some("secret"), true)).unwrap();
    *v.0.lock().unwrap() = None;
    assert_eq!(s.validate_secret().unwrap_err().code, "KEY_MISSING");
    assert!(v.0.lock().unwrap().is_none());
    assert!(s.load().unwrap().encrypted);
}
#[test]
fn tampered_cipher_rejected() {
    let (_d, s, _, p) = setup();
    s.save(request("missing", Some("secret"), true)).unwrap();
    let text = fs::read_to_string(&p).unwrap();
    let start = text.find("ENC(v1:").unwrap() + 7;
    let mut bytes = text.into_bytes();
    bytes[start] = if bytes[start] == b'A' { b'B' } else { b'A' };
    fs::write(p, bytes).unwrap();
    assert_eq!(s.validate_secret().unwrap_err().code, "DECRYPT_FAILED");
}
#[test]
fn external_edit_conflict() {
    let (_d, s, _, p) = setup();
    let a = s.save(request("missing", Some("secret"), false)).unwrap();
    fs::write(p, "other: true\n").unwrap();
    assert_eq!(
        s.save(request(&a.revision, None, false)).unwrap_err().code,
        "CONFLICT"
    );
    assert_eq!(s.history().unwrap().len(), 1);
}
#[test]
fn malformed_configs_are_never_overwritten() {
    for input in [
        "ai: [",
        "ai: {}\nai: {}\n",
        "---\na: 1\n---\na: 2\n",
        "a: !custom value\n",
        "ai: null\n",
        "? [a,b]\n: 1\n",
        "a: .nan\n",
    ] {
        let (_d, s, _, p) = setup();
        fs::write(&p, input).unwrap();
        let e = s.load().unwrap_err();
        assert_eq!(e.code, "INVALID_CONFIG", "{input}");
        assert!(!e.message.contains(input));
        assert!(s.save(request("missing", Some("secret"), false)).is_err());
        assert_eq!(fs::read_to_string(p).unwrap(), input);
    }
}
#[test]
fn unrelated_yaml_semantics_and_canonical_order() {
    let (_d, s, _, p) = setup();
    fs::write(&p, "z: [true, 2, null]\nother:\n  z: last\n  a: first\n").unwrap();
    let rev = s.load().unwrap().revision;
    let v = s.save(request(&rev, Some("secret"), false)).unwrap();
    let doc: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(doc["other"]["z"].as_str(), Some("last"));
    let digest = s.history().unwrap()[0].sha256.clone();
    let reordered="other: {a: first, z: last}\nz: [true, 2, null]\nai:\n  openai:\n    api_key: secret\n    model: test-model\n    base_url: https://example.com/v1\n";
    fs::write(&p, reordered).unwrap();
    let rev = s.load().unwrap().revision;
    assert_ne!(rev, v.revision);
    s.save(request(&rev, None, false)).unwrap();
    assert_eq!(s.history().unwrap()[0].sha256, digest);
}
#[test]
fn validation_and_preserve() {
    for url in [
        "ftp://host",
        "https://u:p@host",
        "https://@host",
        "https:example.com",
        "https://ho\nst",
        "https://host?q=x",
        "https://host#frag",
        " https://host",
        "",
    ] {
        let (_d, s, _, _) = setup();
        let mut r = request("missing", Some("secret"), false);
        r.base_url = url.into();
        assert_eq!(s.save(r).unwrap_err().code, "INVALID_URL");
    }
    let (_d, s, _, _) = setup();
    assert_eq!(
        s.save(request("missing", Some(""), false))
            .unwrap_err()
            .code,
        "INVALID_KEY"
    );
    assert_eq!(
        s.save(request("missing", None, false)).unwrap_err().code,
        "INVALID_KEY"
    );
}
#[test]
fn history_corruption_does_not_block_load_but_blocks_save() {
    let (_d, s, _, p) = setup();
    let v = s.save(request("missing", Some("secret"), false)).unwrap();
    let hp = PathBuf::from(format!("{}.history.json", p.display()));
    fs::write(hp, "not json").unwrap();
    assert!(s.load().is_ok());
    assert_eq!(
        s.save(request(&v.revision, None, false)).unwrap_err().code,
        "HISTORY_CORRUPT"
    );
    assert_eq!(s.load().unwrap().revision, v.revision);
}
#[test]
fn bounded_history() {
    let (_d, s, _, _) = setup();
    let mut rev = "missing".to_string();
    for i in 0..13 {
        let mut r = request(&rev, Some("secret"), false);
        r.model = format!("model-{i}");
        rev = s.save(r).unwrap().revision;
    }
    let h = s.history().unwrap();
    assert_eq!(h.len(), 10);
    assert!(h[0].diff.iter().any(|d| d.after == "model-12"));
}
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
#[test]
fn journal_recovery_all_commit_boundaries_and_stale_history() {
    for phase in ["before", "after", "already", "stale"] {
        let (_d, s, _, p) = setup();
        let one = s.save(request("missing", Some("secret"), false)).unwrap();
        let config_one = fs::read(&p).unwrap();
        let hp = PathBuf::from(format!("{}.history.json", p.display()));
        let jp = PathBuf::from(format!("{}.pending.json", p.display()));
        let history_one = fs::read(&hp).unwrap();
        let two = s.save(request(&one.revision, None, false)).unwrap();
        let config_two = fs::read(&p).unwrap();
        assert_ne!(
            one.revision, two.revision,
            "Identical plaintext saves need distinct commit identities"
        );
        let history_two = s.history().unwrap();
        let journal = serde_json::json!({"before_revision":one.revision,"after_revision":two.revision,"before_history_revision":digest(&history_one),"history":history_two});
        match phase {
            "before" => {
                fs::write(&p, &config_one).unwrap();
                fs::write(&hp, &history_one).unwrap();
            }
            "after" => {
                fs::write(&hp, &history_one).unwrap();
            }
            "stale" => {
                s.save(request(&two.revision, None, false)).unwrap();
                fs::write(&p, &config_two).unwrap();
            }
            _ => {}
        }
        let history_before_recovery = fs::read(&hp).unwrap();
        fs::write(&jp, serde_json::to_vec(&journal).unwrap()).unwrap();
        if phase == "stale" {
            assert_eq!(s.history().unwrap_err().code, "HISTORY_CORRUPT");
            assert_eq!(
                fs::read(&hp).unwrap(),
                history_before_recovery,
                "Stale journal must never roll history back"
            );
            assert!(jp.exists());
        } else {
            assert_eq!(
                s.history().unwrap().len(),
                if phase == "before" { 1 } else { 2 }
            );
            assert!(!jp.exists());
        }
    }
}
#[test]
fn failed_save_journal_is_dropped_after_an_external_edit() {
    // A save that fails before replacement leaves a durable journal behind. If the
    // configuration is then edited by another writer, the stale journal must not turn
    // every later history call into HISTORY_CORRUPT (a dead end: README warns against
    // deleting the pending file by hand).
    use sha2::Digest as _;
    let (_d, s, _, p) = setup();
    s.save(request("missing", Some("secret"), false)).unwrap();
    let jp = PathBuf::from(format!("{}.pending.json", p.display()));
    let mut hasher = sha2::Sha256::new();
    hasher.update(fs::read(&p).unwrap());
    let before = format!("{:x}", hasher.finalize());
    let mut intended = s.history().unwrap();
    intended[0].timestamp = "2026-10-21T00:00:00Z".into();
    fs::write(
        &jp,
        serde_json::to_vec(&serde_json::json!({
            "before_revision": before,
            "after_revision": "b".repeat(64),
            "before_history_revision": "missing",
            "history": intended,
        }))
        .unwrap(),
    )
    .unwrap();
    // External writer rewrites the configuration: bytes match neither journal side.
    fs::write(
        &p,
        "ai:\n  openai:\n    base_url: https://example.com/v1\n    api_key: secret\n    model: external\n",
    )
    .unwrap();
    assert!(!s.history().unwrap().is_empty());
    assert!(!jp.exists());
    let rev = s.load().unwrap().revision;
    s.save(request(&rev, Some("secret"), false)).unwrap();
}
#[test]
fn stale_revision_conflicts_before_history_health_is_reported() {
    // CONFLICT is the documented contract for a stale revision; an unreadable history
    // sidecar must not mask it as HISTORY_CORRUPT. (A malformed journal is different:
    // recovery must run first, because it may need to finalize a committed write.)
    let (_d, s, _, p) = setup();
    s.save(request("missing", Some("secret"), false)).unwrap();
    let hp = PathBuf::from(format!("{}.history.json", p.display()));
    fs::write(hp, b"[{\"id\":\"broken\"}]").unwrap();
    assert_eq!(
        s.save(request("stale-revision", None, false))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
}
#[test]
fn divergent_journal_blocks_save() {
    let (_d, s, _, p) = setup();
    let v = s.save(request("missing", Some("secret"), false)).unwrap();
    let jp = PathBuf::from(format!("{}.pending.json", p.display()));
    fs::write(jp,serde_json::to_vec(&serde_json::json!({"before_revision":"other","after_revision":"different","before_history_revision":"missing","history":s.history().unwrap()})).unwrap()).unwrap();
    assert!(s.load().is_ok());
    assert_eq!(
        s.save(request(&v.revision, None, false)).unwrap_err().code,
        "HISTORY_CORRUPT"
    );
}
#[cfg(unix)]
#[test]
fn private_mode_and_symlink_rejection() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (_d, s, _, p) = setup();
    s.save(request("missing", Some("secret"), false)).unwrap();
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let target = p.with_extension("target");
    fs::rename(&p, &target).unwrap();
    symlink(target, &p).unwrap();
    assert_eq!(s.load().unwrap_err().code, "UNSAFE_PATH");
}
#[test]
fn redacted_debug() {
    assert!(!format!("{:?}", Secret::new("verysecret".into())).contains("verysecret"));
    assert!(!format!("{:?}", request("missing", Some("verysecret"), false)).contains("verysecret"));
}
#[test]
fn concurrent_cas_one_winner() {
    let (_d, s, v, p) = setup();
    let rev = s
        .save(request("missing", Some("secret"), false))
        .unwrap()
        .revision;
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let p = p.clone();
            let v = v.clone();
            let rev = rev.clone();
            std::thread::spawn(move || Store::new(p, v).save(request(&rev, Some("updated"), true)))
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .filter(|h| h.thread().id() != std::thread::current().id())
            .map(|h| h.join().unwrap())
            .filter(Result::is_ok)
            .count(),
        1
    );
    assert_eq!(s.history().unwrap().len(), 2);
}

#[test]
fn lock_timeout_is_bounded() {
    use fs2::FileExt;
    let (_d, s, _, p) = setup();
    let lockpath = PathBuf::from(format!("{}.lock", p.display()));
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lockpath)
        .unwrap();
    lock.lock_exclusive().unwrap();
    let start = std::time::Instant::now();
    assert_eq!(s.load().unwrap_err().code, "LOCK_TIMEOUT");
    assert!(start.elapsed() < std::time::Duration::from_secs(7));
}

#[test]
fn oversized_imported_field_can_be_repaired_without_poisoning_history() {
    let (_d, s, _, p) = setup();
    fs::write(&p,format!("ai:\n  openai:\n    model: {}\n    base_url: https://example.com\n    api_key: secret\n", "m".repeat(9000))).unwrap();
    let rev = s.load().unwrap().revision;
    s.save(request(&rev, None, false)).unwrap();
    let h = s.history().unwrap();
    assert!(h[0]
        .diff
        .iter()
        .any(|d| d.before == "[VALUE EXCEEDS LIMIT]"));
    let rev = s.load().unwrap().revision;
    s.save(request(&rev, None, false)).unwrap();
}

#[test]
fn relative_path_is_resolved_without_changing_process_directory() {
    let cwd = std::env::current_dir().unwrap();
    let d = tempfile::tempdir_in(&cwd).unwrap();
    let relative = d.path().strip_prefix(&cwd).unwrap().join("ai.yml");
    let s = Store::new(relative, Arc::new(Mock::default()));
    s.save(request("missing", Some("secret"), false)).unwrap();
    assert_eq!(s.history().unwrap().len(), 1);
    assert_eq!(s.with_secret(str::to_string).unwrap(), "secret");
}

#[test]
fn unsafe_config_target_creates_no_history() {
    let (_d, s, _, p) = setup();
    fs::create_dir(&p).unwrap();
    assert!(s.save(request("missing", Some("secret"), false)).is_err());
    assert!(!PathBuf::from(format!("{}.history.json", p.display())).exists());
}

#[test]
fn identical_plaintext_saves_keep_latest_ten_ids_and_stable_hash() {
    let (_d, s, _, _) = setup();
    let mut revision = "missing".to_string();
    let mut ids = Vec::new();
    let mut semantic = None;
    for _ in 0..13 {
        let view = s.save(request(&revision, Some("secret"), false)).unwrap();
        assert_ne!(view.revision, revision);
        revision = view.revision;
        let history = s.history().unwrap();
        if let Some(hash) = &semantic {
            assert_eq!(&history[0].sha256, hash);
        } else {
            semantic = Some(history[0].sha256.clone());
        }
        ids.push(history[0].id.clone());
    }
    let expected: Vec<_> = ids.into_iter().rev().take(10).collect();
    assert_eq!(
        s.history()
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn long_unknown_nested_yaml_values_are_preserved() {
    let (_d, s, _, p) = setup();
    let long = "a".repeat(30000);
    fs::write(
        &p,
        format!("unrelated:\n  nested:\n    text: {long}\n    values: [42, false, null, '42']\n"),
    )
    .unwrap();
    let original: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    let revision = s.load().unwrap().revision;
    s.save(request(&revision, Some("secret"), false)).unwrap();
    let saved: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(original["unrelated"], saved["unrelated"]);
}

#[test]
fn missing_vault_preserve_fails_unchanged_and_explicit_new_key_recovers() {
    let (_d, s, v, p) = setup();
    let view = s
        .save(request("missing", Some("old-secret"), true))
        .unwrap();
    let before = fs::read(&p).unwrap();
    let history_path = PathBuf::from(format!("{}.history.json", p.display()));
    let history_before = fs::read(&history_path).unwrap();
    *v.0.lock().unwrap() = None;
    assert_eq!(
        s.save(request(&view.revision, None, true))
            .unwrap_err()
            .code,
        "KEY_MISSING"
    );
    assert_eq!(fs::read(&p).unwrap(), before);
    assert_eq!(fs::read(&history_path).unwrap(), history_before);
    assert!(v.0.lock().unwrap().is_none());
    s.save(request(&view.revision, Some("new-secret"), true))
        .unwrap();
    assert_eq!(s.with_secret(str::to_string).unwrap(), "new-secret");
}

#[test]
fn unavailable_vault_fails_closed_before_any_config_or_history_commit() {
    struct LockedVault;
    impl Vault for LockedVault {
        fn get_key(&self) -> Result<Option<SecretKey>> {
            Err(Error {
                code: "VAULT_UNAVAILABLE".into(),
                message: "Credential store is locked.".into(),
            })
        }
        fn create_key(&self) -> Result<SecretKey> {
            Err(Error {
                code: "VAULT_UNAVAILABLE".into(),
                message: "Credential store is locked.".into(),
            })
        }
    }
    let (_dir, existing, _, path) = setup();
    let locked = Store::new(path.clone(), Arc::new(LockedVault));
    assert_eq!(
        locked
            .save(request("missing", Some("synthetic-new-secret"), true))
            .unwrap_err()
            .code,
        "VAULT_UNAVAILABLE"
    );
    assert!(!path.exists());
    assert!(locked.history().unwrap().is_empty());
    let first = existing
        .save(request("missing", Some("synthetic-existing-secret"), true))
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    let history = fs::read(PathBuf::from(format!("{}.history.json", path.display()))).unwrap();
    assert!(locked.load().unwrap().encrypted);
    assert_eq!(
        locked
            .save(request(&first.revision, None, true))
            .unwrap_err()
            .code,
        "VAULT_UNAVAILABLE"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        fs::read(PathBuf::from(format!("{}.history.json", path.display()))).unwrap(),
        history
    );
}
