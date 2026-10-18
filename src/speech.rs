//! Portable book-owned speech choices and reproducible synthesis recipes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechConfig {
    pub voices: Vec<String>,
    pub default_voice: Option<String>,
    pub languages: BTreeMap<String, String>,
    pub chapters: BTreeMap<String, String>,
    pub pronunciations: BTreeMap<String, String>,
    pub omit_speakers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub voice: String,
    pub revision: String,
    pub pronunciations: BTreeMap<String, String>,
    pub omit_speakers: Vec<String>,
}

impl SpeechConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.voices.len() > 8 || self.pronunciations.len() > 256 {
            return Err("speech allows at most 8 voices and 256 pronunciations".into());
        }
        let mut seen = std::collections::HashSet::new();
        for voice in &self.voices {
            if !valid_voice(voice) || !seen.insert(voice) {
                return Err(format!("invalid or duplicate speech voice: {voice}"));
            }
        }
        for voice in self
            .default_voice
            .iter()
            .chain(self.languages.values())
            .chain(self.chapters.values())
        {
            if !self.voices.contains(voice) {
                return Err(format!("speech default {voice} must be in voices"));
            }
        }
        for (word, spoken) in &self.pronunciations {
            if word.trim().is_empty()
                || word.len() > 100
                || spoken.trim().is_empty()
                || spoken.len() > 300
            {
                return Err(
                    "speech pronunciations require bounded, nonempty words and replacements".into(),
                );
            }
        }
        if self.omit_speakers.len() > 32
            || self
                .omit_speakers
                .iter()
                .any(|s| s.is_empty() || s.len() > 80)
        {
            return Err("speech speaker names must be nonempty and bounded".into());
        }
        Ok(())
    }

    pub fn default_for(&self, lang: &str, chapter: &str, legacy: Option<&str>) -> String {
        self.chapters
            .get(chapter)
            .or_else(|| self.languages.get(lang))
            .or(self.default_voice.as_ref())
            .or_else(|| self.voices.iter().find(|v| matches_language(v, lang)))
            .or_else(|| self.voices.first())
            .cloned()
            .unwrap_or_else(|| language_default(lang, legacy))
    }

    pub fn recipe(&self, voice: &str) -> Recipe {
        Recipe {
            voice: voice.to_string(),
            revision: if voice.starts_with("kokoro:") {
                "kokoro-f3ff3571-misaki-20250616-v2"
            } else {
                "edge-v1"
            }
            .into(),
            pronunciations: self.pronunciations.clone(),
            omit_speakers: self.omit_speakers.clone(),
        }
    }

    pub fn resolve(&self, lang: &str, chapter: &str, legacy: Option<&str>) -> String {
        // Books without a policy keep their existing provider/cache identity.
        // Opting a book into a policy enables language-aware defaults.
        if self == &Self::default()
            && let Some(voice) = legacy
        {
            return voice.into();
        }
        let voice = self.default_for(lang, chapter, legacy);
        // Preserve legacy cache identities for an unchanged Edge recipe.
        if self == &Self::default() {
            return voice;
        }
        self.recipe(&voice).encode()
    }
}

impl Recipe {
    pub fn encode(&self) -> String {
        format!(
            "speech-v1:{}",
            serde_json::to_string(self).expect("serializable speech recipe")
        )
    }

    pub fn decode(value: &str) -> Result<Self, String> {
        match value.strip_prefix("speech-v1:") {
            Some(json) => {
                serde_json::from_str(json).map_err(|e| format!("invalid speech recipe: {e}"))
            }
            None => Ok(SpeechConfig::default().recipe(value)),
        }
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
        // One replacement pass avoids expanding replacement text a second time.
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
    if let Some(voice) = fallback.filter(|voice| matches_language(voice, lang)) {
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

    #[test]
    fn english_never_inherits_the_chinese_global_voice() {
        assert_eq!(
            language_default("en", Some("zh-CN-XiaoxiaoNeural")),
            "en-US-EmmaMultilingualNeural"
        );
        assert_eq!(
            language_default("zh", Some("zh-CN-XiaoxiaoNeural")),
            "zh-CN-XiaoxiaoNeural"
        );
    }

    #[test]
    fn chapter_language_and_book_defaults_are_ordered() {
        let cfg: SpeechConfig = toml::from_str("voices = ['kokoro:af_heart', 'kokoro:af_bella']\ndefault_voice = 'kokoro:af_heart'\n[languages]\nen = 'kokoro:af_bella'\n[chapters]\n'22.md' = 'kokoro:af_heart'").unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.default_for("en", "21.md", None), "kokoro:af_bella");
        assert_eq!(cfg.default_for("en", "22.md", None), "kokoro:af_heart");
    }

    #[test]
    fn pronunciations_change_identity_and_preserve_display_text() {
        let mut cfg = SpeechConfig::default();
        let before = cfg.recipe("kokoro:af_heart").id();
        cfg.pronunciations.insert("API".into(), "A P I".into());
        cfg.omit_speakers.push("Lin".into());
        let recipe = cfg.recipe("kokoro:af_heart");
        assert_ne!(before, recipe.id());
        assert_eq!(
            recipe.prepare("Lin: The API is ready; APIs remain."),
            "The A P I is ready; APIs remain."
        );
        assert_eq!(Recipe::decode(&recipe.encode()).unwrap(), recipe);
    }

    #[test]
    fn unlisted_default_and_duplicate_voices_are_rejected() {
        let mut cfg = SpeechConfig {
            voices: vec!["kokoro:af_heart".into()],
            default_voice: Some("kokoro:af_bella".into()),
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
        cfg.default_voice = None;
        cfg.voices.push("kokoro:af_heart".into());
        assert!(cfg.validate().is_err());
    }
}
