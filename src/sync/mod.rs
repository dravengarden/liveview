//! `liveview sync` — the git-driven incremental content deploy.
//!
//! Pure pieces land first (the Merkle DAG + reconcile planner); the CLI
//! wiring, postgres/rustfs application, and HTML rendering are added in a later
//! step. Until the `sync` subcommand is wired into the CLI the module stands
//! alone (exercised by its own tests), hence the crate-local `dead_code`
//! allowance.
#![allow(dead_code)]

pub mod diff;
pub mod merkle;
pub mod objstore;
pub mod run;
