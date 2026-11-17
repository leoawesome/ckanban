//! Web Push without a web-push library (`src/helper/webpush.ts`): VAPID (RFC 8292, an ES256 JWT) and the aes128gcm
//! payload encryption (RFC 8291), on aws-lc-rs (already in the build through rustls). The browser's push service
//! (FCM, Mozilla, Apple) gets the encrypted body and wakes the board's service worker (`web/public/sw.js`).

use aws_lc_rs::aead::{AES_128_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::agreement::{self, ECDH_P256, PrivateKey, UnparsedPublicKey};
use aws_lc_rs::encoding::AsBigEndian;
use aws_lc_rs::hmac;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::json;

/// `Buffer.toString("base64url")`: no padding.
pub fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// `Buffer.from(s, "base64url")`: padding or not.
pub fn from_b64url(s: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose =
        GeneralPurpose::new(&base64::alphabet::URL_SAFE, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true));
    LENIENT.decode(s.trim_end_matches('=')).unwrap_or_default()
}

/// The board's VAPID key pair: P-256, public key uncompressed (65 bytes), private scalar (32 bytes), base64url.
#[derive(Clone, Debug, PartialEq)]
pub struct VapidKeys {
    pub public_key: String,
    pub private_key: String,
}

pub fn generate_vapid_keys() -> VapidKeys {
    let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).expect("P-256 key");
    let private = pair.private_key().as_be_bytes().expect("private key");
    VapidKeys { public_key: b64url(pair.public_key().as_ref()), private_key: b64url(private.as_ref()) }
}

/// A private scalar as 32 bytes (a shorter one, from a key that began with zero bytes, padded).
fn scalar32(b: &[u8]) -> Option<[u8; 32]> {
    if b.len() > 32 || b.is_empty() {
        return None;
    }
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(b);
    Some(out)
}

fn hmac256(key: &[u8], data: &[&[u8]]) -> Vec<u8> {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key);
    let mut ctx = hmac::Context::with_key(&k);
    for d in data {
        ctx.update(d);
    }
    ctx.sign().as_ref().to_vec()
}

/// HKDF (one block), as `webpush.ts` `hkdf`.
fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let prk = hmac256(salt, &[ikm]);
    let mut out = hmac256(&prk, &[info, &[1u8]]);
    out.truncate(len);
    out
}

/// Fixed sender key and salt, for the RFC 8291 test vector only.
pub struct EncryptFixture<'a> {
    pub sender_private_key: &'a str,
    pub salt: &'a str,
}

const RECORD_SIZE: u32 = 4096;

/// RFC 8291 aes128gcm body: salt, record size, sender public key, then one record (payload, 0x02 padding delimiter).
pub fn encrypt_payload(payload: &[u8], p256dh: &str, auth: &str, fixture: Option<&EncryptFixture>) -> Result<Vec<u8>, String> {
    let ua_public = from_b64url(p256dh);
    let auth_secret = from_b64url(auth);
    if ua_public.len() != 65 || auth_secret.len() < 16 {
        return Err("invalid push keys".into());
    }
    let key = match fixture {
        Some(f) => PrivateKey::from_private_key(&ECDH_P256, &scalar32(&from_b64url(f.sender_private_key)).ok_or("invalid push keys")?).map_err(|_| "invalid push keys".to_string())?,
        None => PrivateKey::generate(&ECDH_P256).map_err(|_| "can't make a key".to_string())?,
    };
    let as_public = key.compute_public_key().map_err(|_| "invalid push keys".to_string())?.as_ref().to_vec();
    let salt = match fixture {
        Some(f) => from_b64url(f.salt),
        None => {
            let mut s = vec![0u8; 16];
            SystemRandom::new().fill(&mut s).map_err(|_| "no random bytes".to_string())?;
            s
        }
    };
    let shared = agreement::agree(&key, UnparsedPublicKey::new(&ECDH_P256, &ua_public), "invalid push keys".to_string(), |k| Ok(k.to_vec()))?;
    let info = [b"WebPush: info\0".as_slice(), &ua_public, &as_public].concat();
    let ikm = hkdf(&auth_secret, &shared, &info, 32);
    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12);
    if payload.len() + 1 + 16 > RECORD_SIZE as usize {
        return Err("push payload too large".into());
    }
    let sealing = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek).map_err(|_| "cipher".to_string())?);
    let mut body = [payload, &[2u8]].concat();
    let n = Nonce::try_assume_unique_for_key(&nonce).map_err(|_| "nonce".to_string())?;
    sealing.seal_in_place_append_tag(n, Aad::empty(), &mut body).map_err(|_| "cipher".to_string())?;
    let mut out = Vec::with_capacity(21 + as_public.len() + body.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&body);
    Ok(out)
}

