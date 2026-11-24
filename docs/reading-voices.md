# Reading voices

Speech settings for read-aloud and audiobook renditions: inheritance, manifest
and API configuration, background preparation, and local synthesis.

Speech settings inherit by field: library defaults → book → rendition (text
read-aloud or audiobook) → article. The playback panel's Audio settings editor
selects a scope, shows the effective bitrate and its source, and lets each field
return to Inherit. Settings persist in the database and synchronize across devices.

Book manifests can declare the same portable settings:

```toml
[speech]
voices = ["kokoro:af_heart", "kokoro:af_bella"]
default_voice = "kokoro:af_heart"
bitrate_kbps = 96
speed_percent = 100
omit_speakers = ["Lin", "Anna"]

[renditions.audio.speech]
bitrate_kbps = 128

[renditions.text.speech.languages]
en = "kokoro:af_heart"

[renditions.text.speech.chapters]
"22-practice-dialogues.md" = "kokoro:af_heart"

[renditions.text.speech.chapters."en/23-practice-dialogues.md"]
bitrate_kbps = 128
speed_percent = 110

[renditions.text.speech.pronunciations]
API = "A P I"
CSV = "C S V"
```

Within each scope, a language override follows its base fields; article overrides
apply last. Article keys may be relative paths (all languages) or `lang/path`
(one edition). Omitted or null fields inherit; empty pronunciation maps and
speaker lists explicitly clear inherited rules. Lists and maps replace the
inherited field rather than concatenate it. A more specific default also makes
that voice available at its scope. A reader's selection is saved per book,
rendition, and language in server settings; an explicit article default takes
precedence when loading that article. The playback sheet switches at the current sentence and can
replay that sentence. Playback speed preserves pitch.

Policies can also be persisted directly with `PUT /api/speech/<slug>` and a
JSON body `{ "rendition": "text", "speech": { "voices": [...],
"default_voice": "kokoro:af_heart" } }`. Omit `rendition` for book defaults;
add `chapter: "en/22-practice-dialogues.md"` for an article override. Library
defaults use `GET/PUT /api/speech-defaults` with the policy itself as the body.
Set `generation = "all"` at any speech scope to prepare its current default
voice automatically, including newly synced chapters. `"on_demand"` excludes
that scope from automatic preparation; omitting the field inherits. Scheduling
does not change the audio recipe. The server scans 32 chapters at a time,
reuses existing audio, and persists work across restarts. Failed variant jobs
remain failed until explicitly retried from playback, rather than being
resubmitted on every scan. A dedicated slot serves interactive requests, and
opening a chapter raises its book's queued variant priority.

The Library audio summary reports discovered chapters, ready audio, active work,
waiting work, and failures. Its counts converge as the bounded scan runs.
`GET /api/speech-preparation` returns this compact summary; `PUT` with
`{"paused":true}` pauses new background claims (current work finishes and
interactive requests still run). Resume with `false`. Generation stores audio
on the server; it does not download the library to a reader's device.

`GET /api/speech/<slug>` returns all raw layers, each article's effective settings
and field sources, and available voices. An omitted manifest policy preserves this server
configuration during content sync; a declared manifest policy takes precedence
at sync. An empty policy clears that scope's overrides and restores inheritance.

`bitrate_kbps` accepts 32, 48, 64, 96 (default), 128 or 160; the native-compatible
container remains CAF with mono 24 kHz MP3. `speed_percent` accepts 50–150
(default 100), controls synthesis pace, and is independent of playback speed.
Bitrate, pace, voice and pronunciation rules all participate in the cache identity.
Changing a policy retains unaffected variants and rejects stale worker results.

Speaker omissions and pronunciation substitutions affect speech only. Source
text and highlight indices remain unchanged. Text and audio renditions have
separate policies; use `[renditions.audio.speech]` for audiobook scripts. Edge
voice names remain supported, including the legacy rendition `voice` field.

Kokoro runs locally without an account or per-character charges. The optional
`.#liveview-with-speech` package includes pinned English Heart and Bella models
and the tokenizer; inference is offline and bounded to one CPU job at a time.
It defaults to 96 kbps MP3 in the native-compatible CAF container. Each recipe
(voice, model revision, pronunciations, omissions) has separate audio and timing
assets, advertised through the ordinary offline DAG. Extra voices generate on
first selection; failed generation is visible and retryable. Source or policy
edits invalidate obsolete variants, and expired worker leases recover after a
restart. Choosing a voice never changes another device's live playback.
