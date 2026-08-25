use crate::write_atomic;
use crate::DesiredItem;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListItem {
    pub id: String,
    pub content: String,
    pub labels: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    pub checked: bool,
    /// Hand-added items survive an apply that rebuilds the week from recipes.
    #[serde(default)]
    pub manual: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListSnapshot {
    pub week_label: String,
    pub items: Vec<ShoppingListItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingList {
    pub schema_version: u32,
    pub revision: u64,
    pub week_label: String,
    pub items: Vec<ShoppingListItem>,
    pub rollback: Option<ShoppingListSnapshot>,
}

impl Default for ShoppingList {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            week_label: String::new(),
            items: Vec::new(),
            rollback: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListPlanSummary {
    pub current_count: usize,
    pub desired_count: usize,
    pub unchanged_count: usize,
    pub create_count: usize,
    pub delete_count: usize,
    /// Hand-added items the apply will keep rather than delete.
    pub manual_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListPlan {
    pub base_revision: u64,
    pub week_label: String,
    pub items: Vec<ShoppingListItem>,
    pub summary: ShoppingListPlanSummary,
}

fn canonical_labels(labels: &[String]) -> Result<Vec<String>, String> {
    let mut canonical = BTreeSet::new();
    for label in labels {
        let label = label.trim().to_lowercase();
        if label.is_empty() {
            return Err("Shopping item labels must not be empty".to_string());
        }
        canonical.insert(label);
    }
    Ok(canonical.into_iter().collect())
}

fn item_id(content: &str, labels: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hasher.update(b"\0");
    for label in labels {
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
    }
    hex::encode(hasher.finalize())[..20].to_string()
}

fn desired_items(items: &[DesiredItem]) -> Result<Vec<ShoppingListItem>, String> {
    let mut by_id = BTreeMap::new();
    for desired in items {
        let content = desired.content.trim().to_string();
        if content.is_empty() {
            return Err("Shopping item content must not be empty".to_string());
        }
        let labels = canonical_labels(&desired.labels)?;
        let id = item_id(&content, &labels);
        let sources = desired
            .sources
            .iter()
            .map(|source| source.trim())
            .filter(|source| !source.is_empty())
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        by_id.insert(
            id.clone(),
            ShoppingListItem {
                id,
                content,
                labels,
                sources,
                checked: false,
                manual: false,
            },
        );
    }
    Ok(by_id.into_values().collect())
}

pub fn load_shopping_list(path: &Path) -> Result<ShoppingList, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ShoppingList::default())
        }
        Err(error) => return Err(format!("Failed reading shopping list: {error}")),
    };
    let list: ShoppingList = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid shopping list file: {error}"))?;
    if list.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported shopping list schema version: {}",
            list.schema_version
        ));
    }
    Ok(list)
}

pub fn plan_shopping_list(
    current: &ShoppingList,
    week_label: &str,
    desired: &[DesiredItem],
) -> Result<ShoppingListPlan, String> {
    let week_label = week_label.trim().to_string();
    if week_label.is_empty() {
        return Err("Shopping list week label must not be empty".to_string());
    }
    let items = desired_items(desired)?;
    let current_ids = current
        .items
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    let desired_ids = items
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    let unchanged_count = current_ids.intersection(&desired_ids).count();
    // Manual items are retained by the apply, so they are neither deleted nor recreated.
    let retained = current
        .items
        .iter()
        .filter(|item| item.manual && !desired_ids.contains(item.id.as_str()))
        .count();
    Ok(ShoppingListPlan {
        base_revision: current.revision,
        week_label,
        summary: ShoppingListPlanSummary {
            current_count: current.items.len(),
            desired_count: items.len(),
            unchanged_count,
            create_count: desired_ids.difference(&current_ids).count(),
            delete_count: current_ids.difference(&desired_ids).count() - retained,
            manual_count: retained,
        },
        items,
    })
}

pub fn preview_shopping_list(
    path: &Path,
    week_label: &str,
    desired: &[DesiredItem],
) -> Result<ShoppingListPlan, String> {
    plan_shopping_list(&load_shopping_list(path)?, week_label, desired)
}