/// The receiving side of `encrypt_payload` (what the browser does); for tests.
pub fn decrypt_payload(body: &[u8], ua_private_key: &str, auth_secret: &str) -> Result<Vec<u8>, String> {
    let bad = || "can't decrypt".to_string();
    let salt = body.get(..16).ok_or_else(bad)?;
    let idlen = *body.get(20).ok_or_else(bad)? as usize;
    let as_public = body.get(21..21 + idlen).ok_or_else(bad)?;
    let key = PrivateKey::from_private_key(&ECDH_P256, &scalar32(&from_b64url(ua_private_key)).ok_or_else(bad)?).map_err(|_| bad())?;
    let ua_public = key.compute_public_key().map_err(|_| bad())?.as_ref().to_vec();
    let shared = agreement::agree(&key, UnparsedPublicKey::new(&ECDH_P256, as_public), bad(), |k| Ok(k.to_vec()))?;
    let info = [b"WebPush: info\0".as_slice(), &ua_public, as_public].concat();
    let ikm = hkdf(&from_b64url(auth_secret), &shared, &info, 32);
    let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12);
    let opening = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek).map_err(|_| bad())?);
    let mut data = body[21 + idlen..].to_vec();
    let plain = opening.open_in_place(Nonce::try_assume_unique_for_key(&nonce).map_err(|_| bad())?, Aad::empty(), &mut data).map_err(|_| bad())?;
    let end = plain.iter().rposition(|b| *b == 2).ok_or_else(bad)?;
    Ok(plain[..end].to_vec())
}

/// The VAPID signing key from the stored pair.
fn vapid_key(keys: &VapidKeys) -> Result<EcdsaKeyPair, String> {
    let private = scalar32(&from_b64url(&keys.private_key)).ok_or("the board's push keys are damaged")?;
    EcdsaKeyPair::from_private_key_and_public_key(&ECDSA_P256_SHA256_FIXED_SIGNING, &private, &from_b64url(&keys.public_key))
        .map_err(|_| "the board's push keys are damaged".to_string())
}

/// RFC 8292 JWT for one push service (aud = its origin), valid 12 hours.
pub fn vapid_jwt(audience: &str, subject: &str, keys: &VapidKeys, now_sec: i64) -> Result<String, String> {
    let enc = |v: serde_json::Value| b64url(v.to_string().as_bytes());
    let input = format!("{}.{}", enc(json!({ "typ": "JWT", "alg": "ES256" })), enc(json!({ "aud": audience, "exp": now_sec + 12 * 3600, "sub": subject })));
    let sig = vapid_key(keys)?.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "can't sign the push request".to_string())?;
    Ok(format!("{input}.{}", b64url(sig.as_ref())))
}

/// Apple rejects a JWT without a real-looking contact; any https URL or mailto works.
pub const VAPID_SUBJECT: &str = "https://github.com/leoawesome/ckanban";

/// The HTTP request that delivers one encrypted message to a browser's push service: its headers and body.
pub struct PushRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// `new URL(endpoint).origin`.
pub fn origin(endpoint: &str) -> Result<String, String> {
    let u = url::Url::parse(endpoint).map_err(|_| "endpoint is not a valid URL".to_string())?;
    Ok(u.origin().ascii_serialization())
}

