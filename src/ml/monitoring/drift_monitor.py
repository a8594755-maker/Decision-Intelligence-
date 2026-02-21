"""
PR-E Deliverable 4: Drift Monitoring
=====================================
Computes and persists drift signals for data distribution shift
and residual (forecast error) drift.

Drift types:
  A) Data drift: input distribution shift between baseline and recent windows.
     - PSI (Population Stability Index)
     - Z-score shift on mean/std
  B) Residual drift: forecast error distribution shift.
     - Rolling MAPE change
     - Rolling bias change
     - Rolling coverage_10_90 change
     - Residual mean/std shift vs baseline

Thresholds (defaults, configurable):
  - PSI > 0.2 → significant data drift
  - Z-score shift > 2.0 → significant mean shift
  - MAPE increase > 10 points → residual drift
  - Coverage drop > 0.15 → residual drift
"""
import json
import logging
import os
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_DRIFT_STORE = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store", "drift_reports"
)


@dataclass
class DriftConfig:
    """Configurable thresholds for drift detection."""

    # Data drift thresholds
    psi_threshold: float = 0.2
    zscore_shift_threshold: float = 2.0

    # Residual drift thresholds
    mape_increase_threshold: float = 10.0      # percentage points
    bias_shift_threshold: float = 2.0          # in units of baseline std
    coverage_drop_threshold: float = 0.15      # absolute drop

    # Window sizes
    default_baseline_size: int = 60            # days
    default_recent_size: int = 14              # days

    # PSI binning
    psi_n_bins: int = 10

    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class DriftReport:
    """Result of a drift analysis run."""

    report_id: str = ""
    series_id: str = ""
    created_at: str = ""

    # Scores
    data_drift_score: float = 0.0
    residual_drift_score: float = 0.0
    drift_score: float = 0.0   # combined

    # Flags
    drift_flags: List[str] = field(default_factory=list)

    # Data drift details
    psi: Optional[float] = None
    mean_zscore_shift: Optional[float] = None
    std_ratio: Optional[float] = None

    # Residual drift details
    baseline_mape: Optional[float] = None
    recent_mape: Optional[float] = None
    baseline_bias: Optional[float] = None
    recent_bias: Optional[float] = None
    baseline_coverage: Optional[float] = None
    recent_coverage: Optional[float] = None
    residual_mean_shift: Optional[float] = None
    residual_std_ratio: Optional[float] = None

    # Window definitions
    baseline_window_start: str = ""
    baseline_window_end: str = ""
    recent_window_start: str = ""
    recent_window_end: str = ""

    # Config used
    config: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: Dict) -> "DriftReport":
        return DriftReport(**{
            k: v for k, v in d.items()
            if k in DriftReport.__dataclass_fields__
        })


def compute_psi(
    baseline: np.ndarray,
    recent: np.ndarray,
    n_bins: int = 10,
) -> float:
    """
    Population Stability Index between two distributions.

    PSI < 0.1  → no significant shift
    PSI 0.1-0.2 → moderate shift
    PSI > 0.2  → significant shift
    """
    eps = 1e-8

    # Use common bin edges from the baseline
    all_data = np.concatenate([baseline, recent])
    _, bin_edges = np.histogram(all_data, bins=n_bins)

    baseline_counts, _ = np.histogram(baseline, bins=bin_edges)
    recent_counts, _ = np.histogram(recent, bins=bin_edges)

    # Normalize to proportions
    baseline_pct = (baseline_counts + eps) / (baseline_counts.sum() + eps * n_bins)
    recent_pct = (recent_counts + eps) / (recent_counts.sum() + eps * n_bins)

    psi = float(np.sum((recent_pct - baseline_pct) * np.log(recent_pct / baseline_pct)))
    return max(0.0, psi)


def compute_zscore_shift(
    baseline: np.ndarray,
    recent: np.ndarray,
) -> float:
    """Z-score of recent mean relative to baseline distribution."""
    baseline_mean = np.mean(baseline)
    baseline_std = np.std(baseline)
    recent_mean = np.mean(recent)

    if baseline_std < 1e-10:
        return 0.0

    return float(abs(recent_mean - baseline_mean) / baseline_std)


def compute_data_drift(
    baseline_values: Sequence[float],
    recent_values: Sequence[float],
    config: Optional[DriftConfig] = None,
) -> Dict:
    """
    Compute data drift between baseline and recent value windows.

    Returns dict with psi, zscore_shift, std_ratio, score, and flags.
    """
    if config is None:
        config = DriftConfig()

    baseline = np.array(baseline_values, dtype=float)
    recent = np.array(recent_values, dtype=float)

    if len(baseline) < 2 or len(recent) < 2:
        return {
            "psi": 0.0,
            "mean_zscore_shift": 0.0,
            "std_ratio": 1.0,
            "data_drift_score": 0.0,
            "flags": [],
        }

    psi = compute_psi(baseline, recent, n_bins=config.psi_n_bins)
    zscore = compute_zscore_shift(baseline, recent)

    baseline_std = float(np.std(baseline))
    recent_std = float(np.std(recent))
    std_ratio = recent_std / (baseline_std + 1e-10)

    # Combined score: weighted PSI + zscore
    score = min(1.0, (psi / config.psi_threshold) * 0.5 + (zscore / config.zscore_shift_threshold) * 0.5)

    flags = []
    if psi > config.psi_threshold:
        flags.append("data_drift_high")
    if zscore > config.zscore_shift_threshold:
        flags.append("mean_shift_high")

    return {
        "psi": round(psi, 6),
        "mean_zscore_shift": round(zscore, 4),
        "std_ratio": round(std_ratio, 4),
        "data_drift_score": round(score, 4),
        "flags": flags,
    }


