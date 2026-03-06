# Mermaid Diagrams

Testing mermaid.js rendering for various diagram types.

## Flowchart

```mermaid
graph TD
    A[Start lv] --> B{Parse CLI args}
    B -->|Valid| C[Scan directory]
    B -->|Invalid| X[Show help & exit]
    C --> D[Build file tree]
    D --> E[Start file watcher]
    E --> F[Start web server]
    F --> G[Serve SSR + WASM]
    G --> H{File changed?}
    H -->|Yes| I[Re-render markdown]
    I --> J[Broadcast via WebSocket]
    J --> K[Browser updates live]
    K --> H
    H -->|No| H
```

## Sequence Diagram

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server
    participant W as File Watcher
    participant F as Filesystem

    B->>S: GET / (initial page load)
    S->>B: SSR HTML + WASM
    B->>S: WebSocket connect /ws

    Note over B,S: Live connection established

    F->>W: File modified event
    W->>S: Debounced change notification
    S->>S: Re-render markdown (comrak)
    S->>B: WebSocket: ContentUpdate
    B->>B: Update DOM + re-highlight
```

## Class Diagram

```mermaid
classDiagram
    class AppState {
        +PathBuf canonical_root
        +GlobSet include_set
        +GlobSet exclude_set
        +RwLock~Vec~TreeNode~~ file_tree
        +RwLock~HashMap~ rendered_cache
        +broadcast::Sender tx
    }

    class TreeNode {
        +String name
        +String path
        +bool is_dir
        +Vec~TreeNode~ children
    }

    class WsMessage {
        <<enumeration>>
        ContentUpdate
        TreeUpdate
    }

    AppState --> TreeNode : contains
    AppState --> WsMessage : broadcasts
```

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Watching : start_watcher()
    Watching --> Debouncing : file event
    Debouncing --> Processing : debounce timeout
    Processing --> Rendering : content change
    Processing --> TreeUpdate : structure change
    Rendering --> Broadcasting : render complete
    TreeUpdate --> Broadcasting : tree rebuilt
    Broadcasting --> Watching : message sent
    Watching --> [*] : shutdown
```

## Gantt Chart

```mermaid
gantt
    title lv Development Timeline
    dateFormat YYYY-MM-DD

    section Core
    CLI parsing          :done, cli, 2024-01-01, 1d
    File watcher         :done, watch, after cli, 2d
    Markdown renderer    :done, render, after cli, 1d

    section Web
    Dioxus SSR setup     :done, ssr, after render, 2d
    WebSocket server     :done, ws, after ssr, 1d
    WASM client          :done, wasm, after ssr, 2d

    section UI
    Sidebar file tree    :done, tree, after wasm, 1d
    Markdown viewer      :done, viewer, after wasm, 1d
    Syntax highlighting  :done, hl, after viewer, 1d
    Mermaid integration  :done, merm, after viewer, 1d
```

## Pie Chart

```mermaid
pie title lv Dependencies by Category
    "Dioxus (UI framework)" : 35
    "Axum (HTTP/WS)" : 20
    "Comrak (Markdown)" : 15
    "Notify (File watching)" : 10
    "Serde (Serialization)" : 10
    "Other" : 10
```

## Entity Relationship

```mermaid
erDiagram
    PROJECT ||--o{ MARKDOWN_FILE : contains
    MARKDOWN_FILE {
        string path
        string name
        datetime modified
        string content
    }
    PROJECT {
        string root_path
        string[] include_patterns
        string[] exclude_patterns
    }
    MARKDOWN_FILE ||--|| RENDERED_HTML : "renders to"
    RENDERED_HTML {
        string html
        datetime rendered_at
    }
```