pub fn push_request(endpoint: &str, p256dh: &str, auth: &str, payload: &str, keys: &VapidKeys, now_sec: i64) -> Result<PushRequest, String> {
    let aud = origin(endpoint)?;
    Ok(PushRequest {
        url: endpoint.to_string(),
        headers: vec![
            ("TTL", (24 * 3600).to_string()),
            ("Urgency", "high".into()),
            ("Content-Encoding", "aes128gcm".into()),
            ("Content-Type", "application/octet-stream".into()),
            ("Authorization", format!("vapid t={}, k={}", vapid_jwt(&aud, VAPID_SUBJECT, keys, now_sec)?, keys.public_key)),
        ],
        body: encrypt_payload(payload.as_bytes(), p256dh, auth, None)?,
    })
}

/// Short stable id for a device, from its push endpoint (sha256 hex, 12 characters).
pub fn device_id(endpoint: &str) -> String {
    let d = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, endpoint.as_bytes());
    d.as_ref().iter().take(6).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey as SigKey};

    // RFC 8291 section 5 / appendix A (the same vector as push.test.ts).
    const PLAIN: &str = "When I grow up, I want to be a watermelon";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    #[test]
    fn aes128gcm_matches_the_rfc_8291_test_vector() {
        let out = encrypt_payload(PLAIN.as_bytes(), UA_PUBLIC, AUTH, Some(&EncryptFixture { sender_private_key: AS_PRIVATE, salt: SALT })).unwrap();
        assert_eq!(b64url(&out), BODY);
        assert_eq!(decrypt_payload(&from_b64url(BODY), UA_PRIVATE, AUTH).unwrap(), PLAIN.as_bytes());
        // A random sender key and salt still decrypt on the browser side.
        let out = encrypt_payload(b"hi there", UA_PUBLIC, AUTH, None).unwrap();
        assert_eq!(decrypt_payload(&out, UA_PRIVATE, AUTH).unwrap(), b"hi there");
        assert!(encrypt_payload(b"x", "AAAA", AUTH, None).is_err());
        assert_eq!(encrypt_payload(&vec![b'a'; 4080], UA_PUBLIC, AUTH, None).unwrap_err(), "push payload too large");
    }

    #[test]
    fn the_vapid_jwt_verifies_with_the_public_key() {
        let keys = generate_vapid_keys();
        assert_eq!(from_b64url(&keys.public_key).len(), 65);
        assert_eq!(from_b64url(&keys.private_key).len(), 32);
        let jwt = vapid_jwt("https://fcm.googleapis.com", VAPID_SUBJECT, &keys, 1_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(String::from_utf8(from_b64url(parts[0])).unwrap(), r#"{"typ":"JWT","alg":"ES256"}"#);
        assert_eq!(String::from_utf8(from_b64url(parts[1])).unwrap(), r#"{"aud":"https://fcm.googleapis.com","exp":44200,"sub":"https://github.com/leoawesome/ckanban"}"#);
        let pk = from_b64url(&keys.public_key);
        SigKey::new(&ECDSA_P256_SHA256_FIXED, &pk).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &from_b64url(parts[2])).unwrap();
        // A pair whose halves don't match is refused, not used.
        let other = generate_vapid_keys();
        assert!(vapid_jwt("https://x", VAPID_SUBJECT, &VapidKeys { public_key: other.public_key, private_key: keys.private_key }, 0).is_err());
    }

    #[test]
    fn the_request_and_the_device_id_are_bun_s() {
        let keys = generate_vapid_keys();
        let r = push_request("https://fcm.googleapis.com/fcm/send/abc", UA_PUBLIC, AUTH, "{}", &keys, 0).unwrap();
        let names: Vec<&str> = r.headers.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, ["TTL", "Urgency", "Content-Encoding", "Content-Type", "Authorization"]);
        assert_eq!(r.headers[0].1, "86400");
        assert!(r.headers[4].1.ends_with(&format!(", k={}", keys.public_key)));
        // createHash("sha256").update("https://example.com/x").digest("hex").slice(0, 12)
        assert_eq!(device_id("https://example.com/x"), "54cef8f42f3f");
    }
}
