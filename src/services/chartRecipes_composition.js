/**
 * chartRecipes_composition.js — 5 composition & proportion recipes (#15–#19)
 */

export const COMPOSITION_RECIPES = [
  // ── #15 Donut — Payment Method Share ──
  {
    id: 'payment_method_donut',
    name: 'Payment Method Share',
    name_zh: '付款方式佔比（信用卡/boleto等）',
    category: 'composition',
    description: 'Donut chart showing payment method market share',
    tags: ['payment', 'composition'],
    chartType: 'donut',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    payments = tables["payments"].copy()
    share = payments.groupby("payment_type")["order_id"].nunique().reset_index()
    share.columns = ["payment_type", "orders"]
    total = share["orders"].sum()
    share["pct"] = (share["orders"] / total * 100).round(1)
    share = share.sort_values("orders", ascending=False)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Payment Method Share", "data": {
        "title": "Payment Method Distribution",
        "analysisType": "payment_method_donut",
        "summary": f"Credit card dominates with {share.iloc[0]['pct']}% of orders.",
        "metrics": {row["payment_type"]: f"{row['pct']}%" for _, row in share.iterrows()},
        "charts": [{"type": "donut", "data": share.to_dict("records"), "xKey": "payment_type", "yKey": "orders", "title": "Payment Method Share", "compatibleTypes": ["donut", "pie", "bar", "horizontal_bar"]}],
        "highlights": [f"#1 {share.iloc[0]['payment_type']}: {share.iloc[0]['pct']}%", f"{len(share)} payment methods total"]
    }}]}}
`,
  },

  // ── #16 Treemap — Category Revenue (Area = Revenue) ──
  {
    id: 'category_revenue_treemap',
    name: 'Category Revenue Treemap',
    name_zh: '品類營收佔比（面積=營收）',
    category: 'composition',
    description: 'Treemap showing category revenue proportions',
    tags: ['category', 'revenue', 'composition'],
    chartType: 'treemap',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    cat_rev = merged.groupby("product_category_name")["price"].sum().nlargest(20).reset_index()
    cat_rev.columns = ["name", "value"]
    cat_rev["value"] = cat_rev["value"].round(0)
    total = cat_rev["value"].sum()

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Revenue Treemap", "data": {
        "title": "Category Revenue Treemap (Top 20)",
        "analysisType": "category_revenue_treemap",
        "summary": f"Top 20 categories represent R\${total:,.0f} in revenue.",
        "charts": [{"type": "treemap", "data": cat_rev.to_dict("records"), "xKey": "name", "yKey": "value", "title": "Revenue by Category", "compatibleTypes": ["treemap", "horizontal_bar", "pie"]}],
        "highlights": [f"#1 {cat_rev.iloc[0]['name']}: R\${cat_rev.iloc[0]['value']:,.0f}"]
    }}]}}
`,
  },

  // ── #17 100% Stacked Bar — State Payment Preference ──
  {
    id: 'state_payment_preference',
    name: 'State Payment Preference',
    name_zh: '各州付款方式偏好差異',
    category: 'composition',
    description: 'Percent stacked bar showing payment method preferences by state',
    tags: ['geo', 'payment', 'composition'],
    chartType: 'stacked_bar',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    payments = tables["payments"].copy()
    orders = tables["orders"].copy()
    customers = tables["customers"].copy()

    merged = payments.merge(orders[["order_id", "customer_id"]], on="order_id", how="left")
    merged = merged.merge(customers[["customer_id", "customer_state"]], on="customer_id", how="left")
    merged = merged.dropna(subset=["customer_state"])

    top_states = merged.groupby("customer_state")["order_id"].count().nlargest(10).index.tolist()
    subset = merged[merged["customer_state"].isin(top_states)]

    pivot = subset.groupby(["customer_state", "payment_type"]).size().unstack(fill_value=0)
    pivot_pct = pivot.div(pivot.sum(axis=1), axis=0).multiply(100).round(1).reset_index()
    pivot_pct.columns = ["state"] + [str(c) for c in pivot_pct.columns[1:]]
    series = [c for c in pivot_pct.columns if c != "state"]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "State Payment Preferences", "data": {
        "title": "Payment Method Preferences by State (Top 10)",
        "analysisType": "state_payment_preference",
        "summary": "Payment method mix varies by geography.",
        "charts": [{"type": "stacked_bar", "data": pivot_pct.to_dict("records"), "xKey": "state", "yKey": series[0], "series": series, "title": "Payment Method % by State", "compatibleTypes": ["stacked_bar", "grouped_bar"],
            "xAxisLabel": "State", "yAxisLabel": "Payment Share (%)", "tickFormatter": {"y": "percent"}}],
        "highlights": ["Credit card usage varies by state", "Boleto more popular in certain regions"]
    }}]}}
