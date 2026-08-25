//! Pure cooking-domain models and deterministic ingredient semantics.
//!
//! The pre-migration contract deliberately has two different shopping
//! strategies. This module keeps those choices explicit instead of silently
//! making the Rust and TypeScript surfaces agree.

use crate::{
    find_section, parse_pipe_ingredient_line, CookingConfig, Error, PipeIngredient, Result,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

pub const SIDECAR_SCHEMA_VERSION: &str = "1.0.0";

/// Canonical validated recipe body shared by import providers and artifact
/// renderers. Providers may extract these fields, but only core decides
/// whether the body is a valid recipe document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedRecipeBody {
    pub title: String,
    pub ingredients: Vec<PipeIngredient>,
    pub method: Vec<String>,
}

/// Metadata and content needed to render the canonical markdown and machine
/// sidecar artifacts. All timestamps and paths are supplied by the adapter so
/// rendering remains deterministic and testable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRenderInput {
    pub source_url: String,
    pub added: String,
    pub body: ValidatedRecipeBody,
    pub cover: Option<String>,
    pub recipe_id: String,
    pub markdown_path: String,
    pub generated_at: String,
    pub source_job_type: String,
    #[serde(default)]
    pub source_job_id: Option<String>,
    #[serde(default)]
    pub source_job_created_at: Option<String>,
    #[serde(default)]
    pub source_job_source: Option<String>,
}

/// Render both canonical recipe artifacts. JSON serialization is stable for a
/// given input and preserves the existing sidecar schema.
pub fn render_recipe_artifacts(input: &RecipeRenderInput) -> Result<RenderedRecipeArtifacts> {
    let markdown = render_recipe_markdown(
        &input.source_url,
        &input.added,
        &input.body,
        input.cover.as_deref(),
    );
    let sidecar = render_machine_sidecar(input)?;
    Ok(RenderedRecipeArtifacts { markdown, sidecar })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderedRecipeArtifacts {
    pub markdown: String,
    pub sidecar: String,
}

/// Capture-mode input for native/remote adapters. Extraction providers retain
/// their raw ingredient text; core owns the deterministic artifact shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCaptureRenderInput {
    pub title: String,
    pub source: String,
    pub added: String,
    pub cover: Option<String>,
    pub ingredients: Vec<MachineIngredient>,
    pub method: Vec<String>,
    pub prep_time: String,
    pub cook_time: String,
    pub servings: String,
    pub recipe_id: String,
    pub markdown_path: String,
    pub generated_at: String,
    pub source_job_type: String,
    #[serde(default)]
    pub source_job_id: Option<String>,
    #[serde(default)]
    pub source_job_created_at: Option<String>,
    #[serde(default)]
    pub source_job_source: Option<String>,
}

