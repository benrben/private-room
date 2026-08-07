"""Regenerate the Arcelle application icon set from the marker-x-notebook mark.

    python3 src-tauri/icons/generate.py

Rewrites every PNG in this directory plus icon.icns, document.icns and
icon.ico. Needs only Pillow and macOS iconutil — no SVG renderer is in the
loop, because every shape here is a sampled curve or polygon and PIL draws it
deterministically.

THE MARK — a highlighter swipe on the app's own dark dotted sheet, with the
handwritten Arcelle A drawn over it in cream ink. Swipe first, then the
letter, the way it happens in a real notebook. The band glows (a dark page
cannot be stained), dries in streaks where the tip starved, and doubles where
the pen set down. The letter is the signature A: a sail-curve left stroke,
a re-inked apex, a bowed descender, the crossbar with its short leg — the
whole glyph sitting 1.8 degrees off level, because handwriting does.

Below 48px the tile switches to the MICRO cut: the same object redrawn, not
shrunk — heavier strokes, the band through the letter's waist, no dots, no
texture. macOS picks the member per context, so the Dock gets texture and
the tab bar gets legibility.

This file is the SOURCE OF TRUTH for the mark's geometry. The same
construction appears three more times, always as the 0..100 design-space
numbers below wrapped in a scale transform:

  src/icons/nav.tsx   GLYPH/BAND (+ MICRO), theme ink   - the in-app mark
  index.html          the launch shell, identical paths
  public/logo.svg     the micro cut in a 64 tile        - favicon/standalone

To move the mark, edit the GLYPH / BAND / MICRO constants here, run this
script, and carry the same numbers into those three. If they ever disagree,
this file wins.

The brand lilac is correct HERE and in public/logo.svg only: the interface
carries no violet, so the in-app band is drawn with the product's own
highlighter token (--mk-yellow) and the strokes in theme ink.
"""
import math
import os
import subprocess

from PIL import Image, ImageDraw, ImageFilter

# ---- design space: 0..100, y down -------------------------------------------
# The glyph: chains of cubic beziers, (points, stroke width).
GLYPH = [
    # sail stroke, foot to apex
    ([(20.5, 89), (25, 66), (33, 42), (44, 25.5),
      (48.5, 18.8), (53, 13.4), (57.5, 10.5)], 9.4),
    # re-inked apex, where the pen changed direction
    ([(52.5, 14.5), (54.5, 12.6), (56.2, 11.2), (57.5, 10.5)], 10.6),
    # bowed descender, lands past the sail's baseline
    ([(57.5, 10.5), (60, 26), (63.5, 55), (66.5, 88.5)], 9.0),
    # crossbar and its leg, one gesture in two strokes
    ([(40, 57.5), (49, 56.6), (58, 56.4), (66.8, 57.2)], 7.0),
    ([(40.6, 57.5), (40.2, 66), (40, 76), (40.2, 85.5)], 7.0),
]
GLYPH_TILT = -1.8  # degrees about (50, 50)

# The band: bottom and top edges as single cubics, left to right.
BAND_BOT = [(11, 73.5), (36, 71), (66, 68.6), (90, 67)]
BAND_TOP = [(10.2, 54), (35, 51.6), (65, 49.2), (89.2, 47.5)]
SETDOWN_T = 0.30          # fraction of the band re-inked where the pen landed
BAND_ALPHA = 0.62         # the glow: translucent, the dots stay visible
SETDOWN_ALPHA = 0.35      # extra pass, relative to the band

# Dry streaks where the tip starved: cubics drawn in the ground colour.
STREAKS = [
    ([(22, 68.5), (44, 66.5), (66, 64.5), (84, 63)], 1.5, 0.50),
    ([(30, 63.5), (50, 61.8), (68, 60.2), (86, 58.8)], 1.0, 0.42),
    ([(18, 59.5), (40, 57.8), (60, 56.2), (78, 54.8)], 0.9, 0.30),
]

# Ink pooling where each stroke stops. Cream ink pools BRIGHT on dark.
POOLS = [((21.5, 88), 3.4, 2.6), ((66.2, 87.6), 3.2, 2.6), ((40.4, 84.8), 2.6, 2.2)]

# ---- the micro cut: redrawn for 32 and below, not shrunk ---------------------
MICRO_GLYPH = [
    ([(20, 89), (26, 62), (38, 30), (57, 10)], 12.5),
    ([(57, 10), (61, 30), (65.5, 62), (68, 89)], 12.5),
    ([(39, 58), (48.7, 57.8), (58.3, 57.7), (68, 57.5)], 9.5),
    ([(39.6, 58), (39.6, 67.3), (39.6, 76.7), (39.6, 86)], 9.5),
]
MICRO_BAND_BOT = [(8, 72), (36, 68.5), (68, 65.5), (94, 63.5)]
MICRO_BAND_TOP = [(7, 50), (34, 46.5), (66, 43.5), (92.8, 41)]
MICRO_BAND_ALPHA = 0.75


