/**
 * chartRecipes_trend.js — 6 trend & time-series recipes (#1–#6)
 */

export const TREND_RECIPES = [
  // ── #1 Monthly Revenue & Order Dual-Axis Trend ──
  {
    id: 'monthly_revenue_order_trend',
    name: 'Monthly Revenue & Order Trend',
    name_zh: '月度營收與訂單量雙軸趨勢',
    category: 'trend',
    description: 'Monthly revenue and order count dual-axis trend line',
    tags: ['revenue', 'orders', 'trend', 'time-series'],
    chartType: 'line',
    params: {
      period: { type: 'string', default: 'M', enum: ['W', 'M', 'Q'], description: 'Aggregation period' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    params = input_data.get("recipe_params", {})
    period = params.get("period", "M")

    orders = tables["orders"].copy()
    items  = tables["order_items"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    merged = items.merge(orders[["order_id", "order_purchase_timestamp"]], on="order_id", how="left")
    merged = merged.dropna(subset=["order_purchase_timestamp"])
    merged.set_index("order_purchase_timestamp", inplace=True)

    grp = merged.resample(period).agg(revenue=("price", "sum"), orders=("order_id", "nunique")).reset_index()
    grp.columns = ["month", "revenue", "orders"]
    grp["month"] = grp["month"].dt.strftime("%Y-%m")
    grp["revenue"] = grp["revenue"].round(2)

    total_rev = grp["revenue"].sum()
    total_orders = grp["orders"].sum()
    avg_monthly_rev = grp["revenue"].mean()

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Monthly Revenue & Order Trend", "data": {
        "title": "Monthly Revenue & Order Trend",
        "analysisType": "monthly_revenue_order_trend",
        "summary": f"Total revenue: R\${total_rev:,.0f} across {total_orders:,} orders. Average monthly revenue: R\${avg_monthly_rev:,.0f}.",
        "metrics": {"Total Revenue": f"R\${total_rev:,.0f}", "Total Orders": f"{total_orders:,}", "Avg Monthly Revenue": f"R\${avg_monthly_rev:,.0f}", "Months": str(len(grp))},
        "charts": [{"type": "line", "data": grp.to_dict("records"), "xKey": "month", "yKey": "revenue", "series": ["revenue", "orders"], "title": "Revenue & Orders by Month", "compatibleTypes": ["line", "area", "bar", "stacked_bar"],
            "xAxisLabel": "Month", "yAxisLabel": "Revenue (R$) / Orders", "tickFormatter": {"y": "compact"},
            "referenceLines": [{"axis": "y", "value": float(avg_monthly_rev), "label": f"Avg R\${avg_monthly_rev:,.0f}", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Peak revenue month: {grp.loc[grp['revenue'].idxmax(), 'month']}", f"Peak orders month: {grp.loc[grp['orders'].idxmax(), 'month']}"]
    }}]}}
`,
  },

  // ── #2 Stacked Area — Category Revenue Over Time ──
  {
    id: 'category_revenue_stacked_area',
    name: 'Category Revenue Stacked Area',
    name_zh: '品類營收佔比隨時間的消長',
    category: 'trend',
    description: 'Stacked area chart showing revenue share by product category over time',
    tags: ['category', 'revenue', 'trend', 'time-series'],
    chartType: 'area',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items  = tables["order_items"].copy()
    products = tables["products"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    merged = items.merge(orders[["order_id", "order_purchase_timestamp"]], on="order_id", how="left")
    merged = merged.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["order_purchase_timestamp", "product_category_name"])
    merged["month"] = merged["order_purchase_timestamp"].dt.to_period("M").dt.to_timestamp()

    top_cats = merged.groupby("product_category_name")["price"].sum().nlargest(8).index.tolist()
    merged["category"] = merged["product_category_name"].apply(lambda x: x if x in top_cats else "Other")

    pivot = merged.groupby(["month", "category"])["price"].sum().unstack(fill_value=0).reset_index()
    pivot["month"] = pivot["month"].dt.strftime("%Y-%m")
    series = [c for c in pivot.columns if c != "month"]
    chart_data = pivot.to_dict("records")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Revenue Over Time", "data": {
        "title": "Category Revenue Share Over Time (Top 8 + Other)",
        "analysisType": "category_revenue_stacked_area",
        "summary": f"Top 8 categories tracked across {len(pivot)} months.",
        "charts": [{"type": "area", "data": chart_data, "xKey": "month", "yKey": series[0], "series": series, "title": "Revenue by Category", "compatibleTypes": ["area", "stacked_bar", "line"],
            "xAxisLabel": "Month", "yAxisLabel": "Revenue (R$)", "tickFormatter": {"y": "compact"}}],
        "highlights": [f"Top category: {top_cats[0]}" if top_cats else "No data"]
    }}]}}
`,
  },

  // ── #3 Multi-line — Payment Method Usage Trend ──
  {
    id: 'payment_method_trend',
    name: 'Payment Method Trend',
    name_zh: '各付款方式月度使用量趨勢',
    category: 'trend',
    description: 'Multi-line chart showing monthly usage of each payment method',
    tags: ['payment', 'trend', 'time-series'],
    chartType: 'line',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    payments = tables["payments"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    merged = payments.merge(orders[["order_id", "order_purchase_timestamp"]], on="order_id", how="left")
    merged = merged.dropna(subset=["order_purchase_timestamp"])
    merged["month"] = merged["order_purchase_timestamp"].dt.to_period("M").dt.to_timestamp()

    pivot = merged.groupby(["month", "payment_type"])["order_id"].count().unstack(fill_value=0).reset_index()
    pivot["month"] = pivot["month"].dt.strftime("%Y-%m")
    series = [c for c in pivot.columns if c != "month"]
    chart_data = pivot.to_dict("records")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Payment Method Trends", "data": {
        "title": "Payment Method Usage Over Time",
        "analysisType": "payment_method_trend",
        "summary": f"Tracked {len(series)} payment methods across {len(pivot)} months.",
        "charts": [{"type": "line", "data": chart_data, "xKey": "month", "yKey": series[0], "series": series, "title": "Monthly Transactions by Payment Method", "compatibleTypes": ["line", "area", "stacked_bar"],
            "xAxisLabel": "Month", "yAxisLabel": "Transaction Count", "tickFormatter": {"y": "compact"}}],
        "highlights": [f"Payment methods: {', '.join(series)}"]
    }}]}}