`,
  },

  // ── #18 Pie — Order Status Distribution ──
  {
    id: 'order_status_pie',
    name: 'Order Status Distribution',
    name_zh: '訂單狀態分布',
    category: 'composition',
    description: 'Pie chart showing distribution of order statuses',
    tags: ['logistics', 'composition'],
    chartType: 'pie',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    status_counts = orders["order_status"].value_counts().reset_index()
    status_counts.columns = ["status", "count"]
    total = status_counts["count"].sum()
    status_counts["pct"] = (status_counts["count"] / total * 100).round(1)

    delivered_pct = status_counts[status_counts["status"] == "delivered"]["pct"].values
    delivered_pct = delivered_pct[0] if len(delivered_pct) > 0 else 0

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Order Status", "data": {
        "title": "Order Status Distribution",
        "analysisType": "order_status_pie",
        "summary": f"{delivered_pct:.1f}% of orders delivered. {len(status_counts)} status types.",
        "metrics": {row["status"]: f"{row['pct']}%" for _, row in status_counts.iterrows()},
        "charts": [{"type": "pie", "data": status_counts.to_dict("records"), "xKey": "status", "yKey": "count", "title": "Order Status", "compatibleTypes": ["pie", "donut", "bar", "horizontal_bar"]}],
        "highlights": [f"Delivered: {delivered_pct:.1f}%", f"{len(status_counts)} distinct statuses"]
    }}]}}
`,
  },

  // ── #19 Donut — Credit Card Installment Distribution ──
  {
    id: 'installment_distribution',
    name: 'Credit Card Installments',
    name_zh: '信用卡分期期數分布（1期/3期/6期...）',
    category: 'composition',
    description: 'Donut chart showing credit card installment plan distribution',
    tags: ['payment', 'composition'],
    chartType: 'donut',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    payments = tables["payments"].copy()
    cc = payments[payments["payment_type"] == "credit_card"].copy()
    inst = cc.groupby("payment_installments")["order_id"].nunique().reset_index()
    inst.columns = ["installments", "orders"]
    inst = inst.sort_values("installments")
    total = inst["orders"].sum()
    inst["pct"] = (inst["orders"] / total * 100).round(1)
    inst["installments"] = inst["installments"].astype(str) + "x"

    one_time = inst[inst["installments"] == "1x"]["pct"].values
    one_time_pct = one_time[0] if len(one_time) > 0 else 0

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Installment Distribution", "data": {
        "title": "Credit Card Installment Distribution",
        "analysisType": "installment_distribution",
        "summary": f"{one_time_pct:.1f}% pay in full (1x). {len(inst)} different installment plans.",
        "metrics": {"Total CC Orders": f"{total:,}", "1x (Full)": f"{one_time_pct:.1f}%", "Plans Available": str(len(inst))},
        "charts": [{"type": "donut", "data": inst.to_dict("records"), "xKey": "installments", "yKey": "orders", "title": "Installment Plans", "compatibleTypes": ["donut", "pie", "bar"]}],
        "highlights": [f"{one_time_pct:.1f}% pay in full", f"{len(inst)} installment options"]
    }}]}}
`,
  },
];