def bez(pts, n=48):
    """Sample a chain of cubics: pts is 3k+1 control points."""
    out = []
    for s in range(0, len(pts) - 1, 3):
        p0, c1, c2, p3 = pts[s], pts[s + 1], pts[s + 2], pts[s + 3]
        for i in range(n + 1):
            if out and i == 0:
                continue
            t = i / n
            u = 1 - t
            out.append((
                u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
                u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
            ))
    return out


def tilt(pts, deg, cx=50.0, cy=50.0):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c)
            for x, y in pts]


def wobble(pts, amp, f1=3.3, f2=7.1, ph1=0.7, ph2=2.9):
    """Displace a sampled edge vertically with two summed sines.

    Deterministic stand-in for the turbulence-displaced edges of the vector
    mark: the band is near-horizontal, so y-only displacement is stable and
    indistinguishable from a true normal offset at these amplitudes.
    """
    m = len(pts) - 1
    out = []
    for i, (x, y) in enumerate(pts):
        t = i / m
        d = amp * (math.sin(2 * math.pi * f1 * t + ph1)
                   + 0.55 * math.sin(2 * math.pi * f2 * t + ph2))
        out.append((x, y + d))
    return out


OUT = os.path.dirname(os.path.abspath(__file__))

GROUND = (0x15, 0x17, 0x16)          # --page dark: the app's own sheet
LILAC = (0x9A, 0x82, 0xD1)           # the highlighter band (brand accent)
IVORY = (0xF3, 0xF0, 0xE7)           # the cream ink of the letter
POOL = (0xFF, 0xFF, 0xFF, 26)        # ink pooling reads bright on dark
DOT = (0x9A, 0x82, 0xD1, 52)         # the sheet's dotted grid, a whisper of lilac
HAIRLINE = (0xF0, 0xEE, 0xE5, 26)    # edge definition on a dark desktop

# Fractions of the canvas. The body is Apple's 824/1024 icon grid.
BODY = 824 / 1024
RADIUS_N = 5.0        # superellipse exponent: the macOS squircle, near enough
GRID_PITCH = 103 / 1024
GRID_R = 5 / 1024


