/**
 * chartRecipes_generic.js — 8 schema-agnostic chart recipes
 *
 * Unlike domain-specific recipes that hardcode table/column names,
 * these recipes use dynamic column mapping from input_data.recipe_params.
 * The chartRecipeAdapter resolves actual column names before execution.
 *
 * Required recipe_params (injected by adapter or agent):
 *   - data_json: JSON string of the dataset rows
 *   - columns: { date?, numeric[], category?, id? }
 */

export const GENERIC_RECIPES = [
  // ── #G1 Correlation Matrix Heatmap ──
  {
    id: 'generic_correlation_matrix',
    name: 'Correlation Matrix',
    name_zh: '數值欄相關性矩陣',
    category: 'generic',
    description: 'Heatmap of Pearson correlations across all numeric columns in any dataset',
    tags: ['correlation', 'heatmap', 'generic', 'EDA'],
    chartType: 'heatmap',
    params: {
      max_columns: { type: 'number', default: 15, description: 'Max numeric columns to include' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json, numpy as np
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    max_cols = int(p.get("max_columns", 15))

    nums = df.select_dtypes(include="number").iloc[:, :max_cols]
    if nums.shape[1] < 2:
        return {"result": {"artifacts": [{"type": "analysis_result", "label": "Correlation Matrix", "data": {"title": "Correlation Matrix", "summary": "Need at least 2 numeric columns.", "metrics": {}, "charts": [], "highlights": []}}]}}

    corr = nums.corr().round(3)
    rows_out = []
    for c1 in corr.columns:
        for c2 in corr.columns:
            rows_out.append({"x": c1, "y": c2, "value": float(corr.loc[c1, c2])})

    strong = []
    for i, c1 in enumerate(corr.columns):
        for c2 in corr.columns[i+1:]:
            r = corr.loc[c1, c2]
            if abs(r) > 0.5:
                strong.append(f"{c1} ↔ {c2}: r={r:.3f}")

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Correlation Matrix", "data": {
        "title": "Correlation Matrix",
        "analysisType": "generic_correlation_matrix",
        "summary": f"Correlation matrix for {nums.shape[1]} numeric columns. {len(strong)} strong correlations found (|r|>0.5).",
        "metrics": {"Columns": str(nums.shape[1]), "Strong Correlations": str(len(strong))},
        "charts": [{"type": "heatmap", "data": rows_out, "xKey": "x", "yKey": "y", "valueKey": "value",
            "title": "Pearson Correlation Matrix", "compatibleTypes": ["heatmap"]}],
        "highlights": strong[:5] if strong else ["No strong correlations found (|r|>0.5)."]
    }}]}}
