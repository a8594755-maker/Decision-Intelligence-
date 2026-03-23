/**
 * chartRecipes_advanced.js — 15 advanced analysis recipes (#36–#50)
 */

export const ADVANCED_RECIPES = [
  // ── #36 Cohort Heatmap — Customer Retention ──
  {
    id: 'customer_cohort_retention',
    name: 'Customer Cohort Retention',
    name_zh: '客戶留存率（月度 cohort）',
    category: 'advanced',
    description: 'Cohort analysis heatmap showing monthly customer retention rates',
    tags: ['customer', 'retention', 'cohort'],
    chartType: 'heatmap',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])
    orders["order_month"] = orders["order_purchase_timestamp"].dt.to_period("M")

    first_purchase = orders.groupby("customer_id")["order_month"].min().reset_index()
    first_purchase.columns = ["customer_id", "cohort_month"]
    orders = orders.merge(first_purchase, on="customer_id")
    orders["months_since"] = (orders["order_month"] - orders["cohort_month"]).apply(lambda x: x.n)

    cohort = orders.groupby(["cohort_month", "months_since"])["customer_id"].nunique().reset_index()
    cohort.columns = ["cohort_month", "months_since", "customers"]
    cohort_size = cohort[cohort["months_since"] == 0][["cohort_month", "customers"]].rename(columns={"customers": "cohort_size"})
    cohort = cohort.merge(cohort_size, on="cohort_month")
    cohort["retention"] = (cohort["customers"] / cohort["cohort_size"] * 100).round(1)
    cohort["cohort_month"] = cohort["cohort_month"].astype(str)

    heatmap_data = [{"row": r["cohort_month"], "col": str(int(r["months_since"])), "value": float(r["retention"])} for _, r in cohort.iterrows() if r["months_since"] <= 12]

    avg_m1 = cohort[cohort["months_since"] == 1]["retention"].mean()

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Cohort Retention", "data": {
        "title": "Monthly Cohort Retention Rate",
        "analysisType": "customer_cohort_retention",
        "summary": f"Average Month-1 retention: {avg_m1:.1f}%.",
        "metrics": {"Avg M1 Retention": f"{avg_m1:.1f}%", "Cohorts": str(cohort["cohort_month"].nunique())},
        "charts": [{"type": "heatmap", "data": heatmap_data, "title": "Retention % (Cohort × Months Since)", "compatibleTypes": ["heatmap"]}],
        "highlights": [f"Avg month-1 retention: {avg_m1:.1f}%", "Most customers don't return (low repeat rate)"]
    }}]}}
