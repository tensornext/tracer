"""Render public/sample.jpg: tools on a Letter sheet on a wooden bench, shot slightly off-square."""
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFilter

rng = np.random.default_rng(7)
S = 5.0                      # px per mm in the flat "world"
WW, WH = 420, 330            # world size, mm
W, H = int(WW * S), int(WH * S)
SS = 2                       # supersampling for anti-aliased shapes

def px(pts):  # mm → supersampled px
    return [(x * S * SS, y * S * SS) for x, y in pts]

# --- bench: warm wood with grain ---
y = np.linspace(0, 1, H)[:, None]; x = np.linspace(0, 1, W)[None, :]
noise_lo = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 40) * 8
grain = np.sin((x * 26 + np.sin(y * 4) * 0.8 + noise_lo * 0.6) * np.pi) * 0.5 + 0.5
noise = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 6)
wood = np.stack([150 + 30 * grain + 10 * noise, 104 + 22 * grain + 7 * noise, 66 + 14 * grain + 5 * noise], -1)
world = Image.fromarray(np.clip(wood, 0, 255).astype(np.uint8))

# --- paper (Letter, portrait) ---
PX0, PY0 = (WW - 215.9) / 2, (WH - 279.4) / 2 + 0  # world is wider than tall; paper sits in the middle
PY0 = 25
paper_poly = [(PX0, PY0), (PX0 + 215.9, PY0), (PX0 + 215.9, PY0 + 279.4), (PX0, PY0 + 279.4)]

big = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
d = ImageDraw.Draw(big)
d.polygon(px(paper_poly), fill=(242, 241, 236, 255))
paper = big.resize((W, H), Image.LANCZOS)
# paper casts a faint shadow on the bench
sh = Image.new("L", (W, H), 0); ImageDraw.Draw(sh).polygon([(a / SS + 4, b / SS + 6) for a, b in px(paper_poly)], fill=90)
world = Image.composite(Image.new("RGB", (W, H), (60, 40, 25)), world, sh.filter(ImageFilter.GaussianBlur(8)))
world.paste(paper, (0, 0), paper)

# --- tools (in world mm) ---
def rot(pts, ang, cx, cy):
    a = np.radians(ang); c, s = np.cos(a), np.sin(a)
    return [(cx + x * c - y * s, cy + x * s + y * c) for x, y in pts]

def circle(cx, cy, r, n=64):
    return [(cx + r * np.cos(t), cy + r * np.sin(t)) for t in np.linspace(0, 2 * np.pi, n, endpoint=False)]

layers = []  # (polygon_mm, rgb, holes)
# Combination wrench ~165 mm, lying diagonally
shaft = [(-70, -6), (64, -5), (64, 5), (-70, 6)]
ring = circle(72, 0, 13); ring_hole = circle(72, 0, 7.2, 12)
openend = [(-62, -12), (-80, -16), (-92, -10), (-86, -4), (-76, -5), (-76, 5), (-86, 4), (-92, 10), (-80, 16), (-62, 12)]
wx, wy, wa = PX0 + 112, PY0 + 42, -4
for poly in (shaft, openend, ring):
    layers.append((rot(poly, wa, wx, wy), (58, 62, 68), []))
layers.append((rot(ring_hole, wa, wx, wy), None, []))  # hole shows paper
# Screwdriver: red handle + steel shaft, partly over the paper's right edge
sx, sy, sa = PX0 + 166, PY0 + 250, -5
layers.append((rot([(-5, -3), (70, -3), (74, 0), (70, 3), (-5, 3)], sa, sx, sy), (96, 100, 106), []))
layers.append((rot([(-100, -14), (-12, -13), (-5, -9), (-5, 9), (-12, 13), (-100, 14), (-106, 8), (-106, -8)], sa, sx, sy), (176, 38, 32), []))
# Pliers: jaws + two red grips
px0, py0, pa = PX0 + 45, PY0 + 122, -90
jaws = [(0, -9), (38, -6), (52, -2), (52, 2), (38, 6), (0, 9), (-8, 0)]
grip1 = [(-6, -1), (-92, -15), (-96, -8), (-8, 5)]
grip2 = [(-6, 1), (-92, 15), (-96, 8), (-8, -5)]
layers.append((rot(jaws, pa, px0, py0), (50, 54, 58), []))
layers.append((rot(grip1, pa, px0, py0), (196, 52, 30), []))
layers.append((rot(grip2, pa, px0, py0), (196, 52, 30), []))
layers.append((rot(circle(-4, 0, 7), pa, px0, py0), (70, 74, 80), []))
# A 3/8" socket standing on end
layers.append((circle(PX0 + 150, PY0 + 150, 12.5), (84, 88, 94), []))
layers.append((circle(PX0 + 150, PY0 + 150, 7.5, 6), (38, 40, 44), []))

# soft shadows first
shadow = Image.new("L", (W * SS, H * SS), 0); sd = ImageDraw.Draw(shadow)
for poly, col, _ in layers:
    if col is not None:
        sd.polygon([(a + 10 * SS, b + 14 * SS) for a, b in px(poly)], fill=150)
for poly, col, _ in layers:
    if col is None:
        sd.polygon([(a + 10 * SS, b + 14 * SS) for a, b in px(poly)], fill=0)
shadow = shadow.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(9))
world = Image.composite(Image.new("RGB", (W, H), (70, 66, 60)), world, shadow.point(lambda v: int(v * 0.55)))

tools = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0)); td = ImageDraw.Draw(tools)
for poly, col, _ in layers:
    if col is None:
        # Punch the ring hole back to paper colour.
        td.polygon(px(poly), fill=(240, 239, 234, 255))
    else:
        td.polygon(px(poly), fill=col + (255,))
tools = tools.resize((W, H), Image.LANCZOS)
world.paste(tools, (0, 0), tools)

# subtle highlight streaks on metal
arr = np.asarray(world).astype(np.float32)
arr += rng.normal(0, 2.2, arr.shape)

# --- camera: mild keystone + rotation, then vignette ---
OW, OH = 2000, 1500
src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
dst = np.float32([[60, 20], [OW - 40, 70], [OW - 95, OH - 10], [25, OH - 55]])
Hm = cv2.getPerspectiveTransform(src, dst)
photo = cv2.warpPerspective(np.clip(arr, 0, 255).astype(np.uint8), Hm, (OW, OH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
yy, xx = np.mgrid[0:OH, 0:OW]
vig = 1 - 0.22 * (((xx - OW / 2) / (OW / 2)) ** 2 + ((yy - OH / 2) / (OH / 2)) ** 2)
photo = np.clip(photo * vig[..., None] * [1.02, 1.0, 0.97], 0, 255).astype(np.uint8)
Image.fromarray(photo).save("public/sample.jpg", quality=86, optimize=True)

# Ground truth for tests: paper corners in the photo.
pc = cv2.perspectiveTransform(np.float32([[[a * S, b * S] for a, b in paper_poly]]), Hm)[0]
np.save("scripts/sample_paper_corners.npy", pc)
print("paper corners", pc.round(1).tolist())