`,
  },

  // ── #G2 Distribution Grid ──
  {
    id: 'generic_distribution_grid',
    name: 'Distribution Overview',
    name_zh: '數值欄分布概覽',
    category: 'generic',
    description: 'Histograms and box-plot statistics for all numeric columns',
    tags: ['distribution', 'histogram', 'generic', 'EDA'],
    chartType: 'bar',
    params: {
      bins: { type: 'number', default: 20, description: 'Number of bins per histogram' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json, numpy as np
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    bins = int(p.get("bins", 20))

    nums = df.select_dtypes(include="number")
    if nums.empty:
        return {"result": {"artifacts": [{"type": "analysis_result", "label": "Distribution Overview", "data": {"title": "Distribution Overview", "summary": "No numeric columns found.", "metrics": {}, "charts": [], "highlights": []}}]}}

    charts = []
    highlights = []
    stats_rows = []
    for col in nums.columns[:12]:
        s = nums[col].dropna()
        if len(s) == 0: continue
        hist_vals, bin_edges = np.histogram(s, bins=min(bins, max(5, len(s)//5)))
        hist_data = [{"bin": f"{bin_edges[i]:.2g}~{bin_edges[i+1]:.2g}", "count": int(hist_vals[i])} for i in range(len(hist_vals))]
        charts.append({"type": "bar", "data": hist_data, "xKey": "bin", "yKey": "count", "title": f"{col} Distribution", "compatibleTypes": ["bar", "area"]})
        sk = float(s.skew()) if len(s) > 2 else 0
        if abs(sk) > 2:
            highlights.append(f"{col}: skewness={sk:.2f} ({'right' if sk>0 else 'left'}-skewed)")
        stats_rows.append({"column": col, "mean": f"{s.mean():.4g}", "median": f"{s.median():.4g}", "std": f"{s.std():.4g}", "min": f"{s.min():.4g}", "max": f"{s.max():.4g}", "nulls": str(int(nums[col].isna().sum()))})

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Distribution Overview", "data": {
        "title": "Distribution Overview",
        "analysisType": "generic_distribution_grid",
        "summary": f"Distribution analysis for {len(charts)} numeric columns across {len(df)} rows.",
        "metrics": {"Columns Analyzed": str(len(charts)), "Total Rows": str(len(df))},
        "charts": charts[:6],
        "tables": [{"title": "Column Statistics", "columns": ["column","mean","median","std","min","max","nulls"], "rows": stats_rows}],
        "highlights": highlights if highlights else ["All distributions appear roughly symmetric."]
    }}]}}
`,
  },

  // ── #G3 Time Series Multi-Line ──
  {
    id: 'generic_time_series_multi',
    name: 'Multi-Metric Time Series',
    name_zh: '多指標時序趨勢圖',
    category: 'generic',
    description: 'Line chart for multiple numeric columns over a date column',
    tags: ['time-series', 'trend', 'line', 'generic'],
    chartType: 'line',
    params: {
      date_col: { type: 'string', description: 'Date column name' },
      value_cols: { type: 'string', description: 'Comma-separated numeric column names' },
      period: { type: 'string', default: 'M', enum: ['D', 'W', 'M', 'Q'], description: 'Resample period' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    date_col = p.get("date_col", "")
    value_cols = [c.strip() for c in p.get("value_cols", "").split(",") if c.strip()]
    period = p.get("period", "M")

    if not date_col or date_col not in df.columns:
        date_candidates = [c for c in df.columns if df[c].dtype == 'object' and pd.to_datetime(df[c], errors='coerce').notna().mean() > 0.5]
        date_col = date_candidates[0] if date_candidates else df.columns[0]
    if not value_cols:
        value_cols = list(df.select_dtypes(include="number").columns[:5])
    if not value_cols:
        return {"result": {"artifacts": [{"type": "analysis_result", "label": "Time Series", "data": {"title": "Time Series", "summary": "No numeric columns found.", "metrics": {}, "charts": [], "highlights": []}}]}}

    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).set_index(date_col)
    grp = df[value_cols].resample(period).mean().reset_index()
    grp[date_col] = grp[date_col].dt.strftime("%Y-%m-%d")
    for c in value_cols:
        grp[c] = grp[c].round(2)

    chart_data = grp.to_dict("records")
    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Multi-Metric Time Series", "data": {
        "title": "Multi-Metric Time Series",
        "analysisType": "generic_time_series_multi",
        "summary": f"Time series for {', '.join(value_cols)} by {period} over {len(grp)} periods.",
        "metrics": {"Period": period, "Data Points": str(len(grp)), "Metrics": str(len(value_cols))},
        "charts": [{"type": "line", "data": chart_data, "xKey": date_col, "yKey": value_cols[0], "series": value_cols,
            "title": "Multi-Metric Trend", "compatibleTypes": ["line", "area", "bar"]}],
        "highlights": [f"Trend covers {len(grp)} {period}-periods"]
    }}]}}
