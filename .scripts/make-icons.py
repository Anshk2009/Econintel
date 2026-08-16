#!/usr/bin/env python3
"""Generate the PNG icon set from the same geometry as favicon.svg.

WHY THIS EXISTS: iOS home-screen icons and Android/PWA manifest icons must be
PNG — neither accepts SVG. This machine has no Pillow/cairosvg, and adding an
image dependency for four flat-colour images would be silly, so this writes PNGs
directly using only the standard library (zlib + struct).

The artwork is rectangles on a gradient, so there is nothing here that needs a
font or a rasteriser. Edges are smoothed by supersampling 4x and box-downsampling.

Run:  python .scripts/make-icons.py
Outputs (repo root): apple-touch-icon.png, icon-192.png, icon-512.png, favicon-32.png
Re-run only if favicon.svg's geometry or colours change.
"""
import zlib, struct, os

SS = 4  # supersample factor — 4x then average gives clean anti-aliased edges

# Brand gradient, matching favicon.svg (#5b8def -> #7a5bff on the diagonal).
C0 = (0x5b, 0x8d, 0xef)
C1 = (0x7a, 0x5b, 0xff)
WHITE = (255, 255, 255)

# The four "chart grid" blocks, in the 32-unit coordinate system of favicon.svg:
# (x, y, w, h, corner_radius)
BLOCKS = [
    (7,  7,  5, 5, 0.8),
    (18, 7,  7, 7, 1.4),
    (18, 18, 7, 7, 1.4),
    (7,  18, 5, 7, 0.8),
]
GRID = 32.0


def in_rounded_rect(px, py, x, y, w, h, r):
    """True if point (px,py) lies inside a rounded rectangle."""
    if px < x or px > x + w or py < y or py > y + h:
        return False
    # Inside the straight-edge cross section?
    if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
        return True
    # Otherwise it must fall within one of the four corner circles.
    for cx, cy in ((x + r, y + r), (x + w - r, y + r), (x + r, y + h - r), (x + w - r, y + h - r)):
        if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
            return True
    return False


def render(size, tile_radius_units):
    """Render one icon at `size` px. tile_radius_units is the background corner
    radius in 32-unit space (0 = full bleed, which is what iOS wants since it
    applies its own mask and would otherwise double-round the corners)."""
    big = size * SS
    scale = big / GRID
    rows = []
    for yy in range(big):
        row = bytearray()
        for xx in range(big):
            # Convert pixel centre into 32-unit space.
            ux = (xx + 0.5) / scale
            uy = (yy + 0.5) / scale

            # Outside the (optionally rounded) tile => transparent-ish edge.
            # We keep it opaque by painting the gradient anyway when radius is 0.
            if tile_radius_units > 0 and not in_rounded_rect(ux, uy, 0, 0, GRID, GRID, tile_radius_units):
                row += bytes(WHITE)          # corners get overwritten by alpha below
                continue

            # Diagonal gradient: t runs 0->1 across the top-left/bottom-right axis.
            t = (ux + uy) / (2 * GRID)
            px = tuple(round(C0[i] + (C1[i] - C0[i]) * t) for i in range(3))

            for (bx, by, bw, bh, br) in BLOCKS:
                if in_rounded_rect(ux, uy, bx, by, bw, bh, br):
                    px = WHITE
                    break
            row += bytes(px)
        rows.append(row)

    # Box-downsample the supersampled buffer back to `size`.
    out = []
    for y in range(size):
        line = bytearray()
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                src = rows[y * SS + dy]
                for dx in range(SS):
                    i = (x * SS + dx) * 3
                    r += src[i]; g += src[i + 1]; b += src[i + 2]
            n = SS * SS
            line += bytes((r // n, g // n, b // n))
        out.append(bytes(line))
    return out


def write_png(path, rows, size):
    """Minimal PNG writer: 8-bit RGB, no interlace."""
    raw = b''.join(b'\x00' + r for r in rows)          # filter byte 0 per scanline

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
targets = [
    # (filename, px, tile corner radius in 32-unit space)
    ('apple-touch-icon.png', 180, 0),   # iOS masks corners itself -> full bleed
    ('icon-192.png',         192, 0),   # PWA manifest / Android
    ('icon-512.png',         512, 0),   # PWA splash + install prompt
    # Legacy tab icon, full bleed. NOT rounded: this writer emits RGB with no
    # alpha channel, so rounded corners would have to be painted a solid colour
    # and would show as white notches on a dark browser tab. Modern browsers take
    # favicon.svg (which does have real rounded corners); this is only the
    # fallback for ones that don't support SVG icons.
    ('favicon-32.png',        32, 0),
]
for name, size, radius in targets:
    path = os.path.join(root, name)
    n = write_png(path, render(size, radius), size)
    print(f'{name:24} {size}x{size}  {n/1024:.1f} KB')