fn persist(path: &Path, list: &ShoppingList) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed creating shopping list directory: {error}"))?;
    }
    let mut payload = serde_json::to_vec_pretty(list)
        .map_err(|error| format!("Failed serializing shopping list: {error}"))?;
    payload.push(b'\n');
    write_atomic(path, &payload).map_err(|error| format!("Failed saving shopping list: {error}"))
}

fn require_revision(current: &ShoppingList, expected_revision: u64) -> Result<(), String> {
    if current.revision != expected_revision {
        return Err(format!(
            "Stale shopping list revision: expected {expected_revision}, current {}",
            current.revision
        ));
    }
    Ok(())
}

pub fn apply_shopping_list(
    path: &Path,
    expected_revision: u64,
    week_label: &str,
    desired: &[DesiredItem],
) -> Result<ShoppingList, String> {
    let current = load_shopping_list(path)?;
    require_revision(&current, expected_revision)?;
    let plan = plan_shopping_list(&current, week_label, desired)?;
    let checked = current
        .items
        .iter()
        .map(|item| (item.id.as_str(), item.checked))
        .collect::<BTreeMap<_, _>>();
    // Hand-added items survive the rebuild; a recipe that now yields the same item wins.
    let mut by_id = current
        .items
        .iter()
        .filter(|item| item.manual)
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<BTreeMap<_, _>>();
    for mut item in plan.items {
        item.checked = checked.get(item.id.as_str()).copied().unwrap_or(false);
        by_id.insert(item.id.clone(), item);
    }
    let items = by_id.into_values().collect();
    let next = ShoppingList {
        schema_version: SCHEMA_VERSION,
        revision: current.revision + 1,
        week_label: plan.week_label,
        items,
        rollback: Some(ShoppingListSnapshot {
            week_label: current.week_label,
            items: current.items,
        }),
    };
    persist(path, &next)?;
    Ok(next)
}

pub fn set_shopping_item_checked(
    path: &Path,
    expected_revision: u64,
    item_id: &str,
    checked: bool,
) -> Result<ShoppingList, String> {
    let mut current = load_shopping_list(path)?;
    require_revision(&current, expected_revision)?;
    let item = current
        .items
        .iter_mut()
        .find(|item| item.id == item_id)
        .ok_or_else(|| format!("Shopping item not found: {item_id}"))?;
    item.checked = checked;
    current.revision += 1;
    persist(path, &current)?;
    Ok(current)
}

pub fn add_shopping_item(
    path: &Path,
    expected_revision: u64,
    content: &str,
    labels: &[String],
) -> Result<ShoppingList, String> {
    let mut current = load_shopping_list(path)?;
    require_revision(&current, expected_revision)?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Shopping item content must not be empty".to_string());
    }
    let labels = canonical_labels(labels)?;
    let id = item_id(&content, &labels);
    if current.items.iter().any(|item| item.id == id) {
        return Err(format!("Shopping item is already on the list: {content}"));
    }
    let position = current.items.partition_point(|item| item.id < id);
    current.items.insert(
        position,
        ShoppingListItem {
            id,
            content,
            labels,
            sources: Vec::new(),
            checked: false,
            manual: true,
        },
    );
    current.revision += 1;
    persist(path, &current)?;
    Ok(current)
}

pub fn remove_shopping_item(
    path: &Path,
    expected_revision: u64,
    item_id: &str,
) -> Result<ShoppingList, String> {
    let mut current = load_shopping_list(path)?;
    require_revision(&current, expected_revision)?;
    let position = current
        .items
        .iter()
        .position(|item| item.id == item_id)
        .ok_or_else(|| format!("Shopping item not found: {item_id}"))?;
    current.items.remove(position);
    current.revision += 1;
    persist(path, &current)?;
    Ok(current)
}

