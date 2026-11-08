#!/usr/bin/env python3
"""Generate EVERY Android launcher asset from the single master artwork."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "branding" / "luma-icon-source.png"
RES = ROOT / "android" / "app" / "src" / "main" / "res"
master = Image.open(SRC).convert("RGBA")
BG = (11, 7, 22, 255)

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

def circle(img, bg=BG):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, w - 1, h - 1], fill=255)
    out = Image.new("RGBA", (w, h), bg)
    out.paste(img, (0, 0), mask)
    return out

for density, size in DENSITIES.items():
    folder = RES / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)

    # legacy square-ish launcher (artwork already has rounded corners baked in)
    master.resize((size, size), Image.LANCZOS).save(folder / "ic_launcher.png", optimize=True)
    circle(master.resize((size, size), Image.LANCZOS)).save(
        folder / "ic_launcher_round.png", optimize=True
    )

    # adaptive foreground: 108dp canvas, art inside the 66dp safe zone (61%)
    fg = int(round(size * 108 / 48))
    canvas = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
    art = int(fg * 0.60)
    a = master.resize((art, art), Image.LANCZOS)
    canvas.paste(a, ((fg - art) // 2, (fg - art) // 2), a)
    canvas.save(folder / "ic_launcher_foreground.png", optimize=True)

    # splash artwork
    d = RES / f"drawable-{density}"
    d.mkdir(parents=True, exist_ok=True)
    logo = master.resize((int(size * 2.6), int(size * 2.6)), Image.LANCZOS)
    sp = Image.new("RGBA", (logo.width, logo.height), (0, 0, 0, 0))
    sp.paste(logo, (0, 0), logo)
    sp.save(d / "splash_luma.png", optimize=True)

(RES / "values").mkdir(parents=True, exist_ok=True)
(RES / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    '    <color name="ic_launcher_background">#0B0716</color>\n</resources>\n'
)
print("Android launcher assets written for:", ", ".join(DENSITIES))
