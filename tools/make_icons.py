#!/usr/bin/env python3
"""Generate the PWA icons (pure stdlib, no Pillow).

Draws a sleek green front-of-train glyph on a black background (with a subtle
green glow and a glossy body gradient) and writes icon-512.png, icon-192.png
and apple-touch-icon.png (180px) to the repo root.
Re-run after tweaking colours/shape: `python3 tools/make_icons.py`.
"""
import struct
import zlib
import os
import math

BG = (5, 9, 7)           # near-black background
GLOW = (24, 150, 92)     # green glow behind the train
BODY_TOP = (78, 240, 150)    # bright green (top of body gradient)
BODY_BOT = (12, 120, 66)     # deep green (bottom of body gradient)
GLASS = (6, 18, 14)      # dark windscreen visor
RIM = (150, 255, 200)    # bright mint rim / highlights
LIGHT = (210, 255, 230)  # headlights
SKIRT = (7, 26, 18)      # underframe / wheels


def lerp(a, b, t):
    return (int(a[0] + (b[0] - a[0]) * t),
            int(a[1] + (b[1] - a[1]) * t),
            int(a[2] + (b[2] - a[2]) * t))


def new_canvas(n):
    """Black canvas with a soft radial green glow centred a little high."""
    buf = bytearray(n * n * 3)
    cx, cy = n * 0.5, n * 0.46
    maxd = n * 0.62
    for y in range(n):
        for x in range(n):
            d = math.hypot(x - cx, y - cy)
            t = max(0.0, 1.0 - d / maxd)
            col = lerp(BG, GLOW, t * t * 0.28)
            i = (y * n + x) * 3
            buf[i:i + 3] = bytes(col)
    return buf


def set_px(buf, n, x, y, color):
    if 0 <= x < n and 0 <= y < n:
        i = (y * n + x) * 3
        buf[i:i + 3] = bytes(color)


def _corner_clipped(x, y, x0, y0, x1, y1, rt, rb):
    """True if pixel falls outside a rounded corner (rt top, rb bottom)."""
    cx = cy = r = None
    if x < x0 + rt and y < y0 + rt:
        cx, cy, r = x0 + rt, y0 + rt, rt
    elif x >= x1 - rt and y < y0 + rt:
        cx, cy, r = x1 - rt - 1, y0 + rt, rt
    elif x < x0 + rb and y >= y1 - rb:
        cx, cy, r = x0 + rb, y1 - rb - 1, rb
    elif x >= x1 - rb and y >= y1 - rb:
        cx, cy, r = x1 - rb - 1, y1 - rb - 1, rb
    if cx is None:
        return False
    return (x - cx) ** 2 + (y - cy) ** 2 > r * r


def fill_rrect(buf, n, x0, y0, x1, y1, color, r):
    fill_rrect_grad(buf, n, x0, y0, x1, y1, color, color, r, r)


def fill_rrect_grad(buf, n, x0, y0, x1, y1, c_top, c_bot, rt, rb=None):
    x0, y0, x1, y1, rt = int(x0), int(y0), int(x1), int(y1), int(rt)
    rb = int(rb if rb is not None else rt)
    span = max(1, y1 - y0)
    for y in range(y0, y1):
        col = lerp(c_top, c_bot, (y - y0) / span)
        for x in range(x0, x1):
            if _corner_clipped(x, y, x0, y0, x1, y1, rt, rb):
                continue
            set_px(buf, n, x, y, col)


def draw_train(buf, n):
    s = float(n)
    # aerodynamic body: rounded, very round on top, slight at the base
    fill_rrect_grad(buf, n, 0.21 * s, 0.15 * s, 0.79 * s, 0.85 * s,
                    BODY_TOP, BODY_BOT, 0.19 * s, 0.09 * s)
    # wraparound windscreen visor
    fill_rrect(buf, n, 0.29 * s, 0.26 * s, 0.71 * s, 0.45 * s, GLASS, 0.06 * s)
    # bright rim line just under the visor
    fill_rrect(buf, n, 0.30 * s, 0.475 * s, 0.70 * s, 0.50 * s, RIM, 0.012 * s)
    # twin LED headlight strips
    fill_rrect(buf, n, 0.30 * s, 0.60 * s, 0.43 * s, 0.645 * s, LIGHT, 0.018 * s)
    fill_rrect(buf, n, 0.57 * s, 0.60 * s, 0.70 * s, 0.645 * s, LIGHT, 0.018 * s)
    # darker skirt + two bogies peeking below
    fill_rrect(buf, n, 0.25 * s, 0.80 * s, 0.75 * s, 0.85 * s, SKIRT, 0.02 * s)
    fill_rrect(buf, n, 0.30 * s, 0.845 * s, 0.41 * s, 0.90 * s, SKIRT, 0.04 * s)
    fill_rrect(buf, n, 0.59 * s, 0.845 * s, 0.70 * s, 0.90 * s, SKIRT, 0.04 * s)


def write_png(path, n, buf):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = bytearray()
    for y in range(n):
        raw.append(0)  # filter type 0
        raw += buf[y * n * 3:(y + 1) * n * 3]
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def make(path, n):
    buf = new_canvas(n)
    draw_train(buf, n)
    write_png(path, n, buf)
    print("wrote", path, f"({n}x{n})")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    make(os.path.join(root, "icon-512.png"), 512)
    make(os.path.join(root, "icon-192.png"), 192)
    make(os.path.join(root, "apple-touch-icon.png"), 180)
