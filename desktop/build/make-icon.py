# Donna app icon: the mascot on the landing-gradient squircle tile.
#
# Regeneration: needs pillow + icnsutil (pip install pillow icnsutil) and the
# ORIGINAL uncropped render next to this script as buddy-original.png —
# recover it with `git show 975125ae:public/donna-buddy.png` (the shipped
# public/ copy is the tight 512 crop, not this source). Produces
# icon-1024.png (-> icon.png) and, via the explicit-slot snippet in the
# 2026-08-05 session, icon.icns. The icns slots used: icp4/icp5 (16/32),
# ic11/ic12 (32/64), ic07/ic13 (128/256), ic08/ic14 (256/512), ic09/ic10
# (512/1024) — icnsutil's filename guesser can't infer these, pass keys.
# macOS Big Sur+ convention: the icon is a rounded-square tile occupying
# 824/1024 of the canvas (Apple's grid), with transparent padding around it.
# The tile is Donna's signature sunset sweep (design-tokens.js
# landingGradient: oklch(0.80 0.12 78) -> (0.70 0.17 50) -> (0.58 0.20 32),
# 135deg), the fella centered on it.
import math
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
TILE = 824          # Apple grid tile side
RADIUS = int(TILE * 0.2237)  # the accepted squircle approximation


# oklch -> sRGB (Björn Ottosson's OKLab reference math)
def oklch_to_srgb(L, C, H):
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def gamma(u):
        u = max(0.0, min(1.0, u))
        return 12.92 * u if u <= 0.0031308 else 1.055 * (u ** (1 / 2.4)) - 0.055
    return tuple(round(gamma(v) * 255) for v in (r, g, bl))


STOPS = [(0.0, oklch_to_srgb(0.80, 0.12, 78)),
         (0.48, oklch_to_srgb(0.70, 0.17, 50)),
         (1.0, oklch_to_srgb(0.58, 0.20, 32))]
print('gradient stops (sRGB):', STOPS)


def grad_at(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


# 135deg diagonal gradient over the tile
tile = Image.new('RGB', (TILE, TILE))
px = tile.load()
for y in range(TILE):
    for x in range(TILE):
        t = (x + y) / (2 * (TILE - 1))
        px[x, y] = grad_at(t)

# squircle mask (rounded rect at Apple's radius; anti-aliased via supersample)
mask = Image.new('L', (TILE * 4, TILE * 4), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    (0, 0, TILE * 4 - 1, TILE * 4 - 1), radius=RADIUS * 4, fill=255)
mask = mask.resize((TILE, TILE), Image.LANCZOS)

canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
off = (SIZE - TILE) // 2

# soft drop shadow under the tile (Apple's template carries one)
shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
sh_mask = Image.new('L', (SIZE, SIZE), 0)
sh_mask.paste(mask, (off, off + 14))
sh_mask = sh_mask.filter(ImageFilter.GaussianBlur(18))
shadow.putalpha(sh_mask.point(lambda v: int(v * 0.30)))
canvas.alpha_composite(shadow)

tile_rgba = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
tile_rgba.paste(tile.convert('RGBA'), (off, off))
tile_mask = Image.new('L', (SIZE, SIZE), 0)
tile_mask.paste(mask, (off, off))
tile_rgba.putalpha(tile_mask)
canvas.alpha_composite(tile_rgba)

# the fella: alpha-bbox crop of the original render, scaled to 76% of tile
im = Image.open('buddy-original.png')
bbox = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
fella = im.crop(bbox)
target_h = int(TILE * 0.76)
scale = target_h / fella.height
fella = fella.resize((int(fella.width * scale), target_h), Image.LANCZOS)
fx = (SIZE - fella.width) // 2
fy = off + (TILE - fella.height) // 2 + int(TILE * 0.015)  # a whisper low: optical center
canvas.alpha_composite(fella, (fx, fy))

canvas.save('icon-1024.png', optimize=True)
print('icon-1024.png', canvas.size)

# .icns: PNG-based entries for every slot modern macOS reads
from icnsutil import IcnsFile
icns = IcnsFile()
for side, name in [(16, 'icon_16.png'), (32, 'icon_32.png'), (64, 'icon_64.png'),
                   (128, 'icon_128.png'), (256, 'icon_256.png'),
                   (512, 'icon_512.png'), (1024, 'icon_1024s.png')]:
    canvas.resize((side, side), Image.LANCZOS).save(name)
    icns.add_media(file=name)
icns.write('icon.icns')
import os
print('icon.icns bytes:', os.path.getsize('icon.icns'))
