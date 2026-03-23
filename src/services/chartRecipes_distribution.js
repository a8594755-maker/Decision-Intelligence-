/**
 * chartRecipes_distribution.js — 8 distribution & comparison recipes (#7–#14)
 */

export const DISTRIBUTION_RECIPES = [
  // ── #7 Histogram — Order Amount Distribution ──
  {
    id: 'order_amount_histogram',
    name: 'Order Amount Distribution',
    name_zh: '訂單金額分布（偏態分析）',
    category: 'distribution',
    description: 'Histogram of order payment values with skewness analysis',
    tags: ['payment', 'distribution'],
    chartType: 'histogram',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    from scipy import stats as sp_stats
    payments = tables["payments"].copy()
    order_totals = payments.groupby("order_id")["payment_value"].sum().reset_index()
    vals = order_totals["payment_value"]

    bins = pd.cut(vals, bins=20)
    hist = vals.groupby(bins).count().reset_index()
    hist.columns = ["bin", "count"]
    hist["bin"] = hist["bin"].astype(str)

    skew = float(vals.skew())
    kurt = float(vals.kurtosis())
    median = float(vals.median())
    p90 = float(vals.quantile(0.9))

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Order Amount Distribution", "data": {
        "title": "Order Amount Distribution",
        "analysisType": "order_amount_histogram",
        "summary": f"Median order: R\${median:,.0f}, P90: R\${p90:,.0f}. Skewness: {skew:.2f} (right-skewed).",
        "metrics": {"Median": f"R\${median:,.0f}", "Mean": f"R\${vals.mean():,.0f}", "P90": f"R\${p90:,.0f}", "Skewness": f"{skew:.2f}", "Kurtosis": f"{kurt:.2f}"},
        "charts": [{"type": "histogram", "data": hist.to_dict("records"), "xKey": "bin", "yKey": "count", "title": "Order Value Distribution", "compatibleTypes": ["histogram", "bar"],
            "xAxisLabel": "Order Value (R$)", "yAxisLabel": "Order Count", "tickFormatter": {"y": "compact"},
            "referenceLines": [
                {"axis": "y", "value": float(median), "label": f"Median R\${median:,.0f}", "color": "#f59e0b"},
                {"axis": "y", "value": float(p90), "label": f"P90 R\${p90:,.0f}", "color": "#ef4444"},
            ]}],
        "highlights": [f"{'Right' if skew > 0 else 'Left'}-skewed distribution (skew={skew:.2f})", f"90% of orders under R\${p90:,.0f}"]
    }}]}}
`,
  },

  // ── #8 Box Plot — Delivery Days by Rating ──
  {
    id: 'delivery_by_rating_boxplot',
    name: 'Delivery Days by Rating',
    name_zh: '各評分等級的配送天數分布',
    category: 'distribution',
    description: 'Box plot of delivery days distribution grouped by review score',
    tags: ['rating', 'delivery', 'distribution'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    orders = tables["orders"].copy()
    reviews = tables["reviews"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    delivered = orders.dropna(subset=["order_delivered_customer_date", "order_purchase_timestamp"])
    delivered["delivery_days"] = (delivered["order_delivered_customer_date"] - delivered["order_purchase_timestamp"]).dt.days

    merged = delivered.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")

    box_data = []
    for score in sorted(merged["review_score"].unique()):
        subset = merged[merged["review_score"] == score]["delivery_days"]
        box_data.append({
            "rating": f"{int(score)} Star",
            "min": float(subset.min()),
            "Q1": float(subset.quantile(0.25)),
            "median": float(subset.median()),
            "Q3": float(subset.quantile(0.75)),
            "max": float(min(subset.max(), subset.quantile(0.75) + 1.5 * (subset.quantile(0.75) - subset.quantile(0.25)))),
            "mean": round(float(subset.mean()), 1),
        })

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Delivery Days by Rating", "data": {
        "title": "Delivery Days Distribution by Review Score",
        "analysisType": "delivery_by_rating_boxplot",
        "summary": "Lower ratings correlate with longer delivery times.",
        "charts": [{"type": "grouped_bar", "data": box_data, "xKey": "rating", "yKey": "median", "series": ["Q1", "median", "Q3", "mean"], "title": "Delivery Days Quartiles by Rating", "compatibleTypes": ["grouped_bar", "bar"],
            "xAxisLabel": "Review Score", "yAxisLabel": "Delivery Days",
            "referenceLines": [{"axis": "y", "value": float(sum(d['mean'] for d in box_data) / len(box_data)), "label": f"Overall Avg {sum(d['mean'] for d in box_data) / len(box_data):.0f}d", "color": "#94a3b8"}]}],
        "tables": [{"title": "Box Plot Statistics", "columns": ["rating", "min", "Q1", "median", "Q3", "max", "mean"], "rows": box_data}],
        "highlights": [f"1-star orders avg {box_data[0]['mean']:.0f} days vs 5-star avg {box_data[-1]['mean']:.0f} days" if len(box_data) >= 2 else "Insufficient data"]
    }}]}}
`,
  },

  // ── #9 Violin (→ grouped_bar approx) — Top 10 Category Price Distribution ──
  {
    id: 'category_price_distribution',
    name: 'Top 10 Category Price Distribution',
    name_zh: 'Top 10 品類價格分布密度',
    category: 'distribution',
    description: 'Price distribution density for top 10 product categories',
    tags: ['category', 'price', 'distribution'],
    chartType: 'grouped_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    top10 = merged.groupby("product_category_name")["price"].count().nlargest(10).index.tolist()
    subset = merged[merged["product_category_name"].isin(top10)]

    stats = subset.groupby("product_category_name")["price"].agg(["min", "median", "mean", "max", "std"]).reset_index()
    stats.columns = ["category", "min", "median", "mean", "max", "std"]
    stats = stats.round(2).sort_values("median", ascending=False)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Price Distribution", "data": {
        "title": "Top 10 Category Price Distribution",
        "analysisType": "category_price_distribution",
        "summary": f"Price statistics for top 10 categories by volume.",
        "charts": [{"type": "grouped_bar", "data": stats.to_dict("records"), "xKey": "category", "yKey": "median", "series": ["min", "median", "mean", "max"], "title": "Price Range by Category", "compatibleTypes": ["grouped_bar", "horizontal_bar", "bar"],
            "xAxisLabel": "Category", "yAxisLabel": "Price (R$)", "tickFormatter": {"y": "compact"}}],
        "tables": [{"title": "Price Statistics", "columns": ["category", "min", "median", "mean", "max", "std"], "rows": stats.to_dict("records")}],
        "highlights": [f"Highest median price: {stats.iloc[0]['category']} (R\${stats.iloc[0]['median']:,.0f})", f"Most variable: {stats.loc[stats['std'].idxmax(), 'category']}"]
    }}]}}