`,
  },

  // ── #G4 Top/Bottom N Bar Chart ──
  {
    id: 'generic_top_n_bar',
    name: 'Top/Bottom N',
    name_zh: '任意指標 Top/Bottom N',
    category: 'generic',
    description: 'Horizontal bar chart showing top or bottom N items by any metric',
    tags: ['ranking', 'bar', 'top-n', 'generic'],
    chartType: 'bar',
    params: {
      category_col: { type: 'string', description: 'Category/label column' },
      value_col: { type: 'string', description: 'Numeric column to rank by' },
      n: { type: 'number', default: 10, description: 'Number of items' },
      direction: { type: 'string', default: 'top', enum: ['top', 'bottom'] },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    cat_col = p.get("category_col", "")
    val_col = p.get("value_col", "")
    n = int(p.get("n", 10))
    direction = p.get("direction", "top")

    if not cat_col: cat_col = next((c for c in df.columns if df[c].dtype == 'object'), df.columns[0])
    if not val_col: val_col = next((c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])), df.columns[-1])

    grp = df.groupby(cat_col)[val_col].sum().reset_index()
    grp = grp.sort_values(val_col, ascending=(direction == "bottom")).head(n)
    grp[val_col] = grp[val_col].round(2)

    label = f"{'Top' if direction=='top' else 'Bottom'} {n} by {val_col}"
    return {"result": {"artifacts": [{"type": "analysis_result", "label": label, "data": {
        "title": label,
        "analysisType": "generic_top_n_bar",
        "summary": f"{label} across {cat_col}.",
        "metrics": {f"{'Highest' if direction=='top' else 'Lowest'}": f"{grp[val_col].iloc[0]:,.2f}", "Items": str(len(grp))},
        "charts": [{"type": "bar", "data": grp.to_dict("records"), "xKey": cat_col, "yKey": val_col,
            "title": label, "compatibleTypes": ["bar", "pie", "treemap"]}],
        "highlights": [f"#1: {grp[cat_col].iloc[0]} = {grp[val_col].iloc[0]:,.2f}"]
    }}]}}
`,
  },

  // ── #G5 Group Comparison ──
  {
    id: 'generic_group_comparison',
    name: 'Group Comparison',
    name_zh: '分組比較柱狀圖',
    category: 'generic',
    description: 'Grouped bar chart comparing a metric across a categorical dimension',
    tags: ['comparison', 'grouped-bar', 'generic'],
    chartType: 'bar',
    params: {
      group_col: { type: 'string', description: 'Grouping column' },
      value_col: { type: 'string', description: 'Metric to compare' },
      agg: { type: 'string', default: 'mean', enum: ['mean', 'sum', 'median', 'count'] },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    group_col = p.get("group_col", "")
    value_col = p.get("value_col", "")
    agg = p.get("agg", "mean")

    if not group_col: group_col = next((c for c in df.columns if df[c].dtype == 'object'), df.columns[0])
    if not value_col: value_col = next((c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])), df.columns[-1])

    grp = df.groupby(group_col)[value_col].agg(agg).reset_index()
    grp.columns = [group_col, value_col]
    grp = grp.sort_values(value_col, ascending=False).round(2)

    return {"result": {"artifacts": [{"type": "analysis_result", "label": f"{value_col} by {group_col}", "data": {
        "title": f"{value_col} by {group_col} ({agg})",
        "analysisType": "generic_group_comparison",
        "summary": f"{agg.title()} of {value_col} across {len(grp)} groups.",
        "metrics": {"Groups": str(len(grp)), f"Max {agg}": f"{grp[value_col].max():,.2f}", f"Min {agg}": f"{grp[value_col].min():,.2f}"},
        "charts": [{"type": "bar", "data": grp.to_dict("records"), "xKey": group_col, "yKey": value_col,
            "title": f"{value_col} by {group_col}", "compatibleTypes": ["bar", "pie", "treemap", "line"]}],
        "highlights": [f"Highest: {grp.iloc[0][group_col]} ({grp.iloc[0][value_col]:,.2f})", f"Lowest: {grp.iloc[-1][group_col]} ({grp.iloc[-1][value_col]:,.2f})"]
    }}]}}
