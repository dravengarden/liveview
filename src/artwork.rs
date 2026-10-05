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

// ── Deterministic gradient cover synthesis ──────────────────────────────────
// A cover-less book shows a slug-keyed CSS gradient on the bookshelf
// (web/.../Landing.tsx `coverGradient`). The Media Session lock-screen tile
// can't use CSS — it needs a real raster URL — so the SAME gradient is
// rendered to a PNG here.

const GRADIENT_SIZE: u32 = 512;

/// Slug → hue 0–359. Mirrors Landing.tsx `slugHue` exactly (int32 wrapping over
/// UTF-16 code units) so the PNG matches the shelf's colour for the same book.
fn slug_hue(slug: &str) -> f64 {
    let mut h: i32 = 0;
    for c in slug.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(i32::from(c));
    }
    f64::from(h.unsigned_abs() % 360)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [u8; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r, g, b) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    let to = |v: f64| (((v + m) * 255.0).round()).clamp(0.0, 255.0) as u8;
    [to(r), to(g), to(b)]
}

fn lerp(a: u8, b: u8, t: f64) -> u8 {
    (f64::from(a) + (f64::from(b) - f64::from(a)) * t).round() as u8
}

/// 512×512 PNG of the slug's two-stop 135° gradient (top-left → bottom-right),
/// matching Landing.tsx `coverGradient`.
pub fn gradient_png(slug: &str) -> Result<Vec<u8>, String> {
    let hue = slug_hue(slug);
    let from = hsl_to_rgb(hue, 0.52, 0.52);
    let to = hsl_to_rgb((hue + 38.0) % 360.0, 0.48, 0.42);
    let denom = f64::from(2 * (GRADIENT_SIZE - 1));
    let image = image::RgbImage::from_fn(GRADIENT_SIZE, GRADIENT_SIZE, |x, y| {
        let t = f64::from(x + y) / denom;
        image::Rgb(std::array::from_fn(|i| lerp(from[i], to[i], t)))
    });
    let mut output = Vec::new();
    image
        .write_with_encoder(image::codecs::png::PngEncoder::new(&mut output))
        .map_err(|e| format!("encode gradient cover: {e}"))?;
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

    #[test]
    fn gradient_cover_matches_the_shelf_gradient_stops() {
        let png = gradient_png("algorithms").unwrap();
        // A smooth gradient compresses far below the raw 768 KiB RGB raster.
        assert!(png.len() < 64 * 1024, "{} bytes", png.len());
        let decoded = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (512, 512));
        let hue = slug_hue("algorithms");
        assert_eq!(decoded.get_pixel(0, 0).0, hsl_to_rgb(hue, 0.52, 0.52));
        assert_eq!(
            decoded.get_pixel(511, 511).0,
            hsl_to_rgb((hue + 38.0) % 360.0, 0.48, 0.42)
        );
        assert_eq!(png, gradient_png("algorithms").unwrap());
    }

    #[test]
    fn slug_hue_wraps_like_the_web_hash() {
        // JS: [..."ab"].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) = 3105.
        assert_eq!(slug_hue("ab"), f64::from(3105 % 360));
        assert!(slug_hue(&"z".repeat(64)) < 360.0);
    }
}
