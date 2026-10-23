use std::process::Command;
use tempfile::TempDir;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_ai-config"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn help_and_invalid_argument_are_secret_free() {
    assert!(run(&["--help"]).status.success());
    let output = run(&["not-an-operation"]);
    assert!(!output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "INVALID_ARGUMENT");
}

#[test]
fn read_plaintext_never_returns_key_and_check_is_offline() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("ai.yml");
    let marker = "synthetic-secret-never-print-987654321";
    std::fs::write(&path, format!("ai:\n  openai:\n    base_url: https://example.invalid/v1\n    api_key: {marker}\n    model: test-model\n")).unwrap();
    let output = run(&["read", "--config", path.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(marker));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(marker));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["data"]["key_present"], true);
    assert_eq!(value["data"]["model"], "test-model");
    assert!(run(&["check", "--config", path.to_str().unwrap()])
        .status
        .success());
}

#[test]
fn damaged_yaml_diagnostic_does_not_echo_input() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("ai.yml");
    let marker = "synthetic-secret-in-parser-error";
    std::fs::write(&path, format!("ai: [\n  {marker}: {{\n")).unwrap();
    let output = run(&["read", "--config", path.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(marker));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(marker));
}

#[test]
fn unsupported_encryption_is_reported_without_vault_access_or_secret_output() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("ai.yml");
    let fixture = "ai:\n  openai:\n    base_url: https://example.invalid/v1\n    model: encrypted-model\n    api_key: ENC(v99:invalid-envelope)\n";
    std::fs::write(&path, fixture).unwrap();
    let read = run(&["read", "--config", path.to_str().unwrap()]);
    assert!(read.status.success());
    let value: serde_json::Value = serde_json::from_slice(&read.stdout).unwrap();
    assert_eq!(value["data"]["encrypted"], true);
    assert!(!String::from_utf8_lossy(&read.stdout).contains("invalid-envelope"));
    let check = run(&["check", "--config", path.to_str().unwrap()]);
    assert!(!check.status.success());
    let error: serde_json::Value = serde_json::from_slice(&check.stdout).unwrap();
    assert_eq!(error["error"]["code"], "DECRYPT_FAILED");
    assert_eq!(std::fs::read_to_string(path).unwrap(), fixture);
}