def compute_residual_drift(
    baseline_actuals: Sequence[float],
    baseline_predictions: Sequence[float],
    recent_actuals: Sequence[float],
    recent_predictions: Sequence[float],
    baseline_p10: Optional[Sequence[float]] = None,
    baseline_p90: Optional[Sequence[float]] = None,
    recent_p10: Optional[Sequence[float]] = None,
    recent_p90: Optional[Sequence[float]] = None,
    config: Optional[DriftConfig] = None,
) -> Dict:
    """
    Compute residual drift between baseline and recent forecast errors.

    Returns dict with mape changes, bias changes, coverage changes,
    residual distribution shift, score, and flags.
    """
    if config is None:
        config = DriftConfig()

    b_act = np.array(baseline_actuals, dtype=float)
    b_pred = np.array(baseline_predictions, dtype=float)
    r_act = np.array(recent_actuals, dtype=float)
    r_pred = np.array(recent_predictions, dtype=float)

    if len(b_act) < 2 or len(r_act) < 2:
        return {
            "baseline_mape": 0.0,
            "recent_mape": 0.0,
            "baseline_bias": 0.0,
            "recent_bias": 0.0,
            "residual_mean_shift": 0.0,
            "residual_std_ratio": 1.0,
            "residual_drift_score": 0.0,
            "flags": [],
        }

    # MAPE computation (exclude zeros)
    def _mape(act, pred):
        mask = act != 0
        if not mask.any():
            return 0.0
        return float(np.mean(np.abs((act[mask] - pred[mask]) / act[mask])) * 100)

    baseline_mape = _mape(b_act, b_pred)
    recent_mape = _mape(r_act, r_pred)
    mape_increase = recent_mape - baseline_mape

    # Bias
    baseline_bias = float(np.mean(b_pred - b_act))
    recent_bias = float(np.mean(r_pred - r_act))

    # Residual distribution shift
    b_residuals = b_act - b_pred
    r_residuals = r_act - r_pred
    b_res_mean = float(np.mean(b_residuals))
    b_res_std = float(np.std(b_residuals))
    r_res_mean = float(np.mean(r_residuals))
    r_res_std = float(np.std(r_residuals))

    if b_res_std > 1e-10:
        residual_mean_shift = abs(r_res_mean - b_res_mean) / b_res_std
    else:
        residual_mean_shift = 0.0

    residual_std_ratio = r_res_std / (b_res_std + 1e-10)

    # Coverage (if quantiles available)
    baseline_coverage = None
    recent_coverage = None
    coverage_drop = 0.0

    if baseline_p10 is not None and baseline_p90 is not None:
        bp10 = np.array(baseline_p10, dtype=float)
        bp90 = np.array(baseline_p90, dtype=float)
        in_interval = (b_act >= bp10) & (b_act <= bp90)
        baseline_coverage = float(np.mean(in_interval))

    if recent_p10 is not None and recent_p90 is not None:
        rp10 = np.array(recent_p10, dtype=float)
        rp90 = np.array(recent_p90, dtype=float)
        in_interval = (r_act >= rp10) & (r_act <= rp90)
        recent_coverage = float(np.mean(in_interval))

    if baseline_coverage is not None and recent_coverage is not None:
        coverage_drop = baseline_coverage - recent_coverage

    # Flags
    flags = []
    if mape_increase > config.mape_increase_threshold:
        flags.append("residual_drift_high")
    if residual_mean_shift > config.bias_shift_threshold:
        flags.append("bias_shift_high")
    if coverage_drop > config.coverage_drop_threshold:
        flags.append("coverage_bad")

    # Combined residual drift score
    mape_component = min(1.0, max(0, mape_increase) / config.mape_increase_threshold) * 0.4
    shift_component = min(1.0, residual_mean_shift / config.bias_shift_threshold) * 0.3
    coverage_component = min(1.0, max(0, coverage_drop) / config.coverage_drop_threshold) * 0.3
    score = mape_component + shift_component + coverage_component

    return {
        "baseline_mape": round(baseline_mape, 4),
        "recent_mape": round(recent_mape, 4),
        "mape_increase": round(mape_increase, 4),
        "baseline_bias": round(baseline_bias, 4),
        "recent_bias": round(recent_bias, 4),
        "baseline_coverage": round(baseline_coverage, 4) if baseline_coverage is not None else None,
        "recent_coverage": round(recent_coverage, 4) if recent_coverage is not None else None,
        "coverage_drop": round(coverage_drop, 4),
        "residual_mean_shift": round(residual_mean_shift, 4),
        "residual_std_ratio": round(residual_std_ratio, 4),
        "residual_drift_score": round(score, 4),
        "flags": flags,
    }


