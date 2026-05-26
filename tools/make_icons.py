#!/usr/bin/env python3
"""Generate the PWA icons (pure stdlib, no Pillow).

Draws a simple front-of-train glyph on a solid theme background and writes
icon-512.png, icon-192.png and apple-touch-icon.png (180px) to the repo root.
Re-run after tweaking colours/shape: `python3 tools/make_icons.py`.
"""
import struct
import zlib
import os

BG = (11, 31, 23)        # #0b1f17  app theme (dark green)
BODY = (245, 247, 250)   # #f5f7fa  train body (off-white)
GLASS = (47, 111, 176)   # #2f6fb0  windscreen
STRIPE = (31, 143, 95)   # #1f8f5f  cab stripe (accent green)
LIGHT = (255, 209, 102)  # #ffd166  headlights
SKIRT = (42, 49, 56)     # #2a3138  underframe / wheels


def new_canvas(n, color):
    return bytearray(color * (n * n))


def set_px(buf, n, x, y, color):
    if 0 <= x < n and 0 <= y < n:
        i = (y * n + x) * 3
        buf[i:i + 3] = bytes(color)


def fill_rect(buf, n, x0, y0, x1, y1, color):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            set_px(buf, n, x, y, color)


def fill_rrect(buf, n, x0, y0, x1, y1, color, r):
    x0, y0, x1, y1, r = int(x0), int(y0), int(x1), int(y1), int(r)
    for y in range(y0, y1):
        for x in range(x0, x1):
            # corner clipping
            cx = cy = None
            if x < x0 + r and y < y0 + r:
                cx, cy = x0 + r, y0 + r
            elif x >= x1 - r and y < y0 + r:
                cx, cy = x1 - r - 1, y0 + r
            elif x < x0 + r and y >= y1 - r:
                cx, cy = x0 + r, y1 - r - 1
            elif x >= x1 - r and y >= y1 - r:
                cx, cy = x1 - r - 1, y1 - r - 1
            if cx is not None:
                if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                    continue
            set_px(buf, n, x, y, color)


def draw_train(buf, n):
    s = float(n)
    # body
    fill_rrect(buf, n, 0.22 * s, 0.18 * s, 0.78 * s, 0.84 * s, BODY, 0.11 * s)
    # windscreen (two panes split by a centre pillar)
    fill_rrect(buf, n, 0.295 * s, 0.30 * s, 0.475 * s, 0.47 * s, GLASS, 0.03 * s)
    fill_rrect(buf, n, 0.525 * s, 0.30 * s, 0.705 * s, 0.47 * s, GLASS, 0.03 * s)
    # cab stripe
    fill_rect(buf, n, 0.22 * s, 0.515 * s, 0.78 * s, 0.575 * s, STRIPE)
    # headlights
    fill_rrect(buf, n, 0.30 * s, 0.63 * s, 0.39 * s, 0.71 * s, LIGHT, 0.02 * s)
    fill_rrect(buf, n, 0.61 * s, 0.63 * s, 0.70 * s, 0.71 * s, LIGHT, 0.02 * s)
    # underframe + wheels
    fill_rect(buf, n, 0.26 * s, 0.84 * s, 0.74 * s, 0.875 * s, SKIRT)
    fill_rrect(buf, n, 0.30 * s, 0.855 * s, 0.40 * s, 0.91 * s, SKIRT, 0.04 * s)
    fill_rrect(buf, n, 0.60 * s, 0.855 * s, 0.70 * s, 0.91 * s, SKIRT, 0.04 * s)


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
    buf = new_canvas(n, BG)
    draw_train(buf, n)
    write_png(path, n, buf)
    print("wrote", path, f"({n}x{n})")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    make(os.path.join(root, "icon-512.png"), 512)
    make(os.path.join(root, "icon-192.png"), 192)
    make(os.path.join(root, "apple-touch-icon.png"), 180)