`,
  },

  // ── #10 Horizontal Bar — Top 15 Category Revenue ──
  {
    id: 'top_category_revenue',
    name: 'Top 15 Category Revenue',
    name_zh: 'Top 15 品類營收排行',
    category: 'distribution',
    description: 'Horizontal bar chart ranking top 15 categories by revenue',
    tags: ['category', 'revenue', 'ranking'],
    chartType: 'horizontal_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    cat_rev = merged.groupby("product_category_name")["price"].sum().nlargest(15).reset_index()
    cat_rev.columns = ["category", "revenue"]
    cat_rev["revenue"] = cat_rev["revenue"].round(0)
    total = cat_rev["revenue"].sum()
    cat_rev["pct"] = (cat_rev["revenue"] / merged["price"].sum() * 100).round(1)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Top Category Revenue", "data": {
        "title": "Top 15 Categories by Revenue",
        "analysisType": "top_category_revenue",
        "summary": f"Top 15 categories account for R\${total:,.0f} ({cat_rev['pct'].sum():.1f}% of total).",
        "metrics": {"Top 15 Revenue": f"R\${total:,.0f}", "Top 15 Share": f"{cat_rev['pct'].sum():.1f}%", "Categories Total": str(merged['product_category_name'].nunique())},
        "charts": [{"type": "horizontal_bar", "data": cat_rev.to_dict("records"), "xKey": "category", "yKey": "revenue", "title": "Revenue by Category", "compatibleTypes": ["horizontal_bar", "bar", "pie"],
            "xAxisLabel": "Category", "yAxisLabel": "Revenue (R$)", "tickFormatter": {"y": "currency"},
            "referenceLines": [{"axis": "y", "value": float(cat_rev["revenue"].mean()), "label": f"Avg R\${cat_rev['revenue'].mean():,.0f}", "color": "#94a3b8", "strokeDasharray": "6 4"}],
            "colorMap": {cat_rev.iloc[0]["category"]: "#ef4444", cat_rev.iloc[1]["category"]: "#f59e0b", cat_rev.iloc[2]["category"]: "#f59e0b"}}],
        "highlights": [f"#1 {cat_rev.iloc[0]['category']}: R\${cat_rev.iloc[0]['revenue']:,.0f} ({cat_rev.iloc[0]['pct']}%)", f"Top 5 = {cat_rev.head(5)['pct'].sum():.1f}% of total revenue"]
    }}]}}
`,
  },

  // ── #11 Grouped Bar — State: Seller Count vs Avg Revenue ──
  {
    id: 'state_seller_vs_revenue',
    name: 'State Sellers vs Avg Revenue',
    name_zh: '各州賣家數量 vs 平均營收',
    category: 'distribution',
    description: 'Grouped bar comparing seller count and average revenue by state',
    tags: ['geo', 'seller', 'revenue', 'comparison'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    sellers = tables["sellers"].copy()

    merged = items.merge(sellers[["seller_id", "seller_state"]], on="seller_id", how="left")
    merged = merged.dropna(subset=["seller_state"])

    state_stats = merged.groupby("seller_state").agg(
        seller_count=("seller_id", "nunique"),
        total_revenue=("price", "sum")
    ).reset_index()
    state_stats["avg_revenue"] = (state_stats["total_revenue"] / state_stats["seller_count"]).round(0)
    state_stats = state_stats.nlargest(15, "seller_count")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Seller vs Revenue", "data": {
        "title": "Seller Count vs Avg Revenue by State (Top 15)",
        "analysisType": "state_seller_vs_revenue",
        "summary": f"Top state: {state_stats.iloc[0]['seller_state']} with {state_stats.iloc[0]['seller_count']} sellers.",
        "charts": [{"type": "grouped_bar", "data": state_stats.to_dict("records"), "xKey": "seller_state", "yKey": "seller_count", "series": ["seller_count", "avg_revenue"], "title": "Sellers & Avg Revenue by State", "compatibleTypes": ["grouped_bar", "bar", "horizontal_bar"],
            "xAxisLabel": "State", "yAxisLabel": "Count / Revenue (R$)"}],
        "highlights": [f"SP dominates with {state_stats.iloc[0]['seller_count']} sellers"]
    }}]}}
