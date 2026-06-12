//! Postgres content store for the deployed (filesystem-free) server and the
//! incremental `liveview sync`. Runtime-checked sqlx queries only — the Nix
//! build never needs a live `DATABASE_URL`.
//!
//! Wired into the server read-path in Phase F; until then the module stands
//! alone (exercised by its own tests + `liveview sync`), hence the temporary
//! crate-local `dead_code` allowance.
#![allow(dead_code)]

pub mod content;
pub mod fs;
pub mod pg;
