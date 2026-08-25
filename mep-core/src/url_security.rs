use crate::{Error, Result};
use url::Url;

/// Validate recipe-source provenance without resolving or fetching it.
pub fn validate_http_url_syntax(raw_url: &str) -> Result<()> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|_| Error::validation("source must be an http/https URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(Error::validation("source must be an http/https URL"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Error::validation("source URL must not contain credentials"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_url_syntax_validation_is_network_free_and_rejects_credentials() {
        validate_http_url_syntax("https://example.com/recipe").expect("valid source URL");
        assert!(validate_http_url_syntax("file:///tmp/recipe.md").is_err());
        assert!(validate_http_url_syntax("https://user@example.com/recipe").is_err());
    }
}
