//! Pipe-delimited ingredient parsing primitives.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipeIngredient {
    pub quantity: String,
    pub ingredient: String,
    pub label: String,
}

pub fn parse_pipe_ingredient_line(line: &str) -> Result<PipeIngredient> {
    let trimmed = line.trim();
    let without_bullet = trimmed.strip_prefix("- ").unwrap_or(trimmed);
    let parts = without_bullet.split('|').map(str::trim).collect::<Vec<_>>();

    if parts.len() != 3 {
        return Err(Error::parse(format!(
            "ingredient line must have exactly 3 pipe-separated segments: {}",
            line
        )));
    }

    let quantity = parts[0].to_string();
    let ingredient = parts[1].trim().to_ascii_lowercase();
    let label = parts[2].trim().to_string();

    if ingredient.len() < 2 {
        return Err(Error::validation(format!(
            "ingredient name must be at least 2 characters: {}",
            line
        )));
    }

    Ok(PipeIngredient {
        quantity,
        ingredient,
        label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn golden_fixture_locks_three_pipe_persistence_shape() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/cooking-domain/golden.json"))
                .expect("golden fixture should be valid JSON");

        let recipes = fixture["recipes"].as_array().expect("recipes array");
        let parsed = recipes
            .iter()
            .flat_map(|recipe| {
                recipe["ingredients"]
                    .as_array()
                    .expect("ingredient array")
                    .iter()
                    .map(|line| {
                        parse_pipe_ingredient_line(line.as_str().expect("ingredient line"))
                            .expect("golden ingredient should parse")
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(parsed.len(), 8);
        assert_eq!(parsed[0].quantity, "1kg");
        assert_eq!(parsed[0].ingredient, "plain flour");
        assert_eq!(parsed[0].label, "bakery");
        assert_eq!(parsed[1].quantity, "1 tbsp");
        assert_eq!(parsed[1].ingredient, "extra virgin olive oil");
        assert_eq!(parsed[6].quantity, "1");
        assert_eq!(parsed[6].ingredient, "onion");
    }

    #[test]
    fn parser_rejects_fourth_pipe_segment() {
        let error = parse_pipe_ingredient_line("- 1 | onions | fruit & veg | extra");
        assert!(error.is_err());
    }
}
