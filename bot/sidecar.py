"""
Perception + actuation sidecar.

Speaks newline-delimited JSON on stdin/stdout so the TypeScript agent can drive a
real game without any of the tier stack being rewritten in Python. That split is
deliberate: image processing, Win32 input and the Windows OCR engine belong in
Python, while the invariant engine, the Wilson reporting gate, deduplication,
calibration and reporting already exist in TypeScript and are the most valuable and
hardest-won part of the system. Porting them would duplicate exactly the code that
should never be duplicated.

Protocol -- one JSON object per line, request and response:

    {"cmd":"attach","match":"Sugar Cascade","profile":"match3"}
      -> {"ok":true,"window":{...}}
    {"cmd":"observe"}
      -> {"ok":true,"state":{...},"actions":[{"sig":...,"label":...},...]}
    {"cmd":"act","sig":"swap:1_2__2_2"}
      -> {"ok":true,"executed":true,"ms":412,"changed":{"tileBits":9,"cells":4}}
    {"cmd":"settle","timeoutMs":4000}   wait for animation to stop
    {"cmd":"screenshot","path":"..."}   evidence for a finding
    {"cmd":"quit"}

The agent only ever sees SIGS. Coordinates never cross the boundary, because the
side that detected the grid is the side that owns the pixel mapping.
"""

import json
import sys
import time
import traceback
from typing import Any, Dict, List, Optional

import numpy as np

import affordance
import clusters as clusters_mod
import hud as hud_mod
import keys
import match3
import ocr as ocr_mod
import window
from frame import FrameSource, digest_gray
from macros import (MacroAction, MacroExecutor, slugify, point_macro, ui_macros,
                    wait_macro)

# A tile-hash difference above this counts as "the screen responded". The global
# perceptual hash is far too coarse for UI-scale changes -- measured on a real
# match-3 move it reported 0-2 bits while the tile hashes reported 6-16.
CHANGE_TILE_BITS = 4

# How many no-effect attempts before a candidate is treated as inert and withdrawn.
# Two is too eager -- a real control can legitimately do nothing once, for instance a
# disabled button or a click that lands during an animation.
DEAD_AFTER = 3

# A real match-3 board shows several tile colours at once. A panel covering it reads
# as one or two flat regions, so the count of distinct cell kinds separates "I can see
# the board" from "I am reading a dialog through the board's old coordinates".
MIN_BOARD_KINDS = 3


def distinct_kinds(board) -> int:
    import numpy as _np
    return int(len(_np.unique(board)))


def board_is_visible(board) -> bool:
    return board is not None and distinct_kinds(board) >= MIN_BOARD_KINDS


def log(msg: str) -> None:
    """Diagnostics go to stderr; stdout carries the protocol only."""
    print("[sidecar] " + msg, file=sys.stderr, flush=True)


