"""
P0-1.1: 統一資料契約 (Data Contract)
────────────────────────────────────
所有模型共用的資料結構，確保 dates 與 values 永遠成對傳遞。
不再只傳 sales list 而丟掉日期。
"""
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime
import pandas as pd
import numpy as np
import hashlib


@dataclass
class SalesSeries:
    """
    核心資料契約：日頻銷量序列。
    所有 Strategy.predict / FeatureEngineer / Backtest 都應以此為輸入。
    """
    dates: List[pd.Timestamp]
    values: List[float]
    sku: str = ""
    frequency: str = "D"  # 日頻

    def __post_init__(self):
        if len(self.dates) != len(self.values):
            raise ValueError(
                f"dates ({len(self.dates)}) and values ({len(self.values)}) must have same length"
            )
        # 強制轉型
        self.dates = [pd.Timestamp(d) for d in self.dates]
        self.values = [float(v) for v in self.values]

    # ── 核心屬性 ──

    @property
    def n(self) -> int:
        return len(self.values)

    @property
    def last_date(self) -> pd.Timestamp:
        """歷史最後一天"""
        if not self.dates:
            raise ValueError("Empty series — no last_date")
        return self.dates[-1]

    @property
    def next_date(self) -> pd.Timestamp:
        """預測起始日 = 歷史最後一天 + 1"""
        return self.last_date + pd.Timedelta(days=1)

    @property
    def start_date(self) -> pd.Timestamp:
        if not self.dates:
            raise ValueError("Empty series — no start_date")
        return self.dates[0]

    @property
    def date_range_str(self) -> str:
        return f"{self.start_date.date()} ~ {self.last_date.date()}"

    # ── 轉換方法 ──

    def to_dataframe(self) -> pd.DataFrame:
        """轉成 (date, sales) DataFrame"""
        return pd.DataFrame({
            'date': self.dates,
            'sales': self.values
        })

    def to_prophet_df(self) -> pd.DataFrame:
        """轉成 Prophet 格式 (ds, y)"""
        return pd.DataFrame({
            'ds': self.dates,
            'y': self.values
        })

    def to_values_list(self) -> List[float]:
        """向後相容：回傳純 values list"""
        return list(self.values)

    # ── 工廠方法 ──

    @classmethod
    def from_dataframe(cls, df: pd.DataFrame, sku: str = "",
                       date_col: str = 'date', value_col: str = 'sales') -> 'SalesSeries':
        """從 DataFrame 建立"""
        df = df.copy()
        df[date_col] = pd.to_datetime(df[date_col])
        df = df.sort_values(date_col).reset_index(drop=True)
        return cls(
            dates=df[date_col].tolist(),
            values=df[value_col].tolist(),
            sku=sku
        )

    @classmethod
    def from_inline_history(cls, values: List[float], sku: str = "",
                            base_date: Optional[str] = None,
                            last_date: Optional[str] = None) -> 'SalesSeries':
        """
        從 inline_history 建立（API 常見場景）。
        必須提供 base_date 或 last_date 之一，否則日曆特徵必錯。
        若都不提供，以「今天 - len(values) 天」為 fallback 並標記警告。
        """
        n = len(values)
        if last_date:
            end = pd.Timestamp(last_date)
            dates = pd.date_range(end=end, periods=n, freq='D')
        elif base_date:
            dates = pd.date_range(start=base_date, periods=n, freq='D')
        else:
            # Fallback：以今天為最後日期（可能不正確，但至少不崩）
            end = pd.Timestamp.now().normalize()
            dates = pd.date_range(end=end, periods=n, freq='D')

        return cls(dates=dates.tolist(), values=values, sku=sku)

    @classmethod
    def from_erp_records(cls, records: List[Dict], sku: str = "",
                         date_key: str = 'date', value_key: str = 'sales') -> 'SalesSeries':
        """從 ERP JSON records 建立"""
        if not records:
            raise ValueError(f"No ERP records for SKU {sku}")
        dates = [r[date_key] for r in records]
        values = [float(r.get(value_key, 0)) for r in records]
        df = pd.DataFrame({'date': dates, 'sales': values})
        return cls.from_dataframe(df, sku=sku)

    # ── 切片 ──

    def split(self, test_days: int) -> tuple:
        """拆分成 (train, test) SalesSeries"""
        if test_days >= self.n:
            raise ValueError(f"test_days ({test_days}) >= total ({self.n})")
        cut = self.n - test_days
        train = SalesSeries(
            dates=self.dates[:cut], values=self.values[:cut], sku=self.sku
        )
        test = SalesSeries(
            dates=self.dates[cut:], values=self.values[cut:], sku=self.sku
        )
        return train, test

    def append_prediction(self, pred_value: float) -> None:
        """遞歸預測時追加預測值到序列尾端（原地修改）"""
        next_d = self.next_date
        self.dates.append(next_d)
        self.values.append(float(pred_value))

    # ── 摘要 ──

    def summary(self) -> Dict[str, Any]:
        arr = np.array(self.values)
        return {
            "sku": self.sku,
            "n": self.n,
            "date_range": self.date_range_str,
            "mean": round(float(np.mean(arr)), 2),
            "std": round(float(np.std(arr)), 2),
            "min": round(float(np.min(arr)), 2),
            "max": round(float(np.max(arr)), 2),
        }

    def fingerprint(self) -> str:
        """資料指紋（用於 cache / dedup）"""
        raw = f"{self.sku}|{self.n}|{self.start_date}|{self.last_date}|{sum(self.values):.4f}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def __repr__(self):
        return f"SalesSeries(sku='{self.sku}', n={self.n}, range={self.date_range_str})"


@dataclass
class DataQualityReport:
    """
    資料品質報告 — 隨每次清洗產出，可直接放進 API response。
    """
    original_count: int = 0
    cleaned_count: int = 0
    missing_dates_filled: int = 0
    negative_values_clipped: int = 0
    nan_values_filled: int = 0
    duplicate_dates_merged: int = 0
    gaps: List[str] = field(default_factory=list)
    is_daily: bool = True
    is_constant: bool = False
    warnings: List[str] = field(default_factory=list)

    @property
    def missing_rate(self) -> float:
        if self.cleaned_count == 0:
            return 0.0
        return round(self.missing_dates_filled / self.cleaned_count, 4)

    @property
    def is_clean(self) -> bool:
        return len(self.warnings) == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "original_count": self.original_count,
            "cleaned_count": self.cleaned_count,
            "missing_dates_filled": self.missing_dates_filled,
            "negative_values_clipped": self.negative_values_clipped,
            "nan_values_filled": self.nan_values_filled,
            "duplicate_dates_merged": self.duplicate_dates_merged,
            "missing_rate": self.missing_rate,
            "is_daily": self.is_daily,
            "is_constant": self.is_constant,
            "gaps": self.gaps[:10],  # 最多顯示 10 個
            "warnings": self.warnings,
            "is_clean": self.is_clean,
        }
