"""
Week 1A: DataGenerator — 合成需求數據生成器
============================================
混合四種訊號產生逼真的銷售歷史：
  1. Trend (趨勢)     — 產品生命週期
  2. Seasonality (季節) — 週期/月度/年度波動
  3. Noise (雜訊)     — 隨機波動
  4. Shocks (衝擊)    — 黑天鵝事件
"""
import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from typing import List, Optional, Dict
from datetime import datetime, timedelta


@dataclass
class DemandProfile:
    """需求曲線參數組"""
    name: str = "default"

    # 基礎水準
    base_demand: float = 100.0

    # 趨勢
    trend_per_day: float = 0.05          # 每日線性增長
    trend_type: str = "linear"           # linear | logistic | decline

    # 季節性
    weekly_amplitude: float = 15.0       # 週循環振幅
    monthly_amplitude: float = 10.0      # 月循環振幅
    yearly_amplitude: float = 20.0       # 年循環振幅
    weekly_phase: float = 0.0            # 週循環相位偏移（天）
    peak_weekday: int = 5                # 週峰值日 (0=Mon, 6=Sun)

    # 雜訊
    noise_std: float = 8.0               # 高斯雜訊標準差
    noise_type: str = "gaussian"         # gaussian | multiplicative

    # 衝擊
    shock_probability: float = 0.02      # 每天發生衝擊的機率
    shock_magnitude_range: tuple = (0.3, 3.0)  # 衝擊倍數範圍
    shock_duration_range: tuple = (1, 5)       # 衝擊持續天數

    # 促銷
    promo_interval_days: int = 45        # 促銷間隔
    promo_duration_days: int = 3         # 促銷持續天數
    promo_lift: float = 0.4             # 促銷提升比例 (40%)

    # 約束
    min_demand: float = 0.0
    integer_demand: bool = True