`,
  },

  // ── #12 Stacked Bar — Category Rating Distribution ──
  {
    id: 'category_rating_stacked',
    name: 'Category Rating Distribution',
    name_zh: '各品類 1~5 星評分比例',
    category: 'distribution',
    description: 'Stacked bar showing 1-5 star review distribution per category',
    tags: ['category', 'rating', 'distribution'],
    chartType: 'stacked_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()

    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")
    merged = merged.dropna(subset=["product_category_name"])

    top10 = merged.groupby("product_category_name")["order_id"].count().nlargest(10).index.tolist()
    subset = merged[merged["product_category_name"].isin(top10)]

    pivot = subset.groupby(["product_category_name", "review_score"]).size().unstack(fill_value=0)
    # Convert to percentage
    pivot_pct = pivot.div(pivot.sum(axis=1), axis=0).multiply(100).round(1).reset_index()
    pivot_pct.columns = ["category"] + [f"{int(c)}_star" for c in pivot_pct.columns[1:]]
    series = [c for c in pivot_pct.columns if c != "category"]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Ratings", "data": {
        "title": "Rating Distribution by Category (Top 10)",
        "analysisType": "category_rating_stacked",
        "summary": "Percentage of 1-5 star reviews per product category.",
        "charts": [{"type": "stacked_bar", "data": pivot_pct.to_dict("records"), "xKey": "category", "yKey": series[0], "series": series, "title": "Rating % by Category", "compatibleTypes": ["stacked_bar", "grouped_bar", "bar"],
            "xAxisLabel": "Category", "yAxisLabel": "Rating Share (%)", "tickFormatter": {"y": "percent"}}],
        "highlights": ["5-star rates vary significantly across categories"]
    }}]}}
`,
  },

  // ── #13 Log Histogram — Seller Revenue (Long Tail) ──
  {
    id: 'seller_revenue_log_histogram',
    name: 'Seller Revenue Distribution (Log)',
    name_zh: '賣家營收分布（長尾特徵）',
    category: 'distribution',
    description: 'Log-scale histogram of seller revenue showing long-tail characteristics',
    tags: ['seller', 'revenue', 'distribution'],
    chartType: 'bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    items = tables["order_items"].copy()
    seller_rev = items.groupby("seller_id")["price"].sum().reset_index()
    seller_rev.columns = ["seller_id", "revenue"]
    seller_rev = seller_rev[seller_rev["revenue"] > 0]

    log_rev = np.log10(seller_rev["revenue"])
    bins = np.arange(log_rev.min().round(0), log_rev.max().round(0) + 0.5, 0.5)
    median_rev = float(seller_rev["revenue"].median())
    p90_rev = float(seller_rev["revenue"].quantile(0.9))

    def fmt_range(lo, hi):
        def fmt(v):
            if v >= 1_000_000: return f"{v/1_000_000:.0f}M"
            if v >= 1_000: return f"{v/1_000:.0f}K"
            return f"{v:.0f}"
        return f"R\${fmt(10**lo)}-{fmt(10**hi)}"

    seg_colors = ["#8b5cf6", "#8b5cf6", "#3b82f6", "#3b82f6", "#10b981", "#10b981", "#f59e0b", "#f59e0b", "#ef4444", "#ef4444"]
    hist_data = []
    color_map = {}
    median_bin = None
    for i in range(len(bins) - 1):
        count = int(((log_rev >= bins[i]) & (log_rev < bins[i+1])).sum())
        label = fmt_range(bins[i], bins[i+1])
        hist_data.append({"range": label, "sellers": count})
        color_map[label] = seg_colors[min(i, len(seg_colors) - 1)]
        if median_bin is None and 10**bins[i+1] >= median_rev:
            median_bin = label

    top10_share = seller_rev.nlargest(10, "revenue")["revenue"].sum() / seller_rev["revenue"].sum() * 100
    gini = float((2 * np.arange(1, len(seller_rev)+1) * seller_rev.sort_values("revenue")["revenue"].values).sum() / (len(seller_rev) * seller_rev["revenue"].sum()) - (len(seller_rev)+1)/len(seller_rev))

    ref_lines = []
    if median_bin:
        ref_lines.append({"axis": "x", "value": median_bin, "label": f"Median R\${median_rev:,.0f}", "color": "#f59e0b"})

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Seller Revenue Distribution", "data": {
        "title": "Seller Revenue Distribution (Log Scale)",
        "analysisType": "seller_revenue_log_histogram",
        "summary": f"Revenue follows a long-tail distribution. Top 10 sellers = {top10_share:.1f}% of total. Gini = {gini:.3f}.",
        "metrics": {"Total Sellers": f"{len(seller_rev):,}", "Gini Coefficient": f"{gini:.3f}", "Top 10 Share": f"{top10_share:.1f}%", "Median Revenue": f"R\${median_rev:,.0f}"},
        "charts": [{"type": "bar", "data": hist_data, "xKey": "range", "yKey": "sellers", "title": "Sellers by Revenue Bracket (Log Scale)", "compatibleTypes": ["bar", "histogram"],
            "xAxisLabel": "Revenue Bracket (R$)", "yAxisLabel": "Seller Count", "tickFormatter": {"y": "compact"},
            "colorMap": color_map, "referenceLines": ref_lines}],
        "highlights": [f"Long-tail: top 10 sellers = {top10_share:.1f}%", f"Gini = {gini:.3f} (high concentration)"]
    }}]}}
