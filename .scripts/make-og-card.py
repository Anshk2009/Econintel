#!/usr/bin/env python3
"""Generate og.png — the 1200x630 card every page's og:image points at.

WHY A SCRIPT AND NOT A ONE-OFF EXPORT: the tagline and the wordmark will change,
and a card that can only be remade by hand gets left stale. This regenerates it
from the same colours and the same typeface the site uses, so the card cannot
silently drift away from the brand the way the old stock globe did.

UNLIKE make-icons.py THIS NEEDS DEPENDENCIES. That file is deliberately
stdlib-only because it draws rectangles; this one sets real type in a real
typeface, which is not a thing to hand-roll. It is a DESIGN-TIME tool — nothing
in CI runs it, nothing at build time runs it (there is no build), and the output
PNG is committed. Install only when you need to regenerate:

    pip install pillow fonttools brotli
    python .scripts/make-og-card.py

Fonts are fetched from Google Fonts at run time rather than vendored, so the
card always uses the same version the site serves.

WHAT THE LAYOUT IS SOLVING (do not "simplify" these away):
  * 31px tagline — Discord renders this card about 400px wide in a narrow
    window, which puts the tagline near 10px. Below roughly 8px it turns to
    mush, so this is the floor, not a preference.
  * everything inside the centred square — WhatsApp crops toward centre-square.
    Content outside x 285..915 is simply gone there.
  * the inset hairline + the radial lift — a #050508 card sits inside Discord's
    #2B2D31 panel and otherwise looks edgeless, bleeding into the chrome.
  * gradient runs indigo -> sky — the dark-ground ramp. The light-ground ramp
    ends on #404BA0, which is 2.65:1 here and would sink into the card.
"""
import io
import math
import urllib.request

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
GROUND = (5, 6, 8)            # #050508 — the site's own ground
LIFT = (12, 14, 23)           # #0C0E17 — a barely-there radial so it is not flat black
RAMP = [(0.0, (0x63, 0x66, 0xF1)),   # indigo
        (0.5, (0x3B, 0x82, 0xF6)),   # blue
        (1.0, (0x0E, 0xA5, 0xE9))]   # sky
FRAME_INSET, FRAME_RADIUS = 40, 6
WORDMARK, TAGLINE = "EconIntel", "STRUCTURED REASONING, NOT NEWS"
WM_PX, TAG_PX, TRACKING = 104, 31, 0.08   # tracking in em

# THE SQUARE CROP IS WHAT SETS THE TRACKING. WhatsApp keeps only a centred
# 630x630, i.e. x 285..915. At 31px the tagline is 665px wide with 0.14em
# tracking and loses a word at each end there; 0.08em brings it to 611px, which
# clears the crop with ~9px a side. Dropping the SIZE instead would have been
# the wrong trade — 31px is already the floor at Discord's rendered width.
CROP_L, CROP_R = 285, 915


def google_font(css_url, ua="Mozilla/4.0"):
    """Fetch a TTF from Google Fonts. The old user-agent matters: modern ones
    get woff2, which Pillow cannot read."""
    req = urllib.request.Request(css_url, headers={"User-Agent": ua})
    css = urllib.request.urlopen(req).read().decode()
    url = css.split("url(")[1].split(")")[0]
    return io.BytesIO(urllib.request.urlopen(url).read())


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def ramp_at(t):
    """Colour at position t (0..1) along the three-stop ramp."""
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(RAMP, RAMP[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return RAMP[-1][1]


def draw_tracked(draw, xy, text, font, fill, tracking_px):
    """Pillow has no letter-spacing, and the tagline needs it to read as a label
    rather than a sentence. Draw glyph by glyph."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking_px


def tracked_width(draw, text, font, tracking_px):
    return sum(draw.textlength(c, font=font) for c in text) + tracking_px * (len(text) - 1)


def main():
    serif = ImageFont.truetype(
        google_font("https://fonts.googleapis.com/css?family=Old+Standard+TT:700"), WM_PX)
    sans = ImageFont.truetype(
        google_font("https://fonts.googleapis.com/css?family=DM+Sans:400"), TAG_PX)

    # ── ground: radial lift from the top centre, falling off to flat ──────────
    card = Image.new("RGB", (W, H), GROUND)
    px = card.load()
    cx, cy, R = W / 2, 0.0, 760.0
    for y in range(H):
        for x in range(0, W, 2):                     # every 2nd column, then smear
            d = math.hypot(x - cx, y - cy) / R
            c = lerp(LIFT, GROUND, min(d, 1.0) ** 0.85)
            px[x, y] = c
            if x + 1 < W:
                px[x + 1, y] = c

    draw = ImageDraw.Draw(card)

    # ── measure, then centre the whole stack ─────────────────────────────────
    wm_box = draw.textbbox((0, 0), WORDMARK, font=serif)
    wm_w, wm_h = wm_box[2] - wm_box[0], wm_box[3] - wm_box[1]
    track_px = TAG_PX * TRACKING
    tag_w = tracked_width(draw, TAGLINE, sans, track_px)
    tag_h = draw.textbbox((0, 0), TAGLINE, font=sans)[3]

    gap, rule_w = 30, 132
    total = wm_h + gap + 1 + gap + tag_h
    top = (H - total) / 2

    # ── wordmark, gradient clipped to the glyphs ─────────────────────────────
    # Render the text into a mask, build a ramp only as wide as the text (a ramp
    # across the full canvas would barely vary over 9 characters), composite.
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).text(((W - wm_w) / 2 - wm_box[0], top - wm_box[1]),
                              WORDMARK, font=serif, fill=255)
    grad = Image.new("RGB", (W, H), RAMP[0][1])
    gpx = grad.load()
    x0, x1 = (W - wm_w) / 2, (W + wm_w) / 2
    for x in range(W):
        c = ramp_at((x - x0) / (x1 - x0))
        for y in range(H):
            gpx[x, y] = c
    card.paste(grad, (0, 0), mask)

    # ── hairline rule ────────────────────────────────────────────────────────
    ry = int(top + wm_h + gap)
    for i in range(rule_w):
        t = i / (rule_w - 1)
        a = math.sin(t * math.pi) * 0.5                # fades out at both ends
        base = card.getpixel((int(W / 2 - rule_w / 2 + i), ry))
        draw.point((int(W / 2 - rule_w / 2 + i), ry), fill=lerp(base, (110, 150, 255), a))

    # ── tagline ──────────────────────────────────────────────────────────────
    draw_tracked(draw, ((W - tag_w) / 2, ry + gap), TAGLINE, sans, (123, 130, 146), track_px)

    # ── inset frame: gives the card an edge inside a dark Discord panel ──────
    draw.rounded_rectangle(
        [FRAME_INSET, FRAME_INSET, W - FRAME_INSET - 1, H - FRAME_INSET - 1],
        radius=FRAME_RADIUS, outline=(23, 24, 29), width=1)

    out = "og.png"
    card.save(out, "PNG", optimize=True)
    print(f"wrote {out}  {W}x{H}")
    budget = CROP_R - CROP_L
    for label, w in (("wordmark", wm_w), ("tagline", tag_w)):
        ok = w <= budget
        print(f"  {label:9} {w:6.1f}px  "
              f"{'fits' if ok else 'ESCAPES'} the {budget}px centre-square crop"
              f"{'' if ok else f' by {w - budget:.0f}px'}")


if __name__ == "__main__":
    main()
