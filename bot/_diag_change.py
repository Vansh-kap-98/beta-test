"""Which change-detector actually sees a single match-3 move?"""
import ctypes, ctypes.wintypes as wt, subprocess, tempfile, time
import numpy as np
import keys, match3, ocr as ocr_mod, window
from frame import FrameSource, digest_gray
from macros import MacroExecutor

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
prof = tempfile.mkdtemp(prefix="m3chg-")
p = subprocess.Popen([CHROME, "--app=http://localhost:8177/match3.html?seed=21&expose=title",
    "--window-position=0,0","--window-size=1000,760","--user-data-dir="+prof,
    "--no-first-run","--no-default-browser-check"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def title(h):
    n=window.user32.GetWindowTextLengthW(wt.HWND(h)); b=ctypes.create_unicode_buffer(n+1)
    window.user32.GetWindowTextW(wt.HWND(h), b, n+1); return b.value
try:
    time.sleep(3.5)
    w = window.find_window("M3|"); window.focus(w.hwnd); time.sleep(0.4)
    src = FrameSource(region=w.region)
    res = ocr_mod.recognize(src.grab_gray())
    got=[r for r in res.regions if "got it" in r.text.lower()]
    if got:
        bx,by,bw,bh=got[0].bbox; keys.click_at(w.left+bx+bw//2, w.top+by+bh//2); time.sleep(0.8)
    ex = MacroExecutor()
    reader = match3.BoardReader()
    print("  %-5s %10s %10s %12s %10s" % ("move","globalBits","tileBits","boardCells","truthCells"))
    print("  " + "-"*54)
    for i in range(6):
        bgr = src.grab_bgr(); g = match3.detect_grid(bgr)
        if not g: print("  no grid"); break
        b0,_ = reader.read(bgr, g)
        d0 = digest_gray(src.grab_gray())
        t0 = title(w.hwnd).split("|",4)[4] if title(w.hwnd).startswith("M3|") else ""
        sw = match3.valid_swaps(b0)
        if not sw: print("  no swaps"); break
        ex.run(match3.swap_macros(g, sw, w.left, w.top)[0], max_ms=2500)
        time.sleep(1.5)
        d1 = digest_gray(src.grab_gray())
        b1,_ = reader.read(src.grab_bgr(), g)
        t1 = title(w.hwnd).split("|",4)[4] if title(w.hwnd).startswith("M3|") else ""
        gbits = bin(d0.phash ^ d1.phash).count("1")
        tbits = sum(bin(a^b).count("1") for a,b in zip(d0.tiles, d1.tiles))
        cells = int((b0 != b1).sum())
        truth = sum(1 for a,b in zip(t0,t1) if a!=b) if t0 and t1 else -1
        print("  %-5d %10d %10d %12d %10d" % (i, gbits, tbits, cells, truth))
    src.close()
finally:
    subprocess.run(["taskkill","/PID",str(p.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