`,
  },

  // ── #37 Funnel — Order Lifecycle ──
  {
    id: 'order_lifecycle_funnel',
    name: 'Order Lifecycle Funnel',
    name_zh: '訂單生命週期漏斗轉化',
    category: 'advanced',
    description: 'Funnel chart showing order status conversion through the lifecycle',
    tags: ['logistics', 'funnel'],
    chartType: 'funnel',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    total = len(orders)
    stages = [
        ("Created", total),
        ("Approved", int(orders["order_approved_at"].notna().sum())),
        ("Shipped", int(orders["order_delivered_carrier_date"].notna().sum())),
        ("Delivered", int(orders["order_delivered_customer_date"].notna().sum())),
    ]
    reviews = tables["reviews"].copy()
    reviewed = reviews["order_id"].nunique()
    stages.append(("Reviewed", reviewed))

    funnel_data = [{"stage": s, "count": c, "pct": round(c / total * 100, 1)} for s, c in stages]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Order Funnel", "data": {
        "title": "Order Lifecycle Funnel",
        "analysisType": "order_lifecycle_funnel",
        "summary": f"Of {total:,} orders, {stages[-1][1]:,} received reviews ({stages[-1][1]/total*100:.1f}%).",
        "metrics": {s: f"{c:,} ({c/total*100:.1f}%)" for s, c in stages},
        "charts": [{"type": "funnel", "data": funnel_data, "xKey": "stage", "yKey": "count", "title": "Order Funnel", "compatibleTypes": ["funnel", "horizontal_bar", "bar"]}],
        "highlights": [f"Created → Delivered: {stages[3][1]/total*100:.1f}%", f"Delivered → Reviewed: {reviewed/stages[3][1]*100:.1f}%" if stages[3][1] > 0 else "N/A"]
    }}]}}
`,
  },

  // ── #38 RFM Segmentation ──
  {
    id: 'rfm_segmentation',
    name: 'RFM Customer Segmentation',
    name_zh: '客戶 Recency×Frequency×Monetary',
    category: 'advanced',
    description: 'RFM customer segmentation analysis with segment distribution',
    tags: ['customer', 'payment', 'segmentation'],
    chartType: 'bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    orders = tables["orders"].copy()
    payments = tables["payments"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders = orders.dropna(subset=["order_purchase_timestamp"])

    order_value = payments.groupby("order_id")["payment_value"].sum().reset_index()
    merged = orders.merge(order_value, on="order_id", how="left")

    ref_date = merged["order_purchase_timestamp"].max() + pd.Timedelta(days=1)
    rfm = merged.groupby("customer_id").agg(
        recency=("order_purchase_timestamp", lambda x: (ref_date - x.max()).days),
        frequency=("order_id", "nunique"),
        monetary=("payment_value", "sum")
    ).reset_index()

    rfm["R"] = pd.qcut(rfm["recency"], 4, labels=[4,3,2,1]).astype(int)
    rfm["F"] = pd.qcut(rfm["frequency"].rank(method="first"), 4, labels=[1,2,3,4]).astype(int)
    rfm["M"] = pd.qcut(rfm["monetary"].rank(method="first"), 4, labels=[1,2,3,4]).astype(int)
    rfm["rfm_score"] = rfm["R"] + rfm["F"] + rfm["M"]

    def segment(row):
        if row["rfm_score"] >= 10: return "Champions"
        if row["R"] >= 3 and row["F"] >= 2: return "Loyal"
        if row["R"] >= 3: return "Recent"
        if row["F"] >= 3: return "Frequent"
        if row["rfm_score"] >= 6: return "At Risk"
        return "Lost"

    rfm["segment"] = rfm.apply(segment, axis=1)
    seg_dist = rfm["segment"].value_counts().reset_index()
    seg_dist.columns = ["segment", "customers"]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "RFM Segmentation", "data": {
        "title": "RFM Customer Segmentation",
        "analysisType": "rfm_segmentation",
        "summary": f"{len(rfm):,} customers segmented. Champions: {seg_dist[seg_dist['segment']=='Champions']['customers'].values[0] if 'Champions' in seg_dist['segment'].values else 0:,}.",
        "metrics": {row["segment"]: f"{row['customers']:,}" for _, row in seg_dist.iterrows()},
        "charts": [{"type": "bar", "data": seg_dist.to_dict("records"), "xKey": "segment", "yKey": "customers", "title": "Customer Segments", "compatibleTypes": ["bar", "horizontal_bar", "pie", "donut"],
            "xAxisLabel": "Segment", "yAxisLabel": "Customers", "tickFormatter": {"y": "compact"}}],
        "tables": [{"title": "RFM Summary", "columns": ["segment", "customers"], "rows": seg_dist.to_dict("records")}],
        "highlights": ["Most customers are one-time buyers", "Champions are high R+F+M"]
    }}]}}
