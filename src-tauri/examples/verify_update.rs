//! Local release preflight only. Uses the same verifier as Tauri, without running an installer.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs};

fn verify(data: &[u8], encoded_key: &str, encoded_signature: &str) -> Result<(), Box<dyn Error>> {
    let key = String::from_utf8(STANDARD.decode(encoded_key.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(encoded_signature.trim())?)?;
    PublicKey::decode(&key)?.verify(data, &Signature::decode(&signature)?, true)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("Usage: verify_update <tauri.conf.json> <installer> <installer.sig>".into());
    }
    let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(&args[0])?)?;
    let public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Missing updater public key")?;
    verify(
        &fs::read(&args[1])?,
        public_key,
        &fs::read_to_string(&args[2])?,
    )?;
    println!("Update artifact signature verified against the configured public key.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Public upstream minisign-verify example, not a production signing key.
    const KEY: &str = "untrusted comment: test public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";
    #[test]
    fn authentic_payload_passes_and_tampered_payload_fails() {
        let key = STANDARD.encode(KEY);
        let signature = STANDARD.encode(SIGNATURE);
        assert!(verify(b"test", &key, &signature).is_ok());
        assert!(verify(b"tampered", &key, &signature).is_err());
    }
    #[test]
    fn missing_or_corrupt_key_and_signature_fail_closed() {
        assert!(verify(b"test", "", &STANDARD.encode(SIGNATURE)).is_err());
        assert!(verify(b"test", &STANDARD.encode(KEY), "not a signature").is_err());
        assert!(verify(
            b"test",
            &STANDARD.encode(KEY),
            &STANDARD.encode(SIGNATURE.replace("zZwo=", "aZwo="))
        )
        .is_err());
    }
}
