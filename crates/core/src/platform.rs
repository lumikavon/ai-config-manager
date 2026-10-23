use super::{err, Result};
#[cfg(unix)]
use std::fs::{self, OpenOptions};
use std::{fs::File, path::Path};
#[cfg(unix)]
pub fn open_private(p: &Path, exclusive: bool) -> Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut o = OpenOptions::new();
    o.read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    if exclusive {
        o.create_new(true);
    } else {
        o.create(true);
    }
    let f = o.open(p).map_err(|_| err("IO"))?;
    f.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| err("IO"))?;
    Ok(f)
}
#[cfg(unix)]
pub fn replace(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(|_| err("IO"))
}
#[cfg(unix)]
pub fn sync_parent(p: &Path) -> Result<()> {
    File::open(p.parent().ok_or_else(|| err("IO"))?)
        .and_then(|f| f.sync_all())
        .map_err(|_| err("IO"))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{FromRawHandle, RawHandle},
        },
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
        System::Threading::*,
    };
    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    pub fn open_private(p: &Path, exclusive: bool) -> Result<File> {
        unsafe {
            let mut token = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(err("IO"));
            }
            let mut needed = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            let mut buf = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                CloseHandle(token);
                return Err(err("IO"));
            }
            CloseHandle(token);
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid_string = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_string) == 0 {
                return Err(err("IO"));
            }
            let mut len = 0;
            while *sid_string.add(len) != 0 {
                len += 1
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, len));
            LocalFree(sid_string.cast());
            let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut sd = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut sd,
                ptr::null_mut(),
            ) == 0
            {
                return Err(err("IO"));
            }
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            let handle = CreateFileW(
                wide(p).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &sa,
                if exclusive { CREATE_NEW } else { OPEN_ALWAYS },
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                LocalFree(sd);
                return Err(err("IO"));
            }
            // Apply a protected DACL to existing lock files as well as new private files.
            let ok = SetFileSecurityW(
                wide(p).as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                sd,
            );
            LocalFree(sd);
            if ok == 0 {
                CloseHandle(handle);
                return Err(err("IO"));
            }
            Ok(File::from_raw_handle(handle as RawHandle))
        }
    }
    pub fn replace(from: &Path, to: &Path) -> Result<()> {
        unsafe {
            if MoveFileExW(
                wide(from).as_ptr(),
                wide(to).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ) == 0
            {
                Err(err("IO"))
            } else {
                Ok(())
            }
        }
    }
    pub fn sync_parent(_: &Path) -> Result<()> {
        Ok(())
    }
}
#[cfg(windows)]
pub use win::{open_private, replace, sync_parent};

#[cfg(unix)]
pub fn open_read(p: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(p)
}
#[cfg(windows)]
pub fn open_read(p: &Path) -> std::io::Result<File> {
    File::open(p)
}
