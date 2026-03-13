"""
Negotiation Policy Registry
============================
Filesystem-based registry for CFR negotiation strategy artifacts.
Mirrors ModelLifecycleRegistry pattern with negotiation-specific fields.

Lifecycle: CANDIDATE -> STAGED -> PROD -> DEPRECATED

Storage layout:
  <registry_root>/negotiation_policies/
    artifacts.json        # {artifact_id: PolicyRecord}
    prod_pointers.json    # {scenario_id: artifact_id}
    promotion_log.json    # [PromotionEvent, ...]
    strategies/           # binary .cfr2.gz files
"""

import json
import logging
import os
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_REGISTRY_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store"
)

DEFAULT_POLICY_DIR = os.path.join(DEFAULT_REGISTRY_ROOT, "negotiation_policies")


# ── Lifecycle States ─────────────────────────────────────────────────────────

class PolicyLifecycleState:
    CANDIDATE = "CANDIDATE"
    STAGED = "STAGED"
    PROD = "PROD"
    DEPRECATED = "DEPRECATED"


# ── Data Classes ─────────────────────────────────────────────────────────────

@dataclass
class PolicyRecord:
    """A registered negotiation strategy artifact."""
    artifact_id: str
    scenario_id: str               # e.g., 'cooperative_normal'
    strategy_path: str             # path to binary or JSONL strategy file
    iterations: int = 0
    exploitability: float = 0.0
    info_set_count: int = 0
    game_config: Dict = field(default_factory=dict)  # PAYOFF_CONFIG snapshot
    metrics_summary: Dict = field(default_factory=dict)
    created_at: str = ""
    git_sha: str = ""
    lifecycle_state: str = PolicyLifecycleState.CANDIDATE
    promotion_history: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: Dict) -> "PolicyRecord":
        return PolicyRecord(**{
            k: v for k, v in d.items()
            if k in PolicyRecord.__dataclass_fields__
        })


@dataclass
class PolicyPromotionEvent:
    artifact_id: str
    scenario_id: str
    from_state: str
    to_state: str
    approved_by: str = ""
    note: str = ""
    timestamp: str = ""
    override: bool = False

    def to_dict(self) -> Dict:
        return asdict(self)


# ── Promotion Gates (negotiation-specific) ───────────────────────────────────

@dataclass
class NegotiationPolicyGateConfig:
    """Thresholds for negotiation policy promotion."""
    max_exploitability: float = 0.05
    min_iterations: int = 10_000
    min_info_set_coverage: float = 0.95

    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class NegotiationPolicyGateResult:
    can_promote: bool
    reasons: List[str] = field(default_factory=list)
    config_used: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return asdict(self)


def evaluate_negotiation_policy_gates(
    record: Dict,
    config: Optional[NegotiationPolicyGateConfig] = None,
) -> NegotiationPolicyGateResult:
    """
    Evaluate whether a negotiation policy is eligible for promotion.

    Checks:
      1. exploitability < threshold (convergence quality)
      2. iterations >= minimum (sufficient training)
      3. info_set_coverage >= threshold (completeness)
    """
    if config is None:
        config = NegotiationPolicyGateConfig()

    reasons = []

    # Gate 1: Exploitability
    exploit = record.get("exploitability", 1.0)
    if exploit > config.max_exploitability:
        reasons.append(
            f"exploitability={exploit:.4f} > max={config.max_exploitability:.4f}"
        )

    # Gate 2: Iterations
    iters = record.get("iterations", 0)
    if iters < config.min_iterations:
        reasons.append(
            f"iterations={iters} < min={config.min_iterations}"
        )

    # Gate 3: Info-set coverage
    metrics = record.get("metrics_summary", {})
    coverage = metrics.get("info_set_coverage", 0.0)
    if coverage < config.min_info_set_coverage:
        reasons.append(
            f"info_set_coverage={coverage:.3f} < min={config.min_info_set_coverage:.3f}"
        )

    can_promote = len(reasons) == 0
    if can_promote:
        reasons.append("All negotiation policy gates passed")

    return NegotiationPolicyGateResult(
        can_promote=can_promote,
        reasons=reasons,
        config_used=config.to_dict(),
    )


# ── Filesystem Helpers ───────────────────────────────────────────────────────

