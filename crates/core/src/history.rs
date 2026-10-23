use super::*;
pub(super) fn validate_history(h: &[HistoryEntry]) -> Result<()> {
    if h.len() > 10 {
        return Err(err("HISTORY_CORRUPT"));
    }
    for e in h {
        if e.id.len() != 32
            || !e.id.bytes().all(|b| b.is_ascii_hexdigit())
            || e.sha256.len() != 64
            || !e.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || chrono::DateTime::parse_from_rfc3339(&e.timestamp).is_err()
            || !matches!(e.source.as_str(), "desktop" | "cli" | "skill" | "test")
            || e.diff.len() > 4
        {
            return Err(err("HISTORY_CORRUPT"));
        }
        for d in &e.diff {
            if !matches!(
                d.field.as_str(),
                "api_key" | "base_url" | "model" | "encrypted"
            ) || d.before.len() > 8192
                || d.after.len() > 8192
            {
                return Err(err("HISTORY_CORRUPT"));
            }
            if d.field == "api_key"
                && (!matches!(d.before.as_str(), "[REDACTED]" | "[EMPTY]")
                    || d.after != "[REDACTED]")
            {
                return Err(err("HISTORY_CORRUPT"));
            }
        }
    }
    Ok(())
}
