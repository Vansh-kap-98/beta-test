"""
Match-3 adapter: screen pixels -> symbolic board -> executable swap macros.

This is the concrete answer to "Laya decides, but what actually does it?". The chain:

    detect_grid()     find the board's geometry in the captured frame
    read_board()      sample each cell, cluster colours -> a symbolic grid
    valid_swaps()     enumerate every legal move from the SYMBOLS (no model)
    swap_macros()     turn each swap into a MacroAction with real screen pixels
      ...model picks one sig...
    MacroExecutor     runs its script: move, click, move, click via SendInput

The division of labour matters: the model works entirely in symbols and never sees
a coordinate, while the harness owns the cell->pixel mapping because it detected the
grid in the first place. That is why `MacroAction.sig` is separate from its `script`.

Grid detection is deliberately general rather than hardcoded to the fixture. It finds
the lattice from the image itself, so it has a chance of working on a real match-3.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from macros import InputStep, MacroAction

# A cell is a solid block of colour; the gaps between cells are where colour changes
# abruptly. Cells smaller than this are probably texture, not a board.
MIN_CELL_PX = 18
MAX_CELL_PX = 200
MIN_GRID = 4                    # at least 4x4 to be a board
MAX_GRID = 12


@dataclass
class GridInfo:
    x0: int
    y0: int
    cell_w: float
    cell_h: float
    cols: int
    rows: int
    confidence: float

    def cell_centre(self, cx: int, cy: int) -> Tuple[int, int]:
        """Centre of cell (col,row) in capture-region pixels."""
        return (int(self.x0 + (cx + 0.5) * self.cell_w),
                int(self.y0 + (cy + 0.5) * self.cell_h))

    def __str__(self) -> str:
        return "%dx%d grid, cell %.0fx%.0f at (%d,%d), conf %.2f" % (
            self.cols, self.rows, self.cell_w, self.cell_h, self.x0, self.y0, self.confidence)


def _autocorr_period(profile: np.ndarray, lo: int = 20, hi: int = 200):
    """Dominant repeat distance in a 1-D profile, with its correlation strength."""
    if profile.size < lo * 3:
        return None, 0.0
    x = profile - profile.mean()
    ac = np.correlate(x, x, mode="full")[len(x) - 1:]
    if ac[0] <= 0:
        return None, 0.0
    ac = ac / ac[0]
    hi = min(hi, len(ac) - 1, len(profile) // 3)
    if hi <= lo:
        return None, 0.0
    lag = int(np.argmax(ac[lo:hi]) + lo)
    return lag, float(ac[lag])


def _best_offset(profile: np.ndarray, pitch: int) -> int:
    """Phase of the lattice: the offset whose comb lands on the strongest edges."""
    best, best_score = 0, -1e18
    n = len(profile)
    for off in range(pitch):
        idx = np.arange(off, n, pitch)
        if idx.size < MIN_GRID:
            continue
        score = float(profile[idx].sum()) / idx.size
        if score > best_score:
            best_score, best = score, off
    return best


def _extent(profile: np.ndarray, pitch: int, offset: int):
    """Longest contiguous run of lattice lines that actually show an edge.

    This is what localises the BOARD rather than finding a lattice somewhere in the
    frame. A title bar, a HUD strip and a large empty background all sit on the same
    image, and a whole-frame profile happily reports periodicity that spans all of
    them -- which is how detection first returned an 8x10 grid anchored at y=0, on
    top of the window chrome.
    """
    n = len(profile)
    positions = list(range(offset, n, pitch))
    if len(positions) < MIN_GRID:
        return None
    # A lattice line is "present" if the profile near it is clearly above the
    # frame's typical edge energy.
    thresh = profile.mean() + 0.35 * profile.std()
    present = []
    for pos in positions:
        lo, hi = max(0, pos - 2), min(n, pos + 3)
        present.append(profile[lo:hi].max() > thresh)

    best_run, cur_start, best = (0, 0), None, None
    for i, ok in enumerate(present + [False]):
        if ok and cur_start is None:
            cur_start = i
        elif not ok and cur_start is not None:
            if i - cur_start > best_run[1] - best_run[0]:
                best_run = (cur_start, i)
            cur_start = None
    if best_run[1] - best_run[0] < MIN_GRID:
        return None
    return positions[best_run[0]], positions[best_run[1] - 1], best_run[1] - best_run[0] - 1


def detect_grid(bgr: np.ndarray) -> Optional[GridInfo]:
    """Find a match-3 board in a frame without being told where it is.

    Structure, not content: a board is a regular lattice of uniform colour blocks, so
    the colour-difference profiles show evenly spaced peaks *within the board region
    and nowhere else*. Finding the period is easy; finding the EXTENT is the part
    that matters, because the frame also contains a title bar, a HUD and a large
    empty background that will happily contribute their own spurious periodicity.

    Cells are assumed square, which is true of every match-3 skin and lets the more
    confident axis supply the pitch for both -- the row profile in particular is
    often swamped by HUD text (measured: column correlation 0.53, row 0.09 on the
    same frame).
    """
    if bgr.ndim != 3 or bgr.shape[0] < 64 or bgr.shape[1] < 64:
        return None
    img = bgr.astype(np.int16)
    dx = np.abs(np.diff(img, axis=1)).sum(axis=2)
    dy = np.abs(np.diff(img, axis=0)).sum(axis=2)
    colp = dx.mean(axis=0)
    rowp = dy.mean(axis=1)

    px, cx = _autocorr_period(colp)
    py, cy = _autocorr_period(rowp)
    cands = [(p_, c_) for p_, c_ in ((px, cx), (py, cy)) if p_]
    if not cands:
        return None
    pitch, corr = max(cands, key=lambda t: t[1])
    if corr < 0.12 or not (MIN_CELL_PX <= pitch <= MAX_CELL_PX):
        return None

    ox = _best_offset(colp, pitch)
    oy = _best_offset(rowp, pitch)
    ex = _extent(colp, pitch, ox)
    ey = _extent(rowp, pitch, oy)
    if not ex or not ey:
        return None

    x0, _x1, cols = ex
    y0, _y1, rows = ey
    if not (MIN_GRID <= cols <= MAX_GRID and MIN_GRID <= rows <= MAX_GRID):
        return None

    g = GridInfo(x0=x0, y0=y0, cell_w=float(pitch), cell_h=float(pitch),
                 cols=cols, rows=rows, confidence=round(float(corr), 3))
    return _grow(bgr, g)


def _cell_stats(bgr: np.ndarray, g: GridInfo, cx: int, cy: int):
    """Mean colour and interior variation of one cell, or None if off-frame."""
    px, py = g.cell_centre(cx, cy)
    hw = max(2, int(g.cell_w * 0.30))
    hh = max(2, int(g.cell_h * 0.30))
    y0, y1 = py - hh, py + hh
    x0, x1 = px - hw, px + hw
    if y0 < 0 or x0 < 0 or y1 > bgr.shape[0] or x1 > bgr.shape[1]:
        return None
    patch = bgr[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    if patch.size == 0:
        return None
    return patch.mean(axis=0), float(patch.std(axis=0).mean())


def _line_is_boardlike(bgr: np.ndarray, g: GridInfo, cells) -> bool:
    """Does a candidate row or column look like part of the board?

    Two conditions, and both are needed. Cell interiors must be reasonably uniform,
    because a board cell is a solid tile rather than text or scenery. And the cells
    must not all be the same colour, because an empty background region is perfectly
    uniform too -- uniformity alone would happily annex the whole page.
    """
    stats = [_cell_stats(bgr, g, cx, cy) for cx, cy in cells]
    if any(st is None for st in stats) or len(stats) < 3:
        return False
    means = np.array([st[0] for st in stats])
    interior = float(np.mean([st[1] for st in stats]))
    spread = float(np.mean(means.std(axis=0)))
    return interior < 42.0 and spread > 12.0


def _grow(bgr: np.ndarray, g: GridInfo) -> GridInfo:
    """Extend the detected lattice outward while the new cells still look like board.

    The lattice is found from EDGES, and a board has two strong edges per cell -- the
    tile's own boundary and the gap between tiles. Phase can therefore lock onto the
    gap lattice and miss the outermost row or column, which is exactly what happened:
    a true 8x8 board was first detected as 7x8, one cell in from its real origin.
    Growing against cell content rather than edges is self-correcting.
    """
    for _ in range(4):
        grew = False

        # left
        if g.x0 - g.cell_w >= 0:
            cand = GridInfo(int(g.x0 - g.cell_w), g.y0, g.cell_w, g.cell_h,
                            g.cols + 1, g.rows, g.confidence)
            if _line_is_boardlike(bgr, cand, [(0, r) for r in range(cand.rows)]):
                g, grew = cand, True
        # right
        if g.x0 + (g.cols + 1) * g.cell_w <= bgr.shape[1]:
            cand = GridInfo(g.x0, g.y0, g.cell_w, g.cell_h, g.cols + 1, g.rows, g.confidence)
            if _line_is_boardlike(bgr, cand, [(cand.cols - 1, r) for r in range(cand.rows)]):
                g, grew = cand, True
        # up
        if g.y0 - g.cell_h >= 0:
            cand = GridInfo(g.x0, int(g.y0 - g.cell_h), g.cell_w, g.cell_h,
                            g.cols, g.rows + 1, g.confidence)
            if _line_is_boardlike(bgr, cand, [(c, 0) for c in range(cand.cols)]):
                g, grew = cand, True
        # down
        if g.y0 + (g.rows + 1) * g.cell_h <= bgr.shape[0]:
            cand = GridInfo(g.x0, g.y0, g.cell_w, g.cell_h, g.cols, g.rows + 1, g.confidence)
            if _line_is_boardlike(bgr, cand, [(c, cand.rows - 1) for c in range(cand.cols)]):
                g, grew = cand, True

        if not grew:
            break

    # Trim any edge row/column that is not board-like -- growth is optimistic and the
    # initial lattice may itself have over-reached into the HUD.
    for _ in range(4):
        trimmed = False
        if g.rows > MIN_GRID and not _line_is_boardlike(bgr, g, [(c, 0) for c in range(g.cols)]):
            g = GridInfo(g.x0, int(g.y0 + g.cell_h), g.cell_w, g.cell_h, g.cols, g.rows - 1, g.confidence)
            trimmed = True
        if g.rows > MIN_GRID and not _line_is_boardlike(bgr, g, [(c, g.rows - 1) for c in range(g.cols)]):
            g = GridInfo(g.x0, g.y0, g.cell_w, g.cell_h, g.cols, g.rows - 1, g.confidence)
            trimmed = True
        if g.cols > MIN_GRID and not _line_is_boardlike(bgr, g, [(0, r) for r in range(g.rows)]):
            g = GridInfo(int(g.x0 + g.cell_w), g.y0, g.cell_w, g.cell_h, g.cols - 1, g.rows, g.confidence)
            trimmed = True
        if g.cols > MIN_GRID and not _line_is_boardlike(bgr, g, [(g.cols - 1, r) for r in range(g.rows)]):
            g = GridInfo(g.x0, g.y0, g.cell_w, g.cell_h, g.cols - 1, g.rows, g.confidence)
            trimmed = True
        if not trimmed:
            break
    return g


def read_board(bgr: np.ndarray, grid: GridInfo, n_kinds: int = 8
               ) -> Tuple[np.ndarray, float]:
    """Sample each cell and cluster the colours into symbolic kinds.

    Returns (board, confidence). Clustering is done on the observed cell colours
    rather than against a fixed palette, so it adapts to any skin -- but it cannot
    know what a candy *is*, only that two cells match, which is all match-3 needs.
    """
    # MEDIAN of the cell interior, not the mean, and not a centre patch.
    #
    # A tile is a solid background colour with an icon drawn on top, and the icon
    # sits dead centre -- so a centre sample measures the ICON and a mean is dragged
    # toward it. Measured on the fixture, centre-mean collapsed six candy types into
    # five and produced 112 phantom legal moves; the median recovers all six because
    # the icon is a minority of the tile's area.
    samples = []
    for ry in range(grid.rows):
        for rx in range(grid.cols):
            cx, cy = grid.cell_centre(rx, ry)
            half_w = max(3, int(grid.cell_w * 0.34))
            half_h = max(3, int(grid.cell_h * 0.34))
            y0, y1 = max(0, cy - half_h), min(bgr.shape[0], cy + half_h)
            x0, x1 = max(0, cx - half_w), min(bgr.shape[1], cx + half_w)
            patch = bgr[y0:y1, x0:x1]
            if patch.size:
                samples.append(np.median(patch.reshape(-1, 3), axis=0))
            else:
                samples.append(np.zeros(3))
    pts = np.array(samples, dtype=np.float32)

    # Greedy clustering: colours in a match-3 skin are chosen to be far apart, so a
    # distance threshold separates them without needing k-means.
    centres: List[np.ndarray] = []
    labels = np.zeros(len(pts), dtype=np.int16)
    # Measured minimum separation between the fixture's six tile colours is 63 in
    # BGR distance, so 60 sits uncomfortably close to merging two of them. 42 keeps
    # a real margin without splitting a single colour across lighting variation.
    THRESH = 42.0
    for i, p in enumerate(pts):
        best, bd = -1, 1e9
        for ci, c in enumerate(centres):
            d = float(np.linalg.norm(p - c))
            if d < bd:
                bd, best = d, ci
        if best >= 0 and bd < THRESH:
            labels[i] = best
            centres[best] = (centres[best] * 0.9 + p * 0.1)
        else:
            centres.append(p.copy())
            labels[i] = len(centres) - 1

    board = labels.reshape(grid.rows, grid.cols)
    # Confidence: a real board has a small number of kinds, each appearing often.
    k = len(centres)
    if k < 3 or k > n_kinds + 2:
        conf = 0.3
    else:
        counts = np.bincount(labels)
        conf = float(min(1.0, 0.55 + 0.45 * (counts.min() / max(counts.mean(), 1))))
    return board, round(conf, 3)


def _matches_after_swap(board: np.ndarray, a: Tuple[int, int], b: Tuple[int, int]) -> int:
    """How many cells would clear if a and b were swapped. 0 means illegal."""
    g = board.copy()
    (ax, ay), (bx, by) = a, b
    g[ay, ax], g[by, bx] = g[by, bx], g[ay, ax]
    rows, cols = g.shape
    hit = set()
    for y in range(rows):
        run = 1
        for x in range(1, cols):
            if g[y, x] == g[y, x - 1]:
                run += 1
            else:
                if run >= 3:
                    hit.update((x - 1 - k, y) for k in range(run))
                run = 1
        if run >= 3:
            hit.update((cols - 1 - k, y) for k in range(run))
    for x in range(cols):
        run = 1
        for y in range(1, rows):
            if g[y, x] == g[y - 1, x]:
                run += 1
            else:
                if run >= 3:
                    hit.update((x, y - 1 - k) for k in range(run))
                run = 1
        if run >= 3:
            hit.update((x, rows - 1 - k) for k in range(run))
    return len(hit)


@dataclass
class Swap:
    a: Tuple[int, int]
    b: Tuple[int, int]
    cleared: int

    @property
    def sig(self) -> str:
        # Stable, symbolic, coordinate-free in the SCREEN sense: these are grid
        # indices, which do not move when the window does.
        return "swap:%d_%d__%d_%d" % (self.a[0], self.a[1], self.b[0], self.b[1])


def valid_swaps(board: np.ndarray) -> List[Swap]:
    """Every legal move, computed from the symbols. No model involved.

    This is the half of the problem that is mechanical. Enumerating what is possible
    is cheap and exact; choosing among the results is the part that needs judgement,
    and that is the only part the model is asked about.
    """
    rows, cols = board.shape
    out: List[Swap] = []
    for y in range(rows):
        for x in range(cols):
            for dx, dy in ((1, 0), (0, 1)):
                nx, ny = x + dx, y + dy
                if nx >= cols or ny >= rows:
                    continue
                n = _matches_after_swap(board, (x, y), (nx, ny))
                if n >= 3:
                    out.append(Swap((x, y), (nx, ny), n))
    out.sort(key=lambda s: -s.cleared)
    return out


def swap_macros(grid: GridInfo, swaps: Sequence[Swap], origin_x: int, origin_y: int,
                limit: int = 12) -> List[MacroAction]:
    """Turn symbolic swaps into executable macros with real screen coordinates.

    `origin_x/y` is the capture region's position on screen, so cell centres become
    absolute screen pixels -- which is what SendInput needs. This is the exact point
    where symbols become pixels, and it happens in the harness, never in the model.
    """
    out = []
    for s in swaps[:limit]:
        ax, ay = grid.cell_centre(*s.a)
        bx, by = grid.cell_centre(*s.b)
        out.append(MacroAction(
            sig=s.sig,
            verb="ui_point",
            label="swap to clear %d tiles" % s.cleared,
            script=[
                InputStep(kind="mouseTo", x=origin_x + ax, y=origin_y + ay),
                InputStep(kind="sleep", ms=40),
                InputStep(kind="click"),
                InputStep(kind="sleep", ms=90),
                InputStep(kind="mouseTo", x=origin_x + bx, y=origin_y + by),
                InputStep(kind="sleep", ms=40),
                InputStep(kind="click"),
            ],
            origin="derived",
            affordance_confidence=grid.confidence,
        ))
    return out


class BoardReader:
    """Reads boards with a PERSISTENT colour palette.

    `read_board` on its own clusters each frame independently and numbers the
    clusters in the order it meets them, so the same candy gets a different symbol
    from one frame to the next. That is harmless when matching within a single read,
    and badly wrong the moment two reads are compared: measured on the fixture, a
    move that truly changed 3-5 cells appeared to change 20-43, because most of the
    "difference" was relabelling.

    Since before/after comparison is what tells a working action from a dead one --
    a core input to the friction metric -- the palette has to persist.
    """

    def __init__(self, threshold: float = 42.0, max_kinds: int = 10):
        self.centres: List[np.ndarray] = []
        self.threshold = threshold
        self.max_kinds = max_kinds
        self.reads = 0
        self.new_kinds = 0

    def read(self, bgr: np.ndarray, grid: GridInfo) -> Tuple[np.ndarray, float]:
        self.reads += 1
        labels = []
        for ry in range(grid.rows):
            for rx in range(grid.cols):
                cx, cy = grid.cell_centre(rx, ry)
                hw = max(3, int(grid.cell_w * 0.34))
                hh = max(3, int(grid.cell_h * 0.34))
                y0, y1 = max(0, cy - hh), min(bgr.shape[0], cy + hh)
                x0, x1 = max(0, cx - hw), min(bgr.shape[1], cx + hw)
                patch = bgr[y0:y1, x0:x1]
                col = (np.median(patch.reshape(-1, 3), axis=0).astype(np.float32)
                       if patch.size else np.zeros(3, dtype=np.float32))

                best, bd = -1, 1e9
                for ci, c in enumerate(self.centres):
                    d = float(np.linalg.norm(col - c))
                    if d < bd:
                        bd, best = d, ci
                if best >= 0 and bd < self.threshold:
                    # Drift slowly so the palette tracks lighting without wandering.
                    self.centres[best] = self.centres[best] * 0.97 + col * 0.03
                    labels.append(best)
                elif len(self.centres) < self.max_kinds:
                    self.centres.append(col.copy())
                    self.new_kinds += 1
                    labels.append(len(self.centres) - 1)
                else:
                    labels.append(best if best >= 0 else 0)

        board = np.array(labels, dtype=np.int16).reshape(grid.rows, grid.cols)
        k = len(set(labels))
        counts = np.bincount(np.array(labels), minlength=max(1, len(self.centres)))
        counts = counts[counts > 0]
        conf = 0.3 if k < 3 else float(min(1.0, 0.55 + 0.45 * (counts.min() / max(counts.mean(), 1))))
        return board, round(conf, 3)


class SettleDetector:
    """Is the board still animating?

    After a move a match-3 cascades for 1-3 seconds. Reading the board mid-cascade
    gives a state that is already wrong by the time an action is chosen, so every
    decision must wait for stillness.

    Reuses the frame-motion signal built for cutscene suppression: the question
    "is the game busy?" is the same one, asked of a different genre.
    """

    def __init__(self, still_frames: int = 3, threshold: int = 3):
        self.still_frames = still_frames
        self.threshold = threshold
        self._prev = None
        self._still = 0

    def update(self, digest) -> bool:
        """Feed a FrameDigest. Returns True when the board has been still long enough."""
        if self._prev is not None:
            if digest.distance(self._prev) <= self.threshold:
                self._still += 1
            else:
                self._still = 0
        self._prev = digest
        return self._still >= self.still_frames

    def reset(self) -> None:
        self._still = 0
        self._prev = None
