/**
 * chartRecipes_geo.js — 5 geographic recipes (#27–#31)
 * Note: True map rendering deferred to v2. Charts render as bar/heatmap with table fallback.
 */

export const GEO_RECIPES = [
  // ── #27 Choropleth (→ horizontal_bar fallback) — State Order Volume ──
  {
    id: 'state_order_choropleth',
    name: 'State Order Volume',
    name_zh: '各州訂單量熱力分布',
    category: 'geo',
    description: 'Order volume distribution across Brazilian states',
    tags: ['geo', 'orders'],
    chartType: 'horizontal_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    customers = tables["customers"].copy()
    merged = orders.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")

    state_orders = merged.groupby("customer_state")["order_id"].count().reset_index()
    state_orders.columns = ["state", "orders"]
    state_orders = state_orders.sort_values("orders", ascending=False)
    total = state_orders["orders"].sum()
    state_orders["pct"] = (state_orders["orders"] / total * 100).round(1)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Order Volume", "data": {
        "title": "Order Volume by State",
        "analysisType": "state_order_choropleth",
        "summary": f"SP leads with {state_orders.iloc[0]['pct']}% of all orders. {len(state_orders)} states.",
        "metrics": {"Total Orders": f"{total:,}", "#1 State": state_orders.iloc[0]["state"], "#1 Share": f"{state_orders.iloc[0]['pct']}%"},
        "charts": [{"type": "horizontal_bar", "data": state_orders.head(15).to_dict("records"), "xKey": "state", "yKey": "orders", "title": "Orders by State (Top 15)", "compatibleTypes": ["horizontal_bar", "bar", "pie"],
            "xAxisLabel": "State", "yAxisLabel": "Orders", "tickFormatter": {"y": "compact"},
            "referenceLines": [{"axis": "y", "value": float(state_orders["orders"].mean()), "label": f"Avg {state_orders['orders'].mean():,.0f}", "color": "#94a3b8", "strokeDasharray": "6 4"}],
            "colorMap": {state_orders.iloc[0]["state"]: "#ef4444", state_orders.iloc[1]["state"]: "#f59e0b", state_orders.iloc[2]["state"]: "#f59e0b"}}],
        "tables": [{"title": "All States", "columns": ["state", "orders", "pct"], "rows": state_orders.to_dict("records")}],
        "highlights": [f"Top 3: {', '.join(state_orders.head(3)['state'].tolist())}", f"Top 5 states = {state_orders.head(5)['pct'].sum():.1f}%"]
    }}]}}
`,
  },

  // ── #28 Dot Map (→ grouped_bar fallback) — Seller vs Buyer Geo ──
  {
    id: 'seller_buyer_geo',
    name: 'Seller vs Buyer Geography',
    name_zh: '賣家 vs 買家地理分布對比',
    category: 'geo',
    description: 'Compare seller and buyer geographic distribution by state',
    tags: ['geo', 'seller'],
    chartType: 'grouped_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    customers = tables["customers"].copy()
    sellers = tables["sellers"].copy()

    buyer_states = customers.groupby("customer_state")["customer_id"].nunique().reset_index()
    buyer_states.columns = ["state", "buyers"]
    seller_states = sellers.groupby("seller_state")["seller_id"].nunique().reset_index()
    seller_states.columns = ["state", "sellers"]

    merged = buyer_states.merge(seller_states, on="state", how="outer").fillna(0)
    merged["sellers"] = merged["sellers"].astype(int)
    merged["buyers"] = merged["buyers"].astype(int)
    merged = merged.sort_values("buyers", ascending=False).head(15)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Seller vs Buyer Geo", "data": {
        "title": "Seller vs Buyer Distribution by State (Top 15)",
        "analysisType": "seller_buyer_geo",
        "summary": "Sellers are more concentrated geographically than buyers.",
        "charts": [{"type": "grouped_bar", "data": merged.to_dict("records"), "xKey": "state", "yKey": "buyers", "series": ["buyers", "sellers"], "title": "Buyers vs Sellers by State", "compatibleTypes": ["grouped_bar", "bar", "horizontal_bar"],
            "xAxisLabel": "State", "yAxisLabel": "Count", "tickFormatter": {"y": "compact"}}],
        "highlights": ["SP dominates both buyer and seller counts", "Some states have buyers but few sellers"]
    }}]}}
`,
  },

  // ── #29 Flow Map (→ heatmap fallback) — Delivery Routes ──
  {
    id: 'delivery_flow_routes',
    name: 'Delivery Route Heatmap',
    name_zh: '買賣家間配送距離熱門路線',
    category: 'geo',
    description: 'Heatmap showing popular delivery routes between seller and buyer states',
    tags: ['geo', 'logistics'],
    chartType: 'heatmap',
    requiresExtendedRenderer: true,
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

    top_states = merged["customer_state"].value_counts().nlargest(8).index.tolist()
    subset = merged[merged["customer_state"].isin(top_states) & merged["seller_state"].isin(top_states)]

    flow = subset.groupby(["seller_state", "customer_state"]).size().reset_index(name="orders")
    heatmap_data = [{"row": r["seller_state"], "col": r["customer_state"], "value": int(r["orders"])} for _, r in flow.iterrows()]

    intra_state = subset[subset["customer_state"] == subset["seller_state"]].shape[0]
    intra_pct = intra_state / len(subset) * 100 if len(subset) > 0 else 0

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Delivery Routes", "data": {
        "title": "Delivery Route Heatmap (Seller → Buyer State)",
        "analysisType": "delivery_flow_routes",
        "summary": f"{intra_pct:.1f}% of orders are intra-state. Top 8 states shown.",
        "metrics": {"Intra-State %": f"{intra_pct:.1f}%", "Routes Shown": str(len(flow))},
        "charts": [{"type": "heatmap", "data": heatmap_data, "title": "Order Flow: Seller State → Buyer State", "compatibleTypes": ["heatmap"]}],
        "highlights": [f"{intra_pct:.1f}% of deliveries are within the same state", "SP→SP is the dominant route"]
    }}]}}
