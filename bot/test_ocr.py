"""
OCR correctness and cost.

Two questions:
  1. Does it read game-like text -- light on dark, small, over a busy background?
  2. What does it cost? R3 sits on the slow loop, but "slow" still has a budget.

Synthetic images with KNOWN text, so accuracy is measurable rather than eyeballed.
"""

import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import ocr


def font(size=22):
    for name in ("segoeui.ttf", "arial.ttf", "calibri.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def render(lines, size=(560, 220), fg=235, bg=18, noise=0, fsize=22):
    img = Image.new("L", size, color=bg)
    if noise:
        arr = np.asarray(img).astype(np.int16)
        arr = arr + np.random.randint(-noise, noise + 1, arr.shape)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    f = font(fsize)
    y = 18
    for ln in lines:
        d.text((22, y), ln, fill=fg, font=f)
        y += fsize + 14
    return np.asarray(img)


def busy_background(size=(560, 220)):
    """A gradient with shapes -- closer to text over a game scene than flat grey."""
    w, h = size
    xs = np.linspace(0, 255, w, dtype=np.uint8)
    arr = np.tile(xs, (h, 1))
    img = Image.fromarray(arr)
    d = ImageDraw.Draw(img)
    for i in range(7):
        d.ellipse([i * 80 - 30, 20 + i * 12, i * 80 + 70, 120 + i * 12], fill=60 + i * 14)
    return np.asarray(img)


def accuracy(expected, got_text):
    """Share of expected words that appear in the reading."""
    exp = [w.lower() for w in expected.split()]
    got = got_text.lower()
    if not exp:
        return 1.0
    return sum(1 for w in exp if w in got) / len(exp)


CASES = [
    ("light on dark (typical menu)",
     ["START NEW GAME", "Continue", "Options"], dict(fg=235, bg=18)),
    ("dark on light (inverted UI)",
     ["START NEW GAME", "Continue", "Options"], dict(fg=25, bg=228)),
    ("low contrast",
     ["Continue", "Settings"], dict(fg=150, bg=105)),
    ("small text",
     ["Press any key to continue", "Inventory"], dict(fg=230, bg=20, fsize=14)),
    ("noisy background",
     ["START NEW GAME", "Quit"], dict(fg=240, bg=30, noise=26)),
]


def main():
    print("OCR accuracy and cost")
    print()
    print("  %-30s %8s %8s %9s  %s" % ("case", "acc", "ms", "conf", "read"))
    print("  " + "-" * 92)

    total_acc, n = 0.0, 0
    for name, lines, kw in CASES:
        img = render(lines, **kw)
        r = ocr.recognize(img)
        expected = " ".join(lines)
        acc = accuracy(expected, r.text)
        conf = np.mean([x.confidence for x in r.regions]) if r.regions else 0.0
        total_acc += acc
        n += 1
        print("  %-30s %7.0f%% %8.1f %9.2f  %r" % (name, acc * 100, r.ms, conf, r.text[:40]))

    # Text over a busy background -- the realistic case, and the hard one.
    bg = busy_background()
    over = Image.fromarray(bg)
    d = ImageDraw.Draw(over)
    d.text((26, 30), "CONTINUE", fill=255, font=font(26))
    d.text((26, 90), "Load Game", fill=250, font=font(26))
    arr = np.asarray(over)
    r = ocr.recognize(arr)
    acc = accuracy("CONTINUE Load Game", r.text)
    total_acc += acc
    n += 1
    conf = np.mean([x.confidence for x in r.regions]) if r.regions else 0.0
    print("  %-30s %7.0f%% %8.1f %9.2f  %r" % ("text over busy background", acc * 100, r.ms, conf, r.text[:40]))

    # Noise rejection: an image with NO text must not hallucinate any.
    r = ocr.recognize(busy_background())
    print()
    print("  no-text image -> %d regions %s" % (
        len(r.regions), "PASS" if len(r.regions) == 0 else "FAIL: " + repr(r.text[:50])))

    # Cost at realistic sizes.
    print()
    print("  cost by region size (the slow loop pays this):")
    for w, h in [(320, 90), (640, 180), (640, 360), (1280, 720)]:
        img = render(["Continue", "Options"], size=(w, h))
        t0 = time.perf_counter()
        ocr.recognize(img)
        ms = (time.perf_counter() - t0) * 1000
        print("    %-12s %7.1f ms" % ("%dx%d" % (w, h), ms))

    print()
    print("  mean accuracy %.0f%% across %d cases" % (100 * total_acc / n, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
