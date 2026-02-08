"""
P0-1.2: 資料品質檢查與日頻補齊 (Data Validation + Resampling)
──────────────────────────────────────────────────────────────
單一入口：validate_and_clean_series()
所有模型（Prophet / LightGBM / Chronos）共用，確保 FeatureEngineer 不會拿到 NaN/inf。
"""
import logging
from typing import Tuple, Optional
import pandas as pd
import numpy as np

from .data_contract import SalesSeries, DataQualityReport

logger = logging.getLogger(__name__)


def validate_and_clean_series(
    series: SalesSeries,
    fill_strategy: str = "zero",   # "zero" | "ffill" | "mean"
    reject_non_daily: bool = True,
    min_points: int = 3,
) -> Tuple[SalesSeries, DataQualityReport]:
    """
    統一資料清洗入口。

    策略說明：
      - fill_strategy="zero"  → 缺日補 0（適合「缺貨=無銷售」的場景）
      - fill_strategy="ffill" → 前向填充（適合「缺資料但有銷售」）
      - fill_strategy="mean"  → 用序列均值填充

    回傳：
      (cleaned_series, quality_report)
    """
    report = DataQualityReport(original_count=series.n)

    if series.n < min_points:
        report.warnings.append(f"資料點不足: {series.n} < {min_points}")
        return series, report

    # ── 1. 轉成 DataFrame 便於操作 ──
    df = series.to_dataframe()
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').reset_index(drop=True)

    # ── 2. 去重（同日多筆 → sum） ──
    dup_count = df.duplicated(subset='date').sum()
    if dup_count > 0:
        report.duplicate_dates_merged = int(dup_count)
        report.warnings.append(f"合併了 {dup_count} 筆重複日期（取 sum）")
        df = df.groupby('date', as_index=False)['sales'].sum()
        df = df.sort_values('date').reset_index(drop=True)

    # ── 3. 檢測頻率 ──
    if len(df) >= 2:
        diffs = df['date'].diff().dropna()
        median_diff = diffs.median()

        if median_diff > pd.Timedelta(days=2):
            report.is_daily = False
            if reject_non_daily:
                report.warnings.append(
                    f"資料非日頻（中位差距: {median_diff.days} 天），已拒絕"
                )
                return series, report
            else:
                report.warnings.append(
                    f"資料非日頻（中位差距: {median_diff.days} 天），已強制 resample 為日頻"
                )

    # ── 4. 補齊缺日（建立完整日頻索引） ──
    full_range = pd.date_range(start=df['date'].min(), end=df['date'].max(), freq='D')
    df_full = pd.DataFrame({'date': full_range})
    df_full = df_full.merge(df, on='date', how='left')

    missing_mask = df_full['sales'].isna()
    missing_count = int(missing_mask.sum())
    report.missing_dates_filled = missing_count

    if missing_count > 0:
        # 記錄缺口
        missing_dates = df_full.loc[missing_mask, 'date']
        gaps = _find_gaps(missing_dates)
        report.gaps = gaps

        # 填充
        if fill_strategy == "zero":
            df_full['sales'] = df_full['sales'].fillna(0)
        elif fill_strategy == "ffill":
            df_full['sales'] = df_full['sales'].ffill().bfill().fillna(0)
        elif fill_strategy == "mean":
            fill_val = df['sales'].mean()
            df_full['sales'] = df_full['sales'].fillna(fill_val)
        else:
            df_full['sales'] = df_full['sales'].fillna(0)

        if missing_count > len(df_full) * 0.3:
            report.warnings.append(
                f"缺失率 {missing_count}/{len(df_full)} = {missing_count/len(df_full)*100:.1f}% (>30%)，品質堪慮"
            )

    # ── 5. NaN 處理（萬一還有殘留） ──
    nan_count = int(df_full['sales'].isna().sum())
    if nan_count > 0:
        report.nan_values_filled = nan_count
        df_full['sales'] = df_full['sales'].fillna(0)

    # ── 6. 負值處理 → clip to 0 ──
    neg_mask = df_full['sales'] < 0
    neg_count = int(neg_mask.sum())
    if neg_count > 0:
        report.negative_values_clipped = neg_count
        report.warnings.append(f"裁切了 {neg_count} 個負值 → 0")
        df_full.loc[neg_mask, 'sales'] = 0

    # ── 7. 常數序列檢測 ──
    if df_full['sales'].std() < 1e-8:
        report.is_constant = True
        report.warnings.append("序列為常數（std ≈ 0），模型預測將無意義")

    # ── 8. Inf 檢測 ──
    inf_mask = ~np.isfinite(df_full['sales'].values)
    if inf_mask.any():
        inf_count = int(inf_mask.sum())
        report.warnings.append(f"偵測到 {inf_count} 個 inf 值，已替換為 0")
        df_full.loc[inf_mask, 'sales'] = 0

    # ── 9. 組裝結果 ──
    report.cleaned_count = len(df_full)

    cleaned = SalesSeries(
        dates=df_full['date'].tolist(),
        values=df_full['sales'].tolist(),
        sku=series.sku,
    )

    if report.warnings:
        logger.warning(f"[{series.sku}] Data quality issues: {report.warnings}")

    return cleaned, report


def _find_gaps(missing_dates: pd.Series) -> list:
    """找出連續缺失的區段，回傳 ['2025-03-01~2025-03-05 (5d)', ...]"""
    if missing_dates.empty:
        return []

    gaps = []
    sorted_dates = sorted(missing_dates)
    start = sorted_dates[0]
    prev = sorted_dates[0]

    for d in sorted_dates[1:]:
        if (d - prev).days > 1:
            length = (prev - start).days + 1
            gaps.append(f"{start.date()}~{prev.date()} ({length}d)")
            start = d
        prev = d

    length = (prev - start).days + 1
    gaps.append(f"{start.date()}~{prev.date()} ({length}d)")
    return gaps


def quick_validate(values: list) -> dict:
    """
    快速驗證（不清洗，只回報品質）。
    適合 API 端快速判斷是否該接受輸入。
    """
    arr = np.array(values, dtype=float)
    n = len(arr)
    return {
        "n": n,
        "has_nan": bool(np.isnan(arr).any()),
        "has_inf": bool(np.isinf(arr).any()),
        "has_negative": bool((arr < 0).any()),
        "is_constant": bool(np.std(arr) < 1e-8) if n > 1 else True,
        "zero_rate": round(float((arr == 0).sum() / max(n, 1)), 4),
        "mean": round(float(np.nanmean(arr)), 2) if n > 0 else 0,
        "std": round(float(np.nanstd(arr)), 2) if n > 1 else 0,
    }
