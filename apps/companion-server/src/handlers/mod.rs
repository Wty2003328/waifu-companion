//! HTTP request handlers, grouped by resource.
//!
//! Each module exposes `pub` handler functions; `main.rs` wires them
//! into the axum router. The `AppState` they share lives in
//! [`crate::state`].

pub mod characters;
pub mod chat;
pub mod config;
pub mod health;
