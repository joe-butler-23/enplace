use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

const CACHE_VERSION: &str = "v4";
const JPEG_QUALITY: u8 = 90;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thumbnail {
    pub path: PathBuf,
    pub version: String,
    pub extension: String,
    pub max_size_px: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceState {
    modified_nanos: String,
    byte_len: u64,
    #[serde(default)]
    unix_change_marker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThumbnailManifest {
    source: SourceState,
    content_hash: String,
    filename: String,
}

pub fn get_or_create_thumbnail(
    cache_root: &Path,
    original_path: &Path,
    max_size_px: u32,
) -> Result<Thumbnail, String> {
    prepare_thumbnail_variants(cache_root, original_path, &[max_size_px])
        .map(|mut thumbnails| thumbnails.remove(0))
}

pub fn get_or_create_thumbnails(
    cache_root: &Path,
    original_paths: &[PathBuf],
    max_size_px: u32,
) -> Vec<Result<Thumbnail, String>> {
    get_or_create_thumbnails_for_variants(cache_root, original_paths, &[max_size_px])
}

pub fn prepare_database_thumbnails(
    cache_root: &Path,
    original_paths: &[PathBuf],
) -> Vec<Result<Thumbnail, String>> {
    get_or_create_thumbnails_for_variants(cache_root, original_paths, &[320, 640])
}

fn get_or_create_thumbnails_for_variants(
    cache_root: &Path,
    original_paths: &[PathBuf],
    variants: &[u32],
) -> Vec<Result<Thumbnail, String>> {
    if original_paths.is_empty() {
        return Vec::new();
    }

    let mut unique_paths = Vec::<PathBuf>::new();
    let mut request_to_unique = Vec::with_capacity(original_paths.len());
    for original_path in original_paths {
        let existing = unique_paths
            .iter()
            .position(|candidate| candidate == original_path);
        let index = existing.unwrap_or_else(|| {
            unique_paths.push(original_path.clone());
            unique_paths.len() - 1
        });
        request_to_unique.push(index);
    }

    let worker_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(12)
        .min(unique_paths.len());
    let queue = Arc::new(Mutex::new(
        (0..unique_paths.len()).rev().collect::<Vec<_>>(),
    ));
    let results = Arc::new(Mutex::new(vec![None; unique_paths.len()]));
    let cache_root = cache_root.to_path_buf();
    let variants = variants.to_vec();

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let results = Arc::clone(&results);
            let cache_root = cache_root.clone();
            let unique_paths = &unique_paths;
            let variants = &variants;
            scope.spawn(move || loop {
                let Some(index) = queue.lock().expect("thumbnail queue poisoned").pop() else {
                    return;
                };
                let result =
                    prepare_thumbnail_variants(&cache_root, &unique_paths[index], &variants)
                        .map(|mut thumbnails| thumbnails.remove(0));
                results.lock().expect("thumbnail result store poisoned")[index] = Some(result);
            });
        }
    });

    let results = results.lock().expect("thumbnail result store poisoned");
    request_to_unique
        .into_iter()
        .map(|index| {
            results[index]
                .as_ref()
                .expect("thumbnail worker did not return a result")
                .clone()
        })
        .collect()
}