def _atomic_write_json(path: str, data: Any):
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _read_json(path: str, default=None):
    if not os.path.exists(path):
        return default if default is not None else {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── Registry ─────────────────────────────────────────────────────────────────

class NegotiationPolicyRegistry:
    """
    Filesystem-based negotiation policy lifecycle registry.

    Tracks CFR strategy artifacts through CANDIDATE -> STAGED -> PROD -> DEPRECATED.
    """

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_POLICY_DIR)
        os.makedirs(self.root, exist_ok=True)

    # ── File paths ──

    @property
    def _artifacts_path(self) -> str:
        return os.path.join(self.root, "artifacts.json")

    @property
    def _pointers_path(self) -> str:
        return os.path.join(self.root, "prod_pointers.json")

    @property
    def _promotion_log_path(self) -> str:
        return os.path.join(self.root, "promotion_log.json")

    # ── Core API ──

    def register_artifact(
        self,
        strategy_path: str,
        metadata: Dict,
    ) -> str:
        """
        Register a new policy artifact as CANDIDATE.

        Args:
            strategy_path: Path to binary/JSONL strategy file.
            metadata: Must include scenario_id. May include iterations,
                      exploitability, info_set_count, game_config, etc.

        Returns:
            artifact_id (stable UUID-based identifier).
        """
        artifact_id = f"neg_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()

        record = PolicyRecord(
            artifact_id=artifact_id,
            scenario_id=metadata.get("scenario_id", ""),
            strategy_path=strategy_path,
            iterations=metadata.get("iterations", 0),
            exploitability=metadata.get("exploitability", 0.0),
            info_set_count=metadata.get("info_set_count", 0),
            game_config=metadata.get("game_config", {}),
            metrics_summary=metadata.get("metrics_summary", {}),
            created_at=now,
            git_sha=metadata.get("git_sha", ""),
            lifecycle_state=PolicyLifecycleState.CANDIDATE,
            promotion_history=[],
        )

        artifacts = _read_json(self._artifacts_path, {})
        artifacts[artifact_id] = record.to_dict()
        _atomic_write_json(self._artifacts_path, artifacts)

        logger.info(
            "Registered negotiation policy %s for scenario=%s",
            artifact_id, record.scenario_id,
        )
        return artifact_id

    def list_artifacts(self, filters: Optional[Dict] = None) -> List[Dict]:
        """List artifacts with optional filters (scenario_id, lifecycle_state)."""
        artifacts = _read_json(self._artifacts_path, {})
        results = list(artifacts.values())

        if filters:
            for key in ("scenario_id", "lifecycle_state"):
                if key in filters and filters[key]:
                    results = [r for r in results if r.get(key) == filters[key]]

        return results

    def get_artifact(self, artifact_id: str) -> Optional[Dict]:
        artifacts = _read_json(self._artifacts_path, {})
        return artifacts.get(artifact_id)

    def promote_to_prod(
        self,
        scenario_id: str,
        artifact_id: str,
        approved_by: str = "",
        note: str = "",
        override: bool = False,
        enforce_gates: bool = True,
    ) -> Dict:
        """
        Promote a policy to PROD for a scenario.

        If enforce_gates=True, runs negotiation-specific promotion gates.
        Previous PROD is set to DEPRECATED.
        """
        artifacts = _read_json(self._artifacts_path, {})
        record = artifacts.get(artifact_id)
        if not record:
            raise ValueError(f"Policy artifact {artifact_id} not found")

        if record["scenario_id"] != scenario_id:
            raise ValueError(
                f"Artifact {artifact_id} belongs to scenario {record['scenario_id']}, "
                f"not {scenario_id}"
            )

        # Gate enforcement
        if enforce_gates and not override:
            gate_result = evaluate_negotiation_policy_gates(record)
            if not gate_result.can_promote:
                raise ValueError(
                    f"Policy gates failed for {artifact_id}: "
                    + "; ".join(gate_result.reasons)
                )

        # Deprecate current PROD (if any)
        pointers = _read_json(self._pointers_path, {})
        old_prod_id = pointers.get(scenario_id)
        if old_prod_id and old_prod_id != artifact_id:
            old_record = artifacts.get(old_prod_id)
            if old_record:
                old_record["lifecycle_state"] = PolicyLifecycleState.DEPRECATED
                dep_event = PolicyPromotionEvent(
                    artifact_id=old_prod_id,
                    scenario_id=scenario_id,
                    from_state=PolicyLifecycleState.PROD,
                    to_state=PolicyLifecycleState.DEPRECATED,
                    note=f"Superseded by {artifact_id}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
                old_record.setdefault("promotion_history", []).append(dep_event.to_dict())
                artifacts[old_prod_id] = old_record
                self._append_promotion_log(dep_event)

        # Promote
        old_state = record["lifecycle_state"]
        record["lifecycle_state"] = PolicyLifecycleState.PROD

        event = PolicyPromotionEvent(
            artifact_id=artifact_id,
            scenario_id=scenario_id,
            from_state=old_state,
            to_state=PolicyLifecycleState.PROD,
            approved_by=approved_by,
            note=note,
            timestamp=datetime.now(timezone.utc).isoformat(),
            override=override,
        )
        record.setdefault("promotion_history", []).append(event.to_dict())

        artifacts[artifact_id] = record
        _atomic_write_json(self._artifacts_path, artifacts)

        pointers[scenario_id] = artifact_id
        _atomic_write_json(self._pointers_path, pointers)

        self._append_promotion_log(event)

        logger.info(
            "Promoted negotiation policy %s to PROD for scenario %s (override=%s)",
            artifact_id, scenario_id, override,
        )
        return record

    def rollback_prod(self, scenario_id: str, steps: int = 1) -> Optional[Dict]:
        """Rollback to a previous PROD policy for a scenario."""
        log = _read_json(self._promotion_log_path, [])

        prod_promotions = [
            e for e in log
            if e.get("scenario_id") == scenario_id
            and e.get("to_state") == PolicyLifecycleState.PROD
        ]

        if len(prod_promotions) < 2:
            logger.warning(
                "Cannot rollback scenario %s: not enough PROD history (found %d)",
                scenario_id, len(prod_promotions),
            )
            return None

        target_idx = max(0, len(prod_promotions) - 1 - steps)
        target_event = prod_promotions[target_idx]
        target_artifact_id = target_event["artifact_id"]

        artifacts = _read_json(self._artifacts_path, {})
        target_record = artifacts.get(target_artifact_id)
        if not target_record:
            logger.error("Rollback target %s not found", target_artifact_id)
            return None

        # Deprecate current
        pointers = _read_json(self._pointers_path, {})
        current_prod_id = pointers.get(scenario_id)
        if current_prod_id and current_prod_id != target_artifact_id:
            current_record = artifacts.get(current_prod_id)
            if current_record:
                current_record["lifecycle_state"] = PolicyLifecycleState.DEPRECATED
                dep_event = PolicyPromotionEvent(
                    artifact_id=current_prod_id,
                    scenario_id=scenario_id,
                    from_state=PolicyLifecycleState.PROD,
                    to_state=PolicyLifecycleState.DEPRECATED,
                    note=f"Rolled back in favor of {target_artifact_id}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
                current_record.setdefault("promotion_history", []).append(dep_event.to_dict())
                artifacts[current_prod_id] = current_record
                self._append_promotion_log(dep_event)

        # Restore target
        old_state = target_record["lifecycle_state"]
        target_record["lifecycle_state"] = PolicyLifecycleState.PROD

        restore_event = PolicyPromotionEvent(
            artifact_id=target_artifact_id,
            scenario_id=scenario_id,
            from_state=old_state,
            to_state=PolicyLifecycleState.PROD,
            note=f"Rollback (steps={steps})",
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        target_record.setdefault("promotion_history", []).append(restore_event.to_dict())

        artifacts[target_artifact_id] = target_record
        _atomic_write_json(self._artifacts_path, artifacts)

        pointers[scenario_id] = target_artifact_id
        _atomic_write_json(self._pointers_path, pointers)

        self._append_promotion_log(restore_event)

        logger.info(
            "Rolled back scenario %s to policy %s (steps=%d)",
            scenario_id, target_artifact_id, steps,
        )
        return target_record

    # ── Query helpers ──

    def get_prod_pointer(self, scenario_id: str) -> Optional[str]:
        pointers = _read_json(self._pointers_path, {})
        return pointers.get(scenario_id)

    def get_prod_artifact(self, scenario_id: str) -> Optional[Dict]:
        artifact_id = self.get_prod_pointer(scenario_id)
        if not artifact_id:
            return None
        return self.get_artifact(artifact_id)

    def get_all_prod_pointers(self) -> Dict[str, str]:
        return _read_json(self._pointers_path, {})

    def get_promotion_log(
        self,
        scenario_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict]:
        log = _read_json(self._promotion_log_path, [])
        if scenario_id:
            log = [e for e in log if e.get("scenario_id") == scenario_id]
        return log[-limit:]

    # ── Internal ──

    def _append_promotion_log(self, event: PolicyPromotionEvent):
        log = _read_json(self._promotion_log_path, [])
        log.append(event.to_dict())
        _atomic_write_json(self._promotion_log_path, log)