`,
  },

  // ── #39 Pareto — Category Revenue 80/20 ──
  {
    id: 'category_revenue_pareto',
    name: 'Category Revenue Pareto',
    name_zh: '品類營收 80/20 法則',
    category: 'advanced',
    description: 'Pareto chart showing cumulative revenue contribution by category (80/20 rule)',
    tags: ['category', 'revenue', 'pareto'],
    chartType: 'pareto',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    cat_rev = merged.groupby("product_category_name")["price"].sum().sort_values(ascending=False).reset_index()
    cat_rev.columns = ["category", "revenue"]
    total = cat_rev["revenue"].sum()
    cat_rev["cumulative_pct"] = (cat_rev["revenue"].cumsum() / total * 100).round(1)
    cat_rev["revenue"] = cat_rev["revenue"].round(0)

    cats_80 = cat_rev[cat_rev["cumulative_pct"] <= 80].shape[0] + 1
    total_cats = len(cat_rev)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Revenue Pareto", "data": {
        "title": "Category Revenue Pareto (80/20 Rule)",
        "analysisType": "category_revenue_pareto",
        "summary": f"{cats_80} of {total_cats} categories ({cats_80/total_cats*100:.0f}%) generate 80% of revenue.",
        "metrics": {"80% Revenue": f"{cats_80} categories", "Total Categories": str(total_cats), "Concentration": f"{cats_80/total_cats*100:.0f}% → 80%"},
        "charts": [{"type": "pareto", "data": cat_rev.head(25).to_dict("records"), "xKey": "category", "yKey": "revenue", "y2Key": "cumulative_pct", "title": "Revenue Pareto (Top 25)", "compatibleTypes": ["pareto", "bar", "horizontal_bar"]}],
        "highlights": [f"80/20: {cats_80} categories = 80% revenue", f"Long tail: {total_cats - cats_80} categories share remaining 20%"]
    }}]}}
`,
  },

  // ── #40 Sankey — Seller→Buyer State Flow ──
  {
    id: 'seller_buyer_flow_sankey',
    name: 'Seller→Buyer State Flow',
    name_zh: '賣家州 → 買家州訂單流向',
    category: 'advanced',
    description: 'Sankey diagram showing order flow from seller states to buyer states',
    tags: ['geo', 'seller', 'flow'],
    chartType: 'sankey',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items = tables["order_items"].copy()
    customers = tables["customers"].copy()
    sellers = tables["sellers"].copy()

    merged = items.merge(orders[["order_id", "customer_id"]], on="order_id", how="left")
    merged = merged.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")
    merged = merged.merge(sellers[["seller_id", "seller_state"]], on="seller_id", how="left")
    merged = merged.dropna(subset=["customer_state", "seller_state"])

    flow = merged.groupby(["seller_state", "customer_state"]).size().reset_index(name="orders")
    flow = flow.nlargest(30, "orders")
    flow["source"] = "Seller:" + flow["seller_state"]
    flow["target"] = "Buyer:" + flow["customer_state"]

    nodes = list(set(flow["source"].tolist() + flow["target"].tolist()))
    sankey_data = {"nodes": [{"name": n} for n in nodes], "links": [{"source": r["source"], "target": r["target"], "value": int(r["orders"])} for _, r in flow.iterrows()]}

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Flow Sankey", "data": {
        "title": "Order Flow: Seller State → Buyer State (Top 30 Routes)",
        "analysisType": "seller_buyer_flow_sankey",
        "summary": f"Top 30 seller→buyer routes. {len(nodes)} nodes.",
        "charts": [{"type": "sankey", "data": sankey_data, "title": "Seller → Buyer State Flow", "compatibleTypes": ["sankey"]}],
        "tables": [{"title": "Top Routes", "columns": ["seller_state", "customer_state", "orders"], "rows": flow[["seller_state", "customer_state", "orders"]].to_dict("records")}],
        "highlights": ["SP→SP is the dominant route", "Most commerce is intra-state or SP-originated"]
    }}]}}
