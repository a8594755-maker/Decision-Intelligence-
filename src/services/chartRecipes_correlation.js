/**
 * chartRecipes_correlation.js — 7 correlation & relationship recipes (#20–#26)
 */

export const CORRELATION_RECIPES = [
  // ── #20 Scatter — Price vs Rating ──
  {
    id: 'price_vs_rating_scatter',
    name: 'Price vs Rating',
    name_zh: '商品價格 vs 評分關係',
    category: 'correlation',
    description: 'Scatter plot exploring relationship between product price and review score',
    tags: ['price', 'rating', 'correlation'],
    chartType: 'scatter',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, numpy as np
    items = tables["order_items"].copy()
    reviews = tables["reviews"].copy()
    merged = items.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")
    # Sample for scatter readability
    sample = merged.sample(min(2000, len(merged)), random_state=42)

    corr = float(merged[["price", "review_score"]].corr().iloc[0, 1])
    avg_by_score = merged.groupby("review_score")["price"].mean().round(2)

    scatter_data = sample[["price", "review_score"]].round(2).to_dict("records")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Price vs Rating", "data": {
        "title": "Product Price vs Review Score",
        "analysisType": "price_vs_rating_scatter",
        "summary": f"Correlation: {corr:.3f}. Price has {'weak' if abs(corr) < 0.3 else 'moderate'} relationship with rating.",
        "metrics": {"Correlation": f"{corr:.3f}", "Avg Price (5-star)": f"R\${avg_by_score.get(5, 0):,.0f}", "Avg Price (1-star)": f"R\${avg_by_score.get(1, 0):,.0f}"},
        "charts": [{"type": "scatter", "data": scatter_data, "xKey": "price", "yKey": "review_score", "title": "Price vs Rating (n=2000 sample)", "compatibleTypes": ["scatter"],
            "xAxisLabel": "Price (R$)", "yAxisLabel": "Review Score", "tickFormatter": {"x": "compact"},
            "referenceLines": [
                {"axis": "x", "value": float(merged["price"].mean()), "label": f"Avg Price R\${merged['price'].mean():,.0f}", "color": "#94a3b8"},
                {"axis": "y", "value": float(merged["review_score"].mean()), "label": f"Avg Rating {merged['review_score'].mean():.1f}", "color": "#94a3b8"}]}],
        "highlights": [f"Correlation: {corr:.3f} ({'weak' if abs(corr) < 0.3 else 'moderate'})", "Higher-priced items don't necessarily get better ratings"]
    }}]}}
`,
  },

  // ── #21 Bubble — Category: Avg Price × Orders × Rating ──
  {
    id: 'category_bubble_chart',
    name: 'Category Bubble Chart',
    name_zh: '品類：均價 × 訂單量 × 評分',
    category: 'correlation',
    description: 'Bubble chart — X: avg price, Y: order count, bubble size: avg rating per category',
    tags: ['category', 'rating', 'correlation'],
    chartType: 'bubble',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()

    merged = items.merge(products[["product_id", "product_category_name"]], on="product_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="left")
    merged = merged.dropna(subset=["product_category_name"])

    cat_stats = merged.groupby("product_category_name").agg(
        avg_price=("price", "mean"),
        orders=("order_id", "nunique"),
        avg_rating=("review_score", "mean")
    ).reset_index()
    cat_stats = cat_stats.nlargest(20, "orders")
    cat_stats["avg_price"] = cat_stats["avg_price"].round(2)
    cat_stats["avg_rating"] = cat_stats["avg_rating"].round(2)
    cat_stats.rename(columns={"product_category_name": "category"}, inplace=True)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Category Bubble Chart", "data": {
        "title": "Category: Avg Price × Orders × Rating (Top 20)",
        "analysisType": "category_bubble_chart",
        "summary": "Bubble size represents average review rating.",
        "charts": [{"type": "bubble", "data": cat_stats.to_dict("records"), "xKey": "avg_price", "yKey": "orders", "zKey": "avg_rating", "labelKey": "category", "title": "Price × Volume × Rating", "compatibleTypes": ["bubble", "scatter"],
            "xAxisLabel": "Avg Price (R$)", "yAxisLabel": "Order Count", "tickFormatter": {"x": "compact", "y": "compact"}}],
        "tables": [{"title": "Category Metrics", "columns": ["category", "avg_price", "orders", "avg_rating"], "rows": cat_stats.to_dict("records")}]
    }}]}}
`,
  },

  // ── #22 Heatmap — Multi-Dimension Correlation Matrix ──
  {
    id: 'correlation_matrix_heatmap',
    name: 'Correlation Matrix',
    name_zh: '多維度相關性矩陣',
    category: 'correlation',
    description: 'Heatmap showing correlation between numeric dimensions (price, weight, freight, rating, delivery days)',
    tags: ['product', 'logistics', 'rating', 'correlation'],
    chartType: 'heatmap',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    orders = tables["orders"].copy()
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()

    orders["order_purchase_timestamp"] = pd.to_datetime(orders["order_purchase_timestamp"], errors="coerce")
    orders["order_delivered_customer_date"] = pd.to_datetime(orders["order_delivered_customer_date"], errors="coerce")
    orders["delivery_days"] = (orders["order_delivered_customer_date"] - orders["order_purchase_timestamp"]).dt.days

    merged = items.merge(orders[["order_id", "delivery_days"]], on="order_id", how="left")
    merged = merged.merge(products[["product_id", "product_weight_g", "product_length_cm", "product_height_cm", "product_width_cm"]], on="product_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="left")

    cols = ["price", "freight_value", "product_weight_g", "review_score", "delivery_days"]
    corr = merged[cols].corr().round(3)

    heatmap_data = []
    for r in corr.index:
        for c in corr.columns:
            heatmap_data.append({"row": r, "col": c, "value": float(corr.loc[r, c])})

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Correlation Matrix", "data": {
        "title": "Multi-Dimension Correlation Matrix",
        "analysisType": "correlation_matrix_heatmap",
        "summary": "Correlation between price, freight, weight, rating, and delivery days.",
        "charts": [{"type": "heatmap", "data": heatmap_data, "title": "Correlation Heatmap", "compatibleTypes": ["heatmap"]}],
        "highlights": ["Weight ↔ Freight: strongest positive correlation", "Delivery days ↔ Rating: negative correlation"]
    }}]}}
