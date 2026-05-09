//! Character management.
//!
//! A "character" bundles a Live2D model with a custom system prompt
//! that's prepended to every chat message sent to upstream zeroclaw.
//! The active character drives:
//!   - Which Live2D model the avatar canvas renders.
//!   - The persona zeroclaw responds as.
//!
//! Subagent (translation + expression detection) is NOT character-
//! scoped per the user's call ("subagent don't need to be changed").
//!
//! Storage: `companion.characters.json` next to companion.toml.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Character {
    pub id: String,
    pub name: String,
    /// Live2D model id (matches the directory name under
    /// `web/public/live2d/models/`). Empty string means "use the
    /// server default model from companion.toml".
    pub model_id: String,
    /// Verbatim text prepended to every user message before zeroclaw
    /// sees it. Empty string disables the prepend.
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CharactersFile {
    /// Id of the currently active character (empty = none active).
    pub active_id: String,
    pub characters: Vec<Character>,
}

/// Where the character roster lives — sibling of `companion.toml`.
pub fn characters_path(toml_path: &Path) -> PathBuf {
    let dir = toml_path.parent().unwrap_or_else(|| Path::new("."));
    dir.join("companion.characters.json")
}

/// Load the roster from disk. Returns Ok(default) if the file
/// doesn't exist yet (first run); errors only on read/parse failure.
pub fn load(path: &Path) -> std::io::Result<CharactersFile> {
    if !path.exists() {
        return Ok(CharactersFile::default());
    }
    let body = std::fs::read_to_string(path)?;
    serde_json::from_str(&body).map_err(std::io::Error::other)
}

pub fn save(path: &Path, file: &CharactersFile) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(file).map_err(std::io::Error::other)?;
    std::fs::write(path, body)
}

/// Look up the active character by id. Returns None if no character
/// is active or the active id doesn't match any entry.
pub fn active<'a>(file: &'a CharactersFile) -> Option<&'a Character> {
    if file.active_id.is_empty() {
        return None;
    }
    file.characters.iter().find(|c| c.id == file.active_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_round_trips() {
        let f = CharactersFile::default();
        let s = serde_json::to_string(&f).unwrap();
        let back: CharactersFile = serde_json::from_str(&s).unwrap();
        assert!(back.active_id.is_empty());
        assert!(back.characters.is_empty());
    }

    #[test]
    fn active_returns_match() {
        let f = CharactersFile {
            active_id: "asuna".into(),
            characters: vec![
                Character {
                    id: "asuna".into(),
                    name: "Asuna".into(),
                    model_id: "asuna".into(),
                    system_prompt: "You are Asuna.".into(),
                },
                Character {
                    id: "haru".into(),
                    name: "Haru".into(),
                    model_id: "haru".into(),
                    system_prompt: "You are Haru.".into(),
                },
            ],
        };
        let a = active(&f).unwrap();
        assert_eq!(a.id, "asuna");
        assert_eq!(a.system_prompt, "You are Asuna.");
    }

    #[test]
    fn no_active_returns_none() {
        let f = CharactersFile {
            active_id: "missing".into(),
            characters: vec![Character {
                id: "asuna".into(),
                name: "Asuna".into(),
                model_id: "asuna".into(),
                system_prompt: "".into(),
            }],
        };
        assert!(active(&f).is_none());
    }

    #[test]
    fn save_then_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("zc-char-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let toml_path = dir.join("companion.toml");
        let _ = std::fs::write(&toml_path, "");
        let path = characters_path(&toml_path);
        let original = CharactersFile {
            active_id: "asuna".into(),
            characters: vec![Character {
                id: "asuna".into(),
                name: "Asuna".into(),
                model_id: "asuna".into(),
                system_prompt: "Persona text.".into(),
            }],
        };
        save(&path, &original).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.active_id, "asuna");
        assert_eq!(back.characters.len(), 1);
        assert_eq!(back.characters[0].system_prompt, "Persona text.");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