pub fn rollback_shopping_list(path: &Path, expected_revision: u64) -> Result<ShoppingList, String> {
    let mut current = load_shopping_list(path)?;
    require_revision(&current, expected_revision)?;
    let rollback = current
        .rollback
        .take()
        .ok_or_else(|| "No shopping list rollback is available".to_string())?;
    current.week_label = rollback.week_label;
    current.items = rollback.items;
    current.revision += 1;
    persist(path, &current)?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cooking::{aggregate_rust, CookingRecipe};
    use crate::CookingConfig;
    use tempfile::tempdir;

    fn desired(content: &str) -> DesiredItem {
        DesiredItem {
            content: content.to_string(),
            labels: vec!["Produce".to_string()],
            sources: Vec::new(),
        }
    }

    fn aggregated_onions(recipe_title: &str) -> Vec<DesiredItem> {
        let config = CookingConfig {
            default_label: "produce".to_string(),
            labels: vec!["produce".to_string()],
            ..CookingConfig::default()
        };
        let recipe = CookingRecipe::from_ingredient_lines(
            "recipe.md",
            recipe_title,
            &["- 2 | onion | produce"],
        )
        .unwrap();
        aggregate_rust(&config, &[recipe]).unwrap()
    }

    #[test]
    fn loads_legacy_schema_v1_items_without_structured_sources() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "revision": 4,
  "weekLabel": "This week",
  "items": [{
    "id": "legacy-item",
    "content": "milk",
    "labels": ["dairy"],
    "checked": true
  }],
  "rollback": {
    "weekLabel": "Last week",
    "items": [{
      "id": "legacy-rollback-item",
      "content": "bread",
      "labels": ["bakery"],
      "checked": false
    }]
  }
}"#,
        )
        .unwrap();

        let loaded = load_shopping_list(&path).unwrap();

        assert!(loaded.items[0].sources.is_empty());
        assert!(loaded.rollback.unwrap().items[0].sources.is_empty());
    }

    #[test]
    fn recipe_provenance_changes_preserve_item_identity_and_checked_state() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let first = apply_shopping_list(&path, 0, "This week", &aggregated_onions("Soup")).unwrap();
        let checked =
            set_shopping_item_checked(&path, first.revision, &first.items[0].id, true).unwrap();

        let reapplied = apply_shopping_list(
            &path,
            checked.revision,
            "This week",
            &aggregated_onions("Stew"),
        )
        .unwrap();

        assert_eq!(reapplied.items[0].id, first.items[0].id);
        assert!(reapplied.items[0].checked);
        assert_eq!(reapplied.items[0].sources, vec!["Stew".to_string()]);
        assert_eq!(reapplied.rollback.unwrap().items[0].sources, vec!["Soup"]);
    }

    #[test]
    fn apply_check_restart_and_rollback_preserve_authoritative_state() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let plan = preview_shopping_list(&path, "Aug 10 - Aug 16", &[desired("2 onions")]).unwrap();
        assert_eq!(plan.base_revision, 0);
        assert_eq!(plan.summary.create_count, 1);

        let applied = apply_shopping_list(
            &path,
            plan.base_revision,
            &plan.week_label,
            &[desired("2 onions")],
        )
        .unwrap();
        let checked =
            set_shopping_item_checked(&path, applied.revision, &applied.items[0].id, true).unwrap();
        assert!(load_shopping_list(&path).unwrap().items[0].checked);

        let restored = rollback_shopping_list(&path, checked.revision).unwrap();
        assert!(restored.items.is_empty());
        assert_eq!(load_shopping_list(&path).unwrap(), restored);
    }

    #[test]
    fn manual_items_survive_an_apply_that_rebuilds_the_week() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let applied = apply_shopping_list(&path, 0, "This week", &[desired("2 onions")]).unwrap();
        let added = add_shopping_item(
            &path,
            applied.revision,
            "loo roll",
            &["household".to_string()],
        )
        .unwrap();
        let loo_roll = added
            .items
            .iter()
            .find(|item| item.content == "loo roll")
            .unwrap();
        assert!(loo_roll.manual);
        let checked = set_shopping_item_checked(&path, added.revision, &loo_roll.id, true).unwrap();

        let plan = plan_shopping_list(&checked, "Next week", &[desired("milk")]).unwrap();
        assert_eq!(plan.summary.manual_count, 1);
        assert_eq!(
            plan.summary.delete_count, 1,
            "only the recipe item is removed"
        );

        let rebuilt =
            apply_shopping_list(&path, checked.revision, "Next week", &[desired("milk")]).unwrap();

        let kept = rebuilt
            .items
            .iter()
            .find(|item| item.content == "loo roll")
            .unwrap();
        assert!(kept.manual, "hand-added items stay manual across apply");
        assert!(kept.checked, "hand-added items keep their checked state");
        assert!(rebuilt.items.iter().any(|item| item.content == "milk"));
        assert!(!rebuilt.items.iter().any(|item| item.content == "2 onions"));
    }

    #[test]
    fn a_recipe_claims_a_manual_item_it_now_produces() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let added = add_shopping_item(&path, 0, "2 onions", &["produce".to_string()]).unwrap();
        let checked =
            set_shopping_item_checked(&path, added.revision, &added.items[0].id, true).unwrap();

        let applied = apply_shopping_list(
            &path,
            checked.revision,
            "This week",
            &[DesiredItem {
                content: "2 onions".to_string(),
                labels: vec!["produce".to_string()],
                sources: vec!["Soup".to_string()],
            }],
        )
        .unwrap();

        assert_eq!(applied.items.len(), 1, "the item is not duplicated");
        assert!(!applied.items[0].manual, "recipe provenance takes over");
        assert!(applied.items[0].checked);
        assert_eq!(applied.items[0].sources, vec!["Soup".to_string()]);
    }

    #[test]
    fn added_items_stay_id_ordered_and_reject_duplicates() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let mut list = ShoppingList::default();
        for content in ["milk", "bread", "eggs", "jam"] {
            list =
                add_shopping_item(&path, list.revision, content, &["other".to_string()]).unwrap();
        }
        let ids = list
            .items
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "items stay in canonical id order");

        let before = fs::read(&path).unwrap();
        let duplicate = add_shopping_item(&path, list.revision, " milk ", &["Other".to_string()])
            .expect_err("duplicate content and labels must fail");
        assert!(duplicate.contains("already on the list"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn removes_a_manual_item_and_stays_id_ordered() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let mut list = ShoppingList::default();
        for content in ["milk", "bread", "eggs"] {
            list =
                add_shopping_item(&path, list.revision, content, &["other".to_string()]).unwrap();
        }
        assert_eq!(list.items.len(), 3);
        let target = list.items[1].id.clone();

        let removed = remove_shopping_item(&path, list.revision, &target).unwrap();

        assert_eq!(removed.revision, list.revision + 1);
        assert_eq!(removed.items.len(), 2);
        assert!(!removed.items.iter().any(|item| item.id == target));
        let ids = removed
            .items
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "remaining items stay in canonical id order");
        assert_eq!(load_shopping_list(&path).unwrap(), removed);
    }

    #[test]
    fn stale_and_invalid_mutations_leave_persisted_bytes_unchanged() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shopping-list.json");
        let applied = apply_shopping_list(&path, 0, "This week", &[desired("milk")]).unwrap();
        let before = fs::read(&path).unwrap();

        let stale = set_shopping_item_checked(&path, 0, &applied.items[0].id, true)
            .expect_err("stale write must fail");
        assert!(stale.contains("Stale shopping list revision"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let invalid = set_shopping_item_checked(&path, applied.revision, "missing", true)
            .expect_err("unknown item must fail");
        assert!(invalid.contains("Shopping item not found"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let invalid_plan =
            apply_shopping_list(&path, applied.revision, "This week", &[desired("")])
                .expect_err("blank item must fail");
        assert!(invalid_plan.contains("content must not be empty"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let stale_add = add_shopping_item(&path, 0, "loo roll", &["household".to_string()])
            .expect_err("stale add must fail");
        assert!(stale_add.contains("Stale shopping list revision"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let blank_add = add_shopping_item(&path, applied.revision, "   ", &[])
            .expect_err("blank add must fail");
        assert!(blank_add.contains("content must not be empty"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let stale_remove = remove_shopping_item(&path, 0, &applied.items[0].id)
            .expect_err("stale remove must fail");
        assert!(stale_remove.contains("Stale shopping list revision"));
        assert_eq!(fs::read(&path).unwrap(), before);

        let unknown_remove = remove_shopping_item(&path, applied.revision, "missing")
            .expect_err("unknown item must fail");
        assert!(unknown_remove.contains("Shopping item not found"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
