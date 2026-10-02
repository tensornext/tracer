"""Drive the built app end to end in headless Chromium: sample photo → paper → trace → layout → 3D → exports."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
URL = "http://localhost:4173/"
IMG_W, IMG_H = 2048, 1536
S = 2048 / 2000  # sample.jpg is 2000 px wide
log = []

def img_to_screen(page, x, y):
    box = page.locator("canvas").first.bounding_box()
    return box["x"] + x * box["width"] / IMG_W, box["y"] + y * box["height"] / IMG_H

def click_img(page, x, y, shift=False):
    sx, sy = img_to_screen(page, x, y)
    if shift:
        page.keyboard.down("Shift")
    page.mouse.move(sx, sy)
    page.mouse.down(); page.mouse.up()
    if shift:
        page.keyboard.up("Shift")
    wait_idle(page)

def wait_idle(page, timeout=30):
    t0 = time.time()
    time.sleep(0.3)
    while time.time() - t0 < timeout:
        # The busy chip's text ends in "…"; a bare "Tracing" is the settings label and is always on screen.
        busy = page.locator("text=/(Tracing|Finding the paper).*…/").count()
        if not busy:
            return
        time.sleep(0.2)

def shot(page, name):
    page.screenshot(path=f"{OUT}/{name}.png")

with sync_playwright() as p:
    b = p.chromium.launch(args=["--enable-unsafe-webgpu"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: log.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
    page.goto(URL)
    page.wait_for_selector("text=Try the sample photo")
    shot(page, "01-empty")

    page.click("text=Try the sample photo")
    page.wait_for_selector("canvas")
    time.sleep(1.5)
    shot(page, "02-photo-paper-step")

    # Paper, then tools. Coordinates are in the 2000-px sample, scaled to the 2048-px working image.
    click_img(page, 1370 * S, 690 * S)
    time.sleep(0.6)
    shot(page, "03-paper-found")

    # Wrench (open end + shaft + ring are one piece)
    click_img(page, 1000 * S, 335 * S); page.keyboard.press("Enter")
    # Pliers: jaws, then the grips (separate colours), then the pivot
    page.keyboard.press("n"); click_img(page, 710 * S, 560 * S); click_img(page, 650 * S, 1000 * S); click_img(page, 745 * S, 1000 * S); click_img(page, 708 * S, 690 * S); page.keyboard.press("Enter")
    # Screwdriver: handle, then shaft
    page.keyboard.press("n"); click_img(page, 980 * S, 1255 * S); click_img(page, 1380 * S, 1228 * S); page.keyboard.press("Enter")
    # Socket: outer ring, then hex centre
    page.keyboard.press("n"); click_img(page, 1135 * S, 805 * S); click_img(page, 1177 * S, 808 * S); page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    time.sleep(0.8)
    shot(page, "04-traced")

    state = page.evaluate("""() => {
      const rows = [...document.querySelectorAll('aside .hint.num')].map(e => e.textContent);
      return rows;
    }""")
    log.append("tool sizes: " + json.dumps(state))

    page.click("nav >> text=Layout")
    time.sleep(0.8)
    shot(page, "05-layout")
    page.click("text=Arrange tightly")
    time.sleep(0.8)
    shot(page, "06-layout-arranged")
    log.append("summary: " + page.locator(".num.text-\\[15px\\]").first.inner_text())

    page.click("nav >> text=3D")
    page.wait_for_selector("text=Building the model", timeout=15000)
    page.wait_for_selector("text=Building the model", state="detached", timeout=180000)
    time.sleep(1.0)
    shot(page, "07-3d")

    def export(label):
        page.click("button:has-text('Export')")
        with page.expect_download(timeout=180000) as d:
            page.click(f"[role=menuitem]:has-text('{label}')")
        dl = d.value
        path = f"{OUT}/{dl.suggested_filename}"
        dl.save_as(path)
        log.append(f"download {label}: {dl.suggested_filename} {os.path.getsize(path)} bytes")

    for label in ["3MF for your slicer", "STL", "STEP", "Size-check PDF"]:
        export(label)

    page.click("text=Foam insert")
    time.sleep(0.5)
    page.click("nav >> text=Layout")
    time.sleep(0.6)
    shot(page, "08-foam-layout")
    for label in ["DXF", "SVG"]:
        export(label)

    page.click("nav >> text=Photo")
    time.sleep(0.5)
    page.set_viewport_size({"width": 1100, "height": 800})
    time.sleep(0.6)
    shot(page, "09-narrow")
    log.append("status: " + page.locator("footer").inner_text())
    b.close()

open(f"{OUT}/log.txt", "w").write("\n".join(log))
print("\n".join(log[-60:]))