pub fn render_recipe_capture_artifacts(
    input: &RecipeCaptureRenderInput,
) -> Result<RenderedRecipeArtifacts> {
    reject_url_cover(input.cover.as_deref())?;
    let mut out = vec![
        "---".to_string(),
        format!("title: {}", crate::yaml_string_serialize(&input.title)),
        "type: recipe".to_string(),
        format!("source: {}", crate::yaml_string_serialize(&input.source)),
        format!("added: {}", input.added),
        format!("cover: {}", input.cover.as_deref().unwrap_or_default()),
        "cooked: false".to_string(),
        "marked: false".to_string(),
        "scheduled:".to_string(),
        "tags:".to_string(),
        "---".to_string(),
        String::new(),
        format!("# {}", input.title),
        String::new(),
    ];
    if let Some(path) = input.cover.as_deref() {
        out.push(format!("![Recipe Image]({path})"));
        out.push(String::new());
    }
    out.push("## Ingredients".to_string());
    if input.ingredients.is_empty() {
        out.push("-".to_string());
    } else {
        out.extend(
            input
                .ingredients
                .iter()
                .map(|ingredient| format!("- {}", ingredient.text)),
        );
    }
    out.push(String::new());
    out.push("## Method".to_string());
    if input.method.is_empty() {
        out.push("1.".to_string());
    } else {
        out.extend(
            input
                .method
                .iter()
                .enumerate()
                .map(|(index, step)| format!("{}. {}", index + 1, step)),
        );
    }
    out.extend([String::new(), "## Cook Log".to_string()]);

    let sidecar = MachineSidecar {
        schema_version: SIDECAR_SCHEMA_VERSION.to_string(),
        recipe_id: input.recipe_id.clone(),
        markdown_path: input.markdown_path.clone(),
        generated_at: input.generated_at.clone(),
        sync: MachineSync {
            renderer: "RecipeWriter".to_string(),
            source_job: Some(MachineSourceJob {
                job_type: input.source_job_type.clone(),
                source: input
                    .source_job_source
                    .clone()
                    .or_else(|| (!input.source.is_empty()).then(|| input.source.clone())),
                id: input.source_job_id.clone(),
                created_at: input.source_job_created_at.clone(),
            }),
        },
        recipe: MachineRecipe {
            title: input.title.clone(),
            source: Some(input.source.clone()),
            cover: input.cover.clone(),
            added: input.added.clone(),
            ingredients: input.ingredients.clone(),
            method: input.method.clone(),
            prep_time: input.prep_time.clone(),
            cook_time: input.cook_time.clone(),
            servings: input.servings.clone(),
        },
    };
    let sidecar = serde_json::to_string_pretty(&sidecar)
        .map(|value| format!("{value}\n"))
        .map_err(|error| Error::parse(format!("serialize sidecar: {error}")))?;
    Ok(RenderedRecipeArtifacts {
        markdown: out.join("\n"),
        sidecar,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CookingRecipe {
    pub path: String,
    pub title: String,
    pub ingredients: Vec<PipeIngredient>,
    #[serde(default)]
    pub method: Vec<String>,
}

/// Typed raw recipe input shared by the native Tauri and remote-host adapters.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookingRecipeInput {
    pub path: String,
    pub title: String,
    pub markdown: String,
    pub machine_sidecar_json: Option<String>,
}

/// Parse typed raw recipe inputs and aggregate their desired shopping items.
/// The adapter reads only the fixed configuration directory; recipe content is
/// supplied in memory by the caller.
pub fn build_desired_items(
    config_dir: &Path,
    inputs: Vec<CookingRecipeInput>,
) -> Result<Vec<DesiredItem>> {
    let cooking = crate::load_cooking_config(config_dir)?;
    let recipes = inputs
        .into_iter()
        .map(parse_cooking_recipe_input)
        .collect::<Result<Vec<_>>>()?;
    aggregate_rust(&cooking, &recipes)
}

fn parse_cooking_recipe_input(input: CookingRecipeInput) -> Result<CookingRecipe> {
    let path = input.path.trim().to_string();
    let title = input.title.trim().to_string();
    if path.is_empty() {
        return Err(Error::validation("Recipe path missing"));
    }
    if title.is_empty() {
        return Err(Error::validation(format!(
            "Recipe title missing for {path}"
        )));
    }

    if let Some(sidecar_json) = input
        .machine_sidecar_json
        .filter(|value| !value.trim().is_empty())
    {
        let lines = parse_machine_recipe_ingredients(&sidecar_json).map_err(|error| {
            Error::validation(format!("Invalid machine sidecar for {path}: {error}"))
        })?;
        if lines.is_empty() {
            return Err(Error::validation(format!(
                "Machine sidecar contains no ingredients for {path}"
            )));
        }
        return CookingRecipe::from_ingredient_lines(path, title, &lines).map_err(|error| {
            Error::validation(format!(
                "Invalid machine ingredients for {}: {error}",
                input.path
            ))
        });
    }

    let parsed = parse_recipe_markdown(&input.markdown, &path).map_err(|error| {
        Error::validation(format!("Invalid recipe markdown for {path}: {error}"))
    })?;
    Ok(CookingRecipe {
        path,
        title,
        ingredients: parsed.ingredients,
        method: parsed.method,
    })
}

/// Validate provider-extracted markdown against the canonical recipe contract.
/// This is deliberately deterministic: providers supply text, while core
/// owns structure, pipe parsing, labels, and quality gates.
pub fn validate_recipe_markdown(raw: &str, cooking: &CookingConfig) -> Result<ValidatedRecipeBody> {
    let cleaned = strip_markdown_fences(raw);
    let title = cleaned
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('#') && !trimmed.starts_with("##") {
                let value = trimmed.trim_start_matches('#').trim();
                (!value.is_empty()).then(|| value.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| Error::validation("missing '# title' line in LLM output"))?;

    let (ingredients_range, ingredients_body) = find_section(&cleaned, "Ingredients")
        .ok_or_else(|| Error::validation("missing '## Ingredients' section"))?;
    let (method_range, method_body) = find_section(&cleaned, "Method")
        .ok_or_else(|| Error::validation("missing '## Method' section"))?;
    if method_range.start <= ingredients_range.start {
        return Err(Error::validation(
            "'## Method' must appear after '## Ingredients'",
        ));
    }

    let mut ingredients = Vec::new();
    for line in &ingredients_body {
        if line.trim().is_empty() || !line.trim_start().starts_with("- ") {
            continue;
        }
        let parsed = parse_pipe_ingredient_line(line)?;
        if !cooking.labels.iter().any(|value| value == &parsed.label) {
            return Err(Error::validation(format!(
                "label '{}' is not in allowed label set",
                parsed.label
            )));
        }
        ingredients.push(parsed);
    }

    let method = method_body
        .iter()
        .filter_map(|line| trim_numbered_prefix(line.trim()).map(str::to_string))
        .collect::<Vec<_>>();

    if ingredients.len() < 2 {
        return Err(Error::validation(
            "quality gate failed: fewer than 2 ingredients",
        ));
    }
    if method.is_empty() {
        return Err(Error::validation(
            "quality gate failed: fewer than 1 method step",
        ));
    }

    Ok(ValidatedRecipeBody {
        title,
        ingredients,
        method,
    })
}

pub fn render_recipe_markdown(
    source_url: &str,
    added: &str,
    body: &ValidatedRecipeBody,
    cover: Option<&str>,
) -> String {
    reject_url_cover(cover).expect("cover must be a vault-relative path, not a URL or data URI");
    let mut out = vec![
        "---".to_string(),
        format!("title: {}", crate::yaml_string_serialize(&body.title)),
        "type: recipe".to_string(),
        format!("source: {}", crate::yaml_string_serialize(source_url)),
        format!("added: {}", added),
    ];
    if let Some(path) = cover {
        out.push(format!("cover: {}", crate::yaml_string_serialize(path)));
    }
    out.extend([
        "cooked: false".to_string(),
        "marked: false".to_string(),
        "scheduled:".to_string(),
        "tags:".to_string(),
        "---".to_string(),
        String::new(),
        format!("# {}", body.title),
        String::new(),
    ]);
    if let Some(path) = cover {
        out.push(format!("![Recipe Image]({})", path));
        out.push(String::new());
    }
    out.push("## Ingredients".to_string());
    out.extend(body.ingredients.iter().map(|ingredient| {
        format!(
            "- {} | {} | {}",
            ingredient.quantity, ingredient.ingredient, ingredient.label
        )
    }));
    out.push(String::new());
    out.push("## Method".to_string());
    out.extend(
        body.method
            .iter()
            .enumerate()
            .map(|(index, step)| format!("{}. {}", index + 1, step)),
    );
    out.push(String::new());
    out.join("\n")
}

pub fn render_machine_sidecar(input: &RecipeRenderInput) -> Result<String> {
    let ingredients = input
        .body
        .ingredients
        .iter()
        .map(|ingredient| MachineIngredient {
            text: format!(
                "{} | {} | {}",
                ingredient.quantity, ingredient.ingredient, ingredient.label
            ),
            normalized_text: Some(ingredient.ingredient.clone()),
            resolved_ingredient_id: None,
            resolved_display_name: Some(ingredient.ingredient.clone()),
            resolution_status: "resolved".to_string(),
            confidence: Some(1.0),
            review_required: false,
            resolution_reason: None,
        })
        .collect();
    let payload = MachineSidecar {
        schema_version: SIDECAR_SCHEMA_VERSION.to_string(),
        recipe_id: input.recipe_id.clone(),
        markdown_path: input.markdown_path.clone(),
        generated_at: input.generated_at.clone(),
        sync: MachineSync {
            renderer: "RecipeWriter".to_string(),
            source_job: Some(MachineSourceJob {
                job_type: input.source_job_type.clone(),
                source: input
                    .source_job_source
                    .clone()
                    .or_else(|| (!input.source_url.is_empty()).then(|| input.source_url.clone())),
                id: input.source_job_id.clone(),
                created_at: input.source_job_created_at.clone(),
            }),
        },
        recipe: MachineRecipe {
            title: input.body.title.clone(),
            source: Some(input.source_url.clone()),
            cover: input.cover.clone(),
            added: input.added.clone(),
            ingredients,
            method: input.body.method.clone(),
            prep_time: String::new(),
            cook_time: String::new(),
            servings: String::new(),
        },
    };
    serde_json::to_string_pretty(&payload)
        .map(|value| format!("{value}\n"))
        .map_err(|error| Error::parse(format!("serialize sidecar: {error}")))
}

/// Trust boundary for both frontmatter serializers: a recipe cover is either
/// absent or a vault-relative path. Neither serializer may write a URL or an
/// embedded `data:` URI verbatim into `cover:` — that would leak a remote
/// reference (or an inline blob) into a document meant to hold a local
/// image path.
fn reject_url_cover(cover: Option<&str>) -> Result<()> {
    match cover {
        Some(value) if has_url_scheme(value) => Err(Error::validation(format!(
            "cover must be a vault-relative path, not a URL or data URI: {value}"
        ))),
        _ => Ok(()),
    }
}

/// Mirrors the vault lint's `URL_SCHEME_RE` (`^[a-zA-Z][a-zA-Z0-9+.-]*://`),
/// plus `data:` URIs, which have no `://` and would otherwise slip through.
fn has_url_scheme(value: &str) -> bool {
    if value.starts_with("data:") {
        return true;
    }
    let Some(scheme_end) = value.find("://") else {
        return false;
    };
    let mut chars = value[..scheme_end].chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
}

fn strip_markdown_fences(raw: &str) -> String {
    let trimmed = raw.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let lines = trimmed.lines().collect::<Vec<_>>();
    if lines.len() < 3 {
        return trimmed.to_string();
    }
    lines[1..lines.len() - 1].join("\n")
}

fn trim_numbered_prefix(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == 0 || index >= bytes.len() || bytes[index] != b'.' {
        return None;
    }
    let rest = value[index + 1..].trim();
    (!rest.is_empty()).then_some(rest)
}

impl CookingRecipe {
    pub fn from_ingredient_lines(
        path: impl Into<String>,
        title: impl Into<String>,
        lines: &[impl AsRef<str>],
    ) -> Result<Self> {
        Ok(Self {
            path: path.into(),
            title: title.into(),
            ingredients: lines
                .iter()
                .map(|line| parse_pipe_ingredient_line(line.as_ref()))
                .collect::<Result<Vec<_>>>()?,
            method: Vec::new(),
        })
    }
}

/// Parse the canonical markdown shape without reading or writing files.
pub fn parse_recipe_markdown(markdown: &str, path: impl Into<String>) -> Result<CookingRecipe> {
    let title = markdown
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('#') && !trimmed.starts_with("##") {
                let value = trimmed.trim_start_matches('#').trim();
                (!value.is_empty()).then(|| value.to_string())
            } else {
                None
            }
        })
        .or_else(|| frontmatter_field(markdown, "title"))
        .ok_or_else(|| Error::validation("missing recipe title"))?;

    let (_, body) = find_section(markdown, "Ingredients")
        .ok_or_else(|| Error::parse("missing ## Ingredients section"))?;
    let ingredients = body
        .iter()
        .filter(|line| line.trim_start().starts_with("- "))
        .map(|line| parse_pipe_ingredient_line(line))
        .collect::<Result<Vec<_>>>()?;
    if ingredients.is_empty() {
        return Err(Error::parse("no ingredient bullet lines found"));
    }

    let (_, method_body) = find_section(markdown, "Method")
        .ok_or_else(|| Error::parse("missing ## Method section"))?;
    let method = method_body
        .iter()
        .filter_map(|line| trim_numbered_prefix(line.trim()).map(str::to_string))
        .collect();

    Ok(CookingRecipe {
        path: path.into(),
        title,
        ingredients,
        method,
    })
}

fn frontmatter_field(markdown: &str, key: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix(&format!("{key}:")) {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredItem {
    pub content: String,
    pub labels: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShoppingItem {
    pub content: String,
    pub labels: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricUnit {
    Gram,
    Millilitre,
    Count,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTypeScriptIngredient {
    pub display_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<MetricUnit>,
    pub count_unit: Option<String>,
}

/// The standalone app's parser: metric conversion, count units, preparation
/// stripping, lexical aliases, and water filtering remain distinct from the
/// Rust pipe parser.
pub fn parse_typescript_ingredient_line(line: &str) -> Option<ParsedTypeScriptIngredient> {
    let cleaned = normalize_spaces(line.trim().trim_start_matches(['-', '*', '+']).trim());
    if cleaned.is_empty() {
        return None;
    }

    let (quantity_raw, ingredient_raw) = if cleaned.contains('|') {
        let parts = cleaned.split('|').map(str::trim).collect::<Vec<_>>();
        if parts.len() != 3 {
            return None;
        }
        (parts[0].to_string(), parts[1].to_ascii_lowercase())
    } else {
        let tokens = cleaned.split_whitespace().collect::<Vec<_>>();
        let (quantity, consumed) = parse_ts_quantity(&tokens);
        if let Some(quantity) = quantity {
            return parse_typescript_tokens(&tokens, quantity, consumed);
        }
        let name = sanitize_typescript_name(&cleaned);
        return (!name.is_empty() && !is_water_name(&name)).then_some(ParsedTypeScriptIngredient {
            display_name: name,
            quantity: None,
            unit: None,
            count_unit: None,
        });
    };

    let tokens = quantity_raw.split_whitespace().collect::<Vec<_>>();
    let (quantity, consumed) = parse_ts_quantity(&tokens);
    let quantity = quantity?;
    let name = sanitize_typescript_name(&ingredient_raw);
    if name.is_empty() || is_water_name(&name) {
        return None;
    }
    let (unit_token, count_unit) = parse_ts_unit(&tokens, consumed);
    let (value, unit) = convert_to_metric(quantity, unit_token.as_deref());
    Some(ParsedTypeScriptIngredient {
        display_name: name,
        quantity: Some(value),
        unit: Some(if unit_token.is_some() {
            unit
        } else {
            MetricUnit::Count
        }),
        count_unit,
    })
}

fn parse_typescript_tokens(
    tokens: &[&str],
    quantity: f64,
    consumed: usize,
) -> Option<ParsedTypeScriptIngredient> {
    let (unit_token, count_unit) = parse_ts_unit(tokens, consumed);
    let mut name_start = consumed;
    if unit_token.is_some() || count_unit.is_some() {
        name_start += 1;
    }
    if tokens
        .get(name_start)
        .is_some_and(|token| token.eq_ignore_ascii_case("of"))
    {
        name_start += 1;
    }
    let name = sanitize_typescript_name(&tokens.get(name_start..)?.join(" "));
    if name.is_empty() || is_water_name(&name) {
        return None;
    }
    let (value, unit) = convert_to_metric(quantity, unit_token.as_deref());
    Some(ParsedTypeScriptIngredient {
        display_name: name,
        quantity: Some(value),
        unit: Some(if unit_token.is_some() {
            unit
        } else {
            MetricUnit::Count
        }),
        count_unit,
    })
}

fn parse_ts_quantity(tokens: &[&str]) -> (Option<f64>, usize) {
    let Some(first) = tokens.first() else {
        return (None, 0);
    };
    if let Some(split) = first.find(|ch: char| ch.is_ascii_alphabetic()) {
        if let Some(value) = parse_decimal_or_fraction(&first[..split]) {
            return (Some(value), 1);
        }
    }
    let Some(value) = parse_decimal_or_fraction(first) else {
        return (None, 0);
    };
    if let Some(extra) = tokens.get(1).and_then(|token| parse_fraction(token)) {
        if value.fract().abs() < f64::EPSILON {
            return (Some(value + extra), 2);
        }
    }
    (Some(value), 1)
}

fn parse_decimal_or_fraction(value: &str) -> Option<f64> {
    if value.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        value.parse().ok()
    } else {
        parse_fraction(value)
    }
}

fn parse_ts_unit(tokens: &[&str], consumed: usize) -> (Option<String>, Option<String>) {
    let attached = tokens.first().and_then(|token| {
        token
            .find(|ch: char| ch.is_ascii_alphabetic())
            .map(|index| &token[index..])
    });
    let token = attached.or_else(|| tokens.get(consumed).copied());
    let Some(token) = token else {
        return (None, None);
    };
    let token = token.to_ascii_lowercase().replace([',', '.'], "");
    if let Some(unit) = normalize_metric_unit(&token) {
        (Some(unit), None)
    } else {
        (None, normalize_count_unit(&token))
    }
}

fn normalize_metric_unit(token: &str) -> Option<String> {
    Some(
        match token {
            "g" | "gram" | "grams" => "g",
            "kg" | "kilogram" | "kilograms" => "kg",
            "ml" | "milliliter" | "milliliters" | "millilitre" | "millilitres" => "ml",
            "l" | "liter" | "liters" | "litre" | "litres" => "l",
            "tsp" | "teaspoon" | "teaspoons" => "tsp",
            "tbsp" | "tablespoon" | "tablespoons" => "tbsp",
            "cup" | "cups" => "cup",
            "oz" | "ounce" | "ounces" => "oz",
            "lb" | "lbs" | "pound" | "pounds" => "lb",
            _ => return None,
        }
        .to_string(),
    )
}

fn normalize_count_unit(token: &str) -> Option<String> {
    Some(
        match token {
            "clove" | "cloves" => "clove",
            "sprig" | "sprigs" => "sprig",
            "bunch" | "bunches" => "bunch",
            "stalk" | "stalks" => "stalk",
            "stick" | "sticks" => "stick",
            "can" | "cans" => "can",
            "tin" | "tins" => "tin",
            "jar" | "jars" => "jar",
            "pack" | "packs" => "pack",
            "bag" | "bags" => "bag",
            "piece" | "pieces" => "piece",
            "slice" | "slices" => "slice",
            "leaf" | "leaves" => "leaf",
            _ => return None,
        }
        .to_string(),
    )
}

fn convert_to_metric(quantity: f64, unit: Option<&str>) -> (f64, MetricUnit) {
    match unit {
        None => (quantity, MetricUnit::Count),
        Some("kg") => (quantity * 1000.0, MetricUnit::Gram),
        Some("g") => (quantity, MetricUnit::Gram),
        Some("l") => (quantity * 1000.0, MetricUnit::Millilitre),
        Some("ml") => (quantity, MetricUnit::Millilitre),
        Some("tsp") => (quantity * 5.0, MetricUnit::Millilitre),
        Some("tbsp") => (quantity * 15.0, MetricUnit::Millilitre),
        Some("cup") => (quantity * 240.0, MetricUnit::Millilitre),
        Some("oz") => (quantity * 28.3495, MetricUnit::Gram),
        Some("lb") => (quantity * 453.592, MetricUnit::Gram),
        Some(_) => (quantity, MetricUnit::Count),
    }
}

fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn normalize_typescript_name(value: &str) -> String {
    let value = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>();
    let value = normalize_spaces(&value);
    if value.ends_with('s') && !value.ends_with("ss") {
        value[..value.len() - 1].to_string()
    } else {
        value
    }
}

fn sanitize_typescript_name(value: &str) -> String {
    let mut value = value.to_string();
    if let Some(start) = value.find('(') {
        if let Some(end) = value[start..].find(')') {
            value.replace_range(start..=start + end, "");
        }
    }
    if let Some(index) = value.find([',', ';']) {
        value.truncate(index);
    }
    for phrase in [
        "good-quality",
        "good quality",
        "quality",
        "freshly",
        "fresh",
        "finely",
        "roughly",
        "thinly",
        "thickly",
        "chopped",
        "minced",
        "sliced",
        "diced",
        "grated",
        "peeled",
        "crushed",
        "ground",
        "shredded",
        "julienned",
        "halved",
        "quartered",
        "trimmed",
        "rinsed",
        "drained",
        "optional",
        "to taste",
    ] {
        value = value.replace(phrase, " ");
    }
    for (from, to) in [
        ("vegetable broth", "veg stock"),
        ("vegetable stock", "veg stock"),
        ("parmesan cheese", "parmesan"),
        ("feta cheese", "feta"),
    ] {
        value = value.replace(from, to);
    }
    let value = value.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    normalize_spaces(&value.to_ascii_lowercase())
}

fn is_water_name(value: &str) -> bool {
    let value = normalize_typescript_name(value);
    if value == "water" {
        return true;
    }
    if !value.contains("water") {
        return false;
    }
    value
        .split_whitespace()
        .filter(|word| *word != "water")
        .all(|word| {
            [
                "cold",
                "warm",
                "hot",
                "boiling",
                "ice",
                "iced",
                "filtered",
                "tap",
                "still",
                "sparkling",
            ]
            .contains(&word)
        })
}

pub fn label_for_typescript_ingredient(name: &str) -> String {
    let name = normalize_typescript_name(name);
    if name == "butter bean" {
        return "tinned-jarred-dried".to_string();
    }
    let rules: [(&str, &[&str]); 10] = [
        (
            "fruit-and-veg",
            &[
                "onion",
                "garlic",
                "tomato",
                "potato",
                "carrot",
                "pepper",
                "lemon",
                "lime",
                "apple",
                "banana",
                "herb",
                "parsley",
                "basil",
                "coriander",
                "ginger",
                "chilli",
                "chili",
                "shallot",
                "leek",
                "celery",
            ],
        ),
        (
            "dairy",
            &[
                "milk",
                "cheese",
                "yogurt",
                "yoghurt",
                "cream",
                "butter",
                "parmesan",
                "mozzarella",
                "cheddar",
                "feta",
                "egg",
            ],
        ),
        (
            "meat-and-fish",
            &[
                "chicken", "beef", "pork", "lamb", "fish", "salmon", "tuna", "anchovy", "shrimp",
                "prawn", "bacon", "ham",
            ],
        ),
        (
            "bakery",
            &[
                "bread",
                "bun",
                "bagel",
                "tortilla",
                "pita",
                "pastry",
                "roll",
                "croissant",
                "brioche",
            ],
        ),
        (
            "baking",
            &[
                "flour",
                "sugar",
                "baking powder",
                "baking soda",
                "yeast",
                "cocoa",
                "vanilla",
            ],
        ),
        ("drinks", &["wine", "beer", "cider", "vodka", "gin", "rum"]),
        ("frozen", &["frozen", "ice cream"]),
        (
            "household",
            &["paper", "soap", "detergent", "bleach", "cleaner", "sponge"],
        ),
        (
            "toiletries",
            &["shampoo", "toothpaste", "deodorant", "razor"],
        ),
        (
            "tinned-jarred-dried",
            &[
                "beans",
                "lentils",
                "chickpeas",
                "rice",
                "pasta",
                "oil",
                "vinegar",
                "salt",
                "pepper",
                "spice",
                "stock",
                "tomato paste",
                "tinned",
                "canned",
                "can",
            ],
        ),
    ];
    rules
        .iter()
        .find(|(_, keywords)| keywords.iter().any(|keyword| name.contains(keyword)))
        .map(|(label, _)| (*label).to_string())
        .unwrap_or_else(|| "tinned-jarred-dried".to_string())
}

/// Rust CLI quantity parsing: values remain in their literal unit buckets.
pub fn parse_rust_quantity(input: &str) -> Option<(f64, String)> {
    let mut parts = input.split_whitespace().collect::<Vec<_>>();
    let first = parts.first().copied()?;
    parts.remove(0);
    let (mut value, first_unit) = parse_amount_with_optional_unit(first)?;
    if first_unit.is_empty() {
        if let Some(next) = parts.first().copied() {
            if let Some(fraction) = parse_fraction(next) {
                value += fraction;
                parts.remove(0);
            }
        }
    }
    let mut units = Vec::new();
    if !first_unit.is_empty() {
        units.push(first_unit);
    }
    units.extend(parts.into_iter().map(str::to_string));
    Some((value, units.join(" ").trim().to_ascii_lowercase()))
}

fn parse_amount_with_optional_unit(token: &str) -> Option<(f64, String)> {
    if let Some(value) = parse_number_like(token) {
        return Some((value, String::new()));
    }
    let split = token
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_digit() || *ch == '.' || *ch == '/'))
        .map(|(index, _)| index)?;
    let number = token[..split].trim();
    let unit = token[split..].trim();
    if number.is_empty() || unit.is_empty() {
        return None;
    }
    Some((parse_number_like(number)?, unit.to_string()))
}

fn parse_number_like(value: &str) -> Option<f64> {
    parse_fraction(value).or_else(|| value.parse::<f64>().ok())
}

fn parse_fraction(value: &str) -> Option<f64> {
    let (num, den) = value.split_once('/')?;
    let numerator = num.trim().parse::<f64>().ok()?;
    let denominator = den.trim().parse::<f64>().ok()?;
    (denominator.abs() >= f64::EPSILON).then_some(numerator / denominator)
}

pub fn aggregate_rust(
    cooking: &CookingConfig,
    recipes: &[CookingRecipe],
) -> Result<Vec<DesiredItem>> {
    #[derive(Default)]
    struct Entry {
        labels: BTreeSet<String>,
        sources: BTreeSet<String>,
        quantities: BTreeMap<String, f64>,
        raw: BTreeSet<String>,
    }

    let ignore = cooking
        .ignore
        .iter()
        .map(|value| normalize_key(value))
        .collect::<HashSet<_>>();
    let merge = cooking
        .merge
        .iter()
        .map(|(from, to)| (normalize_key(from), normalize_key(to)))
        .collect::<BTreeMap<_, _>>();
    let mut grouped = BTreeMap::<String, Entry>::new();

    for recipe in recipes {
        for ingredient in &recipe.ingredients {
            let original = normalize_key(&ingredient.ingredient);
            if ignore.contains(&original) {
                continue;
            }
            let key = merge.get(&original).cloned().unwrap_or(original);
            if ignore.contains(&key) {
                continue;
            }
            let entry = grouped.entry(key).or_default();
            entry.labels.insert(normalize_key(&ingredient.label));
            entry.sources.insert(recipe.title.clone());
            if ingredient.quantity.trim().is_empty() {
                continue;
            }
            if let Some((value, unit)) = parse_rust_quantity(ingredient.quantity.trim()) {
                *entry.quantities.entry(unit).or_insert(0.0) += value;
            } else {
                entry.raw.insert(ingredient.quantity.trim().to_string());
            }
        }
    }

    Ok(grouped
        .into_iter()
        .map(|(ingredient, entry)| {
            let label = choose_configured_label(cooking, &entry.labels);
            let mut quantities = entry
                .quantities
                .into_iter()
                .map(|(unit, value)| {
                    if unit.is_empty() {
                        format_rust_number(value)
                    } else {
                        format!("{} {}", format_rust_number(value), unit)
                    }
                })
                .collect::<Vec<_>>();
            quantities.extend(entry.raw);
            let sources = entry.sources.into_iter().collect::<Vec<_>>();
            let content = if quantities.is_empty() {
                ingredient
            } else {
                format!("{ingredient} - {}", quantities.join(", "))
            };
            DesiredItem {
                content,
                labels: vec![label],
                sources,
            }
        })
        .collect())
}

fn normalize_key(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_rust_number(value: f64) -> String {
    if (value - value.round()).abs() < 1e-9 {
        format!("{}", value.round() as i64)
    } else {
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

pub fn choose_configured_label(cooking: &CookingConfig, seen: &BTreeSet<String>) -> String {
    cooking
        .labels
        .iter()
        .find(|label| seen.contains(&normalize_key(label)))
        .map(|label| label.trim().to_string())
        .unwrap_or_else(|| cooking.default_label.trim().to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineIngredient {
    pub text: String,
    pub normalized_text: Option<String>,
    pub resolved_ingredient_id: Option<String>,
    pub resolved_display_name: Option<String>,
    pub resolution_status: String,
    pub confidence: Option<f64>,
    pub review_required: bool,
    pub resolution_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineSourceJob {
    #[serde(rename = "type")]
    pub job_type: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineSync {
    pub renderer: String,
    pub source_job: Option<MachineSourceJob>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineRecipe {
    pub title: String,
    pub source: Option<String>,
    pub cover: Option<String>,
    pub added: String,
    pub ingredients: Vec<MachineIngredient>,
    pub method: Vec<String>,
    pub prep_time: String,
    pub cook_time: String,
    pub servings: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineSidecar {
    pub schema_version: String,
    pub recipe_id: String,
    pub markdown_path: String,
    pub generated_at: String,
    pub sync: MachineSync,
    pub recipe: MachineRecipe,
}

pub fn parse_machine_recipe_ingredients(raw_json: &str) -> Result<Vec<String>> {
    let sidecar: MachineSidecar = serde_json::from_str(raw_json)?;
    Ok(sidecar
        .recipe
        .ingredients
        .into_iter()
        .filter_map(|ingredient| {
            if !ingredient.text.trim().is_empty() {
                Some(ingredient.text)
            } else {
                ingredient
                    .resolved_display_name
                    .filter(|value| !value.trim().is_empty())
            }
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngredientResolutionPayload {
    pub raw: String,
    pub normalized: Option<String>,
    pub resolved_ingredient_id: Option<String>,
    pub resolved_display_name: Option<String>,
    pub resolution_status: String,
    pub confidence: Option<f64>,
    pub resolution_path: Option<String>,
    pub resolution_reason: Option<String>,
    pub review_required: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../fixtures/cooking-domain/golden.json")).unwrap()
    }

    fn recipes() -> Vec<CookingRecipe> {
        golden()["recipes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|recipe| {
                let lines = recipe["ingredients"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().to_string())
                    .collect::<Vec<_>>();
                CookingRecipe::from_ingredient_lines(
                    recipe["path"].as_str().unwrap(),
                    recipe["title"].as_str().unwrap(),
                    &lines,
                )
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn markdown_fixture_is_parsed_without_io() {
        let recipe = parse_recipe_markdown(
            include_str!("../../fixtures/cooking-domain/recipe.md"),
            "recipe.md",
        )
        .unwrap();
        assert_eq!(recipe.title, "Contract Soup");
        assert_eq!(recipe.ingredients.len(), 3);
        assert_eq!(recipe.method, vec!["Mix", "Serve"]);
    }

    #[test]
    fn canonical_validation_and_rendering_match_recipe_fixture() {
        let cfg = CookingConfig::default();
        let body = validate_recipe_markdown(
            "```markdown\n# Contract Soup\n\n## Ingredients\n- 1kg | plain flour | bakery\n- 1 tbsp | extra virgin olive oil | oils & condiments\n\n## Method\n1. Mix\n```",
            &cfg,
        )
        .expect("provider markdown should validate");
        let rendered = render_recipe_markdown(
            "https://example.test/contract-soup",
            "2026-07-11",
            &body,
            None,
        );
        let fixture = include_str!("../../fixtures/cooking-domain/recipe.md");
        assert!(rendered.contains("title: Contract Soup"));
        assert!(rendered.contains("- 1kg | plain flour | bakery"));
        assert!(rendered.ends_with('\n'));
        assert!(fixture.contains("## Method"));
    }

    #[test]
    fn canonical_sidecar_is_stable_for_explicit_metadata() {
        let body = ValidatedRecipeBody {
            title: "Contract Soup".to_string(),
            ingredients: vec![parse_pipe_ingredient_line("- 1kg | plain flour | bakery").unwrap()],
            method: vec!["Mix".to_string(), "Serve".to_string()],
        };
        let input = RecipeRenderInput {
            source_url: "https://example.test/contract-soup".to_string(),
            added: "2026-07-11".to_string(),
            body,
            cover: None,
            recipe_id: "contract-soup".to_string(),
            markdown_path: "contract-soup.md".to_string(),
            generated_at: "2026-07-11T00:00:00Z".to_string(),
            source_job_type: "url".to_string(),
            source_job_id: None,
            source_job_created_at: None,
            source_job_source: Some("https://example.test/contract-soup".to_string()),
        };
        let sidecar = render_machine_sidecar(&input).expect("sidecar");
        let expected: Value =
            serde_json::from_str(include_str!("../../fixtures/cooking-domain/sidecar.json"))
                .unwrap();
        let actual: Value = serde_json::from_str(&sidecar).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn rust_aggregation_matches_golden() {
        let fixture = golden();
        let cfg = CookingConfig {
            default_label: fixture["config"]["defaultLabel"]
                .as_str()
                .unwrap()
                .to_string(),
            labels: fixture["config"]["labels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect(),
            ignore: fixture["config"]["ignore"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect(),
            merge: fixture["config"]["merge"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_string()))
                .collect(),
            ..CookingConfig::default()
        };
        let actual = aggregate_rust(&cfg, &recipes()).unwrap();
        let expected: Vec<DesiredItem> =
            serde_json::from_value(fixture["rust"]["shoppingItems"].clone()).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn rust_aggregation_retains_deduplicated_structured_recipe_sources() {
        let cfg = CookingConfig {
            default_label: "produce".to_string(),
            labels: vec!["produce".to_string()],
            ..CookingConfig::default()
        };
        let recipes = vec![
            CookingRecipe::from_ingredient_lines(
                "zulu.md",
                "Zulu Recipe",
                &["- 1 | onion | produce", "- 2 | onion | produce"],
            )
            .unwrap(),
            CookingRecipe::from_ingredient_lines(
                "alpha.md",
                "Alpha Recipe",
                &["- 3 | onion | produce"],
            )
            .unwrap(),
        ];

        let actual = aggregate_rust(&cfg, &recipes).unwrap();

        assert_eq!(actual.len(), 1);
        assert_eq!(
            actual[0].sources,
            vec!["Alpha Recipe".to_string(), "Zulu Recipe".to_string()]
        );
        assert_eq!(actual[0].content, "onion - 6");
    }

    #[test]
    fn sidecar_and_tauri_boundary_stay_explicit() {
        assert_eq!(
            parse_machine_recipe_ingredients(include_str!(
                "../../fixtures/cooking-domain/sidecar.json"
            ))
            .unwrap(),
            vec!["1kg | plain flour | bakery"]
        );
        let payload: IngredientResolutionPayload = serde_json::from_str(include_str!(
            "../../fixtures/cooking-domain/host-invoke-resolution.json"
        ))
        .unwrap();
        let value = serde_json::to_value(payload).unwrap();
        assert!(value.get("resolvedIngredientId").is_some());
        assert!(value.get("resolved_ingredient_id").is_none());
    }

    #[test]
    fn rust_quantity_preserves_unit_buckets() {
        assert_eq!(parse_rust_quantity("1 1/2 tsp"), Some((1.5, "tsp".into())));
        assert_eq!(parse_rust_quantity("1kg"), Some((1.0, "kg".into())));
        assert_eq!(parse_rust_quantity("500g"), Some((500.0, "g".into())));
    }

    #[test]
    fn typescript_parser_keeps_metric_and_lexical_differences_explicit() {
        let flour = parse_typescript_ingredient_line("- 1kg | plain flour | bakery").unwrap();
        assert_eq!(flour.display_name, "plain flour");
        assert_eq!(flour.quantity, Some(1000.0));
        assert_eq!(flour.unit, Some(MetricUnit::Gram));
        assert_eq!(
            label_for_typescript_ingredient(&flour.display_name),
            "baking"
        );

        let oil = parse_typescript_ingredient_line(
            "- 1 tbsp | extra virgin olive oil | oils & condiments",
        )
        .unwrap();
        assert_eq!(oil.quantity, Some(15.0));
        assert_eq!(oil.unit, Some(MetricUnit::Millilitre));
        assert_eq!(label_for_typescript_ingredient(&oil.display_name), "drinks");

        let garlic = parse_typescript_ingredient_line("2 cloves garlic").unwrap();
        assert_eq!(garlic.count_unit.as_deref(), Some("clove"));
        assert_eq!(garlic.unit, Some(MetricUnit::Count));
        assert!(parse_typescript_ingredient_line("- 500ml | cold water | other").is_none());
    }

    #[test]
    fn reject_url_cover_rejects_url_schemes_and_data_uris() {
        assert!(reject_url_cover(Some("https://example.test/cover.jpg")).is_err());
        assert!(reject_url_cover(Some("http://example.test/cover.jpg")).is_err());
        assert!(reject_url_cover(Some("data:image/png;base64,AAAA")).is_err());
    }

    #[test]
    fn reject_url_cover_accepts_vault_relative_paths_and_absence() {
        assert!(reject_url_cover(Some("images/foo.webp")).is_ok());
        assert!(reject_url_cover(Some("")).is_ok());
        assert!(reject_url_cover(None).is_ok());
    }

    #[test]
    fn render_recipe_capture_artifacts_rejects_url_cover() {
        let input = RecipeCaptureRenderInput {
            title: "Contract Soup".to_string(),
            source: "https://example.test/contract-soup".to_string(),
            added: "2026-07-11".to_string(),
            cover: Some("https://example.test/cover.jpg".to_string()),
            ingredients: Vec::new(),
            method: Vec::new(),
            prep_time: String::new(),
            cook_time: String::new(),
            servings: String::new(),
            recipe_id: "contract-soup".to_string(),
            markdown_path: "contract-soup.md".to_string(),
            generated_at: "2026-07-11T00:00:00Z".to_string(),
            source_job_type: "url".to_string(),
            source_job_id: None,
            source_job_created_at: None,
            source_job_source: None,
        };
        let error = render_recipe_capture_artifacts(&input)
            .expect_err("URL-scheme cover must be rejected before serialization");
        assert!(error.to_string().contains("cover"));
    }

    #[test]
    fn render_recipe_capture_artifacts_accepts_local_path_cover() {
        let input = RecipeCaptureRenderInput {
            title: "Contract Soup".to_string(),
            source: "https://example.test/contract-soup".to_string(),
            added: "2026-07-11".to_string(),
            cover: Some("images/foo.webp".to_string()),
            ingredients: Vec::new(),
            method: Vec::new(),
            prep_time: String::new(),
            cook_time: String::new(),
            servings: String::new(),
            recipe_id: "contract-soup".to_string(),
            markdown_path: "contract-soup.md".to_string(),
            generated_at: "2026-07-11T00:00:00Z".to_string(),
            source_job_type: "url".to_string(),
            source_job_id: None,
            source_job_created_at: None,
            source_job_source: None,
        };
        let rendered = render_recipe_capture_artifacts(&input).expect("local cover should render");
        assert!(rendered.markdown.contains("cover: images/foo.webp"));
    }

    #[test]
    #[should_panic(expected = "cover must be a vault-relative path")]
    fn render_recipe_markdown_panics_on_url_cover() {
        let body = ValidatedRecipeBody {
            title: "Contract Soup".to_string(),
            ingredients: vec![parse_pipe_ingredient_line("- 1kg | plain flour | bakery").unwrap()],
            method: vec!["Mix".to_string()],
        };
        render_recipe_markdown(
            "https://example.test/contract-soup",
            "2026-07-11",
            &body,
            Some("https://example.test/cover.jpg"),
        );
    }
}
