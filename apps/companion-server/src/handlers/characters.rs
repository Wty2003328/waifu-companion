//! HTTP handlers for the character roster + per-character markdown
//! attachments.
//!
//! The roster's *storage* layer lives in [`crate::characters`]; this
//! module is the thin axum binding over it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::characters;
use crate::state::AppState;

pub async fn handle_list_characters(
    State(state): State<AppState>,
) -> axum::response::Result<Json<characters::CharactersFile>, (StatusCode, String)> {
    let path = characters::characters_path(&state.config_path);
    characters::load(&path)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn handle_upsert_character(
    State(state): State<AppState>,
    Json(req): Json<characters::Character>,
) -> axum::response::Result<StatusCode, (StatusCode, String)> {
    if req.id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "id required".into()));
    }
    let path = characters::characters_path(&state.config_path);
    let mut file = characters::load(&path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(existing) = file.characters.iter_mut().find(|c| c.id == req.id) {
        *existing = req;
    } else {
        file.characters.push(req);
    }
    characters::save(&path, &file)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

#[derive(serde::Deserialize)]
pub struct ActivateCharacterReq {
    id: String,
}

pub async fn handle_set_active_character(
    State(state): State<AppState>,
    Json(req): Json<ActivateCharacterReq>,
) -> axum::response::Result<StatusCode, (StatusCode, String)> {
    let path = characters::characters_path(&state.config_path);
    let mut file = characters::load(&path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Empty id allowed — clears active.
    if !req.id.is_empty() && !file.characters.iter().any(|c| c.id == req.id) {
        return Err((
            StatusCode::NOT_FOUND,
            format!("no character with id {}", req.id),
        ));
    }
    file.active_id = req.id;
    characters::save(&path, &file)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

pub async fn handle_delete_character(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Result<StatusCode, (StatusCode, String)> {
    let path = characters::characters_path(&state.config_path);
    let mut file = characters::load(&path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let before = file.characters.len();
    file.characters.retain(|c| c.id != id);
    if file.characters.len() == before {
        return Err((
            StatusCode::NOT_FOUND,
            format!("no character with id {id}"),
        ));
    }
    if file.active_id == id {
        file.active_id.clear();
    }
    characters::save(&path, &file)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── Character attachments ────────────────────────────────────────
//
// On-disk markdown bundle per character. Lives at
// `<config-dir>/characters/<id>/*.md` and is loaded on every chat
// turn. The user can edit either through the Characters page UI
// (these endpoints) or directly with their own editor — both produce
// the same file on disk so changes round-trip cleanly.

pub async fn handle_list_character_attachments(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // We don't validate `id` against the roster — listing a non-existent
    // character's dir is harmless (returns []), and lets the UI render
    // the section before save.
    let attachments = characters::read_attachments(&state.config_path, &id);
    let shaped: Vec<_> = attachments
        .into_iter()
        .map(|(name, body)| {
            serde_json::json!({
                "name": name,
                "size": body.len(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "attachments": shaped })))
}

pub async fn handle_get_character_attachment(
    State(state): State<AppState>,
    Path((id, file)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if !attachment_filename_ok(&file) {
        return Err((
            StatusCode::BAD_REQUEST,
            "attachment name must be a single .md filename, no slashes / dots".into(),
        ));
    }
    let path = characters::character_dir(&state.config_path, &id).join(&file);
    let body = std::fs::read_to_string(&path)
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(Json(serde_json::json!({ "name": file, "body": body })))
}

#[derive(serde::Deserialize)]
pub struct PutAttachmentReq {
    body: String,
}

pub async fn handle_put_character_attachment(
    State(state): State<AppState>,
    Path((id, file)): Path<(String, String)>,
    Json(req): Json<PutAttachmentReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !attachment_filename_ok(&file) {
        return Err((
            StatusCode::BAD_REQUEST,
            "attachment name must be a single .md filename, no slashes / dots".into(),
        ));
    }
    let dir = characters::character_dir(&state.config_path, &id);
    std::fs::create_dir_all(&dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("create dir: {e}"),
        )
    })?;
    let path = dir.join(&file);
    std::fs::write(&path, req.body).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {}: {e}", path.display()),
        )
    })?;
    Ok(StatusCode::OK)
}

pub async fn handle_delete_character_attachment(
    State(state): State<AppState>,
    Path((id, file)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !attachment_filename_ok(&file) {
        return Err((
            StatusCode::BAD_REQUEST,
            "attachment name must be a single .md filename, no slashes / dots".into(),
        ));
    }
    let path = characters::character_dir(&state.config_path, &id).join(&file);
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(StatusCode::OK),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StatusCode::OK),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// Reject anything that isn't a single safe `*.md` filename. We refuse
/// path separators and `..` so a malicious file name can't escape the
/// per-character directory.
fn attachment_filename_ok(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.to_ascii_lowercase().ends_with(".md")
}
