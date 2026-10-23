use super::*;
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn parse(text: &str) -> Result<Value> {
    let mut docs = serde_yaml::Deserializer::from_str(text);
    let first = docs.next().ok_or_else(|| err("INVALID_CONFIG"))?;
    let value = Value::deserialize(first).map_err(|_| err("INVALID_CONFIG"))?;
    if docs.next().is_some() || !value.is_mapping() {
        return Err(err("INVALID_CONFIG"));
    }
    check_value(&value, 0)?;
    let _ = openai(&value)?;
    Ok(value)
}
pub(super) fn check_value(v: &Value, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(err("INVALID_CONFIG"));
    }
    match v {
        Value::Tagged(_) => Err(err("INVALID_CONFIG")),
        Value::Mapping(m) => {
            for (k, v) in m {
                if !k.is_string() {
                    return Err(err("INVALID_CONFIG"));
                }
                check_value(v, depth + 1)?
            }
            Ok(())
        }
        Value::Sequence(s) => {
            for v in s {
                check_value(v, depth + 1)?
            }
            Ok(())
        }
        Value::Number(n) if n.as_f64().is_some_and(|n| !n.is_finite()) => {
            Err(err("INVALID_CONFIG"))
        }
        _ => Ok(()),
    }
}
pub(super) fn openai(doc: &Value) -> Result<Option<&Mapping>> {
    let root = doc.as_mapping().ok_or_else(|| err("INVALID_CONFIG"))?;
    let Some(ai) = root.get(Value::String("ai".into())) else {
        return Ok(None);
    };
    let ai = ai.as_mapping().ok_or_else(|| err("INVALID_CONFIG"))?;
    let Some(o) = ai.get(Value::String("openai".into())) else {
        return Ok(None);
    };
    Ok(Some(o.as_mapping().ok_or_else(|| err("INVALID_CONFIG"))?))
}
pub(super) fn field<'a>(doc: &'a Value, name: &str) -> Result<&'a str> {
    match openai(doc)?.and_then(|m| m.get(Value::String(name.into()))) {
        None => Ok(""),
        Some(Value::String(s)) => Ok(s),
        _ => Err(err("INVALID_CONFIG")),
    }
}
pub(super) fn key_text(doc: &Value) -> Result<&str> {
    field(doc, "api_key")
}
pub(super) fn view(doc: &Value, revision: String, exists: bool) -> Result<ConfigView> {
    let key = key_text(doc)?;
    Ok(ConfigView {
        exists,
        base_url: field(doc, "base_url")?.into(),
        model: field(doc, "model")?.into(),
        key_present: !key.is_empty(),
        encrypted: key.starts_with("ENC("),
        revision,
    })
}
pub(super) fn validate(url: &str, model: &str, key: &str) -> Result<()> {
    if url.len() > 8192 {
        return Err(err("INVALID_URL"));
    }
    let u = url::Url::parse(url).map_err(|_| err("INVALID_URL"))?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || url.trim() != url
        || url.chars().any(char::is_control)
        || !url.contains("://")
        || url.split_once("://").is_some_and(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .is_some_and(|authority| authority.contains('@'))
        })
    {
        return Err(err("INVALID_URL"));
    }
    if model.trim().is_empty() || model.len() > 1024 || model.chars().any(char::is_control) {
        return Err(err("INVALID_MODEL"));
    }
    if key.trim().is_empty()
        || key.len() > 65536
        || key.chars().any(char::is_control)
        || key.starts_with("ENC(")
    {
        return Err(err("INVALID_KEY"));
    }
    Ok(())
}
pub(super) fn set_fields(doc: &mut Value, url: &str, model: &str, key: &str) -> Result<()> {
    let root = doc.as_mapping_mut().ok_or_else(|| err("INVALID_CONFIG"))?;
    let ai = root
        .entry(Value::String("ai".into()))
        .or_insert(Value::Mapping(Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| err("INVALID_CONFIG"))?;
    let o = ai
        .entry(Value::String("openai".into()))
        .or_insert(Value::Mapping(Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| err("INVALID_CONFIG"))?;
    for (k, v) in [("base_url", url), ("model", model), ("api_key", key)] {
        o.insert(Value::String(k.into()), Value::String(v.into()));
    }
    Ok(())
}
pub(super) fn canonical_hash(doc: &Value, key: &Secret) -> Result<String> {
    let mut plain = doc.clone();
    let url = field(doc, "base_url")?;
    let model = field(doc, "model")?;
    set_fields(&mut plain, url, model, &key.0)?;
    fn norm(v: &Value) -> Result<serde_json::Value> {
        match v {
            Value::Mapping(m) => {
                let mut out = serde_json::Map::new();
                let mut entries = m
                    .iter()
                    .map(|(k, v)| Ok((k.as_str().ok_or_else(|| err("INVALID_CONFIG"))?, v)))
                    .collect::<Result<Vec<_>>>()?;
                entries.sort_by(|a, b| a.0.cmp(b.0));
                for (k, v) in entries {
                    out.insert(k.into(), norm(v)?);
                }
                Ok(serde_json::Value::Object(out))
            }
            Value::Sequence(s) => Ok(serde_json::Value::Array(
                s.iter().map(norm).collect::<Result<_>>()?,
            )),
            _ => serde_json::to_value(v).map_err(|_| err("INVALID_CONFIG")),
        }
    }
    let mut tree = norm(&plain)?;
    let data = Zeroizing::new(serde_json::to_vec(&tree).map_err(|_| err("INVALID_CONFIG"))?);
    // The digest is over plaintext, so the JSON tree holds every secret that the
    // document carries. Wipe those strings (and the serialized bytes above) as soon
    // as the hash exists instead of leaving them for the allocator to reuse.
    wipe_json(&mut tree);
    drop(plain);
    Ok(hash(&data))
}
fn wipe_json(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(a) => a.iter_mut().for_each(wipe_json),
        serde_json::Value::Object(o) => o.values_mut().for_each(wipe_json),
        _ => {}
    }
}
