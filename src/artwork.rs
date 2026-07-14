//! Deterministic derived artwork used by performance-sensitive UI surfaces.
//!
//! Authored cover/backdrop bytes remain canonical, content-addressed resources.
//! A shelf card gets a separate opaque JPEG rendition so WKWebView does not
//! decode and composite a full-size hero texture during momentum scrolling.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;

const CARD_BACKDROP_WIDTH: u32 = 768;
const CARD_BACKDROP_HEIGHT: u32 = 432;
const CARD_BACKDROP_QUALITY: u8 = 74;

pub fn card_backdrop(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let source = image::load_from_memory(bytes).map_err(|e| format!("decode backdrop: {e}"))?;
    let resized = source.resize_to_fill(
        CARD_BACKDROP_WIDTH,
        CARD_BACKDROP_HEIGHT,
        FilterType::Triangle,
    );
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, CARD_BACKDROP_QUALITY)
        .encode_image(&resized)
        .map_err(|e| format!("encode card backdrop: {e}"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbImage};
    use std::io::Cursor;

    fn source_png() -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_fn(1600, 900, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, ((x + y) % 255) as u8])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn card_backdrop_is_small_opaque_and_deterministic() {
        let source = source_png();
        let first = card_backdrop(&source).unwrap();
        let second = card_backdrop(&source).unwrap();
        assert_eq!(first, second);
        assert!(first.len() < source.len());
        let decoded = image::load_from_memory(&first).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (768, 432));
        assert!(!decoded.color().has_alpha());
    }
}
