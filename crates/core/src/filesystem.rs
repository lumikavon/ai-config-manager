use super::*;
pub(super) fn safe_ancestors(p: &Path) -> Result<()> {
    for a in p.ancestors() {
        if a.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(a) {
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(err("UNSAFE_PATH")),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(err("IO")),
        }
    }
    Ok(())
}
pub(super) fn safe_file(p: &Path) -> Result<()> {
    if let Some(parent) = p.parent() {
        safe_ancestors(parent)?
    }
    match fs::symlink_metadata(p) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(err("UNSAFE_PATH")),
        Ok(m) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if m.nlink() != 1 {
                    return Err(err("UNSAFE_PATH"));
                }
            }
            #[cfg(windows)]
            let _ = m;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(err("IO")),
    }
}
pub(super) fn read_bounded(p: &Path) -> Result<Option<Vec<u8>>> {
    safe_file(p)?;
    let mut f = match platform::open_read(p) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(err("IO")),
    };
    if f.metadata().map_err(|_| err("IO"))?.len() > MAX_FILE {
        return Err(err("TOO_LARGE"));
    }
    let mut out = Vec::new();
    (&mut f)
        .take(MAX_FILE + 1)
        .read_to_end(&mut out)
        .map_err(|_| err("IO"))?;
    if out.len() as u64 > MAX_FILE {
        return Err(err("TOO_LARGE"));
    }
    Ok(Some(out))
}
pub(super) fn sync_parent(p: &Path) -> Result<()> {
    platform::sync_parent(p)
}
pub(super) fn write_atomic(p: &Path, data: &[u8]) -> Result<()> {
    safe_file(p)?;
    let mut rand = [0u8; 16];
    OsRng.fill_bytes(&mut rand);
    let mut name = p.as_os_str().to_os_string();
    name.push(format!(
        ".stage-{}",
        STANDARD.encode(rand).replace('/', "_").replace('+', "-")
    ));
    let stage = PathBuf::from(name);
    let result = (|| {
        let mut f = platform::open_private(&stage, true)?;
        f.write_all(data).map_err(|_| err("IO"))?;
        f.sync_all().map_err(|_| err("IO"))?;
        safe_file(p)?;
        #[cfg(test)]
        fail_at(p, false)?;
        platform::replace(&stage, p)?;
        #[cfg(test)]
        fail_at(p, true)?;
        sync_parent(p)
    })();
    let _ = fs::remove_file(&stage);
    result
}

/// Windows reports lock contention as `ERROR_LOCK_VIOLATION` (33) rather than
/// `ErrorKind::WouldBlock`, so testing only the `io::ErrorKind` silently turned a
/// busy lock into an immediate `IO` failure and skipped the bounded retry window.
fn lock_is_contended(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    match e.raw_os_error() {
        #[cfg(windows)]
        Some(32) | Some(33) => true, // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        #[cfg(unix)]
        Some(code) => code == libc::EAGAIN || code == libc::EWOULDBLOCK,
        _ => false,
    }
}
pub(super) fn lock_bounded(file: &File) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(e) if lock_is_contended(&e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(err("LOCK_TIMEOUT"));
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return Err(err("IO")),
        }
    }
}

#[cfg(test)]
thread_local! { pub(super) static FAIL_WRITE: std::cell::RefCell<Option<(PathBuf,bool)>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
fn fail_at(path: &Path, after: bool) -> Result<()> {
    FAIL_WRITE.with(|f| {
        if f.borrow()
            .as_ref()
            .is_some_and(|(p, a)| p == path && *a == after)
        {
            f.borrow_mut().take();
            Err(err("IO"))
        } else {
            Ok(())
        }
    })
}
