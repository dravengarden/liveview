use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
    /// Per-language display titles (lang code → title), set only for
    /// `book.toml` spine chapters whose title is each edition's H1 and thus
    /// varies by language. The sidebar picks `titles[currentLang]`, falling
    /// back to `name` (the default edition's title) when an edition lacks the
    /// page. `None`/omitted for plain file-tree nodes, whose `name` is the
    /// language-independent filename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titles: Option<std::collections::HashMap<String, String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Markdown,
    Image,
    Pdf,
    Html,
    Csv,
    Json,
    Excalidraw,
    Latex,
    Typst,
    Unknown,
}

impl FileType {
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            "md" | "markdown" => FileType::Markdown,
            "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "avif" | "bmp" | "ico" | "tiff"
            | "tif" => FileType::Image,
            "pdf" => FileType::Pdf,
            "html" | "htm" => FileType::Html,
            "csv" | "tsv" => FileType::Csv,
            "json" | "jsonc" | "json5" => FileType::Json,
            "excalidraw" => FileType::Excalidraw,
            "tex" | "latex" => FileType::Latex,
            "typ" | "typst" => FileType::Typst,
            _ => FileType::Unknown,
        }
    }

    pub fn from_path(path: &str) -> Self {
        std::path::Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(Self::from_extension)
            .unwrap_or(FileType::Unknown)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    /// Language edition actually served. May differ from the requested `lang`
    /// when the page is missing in that edition and the base was used instead
    /// (overlay → base fallback); the frontend shows an "untranslated" notice.
    pub lang: String,
    pub file_type: FileType,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
// The `*Update` suffix is the wire contract (the serde `type` tag the SPA
// matches on); renaming the variants to satisfy this lint would break the
// protocol. Pre-existing; scoped allow keeps `clippy --all-targets` green.
#[allow(clippy::enum_variant_names)]
pub enum WsMessage {
    ContentUpdate {
        path: String,
        /// Language edition the changed file belongs to. The frontend only
        /// applies the update if it is currently viewing this (path, lang).
        lang: String,
        file_type: FileType,
        content: String,
    },
    TreeUpdate {
        tree: Vec<TreeNode>,
    },
    /// A single `/api/settings` key changed (any client's PUT). Broadcast so the
    /// state-based `mirroredStore`s (audio rate/pos/session/active-player, …)
    /// re-reconcile live cross-device instead of only on the next page load.
    SettingUpdate {
        key: String,
        value: String,
    },
}
