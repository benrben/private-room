"""Regenerate the Arcelle application icon set from the fold-A artwork.

    python3 src-tauri/icons/generate.py

Rewrites every PNG in this directory plus icon.icns, document.icns and
icon.ico, all derived from source.png.

THE MARK — the paper fold-A. A cream paper ribbon bent into the letter A,
its bottom edge peeling up to show a plum underside, with a small gold
four-point spark resting in the counter. The tile is the app's own dark
felt sheet with its dotted grid and a stitched hairline border. Unlike the
previous marker-x-notebook mark, this one is ARTWORK, not construction:
source.png is the single source of truth and everything here is honest
resampling of it — no procedural redraw, no micro cut.

source.png is the pasted brand art (2026-08-09) with the pure-black margin
outside the tile flood-filled to transparency (threshold sum<=24, which
stays below the tile's own antialiased edge ramp) and the alpha softened by
a 1px gaussian, so the tile composites cleanly on light desktops too.

The tile occupies Apple's 824/1024 icon grid inside each canvas, and every
size carries the same restrained baked shadow every macOS tile carries.

The same mark appears three more times, as traced vector paths in a 0..100
design space (see trace.py, which derives them from source.png):

  src/icons/nav.tsx   the in-app logomark, theme ink + token accents
  index.html          the launch shell, identical paths
  public/logo.svg     the favicon / standalone tile, literal colours

To change the mark: replace source.png, run this script, re-run trace.py
and carry its paths into those three. If they ever disagree, source.png wins.
"""
import os
import subprocess

from PIL import Image, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))

# Fraction of the canvas the tile occupies: Apple's 824/1024 icon grid.
BODY = 824 / 1024

SOURCE = Image.open(os.path.join(OUT, "source.png")).convert("RGBA")


def tile(size):
    """One icon tile at `size` px: the artwork on the 824 grid + baked shadow."""
    n = size * 4  # supersample so the shadow and edge stay smooth when small
    side = round(BODY * n)
    ox = (n - side) // 2
    art = SOURCE.resize((side, side), Image.LANCZOS)

    body = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    body.paste(art, (ox, ox), art)

    # A restrained baked shadow, the way every macOS tile carries one.
    alpha = body.getchannel("A").point(lambda a: a * 66 // 255)
    sh = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    sh.putalpha(alpha)
    sh = sh.transform((n, n), Image.AFFINE, (1, 0, 0, 0, 1, -0.012 * n))
    sh = sh.filter(ImageFilter.GaussianBlur(0.022 * n))
    out = Image.alpha_composite(sh, body)
    return out.resize((size, size), Image.LANCZOS)


PNGS = {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128,
    "128x128@2x.png": 256, "icon.png": 512,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310, "StoreLogo.png": 50,
}
ICONSET = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]


if __name__ == "__main__":
    cache = {}
    for name, s in PNGS.items():
        cache.setdefault(s, tile(s)).save(os.path.join(OUT, name))
    d = os.path.join(OUT, "icon.iconset")
    os.makedirs(d, exist_ok=True)
    for name, s in ICONSET:
        cache.setdefault(s, tile(s)).save(os.path.join(d, name))
    subprocess.run(["iconutil", "-c", "icns", d, "-o", os.path.join(OUT, "icon.icns")], check=True)
    subprocess.run(["cp", os.path.join(OUT, "icon.icns"), os.path.join(OUT, "document.icns")], check=True)
    cache[256].save(os.path.join(OUT, "icon.ico"),
                    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    subprocess.run(["rm", "-rf", d], check=True)
    print("wrote", len(PNGS) + 4, "files")
