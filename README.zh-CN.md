<p align="right">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://dravengarden.github.io/liveview/">
    <img src="web/public/brand-mark.svg" width="112" height="112" alt="LiveView —— Living Book 标志">
  </a>
</p>

<h1 align="center">LiveView</h1>

<p align="center">
  <strong>让技术书鲜活起来。</strong><br>
  面向 Markdown 书籍与技术文档的自托管书库——适合深入阅读、自然收听，并能经过校验后离线保存。
</p>

<p align="center">
  <a href="https://dravengarden.github.io/liveview/"><img src="https://img.shields.io/badge/website-live-AE8DDE?style=flat-square" alt="LiveView 官网"></a>
  <a href="https://github.com/dravengarden/liveview/actions/workflows/pages.yml"><img src="https://github.com/dravengarden/liveview/actions/workflows/pages.yml/badge.svg" alt="官网部署"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-754B86?style=flat-square" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/Rust-1.95-F0A51F?style=flat-square" alt="Rust 1.95">
  <img src="https://img.shields.io/badge/Web_·_PWA_·_iOS_·_macOS-19376D?style=flat-square" alt="Web、PWA、iOS 与 macOS">
</p>

<p align="center">
  <a href="https://dravengarden.github.io/liveview/"><strong>官网</strong></a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#创建书库">编写内容</a>
  · <a href="#架构">架构</a>
  · <a href="docs/INDEX.md">文档</a>
  · <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <a href="https://dravengarden.github.io/liveview/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="website/assets/art/liveview-hero-dark.svg">
      <img src="website/assets/art/liveview-hero-light.svg" alt="抽象的 LiveView 桌面书架，以及正在朗读并高亮句子、显示图表和音频播放器的手机阅读器" width="1100">
    </picture>
  </a>
</p>

<p align="center"><sub>写一次。在任意屏幕上阅读、收听、探索——在线或离线。</sub></p>

LiveView 把一个包含 Markdown、技术资源、译本和音频的目录变成精致的自托管书库。
本地预览、发布检查、响应式网页阅读器和原生离线客户端共用同一套渲染契约。
本地起步无需数据库或对象存储；只有当书库需要持久发布、可校验的离线访问和后台
音频时，再加入 PostgreSQL、S3 兼容存储、增量 Merkle 同步和原生外壳。

> [!NOTE]
> LiveView 尚未到 1.0，以默认分支持续开发。内容模型目前已可使用，CLI 与协议
> 细节仍可能演进。安全修复只针对最新版本，不维护多条发布线。

## 为什么选择 LiveView

大多数 Markdown 工具止步于渲染单个文档。LiveView 把整个书库当作一份出版物：

- **一套内容契约** —— 预览、检查、发布与阅读使用相同的解析规则。
- **是书，而不是文件列表** —— 封面、章节、合集、阅读进度与继续阅读状态都是一等公民。
- **天生多语言** —— 各语言版本共享身份与阅读位置，并可有意地回退到默认语言。
- **阅读与收听平等** —— 文本、有声书、句级时间轴，以及非散文资源的朗读方式都在同一个内容模型中。
- **技术格式保持原生** —— Mermaid、公式、SVG、Typst、Excalidraw、JSON、CSV、
  HTML、图片、PDF 与交互视图都保留其语义。
- **离线数据可校验** —— 封面、背景图、文本、文档与音频都是内容寻址的 Merkle DAG
  资源，而不是按 URL 缓存的旁路数据。
- **增量发布** —— 同步只调和变化的内容，而不是重建整个书库。
- **基础设施属于你** —— 源文件、数据库、对象存储与分发都由你自托管。

不可妥协的交互、离线、生命周期与可移植性保证记录在[核心需求](docs/core-requirements.md)中。

## 每块屏幕，完整深度

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/assets/art/liveview-mobile-dark.svg">
    <img src="website/assets/art/liveview-mobile-light.svg" alt="三个抽象的 LiveView 手机界面：带进度的书架、带滑块和指标的交互图表、高亮当前句子的有声书播放器" width="960">
  </picture>