`,
  },

  // ── #G6 Scatter with Regression Line ──
  {
    id: 'generic_scatter_with_regression',
    name: 'Scatter + Trend Line',
    name_zh: '帶趨勢線散點圖',
    category: 'generic',
    description: 'Scatter plot with OLS regression line for any two numeric columns',
    tags: ['scatter', 'regression', 'correlation', 'generic'],
    chartType: 'scatter',
    params: {
      x_col: { type: 'string', description: 'X-axis numeric column' },
      y_col: { type: 'string', description: 'Y-axis numeric column' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json, numpy as np
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    x_col = p.get("x_col", "")
    y_col = p.get("y_col", "")

    nums = list(df.select_dtypes(include="number").columns)
    if not x_col and len(nums) >= 2: x_col = nums[0]
    if not y_col and len(nums) >= 2: y_col = nums[1]
    if not x_col or not y_col:
        return {"result": {"artifacts": [{"type": "analysis_result", "label": "Scatter Plot", "data": {"title": "Scatter Plot", "summary": "Need at least 2 numeric columns.", "metrics": {}, "charts": [], "highlights": []}}]}}

    clean = df[[x_col, y_col]].dropna().astype(float)
    if len(clean) < 3:
        return {"result": {"artifacts": [{"type": "analysis_result", "label": "Scatter Plot", "data": {"title": "Scatter Plot", "summary": "Too few data points.", "metrics": {}, "charts": [], "highlights": []}}]}}

    r = clean[x_col].corr(clean[y_col])
    slope, intercept = np.polyfit(clean[x_col], clean[y_col], 1)

    sample = clean.sample(min(500, len(clean)), random_state=42).round(4)
    chart_data = sample.to_dict("records")

    x_range = [float(clean[x_col].min()), float(clean[x_col].max())]
    trend_data = [{"x": x_range[0], "y": round(slope*x_range[0]+intercept, 4)}, {"x": x_range[1], "y": round(slope*x_range[1]+intercept, 4)}]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": f"{x_col} vs {y_col}", "data": {
        "title": f"{x_col} vs {y_col}",
        "analysisType": "generic_scatter_with_regression",
        "summary": f"Scatter plot of {x_col} vs {y_col} (n={len(clean)}). Pearson r = {r:.3f}. Trend: y = {slope:.4g}x + {intercept:.4g}.",
        "metrics": {"Pearson r": f"{r:.3f}", "Slope": f"{slope:.4g}", "Intercept": f"{intercept:.4g}", "N": str(len(clean))},
        "charts": [{"type": "scatter", "data": chart_data, "xKey": x_col, "yKey": y_col,
            "title": f"{x_col} vs {y_col} (r={r:.3f})", "compatibleTypes": ["scatter"],
            "referenceLines": [{"axis": "y", "value": float(clean[y_col].mean()), "label": f"Mean {y_col}", "color": "#94a3b8", "strokeDasharray": "6 4"}]}],
        "highlights": [f"Correlation: r={r:.3f} ({'strong' if abs(r)>0.7 else 'moderate' if abs(r)>0.4 else 'weak'})", f"Trend line: y = {slope:.4g}x + {intercept:.4g}"]
    }}]}}
`,
  },

  // ── #G7 Box Plot by Group ──
  {
    id: 'generic_box_plot_by_group',
    name: 'Box Plot by Group',
    name_zh: '分組箱線圖',
    category: 'generic',
    description: 'Box plots comparing a numeric metric across categorical groups',
    tags: ['box-plot', 'distribution', 'comparison', 'generic'],
    chartType: 'bar',
    params: {
      group_col: { type: 'string', description: 'Grouping column' },
      value_col: { type: 'string', description: 'Numeric column for box plots' },
    },
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json, numpy as np
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)
    group_col = p.get("group_col", "")
    value_col = p.get("value_col", "")

    if not group_col: group_col = next((c for c in df.columns if df[c].dtype == 'object'), df.columns[0])
    if not value_col: value_col = next((c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])), df.columns[-1])

    stats = []
    for name, g in df.groupby(group_col)[value_col]:
        s = g.dropna()
        if len(s) == 0: continue
        q1, med, q3 = float(s.quantile(0.25)), float(s.median()), float(s.quantile(0.75))
        iqr = q3 - q1
        stats.append({"group": str(name), "min": round(max(float(s.min()), q1-1.5*iqr), 2), "q1": round(q1, 2),
            "median": round(med, 2), "q3": round(q3, 2), "max": round(min(float(s.max()), q3+1.5*iqr), 2), "mean": round(float(s.mean()), 2), "n": len(s)})

    stats.sort(key=lambda x: -x["median"])

    return {"result": {"artifacts": [{"type": "analysis_result", "label": f"{value_col} by {group_col}", "data": {
        "title": f"{value_col} Distribution by {group_col}",
        "analysisType": "generic_box_plot_by_group",
        "summary": f"Box plot of {value_col} across {len(stats)} groups.",
        "metrics": {"Groups": str(len(stats)), "Highest Median": f"{stats[0]['group']}: {stats[0]['median']:,.2f}" if stats else "N/A"},
        "charts": [{"type": "bar", "data": stats, "xKey": "group", "yKey": "median", "series": ["min", "q1", "median", "q3", "max"],
            "title": f"{value_col} by {group_col}", "compatibleTypes": ["bar"]}],
        "tables": [{"title": "Box Plot Statistics", "columns": ["group", "min", "q1", "median", "q3", "max", "mean", "n"], "rows": stats}],
        "highlights": [f"Highest median: {stats[0]['group']} ({stats[0]['median']:,.2f})" if stats else "No data", f"Lowest median: {stats[-1]['group']} ({stats[-1]['median']:,.2f})" if stats else ""]
    }}]}}
