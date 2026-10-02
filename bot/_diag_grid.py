import os, subprocess, tempfile, time
import numpy as np
from PIL import Image
import window
from frame import FrameSource

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
prof = tempfile.mkdtemp(prefix="m3diag-")
p = subprocess.Popen([CHROME, "--app=http://localhost:8177/match3.html?seed=7",
    "--window-position=0,0", "--window-size=1000,760", "--user-data-dir="+prof,
    "--no-first-run", "--no-default-browser-check"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3.5)
    w = window.find_window("Sugar Cascade")
    print("window:", w)
    src = FrameSource(region=w.region)
    bgr = src.grab_bgr()
    Image.fromarray(bgr[..., ::-1]).save("diag_board.png")
    print("saved diag_board.png", bgr.shape)

    img = bgr.astype(np.int16)
    dx = np.abs(np.diff(img, axis=1)).sum(axis=2)
    dy = np.abs(np.diff(img, axis=0)).sum(axis=2)
    colp = dx.mean(axis=0); rowp = dy.mean(axis=1)

    def autocorr_period(prof, lo=20, hi=160):
        x = prof - prof.mean()
        ac = np.correlate(x, x, mode="full")[len(x)-1:]
        ac = ac / (ac[0] + 1e-9)
        best, bv = None, -1
        for lag in range(lo, min(hi, len(ac))):
            if ac[lag] > bv: bv, best = ac[lag], lag
        return best, bv

    cp, cv = autocorr_period(colp)
    rp, rv = autocorr_period(rowp)
    print("column profile: dominant period %s (corr %.3f)" % (cp, cv))
    print("row    profile: dominant period %s (corr %.3f)" % (rp, rv))
    print("expected cell pitch ~55px (52px cell + 3px gap) scaled by DPI 1.25 -> ~69px")
    # where does the strong periodic structure live?
    thr = colp.mean() + colp.std()
    strong_cols = np.where(colp > thr)[0]
    thr2 = rowp.mean() + rowp.std()
    strong_rows = np.where(rowp > thr2)[0]
    print("strong column edges: first %s last %s count %d" % (strong_cols[:3], strong_cols[-3:], len(strong_cols)))
    print("strong row    edges: first %s last %s count %d" % (strong_rows[:3], strong_rows[-3:], len(strong_rows)))
    src.close()
finally:
    subprocess.run(["taskkill","/PID",str(p.pid),"/T","/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
