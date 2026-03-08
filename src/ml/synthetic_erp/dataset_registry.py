"""
Dataset Registry — In-memory registry of generated synthetic datasets.
========================================================================
v1: Process-local singleton. Datasets are keyed by dataset_id.
    NOT suitable for production persistence or multi-worker deployments.
    Future: upgrade to DB-backed registry (Supabase / Postgres).
"""
import hashlib
import json
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional


@dataclass
class DatasetDescriptor:
    dataset_id: str
    seed: int
    config_hash: str
    created_at: str
    n_materials: int
    n_plants: int
    n_days: int
    disruptions: List[str]
    fingerprint: str


class DatasetRegistry:
    """Process-local registry of generated synthetic ERP datasets.

    Thread-safe singleton. Max 10 datasets (LRU eviction).
    """

    _instance: Optional["DatasetRegistry"] = None
    _lock = threading.Lock()
    MAX_DATASETS = 10

    @classmethod
    def get_instance(cls) -> "DatasetRegistry":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls):
        """Reset singleton (for testing)."""
        with cls._lock:
            cls._instance = None

    def __init__(self):
        self._datasets: Dict[str, Dict[str, Any]] = {}
        self._descriptors: Dict[str, DatasetDescriptor] = {}
        self._access_order: List[str] = []  # LRU tracking
        self._rw_lock = threading.Lock()

    def register(
        self,
        seed: int,
        config: Dict,
        master_data: Dict[str, Any],
        demand_data: Dict,
        inventory_data: Optional[Dict] = None,
        disruptions: Optional[List[str]] = None,
        kpis: Optional[Dict] = None,
        erp_sales: Optional[Dict] = None,
    ) -> DatasetDescriptor:
        """Register a generated dataset. Returns descriptor."""
        config_hash = self._config_hash(config)
        dataset_id = f"synth_{seed}_{config_hash[:8]}"
        fingerprint = self._compute_fingerprint(seed, config, master_data, demand_data)

        n_materials = len(master_data.get("materials", []))
        n_plants = len(master_data.get("plants", []))
        # Infer n_days from first demand DataFrame
        n_days = 0
        if demand_data:
            first_key = next(iter(demand_data))
            first_df = demand_data[first_key]
            n_days = len(first_df) if hasattr(first_df, "__len__") else 0

        descriptor = DatasetDescriptor(
            dataset_id=dataset_id,
            seed=seed,
            config_hash=config_hash,
            created_at=datetime.now(timezone.utc).isoformat(),
            n_materials=n_materials,
            n_plants=n_plants,
            n_days=n_days,
            disruptions=disruptions or [],
            fingerprint=fingerprint,
        )

        with self._rw_lock:
            # LRU eviction
            if len(self._datasets) >= self.MAX_DATASETS and dataset_id not in self._datasets:
                oldest = self._access_order[0]
                self._access_order.pop(0)
                self._datasets.pop(oldest, None)
                self._descriptors.pop(oldest, None)

            self._datasets[dataset_id] = {
                "master_data": master_data,
                "demand_data": demand_data,
                "inventory_data": inventory_data,
                "kpis": kpis,
                "erp_sales": erp_sales,
                "config": config,
            }
            self._descriptors[dataset_id] = descriptor

            # Update access order
            if dataset_id in self._access_order:
                self._access_order.remove(dataset_id)
            self._access_order.append(dataset_id)

        return descriptor

    def get(self, dataset_id: str) -> Optional[Dict[str, Any]]:
        """Get dataset payload by ID. Returns None if not found."""
        with self._rw_lock:
            data = self._datasets.get(dataset_id)
            if data is not None:
                # Touch for LRU
                if dataset_id in self._access_order:
                    self._access_order.remove(dataset_id)
                self._access_order.append(dataset_id)
            return data

    def get_descriptor(self, dataset_id: str) -> Optional[DatasetDescriptor]:
        return self._descriptors.get(dataset_id)

    def list_datasets(self) -> List[Dict[str, Any]]:
        """List all registered dataset descriptors."""
        return [asdict(d) for d in self._descriptors.values()]

    def delete(self, dataset_id: str) -> bool:
        """Delete a dataset. Returns True if found and deleted."""
        with self._rw_lock:
            if dataset_id in self._datasets:
                del self._datasets[dataset_id]
                del self._descriptors[dataset_id]
                if dataset_id in self._access_order:
                    self._access_order.remove(dataset_id)
                return True
            return False

    def _config_hash(self, config: Dict) -> str:
        raw = json.dumps(config, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def _compute_fingerprint(self, seed: int, config: Dict, master_data: Dict, demand_data: Dict) -> str:
        """SHA256 over seed + config + master data summary + demand data summary."""
        n_mats = len(master_data.get("materials", []))
        n_plants = len(master_data.get("plants", []))
        n_demand_keys = len(demand_data)
        total_demand = 0.0
        for df in demand_data.values():
            if hasattr(df, "demand"):
                total_demand += float(df["demand"].sum())
            elif hasattr(df, "__len__"):
                total_demand += len(df)

        raw = (
            f"seed={seed}|cfg={json.dumps(config, sort_keys=True, default=str)}"
            f"|mats={n_mats}|plants={n_plants}|demand_keys={n_demand_keys}"
            f"|demand_sum={total_demand:.2f}"
        )
        return hashlib.sha256(raw.encode()).hexdigest()[:16]
