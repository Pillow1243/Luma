#!/usr/bin/env python3
"""Materialise the framework-only Android shell resources from the master icon."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "branding" / "luma-icon-source.png"
RES = ROOT / "mobile" / "apk-shell" / "res"
master = Image.open(SRC).convert("RGBA")
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

for d, size in DENS.items():
    mip = RES / f"mipmap-{d}"; mip.mkdir(parents=True, exist_ok=True)
    art = master.resize((size, size), Image.LANCZOS)
    art.save(mip / "ic_launcher.png", optimize=True)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    rnd = Image.new("RGBA", (size, size), (11, 7, 22, 255))
    rnd.paste(art, (0, 0), mask)
    rnd.save(mip / "ic_launcher_round.png", optimize=True)

    fg = int(round(size * 108 / 48))
    canvas = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
    a = int(fg * 0.60)
    scaled = master.resize((a, a), Image.LANCZOS)
    canvas.paste(scaled, ((fg - a) // 2, (fg - a) // 2), scaled)
    canvas.save(mip / "ic_launcher_foreground.png", optimize=True)

    dr = RES / f"drawable-{d}"; dr.mkdir(parents=True, exist_ok=True)
    logo = master.resize((int(size * 2.6), int(size * 2.6)), Image.LANCZOS)
    logo.save(dr / "splash_luma.png", optimize=True)

(RES / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/luma_ink" />\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
            '</adaptive-icon>\n')
(RES / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(adaptive)
(RES / "mipmap-anydpi-v26" / "ic_launcher_round.xml").write_text(adaptive)
print("shell resources written")