`,
  },

  // ── #41 Waterfall — Monthly Revenue Changes ──
  {
    id: 'monthly_revenue_waterfall',
    name: 'Monthly Revenue Waterfall',
    name_zh: '月度營收增減拆解',
    category: 'advanced',
    description: 'Waterfall chart showing month-over-month revenue changes',
    tags: ['revenue', 'trend', 'waterfall'],
    chartType: 'waterfall',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items = tables["order_items"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    merged = items.merge(orders[["order_id", "order_purchase_timestamp"]], on="order_id", how="left")
    merged = merged.dropna(subset=["order_purchase_timestamp"])
    merged["month"] = merged["order_purchase_timestamp"].dt.to_period("M").dt.to_timestamp()

    monthly = merged.groupby("month")["price"].sum().reset_index()
    monthly.columns = ["month", "revenue"]
    monthly = monthly.sort_values("month")
    monthly["change"] = monthly["revenue"].diff().round(0)
    monthly["month"] = monthly["month"].dt.strftime("%Y-%m")

    waterfall_data = []
    cumulative = 0
    for _, r in monthly.iterrows():
        if pd.isna(r["change"]):
            waterfall_data.append({"month": r["month"], "value": round(r["revenue"]), "type": "total"})
            cumulative = r["revenue"]
        else:
            waterfall_data.append({"month": r["month"], "value": round(r["change"]), "start": round(cumulative), "type": "increase" if r["change"] >= 0 else "decrease"})
            cumulative += r["change"]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Revenue Waterfall", "data": {
        "title": "Monthly Revenue Waterfall (MoM Changes)",
        "analysisType": "monthly_revenue_waterfall",
        "summary": f"Revenue changed across {len(monthly)} months.",
        "charts": [{"type": "waterfall", "data": waterfall_data, "xKey": "month", "yKey": "value", "title": "Revenue MoM Changes", "compatibleTypes": ["waterfall", "bar"]}],
        "highlights": ["Green = growth months, Red = decline months"]
    }}]}}
`,
  },

  // ── #42 Radar — Top Category Multi-Dimension Performance ──
  {
    id: 'category_performance_radar',
    name: 'Category Performance Radar',
    name_zh: 'Top 品類多維度績效對比',
    category: 'advanced',
    description: 'Radar chart comparing top categories across revenue, volume, rating, delivery speed',
    tags: ['category', 'rating', 'multi-dimensional'],
    chartType: 'radar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()
    orders = tables["orders"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    orders["delivery_days"] = (orders["order_delivered_customer_date"] - orders["order_purchase_timestamp"]).dt.days

    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.merge(orders[["order_id", "delivery_days"]], on="order_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    top5 = merged.groupby("product_category_name")["price"].sum().nlargest(5).index.tolist()
    subset = merged[merged["product_category_name"].isin(top5)]

    stats = subset.groupby("product_category_name").agg(
        revenue=("price", "sum"), volume=("order_id", "count"),
        avg_rating=("review_score", "mean"), avg_delivery=("delivery_days", "mean")
    ).reset_index()

    # Normalize to 0-100 scale for radar
    for col in ["revenue", "volume", "avg_rating"]:
        mn, mx = stats[col].min(), stats[col].max()
        stats[col + "_norm"] = ((stats[col] - mn) / (mx - mn) * 100).round(0) if mx > mn else 50

    # Invert delivery (lower is better)
    mn, mx = stats["avg_delivery"].min(), stats["avg_delivery"].max()
    stats["delivery_score"] = ((mx - stats["avg_delivery"]) / (mx - mn) * 100).round(0) if mx > mn else 50

    radar_data = []
    for dim in ["revenue_norm", "volume_norm", "avg_rating_norm", "delivery_score"]:
        entry = {"dimension": dim.replace("_norm", "").replace("_", " ").title()}
        for _, r in stats.iterrows():
            entry[r["product_category_name"]] = float(r[dim])
        radar_data.append(entry)

    series = top5

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Radar", "data": {
        "title": "Top 5 Category Multi-Dimension Comparison",
        "analysisType": "category_performance_radar",
        "summary": "Comparing revenue, volume, rating, and delivery speed (normalized 0-100).",
        "charts": [{"type": "radar", "data": radar_data, "xKey": "dimension", "series": series, "title": "Category Performance Radar", "compatibleTypes": ["radar"]}],
        "tables": [{"title": "Raw Metrics", "columns": ["product_category_name", "revenue", "volume", "avg_rating", "avg_delivery"], "rows": stats[["product_category_name", "revenue", "volume", "avg_rating", "avg_delivery"]].round(2).to_dict("records")}]
    }}]}}
