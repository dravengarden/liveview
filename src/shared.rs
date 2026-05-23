use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
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
    pub file_type: FileType,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    ContentUpdate {
        path: String,
        file_type: FileType,
        content: String,
    },
    TreeUpdate {
        tree: Vec<TreeNode>,
    },
}
