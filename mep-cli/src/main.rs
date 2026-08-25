//! mep CLI - deterministic recipe import.

use clap::{Parser, Subcommand};
use mep_core::load_cooking_config;
use std::path::PathBuf;

mod commands;

#[derive(Parser)]
#[command(name = "mep")]
#[command(about = "Mise-en-place CLI")]
#[command(version)]
struct Cli {
    /// Path to config directory
    #[arg(long, global = true, env = "MEP_CONFIG_DIR")]
    config_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Recipe import commands
    Recipe {
        #[command(subcommand)]
        recipe: RecipeCommands,
    },
}

#[derive(Subcommand)]
enum RecipeCommands {
    /// Validate and import already-extracted recipe Markdown
    Import {
        /// Markdown file to import, or - to read stdin
        input: PathBuf,

        /// Target recipes directory
        #[arg(long)]
        recipes_dir: PathBuf,
    },
}

fn main() {
    if let Err(error) = run() {
        let exit_code = match error {
            RunError::Core(error) => {
                eprintln!("error: {}", error);
                1
            }
            RunError::Reported => 2,
        };
        std::process::exit(exit_code);
    }
}

enum RunError {
    Core(mep_core::Error),
    Reported,
}

impl From<mep_core::Error> for RunError {
    fn from(error: mep_core::Error) -> Self {
        Self::Core(error)
    }
}

fn run() -> Result<(), RunError> {
    let cli = Cli::parse();
    let config_dir = resolve_config_dir(cli.config_dir);
    let import_is_machine_facing = matches!(
        &cli.command,
        Commands::Recipe {
            recipe: RecipeCommands::Import { .. }
        }
    );
    let cooking = match load_cooking_config(&config_dir) {
        Ok(cooking) => cooking,
        Err(error) if import_is_machine_facing => {
            eprintln!(
                "{}",
                serde_json::json!({
                    "ok": false,
                    "error": {
                        "code": "config_failed",
                        "message": error.to_string(),
                    },
                })
            );
            return Err(RunError::Reported);
        }
        Err(error) => return Err(error.into()),
    };

    match cli.command {
        Commands::Recipe { recipe } => match recipe {
            RecipeCommands::Import { input, recipes_dir } => {
                match commands::recipe::import_markdown(&commands::recipe::MarkdownImportOptions {
                    input: &input,
                    recipes_dir: &recipes_dir,
                    cooking: &cooking,
                }) {
                    Ok(result) => println!(
                        "{}",
                        serde_json::to_string_pretty(&result).expect("import result serializes")
                    ),
                    Err(error) => {
                        eprintln!(
                            "{}",
                            serde_json::to_string(&serde_json::json!({
                                "ok": false,
                                "error": error,
                            }))
                            .expect("import error serializes")
                        );
                        return Err(RunError::Reported);
                    }
                }
            }
        },
    }

    Ok(())
}

fn resolve_config_dir(config_dir: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = config_dir {
        return dir;
    }

    if let Some(dir) = dirs::config_dir() {
        return dir.join("mep");
    }

    PathBuf::from(".mep")
}