fn prepare_thumbnail_variants(
    cache_root: &Path,
    original_path: &Path,
    variants: &[u32],
) -> Result<Vec<Thumbnail>, String> {
    if variants.is_empty() || variants.iter().any(|size| *size == 0) {
        return Err("Thumbnail size must be positive".to_string());
    }

    let source = source_state(original_path)?;
    let thumbnails_dir = cache_root.join("thumbnails").join(CACHE_VERSION);
    let manifests_dir = thumbnails_dir.join("manifests");
    fs::create_dir_all(&manifests_dir).map_err(|error| error.to_string())?;
    let source_id = digest_hex(original_path.to_string_lossy().as_bytes());

    let mut cached = Vec::with_capacity(variants.len());
    let mut needs_content_check = false;
    for max_size_px in variants {
        let manifest_path = manifests_dir.join(format!("{}-{}.json", source_id, max_size_px));
        let manifest = load_manifest(&manifest_path);
        let thumbnail = manifest
            .as_ref()
            .and_then(|manifest| {
                let cached_path = thumbnails_dir.join(&manifest.filename);
                (manifest.source == source
                    && source.unix_change_marker.is_some()
                    && cached_path.is_file())
                .then(|| thumbnail_from_manifest(cached_path, manifest, *max_size_px))
            })
            .transpose()?;
        if thumbnail.is_none() {
            needs_content_check = true;
        }
        cached.push((manifest_path, manifest, thumbnail));
    }
    if !needs_content_check {
        return Ok(cached
            .into_iter()
            .map(|(_, _, thumbnail)| thumbnail.expect("cached thumbnail missing"))
            .collect());
    }

    let source_bytes = fs::read(original_path).map_err(|error| error.to_string())?;
    let content_hash = digest_hex(&source_bytes);
    let mut needs_decode = false;
    for (index, (_, manifest, thumbnail)) in cached.iter_mut().enumerate() {
        if thumbnail.is_some() {
            continue;
        }
        if let Some(manifest) = manifest {
            let cached_path = thumbnails_dir.join(&manifest.filename);
            if manifest.source == source
                && manifest.content_hash == content_hash
                && cached_path.is_file()
            {
                *thumbnail = Some(thumbnail_from_manifest(
                    cached_path,
                    manifest,
                    variants[index],
                )?);
                continue;
            }
        }
        needs_decode = true;
    }
    let decoded = needs_decode
        .then(|| image::load_from_memory(&source_bytes))
        .transpose()
        .map_err(|error| format!("Failed to open image: {error}"))?;
    let decoded = decoded.as_ref().expect("decoded image missing");
    let source_dimensions = (decoded.width(), decoded.height());
    let is_small_jpeg = matches!(
        image::guess_format(&source_bytes),
        Ok(image::ImageFormat::Jpeg)
    );
    let mut groups = BTreeMap::<(u32, u32), Vec<usize>>::new();
    for (index, (_, _, thumbnail)) in cached.iter().enumerate() {
        if thumbnail.is_none() {
            groups
                .entry(target_dimensions(source_dimensions, variants[index]))
                .or_default()
                .push(index);
        }
    }
    for (dimensions, indexes) in groups {
        let passthrough = is_small_jpeg && dimensions == source_dimensions;
        let encoded = (!passthrough)
            .then(|| encode_thumbnail(decoded, dimensions))
            .transpose()?;
        for index in indexes {
            let (manifest_path, manifest, thumbnail) = &mut cached[index];
            let max_size_px = variants[index];
            let extension = "jpg";
            let filename = format!(
                "{}-{}-{}.{}",
                CACHE_VERSION, max_size_px, content_hash, extension
            );
            let thumbnail_path = thumbnails_dir.join(&filename);
            if !thumbnail_path.is_file() {
                write_thumbnail_bytes(
                    &thumbnail_path,
                    encoded.as_deref().unwrap_or(&source_bytes),
                )?;
            }
            let previous_filename = manifest.as_ref().map(|manifest| manifest.filename.clone());
            let next_manifest = ThumbnailManifest {
                source: source.clone(),
                content_hash: content_hash.clone(),
                filename: filename.clone(),
            };
            write_manifest(manifest_path, &next_manifest)?;
            if let Some(previous_filename) =
                previous_filename.filter(|previous| previous != &filename)
            {
                if !manifest_references_filename(&manifests_dir, &previous_filename) {
                    let _ = fs::remove_file(thumbnails_dir.join(previous_filename));
                }
            }
            *thumbnail = Some(Thumbnail {
                path: thumbnail_path,
                version: filename
                    .trim_end_matches(&format!(".{extension}"))
                    .to_string(),
                extension: extension.to_string(),
                max_size_px,
            });
        }
    }
    Ok(cached
        .into_iter()
        .map(|(_, _, thumbnail)| thumbnail.expect("prepared thumbnail missing"))
        .collect())
}

fn source_state(path: &Path) -> Result<SourceState, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_nanos = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    Ok(SourceState {
        modified_nanos,
        byte_len: metadata.len(),
        unix_change_marker: unix_change_marker(&metadata),
    })
}