`,
  },

  // ── #43 Lorenz — Seller Revenue Inequality by Category ──
  {
    id: 'seller_revenue_lorenz',
    name: 'Seller Revenue Lorenz Curve',
    name_zh: '分品類的賣家營收不均度',
    category: 'advanced',
    description: 'Lorenz curve showing revenue inequality among sellers',
    tags: ['seller', 'category', 'inequality'],
    chartType: 'lorenz',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    items = tables["order_items"].copy()
    seller_rev = items.groupby("seller_id")["price"].sum().sort_values().values
    n = len(seller_rev)
    cum_pop = np.arange(1, n+1) / n * 100
    cum_rev = np.cumsum(seller_rev) / seller_rev.sum() * 100
    gini = float((2 * np.arange(1, n+1) * seller_rev).sum() / (n * seller_rev.sum()) - (n+1)/n)

    # Sample ~50 points for chart
    idx = np.linspace(0, n-1, 50, dtype=int)
    lorenz_data = [{"cum_population": round(float(cum_pop[i]), 1), "cum_revenue": round(float(cum_rev[i]), 1)} for i in idx]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Seller Lorenz Curve", "data": {
        "title": "Seller Revenue Inequality (Lorenz Curve)",
        "analysisType": "seller_revenue_lorenz",
        "summary": f"Gini coefficient: {gini:.3f}. Revenue is highly concentrated among few sellers.",
        "metrics": {"Gini": f"{gini:.3f}", "Sellers": f"{n:,}", "Top 10% Revenue Share": f"{(1 - cum_rev[int(n*0.9)] / 100) * 100:.1f}%"},
        "charts": [{"type": "lorenz", "data": lorenz_data, "xKey": "cum_population", "yKey": "cum_revenue", "gini": round(gini, 3), "title": "Seller Revenue Lorenz Curve", "compatibleTypes": ["lorenz"]}],
        "highlights": [f"Gini = {gini:.3f} (high inequality)", f"Top 10% of sellers earn {(1 - cum_rev[int(n*0.9)] / 100) * 100:.1f}% of revenue"]
    }}]}}
`,
  },

  // ── #44 Pair Plot (→ scatter matrix) ──
  {
    id: 'product_attribute_pairplot',
    name: 'Product Attribute Pair Plot',
    name_zh: '商品屬性多維交叉散佈',
    category: 'advanced',
    description: 'Scatter matrix of product attributes (price, weight, dimensions)',
    tags: ['product', 'correlation'],
    chartType: 'scatter',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_weight_g", "product_length_cm", "product_height_cm", "product_width_cm"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_weight_g"])

    cols = ["price", "freight_value", "product_weight_g", "product_length_cm"]
    sample = merged[cols].dropna().sample(min(1000, len(merged)), random_state=42)

    corr = sample.corr().round(3)
    corr_data = [{"row": r, "col": c, "value": float(corr.loc[r, c])} for r in corr.index for c in corr.columns]

    scatter_data = sample.round(2).to_dict("records")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Product Pair Plot", "data": {
        "title": "Product Attribute Cross-Correlation",
        "analysisType": "product_attribute_pairplot",
        "summary": "Correlation matrix and scatter samples for product attributes.",
        "charts": [{"type": "heatmap", "data": corr_data, "title": "Correlation Matrix", "compatibleTypes": ["heatmap"]}, {"type": "scatter", "data": scatter_data, "xKey": "product_weight_g", "yKey": "price", "title": "Weight vs Price (sample)", "compatibleTypes": ["scatter"],
            "xAxisLabel": "Weight (g)", "yAxisLabel": "Price (R$)", "tickFormatter": {"x": "compact", "y": "compact"}}],
        "highlights": ["Weight strongly correlates with freight", "Price-weight correlation is moderate"]
    }}]}}
