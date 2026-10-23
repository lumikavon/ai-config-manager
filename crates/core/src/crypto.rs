use super::*;
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Secret(pub(super) String);
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}
impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub fn expose<T>(&self, f: impl FnOnce(&str) -> T) -> T {
        f(&self.0)
    }
}
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecretKey(pub(super) [u8; 32]);
impl SecretKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self(key)
    }
}
impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey([REDACTED])")
    }
}
pub trait Vault: Send + Sync {
    fn get_key(&self) -> Result<Option<SecretKey>>;
    fn create_key(&self) -> Result<SecretKey>;
}
pub struct NativeVault;
impl Default for NativeVault {
    fn default() -> Self {
        Self::new()
    }
}
impl NativeVault {
    pub fn new() -> Self {
        Self
    }
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new("ai-config-manager", "config-encryption-v1")
            .map_err(|_| err("VAULT_UNAVAILABLE"))
    }
}
impl Vault for NativeVault {
    fn get_key(&self) -> Result<Option<SecretKey>> {
        match self.entry()?.get_secret() {
            Ok(mut v) => {
                if v.len() != 32 {
                    v.zeroize();
                    return Err(err("DECRYPT_FAILED"));
                }
                let mut k = [0; 32];
                k.copy_from_slice(&v);
                v.zeroize();
                Ok(Some(SecretKey(k)))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(err("VAULT_UNAVAILABLE")),
        }
    }
    fn create_key(&self) -> Result<SecretKey> {
        let parent = dirs::home_dir().ok_or_else(|| err("IO"))?.join(".config");
        safe_ancestors(&parent)?;
        fs::create_dir_all(&parent).map_err(|_| err("IO"))?;
        let lockpath = parent.join(".ai-config-manager-vault.lock");
        safe_file(&lockpath)?;
        let lock = platform::open_private(&lockpath, false)?;
        lock_bounded(&lock)?;
        if let Some(k) = self.get_key()? {
            return Ok(k);
        }
        let mut k = SecretKey([0; 32]);
        OsRng.fill_bytes(&mut k.0);
        self.entry()?
            .set_secret(&k.0)
            .map_err(|_| err("VAULT_UNAVAILABLE"))?;
        Ok(k)
    }
}

impl Store {
    pub(super) fn decrypt(&self, value: &str) -> Result<Secret> {
        if !value.starts_with("ENC(") {
            return Ok(Secret(value.into()));
        }
        if !value.starts_with("ENC(v1:") || !value.ends_with(')') {
            return Err(err("DECRYPT_FAILED"));
        }
        let bytes = Zeroizing::new(
            STANDARD
                .decode(&value[7..value.len() - 1])
                .map_err(|_| err("DECRYPT_FAILED"))?,
        );
        if bytes.len() < 28 {
            return Err(err("DECRYPT_FAILED"));
        }
        let key = self.vault.get_key()?.ok_or_else(|| err("KEY_MISSING"))?;
        let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| err("DECRYPT_FAILED"))?;
        let raw = cipher
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &bytes[12..],
                    aad: AAD,
                },
            )
            .map_err(|_| err("DECRYPT_FAILED"))?;
        Ok(Secret(
            String::from_utf8(raw).map_err(|_| err("DECRYPT_FAILED"))?,
        ))
    }
    pub(super) fn encrypt(&self, s: &Secret) -> Result<String> {
        let key = self.vault.create_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| err("ENCRYPT_FAILED"))?;
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: s.0.as_bytes(),
                    aad: AAD,
                },
            )
            .map_err(|_| err("ENCRYPT_FAILED"))?;
        let mut b = nonce.to_vec();
        b.extend(ct);
        Ok(format!("ENC(v1:{})", STANDARD.encode(b)))
    }
}