#[cfg(unix)]
fn unix_change_marker(metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!(
        "{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.ctime(),
        metadata.ctime_nsec()
    ))
}

#[cfg(not(unix))]
fn unix_change_marker(_: &fs::Metadata) -> Option<String> {
    None
}

fn thumbnail_from_manifest(
    cached_path: PathBuf,
    manifest: &ThumbnailManifest,
    max_size_px: u32,
) -> Result<Thumbnail, String> {
    let extension = cached_path
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| "Thumbnail cache file has no extension".to_string())?
        .to_string();
    Ok(Thumbnail {
        path: cached_path,
        version: manifest
            .filename
            .trim_end_matches(&format!(".{extension}"))
            .to_string(),
        extension,
        max_size_px,
    })
}

fn digest_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn load_manifest(path: &Path) -> Option<ThumbnailManifest> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(_) => None,
    }
}

fn manifest_references_filename(manifests_dir: &Path, filename: &str) -> bool {
    fs::read_dir(manifests_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| load_manifest(&entry.path()))
        .any(|manifest| manifest.filename == filename)
}

fn target_dimensions((width, height): (u32, u32), max_size_px: u32) -> (u32, u32) {
    if width <= max_size_px && height <= max_size_px {
        return (width, height);
    }
    if width >= height {
        (
            max_size_px,
            ((height as u64 * max_size_px as u64) / width as u64).max(1) as u32,
        )
    } else {
        (
            ((width as u64 * max_size_px as u64) / height as u64).max(1) as u32,
            max_size_px,
        )
    }
}

fn encode_thumbnail(
    image: &image::DynamicImage,
    (width, height): (u32, u32),
) -> Result<Vec<u8>, String> {
    let thumbnail = image.resize_exact(width, height, FilterType::CatmullRom);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
        .encode_image(&thumbnail)
        .map_err(|error| format!("Failed to encode thumbnail: {error}"))?;
    Ok(bytes)
}

fn write_thumbnail_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp_path = unique_temp_path(path);
    let result = (|| {
        let file = File::create_new(&temp_path)
            .map_err(|error| format!("Failed to create thumbnail file: {error}"))?;
        let mut writer = file;
        writer
            .write_all(bytes)
            .map_err(|error| format!("Failed to write thumbnail: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush thumbnail: {error}"))?;
        writer
            .sync_all()
            .map_err(|error| format!("Failed to sync thumbnail: {error}"))?;
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        if path.is_file() {
            return Ok(());
        }
        return Err(format!("Failed to finalize thumbnail: {error}"));
    }
    Ok(())
}