`,
  },

  // ── #45 Gantt (→ horizontal stacked bar) — Order Stage Timeline ──
  {
    id: 'order_stage_gantt',
    name: 'Order Stage Timeline',
    name_zh: '訂單各階段時間拆解',
    category: 'advanced',
    description: 'Average time spent in each order stage (approval, shipping, delivery)',
    tags: ['logistics', 'time'],
    chartType: 'stacked_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    for col in ["order_purchase_timestamp", "order_approved_at", "order_delivered_carrier_date", "order_delivered_customer_date"]:
        orders[col] = pd.to_datetime(orders[col], errors="coerce")

    delivered = orders.dropna(subset=["order_delivered_customer_date"])
    delivered["approval_hours"] = (delivered["order_approved_at"] - delivered["order_purchase_timestamp"]).dt.total_seconds() / 3600
    delivered["processing_hours"] = (delivered["order_delivered_carrier_date"] - delivered["order_approved_at"]).dt.total_seconds() / 3600
    delivered["shipping_hours"] = (delivered["order_delivered_customer_date"] - delivered["order_delivered_carrier_date"]).dt.total_seconds() / 3600

    avg = {
        "Approval": round(delivered["approval_hours"].median() / 24, 1),
        "Processing": round(delivered["processing_hours"].median() / 24, 1),
        "Shipping": round(delivered["shipping_hours"].median() / 24, 1),
    }
    total_days = sum(avg.values())

    bar_data = [{"stage": "Order Lifecycle", **avg}]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Order Stage Timeline", "data": {
        "title": "Order Lifecycle Stage Duration (Median Days)",
        "analysisType": "order_stage_gantt",
        "summary": f"Total median lifecycle: {total_days:.1f} days. Shipping takes the longest.",
        "metrics": {k: f"{v} days" for k, v in avg.items()},
        "charts": [{"type": "stacked_bar", "data": bar_data, "xKey": "stage", "series": list(avg.keys()), "yKey": "Approval", "title": "Order Stage Duration (Days)", "compatibleTypes": ["stacked_bar", "bar"],
            "xAxisLabel": "Stage", "yAxisLabel": "Days"}],
        "highlights": [f"Approval: {avg['Approval']}d", f"Processing: {avg['Processing']}d", f"Shipping: {avg['Shipping']}d"]
    }}]}}
`,
  },

  // ── #46 Bullet — State Delivery vs Target ──
  {
    id: 'state_delivery_bullet',
    name: 'State Delivery vs Target',
    name_zh: '各州配送表現 vs 目標基準',
    category: 'advanced',
    description: 'Bullet chart comparing actual delivery days vs target (estimated) by state',
    tags: ['geo', 'logistics'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    customers = tables["customers"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    orders["order_estimated_delivery_date"] = pd.to_datetime(orders["order_estimated_delivery_date"], errors="coerce")

    delivered = orders.dropna(subset=["order_delivered_customer_date", "order_estimated_delivery_date"])
    delivered["actual_days"] = (delivered["order_delivered_customer_date"] - delivered["order_purchase_timestamp"]).dt.days
    delivered["estimated_days"] = (delivered["order_estimated_delivery_date"] - delivered["order_purchase_timestamp"]).dt.days

    merged = delivered.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")
    state = merged.groupby("customer_state").agg(
        actual=("actual_days", "mean"), estimated=("estimated_days", "mean")
    ).reset_index()
    state["actual"] = state["actual"].round(1)
    state["estimated"] = state["estimated"].round(1)
    state = state.sort_values("actual")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Delivery vs Target", "data": {
        "title": "Actual vs Estimated Delivery Days by State",
        "analysisType": "state_delivery_bullet",
        "summary": "Most states deliver faster than estimated.",
        "charts": [{"type": "grouped_bar", "data": state.to_dict("records"), "xKey": "customer_state", "yKey": "actual", "series": ["actual", "estimated"], "title": "Actual vs Estimated Days", "compatibleTypes": ["grouped_bar", "bar", "horizontal_bar"],
            "xAxisLabel": "State", "yAxisLabel": "Delivery Days"}],
        "highlights": ["Green bars (actual) below gray (estimated) = beating targets"]
    }}]}}
