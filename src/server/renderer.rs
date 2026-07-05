use comrak::{markdown_to_html, Options};

use crate::shared::FileType;

/// The single source of truth for how we parse/render Markdown.
///
/// Why a shared builder: the `check` subcommand parses with the *exact same*
/// options as the server renders with, so a clean check matches what actually
/// renders (a footnote/link/table that comrak resolves here is one the checker
/// won't flag, and vice-versa). Keep every extension/render flag here — never
/// re-derive options in the checker or the two will silently diverge.
pub fn markdown_options() -> Options<'static> {
    let mut options = Options::default();

    // GFM extensions
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;

    // Additional extensions
    options.extension.header_ids = Some(String::new());
    options.extension.description_lists = true;
    options.extension.multiline_block_quotes = true;

    // Enable math delimiters for KaTeX
    options.extension.math_dollars = true;
    options.extension.math_code = true;

    // Render options
    options.render.unsafe_ = true;
    options.render.github_pre_lang = true;
    options.render.full_info_string = true;

    options
}

/// Render file content based on file type.
pub fn render_file(source: &str, file_type: &FileType) -> String {
    match file_type {
        FileType::Markdown => render_markdown(source),
        // For these types, frontend handles rendering, just return raw content
        FileType::Html
        | FileType::Csv
        | FileType::Json
        | FileType::Excalidraw
        | FileType::Latex
        | FileType::Typst
        // Interactive View is rendered entirely client-side (reactive kernel +
        // chart renderer); the server serves the raw JSON document verbatim.
        | FileType::InteractiveView => source.to_string(),
        // Binary types should not reach here
        FileType::Image | FileType::Pdf | FileType::Unknown => source.to_string(),
    }
}

/// Render markdown source to HTML.
///
/// `render.sourcepos` is enabled so every block element carries
/// `data-sourcepos="startline:col-endline:col"` — the STABLE anchor the
/// read-along highlight maps each spoken unit to (`Unit::line`), instead of the
/// client counting `body.children` (which desyncs when one source block renders
/// to ≠ 1 top-level element, e.g. a multi-part inline `<svg>`). Anchoring by id
/// is position-independent: a block with no wrapper (raw HTML) simply has no
/// anchor and is skipped, without shifting any other block. See
/// `docs/design/read-aloud-narration.md`.
pub fn render_markdown(source: &str) -> String {
    let mut options = markdown_options();
    options.render.sourcepos = true;
    markdown_to_html(source, &options)
}