`,
  },

  // ── #4 Moving Average — Weekly Review Score ──
  {
    id: 'review_score_moving_avg',
    name: 'Review Score Moving Average',
    name_zh: '每週平均評分趨勢與波動',
    category: 'trend',
    description: 'Weekly average review score with 4-week moving average',
    tags: ['review', 'rating', 'trend', 'moving-average'],
    chartType: 'line',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    reviews = tables["reviews"].copy()
    reviews["review_creation_date"] = pd.to_datetime(reviews["review_creation_date"], errors="coerce")
    reviews = reviews.dropna(subset=["review_creation_date", "review_score"])

    weekly = reviews.set_index("review_creation_date").resample("W")["review_score"].mean().reset_index()
    weekly.columns = ["week", "avg_score"]
    weekly["avg_score"] = weekly["avg_score"].round(2)
    weekly["ma_4w"] = weekly["avg_score"].rolling(4, min_periods=1).mean().round(2)
    weekly["week"] = weekly["week"].dt.strftime("%Y-%m-%d")

    overall_avg = reviews["review_score"].mean()

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Review Score Trend", "data": {
        "title": "Weekly Review Score with 4-Week Moving Average",
        "analysisType": "review_score_moving_avg",
        "summary": f"Overall average score: {overall_avg:.2f}. Tracking {len(weekly)} weeks.",
        "metrics": {"Overall Avg": f"{overall_avg:.2f}", "Weeks": str(len(weekly)), "Min Weekly": f"{weekly['avg_score'].min():.2f}", "Max Weekly": f"{weekly['avg_score'].max():.2f}"},
        "charts": [{"type": "line", "data": weekly.to_dict("records"), "xKey": "week", "yKey": "avg_score", "series": ["avg_score", "ma_4w"], "title": "Weekly Avg Score & 4W Moving Average", "compatibleTypes": ["line", "area"],
            "xAxisLabel": "Week", "yAxisLabel": "Review Score",
            "referenceLines": [{"axis": "y", "value": float(overall_avg), "label": f"Overall Avg {overall_avg:.2f}", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Best week: {weekly.loc[weekly['avg_score'].idxmax(), 'week']}", f"Worst week: {weekly.loc[weekly['avg_score'].idxmin(), 'week']}"]
    }}]}}
`,
  },

  // ── #5 Area — New vs Active Sellers Growth ──
  {
    id: 'seller_growth_trend',
    name: 'New vs Active Sellers Growth',
    name_zh: '新賣家入駐 vs 活躍賣家成長',
    category: 'trend',
    description: 'Area chart comparing new seller onboarding vs active seller count per month',
    tags: ['seller', 'growth', 'trend'],
    chartType: 'area',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items  = tables["order_items"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    merged = items.merge(orders[["order_id", "order_purchase_timestamp"]], on="order_id", how="left")
    merged = merged.dropna(subset=["order_purchase_timestamp"])
    merged["month"] = merged["order_purchase_timestamp"].dt.to_period("M").dt.to_timestamp()

    first_sale = merged.groupby("seller_id")["month"].min().reset_index()
    first_sale.columns = ["seller_id", "first_month"]
    new_sellers = first_sale.groupby("first_month").size().reset_index(name="new_sellers")
    new_sellers["first_month"] = new_sellers["first_month"].dt.strftime("%Y-%m")

    active = merged.groupby("month")["seller_id"].nunique().reset_index()
    active.columns = ["month", "active_sellers"]
    active["month"] = active["month"].dt.strftime("%Y-%m")

    result = active.merge(new_sellers, left_on="month", right_on="first_month", how="left").drop(columns=["first_month"], errors="ignore")
    result["new_sellers"] = result["new_sellers"].fillna(0).astype(int)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Seller Growth Trend", "data": {
        "title": "New vs Active Sellers Over Time",
        "analysisType": "seller_growth_trend",
        "summary": f"Total unique sellers: {first_sale['seller_id'].nunique():,}. Active sellers grew from {result['active_sellers'].iloc[0] if len(result) else 0} to {result['active_sellers'].iloc[-1] if len(result) else 0}.",
        "metrics": {"Total Sellers": f"{first_sale['seller_id'].nunique():,}", "Peak Active": f"{result['active_sellers'].max():,}", "Peak New/Month": f"{result['new_sellers'].max():,}"},
        "charts": [{"type": "area", "data": result.to_dict("records"), "xKey": "month", "yKey": "active_sellers", "series": ["active_sellers", "new_sellers"], "title": "Seller Growth", "compatibleTypes": ["area", "line", "stacked_bar"],
            "xAxisLabel": "Month", "yAxisLabel": "Seller Count", "tickFormatter": {"y": "compact"}}],
        "highlights": ["Cumulative seller base tracked month over month"]
    }}]}}
