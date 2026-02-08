"""
P0-1.4: 檔案系統版 Model Registry
─────────────────────────────────
統一 artifact 結構：
  models/
    lightgbm/
      {sku}/
        v001/  model.pkl  meta.json
        v002/  model.pkl  meta.json
        latest -> v002
    prophet/
      {sku}/
        v001/  model.json  meta.json

功能：
  - save(model_type, sku, model_obj, meta) → version
  - load(model_type, sku, version="latest") → (model_obj, meta)
  - list_versions(model_type, sku)
  - rollback(model_type, sku, version)
  - get_latest_version(model_type, sku)
"""
import os
import json
import shutil
import logging
from typing import Optional, Dict, Tuple, List, Any
from datetime import datetime

logger = logging.getLogger(__name__)

# 預設 registry 根目錄
DEFAULT_REGISTRY_ROOT = os.path.join(os.path.dirname(__file__), '..', 'models')

# 模型序列化映射
MODEL_FILE_MAP = {
    "lightgbm": "model.pkl",
    "prophet": "model.json",
    "chronos": "model.bin",
}


class ModelRegistry:
    """
    檔案系統版 Model Registry。
    每個 (model_type, sku) 組合有獨立的版本目錄。
    """

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_REGISTRY_ROOT)
        os.makedirs(self.root, exist_ok=True)

    # ══════════════════════════════════════
    # 核心 API
    # ══════════════════════════════════════

    def save(
        self,
        model_type: str,
        sku: str,
        model_obj: Any,
        meta: Dict,
        model_bytes: bytes = None,
    ) -> str:
        """
        儲存模型 artifact + meta。

        :param model_type: "lightgbm" | "prophet" | "chronos"
        :param sku: SKU 識別碼（"_global" 表示全域模型）
        :param model_obj: 模型物件（LightGBM Booster 或 Prophet 已序列化的 JSON string）
        :param meta: 元資料 dict
        :param model_bytes: 若提供，直接寫入 bytes（優先於 model_obj）
        :return: 版本號 "v001", "v002", ...
        """
        model_type = model_type.lower()
        sku_dir = self._sku_dir(model_type, sku)
        os.makedirs(sku_dir, exist_ok=True)

        # 計算下一個版本號
        version = self._next_version(sku_dir)
        version_dir = os.path.join(sku_dir, version)
        os.makedirs(version_dir, exist_ok=True)

        model_filename = MODEL_FILE_MAP.get(model_type, "model.bin")
        model_path = os.path.join(version_dir, model_filename)

        # 儲存模型
        if model_bytes is not None:
            with open(model_path, 'wb') as f:
                f.write(model_bytes)
        elif model_type == "lightgbm":
            try:
                import joblib
                joblib.dump(model_obj, model_path)
            except ImportError:
                raise RuntimeError("joblib is required for LightGBM model saving")
        elif model_type == "prophet":
            # model_obj 應該是 JSON string (from model_to_json)
            with open(model_path, 'w', encoding='utf-8') as f:
                if isinstance(model_obj, str):
                    f.write(model_obj)
                else:
                    # 若傳入 Prophet model object，嘗試序列化
                    try:
                        from prophet.serialize import model_to_json
                        f.write(model_to_json(model_obj))
                    except Exception as e:
                        raise RuntimeError(f"Cannot serialize Prophet model: {e}")
        else:
            # 通用 fallback: pickle
            try:
                import joblib
                joblib.dump(model_obj, model_path)
            except ImportError:
                import pickle
                with open(model_path, 'wb') as f:
                    pickle.dump(model_obj, f)

        # 寫入 meta
        meta_enriched = {
            **meta,
            "model_type": model_type,
            "sku": sku,
            "version": version,
            "model_file": model_filename,
            "saved_at": datetime.now().isoformat(),
            "registry_root": self.root,
        }
        meta_path = os.path.join(version_dir, "meta.json")
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta_enriched, f, indent=2, ensure_ascii=False)

        # 更新 latest 指標
        self._update_latest(sku_dir, version)

        logger.info(f"Model saved: {model_type}/{sku}/{version} → {model_path}")
        return version

    def load(
        self,
        model_type: str,
        sku: str,
        version: str = "latest",
    ) -> Tuple[Any, Dict]:
        """
        載入模型 + meta。

        :return: (model_object, meta_dict)
        """
        model_type = model_type.lower()
        sku_dir = self._sku_dir(model_type, sku)

        if version == "latest":
            version = self.get_latest_version(model_type, sku)
            if version is None:
                raise FileNotFoundError(f"No model found for {model_type}/{sku}")

        version_dir = os.path.join(sku_dir, version)
        if not os.path.isdir(version_dir):
            raise FileNotFoundError(f"Version not found: {model_type}/{sku}/{version}")

        model_filename = MODEL_FILE_MAP.get(model_type, "model.bin")
        model_path = os.path.join(version_dir, model_filename)
        meta_path = os.path.join(version_dir, "meta.json")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model file not found: {model_path}")

        # 載入模型
        if model_type == "lightgbm":
            import joblib
            model_obj = joblib.load(model_path)
        elif model_type == "prophet":
            from prophet.serialize import model_from_json
            with open(model_path, 'r', encoding='utf-8') as f:
                model_obj = model_from_json(f.read())
        else:
            import joblib
            model_obj = joblib.load(model_path)

        # 載入 meta
        meta = {}
        if os.path.exists(meta_path):
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)

        logger.info(f"Model loaded: {model_type}/{sku}/{version}")
        return model_obj, meta

    def list_versions(self, model_type: str, sku: str) -> List[Dict]:
        """
        列出所有版本 + 摘要。

        :return: [{"version": "v001", "saved_at": "...", "val_mape": ...}, ...]
        """
        sku_dir = self._sku_dir(model_type.lower(), sku)
        if not os.path.isdir(sku_dir):
            return []

        versions = []
        latest = self.get_latest_version(model_type, sku)

        for entry in sorted(os.listdir(sku_dir)):
            version_dir = os.path.join(sku_dir, entry)
            if not os.path.isdir(version_dir) or not entry.startswith('v'):
                continue
            meta_path = os.path.join(version_dir, "meta.json")
            meta = {}
            if os.path.exists(meta_path):
                with open(meta_path, 'r', encoding='utf-8') as f:
                    meta = json.load(f)
            versions.append({
                "version": entry,
                "is_latest": entry == latest,
                "saved_at": meta.get("saved_at", ""),
                "val_mape": meta.get("val_mape"),
                "feature_version": meta.get("feature_version"),
            })

        return versions

    def rollback(self, model_type: str, sku: str, version: str) -> bool:
        """
        將 latest 指標回滾到指定版本。

        :return: True if success
        """
        model_type = model_type.lower()
        sku_dir = self._sku_dir(model_type, sku)
        version_dir = os.path.join(sku_dir, version)

        if not os.path.isdir(version_dir):
            raise FileNotFoundError(f"Cannot rollback — version not found: {model_type}/{sku}/{version}")

        self._update_latest(sku_dir, version)
        logger.info(f"Rolled back {model_type}/{sku} → {version}")
        return True

    def get_latest_version(self, model_type: str, sku: str) -> Optional[str]:
        """取得 latest 版本號"""
        sku_dir = self._sku_dir(model_type.lower(), sku)
        latest_file = os.path.join(sku_dir, "latest.txt")
        if os.path.exists(latest_file):
            with open(latest_file, 'r') as f:
                return f.read().strip()
        return None

    # ══════════════════════════════════════
    # 向後相容：flat path 載入（舊格式 lgbm_model.pkl）
    # ══════════════════════════════════════

    def load_flat(self, model_type: str) -> Tuple[Optional[Any], Optional[Dict]]:
        """
        嘗試從舊的 flat 路徑載入（向後相容）。
        例如 models/lgbm_model.pkl, models/prophet_model.json
        """
        flat_map = {
            "lightgbm": ("lgbm_model.pkl", "lgbm_meta.json"),
            "prophet": ("prophet_model.json", "prophet_meta.json"),
        }
        if model_type not in flat_map:
            return None, None

        model_file, meta_file = flat_map[model_type]
        model_path = os.path.join(self.root, model_file)
        meta_path = os.path.join(self.root, meta_file)

        if not os.path.exists(model_path):
            return None, None

        try:
            if model_type == "lightgbm":
                import joblib
                model_obj = joblib.load(model_path)
            elif model_type == "prophet":
                from prophet.serialize import model_from_json
                with open(model_path, 'r', encoding='utf-8') as f:
                    model_obj = model_from_json(f.read())
            else:
                return None, None

            meta = {}
            if os.path.exists(meta_path):
                with open(meta_path, 'r', encoding='utf-8') as f:
                    meta = json.load(f)

            return model_obj, meta
        except Exception as e:
            logger.warning(f"Failed to load flat model {model_type}: {e}")
            return None, None

    # ══════════════════════════════════════
    # 內部方法
    # ══════════════════════════════════════

    def _sku_dir(self, model_type: str, sku: str) -> str:
        safe_sku = sku.replace('/', '_').replace('\\', '_').replace('..', '_')
        return os.path.join(self.root, model_type, safe_sku)

    def _next_version(self, sku_dir: str) -> str:
        existing = []
        if os.path.isdir(sku_dir):
            for entry in os.listdir(sku_dir):
                if entry.startswith('v') and entry[1:].isdigit():
                    existing.append(int(entry[1:]))
        next_num = max(existing, default=0) + 1
        return f"v{next_num:03d}"

    def _update_latest(self, sku_dir: str, version: str):
        latest_file = os.path.join(sku_dir, "latest.txt")
        with open(latest_file, 'w') as f:
            f.write(version)
