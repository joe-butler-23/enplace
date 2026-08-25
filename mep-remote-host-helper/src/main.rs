use mep_core::watch::{WatchBatch, WatchService, WatchSubscription};
use mep_core::{build_desired_items, CookingRecipeInput};
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const MAX_FRAME_BYTES: usize = 1_048_576;
const MAX_RECIPES: usize = 256;
const MAX_THUMBNAILS: usize = 500;
const BUILD_COMMAND: &str = "build_desired_items";
const THUMBNAIL_COMMAND: &str = "create_thumbnail";
const THUMBNAILS_COMMAND: &str = "create_thumbnails";
const PREPARE_DATABASE_THUMBNAILS_COMMAND: &str = "prepare_database_thumbnails";
const WATCH_START_COMMAND: &str = "watch_start";
const WATCH_STATUS_COMMAND: &str = "watch_status";
const WATCH_STOP_COMMAND: &str = "watch_stop";
const SHOPPING_LIST_COMMAND: &str = "shopping_list";
const SHOPPING_PREVIEW_COMMAND: &str = "shopping_preview";
const SHOPPING_APPLY_COMMAND: &str = "shopping_apply";
const SHOPPING_CHECK_COMMAND: &str = "shopping_check";
const SHOPPING_ADD_COMMAND: &str = "shopping_add";
const SHOPPING_REMOVE_COMMAND: &str = "shopping_remove";
const SHOPPING_ROLLBACK_COMMAND: &str = "shopping_rollback";

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    auth: String,
    command: String,
    payload: Payload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Payload {
    #[serde(default)]
    recipes: Vec<CookingRecipeInput>,
    #[serde(default)]
    source_path: Option<PathBuf>,
    #[serde(default)]
    source_paths: Vec<PathBuf>,
    #[serde(default)]
    max_size_px: Option<u32>,
    #[serde(default)]
    root: Option<PathBuf>,
    #[serde(default)]
    subscriptions: Vec<WatchSubscription>,
    #[serde(default)]
    generation: Option<u64>,
    #[serde(default)]
    desired_items: Vec<mep_core::DesiredItem>,
    #[serde(default)]
    week_label: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    checked: Option<bool>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Response<T: Serialize> {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ThumbnailBatchItem {
    thumbnail: Option<mep_core::thumbnails::Thumbnail>,
    error: Option<String>,
}

fn response_error(id: Option<String>, message: impl Into<String>) -> Response<serde_json::Value> {
    Response {
        id,
        ok: false,
        result: None,
        error: Some(message.into()),
    }
}

fn response_ok<T: Serialize>(id: String, result: T) -> Response<T> {
    Response {
        id: Some(id),
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn argument(name: &str) -> Option<String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
    }
    None
}

fn write_json<T: Serialize, W: Write + ?Sized>(stdout: &mut W, response: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *stdout, response).map_err(io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn hello_ack() -> serde_json::Value {
    serde_json::json!({"type": "hello", "ok": true})
}

fn validate_hello(line: &[u8]) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_slice(line).map_err(|error| format!("Malformed handshake: {error}"))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("hello") {
        return Err("Authentication handshake required".to_string());
    }
    let auth = value
        .get("auth")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Handshake authentication token missing".to_string())?;
    Ok(auth.to_string())
}

fn read_frame(reader: &mut impl BufRead, frame: &mut Vec<u8>) -> io::Result<bool> {
    frame.clear();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(!frame.is_empty());
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        let chunk = buffer[..take].to_vec();
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            reader.consume(take);
            let mut ended = chunk.contains(&b'\n');
            while !ended {
                let next = reader.fill_buf()?;
                if next.is_empty() {
                    break;
                }
                let next_take = next
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(next.len(), |index| index + 1);
                let next_chunk = next[..next_take].to_vec();
                reader.consume(next_take);
                ended = next_chunk.contains(&b'\n');
            }
            frame.clear();
            frame.resize(MAX_FRAME_BYTES + 1, b' ');
            return Ok(true);
        }
        frame.extend_from_slice(&chunk);
        reader.consume(take);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

fn process_line(
    line: &[u8],
    config_dir: &PathBuf,
    shopping_data_dir: &PathBuf,
    thumbnail_cache_dir: &PathBuf,
    expected_auth: Option<&str>,
    watch_service: &Arc<WatchService>,
    writer: &SharedWriter,
) -> serde_json::Value {
    if line.len() > MAX_FRAME_BYTES {
        return serde_json::to_value(response_error(None, "Input frame too large")).unwrap();
    }

    let Some(expected_auth) = expected_auth else {
        return serde_json::to_value(response_error(None, "Authentication handshake required"))
            .unwrap();
    };

    let request: Request = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(error) => {
            return serde_json::to_value(response_error(
                None,
                format!("Malformed request: {error}"),
            ))
            .unwrap()
        }
    };
    if request.auth != expected_auth {
        return serde_json::to_value(response_error(Some(request.id), "Authentication failed"))
            .unwrap();
    }
    if request.command != BUILD_COMMAND
        && request.command != THUMBNAIL_COMMAND
        && request.command != THUMBNAILS_COMMAND
        && request.command != PREPARE_DATABASE_THUMBNAILS_COMMAND
        && request.command != WATCH_START_COMMAND
        && request.command != WATCH_STATUS_COMMAND
        && request.command != WATCH_STOP_COMMAND
        && request.command != SHOPPING_LIST_COMMAND
        && request.command != SHOPPING_PREVIEW_COMMAND
        && request.command != SHOPPING_APPLY_COMMAND
        && request.command != SHOPPING_CHECK_COMMAND
        && request.command != SHOPPING_ADD_COMMAND
        && request.command != SHOPPING_REMOVE_COMMAND
        && request.command != SHOPPING_ROLLBACK_COMMAND
    {
        return serde_json::to_value(response_error(
            Some(request.id),
            format!("Unsupported command: {}", request.command),
        ))
        .unwrap();
    }
    if request.command == BUILD_COMMAND && request.payload.recipes.len() > MAX_RECIPES {
        return serde_json::to_value(response_error(
            Some(request.id),
            format!("Too many recipes (maximum {MAX_RECIPES})"),
        ))
        .unwrap();
    }

    if request.command == WATCH_START_COMMAND {
        let Some(root) = request.payload.root else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "watch_start requires a root",
            ))
            .unwrap();
        };
        if request.payload.subscriptions.is_empty() {
            return serde_json::to_value(response_error(
                Some(request.id),
                "watch_start requires path-filtered subscriptions",
            ))
            .unwrap();
        }
        let writer = writer.clone();
        return match watch_service.start(
            root,
            request.payload.subscriptions,
            move |batch: WatchBatch| {
                if let Ok(mut writer) = writer.lock() {
                    let frame = serde_json::json!({ "type": "watch", "batch": batch });
                    let _ = write_json(&mut **writer, &frame);
                }
            },
        ) {
            Ok(status) => serde_json::to_value(response_ok(request.id, status)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }

    if request.command == WATCH_STATUS_COMMAND {
        return match watch_service.status_since(request.payload.generation.unwrap_or(0)) {
            Ok(status) => serde_json::to_value(response_ok(request.id, status)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }

    if request.command == WATCH_STOP_COMMAND {
        return match watch_service.stop() {
            Ok(()) => {
                serde_json::to_value(response_ok(request.id, serde_json::Value::Null)).unwrap()
            }
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }

    if request.command == BUILD_COMMAND {
        return match build_desired_items(config_dir, request.payload.recipes) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => {
                serde_json::to_value(response_error(Some(request.id), error.to_string())).unwrap()
            }
        };
    }

    let shopping_path = shopping_data_dir.join("shopping-list.json");
    if request.command == SHOPPING_LIST_COMMAND {
        return match mep_core::shopping_list::load_shopping_list(&shopping_path) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_PREVIEW_COMMAND {
        let week_label = request.payload.week_label.as_deref().unwrap_or("");
        return match mep_core::shopping_list::preview_shopping_list(
            &shopping_path,
            week_label,
            &request.payload.desired_items,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_APPLY_COMMAND {
        let Some(expected_revision) = request.payload.expected_revision else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_apply requires expectedRevision",
            ))
            .unwrap();
        };
        let week_label = request.payload.week_label.as_deref().unwrap_or("");
        return match mep_core::shopping_list::apply_shopping_list(
            &shopping_path,
            expected_revision,
            week_label,
            &request.payload.desired_items,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_CHECK_COMMAND {
        let Some(expected_revision) = request.payload.expected_revision else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_check requires expectedRevision",
            ))
            .unwrap();
        };
        let Some(item_id) = request.payload.item_id.as_deref() else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_check requires itemId",
            ))
            .unwrap();
        };
        let Some(checked) = request.payload.checked else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_check requires checked",
            ))
            .unwrap();
        };
        return match mep_core::shopping_list::set_shopping_item_checked(
            &shopping_path,
            expected_revision,
            item_id,
            checked,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_ADD_COMMAND {
        let Some(expected_revision) = request.payload.expected_revision else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_add requires expectedRevision",
            ))
            .unwrap();
        };
        let Some(content) = request.payload.content.as_deref() else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_add requires content",
            ))
            .unwrap();
        };
        return match mep_core::shopping_list::add_shopping_item(
            &shopping_path,
            expected_revision,
            content,
            &request.payload.labels,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_REMOVE_COMMAND {
        let Some(expected_revision) = request.payload.expected_revision else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_remove requires expectedRevision",
            ))
            .unwrap();
        };
        let Some(item_id) = request.payload.item_id.as_deref() else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_remove requires itemId",
            ))
            .unwrap();
        };
        return match mep_core::shopping_list::remove_shopping_item(
            &shopping_path,
            expected_revision,
            item_id,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }
    if request.command == SHOPPING_ROLLBACK_COMMAND {
        let Some(expected_revision) = request.payload.expected_revision else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "shopping_rollback requires expectedRevision",
            ))
            .unwrap();
        };
        return match mep_core::shopping_list::rollback_shopping_list(
            &shopping_path,
            expected_revision,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }

    if request.command == THUMBNAIL_COMMAND {
        let Some(source_path) = request.payload.source_path else {
            return serde_json::to_value(response_error(
                Some(request.id),
                "create_thumbnail requires a source_path",
            ))
            .unwrap();
        };
        let max_size_px = request.payload.max_size_px.unwrap_or(640);
        if max_size_px != 320 && max_size_px != 640 {
            return serde_json::to_value(response_error(
                Some(request.id),
                "create_thumbnail supports only 320 or 640 pixels",
            ))
            .unwrap();
        }
        return match mep_core::thumbnails::get_or_create_thumbnail(
            thumbnail_cache_dir,
            &source_path,
            max_size_px,
        ) {
            Ok(result) => serde_json::to_value(response_ok(request.id, result)).unwrap(),
            Err(error) => serde_json::to_value(response_error(Some(request.id), error)).unwrap(),
        };
    }

    if request.command == THUMBNAILS_COMMAND {
        let max_size_px = request.payload.max_size_px.unwrap_or(640);
        if max_size_px != 320 && max_size_px != 640 {
            return serde_json::to_value(response_error(
                Some(request.id),
                "create_thumbnails supports only 320 or 640 pixels",
            ))
            .unwrap();
        }
        if request.payload.source_paths.len() > MAX_THUMBNAILS {
            return serde_json::to_value(response_error(
                Some(request.id),
                format!("Too many thumbnails (maximum {MAX_THUMBNAILS})"),
            ))
            .unwrap();
        }
        let result = mep_core::thumbnails::get_or_create_thumbnails(
            thumbnail_cache_dir,
            &request.payload.source_paths,
            max_size_px,
        )
        .into_iter()
        .map(|result| match result {
            Ok(thumbnail) => ThumbnailBatchItem {
                thumbnail: Some(thumbnail),
                error: None,
            },
            Err(error) => ThumbnailBatchItem {
                thumbnail: None,
                error: Some(error),
            },
        })
        .collect::<Vec<_>>();
        return serde_json::to_value(response_ok(request.id, result)).unwrap();
    }

    if request.command == PREPARE_DATABASE_THUMBNAILS_COMMAND {
        if request.payload.source_paths.len() > MAX_THUMBNAILS {
            return serde_json::to_value(response_error(
                Some(request.id),
                format!("Too many thumbnails (maximum {MAX_THUMBNAILS})"),
            ))
            .unwrap();
        }
        let result = mep_core::thumbnails::prepare_database_thumbnails(
            thumbnail_cache_dir,
            &request.payload.source_paths,
        )
        .into_iter()
        .map(|result| match result {
            Ok(thumbnail) => ThumbnailBatchItem {
                thumbnail: Some(thumbnail),
                error: None,
            },
            Err(error) => ThumbnailBatchItem {
                thumbnail: None,
                error: Some(error),
            },
        })
        .collect::<Vec<_>>();
        return serde_json::to_value(response_ok(request.id, result)).unwrap();
    }

    serde_json::to_value(response_error(Some(request.id), "unknown command")).unwrap()
}