`,
  },

  // ── #6 Trend Line — Delivery Days & Late Rate ──
  {
    id: 'delivery_days_trend',
    name: 'Delivery Days & Late Rate Trend',
    name_zh: '月度平均配送天數與延遲率趨勢',
    category: 'trend',
    description: 'Monthly average delivery days and late delivery rate trend',
    tags: ['delivery', 'logistics', 'trend'],
    chartType: 'line',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    orders["order_estimated_delivery_date"] = pd.to_datetime(orders["order_estimated_delivery_date"], errors="coerce")

    delivered = orders.dropna(subset=["order_delivered_customer_date", "order_purchase_timestamp"])
    delivered["delivery_days"] = (delivered["order_delivered_customer_date"] - delivered["order_purchase_timestamp"]).dt.days
    delivered["is_late"] = (delivered["order_delivered_customer_date"] > delivered["order_estimated_delivery_date"]).astype(int)
    delivered["month"] = delivered["order_purchase_timestamp"].dt.to_period("M").dt.to_timestamp()

    monthly = delivered.groupby("month").agg(avg_days=("delivery_days", "mean"), late_rate=("is_late", "mean")).reset_index()
    monthly["avg_days"] = monthly["avg_days"].round(1)
    monthly["late_rate"] = (monthly["late_rate"] * 100).round(1)
    monthly["month"] = monthly["month"].dt.strftime("%Y-%m")

    overall_avg = delivered["delivery_days"].mean()
    overall_late = delivered["is_late"].mean() * 100

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Delivery Trend", "data": {
        "title": "Monthly Avg Delivery Days & Late Rate",
        "analysisType": "delivery_days_trend",
        "summary": f"Overall avg delivery: {overall_avg:.1f} days, late rate: {overall_late:.1f}%.",
        "metrics": {"Avg Delivery Days": f"{overall_avg:.1f}", "Late Rate": f"{overall_late:.1f}%", "Months Tracked": str(len(monthly))},
        "charts": [{"type": "line", "data": monthly.to_dict("records"), "xKey": "month", "yKey": "avg_days", "series": ["avg_days", "late_rate"], "title": "Delivery Days & Late Rate (%)", "compatibleTypes": ["line", "area", "bar"],
            "xAxisLabel": "Month", "yAxisLabel": "Days / Late Rate (%)",
            "referenceLines": [{"axis": "y", "value": float(overall_avg), "label": f"Avg {overall_avg:.1f}d", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Best delivery month: {monthly.loc[monthly['avg_days'].idxmin(), 'month']}", f"Worst late rate: {monthly.loc[monthly['late_rate'].idxmax(), 'month']}"]
    }}]}}
`,
  },
];
