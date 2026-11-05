//! Content transformations shared by the server, `liveview sync` and
//! `liveview check`: Markdown rendering, the sidebar tree, speakable text and
//! units, and narration overrides. No I/O beyond reading source files.

pub mod narration;
pub mod renderer;
pub mod speakable;
pub mod spoken;
pub mod tree;