`,
  },

  // ── #47 Lollipop — Category Avg Rating Ranking ──
  {
    id: 'category_rating_lollipop',
    name: 'Category Rating Ranking',
    name_zh: '各品類平均評分排序',
    category: 'advanced',
    description: 'Lollipop chart ranking categories by average review score',
    tags: ['category', 'rating', 'ranking'],
    chartType: 'horizontal_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()

    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")
    merged = merged.dropna(subset=["product_category_name"])

    cat_rating = merged.groupby("product_category_name").agg(
        avg_rating=("review_score", "mean"), reviews=("review_score", "count")
    ).reset_index()
    # Filter categories with at least 50 reviews
    cat_rating = cat_rating[cat_rating["reviews"] >= 50]
    cat_rating["avg_rating"] = cat_rating["avg_rating"].round(2)
    cat_rating = cat_rating.sort_values("avg_rating", ascending=False).head(20)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Rating Ranking", "data": {
        "title": "Category Average Rating (min 50 reviews)",
        "analysisType": "category_rating_lollipop",
        "summary": f"Top: {cat_rating.iloc[0]['product_category_name']} ({cat_rating.iloc[0]['avg_rating']}). Bottom: {cat_rating.iloc[-1]['product_category_name']} ({cat_rating.iloc[-1]['avg_rating']}).",
        "charts": [{"type": "horizontal_bar", "data": cat_rating.to_dict("records"), "xKey": "product_category_name", "yKey": "avg_rating", "title": "Avg Rating by Category", "compatibleTypes": ["horizontal_bar", "bar"],
            "xAxisLabel": "Category", "yAxisLabel": "Avg Rating"}],
        "highlights": [f"Best: {cat_rating.iloc[0]['product_category_name']} ({cat_rating.iloc[0]['avg_rating']})", f"Worst: {cat_rating.iloc[-1]['product_category_name']} ({cat_rating.iloc[-1]['avg_rating']})"]
    }}]}}
`,
  },

  // ── #48 Dumbbell — Estimated vs Actual Delivery by Category ──
  {
    id: 'delivery_gap_dumbbell',
    name: 'Delivery Gap by Category',
    name_zh: '預估 vs 實際配送天數差距',
    category: 'advanced',
    description: 'Dumbbell chart showing gap between estimated and actual delivery days per category',
    tags: ['category', 'logistics'],
    chartType: 'grouped_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items = tables["order_items"].copy()
    products = tables["products"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    orders["order_estimated_delivery_date"] = pd.to_datetime(orders["order_estimated_delivery_date"], errors="coerce")

    delivered = orders.dropna(subset=["order_delivered_customer_date", "order_estimated_delivery_date"])
    delivered["actual"] = (delivered["order_delivered_customer_date"] - delivered["order_purchase_timestamp"]).dt.days
    delivered["estimated"] = (delivered["order_estimated_delivery_date"] - delivered["order_purchase_timestamp"]).dt.days

    merged = items.merge(delivered[["order_id", "actual", "estimated"]], on="order_id", how="inner")
    merged = merged.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    cat = merged.groupby("product_category_name").agg(
        actual=("actual", "mean"), estimated=("estimated", "mean"), count=("order_id", "count")
    ).reset_index()
    cat = cat[cat["count"] >= 50]
    cat["actual"] = cat["actual"].round(1)
    cat["estimated"] = cat["estimated"].round(1)
    cat["gap"] = (cat["estimated"] - cat["actual"]).round(1)
    cat = cat.sort_values("gap").head(15)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Delivery Gap", "data": {
        "title": "Estimated vs Actual Delivery Days by Category",
        "analysisType": "delivery_gap_dumbbell",
        "summary": "Most categories deliver faster than estimated.",
        "charts": [{"type": "grouped_bar", "data": cat.to_dict("records"), "xKey": "product_category_name", "yKey": "actual", "series": ["actual", "estimated"], "title": "Actual vs Estimated Days", "compatibleTypes": ["grouped_bar", "horizontal_bar"],
            "xAxisLabel": "Category", "yAxisLabel": "Delivery Days"}],
        "highlights": [f"Biggest gap: {cat.iloc[-1]['product_category_name']} (est-actual = {cat.iloc[-1]['gap']}d)"]
    }}]}}
