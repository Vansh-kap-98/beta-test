import subprocess, tempfile, time
import numpy as np
from PIL import Image
import window, keys, ocr as ocr_mod
from frame import FrameSource
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
prof = tempfile.mkdtemp(prefix="m3ref-")
p = subprocess.Popen([CHROME, "--app=http://localhost:8177/match3.html?seed=7",
    "--window-position=0,0","--window-size=1000,760","--user-data-dir="+prof,
    "--no-first-run","--no-default-browser-check"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3.5)
    w = window.find_window("Sugar Cascade")
    window.focus(w.hwnd); time.sleep(0.4)
    src = FrameSource(region=w.region)
    # dismiss the tutorial by OCR so the board is undimmed
    res = ocr_mod.recognize(src.grab_gray())
    got = [r for r in res.regions if "got it" in r.text.lower()]
    if got:
        bx,by,bw,bh = got[0].bbox
        keys.click_at(w.left+bx+bw//2, w.top+by+bh//2)
        time.sleep(0.8)
    bgr = src.grab_bgr()
    np.save("ref_board.npy", bgr)
    Image.fromarray(bgr[...,::-1]).save("ref_board.png")
    print("saved ref_board.npy/.png", bgr.shape, "| tutorial dismissed:", bool(got))
    src.close()
finally:
    subprocess.run(["taskkill","/PID",str(p.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