`,
  },

  // ── #23 Colored Scatter — Weight vs Freight by Category ──
  {
    id: 'weight_vs_freight_by_category',
    name: 'Weight vs Freight by Category',
    name_zh: '重量 vs 運費，依品類著色',
    category: 'correlation',
    description: 'Scatter plot of product weight vs freight colored by product category',
    tags: ['product', 'category', 'logistics', 'correlation'],
    chartType: 'scatter',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    merged = items.merge(products[["product_id", "product_category_name", "product_weight_g"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_weight_g", "freight_value", "product_category_name"])

    top5 = merged.groupby("product_category_name").size().nlargest(5).index.tolist()
    subset = merged[merged["product_category_name"].isin(top5)].sample(min(1500, len(merged)), random_state=42)

    scatter_data = subset[["product_weight_g", "freight_value", "product_category_name"]].rename(
        columns={"product_weight_g": "weight_g", "product_category_name": "category"}
    ).round(2).to_dict("records")

    corr = float(merged[["product_weight_g", "freight_value"]].corr().iloc[0, 1])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Weight vs Freight", "data": {
        "title": "Product Weight vs Freight (Top 5 Categories)",
        "analysisType": "weight_vs_freight_by_category",
        "summary": f"Weight-freight correlation: {corr:.3f}. Colored by category.",
        "metrics": {"Correlation": f"{corr:.3f}", "Categories Shown": "5", "Sample Size": str(len(scatter_data))},
        "charts": [{"type": "scatter", "data": scatter_data, "xKey": "weight_g", "yKey": "freight_value", "title": "Weight vs Freight by Category", "compatibleTypes": ["scatter"],
            "xAxisLabel": "Weight (g)", "yAxisLabel": "Freight (R$)", "tickFormatter": {"x": "compact", "y": "compact"},
            "referenceLines": [
                {"axis": "x", "value": float(merged["product_weight_g"].mean()), "label": f"Avg {merged['product_weight_g'].mean():,.0f}g", "color": "#94a3b8"},
                {"axis": "y", "value": float(merged["freight_value"].mean()), "label": f"Avg R\${merged['freight_value'].mean():,.0f}", "color": "#94a3b8"}]}],
        "highlights": [f"Strong correlation ({corr:.3f}) between weight and freight"]
    }}]}}
`,
  },

  // ── #24 Scatter — Photo Count vs Rating ──
  {
    id: 'photos_vs_rating',
    name: 'Photo Count vs Rating',
    name_zh: '照片數量 vs 評分',
    category: 'correlation',
    description: 'Scatter plot showing relationship between product photo count and review score',
    tags: ['product', 'rating', 'correlation'],
    chartType: 'scatter',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()
    reviews = tables["reviews"].copy()

    merged = items.merge(products[["product_id", "product_photos_qty"]], on="product_id", how="left")
    merged = merged.merge(reviews[["order_id", "review_score"]], on="order_id", how="inner")
    merged = merged.dropna(subset=["product_photos_qty"])

    agg = merged.groupby("product_photos_qty").agg(
        avg_rating=("review_score", "mean"),
        count=("order_id", "count")
    ).reset_index()
    agg["avg_rating"] = agg["avg_rating"].round(2)

    corr = float(merged[["product_photos_qty", "review_score"]].corr().iloc[0, 1])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Photos vs Rating", "data": {
        "title": "Product Photo Count vs Avg Rating",
        "analysisType": "photos_vs_rating",
        "summary": f"Correlation: {corr:.3f}. More photos {'slightly improve' if corr > 0 else 'do not improve'} ratings.",
        "metrics": {"Correlation": f"{corr:.3f}", "Max Photos": str(int(agg['product_photos_qty'].max()))},
        "charts": [{"type": "scatter", "data": agg.to_dict("records"), "xKey": "product_photos_qty", "yKey": "avg_rating", "title": "Photos vs Avg Rating", "compatibleTypes": ["scatter", "line", "bar"],
            "xAxisLabel": "Photo Count", "yAxisLabel": "Avg Rating",
            "referenceLines": [{"axis": "y", "value": float(merged["review_score"].mean()), "label": f"Avg Rating {merged['review_score'].mean():.2f}", "color": "#94a3b8"}]}],
        "highlights": [f"Correlation: {corr:.3f}", f"Most products have 1-3 photos"]
    }}]}}