class DataGenerator:
    """
    合成需求數據生成器 — The Creator
    ================================
    產生具備真實統計特徵的銷售歷史，供模擬和訓練使用。

    Usage:
        gen = DataGenerator(seed=42)
        profile = DemandProfile(base_demand=80, weekly_amplitude=20)
        df = gen.generate(profile, days=365)
    """

    def __init__(self, seed: Optional[int] = None):
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def generate(
        self,
        profile: Optional[DemandProfile] = None,
        days: int = 365,
        start_date: str = "2024-01-01",
    ) -> pd.DataFrame:
        """
        生成合成銷售數據。

        Returns:
            DataFrame with columns: date, demand, trend, seasonality, noise, shock, promo
        """
        if profile is None:
            profile = DemandProfile()

        dates = pd.date_range(start=start_date, periods=days, freq="D")
        t = np.arange(days, dtype=float)

        # ── 1. Trend ──
        trend = self._build_trend(t, profile)

        # ── 2. Seasonality ──
        seasonality = self._build_seasonality(t, dates, profile)

        # ── 3. Noise ──
        noise = self._build_noise(t, profile)

        # ── 4. Shocks (Black Swans) ──
        shocks, shock_events = self._build_shocks(t, dates, profile)

        # ── 5. Promotions ──
        promos = self._build_promos(t, profile)

        # ── Compose ──
        base = profile.base_demand
        raw = base + trend + seasonality + noise + promos

        # Apply multiplicative shocks
        demand = raw * shocks

        # Clip
        demand = np.maximum(demand, profile.min_demand)
        if profile.integer_demand:
            demand = np.round(demand).astype(int)

        df = pd.DataFrame({
            "date": dates,
            "demand": demand,
            "trend": np.round(trend, 2),
            "seasonality": np.round(seasonality, 2),
            "noise": np.round(noise, 2),
            "shock_multiplier": np.round(shocks, 3),
            "promo_lift": np.round(promos, 2),
        })

        # Attach metadata
        df.attrs["profile"] = profile.name
        df.attrs["seed"] = self.seed
        df.attrs["shock_events"] = shock_events

        return df

    def generate_multi_sku(
        self,
        profiles: Dict[str, DemandProfile],
        days: int = 365,
        start_date: str = "2024-01-01",
    ) -> Dict[str, pd.DataFrame]:
        """為多個 SKU 生成各自的需求數據"""
        results = {}
        for sku, profile in profiles.items():
            profile.name = sku
            results[sku] = self.generate(profile, days, start_date)
        return results

    # ─── Internal builders ───

    def _build_trend(self, t: np.ndarray, p: DemandProfile) -> np.ndarray:
        if p.trend_type == "linear":
            return p.trend_per_day * t
        elif p.trend_type == "logistic":
            # S-curve: slow start → fast growth → plateau
            midpoint = len(t) / 2
            k = 0.02  # steepness
            max_trend = p.trend_per_day * len(t)
            return max_trend / (1 + np.exp(-k * (t - midpoint)))
        elif p.trend_type == "decline":
            return -p.trend_per_day * t
        return np.zeros_like(t)

    def _build_seasonality(self, t: np.ndarray, dates: pd.DatetimeIndex, p: DemandProfile) -> np.ndarray:
        # Weekly cycle
        weekly = p.weekly_amplitude * np.sin(
            2 * np.pi * (t - p.weekly_phase) / 7
        )

        # Monthly cycle
        monthly = p.monthly_amplitude * np.sin(2 * np.pi * t / 30.44)

        # Yearly cycle (peak in Q4 for retail)
        day_of_year = dates.dayofyear.values.astype(float)
        yearly = p.yearly_amplitude * np.sin(
            2 * np.pi * (day_of_year - 90) / 365.25
        )

        return weekly + monthly + yearly

    def _build_noise(self, t: np.ndarray, p: DemandProfile) -> np.ndarray:
        if p.noise_type == "multiplicative":
            # Noise proportional to base demand level
            return self._rng.normal(0, 1, len(t)) * p.noise_std * (1 + 0.001 * t)
        return self._rng.normal(0, p.noise_std, len(t))

    def _build_shocks(self, t: np.ndarray, dates: pd.DatetimeIndex, p: DemandProfile):
        """
        Shock events: sudden demand spikes or crashes.
        Returns (multiplier array, event list).
        """
        n = len(t)
        multipliers = np.ones(n)
        events = []

        i = 0
        while i < n:
            if self._rng.random() < p.shock_probability:
                # Generate shock
                mag = self._rng.uniform(*p.shock_magnitude_range)
                dur = self._rng.randint(*p.shock_duration_range)
                end = min(i + dur, n)

                # Apply
                multipliers[i:end] = mag

                event_type = "surge" if mag > 1.0 else "crash"
                events.append({
                    "date": str(dates[i].date()),
                    "type": event_type,
                    "magnitude": round(float(mag), 2),
                    "duration_days": int(end - i),
                    "description": self._describe_shock(event_type, mag),
                })

                i = end  # Skip past shock duration
            else:
                i += 1

        return multipliers, events

    def _build_promos(self, t: np.ndarray, p: DemandProfile) -> np.ndarray:
        promos = np.zeros(len(t))
        if p.promo_interval_days <= 0:
            return promos

        for start in range(0, len(t), p.promo_interval_days):
            end = min(start + p.promo_duration_days, len(t))
            promos[start:end] = p.base_demand * p.promo_lift
        return promos

    @staticmethod
    def _describe_shock(event_type: str, magnitude: float) -> str:
        if event_type == "surge":
            if magnitude > 2.5:
                return "🔥 病毒式爆紅 — 需求暴增"
            elif magnitude > 1.5:
                return "📈 KOL 推薦 — 需求激增"
            else:
                return "📊 小幅需求上升"
        else:
            if magnitude < 0.4:
                return "💀 競品替代 — 需求崩塌"
            elif magnitude < 0.7:
                return "📉 市場疲軟 — 需求下滑"
            else:
                return "📊 小幅需求下降"
