import pandas as pd
import numpy as np
try:
    from sklearn.preprocessing import StandardScaler
except ImportError:
    StandardScaler = None

# LightGBM 训练所需的全部特征列（顺序固定，保证 .pkl 模型兼容）
FEATURE_COLUMNS = [
    'day_of_week', 'day_of_month', 'month', 'week_of_year',
    'month_sin', 'month_cos', 'dow_sin', 'dow_cos',
    'is_holiday',
    'lag_1', 'lag_7', 'lag_14', 'lag_30',
    'rolling_mean_7', 'rolling_std_7',
    'rolling_mean_14', 'rolling_std_14',
    'rolling_mean_30',
    'ewm_7',
]


class FeatureEngineer:
    """
    需求预测特征工程模块 (v2 — 工業級)
    将原始销售数据转换为 LightGBM / Prophet 可用特征
    """
    def __init__(self):
        self.scaler = StandardScaler() if StandardScaler else None
        self.calendar = self._load_calendar()
    
    def _load_calendar(self):
        """加载业务日历（节假日/促销）"""
        return {
            '2026-01-01': '元旦',
            '2026-01-28': '春节前',
            '2026-01-29': '春节',
            '2026-01-30': '春节',
            '2026-01-31': '春节',
            '2026-02-01': '春节',
            '2026-02-02': '春节',
            '2026-05-01': '劳动节',
            '2026-10-01': '国庆节',
            '2026-10-02': '国庆节',
            '2026-10-03': '国庆节',
        }

    # ─────────────────────────────────────────────
    # 核心：从 DataFrame 构建完整特征
    # ─────────────────────────────────────────────
    def create_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        创建时间序列特征（用于训练和预测）
        :param df: 必须包含 'date' 和 'sales' 列
        :return: 添加了特征列的 DataFrame
        """
        df = df.copy()
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date').reset_index(drop=True)

        # ── 日历特征 ──
        df['day_of_week'] = df['date'].dt.dayofweek
        df['day_of_month'] = df['date'].dt.day
        df['month'] = df['date'].dt.month
        df['week_of_year'] = df['date'].dt.isocalendar().week.astype(int)

        # ── 周期性编码 ──
        df['month_sin'] = np.sin(2 * np.pi * df['month'] / 12)
        df['month_cos'] = np.cos(2 * np.pi * df['month'] / 12)
        df['dow_sin'] = np.sin(2 * np.pi * df['day_of_week'] / 7)
        df['dow_cos'] = np.cos(2 * np.pi * df['day_of_week'] / 7)

        # ── 节假日标记 ──
        df['is_holiday'] = df['date'].apply(
            lambda x: 1 if x.strftime('%Y-%m-%d') in self.calendar else 0
        ).astype(int)

        # ── 滞后特征 (Lag Features) ──
        df['lag_1'] = df['sales'].shift(1)
        df['lag_7'] = df['sales'].shift(7)
        df['lag_14'] = df['sales'].shift(14)
        df['lag_30'] = df['sales'].shift(30)

        # ── 滚动特征 (Rolling Window Features) ──
        df['rolling_mean_7'] = df['sales'].rolling(window=7, min_periods=1).mean()
        df['rolling_std_7'] = df['sales'].rolling(window=7, min_periods=1).std().fillna(0)
        df['rolling_mean_14'] = df['sales'].rolling(window=14, min_periods=1).mean()
        df['rolling_std_14'] = df['sales'].rolling(window=14, min_periods=1).std().fillna(0)
        df['rolling_mean_30'] = df['sales'].rolling(window=30, min_periods=1).mean()

        # ── 指数加权移动平均 (EWM) ──
        df['ewm_7'] = df['sales'].ewm(span=7, min_periods=1).mean()

        # ── 前向填充所有 NaN（lag 产生的空行）──
        df = df.ffill().bfill().fillna(0)

        return df

    # ─────────────────────────────────────────────
    # 辅助：从 DataFrame 拆出 X, y
    # ─────────────────────────────────────────────
    def create_training_data(self, df: pd.DataFrame, min_rows: int = 30):
        """
        从带特征的 DataFrame 拆出训练用 (X, y)
        :param df: 已经过 create_features 的 DataFrame
        :param min_rows: 丢弃前 N 行（Lag 暖身期）
        :return: (X: DataFrame, y: Series)
        """
        featured = self.create_features(df)
        # 丢弃暖身行
        featured = featured.iloc[min(min_rows, len(featured) // 2):].reset_index(drop=True)
        X = featured[FEATURE_COLUMNS]
        y = featured['sales']
        return X, y

    # ─────────────────────────────────────────────
    # 辅助：从纯序列构建特征行（用于推论）
    # ─────────────────────────────────────────────
    def sequence_to_features(self, sales_sequence: list, base_date: str = '2026-01-01') -> pd.DataFrame:
        """
        将纯销量序列转成带特征的 DataFrame，用于推论（inline_history 场景）
        :param sales_sequence: 原始销量列表
        :param base_date: 起始日期
        :return: 带完整特征的 DataFrame
        """
        dates = pd.date_range(start=base_date, periods=len(sales_sequence), freq='D')
        df = pd.DataFrame({'date': dates, 'sales': sales_sequence})
        return self.create_features(df)

    def build_next_day_features(self, sales_history: list, next_date: pd.Timestamp) -> pd.DataFrame:
        """
        为「下一天」构建单行特征（递归预测核心方法）

        用法（在递归循环中）：
            for day in range(horizon):
                X = fe.build_next_day_features(current_history, next_date)
                pred = model.predict(X)[0]
                current_history.append(pred)   # ← 关键：把预测值当作已知
                next_date += 1 day

        :param sales_history: 截至「今天」的完整销量列表（含已追加的预测值）
        :param next_date: 要预测的那一天的日期
        :return: 单行 DataFrame，列 = FEATURE_COLUMNS（可直接喂给 model.predict）
        """
        dt = pd.Timestamp(next_date)
        n = len(sales_history)

        row = {}
        # ── 日历特征 ──
        row['day_of_week'] = dt.dayofweek
        row['day_of_month'] = dt.day
        row['month'] = dt.month
        row['week_of_year'] = int(dt.isocalendar().week)

        # ── 周期性编码 ──
        row['month_sin'] = np.sin(2 * np.pi * row['month'] / 12)
        row['month_cos'] = np.cos(2 * np.pi * row['month'] / 12)
        row['dow_sin'] = np.sin(2 * np.pi * row['day_of_week'] / 7)
        row['dow_cos'] = np.cos(2 * np.pi * row['day_of_week'] / 7)

        # ── 节假日 ──
        row['is_holiday'] = 1 if dt.strftime('%Y-%m-%d') in self.calendar else 0

        # ── Lag 特征：直接从 sales_history 尾部取 ──
        row['lag_1']  = sales_history[-1]  if n >= 1  else 0
        row['lag_7']  = sales_history[-7]  if n >= 7  else (sales_history[0] if n > 0 else 0)
        row['lag_14'] = sales_history[-14] if n >= 14 else (sales_history[0] if n > 0 else 0)
        row['lag_30'] = sales_history[-30] if n >= 30 else (sales_history[0] if n > 0 else 0)

        # ── Rolling 特征：从尾部窗口计算 ──
        tail_7  = sales_history[-7:]  if n >= 7  else sales_history
        tail_14 = sales_history[-14:] if n >= 14 else sales_history
        tail_30 = sales_history[-30:] if n >= 30 else sales_history

        row['rolling_mean_7']  = float(np.mean(tail_7))
        row['rolling_std_7']   = float(np.std(tail_7)) if len(tail_7) > 1 else 0.0
        row['rolling_mean_14'] = float(np.mean(tail_14))
        row['rolling_std_14']  = float(np.std(tail_14)) if len(tail_14) > 1 else 0.0
        row['rolling_mean_30'] = float(np.mean(tail_30))

        # ── EWM ──
        row['ewm_7'] = float(
            pd.Series(tail_7).ewm(span=7, min_periods=1).mean().iloc[-1]
        )

        return pd.DataFrame([row])[FEATURE_COLUMNS]
