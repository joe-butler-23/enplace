//! Cooking config loader for the simplified mep workflow.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PromptConfig {
    #[serde(default)]
    pub overlay_file: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractionConfig {
    #[serde(default)]
    pub include_method_only_ingredients: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookingConfig {
    #[serde(default = "default_label")]
    pub default_label: String,
    #[serde(default = "default_labels")]
    pub labels: Vec<String>,
    #[serde(default = "default_ignore")]
    pub ignore: Vec<String>,
    #[serde(default)]
    pub merge: BTreeMap<String, String>,
    #[serde(default)]
    pub prompt: PromptConfig,
    #[serde(default)]
    pub extraction: ExtractionConfig,
}

impl Default for CookingConfig {
    fn default() -> Self {
        Self {
            default_label: default_label(),
            labels: default_labels(),
            ignore: default_ignore(),
            merge: default_merge(),
            prompt: PromptConfig::default(),
            extraction: ExtractionConfig::default(),
        }
    }
}

pub fn cooking_config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("cooking.toml")
}

pub fn load_cooking_config(config_dir: &Path) -> Result<CookingConfig> {
    let path = cooking_config_path(config_dir);
    if !path.exists() {
        return Ok(CookingConfig::default());
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| Error::backend(format!("read config {}: {}", path.display(), e)))?;
    let mut cfg = toml::from_str::<CookingConfig>(&raw)
        .map_err(|e| Error::parse(format!("parse config {}: {}", path.display(), e)))?;
    normalize_config(&mut cfg)?;
    Ok(cfg)
}

fn normalize_config(cfg: &mut CookingConfig) -> Result<()> {
    if cfg.labels.is_empty() {
        return Err(Error::validation("cooking config labels cannot be empty"));
    }

    let mut seen = BTreeSet::new();
    let mut labels = Vec::with_capacity(cfg.labels.len());
    for label in &cfg.labels {
        let normalized = label.trim().to_string();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.clone()) {
            labels.push(normalized);
        }
    }
    if labels.is_empty() {
        return Err(Error::validation("cooking config labels cannot be empty"));
    }
    cfg.labels = labels;

    cfg.default_label = cfg.default_label.trim().to_string();
    if cfg.default_label.is_empty() {
        cfg.default_label = default_label();
    }
    if !cfg.labels.iter().any(|v| v == &cfg.default_label) {
        return Err(Error::validation(format!(
            "default_label '{}' is not present in labels",
            cfg.default_label
        )));
    }

    cfg.ignore = cfg
        .ignore
        .iter()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();

    let mut normalized_merge = BTreeMap::new();
    for (from, to) in &cfg.merge {
        let from_key = from.trim().to_ascii_lowercase();
        let to_value = to.trim().to_ascii_lowercase();
        if from_key.is_empty() || to_value.is_empty() {
            continue;
        }
        normalized_merge.insert(from_key, to_value);
    }
    cfg.merge = normalized_merge;

    if let Some(path) = cfg.prompt.overlay_file.as_mut() {
        let trimmed = path.trim().to_string();
        if trimmed.is_empty() {
            *path = String::new();
        } else {
            *path = trimmed;
        }
    }

    Ok(())
}

fn default_label() -> String {
    "other".to_string()
}

fn default_labels() -> Vec<String> {
    vec![
        "fruit & veg".to_string(),
        "meat & fish".to_string(),
        "dairy".to_string(),
        "bakery".to_string(),
        "oils & condiments".to_string(),
        "spices & seasonings".to_string(),
        "tins & jars".to_string(),
        "frozen".to_string(),
        "drinks".to_string(),
        "other".to_string(),
    ]
}

fn default_ignore() -> Vec<String> {
    vec![
        "salt".to_string(),
        "pepper".to_string(),
        "water".to_string(),
        "ice".to_string(),
        "oil for frying".to_string(),
        "cooking spray".to_string(),
    ]
}

fn default_merge() -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    map.insert(
        "extra virgin olive oil".to_string(),
        "olive oil".to_string(),
    );
    map.insert("fresh coriander".to_string(), "coriander".to_string());
    map.insert("flat-leaf parsley".to_string(), "parsley".to_string());
    map
}