class Session:
    def __init__(self) -> None:
        self.win = None
        self.src: Optional[FrameSource] = None
        self.profile = "generic"
        self.ex = MacroExecutor()
        self.reader = match3.BoardReader()
        self.settle = match3.SettleDetector()
        self.grid: Optional[match3.GridInfo] = None
        self.last_board: Optional[np.ndarray] = None
        self.last_digest = None
        self.macros: Dict[str, MacroAction] = {}
        self.step = 0
        # Per-sig effect history. OCR cannot tell a button from a label -- "Score 0"
        # reads exactly like "Got it" -- so every readable region starts out as a
        # candidate and the inert ones are learned and dropped. That is also what a
        # player does: try it once, notice nothing happened, stop trying.
        self.tried: Dict[str, int] = {}
        self.dead: Dict[str, int] = {}
        self.last_origin: Optional[str] = None
        self.last_affordance: Optional[float] = None
        self.guard: Optional[window.TargetGuard] = None
        # Set once the target is lost, so a run cannot be resumed by accident into a
        # window that is no longer the one under test.
        self.lost: Optional[Dict[str, str]] = None
        self.last_hud: Dict[str, Any] = {}
        # Perceptual screen identity. Built in Phase 0b and benchmarked there
        # (a cutscene went from 235 clusters to 10 with the masked strategy), but
        # never actually wired into the agent -- screen identity was being
        # synthesised on the TypeScript side by concatenating OCR'd control names.
        # That is unstable by construction: one misread caption mints a new screen,
        # and a 45-step live run reported 20 "distinct screens" with 120-character
        # ids. Dedup, visit counts, bans and the stagnation detector are all keyed
        # on screen identity, so every one of them was degraded, and one defect was
        # reported twice because its two sightings had different ids.
        self.clusters = clusters_mod.ClusterLibrary(strategy="masked")
        self.hud_before_action: Dict[str, Any] = {}

    # ------------------------------------------------------------------ attach

    def attach(self, match: str, profile: str = "generic") -> Dict[str, Any]:
        window.set_dpi_aware()
        window.keep_awake(True)
        locked = window.session_locked()
        if locked:
            return {"ok": False, "locked": True,
                    "error": "the Windows session is locked (%s holds the screen). "
                             "Capture returns the lock screen and input is swallowed, "
                             "so any run would produce meaningless findings." % locked}
        cands = window.find_windows(match)
        if not cands:
            return {"ok": False, "error": "no window matching %r" % match,
                    "candidates": [x.title for x in window.list_windows()[:12]]}
        # Refuse a coin flip. Two same-sized matches are two instances, not a launcher
        # beside a game, and silently taking the larger one lets a run measure the
        # wrong build while reporting success.
        if window.ambiguous(cands):
            return {"ok": False, "ambiguous": True,
                    "error": "%d windows match %r at the same size; refusing to guess "
                             "which one to test. Close the others or match on a more "
                             "specific title." % (len(cands), match),
                    "candidates": ["%s [%s] %dx%d" % (x.title, x.process, x.width, x.height)
                                   for x in cands[:8]]}
        w = cands[0]
        if not window.focus(w.hwnd):
            return {"ok": False, "error": "window found but could not be focused; "
                                          "input would go nowhere"}
        self.win = w
        self.profile = profile
        # From here on, every observation and every action is gated on this window
        # still being the one that will receive input.
        self.guard = window.TargetGuard(w.hwnd, w.width, w.height, w.title)
        if self.src:
            self.src.close()
        self.src = FrameSource(region=w.region)
        gray = self.src.grab_gray()
        if float(gray.std()) < 8.0:
            return {"ok": False, "error": "capture region is blank (std %.1f); the game "
                                          "may be exclusive-fullscreen" % float(gray.std())}
        return {"ok": True, "window": {"title": w.title, "process": w.process,
                                       "width": w.width, "height": w.height,
                                       "left": w.left, "top": w.top}}

    def _target_lost(self) -> Optional[Dict[str, Any]]:
        """None while it is safe to proceed; an error payload once it is not.

        One gate for both halves of the danger. Capturing a window that is minimised
        or behind another returns stale pixels, so the agent reads an unchanging
        screen and reports confident softlocks for everything it "saw" -- and sending
        input while another window has focus types into that window instead. The
        second is the one that matters outside this program: the user's editor, chat
        client or file manager receives the clicks.

        Once lost, it stays lost. Recovering focus silently would mean a run whose
        first half tested the game and whose second half tested a notification popup,
        reported as one clean result -- and re-grabbing focus would also be fighting
        the person whose machine this is.
        """
        if self.lost is not None:
            return {"ok": False, "targetLost": self.lost["reason"],
                    "error": self.lost["error"]}
        if self.guard is None:
            return {"ok": False, "error": "not attached"}

        reason = self.guard.check()
        if reason is None:
            return None

        # A resize does not endanger the user; it only invalidates cached geometry.
        # Adopt the new size, drop the derived state and carry on.
        if reason == "resized":
            info = self.guard.accept_resize()
            if info is not None:
                self.win = info
                if self.src:
                    self.src.close()
                self.src = FrameSource(region=info.region)
                self.grid = None
                self.last_board = None
                self.macros.clear()
                return None

        self.lost = {
            "reason": reason,
            "error": "stopped: " + self.guard.last_detail +
                     ". No further input will be sent, because synthetic clicks and "
                     "keystrokes go to whichever window has focus -- not to the one "
                     "under test.",
        }
        # Never leave a key held down when abandoning the run.
        try:
            self.ex.release_all()
        except Exception:
            pass
        return {"ok": False, "targetLost": reason, "error": self.lost["error"]}

    # ----------------------------------------------------------------- observe

    def observe(self, ocr: bool = True) -> Dict[str, Any]:
        if not self.src:
            return {"ok": False, "error": "not attached"}
        lost = self._target_lost()
        if lost:
            return lost
        self.step += 1
        t0 = time.perf_counter()

        bgr = self.src.grab_bgr()
        # Widen BEFORE the weighted sum, then shift, THEN narrow. Casting to uint8
        # first truncates the high bits and yields a near-black frame -- which looks
        # exactly like a failed capture and sent this straight into the "blank
        # screen" path with uniformity 1.0 and no text.
        gray = (np.dot(bgr[..., :3].astype(np.uint32), [29, 150, 77]) >> 8).astype(np.uint8)
        digest = digest_gray(gray)

        state: Dict[str, Any] = {"step": self.step}
        unreadable: List[Dict[str, str]] = []
        actions: List[MacroAction] = []

        # --- text: OCR the frame, which also supplies the UI buttons -----------
        regions = []
        if ocr:
            res = ocr_mod.recognize(gray)
            regions = res.regions
            state["text"] = [r.text for r in regions[:16]]
            if not regions:
                unreadable.append({"field": "text", "reason": "low_confidence"})
        else:
            unreadable.append({"field": "text", "reason": "budget"})

        # Any readable text region becomes a clickable candidate. Crude, but it is
        # the same affordance a player has: if you can read it, you can try it.
        seen = set()
        page_bg = affordance.page_background(bgr) if regions else None
        for r in regions:
            if r.confidence < 0.55 or len(r.text) > 40:
                continue
            slug = slugify(r.text)
            if slug in seen or slug == "unknown":
                continue
            seen.add(slug)
            bx, by, bw, bh = r.bbox
            # How confident are we this is a CONTROL rather than a label? A text
            # region is still offered either way -- trying it is how you find out --
            # but only a confident control supports the claim that it is broken.
            btn = affordance.button_likeness(bgr, r.bbox, page_bg, r.text)
            actions.append(point_macro(slug, r.text,
                                       self.win.left + bx + bw // 2,
                                       self.win.top + by + bh // 2,
                                       origin="button" if btn >= affordance.BUTTON_THRESHOLD else "ocr",
                                       confidence=btn))

        # --- typed variables from the HUD -------------------------------------
        #
        # This is what stops the invariant suite going silent on a black-box target.
        # Without numbers, every gate that mentions currency or progress returns
        # False, the suite reports nothing, and a blind run is indistinguishable from
        # a clean one.
        # Cross-scale verification, reusing the whole-frame pass just computed.
        #
        # A single pass is not trustworthy enough to support an economy claim: the
        # HUD line "Score 0 Moves 22 Goal 1000 Level 1" read correctly but scored
        # only 0.36-0.46 derived confidence, below the 0.6 gate, so every economy
        # oracle was starved of data on the live path. Two independent resamplings
        # agreeing on the same number is hard to achieve by accident, and fields
        # that disagree are dropped rather than averaged.
        hud_vals = hud_mod.read_hud(gray, primary_regions=regions) if regions else {}
        if hud_vals:
            state["hud"] = {k: {"value": v.value, "confidence": v.confidence}
                            for k, v in hud_vals.items()}
            deltas = hud_mod.diff(self.last_hud, hud_vals)
            if deltas:
                state["hudDeltas"] = deltas
        elif regions:
            unreadable.append({"field": "hud", "reason": "low_confidence",
                               "detail": "text read but no labelled numbers in it"})
        self.last_hud = hud_vals

        # --- genre profile ----------------------------------------------------
        if self.profile == "match3":
            grid = match3.detect_grid(bgr)
            if grid is not None:
                self.grid = grid
                board, conf = self.reader.read(bgr, grid)
                if not board_is_visible(board):
                    # A dialog is sitting on top of the board.
                    #
                    # The grid geometry is remembered from when the board WAS visible,
                    # so reading it while a pause or win panel covers it returns the
                    # panel's own pixels as cells. Those collapse to one or two
                    # colours, the diff against the real previous board reports almost
                    # every cell changed, and with the score correctly unchanged the
                    # economy oracles reported "work done with no reward" on a clean
                    # build -- making it indistinguishable from the planted score bug.
                    #
                    # A board must be absent rather than wrong: every downstream gate
                    # is written to skip a field it cannot see, and none of them can
                    # defend themselves against a confident fiction.
                    unreadable.append({"field": "board", "reason": "occluded",
                                       "detail": "grid region shows %d distinct cell "
                                                 "kinds; a panel is covering it"
                                                 % distinct_kinds(board)})
                    self.last_board = None
                else:
                    state["board"] = {"cols": grid.cols, "rows": grid.rows,
                                      "confidence": conf}
                    if self.last_board is not None and self.last_board.shape == board.shape:
                        state["board"]["cellsChanged"] = int((self.last_board != board).sum())
                    self.last_board = board

                swaps = match3.valid_swaps(board)
                state["legalMoves"] = len(swaps)
                if swaps:
                    state["bestClears"] = swaps[0].cleared
                actions.extend(match3.swap_macros(grid, swaps, self.win.left, self.win.top))
            else:
                unreadable.append({"field": "board", "reason": "no_source",
                                   "detail": "no grid detected in frame"})

        actions.extend(ui_macros())
        actions.append(wait_macro())

        # Drop candidates that have repeatedly done nothing. Kept out of the option
        # list entirely rather than merely deprioritised, because option budget is
        # the scarce resource and an inert control wastes a slot every single step.
        live_actions = [m for m in actions if self.dead.get(m.sig, 0) < DEAD_AFTER]
        if live_actions:
            actions = live_actions
        if self.dead:
            state["prunedActions"] = sum(1 for v in self.dead.values() if v >= DEAD_AFTER)

        self.macros = {m.sig: m for m in actions}
        self.last_digest = digest

        if self.last_origin is not None:
            state["lastActionOrigin"] = self.last_origin
            state["lastActionAffordance"] = self.last_affordance

        assignment = self.clusters.assign(digest)
        state["screenId"] = "c%d" % assignment.cluster_id
        state["screenNovel"] = bool(assignment.novel)
        state["screenClusters"] = len(self.clusters.clusters)

        state["frame"] = {"uniformity": round(digest.uniformity, 3),
                          "information": round(digest.information, 3)}
        if unreadable:
            state["unreadable"] = unreadable
        state["perceptionMs"] = round((time.perf_counter() - t0) * 1000, 1)

        return {"ok": True, "state": state,
                "actions": [{"sig": m.sig, "label": m.label,
                             "origin": m.origin,
                             "confidence": m.affordance_confidence} for m in actions]}

    # --------------------------------------------------------------------- act

    def act(self, sig: str, max_ms: float = 4000.0) -> Dict[str, Any]:
        if not self.src:
            return {"ok": False, "error": "not attached"}
        # The guard comes FIRST, before the macro is even looked up. With the lookup
        # first, a lost target reported "unknown sig" instead of the real reason,
        # which is both misleading and one refactor away from being treated as a
        # recoverable error and retried.
        lost = self._target_lost()
        if lost:
            return lost

        macro = self.macros.get(sig)
        if macro is None:
            return {"ok": False, "error": "unknown sig %r" % sig,
                    "known": list(self.macros)[:20]}

        before_digest = digest_gray(self.src.grab_gray())
        before_board = self.last_board.copy() if self.last_board is not None else None

        t0 = time.perf_counter()
        # The guard also runs between the macro's own steps, because a macro can take
        # seconds and focus can move halfway through one.
        res = self.ex.run(macro, max_ms=max_ms,
                          abort_when=lambda: self.guard is not None and
                          self.guard.check() is not None)

        # And once more afterwards: if focus moved mid-macro the remaining steps were
        # abandoned, but part of the action may already have gone elsewhere, so the
        # run stops rather than reporting what the half-action appeared to do.
        lost = self._target_lost()
        if lost:
            lost["partial"] = True
            lost["stepsRun"] = res.steps_run
            return lost
        settled_ms = self._settle(4000.0)

        after_digest = digest_gray(self.src.grab_gray())
        tile_bits = sum(bin(a ^ b).count("1")
                        for a, b in zip(before_digest.tiles, after_digest.tiles))

        changed: Dict[str, Any] = {"tileBits": tile_bits,
                                   "globalBits": bin(before_digest.phash ^ after_digest.phash).count("1")}
        if self.profile == "match3" and self.grid is not None and before_board is not None:
            board, _ = self.reader.read(self.src.grab_bgr(), self.grid)
            if board_is_visible(board):
                changed["cells"] = int((before_board != board).sum())
                self.last_board = board
            else:
                # Occluded: report no cell count rather than a fictional one. The
                # invariants that need it decline; the ones that do not are unaffected.
                self.last_board = None

        produced = tile_bits >= CHANGE_TILE_BITS
        # Carry the action's PROVENANCE forward. "This control does nothing" is a
        # defect claim about the game, and it should only be made about things we
        # are confident are controls. A swap computed from the board is one; a text
        # region OCR'd off the HUD and optimistically treated as clickable is not --
        # "Score 0" reads exactly like a button and clicking it rightly does nothing.
        self.last_origin = macro.origin
        self.last_affordance = macro.affordance_confidence
        self.tried[sig] = self.tried.get(sig, 0) + 1
        if produced:
            self.dead.pop(sig, None)
        else:
            self.dead[sig] = self.dead.get(sig, 0) + 1

        return {"ok": True, "executed": True,
                "ms": round((time.perf_counter() - t0) * 1000, 1),
                "settleMs": round(settled_ms, 1),
                "abortedEarly": res.aborted_early,
                "changed": changed,
                # The single boolean the agent actually gates on. Derived from tile
                # hashes rather than the global hash for the reason above.
                "producedChange": produced,
                "noEffectStreak": self.dead.get(sig, 0)}

    def _settle(self, timeout_ms: float) -> float:
        """Block until the screen stops animating, so the next observation is not
        taken mid-cascade. Returns how long it took."""
        self.settle.reset()
        t0 = time.perf_counter()
        while (time.perf_counter() - t0) * 1000 < timeout_ms:
            if self.settle.update(digest_gray(self.src.grab_gray())):
                break
            time.sleep(0.04)
        return (time.perf_counter() - t0) * 1000

    def screenshot(self, path: str) -> Dict[str, Any]:
        if not self.src:
            return {"ok": False, "error": "not attached"}
        from PIL import Image
        Image.fromarray(self.src.grab_bgr()[..., ::-1]).save(path)
        return {"ok": True, "path": path}


def main() -> int:
    s = Session()
    log("ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "attach":
                out = s.attach(req.get("match", ""), req.get("profile", "generic"))
            elif cmd == "observe":
                out = s.observe(ocr=req.get("ocr", True))
            elif cmd == "act":
                out = s.act(req.get("sig", ""), req.get("maxMs", 4000.0))
            elif cmd == "settle":
                out = {"ok": True, "settleMs": round(s._settle(req.get("timeoutMs", 4000.0)), 1)}
            elif cmd == "screenshot":
                out = s.screenshot(req.get("path", "shot.png"))
            elif cmd == "ping":
                out = {"ok": True, "pong": True}
            elif cmd == "quit":
                print(json.dumps({"ok": True, "bye": True}), flush=True)
                break
            else:
                out = {"ok": False, "error": "unknown cmd %r" % cmd}
        except Exception as e:
            out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                   "trace": traceback.format_exc()[-400:]}
        print(json.dumps(out), flush=True)

    keys.release_all(["w", "a", "s", "d", "shift", "ctrl", "space"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
