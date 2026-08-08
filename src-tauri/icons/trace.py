"""Trace the fold-A artwork (source.png) into the vector paths the three
non-raster brand sites carry:

    python3 src-tauri/icons/trace.py

Prints four path strings in the mark's 0..100 design space (y down):

  outer    the cream ribbon's silhouette
  counter  the dark counter inside it (the second, even-odd subpath)
  flap     the plum underside of the fold
  star     centre + radius of the gold four-point spark (drawn ideal, not
           traced — at favicon sizes a traced 2-unit star is just noise)

The counter is not a hole in the cream alone: it is closed jointly by the
cream curl and the flap's top edge, with a dark crease between them. So the
hole is found on the closed (dilate-erode) cream-union-flap mask, and the
cream path is filled even-odd with that hole as its second subpath, drawn
OVER the flap: where the hole overlaps the flap, the flap shows through,
which is exactly the plum lip the artwork has along the counter's bottom.

Pipeline per region: colour threshold -> morphological clean -> largest
component -> Moore boundary trace -> Douglas-Peucker (split at two extreme
points; D-P on an unsplit closed loop degenerates) -> Chaikin corner
rounding -> every 2nd point, one decimal.

These are sampled polygons, the same trick public/logo.svg already used for
its superellipse tile: at the 26..64px the mark renders at, a 90-point
polygon is indistinguishable from the artwork's true curve.
"""
import json
import math
import os
from collections import deque

from PIL import Image, ImageChops, ImageFilter

N = 600
OUT = os.path.dirname(os.path.abspath(__file__))


def masks():
    src = Image.open(os.path.join(OUT, "source.png")).convert("RGB").resize((N, N), Image.LANCZOS)
    px = src.load()

    def mask_of(pred):
        m = Image.new("L", (N, N), 0)
        mp = m.load()
        for y in range(N):
            for x in range(N):
                r, g, b = px[x, y]
                if pred(r, g, b):
                    mp[x, y] = 255
        return m

    def clean(m):
        return m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))

    cream = clean(mask_of(lambda r, g, b: r > 140 and g > 130 and b > 105 and (r - b) < 85))
    pink = clean(mask_of(lambda r, g, b: r > 85 and (r - g) > 35 and b > g and g < 130))
    gold = clean(mask_of(lambda r, g, b: r > 165 and g > 135 and b < 155 and (r - b) > 60 and g > b))
    return cream, pink, gold


def grid(m):
    p = m.load()
    return [[1 if p[x, y] else 0 for x in range(N)] for y in range(N)]


def largest_component(g):
    seen = [[0] * N for _ in range(N)]
    best = []
    for y0 in range(N):
        for x0 in range(N):
            if g[y0][x0] and not seen[y0][x0]:
                comp = []
                q = deque([(x0, y0)])
                seen[y0][x0] = 1
                while q:
                    x, y = q.popleft()
                    comp.append((x, y))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < N and 0 <= ny < N and g[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = 1
                            q.append((nx, ny))
                if len(comp) > len(best):
                    best = comp
    out = [[0] * N for _ in range(N)]
    for x, y in best:
        out[y][x] = 1
    return out


def largest_hole(g):
    seen = [[0] * N for _ in range(N)]
    best = []
    for y0 in range(N):
        for x0 in range(N):
            if not g[y0][x0] and not seen[y0][x0]:
                comp = []
                touches = False
                q = deque([(x0, y0)])
                seen[y0][x0] = 1
                while q:
                    x, y = q.popleft()
                    comp.append((x, y))
                    if x in (0, N - 1) or y in (0, N - 1):
                        touches = True
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < N and 0 <= ny < N and not g[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = 1
                            q.append((nx, ny))
                if not touches and len(comp) > len(best):
                    best = comp
    out = [[0] * N for _ in range(N)]
    for x, y in best:
        out[y][x] = 1
    return out


def boundary(g, what):
    """Moore-neighbour boundary trace, clockwise.

    The scan anchor is the last OFF cell examined (proper Moore), not the
    previous boundary pixel — anchoring on the previous pixel wanders into
    the interior and closes a false three-pixel loop. Terminates on Jacob's
    criterion: the start pixel revisited with the same anchor.
    """
    start = None
    for y in range(N):
        for x in range(N):
            if g[y][x]:
                start = (x, y)
                break
        if start:
            break
    if start is None:
        raise RuntimeError(f"empty region: {what}")
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]

    def at(p):
        x, y = p
        return 0 <= x < N and 0 <= y < N and g[y][x]

    def dir_index(frm, to):
        d = (to[0] - frm[0], to[1] - frm[1])
        return dirs.index(d)

    # start was found by raster scan, so its west neighbour is off
    b0 = (start[0] - 1, start[1])
    cur, b = start, b0
    pts = [start]
    for _ in range(8 * N * N):
        d0 = dir_index(cur, b)
        nxt = None
        for k in range(1, 9):
            d = (d0 + k) % 8
            cand = (cur[0] + dirs[d][0], cur[1] + dirs[d][1])
            if at(cand):
                nxt = cand
                b = (cur[0] + dirs[(d0 + k - 1) % 8][0], cur[1] + dirs[(d0 + k - 1) % 8][1])
                break
        if nxt is None:
            break  # isolated pixel
        cur = nxt
        if cur == start and b == b0:
            break
        pts.append(cur)
    return pts


def dp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dmax, idx = 0, 0
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1e-9
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x1) - dx * (pts[i][1] - y1)) / L
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        a = dp(pts[: idx + 1], eps)
        b = dp(pts[idx:], eps)
        return a[:-1] + b
    return [pts[0], pts[-1]]


