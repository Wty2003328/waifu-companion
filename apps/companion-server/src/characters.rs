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
    /// Inline markdown notes (lore, scenario, speech style). Edited
    /// in the Characters page UI. Appended to `system_prompt` when
    /// composing the persona payload to zeroclaw. Empty string ignored.
    pub notes: String,
}

/// Per-character on-disk markdown directory:
/// `<config-dir>/characters/<character-id>/`. Every `*.md` file in
/// there is loaded on every chat turn and included in the persona
/// payload — gives the user a place to drop knowledge-base / lorebook
/// files they edit in their own editor without going through the UI.
pub fn character_dir(toml_path: &Path, char_id: &str) -> PathBuf {
    let dir = toml_path.parent().unwrap_or_else(|| Path::new("."));
    dir.join("characters").join(char_id)
}

/// Read the on-disk markdown attachments for a character (if any).
/// Returns `(filename, body)` pairs sorted by filename so the order
/// is stable across runs. Missing dir is not an error — the user can
/// just have inline notes and no attachments.
pub fn read_attachments(toml_path: &Path, char_id: &str) -> Vec<(String, String)> {
    let dir = character_dir(toml_path, char_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("md"))
            == Some(true)
            && let (Some(name), Ok(body)) = (
                path.file_name().and_then(|s| s.to_str()).map(String::from),
                std::fs::read_to_string(&path),
            ) {
                out.push((name, body));
            }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Build the full persona-prefix string we hand to zeroclaw before
/// the user's message. Combines `system_prompt`, inline `notes`, and
/// every on-disk markdown attachment. Returns empty string if all
/// three are empty (in which case main.rs skips the prepend entirely).
pub fn compose_persona_prefix(toml_path: &Path, c: &Character) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !c.system_prompt.trim().is_empty() {
        parts.push(c.system_prompt.trim().to_string());
    }
    if !c.notes.trim().is_empty() {
        parts.push(format!("# Notes\n{}", c.notes.trim()));
    }
    for (name, body) in read_attachments(toml_path, &c.id) {
        if body.trim().is_empty() {
            continue;
        }
        parts.push(format!("# {name}\n{}", body.trim()));
    }
    parts.join("\n\n")
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
pub fn active(file: &CharactersFile) -> Option<&Character> {
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
                    notes: String::new(),
                },
                Character {
                    id: "haru".into(),
                    name: "Haru".into(),
                    model_id: "haru".into(),
                    system_prompt: "You are Haru.".into(),
                    notes: String::new(),
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
                notes: String::new(),
            }],
        };
        assert!(active(&f).is_none());
    }

    #[test]
    fn compose_persona_prefix_combines_prompt_notes_and_files() {
        let dir = std::env::temp_dir().join(format!("zc-char-attach-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        let toml_path = dir.join("companion.toml");
        let _ = std::fs::write(&toml_path, "");
        let char_dir = character_dir(&toml_path, "asuna");
        std::fs::create_dir_all(&char_dir).unwrap();
        std::fs::write(char_dir.join("a_lore.md"), "Lore content.").unwrap();
        std::fs::write(char_dir.join("b_style.md"), "Style content.").unwrap();
        // Non-md files are ignored.
        std::fs::write(char_dir.join("ignore.txt"), "junk").unwrap();

        let c = Character {
            id: "asuna".into(),
            name: "Asuna".into(),
            model_id: "asuna".into(),
            system_prompt: "You are Asuna.".into(),
            notes: "Speak softly.".into(),
        };
        let prefix = compose_persona_prefix(&toml_path, &c);
        // Prompt first, then notes, then attachments alphabetical.
        assert!(prefix.starts_with("You are Asuna."));
        assert!(prefix.contains("# Notes\nSpeak softly."));
        assert!(prefix.contains("# a_lore.md\nLore content."));
        assert!(prefix.contains("# b_style.md\nStyle content."));
        // Order check: a_lore comes before b_style.
        assert!(prefix.find("a_lore.md").unwrap() < prefix.find("b_style.md").unwrap());
        // .txt was ignored.
        assert!(!prefix.contains("ignore.txt"));
        // Empty inputs collapse to empty.
        let empty = Character::default();
        assert_eq!(compose_persona_prefix(&toml_path, &empty), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn uuid_like() -> String {
        // Avoid pulling uuid into server tests just for a temp-dir suffix.
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{}", std::process::id(), n)
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
                notes: "Inline notes".into(),
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