`,
  },

  // ── #G8 Missing Data Heatmap ──
  {
    id: 'generic_missing_data_heatmap',
    name: 'Missing Data Heatmap',
    name_zh: '缺失值分布視覺化',
    category: 'generic',
    description: 'Visual map of missing/null patterns across all columns',
    tags: ['missing', 'data-quality', 'heatmap', 'generic', 'EDA'],
    chartType: 'bar',
    params: {},
    pythonCode: `
def run(input_data, prior_artifacts, tables):
    import pandas as pd, json
    p = input_data.get("recipe_params", {})
    data = json.loads(p.get("data_json", "[]"))
    df = pd.DataFrame(data)

    missing = df.isnull().sum().reset_index()
    missing.columns = ["column", "missing_count"]
    missing["total"] = len(df)
    missing["missing_pct"] = (missing["missing_count"] / len(df) * 100).round(1)
    missing["present_pct"] = (100 - missing["missing_pct"]).round(1)
    missing = missing.sort_values("missing_pct", ascending=False)

    total_cells = len(df) * len(df.columns)
    total_missing = int(df.isnull().sum().sum())
    completeness = round((1 - total_missing / total_cells) * 100, 1) if total_cells > 0 else 100

    problem_cols = missing[missing["missing_pct"] > 5]
    highlights = [f"{row['column']}: {row['missing_pct']}% missing" for _, row in problem_cols.head(5).iterrows()]
    if not highlights:
        highlights = ["Data quality is excellent — less than 5% missing in all columns."]

    return {"result": {"artifacts": [{"type": "analysis_result", "label": "Missing Data Analysis", "data": {
        "title": "Missing Data Analysis",
        "analysisType": "generic_missing_data_heatmap",
        "summary": f"Data completeness: {completeness}%. {len(problem_cols)} columns have >5% missing values.",
        "metrics": {"Completeness": f"{completeness}%", "Total Cells": f"{total_cells:,}", "Missing Cells": f"{total_missing:,}", "Problem Columns": str(len(problem_cols))},
        "charts": [{"type": "bar", "data": missing.to_dict("records"), "xKey": "column", "yKey": "missing_pct",
            "title": "Missing Value % by Column", "compatibleTypes": ["bar"],
            "yAxisLabel": "Missing %", "referenceLines": [{"axis": "y", "value": 5, "label": "5% threshold", "color": "#ef4444", "strokeDasharray": "6 4"}]}],
        "tables": [{"title": "Missing Value Summary", "columns": ["column", "missing_count", "total", "missing_pct", "present_pct"],
            "rows": missing.to_dict("records")}],
        "highlights": highlights
    }}]}}
`,
  },
];

export default GENERIC_RECIPES;