def simplify_closed(pts, eps):
    """D-P a closed loop by splitting it at two mutually-far points.

    Running D-P on the loop closed back to its own start degenerates: the
    chord has zero length, every distance reads 0, and the whole boundary
    collapses to two points.
    """
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    k = max(range(len(pts)), key=lambda i: (pts[i][0] - cx) ** 2 + (pts[i][1] - cy) ** 2)
    pts = pts[k:] + pts[:k]
    m = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a = dp(pts[: m + 1], eps)
    b = dp(pts[m:] + [pts[0]], eps)
    return a[:-1] + b[:-1]


def chaikin(pts, it=2):
    for _ in range(it):
        out = []
        n = len(pts)
        for i in range(n):
            p, q = pts[i], pts[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        pts = out
    return pts


def path_of(pts):
    def f(v):
        s = f"{v:.1f}"
        return s[:-2] if s.endswith(".0") else s

    return "M" + "L".join(f"{f(x / N * 100)} {f(y / N * 100)}" for x, y in pts) + "Z"


if __name__ == "__main__":
    cream, pink, gold = masks()
    union = ImageChops.lighter(cream, pink)
    closed = union.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))

    cg = largest_component(grid(cream))
    hole = largest_hole(grid(closed))
    pg = largest_component(grid(pink))

    # The cream region is NOT an annulus: the dark crease between the curl
    # and the flap connects the counter to the outside, so the cream's own
    # boundary slips in through that slot and walks the counter's rim — and
    # a path that already excludes the counter plus an explicit counter
    # subpath re-FILLS it under even-odd. The body silhouette is therefore
    # traced from cream + the counter hole (dilated a touch so the closing
    # erosion cannot leave a separating dark ring): one simple loop that
    # encloses the counter, which the counter subpath then punches once.
    def img_of(g):
        m = Image.new("L", (N, N), 0)
        mp = m.load()
        for y in range(N):
            for x in range(N):
                if g[y][x]:
                    mp[x, y] = 255
        return m

    body = ImageChops.lighter(img_of(cg), img_of(hole).filter(ImageFilter.MaxFilter(7)))
    bg = largest_component(grid(body))

    out = {}
    for name, g in [("outer", bg), ("counter", hole), ("flap", pg)]:
        pts = chaikin(simplify_closed(boundary(g, name), 2.0))[::2]
        out[name] = path_of(pts)

    gp = gold.load()
    xs = [x for y in range(N) for x in range(N) if gp[x, y]]
    ys = [y for y in range(N) for x in range(N) if gp[x, y]]
    out["star"] = {
        "cx": round((min(xs) + max(xs)) / 2 / N * 100, 1),
        "cy": round((min(ys) + max(ys)) / 2 / N * 100, 1),
        "r": round(max(max(xs) - min(xs), max(ys) - min(ys)) / 2 / N * 100, 1),
    }
    print(json.dumps(out, indent=1))