`,
  },

  // ── #14 Dual Histogram — Weight vs Freight ──
  {
    id: 'weight_vs_freight_dual_hist',
    name: 'Weight vs Freight Distribution',
    name_zh: '商品重量分布 vs 運費分布',
    category: 'distribution',
    description: 'Dual histogram comparing product weight and freight value distributions',
    tags: ['product', 'logistics', 'distribution'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_weight_g"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_weight_g", "freight_value"])

    # Normalize both to 0-1 range then bin into 10 buckets
    w = merged["product_weight_g"]
    f = merged["freight_value"]

    w_bins = pd.cut(w, bins=10)
    f_bins = pd.cut(f, bins=10)

    w_hist = w.groupby(w_bins).count().reset_index()
    w_hist.columns = ["bin", "weight_count"]
    w_hist["bin"] = w_hist["bin"].astype(str)

    f_hist = f.groupby(f_bins).count().reset_index()
    f_hist.columns = ["bin", "freight_count"]
    f_hist["bin"] = f_hist["bin"].astype(str)

    # Combine into single chart with index
    chart_data = []
    for i in range(min(len(w_hist), len(f_hist))):
        chart_data.append({"bucket": str(i+1), "weight_count": int(w_hist.iloc[i]["weight_count"]), "freight_count": int(f_hist.iloc[i]["freight_count"])})

    corr = float(merged[["product_weight_g", "freight_value"]].corr().iloc[0, 1])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Weight vs Freight Distribution", "data": {
        "title": "Product Weight vs Freight Value Distribution",
        "analysisType": "weight_vs_freight_dual_hist",
        "summary": f"Correlation between weight and freight: {corr:.3f}.",
        "metrics": {"Correlation": f"{corr:.3f}", "Avg Weight": f"{w.mean():,.0f}g", "Avg Freight": f"R\${f.mean():,.1f}"},
        "charts": [{"type": "grouped_bar", "data": chart_data, "xKey": "bucket", "yKey": "weight_count", "series": ["weight_count", "freight_count"], "title": "Weight vs Freight (10 Buckets)", "compatibleTypes": ["grouped_bar", "bar", "stacked_bar"],
            "xAxisLabel": "Bucket (Decile)", "yAxisLabel": "Item Count", "tickFormatter": {"y": "compact"}}],
        "highlights": [f"Weight-freight correlation: {corr:.3f}", f"Heavier items tend to have {'higher' if corr > 0.3 else 'similar'} freight costs"]
    }}]}}
`,
  },
];
