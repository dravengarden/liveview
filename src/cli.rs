use clap::Parser;
use std::path::PathBuf;

/// lv - LiveView
///
/// Watch and preview various file formats with live-reloading in your browser.
#[derive(Parser, Debug, Clone)]
#[command(name = "lv", version, about, long_about = None)]
pub struct Cli {
    /// Path to watch (file or directory)
    #[arg(default_value = ".")]
    pub path: PathBuf,

    /// Port to serve on (auto-selects from 4159 if not specified and port is in use)
    #[arg(short, long)]
    pub port: Option<u16>,

    /// Host address to bind to
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// File patterns to include (glob syntax, can be specified multiple times)
    #[arg(short = 'I', long)]
    pub include: Vec<String>,

    /// File/directory patterns to exclude (glob syntax, added to defaults)
    #[arg(short = 'E', long)]
    pub exclude: Vec<String>,

    /// Open browser automatically after starting the server
    #[arg(short, long)]
    pub open: bool,

    /// Debounce interval in milliseconds for file change detection
    #[arg(long, default_value_t = 200)]
    pub debounce_ms: u64,

    /// Enable verbose logging
    #[arg(short, long)]
    pub verbose: bool,
}

impl Cli {
    pub fn effective_includes(&self) -> Vec<String> {
        if self.include.is_empty() {
            vec![
                // Markdown
                "**/*.md".to_string(),
                "**/*.markdown".to_string(),
                // Images
                "**/*.png".to_string(),
                "**/*.jpg".to_string(),
                "**/*.jpeg".to_string(),
                "**/*.gif".to_string(),
                "**/*.svg".to_string(),
                "**/*.webp".to_string(),
                "**/*.avif".to_string(),
                "**/*.bmp".to_string(),
                "**/*.ico".to_string(),
                "**/*.tiff".to_string(),
                "**/*.tif".to_string(),
                // Documents
                "**/*.pdf".to_string(),
                "**/*.html".to_string(),
                "**/*.htm".to_string(),
                // Data
                "**/*.csv".to_string(),
                "**/*.tsv".to_string(),
                "**/*.json".to_string(),
                "**/*.jsonc".to_string(),
                "**/*.json5".to_string(),
                // Drawings
                "**/*.excalidraw".to_string(),
                // Typesetting
                "**/*.tex".to_string(),
                "**/*.latex".to_string(),
                "**/*.typ".to_string(),
                "**/*.typst".to_string(),
            ]
        } else {
            self.include.clone()
        }
    }

    pub fn effective_excludes(&self) -> Vec<String> {
        let mut excludes = vec![
            "**/.git/**".to_string(),
            "**/.git".to_string(),
            "**/node_modules/**".to_string(),
            "**/target/**".to_string(),
            "**/__pycache__/**".to_string(),
            "**/.DS_Store".to_string(),
            "**/vendor/**".to_string(),
            "**/.venv/**".to_string(),
            "**/.dioxus/**".to_string(),
        ];
        excludes.extend(self.exclude.clone());
        excludes
    }
}
