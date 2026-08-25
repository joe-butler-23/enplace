//! Minimal shared primitives for mep CLI and Tauri bridge.

mod config;
mod cooking;
mod error;
mod pipe;
pub mod shopping_list;
pub mod thumbnails;
mod url_security;
pub mod watch;

pub use config::{cooking_config_path, load_cooking_config, CookingConfig, PromptConfig};
pub use cooking::{
    aggregate_rust, build_desired_items, choose_configured_label, label_for_typescript_ingredient,
    normalize_typescript_name, parse_machine_recipe_ingredients, parse_recipe_markdown,
    parse_rust_quantity, parse_typescript_ingredient_line, render_machine_sidecar,
    render_recipe_artifacts, render_recipe_capture_artifacts, render_recipe_markdown,
    validate_recipe_markdown, CookingRecipe, CookingRecipeInput, DesiredItem,
    IngredientResolutionPayload, MachineIngredient, MachineRecipe, MachineSidecar,
    MachineSourceJob, MachineSync, MetricUnit, ParsedTypeScriptIngredient,
    RecipeCaptureRenderInput, RecipeRenderInput, RenderedRecipeArtifacts, ShoppingItem,
    ValidatedRecipeBody, SIDECAR_SCHEMA_VERSION,
};
pub use error::{Error, Result};
pub use pipe::{parse_pipe_ingredient_line, PipeIngredient};
pub use url_security::validate_http_url_syntax;

use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut tmp_path = path.as_os_str().to_os_string();
    tmp_path.push(".tmp");
    let tmp_path = PathBuf::from(tmp_path);

    if let Err(error) = fs::write(&tmp_path, contents) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    Ok(())
}

/// Extract a single field from markdown frontmatter using simple line matching.
/// Note: This is a fast, simplified parser for basic fields. For complex nested
/// YAML, use a full YAML parser.
pub fn frontmatter_field(markdown: &str, key: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }

        if let Some(value) = trimmed.strip_prefix(&format!("{}:", key)) {
            return Some(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }

    None
}

/// Find a `## <section_name>` markdown section and return its body line range
/// plus the raw body lines.
///
/// Heading matching is case-insensitive and tolerant: a line matches when it
/// either equals `## <section_name>` (ASCII-case-insensitive) or starts with
/// `##` and contains `<section_name>` (ASCII-case-insensitive). The body
/// extends from the line after the heading up to — but not including — the next
/// same-level `## ` heading. Subheadings (`###`, `####`, ...) do NOT end the
/// section; only a sibling `## ` heading does.
///
/// Returns `None` when no matching heading is found. The returned `Range` spans
/// the body lines (exclusive of the heading line itself), and the `Vec<String>`
/// holds those body lines verbatim.
pub fn find_section(markdown: &str, section_name: &str) -> Option<(Range<usize>, Vec<String>)> {
    let lines = markdown.lines().collect::<Vec<_>>();
    let name_lower = section_name.to_ascii_lowercase();
    let exact = format!("## {}", section_name);

    let heading_index = lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.eq_ignore_ascii_case(&exact)
            || (trimmed.starts_with("##") && trimmed.to_ascii_lowercase().contains(&name_lower))
    })?;

    let body_start = heading_index + 1;
    let mut body_end = lines.len();
    for (idx, line) in lines.iter().enumerate().skip(body_start) {
        if line.trim_start().starts_with("## ") {
            body_end = idx;
            break;
        }
    }

    let body = lines[body_start..body_end]
        .iter()
        .map(|s| s.to_string())
        .collect();
    Some((body_start..body_end, body))
}

/// Convert a path to a string with forward slashes for cross-platform consistency.
pub fn normalize_path_display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Serialize a string for safe inclusion in a YAML value block.
/// Uses serde_yaml to handle escaping and special characters correctly.
pub fn yaml_string_serialize(value: &str) -> String {
    match serde_yaml::to_string(value) {
        Ok(s) => s.trim().to_string(),
        Err(_) => format!("\"{}\"", value.replace('"', "\\\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frontmatter_field() {
        let md = "---\ntitle: \"Soup\"\ncount: 5\n---";
        assert_eq!(frontmatter_field(md, "title"), Some("Soup".to_string()));
        assert_eq!(frontmatter_field(md, "count"), Some("5".to_string()));
    }

    #[test]
    fn find_section_returns_body_lines_and_range() {
        let md = "# T\n\n## Ingredients\n- a\n- b\n\n## Method\n1. cook\n";
        let (range, body) = find_section(md, "Ingredients").expect("section");
        assert_eq!(range, 3..6);
        assert_eq!(body, vec!["- a", "- b", ""]);
    }

    #[test]
    fn find_section_returns_none_when_missing() {
        assert!(find_section("# x", "Ingredients").is_none());
    }

    #[test]
    fn find_section_stops_at_same_level_heading_only() {
        let md = [
            "# T",
            "## Ingredients",
            "- a",
            "### For the sauce",
            "- b",
            "## Notes",
            "- c",
        ]
        .join("\n");
        let (range, body) = find_section(&md, "Ingredients").expect("section");
        // Subheading (###) stays inside; only sibling (##) ends the section.
        assert_eq!(range, 2..5);
        assert_eq!(body, vec!["- a", "### For the sauce", "- b"]);
    }

    #[test]
    fn find_section_is_case_insensitive() {
        let md = "## ingredients\n- a\n## Method\n1. x";
        assert!(find_section(md, "Ingredients").is_some());
        assert!(find_section(md, "INGREDIENTS").is_some());
    }

    #[test]
    fn find_section_body_extends_to_end_when_no_next_heading() {
        let md = "## Method\n1. cook\n2. serve";
        let (range, body) = find_section(md, "Method").expect("section");
        assert_eq!(range, 1..3);
        assert_eq!(body, vec!["1. cook", "2. serve"]);
    }

    #[test]
    fn test_normalize_path_display() {
        let p = Path::new("a\\b/c");
        assert_eq!(normalize_path_display(p), "a/b/c");
    }

    #[test]
    fn test_yaml_string_serialize() {
        assert_eq!(yaml_string_serialize("plain"), "plain");
        assert_eq!(yaml_string_serialize("with \"quotes\""), "with \"quotes\"");
        assert_eq!(yaml_string_serialize("with: colon"), "'with: colon'");
        assert_eq!(
            yaml_string_serialize("with\nnewline"),
            "|-\n  with\n  newline"
        );
    }

    #[test]
    fn write_atomic_preserves_original_when_temporary_target_is_invalid() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("note.md");
        let original = b"original contents\n";
        fs::write(&path, original).expect("write original");
        fs::create_dir(path.with_file_name("note.md.tmp"))
            .expect("create invalid temporary target");

        assert!(write_atomic(&path, b"replacement contents\n").is_err());
        assert_eq!(fs::read(&path).expect("read original"), original);
    }
}