def squircle(n, cx, cy, a, steps=512):
    """Superellipse |x/a|^n + |y/a|^n = 1 as a polygon."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = math.copysign(abs(ct) ** (2 / n), ct)
        y = math.copysign(abs(st) ** (2 / n), st)
        pts.append((cx + x * a, cy + y * a))
    return pts


def band_poly(bot, top, amp, t0=0.0, t1=1.0, t1_top=None):
    """Closed band polygon between two edges, wobbled, over t0..t1.

    t1_top slants the right-hand cut (the set-down edge) by ending the top
    edge at a different fraction than the bottom one — a marker never lifts
    off square.
    """
    b = wobble(bez(bot), amp, f1=2.2, f2=5.0, ph1=0.7, ph2=2.9)
    t = wobble(bez(top), amp, f1=1.9, f2=4.6, ph1=4.1, ph2=1.3)
    lo_b, hi_b = int(t0 * (len(b) - 1)), int(t1 * (len(b) - 1))
    hi_t = int((t1 if t1_top is None else t1_top) * (len(t) - 1))
    lo_t = int(t0 * (len(t) - 1))
    return b[lo_b:hi_b + 1] + list(reversed(t[lo_t:hi_t + 1]))


class Sheet:
    """One supersampled tile: layered so translucent passes composite."""

    def __init__(self, n, xform):
        self.n = n
        self.xf = xform
        self.img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    def _layer(self):
        return Image.new("RGBA", (self.n, self.n), (0, 0, 0, 0))

    def merge(self, layer):
        self.img = Image.alpha_composite(self.img, layer)

    def poly(self, pts, rgba, layer=None):
        target = layer if layer is not None else self._layer()
        ImageDraw.Draw(target).polygon([self.xf(p) for p in pts], fill=rgba)
        if layer is None:
            self.merge(target)
        return target

    def stroke(self, pts, w_units, rgba):
        """A round stroke, stamped as overlapping circles like a real nib.

        Pillow's joint="curve" polylines throw perpendicular fin artifacts on
        dense near-collinear points; stamping is immune and gives round caps
        for free. Points are re-sampled to quarter-radius spacing first so the
        edge is smooth regardless of the input sampling.
        """
        layer = self._layer()
        dr = ImageDraw.Draw(layer)
        r = max(w_units / 100 * self.scale / 2, 0.75)
        xy = [self.xf(p) for p in pts]
        step = r / 4
        for i in range(len(xy) - 1):
            (x0, y0), (x1, y1) = xy[i], xy[i + 1]
            seg = math.hypot(x1 - x0, y1 - y0)
            k = max(int(seg / step), 1)
            for j in range(k + (1 if i == len(xy) - 2 else 0)):
                t = j / k
                cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgba)
        self.merge(layer)


def tile(size, ss=4, micro=False, dots=True):
    """One icon tile at `size` px, supersampled by `ss`."""
    n = size * ss
    side = BODY * n
    ox = (n - side) / 2

    def xf(p):
        return (ox + p[0] / 100 * side, ox + p[1] / 100 * side)

    sheet = Sheet(n, xf)
    sheet.scale = side
    dr = ImageDraw.Draw(sheet.img)
    a = BODY * n / 2
    poly = squircle(RADIUS_N, n / 2, n / 2, a)
    dr.polygon(poly, fill=GROUND + (255,))

    if dots:
        # Drawn on its own layer and masked by the body, so the grid stops at
        # the tile edge instead of being clipped into half-dots.
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        pitch, r = GRID_PITCH * n, max(GRID_R * n, 0.6)
        k = int(n / pitch) + 2
        for i in range(-k, k):
            for j in range(-k, k):
                cx, cy = n / 2 + i * pitch, n / 2 + j * pitch
                ld.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT)
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        sheet.merge(Image.composite(layer, Image.new("RGBA", (n, n), (0, 0, 0, 0)), mask))

    if micro:
        sheet.poly(band_poly(MICRO_BAND_BOT, MICRO_BAND_TOP, 0.35),
                   LILAC + (int(MICRO_BAND_ALPHA * 255),))
        for pts, w in MICRO_GLYPH:
            sheet.stroke(bez(pts), w, IVORY + (255,))
    else:
        amp = 0.65
        sheet.poly(band_poly(BAND_BOT, BAND_TOP, amp),
                   LILAC + (int(BAND_ALPHA * 255),))
        # the set-down: a second half-pass where the pen landed, lifting off
        # at a slant because a marker never leaves square
        sheet.poly(band_poly(BAND_BOT, BAND_TOP, amp, 0, SETDOWN_T, SETDOWN_T - 0.05),
                   LILAC + (int(BAND_ALPHA * SETDOWN_ALPHA * 255),))
        # dry streaks, in the ground colour, so they read as gaps in the ink
        for pts, w, op in STREAKS:
            sheet.stroke(bez(pts), w, GROUND + (int(op * 255),))
        for pts, w in GLYPH:
            sheet.stroke(tilt(bez(pts), GLYPH_TILT), w, IVORY + (255,))
        pool = sheet._layer()
        pd = ImageDraw.Draw(pool)
        for (cx, cy), rx, ry in POOLS:
            (px, py) = xf(tilt([(cx, cy)], GLYPH_TILT)[0])
            rxp, ryp = rx / 100 * side, ry / 100 * side
            pd.ellipse([px - rxp, py - ryp, px + rxp, py + ryp], fill=POOL)
        sheet.merge(pool)

    body = sheet.img
    dr = ImageDraw.Draw(body)
    dr.line(poly + [poly[0]], fill=HAIRLINE, width=max(int(n / 512), 1))

    # A restrained baked shadow, the way every macOS tile carries one.
    sh = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon(poly, fill=(0, 0, 0, 66))
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


def render(size):
    # Below 48px the full drawing rots into noise — texture is the first
    # casualty of scale — so the small tiles switch to the micro cut: the
    # same object redrawn heavier, not shrunk. The dotted grid needs 64px
    # before a dot gets a whole pixel.
    ss = 8 if size <= 128 else (4 if size <= 512 else 2)
    return tile(size, ss=ss, micro=size <= 32, dots=size >= 64)


if __name__ == "__main__":
    cache = {}
    for name, s in PNGS.items():
        cache.setdefault(s, render(s)).save(os.path.join(OUT, name))
    d = os.path.join(OUT, "icon.iconset")
    os.makedirs(d, exist_ok=True)
    for name, s in ICONSET:
        cache.setdefault(s, render(s)).save(os.path.join(d, name))
    subprocess.run(["iconutil", "-c", "icns", d, "-o", os.path.join(OUT, "icon.icns")], check=True)
    subprocess.run(["cp", os.path.join(OUT, "icon.icns"), os.path.join(OUT, "document.icns")], check=True)
    cache[256].save(os.path.join(OUT, "icon.ico"),
                    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    subprocess.run(["rm", "-rf", d], check=True)
    print("wrote", len(PNGS) + 4, "files")
