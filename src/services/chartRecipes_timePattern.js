/**
 * chartRecipes_timePattern.js — 4 time pattern & cycle recipes (#32–#35)
 */

export const TIME_PATTERN_RECIPES = [
  // ── #32 Calendar Heatmap — Day × Hour Order Volume ──
  {
    id: 'weekday_hour_heatmap',
    name: 'Weekday × Hour Order Heatmap',
    name_zh: '星期 × 小時的訂單量熱力',
    category: 'time_pattern',
    description: 'Heatmap showing order volume by weekday and hour of day',
    tags: ['time', 'pattern'],
    chartType: 'heatmap',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])

    orders["weekday"] = orders["order_purchase_timestamp"].dt.day_name()
    orders["hour"] = orders["order_purchase_timestamp"].dt.hour

    day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    hour_order = list(range(24))
    orders["weekday"] = pd.Categorical(orders["weekday"], categories=day_order, ordered=True)
    pivot = orders.groupby(["weekday", "hour"], observed=False).size()
    pivot = pivot.reindex(pd.MultiIndex.from_product([day_order, hour_order], names=["weekday", "hour"]), fill_value=0).reset_index(name="orders")

    heatmap_data = [{"row": r["weekday"], "col": f"{int(r['hour']):02d}", "value": int(r["orders"])} for _, r in pivot.iterrows()]

    peak = pivot.loc[pivot["orders"].idxmax()]
    low = pivot.loc[pivot["orders"].idxmin()]
    time_bucket_labels = {
        "Overnight": "00:00-05:59",
        "Morning": "06:00-11:59",
        "Afternoon": "12:00-17:59",
        "Evening": "18:00-23:59",
    }
    pivot["time_bucket"] = pd.cut(
        pivot["hour"],
        bins=[-1, 5, 11, 17, 23],
        labels=["Overnight", "Morning", "Afternoon", "Evening"]
    )
    bucket_mix = pivot.groupby("time_bucket", observed=False)["orders"].sum().sort_values(ascending=False)
    dominant_bucket = bucket_mix.index[0]
    dominant_bucket_label = time_bucket_labels[str(dominant_bucket)]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Order Time Heatmap", "data": {
        "title": "Order Volume: Weekday × Hour",
        "analysisType": "weekday_hour_heatmap",
        "summary": f"Peak: {peak['weekday']} at {int(peak['hour']):02d}:00. Quietest: {low['weekday']} at {int(low['hour']):02d}:00.",
        "metrics": {"Peak Slot": f"{peak['weekday']} {int(peak['hour']):02d}:00", "Peak Orders": f"{int(peak['orders']):,}", "Quietest Slot": f"{low['weekday']} {int(low['hour']):02d}:00"},
        "charts": [{"type": "heatmap", "data": heatmap_data, "rowOrder": day_order, "colOrder": [f"{hour:02d}" for hour in hour_order], "title": "Orders by Day × Hour", "compatibleTypes": ["heatmap"]}],
        "highlights": [f"Peak: {peak['weekday']} {int(peak['hour']):02d}:00 ({int(peak['orders'])} orders)", f"Top demand window: {dominant_bucket} ({dominant_bucket_label})"]
    }}]}}
