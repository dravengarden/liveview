use comrak::{markdown_to_html, Options};

use crate::shared::FileType;

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
        | FileType::Typst => source.to_string(),
        // Binary types should not reach here
        FileType::Image | FileType::Pdf | FileType::Unknown => source.to_string(),
    }
}

/// Render markdown source to HTML.
pub fn render_markdown(source: &str) -> String {
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

    markdown_to_html(source, &options)
}
