/**
 * Measures whether the System One model's confidence means what it says.
 *
 * This is not a nice-to-have report. Two decisions in this system read directly
 * from it:
 *
 *   - the escalation gate (below what confidence do we wake Tier 2?), and
 *   - the invariant reporting gate (what violation rate beats model noise?).
 *
 * Both are set from the numbers produced here. If confidence is overconfident on
 * our workload, escalation quietly stops firing and bad decisions sail through with
 * no error anywhere - the failure is silent, which is exactly why it has to be
 * measured rather than assumed.
 */

export interface CalibrationSample {
  reported: number;
  correct: boolean;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanReported: number;
  empiricalAccuracy: number;
  /** Positive = overconfident in this bin. */
  gap: number;
}

export interface CalibrationReport {
  n: number;
  accuracy: number;
  meanConfidence: number;
  /** Expected Calibration Error: mean |reported - actual|, weighted by bin size. */
  ece: number;
  /** Worst single-bin gap, which is what actually bites at a threshold. */
  maxGap: number;
  overconfident: boolean;
  bins: CalibrationBin[];
  /** Measured error rate - feeds the invariant reporting gate. */
  errorRate: number;
  /**
   * Lowest confidence threshold at which observed accuracy reaches the target.
   * Null when no threshold achieves it, which means escalate far more or fix the
   * state representation.
   */
  recommendedGate: number | null;
  targetAccuracy: number;
}

export function calibrate(
  samples: CalibrationSample[],
  opts: { bins?: number; targetAccuracy?: number } = {},
): CalibrationReport {
  const binCount = opts.bins ?? 10;
  const target = opts.targetAccuracy ?? 0.95;
  const n = samples.length;

  if (n === 0) {
    return {
      n: 0,
      accuracy: 0,
      meanConfidence: 0,
      ece: 0,
      maxGap: 0,
      overconfident: false,
      bins: [],
      errorRate: 0,
      recommendedGate: null,
      targetAccuracy: target,
    };
  }

  const correct = samples.filter((s) => s.correct).length;
  const accuracy = correct / n;
  const meanConfidence = samples.reduce((a, s) => a + s.reported, 0) / n;

  const bins: CalibrationBin[] = [];
  let ece = 0;
  let maxGap = 0;
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    const inBin = samples.filter((s) => (i === binCount - 1 ? s.reported >= lo && s.reported <= hi : s.reported >= lo && s.reported < hi));
    if (inBin.length === 0) continue;
    const meanRep = inBin.reduce((a, s) => a + s.reported, 0) / inBin.length;
    const acc = inBin.filter((s) => s.correct).length / inBin.length;
    const gap = meanRep - acc;
    ece += (inBin.length / n) * Math.abs(gap);
    if (Math.abs(gap) > Math.abs(maxGap)) maxGap = gap;
    bins.push({ lo, hi, n: inBin.length, meanReported: meanRep, empiricalAccuracy: acc, gap });
  }

  // Sweep candidate thresholds and find the lowest that actually delivers the
  // target accuracy on this workload. This is the number the escalation gate uses.
  let recommendedGate: number | null = null;
  for (let t = 0; t <= 100; t++) {
    const th = t / 100;
    const kept = samples.filter((s) => s.reported >= th);
    if (kept.length < Math.max(20, n * 0.02)) break; // too few left to trust
    const acc = kept.filter((s) => s.correct).length / kept.length;
    if (acc >= target) {
      recommendedGate = th;
      break;
    }
  }

  return {
    n,
    accuracy,
    meanConfidence,
    ece,
    maxGap,
    overconfident: meanConfidence - accuracy > 0.02,
    bins,
    errorRate: 1 - accuracy,
    recommendedGate,
    targetAccuracy: target,
  };
}

/** Terminal-friendly reliability diagram. Perfect calibration is the diagonal. */
export function renderReliabilityDiagram(r: CalibrationReport): string {
  const lines: string[] = [];
  lines.push("confidence   n      reported  actual   gap");
  lines.push("--------------------------------------------------------");
  for (const b of r.bins) {
    const label = b.lo.toFixed(1) + "-" + b.hi.toFixed(1);
    const bar = (v: number) => "#".repeat(Math.round(v * 20)).padEnd(20, ".");
    lines.push(
      label.padEnd(12) +
        String(b.n).padEnd(7) +
        b.meanReported.toFixed(3).padEnd(10) +
        b.empiricalAccuracy.toFixed(3).padEnd(9) +
        (b.gap >= 0 ? "+" : "") +
        b.gap.toFixed(3),
    );
    lines.push("             " + bar(b.empiricalAccuracy) + "  actual");
  }
  lines.push("--------------------------------------------------------");
  lines.push(
    "n=" +
      r.n +
      "  accuracy=" +
      r.accuracy.toFixed(3) +
      "  meanConfidence=" +
      r.meanConfidence.toFixed(3) +
      "  ECE=" +
      r.ece.toFixed(3),
  );
  // Three verdicts, not two. Underconfidence is still miscalibration - it is
  // merely the safe direction: correctness is fine but the gate escalates
  // decisions the model already had right, and every one of those is an LLM call
  // bought for nothing.
  const gap = r.meanConfidence - r.accuracy;
  if (r.overconfident) {
    lines.push(
      "VERDICT: OVERCONFIDENT by " +
        gap.toFixed(3) +
        " - escalation will under-fire and wrong answers will pass as findings. " +
        "Raise the gate or fix the state representation.",
    );
  } else if (gap < -0.05) {
    lines.push(
      "VERDICT: UNDERCONFIDENT by " +
        (-gap).toFixed(3) +
        " - safe but wasteful: Tier 2 is being woken for decisions Tier 1 got right. " +
        "Lower the gate to recover the cost.",
    );
  } else {
    lines.push("VERDICT: well calibrated (mean confidence tracks accuracy).");
  }
  lines.push(
    r.recommendedGate === null
      ? "No threshold reaches " +
        r.targetAccuracy +
        " accuracy on this workload. Escalate more, or the questions are too hard as posed."
      : "Recommended escalation gate: " +
        r.recommendedGate.toFixed(2) +
        " (lowest confidence delivering " +
        r.targetAccuracy +
        " accuracy)",
  );
  return lines.join("\n");
}
