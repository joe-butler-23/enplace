use chrono::Utc;
use mep_core::{
    frontmatter_field, normalize_path_display, render_recipe_artifacts, validate_http_url_syntax,
    validate_recipe_markdown, write_atomic, CookingConfig, RecipeRenderInput,
};
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

pub struct MarkdownImportOptions<'a> {
    pub input: &'a Path,
    pub recipes_dir: &'a Path,
    pub cooking: &'a CookingConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownImportResult {
    ok: bool,
    title: String,
    slug: String,
    source: String,
    markdown_path: String,
    sidecar_path: String,
    ingredient_count: usize,
}

#[derive(Debug, Serialize)]
pub struct MarkdownImportError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'static str>,
}

impl MarkdownImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            field: None,
        }
    }

    fn field(code: &'static str, field: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            field: Some(field),
        }
    }
}

pub fn import_markdown(
    options: &MarkdownImportOptions<'_>,
) -> Result<MarkdownImportResult, MarkdownImportError> {
    let raw = read_input(options.input)?;
    require_closed_frontmatter(&raw)?;

    let frontmatter_title = required_field(&raw, "title")?;
    let recipe_type = required_field(&raw, "type")?;
    if recipe_type != "recipe" {
        return Err(MarkdownImportError::field(
            "invalid_frontmatter",
            "type",
            "frontmatter type must be 'recipe'",
        ));
    }

    let source = required_field(&raw, "source")?;
    validate_http_url_syntax(&source).map_err(|error| {
        MarkdownImportError::field("invalid_source", "source", error.to_string())
    })?;

    let body = validate_recipe_markdown(&raw, options.cooking)
        .map_err(|error| MarkdownImportError::new("invalid_recipe", error.to_string()))?;
    if frontmatter_title != body.title {
        return Err(MarkdownImportError::field(
            "title_mismatch",
            "title",
            "frontmatter title must match the '# title' heading",
        ));
    }

    let cover = frontmatter_field(&raw, "cover").filter(|value| !value.trim().is_empty());
    validate_image_references(&raw, cover.as_deref(), options.recipes_dir)?;

    let (slug, markdown_path) = choose_markdown_path(options.recipes_dir, &body.title, &source)
        .map_err(|error| MarkdownImportError::new("output_path_failed", error.to_string()))?;
    if slug == "recipe" || !is_safe_slug(&slug) {
        return Err(MarkdownImportError::field(
            "unsafe_slug",
            "title",
            "title does not produce a safe, meaningful recipe filename",
        ));
    }

    let added = Utc::now().format("%Y-%m-%d").to_string();
    let generated_at = Utc::now().to_rfc3339();
    let sidecar_path = options
        .recipes_dir
        .join(".machine")
        .join(format!("{slug}.json"));
    let rendered = render_recipe_artifacts(&RecipeRenderInput {
        source_url: source.clone(),
        added,
        body: body.clone(),
        cover: cover.clone(),
        recipe_id: slug.clone(),
        markdown_path: normalize_path_display(
            markdown_path
                .strip_prefix(options.recipes_dir)
                .unwrap_or(&markdown_path),
        ),
        generated_at,
        source_job_type: "agent-import".to_string(),
        source_job_id: None,
        source_job_created_at: None,
        source_job_source: Some(source.clone()),
    })
    .map_err(|error| MarkdownImportError::new("render_failed", error.to_string()))?;

    fs::create_dir_all(options.recipes_dir)
        .and_then(|_| fs::create_dir_all(sidecar_path.parent().expect("sidecar has parent")))
        .map_err(|error| MarkdownImportError::new("write_failed", error.to_string()))?;
    write_atomic(&sidecar_path, rendered.sidecar.as_bytes())
        .and_then(|_| write_atomic(&markdown_path, rendered.markdown.as_bytes()))
        .map_err(|error| MarkdownImportError::new("write_failed", error.to_string()))?;

    Ok(MarkdownImportResult {
        ok: true,
        title: body.title,
        slug,
        source,
        markdown_path: normalize_path_display(&markdown_path),
        sidecar_path: normalize_path_display(&sidecar_path),
        ingredient_count: body.ingredients.len(),
    })
}

