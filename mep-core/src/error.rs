//! Error types for mep-core.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Backend error: {0}")]
    BackendError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Operation error: {0}")]
    OperationError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("Not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Error::NotFound(msg.into())
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Error::ValidationError(msg.into())
    }

    pub fn backend(msg: impl Into<String>) -> Self {
        Error::BackendError(msg.into())
    }

    pub fn parse(msg: impl Into<String>) -> Self {
        Error::ParseError(msg.into())
    }
}