`,
  },

  // ── #25 Scatter — Description Length vs Sales ──
  {
    id: 'description_vs_sales',
    name: 'Description Length vs Sales',
    name_zh: '描述長度 vs 銷量',
    category: 'correlation',
    description: 'Scatter plot exploring if longer product descriptions lead to more sales',
    tags: ['product', 'correlation'],
    chartType: 'scatter',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    items = tables["order_items"].copy()
    products = tables["products"].copy()

    sales = items.groupby("product_id").size().reset_index(name="sales")
    merged = sales.merge(products[["product_id", "product_description_lenght"]], on="product_id", how="left")
    merged = merged.dropna(subset=["product_description_lenght"])
    merged["desc_length"] = merged["product_description_lenght"].astype(int)

    sample = merged.sample(min(2000, len(merged)), random_state=42)
    corr = float(merged[["desc_length", "sales"]].corr().iloc[0, 1])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Description vs Sales", "data": {
        "title": "Product Description Length vs Sales Volume",
        "analysisType": "description_vs_sales",
        "summary": f"Correlation: {corr:.3f}. Description length has {'weak' if abs(corr) < 0.3 else 'moderate'} effect on sales.",
        "metrics": {"Correlation": f"{corr:.3f}", "Avg Desc Length": f"{merged['desc_length'].mean():,.0f} chars", "Median Sales": str(int(merged['sales'].median()))},
        "charts": [{"type": "scatter", "data": sample[["desc_length", "sales"]].to_dict("records"), "xKey": "desc_length", "yKey": "sales", "title": "Description Length vs Sales", "compatibleTypes": ["scatter"],
            "xAxisLabel": "Description Length (chars)", "yAxisLabel": "Sales Volume", "tickFormatter": {"x": "compact"},
            "referenceLines": [
                {"axis": "x", "value": float(merged["desc_length"].mean()), "label": f"Avg {merged['desc_length'].mean():,.0f} chars", "color": "#94a3b8"},
                {"axis": "y", "value": float(merged["sales"].mean()), "label": f"Avg {merged['sales'].mean():.0f} sales", "color": "#94a3b8"}]}],
        "highlights": [f"Correlation: {corr:.3f}", "Optimal description length may plateau"]
    }}]}}
`,
  },

  // ── #26 Scatter — Installments vs Order Value ──
  {
    id: 'installments_vs_order_value',
    name: 'Installments vs Order Value',
    name_zh: '分期期數 vs 訂單金額',
    category: 'correlation',
    description: 'Scatter plot showing relationship between installment count and order value',
    tags: ['payment', 'correlation'],
    chartType: 'scatter',
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd
    payments = tables["payments"].copy()
    cc = payments[payments["payment_type"] == "credit_card"].copy()

    agg = cc.groupby("payment_installments").agg(
        avg_value=("payment_value", "mean"),
        median_value=("payment_value", "median"),
        count=("order_id", "count")
    ).reset_index()
    agg["avg_value"] = agg["avg_value"].round(2)
    agg["median_value"] = agg["median_value"].round(2)

    corr = float(cc[["payment_installments", "payment_value"]].corr().iloc[0, 1])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Installments vs Value", "data": {
        "title": "Installment Count vs Order Value",
        "analysisType": "installments_vs_order_value",
        "summary": f"Correlation: {corr:.3f}. Higher-value orders use more installments.",
        "metrics": {"Correlation": f"{corr:.3f}", "Max Installments": str(int(agg['payment_installments'].max())), "Avg Value (1x)": f"R\${agg[agg['payment_installments']==1]['avg_value'].values[0]:,.0f}" if len(agg[agg['payment_installments']==1]) > 0 else "N/A"},
        "charts": [{"type": "scatter", "data": agg.to_dict("records"), "xKey": "payment_installments", "yKey": "avg_value", "title": "Installments vs Avg Order Value", "compatibleTypes": ["scatter", "bar", "line"],
            "xAxisLabel": "Installments", "yAxisLabel": "Avg Order Value (R$)", "tickFormatter": {"y": "currency"},
            "referenceLines": [{"axis": "y", "value": float(cc["payment_value"].mean()), "label": f"Avg R\${cc['payment_value'].mean():,.0f}", "color": "#94a3b8"}]}],
        "highlights": [f"Positive correlation ({corr:.3f})", "More installments = higher order value"]
    }}]}}
`,
  },
];
