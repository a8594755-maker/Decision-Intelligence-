"""
PR-B: Artifact Manager
──────────────────────
Writes and reads training run artifacts with full provenance.

Artifact layout:
  artifacts/forecast/<run_id>/<series_id>/<model_name>/
    model.pkl | model.json          # serialized model
    feature_spec.json               # feature columns + version + hash
    metrics.json                    # train/val/test metrics
    config.json                     # hyperparams + run settings + seed
    dataset_fingerprint.txt         # from DatasetBundle
    code_provenance.json            # git sha, timestamp, versions
"""
import json
import logging
import os
import platform
import subprocess
import sys
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_ARTIFACT_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "artifacts", "forecast"
)


def _get_git_sha() -> str:
    try:
        return (
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()[:12]
        )
    except Exception:
        return "unknown"


def _get_library_versions() -> Dict[str, str]:
    versions = {"python": platform.python_version()}
    for lib in ["numpy", "pandas", "lightgbm", "prophet", "scikit-learn", "torch"]:
        try:
            mod = __import__(lib)
            versions[lib] = getattr(mod, "__version__", "?")
        except ImportError:
            pass
    return versions


class ArtifactManager:
    """Manages training run artifact persistence."""

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_ARTIFACT_ROOT)

    def run_dir(self, run_id: str, series_id: str, model_name: str) -> str:
        safe_series = series_id.replace("/", "_").replace("\\", "_")
        return os.path.join(self.root, run_id, safe_series, model_name)

    def save_run(
        self,
        run_id: str,
        series_id: str,
        model_name: str,
        model_obj: Any,
        config: Dict,
        metrics: Dict,
        feature_spec: Dict,
        dataset_fingerprint: str,
        extra_files: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Write all artifacts for a single training run.

        Returns the artifact directory path.
        """
        d = self.run_dir(run_id, series_id, model_name)
        os.makedirs(d, exist_ok=True)

        # 1. Model file
        self._save_model(d, model_name, model_obj)

        # 2. Feature spec
        self._write_json(os.path.join(d, "feature_spec.json"), feature_spec)

        # 3. Metrics
        self._write_json(os.path.join(d, "metrics.json"), metrics)

        # 4. Config (includes hyperparams + seed)
        self._write_json(os.path.join(d, "config.json"), config)

        # 5. Dataset fingerprint
        with open(os.path.join(d, "dataset_fingerprint.txt"), "w") as f:
            f.write(dataset_fingerprint)

        # 6. Code provenance
        provenance = {
            "git_sha": _get_git_sha(),
            "timestamp": datetime.now().isoformat(),
            "python_version": platform.python_version(),
            "library_versions": _get_library_versions(),
            "platform": platform.platform(),
        }
        self._write_json(os.path.join(d, "code_provenance.json"), provenance)

        # 7. Extra files
        if extra_files:
            for filename, content in extra_files.items():
                if isinstance(content, (dict, list)):
                    self._write_json(os.path.join(d, filename), content)
                elif isinstance(content, str):
                    with open(os.path.join(d, filename), "w") as f:
                        f.write(content)

        logger.info(f"Artifacts saved: {d}")
        return d

    def load_model(self, artifact_dir: str, model_name: str) -> Any:
        """Load a model object from an artifact directory."""
        model_name_lower = model_name.lower()

        if model_name_lower == "prophet":
            model_path = os.path.join(artifact_dir, "model.json")
            if not os.path.exists(model_path):
                raise FileNotFoundError(f"Prophet model not found: {model_path}")
            from prophet.serialize import model_from_json

            with open(model_path, "r", encoding="utf-8") as f:
                return model_from_json(f.read())

        # LightGBM or generic pickle
        model_path = os.path.join(artifact_dir, "model.pkl")
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model not found: {model_path}")
        import joblib

        return joblib.load(model_path)

    def load_metadata(self, artifact_dir: str) -> Dict:
        """Load metrics + config + feature_spec from artifact dir."""
        result = {}
        for name in ["metrics.json", "config.json", "feature_spec.json",
                      "code_provenance.json"]:
            path = os.path.join(artifact_dir, name)
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    result[name.replace(".json", "")] = json.load(f)

        fp_path = os.path.join(artifact_dir, "dataset_fingerprint.txt")
        if os.path.exists(fp_path):
            with open(fp_path, "r") as f:
                result["dataset_fingerprint"] = f.read().strip()

        return result

    def list_runs(self) -> list:
        """List all run_ids in the artifact root."""
        if not os.path.isdir(self.root):
            return []
        return sorted(
            e
            for e in os.listdir(self.root)
            if os.path.isdir(os.path.join(self.root, e))
        )

    # --- internal helpers ---

    def _save_model(self, directory: str, model_name: str, model_obj: Any):
        model_name_lower = model_name.lower()

        if model_name_lower == "prophet":
            model_path = os.path.join(directory, "model.json")
            if isinstance(model_obj, str):
                with open(model_path, "w", encoding="utf-8") as f:
                    f.write(model_obj)
            else:
                from prophet.serialize import model_to_json

                with open(model_path, "w", encoding="utf-8") as f:
                    f.write(model_to_json(model_obj))
        else:
            model_path = os.path.join(directory, "model.pkl")
            import joblib

            joblib.dump(model_obj, model_path)

    @staticmethod
    def _write_json(path: str, data: Any):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
