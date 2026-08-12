#!/usr/bin/env python3
"""Génère icon-*-maskable.png avec safe-zone (padding 12%)."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "web" / "public"

for size, out_name in [(192, "icon-192-maskable.png"), (512, "icon-512-maskable.png")]:
    src = Image.open(ROOT / f"icon-{size}.png").convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (255, 0, 51, 255))
    pad = int(size * 0.12)
    inner = size - pad * 2
    resized = src.resize((inner, inner), Image.Resampling.LANCZOS)
    canvas.paste(resized, (pad, pad), resized)
    canvas.save(ROOT / out_name)
    print("wrote", out_name)