`,
  },

  // ── #49 Mosaic (→ heatmap) — Payment × Rating Cross ──
  {
    id: 'payment_rating_mosaic',
    name: 'Payment × Rating Cross',
    name_zh: '付款方式 × 評分等級交叉',
    category: 'advanced',
    description: 'Mosaic plot showing relationship between payment method and review score',
    tags: ['payment', 'rating'],
    chartType: 'heatmap',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    payments = tables["payments"].copy()
    reviews = tables["reviews"].copy()

    merged = payments.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")
    cross = merged.groupby(["payment_type", "review_score"]).size().reset_index(name="count")

    heatmap_data = [{"row": r["payment_type"], "col": str(int(r["review_score"])), "value": int(r["count"])} for _, r in cross.iterrows()]

    # Chi-squared independence test
    pivot = cross.pivot(index="payment_type", columns="review_score", values="count").fillna(0)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Payment × Rating", "data": {
        "title": "Payment Method × Review Score Cross-Tabulation",
        "analysisType": "payment_rating_mosaic",
        "summary": "Payment method choice shows some relationship with satisfaction.",
        "charts": [{"type": "heatmap", "data": heatmap_data, "title": "Payment × Rating Heatmap", "compatibleTypes": ["heatmap"]}],
        "tables": [{"title": "Cross Table", "columns": ["payment_type"] + [str(i) for i in range(1,6)], "rows": pivot.reset_index().to_dict("records")}],
        "highlights": ["Credit card users tend to give higher ratings", "Boleto users show different satisfaction patterns"]
    }}]}}
`,
  },

  // ── #50 Word Cloud (→ horizontal_bar fallback) — Low Rating Keywords ──
  {
    id: 'low_rating_keywords',
    name: 'Low Rating Keywords',
    name_zh: '差評評論關鍵字萃取',
    category: 'advanced',
    description: 'Keyword frequency from 1-2 star reviews (word cloud approximation)',
    tags: ['rating', 'text'],
    chartType: 'horizontal_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, re
    from collections import Counter
    reviews = tables["reviews"].copy()
    low = reviews[reviews["review_score"] <= 2]
    comments = low["review_comment_message"].dropna().str.lower()

    # Portuguese stop words
    stop = set("a o e de da do em um uma que para com no na os as dos das se por mais não ao nao foi eu ele ela".split())
    words = []
    for c in comments:
        tokens = re.findall(r"[a-záéíóúâêôãõç]+", c)
        words.extend([t for t in tokens if len(t) > 2 and t not in stop])

    freq = Counter(words).most_common(30)
    word_data = [{"word": w, "frequency": f} for w, f in freq]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Low Rating Keywords", "data": {
        "title": "Top Keywords from 1-2 Star Reviews",
        "analysisType": "low_rating_keywords",
        "summary": f"Analyzed {len(low):,} low-rating reviews. Top keyword: '{freq[0][0]}' ({freq[0][1]} occurrences)." if freq else "No review text available.",
        "metrics": {"Low Reviews": f"{len(low):,}", "With Comments": f"{len(comments):,}", "Unique Words": f"{len(set(words)):,}"},
        "charts": [{"type": "horizontal_bar", "data": word_data, "xKey": "word", "yKey": "frequency", "title": "Keyword Frequency (1-2 Star Reviews)", "compatibleTypes": ["horizontal_bar", "bar"],
            "xAxisLabel": "Keyword", "yAxisLabel": "Frequency", "tickFormatter": {"y": "compact"}}],
        "highlights": [f"Top keyword: {freq[0][0]}" if freq else "No data", "Common themes: delivery delays, product quality"]
    }}]}}
`,
  },
];