def run_drift_analysis(
    series_id: str,
    baseline_values: Sequence[float],
    recent_values: Sequence[float],
    baseline_actuals: Optional[Sequence[float]] = None,
    baseline_predictions: Optional[Sequence[float]] = None,
    recent_actuals: Optional[Sequence[float]] = None,
    recent_predictions: Optional[Sequence[float]] = None,
    baseline_p10: Optional[Sequence[float]] = None,
    baseline_p90: Optional[Sequence[float]] = None,
    recent_p10: Optional[Sequence[float]] = None,
    recent_p90: Optional[Sequence[float]] = None,
    baseline_window: Optional[Dict] = None,
    recent_window: Optional[Dict] = None,
    config: Optional[DriftConfig] = None,
) -> DriftReport:
    """
    Run full drift analysis (data + residual) for a series.

    Args:
        series_id: Series/SKU identifier.
        baseline_values: Raw input values for baseline window.
        recent_values: Raw input values for recent window.
        baseline_actuals/predictions: For residual drift.
        recent_actuals/predictions: For residual drift.
        baseline_window: {"start": str, "end": str} (optional).
        recent_window: {"start": str, "end": str} (optional).
        config: Drift thresholds.

    Returns:
        DriftReport with scores, flags, and details.
    """
    if config is None:
        config = DriftConfig()

    report = DriftReport(
        report_id=f"drift_{uuid.uuid4().hex[:10]}",
        series_id=series_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        config=config.to_dict(),
    )

    if baseline_window:
        report.baseline_window_start = baseline_window.get("start", "")
        report.baseline_window_end = baseline_window.get("end", "")
    if recent_window:
        report.recent_window_start = recent_window.get("start", "")
        report.recent_window_end = recent_window.get("end", "")

    # Data drift
    data_result = compute_data_drift(baseline_values, recent_values, config)
    report.data_drift_score = data_result["data_drift_score"]
    report.psi = data_result["psi"]
    report.mean_zscore_shift = data_result["mean_zscore_shift"]
    report.std_ratio = data_result["std_ratio"]
    report.drift_flags.extend(data_result["flags"])

    # Residual drift (if backtest data available)
    if (
        baseline_actuals is not None
        and baseline_predictions is not None
        and recent_actuals is not None
        and recent_predictions is not None
    ):
        res_result = compute_residual_drift(
            baseline_actuals, baseline_predictions,
            recent_actuals, recent_predictions,
            baseline_p10, baseline_p90,
            recent_p10, recent_p90,
            config,
        )
        report.residual_drift_score = res_result["residual_drift_score"]
        report.baseline_mape = res_result["baseline_mape"]
        report.recent_mape = res_result["recent_mape"]
        report.baseline_bias = res_result["baseline_bias"]
        report.recent_bias = res_result["recent_bias"]
        report.baseline_coverage = res_result.get("baseline_coverage")
        report.recent_coverage = res_result.get("recent_coverage")
        report.residual_mean_shift = res_result["residual_mean_shift"]
        report.residual_std_ratio = res_result["residual_std_ratio"]
        report.drift_flags.extend(res_result["flags"])

    # Combined drift score
    report.drift_score = round(
        0.5 * report.data_drift_score + 0.5 * report.residual_drift_score, 4
    )

    return report


class DriftReportStore:
    """Persist drift reports to filesystem as JSON files."""

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_DRIFT_STORE)
        os.makedirs(self.root, exist_ok=True)

    def save(self, report: DriftReport) -> str:
        """Save a drift report. Returns the report_id."""
        path = os.path.join(self.root, f"{report.report_id}.json")
        dir_name = os.path.dirname(path)
        os.makedirs(dir_name, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(report.to_dict(), f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, path)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
        logger.info("Saved drift report %s for series %s", report.report_id, report.series_id)
        return report.report_id

    def load(self, report_id: str) -> Optional[DriftReport]:
        """Load a drift report by ID."""
        path = os.path.join(self.root, f"{report_id}.json")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return DriftReport.from_dict(data)

    def list_reports(
        self,
        series_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[DriftReport]:
        """List drift reports, optionally filtered by series, most recent first."""
        if not os.path.isdir(self.root):
            return []

        reports = []
        for fname in sorted(os.listdir(self.root), reverse=True):
            if not fname.endswith(".json"):
                continue
            path = os.path.join(self.root, fname)
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            report = DriftReport.from_dict(data)
            if series_id and report.series_id != series_id:
                continue
            reports.append(report)
            if len(reports) >= limit:
                break

        return reports

    def get_latest(self, series_id: str) -> Optional[DriftReport]:
        """Get the most recent drift report for a series."""
        reports = self.list_reports(series_id=series_id, limit=1)
        return reports[0] if reports else None