`,
  },

  // ── #33 Bar — Hourly Order Distribution ──
  {
    id: 'hourly_order_distribution',
    name: 'Hourly Order Distribution',
    name_zh: '24 小時訂單量分布',
    category: 'time_pattern',
    description: 'Bar chart showing order count by hour of day',
    tags: ['time', 'pattern'],
    chartType: 'bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])
    orders["hour"] = orders["order_purchase_timestamp"].dt.hour

    hourly = orders.groupby("hour")["order_id"].count().reset_index()
    hourly.columns = ["hour", "orders"]
    hourly["hour_label"] = hourly["hour"].apply(lambda h: f"{int(h):02d}:00")

    peak_hour = hourly.loc[hourly["orders"].idxmax()]
    quiet_hour = hourly.loc[hourly["orders"].idxmin()]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Hourly Orders", "data": {
        "title": "Order Distribution by Hour of Day",
        "analysisType": "hourly_order_distribution",
        "summary": f"Peak hour: {peak_hour['hour_label']} ({int(peak_hour['orders']):,} orders).",
        "metrics": {"Peak Hour": peak_hour["hour_label"], "Peak Orders": f"{int(peak_hour['orders']):,}", "Quietest Hour": quiet_hour["hour_label"]},
        "charts": [{"type": "bar", "data": hourly.to_dict("records"), "xKey": "hour_label", "yKey": "orders", "title": "Orders by Hour", "compatibleTypes": ["bar", "line", "area"],
            "xAxisLabel": "Hour of Day", "yAxisLabel": "Order Count", "tickFormatter": {"y": "compact"},
            "referenceLines": [{"axis": "x", "value": peak_hour["hour_label"], "label": f"Peak {peak_hour['hour_label']}", "color": "#ef4444"}],
            "colorMap": {peak_hour["hour_label"]: "#ef4444", quiet_hour["hour_label"]: "#94a3b8"}}],
        "highlights": [f"Peak at {peak_hour['hour_label']}", f"Lowest at {quiet_hour['hour_label']}"]
    }}]}}
`,
  },

  // ── #34 Grouped Bar — Weekday Orders vs Rating ──
  {
    id: 'weekday_orders_vs_rating',
    name: 'Weekday Orders vs Rating',
    name_zh: '週一~週日訂單量與評分差異',
    category: 'time_pattern',
    description: 'Grouped bar comparing order volume and average rating by day of week',
    tags: ['time', 'rating', 'pattern'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    reviews = tables["reviews"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])
    orders["weekday"] = orders["order_purchase_timestamp"].dt.day_name()

    merged = orders.merge(reviews[["order_id", "review_score"]], on="order_id", how="left")

    day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    stats = merged.groupby("weekday").agg(
        orders=("order_id", "count"),
        avg_rating=("review_score", "mean")
    ).reindex(day_order).reset_index()
    stats["avg_rating"] = stats["avg_rating"].round(2)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Weekday Pattern", "data": {
        "title": "Orders & Rating by Day of Week",
        "analysisType": "weekday_orders_vs_rating",
        "summary": "Order volume and satisfaction vary by weekday.",
        "charts": [{"type": "grouped_bar", "data": stats.to_dict("records"), "xKey": "weekday", "yKey": "orders", "series": ["orders", "avg_rating"], "title": "Orders & Avg Rating by Weekday", "compatibleTypes": ["grouped_bar", "bar", "line"],
            "xAxisLabel": "Day of Week", "yAxisLabel": "Orders / Rating"}],
        "highlights": [f"Busiest day: {stats.loc[stats['orders'].idxmax(), 'weekday']}", f"Best rated day: {stats.loc[stats['avg_rating'].idxmax(), 'weekday']}"]
    }}]}}
`,
  },

  // ── #35 Calendar Chart (→ heatmap) — Daily Order Volume ──
  {
    id: 'daily_order_calendar',
    name: 'Daily Order Calendar',
    name_zh: '每日訂單量（找節日/促銷峰值）',
    category: 'time_pattern',
    description: 'Calendar heatmap of daily order volume to spot holidays and promotions',
    tags: ['time', 'pattern'],
    chartType: 'heatmap',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])
    orders["date"] = orders["order_purchase_timestamp"].dt.date

    daily = orders.groupby("date")["order_id"].count().reset_index()
    daily.columns = ["date", "orders"]
    daily["date"] = pd.to_datetime(daily["date"])
    daily["week"] = daily["date"].dt.isocalendar().week.astype(str)
    daily["weekday"] = daily["date"].dt.day_name()

    # Use month-week as col, weekday as row for calendar layout
    daily["month_week"] = daily["date"].dt.strftime("%Y-W%V")
    heatmap_data = [{"row": r["weekday"], "col": r["month_week"], "value": int(r["orders"])} for _, r in daily.iterrows()]

    peak = daily.loc[daily["orders"].idxmax()]
    avg_daily = daily["orders"].mean()

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Daily Order Calendar", "data": {
        "title": "Daily Order Volume Calendar",
        "analysisType": "daily_order_calendar",
        "summary": f"Peak day: {peak['date'].strftime('%Y-%m-%d')} with {int(peak['orders'])} orders. Avg: {avg_daily:.0f}/day.",
        "metrics": {"Peak Day": peak["date"].strftime("%Y-%m-%d"), "Peak Orders": f"{int(peak['orders']):,}", "Avg Daily": f"{avg_daily:.0f}", "Days Tracked": str(len(daily))},
        "charts": [{"type": "heatmap", "data": heatmap_data[:500], "title": "Daily Orders (Calendar View)", "compatibleTypes": ["heatmap"]}],
        "tables": [{"title": "Top 10 Peak Days", "columns": ["date", "orders"], "rows": daily.nlargest(10, "orders").assign(date=lambda d: d["date"].dt.strftime("%Y-%m-%d")).to_dict("records")}],
        "highlights": [f"Peak: {peak['date'].strftime('%Y-%m-%d')} ({int(peak['orders'])} orders)", "Look for holiday/promotion spikes"]
    }}]}}
`,
  },
];