</p>

- **发现** —— 信息密集、可搜索的书架，包含合集、语言版本、封面，以及相互独立的阅读与收听进度。
- **探索** —— 信号、控件、计算指标与响应式图表保持可交互，而不是被压平成图片。
- **收听** —— 原生播放，支持逐句高亮、拖动、变速与章节控制，原生外壳中还支持锁屏控制。

桌面端展示书库结构与并行导航；手机端单列、触控优先，且不简化内容。两者读取同一份出版物。

## 从这里开始

| 目标 | 入口 | 基础设施 |
|---|---|---|
| 在本地预览一个文件夹 | [`liveview preview`](#快速开始) | 无 |
| 编写一本书或一个书架 | [创建书库](#创建书库) | 文件与 `book.toml` |
| 在发布前发现问题 | [校验内容](#校验内容) | 无 |
| 托管持久的阅读器 | [持久部署](#持久部署) | PostgreSQL 与 S3 兼容存储 |
| 参与 LiveView 开发 | [开发](#开发) | Nix、Git 与固定版本工具链 |

## 快速开始

### 先决条件

- 启用了 flakes 的 [Nix](https://nixos.org/)，运行在 x86_64 Linux 上
- Git

克隆仓库并构建可复现的软件包：

```bash
git clone https://github.com/dravengarden/liveview.git
cd liveview
nix build
```

预览仓库本身：

```bash
./result/bin/liveview preview --open
```

或者在不使用 PostgreSQL 与对象存储的情况下预览任意目录：

```bash
cd /path/to/your/library
/path/to/liveview/result/bin/liveview preview --open
```

LiveView 会打印所选的本地 URL，带 `--open` 时会自动打开。它会在当前目录中查找
`liveview.toml`、`liveview.yaml` 或 `liveview.json`；没有配置文件时，预览模式会
把该目录当作一个书库。

如需可编辑的开发构建，请使用固定版本的开发环境：

```bash
nix develop -c just build
./target/release/liveview preview --open
```

## 创建书库

对于小型文档集，一个显式的书籍条目就足够了：

```toml
# liveview.toml
[server]
host = "127.0.0.1"
port = 4160

[[book]]
label = "Project Handbook"
description = "Guides, decisions, and operating notes."
source = "docs"

[book.layout]
order = ["README.md", "getting-started/", "reference/"]
```

如需书架，让 LiveView 指向一个目录，其直接子目录中包含 `book.toml` 清单：

```toml
# liveview.toml
[[shelf]]
path = "library"
```

```text
library/
├── distributed-systems/
│   ├── book.toml
│   ├── cover.webp
│   ├── backdrop.webp
│   ├── en/
│   │   ├── 01-introduction.md
│   │   └── 02-replication.md
│   ├── zh/
│   │   ├── 01-introduction.md
│   │   └── 02-replication.md
│   └── audio/
│       └── en/
│           ├── 01-introduction.spoken.md
│           └── 02-replication.spoken.md
└── practical-rust/
    ├── book.toml
    └── en/
        └── 01-getting-started.md
```

一个多语言清单示例：

```toml
# library/distributed-systems/book.toml
slug = "distributed-systems"
title = "Distributed Systems"
default_lang = "en"
default_rendition = "text"
cover = "cover.webp"
backdrop = "backdrop.webp"
tags = ["subject.distributed-systems", "format.guide", "replication"]

[langs.en]
label = "English"

[langs.zh]
label = "简体中文"

[renditions.text]
label = "Read"
langs = ["en", "zh"]

[renditions.audio]
label = "Listen"
langs = ["en"]
voice = "en-US-AriaNeural"
```

标签是可选的、由作者拥有的搜索关键词。LiveView 从当前目录动态派生筛选项，而不是
内置一套学科分类：`facet.value` 会创建一个具名维度（例如 `format.guide`），而
`replication` 这样不带命名空间的值会出现在通用的 Tags 维度下。合集独立地对书籍
分组，从不隐含标签或优先级。

### 朗读语音

语音设置按字段逐级继承——书库默认值 → 书 → 呈现方式（文本朗读或有声书）→ 文章——
也可以在清单中声明：

```toml
[speech]
voices = ["kokoro:af_heart", "kokoro:af_bella"]
default_voice = "kokoro:af_heart"
bitrate_kbps = 96
speed_percent = 100
```

Kokoro 通过 `.#liveview-with-speech` 包在本地离线运行；Edge TTS 是可选适配器。
按语言和章节覆盖、发音规则、说话人省略、语音 API 与后台预生成，请参阅
[朗读语音](docs/reading-voices.md)。

## 校验内容

LiveView 使用与渲染器兼容的解析器校验内容，在读者遇到问题之前发现它们。

```bash
# Check one book or a whole library.
liveview check ./library

# Treat warnings as failures.
liveview check ./library --deny-warnings

# Create a baseline for existing warnings.
liveview gate ./library --write-baseline

# Reject renderer errors and warning regressions.
liveview gate ./library
```

检查器覆盖 Markdown 引用与资源、KaTeX 公式、Mermaid 语法、内联 SVG、Typst、
JSON、Excalidraw 以及朗读资源覆盖率。

## 持久部署

关于安装、离线下载、更新以及与原生应用的差异，请参阅 [PWA 指南](docs/pwa.md)。

当书库需要独立于源码目录提供服务时，使用持久模式。

```mermaid
sequenceDiagram
    participant Author as Author
    participant CLI as LiveView CLI
    participant DB as PostgreSQL
    participant S3 as S3-compatible storage
    participant Server as LiveView server
    participant Reader as Reader client

    Author->>CLI: Edit books and assets
    CLI->>CLI: Check, render, and diff the Merkle DAG
    CLI->>DB: Reconcile catalog and rendered content
    CLI->>S3: Upload changed binary assets and audio
    CLI-->>Server: Notify catalog reload
    Reader->>Server: Request shelf, chapter, or media
    Server->>DB: Read metadata and rendered content
    Server->>S3: Stream binary objects
    Server-->>Reader: Serve the web, PWA, or native client
```

设置存储连接信息，同步书库，然后启动服务器：

```bash
export DATABASE_URL='postgres://liveview:password@127.0.0.1:5432/liveview'
export LIVEVIEW_S3_ENDPOINT='http://127.0.0.1:9000'
export LIVEVIEW_S3_BUCKET='liveview'
export LIVEVIEW_S3_ACCESS_KEY='...'
export LIVEVIEW_S3_SECRET_KEY='...'

liveview sync --config liveview.toml
liveview --config liveview.toml --host 0.0.0.0 --port 4160
```

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接 URL |
| `LIVEVIEW_S3_ENDPOINT` | S3 兼容 API 端点 |
| `LIVEVIEW_S3_BUCKET` | 对象存储桶名称；默认 `liveview` |
| `LIVEVIEW_S3_ACCESS_KEY[_FILE]` | Access key，或包含它的文件路径 |
| `LIVEVIEW_S3_SECRET_KEY[_FILE]` | Secret key，或包含它的文件路径 |
| `LIVEVIEW_EDGE_TTS_CMD` | 可选的 Edge TTS 适配器命令；未设置时禁用联网语音合成 |
| `LIVEVIEW_KOKORO_TTS_CMD` | 离线 Kokoro 适配器，由 `.#liveview-with-speech` 自动设置 |
| `LIVEVIEW_TTS_VOICE` | 书籍呈现方式未声明语音时的可选回退语音 |
| `LIVEVIEW_BOOK_END_PHRASES` | 可选的语言标签到结束语的 JSON 映射，例如 `{"en":"The end."}` |
| `LIVEVIEW_APM_VL_URL` | 可选的 VictoriaLogs 兼容 APM 写入 URL |
| `LIVEVIEW_APM_TOKEN[_FILE]` | 可选 APM 接收端的 Bearer token 或 token 文件 |
| `LIVEVIEW_APM_ALLOW_UNAUTHENTICATED` | 显式允许无 token 的 APM 接收端；默认 false |
| `LIVEVIEW_ALLOWED_ORIGINS` | 额外的、逗号分隔的精确 CORS 来源。`lvsync://localhost` 与 `tauri://localhost` 始终允许，以便原生 WKWebView `fetch` `/api`。通配符 `*` 会被拒绝 |
| `LIVEVIEW_ACCESS_TOKEN[_FILE]` | 可选；每个 API 与 WebSocket 请求都需携带的 Bearer token |

默认 Nix 包不含语音提供方。`.#liveview-with-edge-tts` 会加入参考适配器，但在设置
`LIVEVIEW_EDGE_TTS_CMD=edge-tts` 之前合成仍处于禁用状态。浏览器端 APM 采集需要在
构建时通过 `VITE_APM_ENABLED=true` 单独开启。

原生版本更新提示由部署方负责。构建网页应用时同时设置
`VITE_NATIVE_RELEASE_APP_ID` 与 `VITE_NATIVE_RELEASE_MANIFEST_URL` 才会启用；否则
阅读器中不会出现任何发布渠道或端点。

> [!IMPORTANT]
> LiveView 不提供用户账号或多用户授权。面向公网部署时，请把它放在可信的反向代理或
> 身份感知访问层之后，在那里终止 TLS，并限制对存储服务的访问。作为纵深防御，代理
> 可以向上游注入 `Authorization: Bearer …`，由 LiveView 校验匹配的
> `LIVEVIEW_ACCESS_TOKEN`。这种由代理注入的模式也覆盖浏览器 API 无法直接附加请求头
> 的媒体与 WebSocket 请求。

原生 WKWebView 来源（`lvsync://localhost`，以及旧外壳使用的 `tauri://localhost`）
始终在 CORS 允许列表中。单独托管的阅读器仍需在 `LIVEVIEW_ALLOWED_ORIGINS` 中逐一
列出每个额外的精确来源；通配符 CORS 会被有意拒绝。例如：

```bash
export LIVEVIEW_ALLOWED_ORIGINS='https://reader.example.org'
```

## 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/assets/art/liveview-pipeline-dark.svg">
    <img src="website/assets/art/liveview-pipeline-light.svg" alt="LiveView 发布流水线：作者的书库文件夹、与渲染器一致的检查、只更新变化路径的增量内容寻址 DAG，以及带有校验过的离线副本的网页与原生阅读器" width="1100">
  </picture>
</p>

```mermaid
flowchart LR
    subgraph Source[Authored library]
        M[Markdown chapters]
        A[Images, PDFs, and data]
        T[Translations and audio scripts]
        B[book.toml manifests]
    end

    subgraph Tooling[LiveView CLI]
        P[preview]
        C[check and gate]
        S[sync and Merkle diff]
    end

    subgraph Storage[Persistent deployment]
        PG[(PostgreSQL<br/>catalog, rendered content, progress)]
        OBJ[(S3-compatible storage<br/>assets and audio)]
    end

    subgraph Delivery[Reader]
        API[Axum server]
        WEB[Web and PWA]
        NATIVE[Tauri native shell]
    end

    M --> P
    A --> P
    T --> P
    B --> P
    P --> C
    C --> S
    S --> PG
    S --> OBJ
    PG --> API
    OBJ --> API
    API --> WEB
    API --> NATIVE
```

本地预览走最短路径：源文件 → 渲染器 → 浏览器。持久部署额外加入校验、增量同步、
持久存储以及支持离线的客户端。

| 模式 | 内容来源 | 阅读器 | 外部服务 |
|---|---|---|---|
| 本地预览 | 文件系统 | Web | 无 |
| 持久服务器 | PostgreSQL 与对象存储 | Web/PWA | PostgreSQL 与 S3 兼容存储 |
| 原生外壳 | 持久服务器加上经过校验的本地缓存 | Tauri/WKWebView | 持久服务器；原生构建需要 Xcode |

## CLI 概览

| 命令 | 用途 |
|---|---|
| `liveview preview` | 直接从文件系统提供本地书库 |
| `liveview check` | 校验可渲染性与内容结构 |
| `liveview gate` | 执行带基线的发布策略 |
| `liveview sync` | 把源内容增量调和到持久存储 |
| `liveview audio-optimize` | 把旧版 MP3 章节音频升级为规范的内容寻址音频 |
| `liveview targets` | 列出用于视觉检查的 Mermaid 与 SVG 渲染目标 |
| `liveview tasks` | 查看或重试异步音频生成任务 |
| `liveview narrate-audit` | 审查散文与非散文资源将如何被朗读 |
| `liveview narrate-plan` | 以结构化 JSON 输出缺失的朗读工作 |

运行 `liveview <command> --help` 查看完整选项。

## 支持的格式

| 内容 | 扩展名与语法 |
|---|---|
| Markdown | `.md`、`.markdown`、GitHub 风格 Markdown、脚注 |
| 图片 | PNG、JPEG、GIF、SVG、WebP、AVIF、BMP、ICO、TIFF |
| 文档 | PDF、HTML |
| 数据 | CSV、TSV、JSON、JSONC、JSON5 |
| 图表 | Mermaid、内联 SVG、Excalidraw |
| 公式与排版 | KaTeX 兼容公式、LaTeX、Typst |
| 交互视图 | `*.interactive-view.json` |
| 音频 | 朗读用 Markdown 脚本、生成的音频、句级时间标记 |

## 文档

[文档索引](docs/INDEX.md)是稳定契约、设计文档与历史计划的规范入口。推荐从这里开始：

- [核心需求](docs/core-requirements.md) —— 产品不变量与性能验收标准。
- [设计系统](docs/design-system.md) —— 品牌、响应式布局、材质、动效与无障碍规则。
- [增量离线流水线](docs/design/incremental-offline-pipeline.md) —— 内容身份、同步、保留与恢复。
- [交互视图编写](docs/design/interactive-view-authoring.md) —— 可执行技术内容的 schema 与编写指南。
- [朗读旁白](docs/design/read-aloud-narration.md) —— 旁白身份，以及图表、表格、公式与代码的处理方式。
- [朗读语音](docs/reading-voices.md) —— 语音继承、清单与 API 策略、后台预生成与本地合成。

## 开发

请使用仓库固定版本的开发环境；主机上的工具版本不属于受支持的构建：

```bash
nix develop -c just verify
```

快速迭代：

```bash
just dev          # Start the frontend and backend development servers
just build        # Build the embedded release binary
just check        # Formatting, Clippy, and TypeScript checks
just test         # Rust and web test suites
just dependencies # Vulnerability, license, and dependency hygiene checks
just verify       # Full local verification gate
```

请在 `nix develop` 中运行这些命令（或在单次调用前加 `nix develop -c`）。原生
模拟器与真机验证还需要 macOS 上的 Xcode。

主要组件：

```text
src/                 Rust CLI, server, renderer, checker, and sync pipeline
web/                 React and TypeScript reader (IDB replica)
app/                 Tauri application shell (thin lvsync:// host)
tools/               Deterministic content tooling
```

## 参与贡献

欢迎提交 issue、聚焦的 pull request、文档改进和可复现的缺陷报告。一份有用的缺陷
报告应包含 `liveview --version`、平台、最小的内容/配置示例、预期与实际行为，以及
去除凭据后的相关日志。

开发与评审约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。较大的功能或协议变更，请先
[提交 issue](https://github.com/dravengarden/liveview/issues/new) 讨论归属与兼容性。
疑似安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，切勿发布在公开 issue 中。

提交变更前：

```bash
nix develop -c just verify
```

## 许可证

LiveView 基于 [MIT 许可证](LICENSE) 发布。
