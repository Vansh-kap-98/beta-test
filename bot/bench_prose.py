"""
Score the real Laya model on labelled state blobs: how the state is WRITTEN crossed
with how the question is ASKED.

Both axes turned out to matter more than the model choice. Two thresholds the system
depends on are derived from the model's error rate -- the escalation gate and the
Wilson reporting gate -- so measuring it is not optional. Laya's own README reports
0.362 zero-shot on their typed-decisions benchmark against 0.766 fine-tuned.

The headline number is not accuracy. It is MISSED BUGS: a tool that cannot say "no"
produces a clean report on a broken build, which is worse than useless because it is
trusted. A false alarm only costs a reviewer a minute.
"""
import json, statistics, sys, time
from laya import Router

GATE = 0.75
path = sys.argv[1] if len(sys.argv) > 1 else "artifacts/prosebench.json"
data = json.load(open(path, encoding="utf-8"))
QS = {"healthy": data["questions"], "defect": data.get("questionsDefect", {})}

router = Router(device="cuda")


def noul_conf(p):
    """Calibrated confidence is distance from the coin flip, not p itself."""
    return max(p, 1.0 - p)


results = {}
for rendering in ("json", "prose"):
    for polarity in ("healthy", "defect"):
        qsrc = QS[polarity]
        if not qsrc:
            continue
        rows, lats = [], []
        for case in data["cases"]:
            asked = {k: {"type": "noul", "instructions": qsrc[k]}
                     for k in case["truth"] if k in qsrc}
            if not asked:
                continue
            t = time.perf_counter()
            out = router.predict(case["renderings"][rendering], asked)
            lats.append((time.perf_counter() - t) * 1000)
            for qid in asked:
                want = case["truth"][qid]          # True == healthy
                p = out["answers"][qid]["noul"]
                # Under defect-positive phrasing "yes" means the bug is present, so
                # the answer is inverted before comparing against healthy-is-true.
                said_healthy = (p <= 0.5) if polarity == "defect" else (p > 0.5)
                rows.append({"case": case["name"], "q": qid, "p": p, "want": want,
                             "correct": said_healthy == want,
                             "said_healthy": said_healthy,
                             "decisive": noul_conf(p) >= GATE})
        n = len(rows)
        broken = [r for r in rows if not r["want"]]
        missed = [r for r in broken if r["said_healthy"]]
        cw = [r for r in rows if r["decisive"] and not r["correct"]]
        key = rendering + "/" + polarity
        results[key] = dict(n=n, rows=rows, missed=missed, cw=cw, broken=broken,
                            acc=sum(r["correct"] for r in rows) / n,
                            dec=sum(r["decisive"] for r in rows) / n,
                            absorbed=sum(r["decisive"] and r["correct"] for r in rows) / n,
                            lat=statistics.median(lats))
        R = results[key]
        print("%-14s n=%-3d acc %.3f  decisive %.3f  absorbed %.3f  conf-wrong %-2d  "
              "MISSED %d/%-2d  %4.0f ms"
              % (key, n, R["acc"], R["dec"], R["absorbed"], len(cw),
                 len(missed), len(broken), R["lat"]))

print("\n=== ranked by missed bugs, then accuracy ===")
for k in sorted(results, key=lambda k: (len(results[k]["missed"]), -results[k]["acc"])):
    R = results[k]
    print("  %-14s missed %d/%-2d  acc %.3f  absorbed %.3f"
          % (k, len(R["missed"]), len(R["broken"]), R["acc"], R["absorbed"]))

best = min(results, key=lambda k: (len(results[k]["missed"]), -results[k]["acc"]))
print("\n=== %s: per-question ===" % best)
by_q = {}
for r in results[best]["rows"]:
    by_q.setdefault(r["q"], []).append(r)
for q, rs in sorted(by_q.items(), key=lambda kv: sum(x["correct"] for x in kv[1]) / len(kv[1])):
    print("  %-28s %d/%d correct" % (q, sum(x["correct"] for x in rs), len(rs)))

print("\n=== %s: bugs it still MISSED (reported healthy on a broken state) ===" % best)
for r in results[best]["missed"]:
    print("  %-36s %-28s p=%.3f" % (r["case"][:36], r["q"], r["p"]))
if not results[best]["missed"]:
    print("  none")
