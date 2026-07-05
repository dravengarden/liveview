//! Interactive View — sound, mobile-first interactive charts & widgets.
//!
//! This module holds the IR (`model`) and the `derived` expression language
//! (`expr`). The soundness checker that consumes them lives at
//! `crate::check::interactive_view`; the web renderer mirrors `model`. See
//! `docs/design/interactive-view.md` for the full design and the two guarantees
//! (deploy-time soundness vs runtime resilience).
//!
//! `allow(dead_code)`: the IR is the **wire contract** the web renderer (and the
//! Phase-2 chart pass) consume. Many fields (`vega`, widget `min`/`max`/`step`,
//! `format`, `audio`, …) are deserialized and carried to the client but not read
//! by *this* binary yet — they are load-bearing for the renderer, not dead.
#![allow(dead_code)]

pub mod expr;
pub mod model;
