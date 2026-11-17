//! What is left of the satellite's edge (plan 3.3) after P4 removed the Bun satellite: the constant-time secret check
//! the Telegram front desk's header uses (`telegram::desk`).

/// Whether `got` is the secret (same length and bytes, compared in constant time).
pub fn secret_matches(got: &[u8], secret: &str) -> bool {
    let want = secret.as_bytes();
    if got.len() != want.len() || want.is_empty() {
        return false;
    }
    got.iter().zip(want).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_needs_the_same_bytes() {
        assert!(secret_matches(b"abc", "abc"));
        assert!(!secret_matches(b"abd", "abc"));
        assert!(!secret_matches(b"ab", "abc"));
        assert!(!secret_matches(b"", ""));
    }
}
