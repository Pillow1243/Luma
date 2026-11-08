#!/usr/bin/env python3
"""Generate every Luma icon from the single master artwork.

Outputs:
  public/icons/icon-{16,32,48,64,192,256,384,512,1024}.png
  public/icons/maskable-512.png          (safe-zone padded, full-bleed bg)
  public/icons/apple-touch-icon.png      (180, no transparency)
  public/favicon.ico                     (16+32+48 multi-size ICO)
  android/app/src/main/res/mipmap-*/ic_launcher.png + ic_launcher_round.png
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png (adaptive)
  android/app/src/main/res/values/ic_launcher_background.xml
  android/app/src/main/res/drawable/splash.png
"""
from pathlib import Path
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "branding" / "luma-icon-source.png"
PUB = ROOT / "public"
ICONS = PUB / "icons"
ICONS.mkdir(parents=True, exist_ok=True)

master = Image.open(SRC).convert("RGBA")

# ------------------------------------------------------------------ web icons
WEB_SIZES = [16, 32, 48, 64, 128, 192, 256, 384, 512, 1024]


def rounded(img: Image.Image, radius_ratio: float = 0.2237) -> Image.Image:
    """Apply the iOS/Android style squircle-ish rounded mask."""
    w, h = img.size
    r = int(min(w, h) * radius_ratio)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


for s in WEB_SIZES:
    resized = master.resize((s, s), Image.LANCZOS)
    # Store the artwork square: the source already reads as an app icon, and a
    # full-bleed square avoids double-rounding artefacts on every platform.
    resized.save(ICONS / f"icon-{s}.png", optimize=True)

(fav := ICONS / "favicon-64.png") and master.resize((64, 64), Image.LANCZOS).save(
    fav, optimize=True
)

# Apple touch icon: opaque (iOS composites black behind transparency)
apple = master.resize((180, 180), Image.LANCZOS).convert("RGB")
apple.save(ICONS / "apple-touch-icon.png", optimize=True)

# Maskable icon: safe zone is the inner 80% — pad the art so nothing is clipped.
mask_size = 512
inner = int(mask_size * 0.78)
canvas = Image.new("RGBA", (mask_size, mask_size), (11, 7, 22, 255))
art = master.resize((inner, inner), Image.LANCZOS)
canvas.paste(art, ((mask_size - inner) // 2, (mask_size - inner) // 2), art)
canvas.convert("RGB").save(ICONS / "maskable-512.png", optimize=True)

# Multi-resolution favicon.ico
ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
master.resize((256, 256), Image.LANCZOS).save(
    PUB / "favicon.ico", format="ICO", sizes=ico_sizes
)

# Social / OpenGraph card
og = Image.new("RGB", (1200, 630), (11, 7, 22))
art = master.resize((360, 360), Image.LANCZOS)
og.paste(art, (108, 135), art)
og.save(PUB / "og-image.png", optimize=True)

# ---------------------------------------------------------------- android res
RES = ROOT / "android" / "app" / "src" / "main" / "res"
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

if RES.exists():
    for density, size in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)

        # Legacy launcher icon (already rounded by the artwork itself)
        launcher = master.resize((size, size), Image.LANCZOS)
        launcher.save(folder / "ic_launcher.png", optimize=True)

        # Round variant
        sq = master.resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        rnd = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rnd.paste(sq, (0, 0), mask)
        rnd.save(folder / "ic_launcher_round.png", optimize=True)

        # Adaptive foreground: 108dp canvas, art confined to the 66dp safe circle.
        fg_size = int(size * 108 / 48)
        fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        art_size = int(fg_size * 0.62)
        art = master.resize((art_size, art_size), Image.LANCZOS)
        # Only the bubble matters for the adaptive layer; drop the dark plate by
        # keeping the art but scaling it to sit inside the safe zone.
        fg.paste(art, ((fg_size - art_size) // 2, (fg_size - art_size) // 2), art)
        fg.save(folder / "ic_launcher_foreground.png", optimize=True)

        # Splash / window background art
        drawable = RES / "drawable"
        drawable.mkdir(parents=True, exist_ok=True)

    # values/ic_launcher_background.xml
    values = RES / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#0B0716</color>\n'
        '    <color name="luma_splash_background">#0B0716</color>\n'
        "</resources>\n"
    )

    # Splash artwork for the launch theme (bitmap centred on #0B0716)
    for density, size in DENSITIES.items():
        drawable_dir = RES / f"drawable-{density}"
        drawable_dir.mkdir(parents=True, exist_ok=True)
        splash = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
        logo = master.resize((int(size * 2.4), int(size * 2.4)), Image.LANCZOS)
        splash.paste(
            logo,
            ((splash.width - logo.width) // 2, (splash.height - logo.height) // 2),
            logo,
        )
        splash.save(drawable_dir / "splash_luma.png", optimize=True)

print("Icons generated:")
for p in sorted(ICONS.iterdir()):
    print("  public/icons/" + p.name)
print("  public/favicon.ico")
print("  public/og-image.png")
if RES.exists():
    print("  android/app/src/main/res/** (launcher, round, adaptive, splash)")