fn main() -> io::Result<()> {
    let config_dir = argument("--config-dir")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "--config-dir is required"))?;
    let thumbnail_cache_dir = argument("--thumbnail-cache-dir")
        .map(PathBuf::from)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "--thumbnail-cache-dir is required",
            )
        })?;
    let shopping_data_dir = argument("--shopping-data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir.clone());
    let stdin = io::stdin();
    let writer: SharedWriter = Arc::new(Mutex::new(Box::new(io::BufWriter::new(io::stdout()))));
    let watch_service = Arc::new(WatchService::default());
    let mut reader = io::BufReader::new(stdin.lock());
    let mut line = Vec::new();
    let mut expected_auth = None;
    loop {
        if !read_frame(&mut reader, &mut line)? {
            break;
        }
        let frame = line.strip_suffix(b"\n").unwrap_or(&line);
        let frame = frame.strip_suffix(b"\r").unwrap_or(frame);
        if expected_auth.is_none() {
            let response = match validate_hello(frame) {
                Ok(auth) => {
                    expected_auth = Some(auth);
                    hello_ack()
                }
                Err(error) => serde_json::to_value(response_error(None, error)).unwrap(),
            };
            let mut writer = writer
                .lock()
                .map_err(|_| io::Error::other("helper output lock poisoned"))?;
            write_json(&mut **writer, &response)?;
            continue;
        }
        let response = process_line(
            frame,
            &config_dir,
            &shopping_data_dir,
            &thumbnail_cache_dir,
            expected_auth.as_deref(),
            &watch_service,
            &writer,
        );
        let mut writer = writer
            .lock()
            .map_err(|_| io::Error::other("helper output lock poisoned"))?;
        write_json(&mut **writer, &response)?;
    }
    watch_service.stop().map_err(io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn request(auth: &str) -> String {
        serde_json::json!({
            "id": "1",
            "auth": auth,
            "command": BUILD_COMMAND,
            "payload": { "recipes": [{
                "path": "recipe.md",
                "title": "Soup",
                "markdown": "# Soup\n\n## Ingredients\n- 1 | onion | produce\n\n## Method\n1. Cook"
            }] }
        })
        .to_string()
    }

    fn process(line: &[u8], config_dir: &PathBuf, auth: Option<&str>) -> serde_json::Value {
        let cache_dir = config_dir.join("thumbnails");
        process_line(
            line,
            config_dir,
            config_dir,
            &cache_dir,
            auth,
            &Arc::new(WatchService::default()),
            &Arc::new(Mutex::new(Box::new(io::sink()))),
        )
    }

    #[test]
    fn valid_request_matches_golden_shape() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("cooking.toml"), "").unwrap();
        let value = process(
            request("secret").as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"][0]["content"], "onion - 1");
        assert_eq!(value["result"][0]["sources"], serde_json::json!(["Soup"]));
    }

    #[test]
    fn unknown_commands_are_rejected_after_handshake() {
        let dir = tempdir().unwrap();
        let mut unknown = serde_json::from_str::<serde_json::Value>(&request("secret")).unwrap();
        unknown["command"] = serde_json::Value::String("nope".to_string());
        let invalid = process(
            unknown.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(invalid["ok"], false);
    }

    #[test]
    fn malformed_and_oversized_frames_are_rejected_without_io() {
        let dir = tempdir().unwrap();
        let malformed = process(b"{", &dir.path().to_path_buf(), Some("secret"));
        assert_eq!(malformed["ok"], false);
        let oversized = process(
            &vec![b'x'; MAX_FRAME_BYTES + 1],
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(oversized["error"], "Input frame too large");
    }

    #[test]
    fn ordinary_commands_are_rejected_before_handshake() {
        let dir = tempdir().unwrap();
        let value = process(
            request("secret").as_bytes(),
            &dir.path().to_path_buf(),
            None,
        );
        assert_eq!(value["error"], "Authentication handshake required");
        assert_eq!(
            validate_hello(br#"{"type":"hello","auth":"secret"}"#).unwrap(),
            "secret"
        );
        assert!(validate_hello(br#"{"type":"hello","auth":""}"#).is_err());
    }

    #[test]
    fn wrong_request_authentication_is_rejected() {
        let dir = tempdir().unwrap();
        let value = process(
            request("wrong").as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(value["error"], "Authentication failed");
    }

    #[test]
    fn thumbnail_request_returns_a_versioned_generated_jpeg() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let image = image::RgbImage::from_pixel(800, 400, image::Rgb([20, 30, 40]));
        image.save(&source).unwrap();
        let request = serde_json::json!({
            "id": "thumbnail-1",
            "auth": "secret",
            "command": THUMBNAIL_COMMAND,
            "payload": { "sourcePath": source, "maxSizePx": 320 }
        });
        let value = process(
            request.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(value["ok"], true);
        assert!(value["result"]["version"]
            .as_str()
            .unwrap()
            .starts_with("v4-320-"));
        assert!(value["result"]["path"].as_str().unwrap().ends_with(".jpg"));
    }

    #[test]
    fn thumbnail_batch_preserves_order_and_reports_individual_failures() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let image = image::RgbImage::from_pixel(800, 400, image::Rgb([20, 30, 40]));
        image.save(&source).unwrap();
        let missing = dir.path().join("missing.png");
        let request = serde_json::json!({
            "id": "thumbnail-batch",
            "auth": "secret",
            "command": THUMBNAILS_COMMAND,
            "payload": { "sourcePaths": [source, missing], "maxSizePx": 320 }
        });
        let value = process(
            request.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(value["ok"], true);
        assert!(value["result"][0]["thumbnail"]["version"]
            .as_str()
            .unwrap()
            .starts_with("v4-320-"));
        assert!(value["result"][1]["thumbnail"].is_null());
        assert!(value["result"][1]["error"]
            .as_str()
            .unwrap()
            .contains("No such"));
    }

    #[test]
    fn database_thumbnail_preparation_returns_card_results_and_persists_detail() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        image::RgbImage::from_pixel(800, 400, image::Rgb([20, 30, 40]))
            .save(&source)
            .unwrap();
        let request = serde_json::json!({
            "id": "database-thumbnail-batch",
            "auth": "secret",
            "command": PREPARE_DATABASE_THUMBNAILS_COMMAND,
            "payload": { "sourcePaths": [source] }
        });
        let value = process(
            request.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(value["ok"], true);
        assert!(value["result"][0]["thumbnail"]["version"]
            .as_str()
            .unwrap()
            .starts_with("v4-320-"));
        let cache_dir = dir.path().join("thumbnails").join("thumbnails").join("v4");
        assert!(fs::read_dir(cache_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("v4-640-")));
    }

    #[test]
    fn watcher_commands_start_report_and_stop_without_a_second_runtime() {
        let dir = tempdir().unwrap();
        let watcher = Arc::new(WatchService::default());
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(io::sink())));
        let start = serde_json::json!({
            "id": "watch-start",
            "auth": "secret",
            "command": WATCH_START_COMMAND,
            "payload": {
                "root": dir.path(),
                "subscriptions": [{
                    "id": "vault",
                    "path": dir.path()
                }]
            }
        });
        let started = process_line(
            start.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            &dir.path().to_path_buf(),
            &dir.path().join("thumbnails"),
            Some("secret"),
            &watcher,
            &writer,
        );
        assert_eq!(started["ok"], true);
        assert_eq!(started["result"]["alive"], true);
        assert_eq!(started["result"]["generation"], 0);

        let status = serde_json::json!({
            "id": "watch-status",
            "auth": "secret",
            "command": WATCH_STATUS_COMMAND,
            "payload": { "generation": 0 }
        });
        let reported = process_line(
            status.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            &dir.path().to_path_buf(),
            &dir.path().join("thumbnails"),
            Some("secret"),
            &watcher,
            &writer,
        );
        assert_eq!(reported["result"]["alive"], true);
        assert_eq!(reported["result"]["changed"], false);

        watcher.stop().unwrap();
        assert_eq!(watcher.status_since(0).unwrap().alive, false);
    }

    #[test]
    fn shopping_commands_persist_valid_changes_and_reject_stale_or_invalid_writes() {
        let dir = tempdir().unwrap();
        let apply = serde_json::json!({
            "id": "apply",
            "auth": "secret",
            "command": SHOPPING_APPLY_COMMAND,
            "payload": {
                "expectedRevision": 0,
                "weekLabel": "This week",
                "desiredItems": [{ "content": "milk", "labels": ["dairy"] }]
            }
        });
        let applied = process(
            apply.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(applied["ok"], true);
        assert_eq!(applied["result"]["revision"], 1);
        let item_id = applied["result"]["items"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let list_path = dir.path().join("shopping-list.json");
        let before_stale = fs::read(&list_path).unwrap();

        let stale = serde_json::json!({
            "id": "stale",
            "auth": "secret",
            "command": SHOPPING_CHECK_COMMAND,
            "payload": { "expectedRevision": 0, "itemId": item_id, "checked": true }
        });
        let stale_result = process(
            stale.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(stale_result["ok"], false);
        assert!(stale_result["error"]
            .as_str()
            .unwrap()
            .contains("Stale shopping list revision"));
        assert_eq!(fs::read(&list_path).unwrap(), before_stale);

        let valid = serde_json::json!({
            "id": "check",
            "auth": "secret",
            "command": SHOPPING_CHECK_COMMAND,
            "payload": { "expectedRevision": 1, "itemId": item_id, "checked": true }
        });
        let checked = process(
            valid.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(checked["result"]["revision"], 2);
        assert_eq!(checked["result"]["items"][0]["checked"], true);

        let before_invalid = fs::read(&list_path).unwrap();
        let invalid = serde_json::json!({
            "id": "invalid",
            "auth": "secret",
            "command": SHOPPING_CHECK_COMMAND,
            "payload": { "expectedRevision": 2, "itemId": "missing", "checked": false }
        });
        let invalid_result = process(
            invalid.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(invalid_result["ok"], false);
        assert_eq!(fs::read(&list_path).unwrap(), before_invalid);

        let read = serde_json::json!({
            "id": "read",
            "auth": "secret",
            "command": SHOPPING_LIST_COMMAND,
            "payload": {}
        });
        let restarted = process(
            read.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(restarted["result"]["revision"], 2);
        assert_eq!(restarted["result"]["items"][0]["checked"], true);
    }

    #[test]
    fn shopping_add_marks_items_manual_and_requires_content() {
        let dir = tempdir().unwrap();
        let add = serde_json::json!({
            "id": "add",
            "auth": "secret",
            "command": SHOPPING_ADD_COMMAND,
            "payload": { "expectedRevision": 0, "content": "loo roll", "labels": ["household"] }
        });
        let added = process(
            add.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(added["ok"], true);
        assert_eq!(added["result"]["revision"], 1);
        assert_eq!(added["result"]["items"][0]["content"], "loo roll");
        assert_eq!(added["result"]["items"][0]["manual"], true);

        let list_path = dir.path().join("shopping-list.json");
        let before = fs::read(&list_path).unwrap();
        let missing_content = serde_json::json!({
            "id": "no-content",
            "auth": "secret",
            "command": SHOPPING_ADD_COMMAND,
            "payload": { "expectedRevision": 1 }
        });
        let rejected = process(
            missing_content.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(rejected["ok"], false);
        assert!(rejected["error"]
            .as_str()
            .unwrap()
            .contains("shopping_add requires content"));
        assert_eq!(fs::read(&list_path).unwrap(), before);
    }

    #[test]
    fn shopping_remove_deletes_an_item_and_requires_item_id() {
        let dir = tempdir().unwrap();
        let add = serde_json::json!({
            "id": "add",
            "auth": "secret",
            "command": SHOPPING_ADD_COMMAND,
            "payload": { "expectedRevision": 0, "content": "loo roll", "labels": ["household"] }
        });
        let added = process(
            add.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(added["ok"], true);
        let item_id = added["result"]["items"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let remove = serde_json::json!({
            "id": "remove",
            "auth": "secret",
            "command": SHOPPING_REMOVE_COMMAND,
            "payload": { "expectedRevision": 1, "itemId": item_id }
        });
        let removed = process(
            remove.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(removed["ok"], true);
        assert_eq!(removed["result"]["revision"], 2);
        assert_eq!(removed["result"]["items"].as_array().unwrap().len(), 0);

        let list_path = dir.path().join("shopping-list.json");
        let before = fs::read(&list_path).unwrap();
        let missing_item_id = serde_json::json!({
            "id": "no-item-id",
            "auth": "secret",
            "command": SHOPPING_REMOVE_COMMAND,
            "payload": { "expectedRevision": 2 }
        });
        let rejected = process(
            missing_item_id.to_string().as_bytes(),
            &dir.path().to_path_buf(),
            Some("secret"),
        );
        assert_eq!(rejected["ok"], false);
        assert!(rejected["error"]
            .as_str()
            .unwrap()
            .contains("shopping_remove requires itemId"));
        assert_eq!(fs::read(&list_path).unwrap(), before);
    }
}