fn read_input(path: &Path) -> Result<String, MarkdownImportError> {
    if path == Path::new("-") {
        let mut raw = String::new();
        io::stdin()
            .read_to_string(&mut raw)
            .map_err(|error| MarkdownImportError::new("input_read_failed", error.to_string()))?;
        return Ok(raw);
    }
    fs::read_to_string(path).map_err(|error| {
        MarkdownImportError::new(
            "input_read_failed",
            format!("read {}: {error}", path.display()),
        )
    })
}

fn require_closed_frontmatter(raw: &str) -> Result<(), MarkdownImportError> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") || !lines.any(|line| line.trim() == "---") {
        return Err(MarkdownImportError::new(
            "invalid_frontmatter",
            "recipe must start with a closed YAML frontmatter block",
        ));
    }
    Ok(())
}

fn required_field(raw: &str, field: &'static str) -> Result<String, MarkdownImportError> {
    frontmatter_field(raw, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            MarkdownImportError::field(
                "missing_frontmatter_field",
                field,
                format!("frontmatter field '{field}' is required"),
            )
        })
}

fn validate_image_references(
    raw: &str,
    cover: Option<&str>,
    recipes_dir: &Path,
) -> Result<(), MarkdownImportError> {
    if raw
        .lines()
        .filter_map(markdown_image_target)
        .any(|target| Some(target) != cover)
    {
        return Err(MarkdownImportError::field(
            "invalid_image_reference",
            "cover",
            "markdown image references must match the frontmatter cover",
        ));
    }

    let Some(cover) = cover else {
        return Ok(());
    };
    let relative = Path::new(cover);
    let extension = relative
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if relative.is_absolute()
        || cover.contains("://")
        || cover.starts_with("data:")
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !matches!(
            extension.as_deref(),
            Some("jpg" | "jpeg" | "png" | "webp" | "gif")
        )
    {
        return Err(MarkdownImportError::field(
            "unsafe_image_reference",
            "cover",
            "cover must be a normalized vault-relative image path",
        ));
    }
    let image_path = recipes_dir.join(relative);
    if !image_path.is_file() {
        return Err(MarkdownImportError::field(
            "missing_image",
            "cover",
            format!("cover image does not exist: {}", image_path.display()),
        ));
    }
    let canonical_root = fs::canonicalize(recipes_dir)
        .map_err(|error| MarkdownImportError::new("image_check_failed", error.to_string()))?;
    let canonical_image = fs::canonicalize(&image_path)
        .map_err(|error| MarkdownImportError::new("image_check_failed", error.to_string()))?;
    if !canonical_image.starts_with(canonical_root) {
        return Err(MarkdownImportError::field(
            "unsafe_image_reference",
            "cover",
            "cover image resolves outside the recipes directory",
        ));
    }
    Ok(())
}

fn markdown_image_target(line: &str) -> Option<&str> {
    let start = line.find("![")?;
    let after_alt = line[start + 2..].find("](")? + start + 4;
    let end = line[after_alt..].find(')')? + after_alt;
    Some(line[after_alt..end].trim())
}

fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn choose_markdown_path(
    recipes_dir: &Path,
    title: &str,
    source_url: &str,
) -> mep_core::Result<(String, PathBuf)> {
    let base = slugify(title);
    let mut suffix = 0usize;
    loop {
        let slug = if suffix == 0 {
            base.clone()
        } else {
            format!("{}-{}", base, suffix + 1)
        };
        let path = recipes_dir.join(format!("{slug}.md"));
        if !path.exists() {
            return Ok((slug, path));
        }
        let raw = fs::read_to_string(&path)?;
        if frontmatter_field(&raw, "source").unwrap_or_default().trim() == source_url.trim() {
            return Ok((slug, path));
        }
        suffix += 1;
    }
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in title.to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "recipe".to_string()
    } else {
        trimmed.to_string()
    }
}