fn write_manifest(path: &Path, manifest: &ThumbnailManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|error| format!("Failed to serialize thumbnail manifest: {error}"))?;
    let temp_path = unique_temp_path(path);
    fs::write(&temp_path, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    Ok(())
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let extension = format!("tmp-{}-{sequence}", std::process::id());
    path.with_extension(extension)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, Rgb, RgbImage};
    use tempfile::tempdir;

    fn write_fixture(path: &Path, color: [u8; 3]) {
        let image = RgbImage::from_pixel(1200, 600, Rgb(color));
        DynamicImage::ImageRgb8(image).save(path).unwrap();
    }

    fn write_small_png(path: &Path) {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(256, 144, Rgb([10, 20, 30])))
            .save(path)
            .unwrap();
    }

    fn write_small_jpeg(path: &Path) {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(256, 144, Rgb([10, 20, 30])))
            .save_with_format(path, image::ImageFormat::Jpeg)
            .unwrap();
    }

    #[test]
    fn persists_card_and_detail_variants_at_the_requested_bounds() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.png");
        write_fixture(&source, [10, 20, 30]);

        let card = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        let detail = get_or_create_thumbnail(root.path(), &source, 640).unwrap();

        assert_ne!(card.path, detail.path);
        assert!(card.path.is_file());
        assert!(detail.path.is_file());
        let card_image = image::open(&card.path).unwrap();
        let detail_image = image::open(&detail.path).unwrap();
        assert_eq!(card_image.dimensions(), (320, 160));
        assert_eq!(detail_image.dimensions(), (640, 320));
    }

    #[test]
    fn database_batch_prepares_both_variants_once_per_unique_source_and_preserves_order() {
        let root = tempdir().unwrap();
        let first = root.path().join("first.png");
        let second = root.path().join("second.png");
        let missing = root.path().join("missing.png");
        write_fixture(&first, [10, 20, 30]);
        write_fixture(&second, [30, 20, 10]);

        let results = prepare_database_thumbnails(
            root.path(),
            &[first.clone(), missing, first.clone(), second.clone()],
        );
        assert_eq!(results.len(), 4);
        assert!(results[0].is_ok());
        assert!(results[1].is_err());
        assert_eq!(results[0].as_ref().unwrap(), results[2].as_ref().unwrap());
        for source in [&first, &second] {
            let source_id = digest_hex(source.to_string_lossy().as_bytes());
            for size in [320, 640] {
                let manifest = root
                    .path()
                    .join("thumbnails")
                    .join(CACHE_VERSION)
                    .join("manifests")
                    .join(format!("{source_id}-{size}.json"));
                assert!(manifest.is_file());
            }
        }
        let second_run = prepare_database_thumbnails(root.path(), &[first.clone(), second]);
        assert_eq!(
            second_run[0].as_ref().unwrap(),
            results[0].as_ref().unwrap()
        );
    }

    #[test]
    fn database_batch_encodes_a_small_png_once_for_identical_bounds() {
        let root = tempdir().unwrap();
        let source = root.path().join("small.png");
        write_small_png(&source);

        let card = prepare_database_thumbnails(root.path(), &[source.clone()])
            .remove(0)
            .unwrap();

        assert_eq!(image::open(&card.path).unwrap().dimensions(), (256, 144));
        let source_id = digest_hex(source.to_string_lossy().as_bytes());
        let manifest = load_manifest(
            &root
                .path()
                .join("thumbnails")
                .join(CACHE_VERSION)
                .join("manifests")
                .join(format!("{source_id}-640.json")),
        )
        .unwrap();
        let detail_path = root
            .path()
            .join("thumbnails")
            .join(CACHE_VERSION)
            .join(manifest.filename);
        assert_eq!(image::open(&detail_path).unwrap().dimensions(), (256, 144));
        assert_eq!(fs::read(card.path).unwrap(), fs::read(detail_path).unwrap());
    }

    #[test]
    fn database_batch_preserves_small_jpeg_bytes_without_encoding() {
        let root = tempdir().unwrap();
        let source = root.path().join("small.jpg");
        write_small_jpeg(&source);
        let original = fs::read(&source).unwrap();

        prepare_database_thumbnails(root.path(), &[source.clone()])
            .remove(0)
            .unwrap();
        let source_id = digest_hex(source.to_string_lossy().as_bytes());
        for size in [320, 640] {
            let manifest = load_manifest(
                &root
                    .path()
                    .join("thumbnails")
                    .join(CACHE_VERSION)
                    .join("manifests")
                    .join(format!("{source_id}-{size}.json")),
            )
            .unwrap();
            assert_eq!(
                fs::read(
                    root.path()
                        .join("thumbnails")
                        .join(CACHE_VERSION)
                        .join(manifest.filename)
                )
                .unwrap(),
                original
            );
        }
    }

    #[test]
    fn database_batch_encodes_large_variants_at_distinct_bounds() {
        let root = tempdir().unwrap();
        let source = root.path().join("large.png");
        write_fixture(&source, [10, 20, 30]);

        prepare_database_thumbnails(root.path(), &[source.clone()])
            .remove(0)
            .unwrap();
        let source_id = digest_hex(source.to_string_lossy().as_bytes());
        for (size, dimensions) in [(320, (320, 160)), (640, (640, 320))] {
            let manifest = load_manifest(
                &root
                    .path()
                    .join("thumbnails")
                    .join(CACHE_VERSION)
                    .join("manifests")
                    .join(format!("{source_id}-{size}.json")),
            )
            .unwrap();
            assert_eq!(
                image::open(
                    root.path()
                        .join("thumbnails")
                        .join(CACHE_VERSION)
                        .join(manifest.filename)
                )
                .unwrap()
                .dimensions(),
                dimensions
            );
        }
    }

    #[test]
    fn reuses_unchanged_source_and_versions_changed_content() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.png");
        write_fixture(&source, [10, 20, 30]);
        let first = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        let second = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        assert_eq!(first, second);

        std::thread::sleep(std::time::Duration::from_millis(2));
        write_fixture(&source, [30, 20, 10]);
        let changed = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        assert_ne!(first.version, changed.version);
        assert!(!first.path.exists());
        assert!(changed.path.is_file());
    }

    #[test]
    fn content_hash_rejects_a_stale_manifest_even_when_its_source_state_matches() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.png");
        write_fixture(&source, [10, 20, 30]);
        let first = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        write_fixture(&source, [30, 20, 10]);

        let manifest_path = root
            .path()
            .join("thumbnails")
            .join(CACHE_VERSION)
            .join("manifests")
            .join(format!(
                "{}-320.json",
                digest_hex(source.to_string_lossy().as_bytes())
            ));
        let mut manifest = load_manifest(&manifest_path).unwrap();
        manifest.source = source_state(&source).unwrap();
        manifest.source.unix_change_marker = None;
        write_manifest(&manifest_path, &manifest).unwrap();

        let changed = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        assert_ne!(first.version, changed.version);
    }

    #[test]
    fn corrupt_manifest_self_heals() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.png");
        write_fixture(&source, [10, 20, 30]);
        let first = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        let manifest_path = root
            .path()
            .join("thumbnails")
            .join(CACHE_VERSION)
            .join("manifests")
            .join(format!(
                "{}-320.json",
                digest_hex(source.to_string_lossy().as_bytes())
            ));
        fs::write(&manifest_path, b"not-json").unwrap();

        let healed = get_or_create_thumbnail(root.path(), &source, 320).unwrap();
        assert_eq!(first.version, healed.version);
        assert!(load_manifest(&manifest_path).is_some());
    }

    #[test]
    fn cleanup_keeps_a_shared_content_thumbnail_referenced_by_another_source() {
        let root = tempdir().unwrap();
        let first_source = root.path().join("first.png");
        let second_source = root.path().join("second.png");
        write_fixture(&first_source, [10, 20, 30]);
        write_fixture(&second_source, [10, 20, 30]);
        let first = get_or_create_thumbnail(root.path(), &first_source, 320).unwrap();
        let second = get_or_create_thumbnail(root.path(), &second_source, 320).unwrap();
        assert_eq!(first.path, second.path);

        write_fixture(&first_source, [30, 20, 10]);
        let changed = get_or_create_thumbnail(root.path(), &first_source, 320).unwrap();
        assert_ne!(changed.path, second.path);
        assert!(second.path.is_file());
    }

    #[test]
    fn concurrent_requests_publish_one_valid_thumbnail() {
        let root = tempdir().unwrap();
        let source = root.path().join("source.png");
        write_fixture(&source, [10, 20, 30]);
        let cache_root = root.path().to_path_buf();
        let source_path = source.clone();
        let first =
            std::thread::spawn(move || get_or_create_thumbnail(&cache_root, &source_path, 320));
        let cache_root = root.path().to_path_buf();
        let second = std::thread::spawn(move || get_or_create_thumbnail(&cache_root, &source, 320));
        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first.path, second.path);
        assert_eq!(image::open(first.path).unwrap().dimensions(), (320, 160));
    }

    #[test]
    fn batch_preserves_order_deduplicates_sources_and_keeps_per_source_errors() {
        let root = tempdir().unwrap();
        let first = root.path().join("first.png");
        let second = root.path().join("second.png");
        let missing = root.path().join("missing.png");
        write_fixture(&first, [10, 20, 30]);
        write_fixture(&second, [30, 20, 10]);

        let results =
            get_or_create_thumbnails(root.path(), &[first.clone(), missing, first, second], 320);
        assert_eq!(results.len(), 4);
        assert_eq!(
            results[0].as_ref().unwrap().path,
            results[2].as_ref().unwrap().path
        );
        assert!(results[1].is_err());
        assert_ne!(
            results[0].as_ref().unwrap().path,
            results[3].as_ref().unwrap().path
        );
    }
}
