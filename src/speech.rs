//! Sparse, inherited speech settings and reproducible synthesis recipes.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<Generation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_voice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_percent: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronunciations: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omit_speakers: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Generation {
    All,
    OnDemand,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechConfig {
    #[serde(flatten)]
    pub options: SpeechOptions,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub languages: BTreeMap<String, SpeechOverride>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub chapters: BTreeMap<String, SpeechOverride>,
}

/// String shorthand remains compatible with the first policy format.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum SpeechOverride {
    Voice(String),
    Options(SpeechOptions),
}
impl SpeechOverride {
    pub fn options(&self) -> SpeechOptions {
        match self {
            Self::Voice(voice) => SpeechOptions {
                default_voice: Some(voice.clone()),
                ..Default::default()
            },
            Self::Options(options) => options.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SpeechPolicy {
    pub global: SpeechConfig,
    pub book: SpeechConfig,
    pub rendition: SpeechConfig,
}
#[derive(Clone, Debug, Serialize)]
pub struct EffectiveSpeech {
    #[serde(flatten)]
    pub options: SpeechOptions,
    pub sources: BTreeMap<String, String>,
}

impl SpeechOptions {
    /// Scheduling never changes the audio recipe or legacy encoding.
    pub fn has_audio_options(&self) -> bool {
        let mut audio = self.clone();
        audio.generation = None;
        audio != Self::default()
    }
    fn overlay(&mut self, child: &Self, source: &str, sources: &mut BTreeMap<String, String>) {
        macro_rules! field {
            ($name:ident) => {
                if let Some(value) = &child.$name {
                    self.$name = Some(value.clone());
                    sources.insert(stringify!($name).into(), source.into());
                }
            };
        }
        field!(voices);
        field!(generation);
        field!(default_voice);
        field!(bitrate_kbps);
        field!(speed_percent);
        field!(pronunciations);
        field!(omit_speakers);
    }
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        if let Some(voices) = &self.voices {
            if voices.is_empty() || voices.len() > 8 {
                return Err("speech allows 1 to 8 voices".into());
            }
            for voice in voices {
                if !valid_voice(voice) || !seen.insert(voice) {
                    return Err(format!("invalid or duplicate speech voice: {voice}"));
                }
            }
            if let Some(voice) = &self.default_voice
                && !voices.contains(voice)
            {
                return Err("default_voice must be included in this scope's voices".into());
            }
        }
        if self.default_voice.as_ref().is_some_and(|v| !valid_voice(v)) {
            return Err("invalid default voice".into());
        }
        if self
            .bitrate_kbps
            .is_some_and(|n| ![32, 48, 64, 96, 128, 160].contains(&n))
        {
            return Err("bitrate_kbps must be 32, 48, 64, 96, 128 or 160".into());
        }
        if self.speed_percent.is_some_and(|n| !(50..=150).contains(&n)) {
            return Err("speed_percent must be between 50 and 150".into());
        }
        if let Some(words) = &self.pronunciations
            && (words.len() > 256
                || words.iter().any(|(w, s)| {
                    w.trim().is_empty() || w.len() > 100 || s.trim().is_empty() || s.len() > 300
                }))
        {
            return Err("pronunciations require at most 256 bounded nonempty replacements".into());
        }
        if let Some(names) = &self.omit_speakers
            && (names.len() > 32 || names.iter().any(|s| s.is_empty() || s.len() > 80))
        {
            return Err("speaker names must be nonempty and bounded".into());
        }
        Ok(())
    }
    pub fn default_for(&self, lang: &str, legacy: Option<&str>) -> String {
        if !self.has_audio_options()
            && let Some(voice) = legacy
        {
            return voice.into();
        }
        self.default_voice
            .clone()
            .or_else(|| {
                self.voices.as_ref().and_then(|v| {
                    v.iter()
                        .find(|v| matches_language(v, lang))
                        .or(v.first())
                        .cloned()
                })
            })
            .unwrap_or_else(|| {
                legacy
                    .map(str::to_owned)
                    .unwrap_or_else(|| language_default(lang, None))
            })
    }
    pub fn available_voices(&self, lang: &str, legacy: Option<&str>) -> Vec<String> {
        let default = self.default_for(lang, legacy);
        let mut voices = self.voices.clone().unwrap_or_default();
        // A more specific default grants that voice at its own scope.
        if !voices.contains(&default) {
            voices.push(default);
        }
        voices
    }
    pub fn recipe(&self, voice: &str) -> Recipe {
        Recipe {
            voice: voice.into(),
            revision: if voice.starts_with("kokoro:") {
                "kokoro-f3ff3571-misaki-20250616-v2"
            } else {
                "edge-v1"
            }
            .into(),
            bitrate_kbps: self.bitrate_kbps.unwrap_or(96),
            speed_percent: self.speed_percent.unwrap_or(100),
            pronunciations: self.pronunciations.clone().unwrap_or_default(),
            omit_speakers: self.omit_speakers.clone().unwrap_or_default(),
        }
    }
    pub fn resolve(&self, lang: &str, legacy: Option<&str>) -> String {
        if !self.has_audio_options() {
            return legacy
                .map(str::to_owned)
                .unwrap_or_else(|| language_default(lang, None));
        }
        self.recipe(&self.default_for(lang, legacy)).encode()
    }
}
impl SpeechConfig {
    pub fn validate(&self) -> Result<(), String> {
        self.options.validate()?;
        if self.languages.len() > 128 || self.chapters.len() > 10000 {
            return Err("too many speech overrides".into());
        }
        for value in self.languages.values().chain(self.chapters.values()) {
            value.options().validate()?;
        }
        Ok(())
    }
}
impl SpeechPolicy {
    pub fn effective(&self, lang: &str, chapter: &str) -> EffectiveSpeech {
        let mut options = SpeechOptions::default();
        let mut sources = BTreeMap::new();
        let layers = [
            ("global", &self.global),
            ("book", &self.book),
            ("rendition", &self.rendition),
        ];
        for (name, config) in &layers {
            options.overlay(&config.options, name, &mut sources);
            if let Some(value) = config.languages.get(lang) {
                options.overlay(&value.options(), &format!("{name}:language"), &mut sources);
            }
        }
        // An article override is always more specific than a scope default.
        for (name, config) in &layers {
            for key in [chapter.to_string(), format!("{lang}/{chapter}")] {
                if let Some(value) = config.chapters.get(&key) {
                    options.overlay(&value.options(), &format!("{name}:chapter"), &mut sources);
                }
            }
        }
        EffectiveSpeech { options, sources }
    }
    pub fn resolve(&self, lang: &str, chapter: &str, legacy: Option<&str>) -> String {
        self.effective(lang, chapter).options.resolve(lang, legacy)
    }
}

fn default_bitrate() -> u16 {
    96
}
fn default_speed() -> u16 {
    100
}
fn is_default_bitrate(n: &u16) -> bool {
    *n == 96
}
fn is_default_speed(n: &u16) -> bool {
    *n == 100
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub voice: String,
    pub revision: String,
    pub pronunciations: BTreeMap<String, String>,
    pub omit_speakers: Vec<String>,
    // Omit original defaults so existing 96 kbps / 1x assets retain identity.
    #[serde(
        default = "default_bitrate",
        skip_serializing_if = "is_default_bitrate"
    )]
    pub bitrate_kbps: u16,
    #[serde(default = "default_speed", skip_serializing_if = "is_default_speed")]
    pub speed_percent: u16,
}
impl Recipe {
    pub fn encode(&self) -> String {
        format!(
            "speech-v1:{}",
            serde_json::to_string(self).expect("serializable recipe")
        )
    }
    pub fn decode(value: &str) -> Result<Self, String> {
        let recipe: Self = match value.strip_prefix("speech-v1:") {
            Some(json) => {
                serde_json::from_str(json).map_err(|e| format!("invalid speech recipe: {e}"))?
            }
            None => SpeechOptions::default().recipe(value),
        };
        SpeechOptions {
            default_voice: Some(recipe.voice.clone()),
            bitrate_kbps: Some(recipe.bitrate_kbps),
            speed_percent: Some(recipe.speed_percent),
            pronunciations: Some(recipe.pronunciations.clone()),
            omit_speakers: Some(recipe.omit_speakers.clone()),
            ..Default::default()
        }
        .validate()?;
        Ok(recipe)
    }
    pub fn id(&self) -> String {
        blake3::hash(self.encode().as_bytes()).to_hex().to_string()
    }
    pub fn prepare(&self, text: &str) -> String {
        let mut text = text.trim();
        for speaker in &self.omit_speakers {
            if let Some(rest) = text.strip_prefix(speaker).and_then(|s| s.strip_prefix(':')) {
                text = rest.trim_start();
                break;
            }
        }
        if self.pronunciations.is_empty() {
            return text.into();
        }
        let pattern = self
            .pronunciations
            .keys()
            .map(|w| regex::escape(w))
            .collect::<Vec<_>>()
            .join("|");
        let regex = regex::Regex::new(&format!(r"\b(?:{pattern})\b")).expect("escaped words");
        regex
            .replace_all(text, |caps: &regex::Captures<'_>| {
                self.pronunciations[&caps[0]].clone()
            })
            .into_owned()
    }
}
pub fn valid_voice(voice: &str) -> bool {
    if voice.starts_with("kokoro:") {
        return matches!(voice, "kokoro:af_heart" | "kokoro:af_bella");
    }
    let voice = voice.strip_prefix("edge:").unwrap_or(voice);
    voice.len() < 100
        && voice.ends_with("Neural")
        && voice.split('-').count() >= 3
        && voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
pub fn matches_language(voice: &str, lang: &str) -> bool {
    let language = lang.split('-').next().unwrap_or(lang);
    if voice.starts_with("kokoro:") {
        return language == "en";
    }
    voice
        .strip_prefix("edge:")
        .unwrap_or(voice)
        .starts_with(&format!("{language}-"))
}
pub fn language_default(lang: &str, fallback: Option<&str>) -> String {
    if let Some(voice) = fallback.filter(|v| matches_language(v, lang)) {
        return voice.into();
    }
    match lang.split('-').next().unwrap_or(lang) {
        "en" => "en-US-EmmaMultilingualNeural",
        "zh" => "zh-CN-XiaoxiaoNeural",
        _ => fallback.unwrap_or("en-US-EmmaMultilingualNeural"),
    }
    .into()
}
pub fn label(voice: &str) -> String {
    match voice {
        "kokoro:af_heart" => "Heart · English (US)".into(),
        "kokoro:af_bella" => "Bella · English (US)".into(),
        other => other
            .strip_prefix("edge:")
            .unwrap_or(other)
            .trim_end_matches("Neural")
            .replace('-', " · "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(json: &str) -> SpeechConfig {
        serde_json::from_str(json).unwrap()
    }
    #[test]
    fn sparse_scope_inheritance_and_restoring_a_field() {
        let mut policy = SpeechPolicy {
            global: config(
                r#"{"bitrate_kbps":64,"speed_percent":100,"languages":{"en":"kokoro:af_heart"}}"#,
            ),
            book: config(r#"{"default_voice":"kokoro:af_bella","pronunciations":{"API":"A P I"}}"#),
            rendition: config(
                r#"{"bitrate_kbps":96,"chapters":{"22.md":{"bitrate_kbps":128},"en/22.md":{"speed_percent":110}}}"#,
            ),
        };
        let resolved = policy.effective("en", "22.md");
        assert_eq!(resolved.options.default_for("en", None), "kokoro:af_bella");
        assert_eq!(resolved.options.bitrate_kbps, Some(128));
        assert_eq!(resolved.options.speed_percent, Some(110));
        assert_eq!(resolved.sources["bitrate_kbps"], "rendition:chapter");
        assert_eq!(
            resolved
                .options
                .recipe("kokoro:af_bella")
                .prepare("The API works."),
            "The A P I works."
        );
        policy.rendition.chapters.remove("22.md");
        assert_eq!(
            policy.effective("en", "22.md").options.bitrate_kbps,
            Some(96)
        );
        assert_eq!(
            policy.effective("en", "21.md").options.speed_percent,
            Some(100)
        );
    }
    #[test]
    fn output_settings_invalidate_only_changed_recipes() {
        let base = SpeechOptions::default().recipe("kokoro:af_heart");
        assert!(!base.encode().contains("bitrate_kbps"));
        assert_eq!(Recipe::decode(&base.encode()).unwrap(), base);
        let mut options = SpeechOptions {
            bitrate_kbps: Some(128),
            ..Default::default()
        };
        assert_ne!(base.id(), options.recipe(&base.voice).id());
        options.bitrate_kbps = None;
        options.speed_percent = Some(120);
        assert_ne!(base.id(), options.recipe(&base.voice).id());
    }
    #[test]
    fn encoding_overrides_preserve_the_inherited_legacy_voice() {
        let options = config(r#"{"bitrate_kbps":128,"speed_percent":110}"#).options;
        assert_eq!(
            options.default_for("en", Some("en-US-GuyNeural")),
            "en-US-GuyNeural"
        );
        assert_eq!(
            options.default_for("en", Some("zh-CN-XiaoxiaoNeural")),
            "zh-CN-XiaoxiaoNeural"
        );
        assert_eq!(
            options.available_voices("en", Some("en-US-GuyNeural")),
            vec!["en-US-GuyNeural"]
        );
    }
    #[test]
    fn invalid_settings_and_unknown_fields_are_rejected() {
        for json in [
            r#"{"bitrate_kbps":97}"#,
            r#"{"speed_percent":0}"#,
            r#"{"voices":["bogus"]}"#,
        ] {
            assert!(config(json).validate().is_err());
        }
        assert!(serde_json::from_str::<SpeechConfig>(r#"{"bitrate":128}"#).is_err());
        assert_eq!(
            language_default("en", Some("zh-CN-XiaoxiaoNeural")),
            "en-US-EmmaMultilingualNeural"
        );
        assert_eq!(
            SpeechPolicy::default().resolve("en", "1.md", Some("legacy")),
            "legacy"
        );
    }
    #[test]
    fn explicit_empty_pronunciations_clear_inherited_rules() {
        let policy = SpeechPolicy {
            global: config(r#"{"pronunciations":{"API":"A P I"}}"#),
            book: config(r#"{"pronunciations":{}}"#),
            ..Default::default()
        };
        assert!(
            policy
                .effective("en", "1.md")
                .options
                .pronunciations
                .unwrap()
                .is_empty()
        );
    }
}
