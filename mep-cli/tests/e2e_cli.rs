use assert_cmd::cargo::cargo_bin_cmd;
use assert_cmd::Command;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn mep_cmd(config_dir: &Path) -> Command {
    let mut cmd = cargo_bin_cmd!("mep");
    cmd.arg("--config-dir").arg(config_dir);
    cmd
}

fn stdout_success(cmd: &mut Command) -> String {
    let output = cmd.assert().success().get_output().stdout.clone();
    String::from_utf8(output).expect("stdout should be utf8")
}

fn stderr_failure(cmd: &mut Command) -> String {
    let output = cmd.assert().failure().get_output().stderr.clone();
    String::from_utf8(output).expect("stderr should be utf8")
}

fn parse_json(stdout: &str) -> Value {
    serde_json::from_str(stdout.trim()).expect("stdout should be valid json")
}

fn write_file(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directories");
    }
    fs::write(path, body).expect("write test file");
}

fn agent_recipe_markdown(title: &str) -> String {
    format!(
        "---\ntitle: {title}\ntype: recipe\nsource: https://example.com/fixture-soup\n---\n\n# {title}\n\n## Ingredients\n- 2 | onions | fruit & veg\n- 500ml | vegetable stock | tins & jars\n\n## Method\n1. Fry onions.\n2. Add stock.\n"
    )
}

#[test]
fn recipe_import_accepts_an_explicit_markdown_file_without_credentials_or_network() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let recipes_dir = temp.path().join("recipes");
    let input_path = temp.path().join("agent-output.md");
    write_file(&input_path, &agent_recipe_markdown("Fixture Soup"));

    let mut import = mep_cmd(&config_dir);
    import
        .arg("recipe")
        .arg("import")
        .arg(&input_path)
        .arg("--recipes-dir")
        .arg(&recipes_dir);

    let result = parse_json(&stdout_success(&mut import));
    assert_eq!(result["ok"], true);
    assert_eq!(result["slug"], "fixture-soup");
    assert_eq!(result["source"], "https://example.com/fixture-soup");

    let markdown =
        fs::read_to_string(recipes_dir.join("fixture-soup.md")).expect("read canonical markdown");
    assert!(markdown.starts_with("---\ntitle: Fixture Soup\ntype: recipe\n"));
    assert!(markdown.contains("- 2 | onions | fruit & veg"));

    let sidecar: Value = serde_json::from_str(
        &fs::read_to_string(recipes_dir.join(".machine/fixture-soup.json")).expect("read sidecar"),
    )
    .expect("parse sidecar");
    assert_eq!(sidecar["sync"]["source_job"]["type"], "agent-import");
    assert_eq!(
        sidecar["sync"]["source_job"]["source"],
        "https://example.com/fixture-soup"
    );
}

#[test]
fn recipe_import_accepts_markdown_from_stdin() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let recipes_dir = temp.path().join("recipes");

    let mut import = mep_cmd(&config_dir);
    import
        .arg("recipe")
        .arg("import")
        .arg("-")
        .arg("--recipes-dir")
        .arg(&recipes_dir)
        .write_stdin(agent_recipe_markdown("Stdin Soup"));

    let result = parse_json(&stdout_success(&mut import));
    assert_eq!(result["ok"], true);
    assert_eq!(result["slug"], "stdin-soup");
    assert!(recipes_dir.join("stdin-soup.md").is_file());
    assert!(recipes_dir.join(".machine/stdin-soup.json").is_file());
}

#[test]
fn recipe_import_rejects_a_title_mismatch_without_creating_the_recipes_directory() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let recipes_dir = temp.path().join("recipes");
    let input_path = temp.path().join("agent-output.md");
    let invalid = agent_recipe_markdown("Fixture Soup").replacen(
        "title: Fixture Soup",
        "title: Nearly Fixture Soup",
        1,
    );
    write_file(&input_path, &invalid);

    let mut import = mep_cmd(&config_dir);
    import
        .arg("recipe")
        .arg("import")
        .arg(&input_path)
        .arg("--recipes-dir")
        .arg(&recipes_dir);

    let stderr = stderr_failure(&mut import);
    let failure = parse_json(&stderr);
    assert_eq!(failure["ok"], false);
    assert_eq!(failure["error"]["code"], "title_mismatch");
    assert_eq!(failure["error"]["field"], "title");
    assert!(
        !recipes_dir.exists(),
        "invalid input must not create or write the recipes directory"
    );
}

#[test]
fn recipe_import_rejects_an_unsafe_cover_without_writing_recipe_artifacts() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let recipes_dir = temp.path().join("recipes");
    let input_path = temp.path().join("agent-output.md");
    let invalid = agent_recipe_markdown("Fixture Soup").replacen(
        "source: https://example.com/fixture-soup",
        "source: https://example.com/fixture-soup\ncover: ../outside.jpg",
        1,
    );
    write_file(&input_path, &invalid);

    let mut import = mep_cmd(&config_dir);
    import
        .arg("recipe")
        .arg("import")
        .arg(&input_path)
        .arg("--recipes-dir")
        .arg(&recipes_dir);

    let stderr = stderr_failure(&mut import);
    let failure = parse_json(&stderr);
    assert_eq!(failure["error"]["code"], "unsafe_image_reference");
    assert!(!recipes_dir.exists());
}
