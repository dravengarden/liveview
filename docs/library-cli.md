# User directory CLI

Use the same server as the reader. Set `LIVEVIEW_SERVER` to its HTTP(S) origin;
servers with access control also accept `LIVEVIEW_ACCESS_TOKEN`. Credentials
belong in the environment, outside saved plans and command history.

```sh
liveview dir tree > library.json
liveview dir apply plan.json --dry-run
liveview dir apply plan.json
liveview dir undo 7 --expected-revision 8
```

`tree` emits JSON with `revision`, `directories` and `placements`. Directory IDs
are stable, names are opaque sibling-unique labels, and `parent: null` means the
root. `placements` maps content slugs to their primary directory ID. Missing
placements mean unfiled content at the root. Empty directories are retained.

An AI organizer should read the current tree and `/api/books`, then produce a
plan against that revision. Inspect the dry-run snapshot before applying it:

```json
{
  "revision": 7,
  "operations": [
    {"op": "create", "id": "learning", "name": "Learning", "parent": null},
    {"op": "create", "id": "systems", "name": "Systems", "parent": "learning"},
    {"op": "place", "slug": "existing-book-slug", "directory": "systems"}
  ]
}
```

Other operations are `rename` (`id`, `name`), `move_directory` (`id`, `parent`),
`place` (`slug`, `directory: null` to unfile), and `delete` (`id`). A plan accepts
1–1000 operations; it either succeeds completely or changes nothing. Missing
content, nonexistent parents, sibling name collisions and cycles are rejected.
Names cannot contain control characters; punctuation is opaque, never a path separator. No subject vocabulary or
collection inference is built in.

The response is the new complete snapshot. A stale revision fails with HTTP 409
and nonzero CLI exit status; read the tree again and reconsider the plan. Never
silently replace its revision and replay an old plan. Lost acknowledgements are
also safe to retry: a committed plan's old revision fails rather than applying
twice. Directory operations never rewrite book content, URLs, or progress.

`undo REVISION --expected-revision CURRENT` restores the snapshot before the
change made at REVISION and creates a new revision. It also checks CURRENT,
so an undo cannot overwrite a concurrent edit unnoticed. History is stored in
PostgreSQL. Ordinary content synchronization does not modify this history.
