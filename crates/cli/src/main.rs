//! Secret-free command-line interface. No argument accepts credentials.
use ai_config_core::{NativeVault, Store};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

fn output(value: Value, success: bool) -> ! {
    println!("{}", value);
    std::process::exit(if success { 0 } else { 1 });
}
fn failure(code: &str, message: &str) -> ! {
    output(
        json!({"ok":false,"error":{"code":code,"message":message}}),
        false,
    )
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args == ["--help"] || args == ["help"] {
        println!("ai-config <read|check|history> [--config PATH]\nJSON output never includes an API key. Default: ~/.config/ai.yml\nread: redacted metadata; check: validate configuration and decrypt in memory; history: last 10 changes.\nExit 0 success; 1 failure. No configuration writes or network requests.");
        return;
    }
    let path = match args.as_slice() {
        [_] => match Store::default_path() {
            Ok(path) => path,
            Err(e) => failure(&e.code, &e.message),
        },
        [_, option, path] if option == "--config" => PathBuf::from(path),
        _ => failure(
            "INVALID_ARGUMENT",
            "Use read, check or history with optional --config PATH.",
        ),
    };
    if !["read", "check", "history"].contains(&args[0].as_str()) {
        failure("INVALID_ARGUMENT", "Unknown operation. Use --help.");
    }
    let store = Store::new(path, Arc::new(NativeVault::new()));
    let value = match args[0].as_str() {
        "read" => store.load().and_then(|v| {
            serde_json::to_value(v).map_err(|_| ai_config_core::Error {
                code: "SERIALIZE".into(),
                message: "Cannot encode metadata.".into(),
            })
        }),
        "check" => store.validate_secret().map(|_| json!({"valid":true})),
        "history" => store.history().and_then(|v| {
            serde_json::to_value(v).map_err(|_| ai_config_core::Error {
                code: "SERIALIZE".into(),
                message: "Cannot encode history.".into(),
            })
        }),
        _ => unreachable!(),
    };
    match value {
        Ok(data) => output(json!({"ok":true,"data":data}), true),
        Err(e) => failure(&e.code, &e.message),
    }
}