`,
  },

  // ── #30 Choropleth (→ horizontal_bar fallback) — State Avg Rating ──
  {
    id: 'state_avg_rating',
    name: 'State Average Rating',
    name_zh: '各州平均評分地理差異',
    category: 'geo',
    description: 'Average review score by customer state',
    tags: ['geo', 'rating'],
    chartType: 'horizontal_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    reviews = tables["reviews"].copy()
    customers = tables["customers"].copy()

    merged = orders.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")

    state_rating = merged.groupby("customer_state").agg(
        avg_score=("review_score", "mean"),
        reviews=("review_score", "count")
    ).reset_index()
    state_rating["avg_score"] = state_rating["avg_score"].round(2)
    state_rating = state_rating.sort_values("avg_score", ascending=False)

    best = state_rating.iloc[0]
    worst = state_rating.iloc[-1]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Rating", "data": {
        "title": "Average Review Score by State",
        "analysisType": "state_avg_rating",
        "summary": f"Best: {best['customer_state']} ({best['avg_score']}), Worst: {worst['customer_state']} ({worst['avg_score']}).",
        "metrics": {"Best State": f"{best['customer_state']} ({best['avg_score']})", "Worst State": f"{worst['customer_state']} ({worst['avg_score']})", "Spread": f"{best['avg_score'] - worst['avg_score']:.2f}"},
        "charts": [{"type": "horizontal_bar", "data": state_rating.to_dict("records"), "xKey": "customer_state", "yKey": "avg_score", "title": "Avg Review Score by State", "compatibleTypes": ["horizontal_bar", "bar"],
            "xAxisLabel": "State", "yAxisLabel": "Avg Rating",
            "referenceLines": [{"axis": "y", "value": float(state_rating["avg_score"].mean()), "label": f"Avg {state_rating['avg_score'].mean():.2f}", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Best: {best['customer_state']} = {best['avg_score']}", f"Worst: {worst['customer_state']} = {worst['avg_score']}"]
    }}]}}
`,
  },

  // ── #31 Choropleth (→ horizontal_bar fallback) — State Avg Delivery Days ──
  {
    id: 'state_delivery_days',
    name: 'State Delivery Days',
    name_zh: '各州平均配送天數',
    category: 'geo',
    description: 'Average delivery days by customer state',
    tags: ['geo', 'logistics'],
    chartType: 'horizontal_bar',
    requiresExtendedRenderer: true,
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    customers = tables["customers"].copy()
    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    delivered = orders.dropna(subset=["order_delivered_customer_date", "order_purchase_timestamp"])
    delivered["delivery_days"] = (delivered["order_delivered_customer_date"] - delivered["order_purchase_timestamp"]).dt.days

    merged = delivered.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")

    state_del = merged.groupby("customer_state").agg(
        avg_days=("delivery_days", "mean"),
        orders=("order_id", "count")
    ).reset_index()
    state_del["avg_days"] = state_del["avg_days"].round(1)
    state_del = state_del.sort_values("avg_days")

    fastest = state_del.iloc[0]
    slowest = state_del.iloc[-1]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Delivery Days", "data": {
        "title": "Average Delivery Days by State",
        "analysisType": "state_delivery_days",
        "summary": f"Fastest: {fastest['customer_state']} ({fastest['avg_days']}d), Slowest: {slowest['customer_state']} ({slowest['avg_days']}d).",
        "metrics": {"Fastest": f"{fastest['customer_state']} ({fastest['avg_days']}d)", "Slowest": f"{slowest['customer_state']} ({slowest['avg_days']}d)", "Range": f"{slowest['avg_days'] - fastest['avg_days']:.1f} days"},
        "charts": [{"type": "horizontal_bar", "data": state_del.to_dict("records"), "xKey": "customer_state", "yKey": "avg_days", "title": "Avg Delivery Days by State", "compatibleTypes": ["horizontal_bar", "bar"],
            "xAxisLabel": "State", "yAxisLabel": "Avg Delivery Days",
            "referenceLines": [{"axis": "y", "value": float(state_del["avg_days"].mean()), "label": f"Avg {state_del['avg_days'].mean():.1f}d", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Fastest: {fastest['customer_state']} = {fastest['avg_days']}d", f"Slowest: {slowest['customer_state']} = {slowest['avg_days']}d"]
    }}]}}
`,
  },
];
