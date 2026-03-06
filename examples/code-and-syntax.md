# Code & Syntax Highlighting

Testing highlight.js integration across multiple languages.

## Rust

```rust
use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Config {
    name: String,
    values: HashMap<String, i64>,
}

impl Config {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            values: HashMap::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&i64> {
        self.values.get(key)
    }
}

fn main() {
    let mut config = Config::new("app");
    config.values.insert("port".into(), 3000);
    println!("{:#?}", config);
}
```

## TypeScript

```typescript
interface User {
  id: number;
  name: string;
  email: string;
  roles: Role[];
}

type Role = "admin" | "editor" | "viewer";

async function fetchUsers(limit: number = 10): Promise<User[]> {
  const response = await fetch(`/api/users?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

const users = await fetchUsers();
console.log(`Loaded ${users.length} users`);
```

## Python

```python
from dataclasses import dataclass, field
from pathlib import Path
import asyncio

@dataclass
class FileWatcher:
    root: Path
    patterns: list[str] = field(default_factory=lambda: ["*.md"])
    _running: bool = False

    async def watch(self):
        self._running = True
        while self._running:
            changes = self._scan()
            for path, kind in changes:
                print(f"[{kind}] {path}")
            await asyncio.sleep(0.5)

    def _scan(self) -> list[tuple[Path, str]]:
        return [(p, "modified") for p in self.root.rglob("*.md")]
```

## Go

```go
package main

import (
	"fmt"
	"net/http"
	"sync"
)

type Server struct {
	mu       sync.RWMutex
	handlers map[string]http.HandlerFunc
}

func (s *Server) Handle(pattern string, handler http.HandlerFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[pattern] = handler
}

func main() {
	srv := &Server{handlers: make(map[string]http.HandlerFunc)}
	srv.Handle("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	http.ListenAndServe(":8080", nil)
}
```

## Shell

```bash
#!/bin/bash
set -euo pipefail

WATCH_DIR="${1:-.}"
PORT="${2:-3000}"

echo "Watching: $WATCH_DIR"
echo "Serving on: http://localhost:$PORT"

inotifywait -m -r -e modify,create,delete "$WATCH_DIR" \
  --include '\.md$' |
while read -r dir event file; do
  echo "[$(date +%H:%M:%S)] $event: $dir$file"
done
```

## SQL

```sql
SELECT
    u.name,
    COUNT(p.id) AS post_count,
    MAX(p.created_at) AS latest_post
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
WHERE u.active = true
GROUP BY u.id, u.name
HAVING COUNT(p.id) > 5
ORDER BY post_count DESC
LIMIT 20;
```

## JSON / YAML / TOML

```json
{
  "name": "lv",
  "version": "0.1.0",
  "features": ["live-reload", "mermaid", "syntax-highlight"]
}
```

```yaml
server:
  host: 127.0.0.1
  port: 3000
  watch:
    include: ["**/*.md"]
    exclude: [".git", "node_modules", "target"]
```

```toml
[application]
name = "lv"
default_platform = "fullstack"
asset_dir = "assets"
```

## Diff

```diff
- old line removed
+ new line added
  unchanged context line
- another removal
+ another addition
```

## Inline Code

Use `cargo run` to start, or run `dx serve` for development. The config file is at `~/.config/lv.toml`.
