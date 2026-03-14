"""
report_generator_pdf.py
FastAPI router: POST /generate-report

Generates PDF dashboards using matplotlib + fpdf2.
Receives KPIs, analysis data, and insights from prior steps,
produces a one-page (or multi-page) PDF dashboard.

Output:
- pdf_base64: base64-encoded PDF
- html_preview: simple HTML preview of the dashboard
- artifacts: chart images and report metadata
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger("report_generator_pdf")

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
report_generator_router = APIRouter()

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ReportRequest(BaseModel):
    artifacts: Dict[str, Any] = Field(default_factory=dict, description="Prior step artifacts keyed by step name")
    report_format: str = Field(default="pdf", description="pdf or html")
    task_title: str = Field(default="Business Report", description="Report title")
    insights: Optional[List[str]] = None
    kpis: Optional[Dict[str, Any]] = None
    # Optional: LLM-generated narrative
    narrative: Optional[str] = None


class ReportArtifact(BaseModel):
    type: str
    label: str
    data: Any


class ReportResponse(BaseModel):
    ok: bool
    pdf_base64: Optional[str] = None
    html_preview: Optional[str] = None
    artifacts: List[ReportArtifact] = []
    error: Optional[str] = None
    execution_ms: int = 0


# ---------------------------------------------------------------------------
# Chart generation helpers
# ---------------------------------------------------------------------------

def _extract_kpis_from_artifacts(artifacts: dict) -> dict:
    """Try to find KPI data from prior step artifacts."""
    kpis = {}
    for step_name, step_data in artifacts.items():
        if isinstance(step_data, list):
            for item in step_data:
                if isinstance(item, dict):
                    # Look for KPI-like artifacts
                    if item.get("type") in ("kpi_summary", "kpi", "metrics", "summary"):
                        data = item.get("data", {})
                        if isinstance(data, dict):
                            kpis.update(data)
                        elif isinstance(data, list) and len(data) > 0:
                            for row in data:
                                if isinstance(row, dict) and "metric" in row and "value" in row:
                                    kpis[row["metric"]] = row["value"]
        elif isinstance(step_data, dict):
            if "data" in step_data:
                data = step_data["data"]
                if isinstance(data, dict):
                    kpis.update(data)
    return kpis


def _extract_table_data(artifacts: dict) -> list:
    """Extract tabular data from artifacts for chart generation."""
    tables = []
    for step_name, step_data in artifacts.items():
        if isinstance(step_data, list):
            for item in step_data:
                if isinstance(item, dict) and isinstance(item.get("data"), list):
                    tables.append({
                        "label": item.get("label", step_name),
                        "type": item.get("type", "data"),
                        "data": item["data"],
                        "step": step_name,
                    })
        elif isinstance(step_data, dict) and isinstance(step_data.get("data"), list):
            tables.append({
                "label": step_data.get("label", step_name),
                "type": step_data.get("type", "data"),
                "data": step_data["data"],
                "step": step_name,
            })
    return tables


def _generate_charts(tables: list, kpis: dict) -> list:
    """Generate matplotlib chart images as base64 PNGs."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.ticker as ticker
    except ImportError:
        logger.warning("matplotlib not available, skipping chart generation")
        return []

    charts = []
    plt.style.use("seaborn-v0_8-whitegrid")

    # KPI bar chart
    if kpis and len(kpis) >= 2:
        try:
            fig, ax = plt.subplots(figsize=(10, 4))
            numeric_kpis = {}
            for k, v in kpis.items():
                try:
                    numeric_kpis[k] = float(v)
                except (ValueError, TypeError):
                    continue
            if numeric_kpis:
                keys = list(numeric_kpis.keys())[:12]
                values = [numeric_kpis[k] for k in keys]
                colors = plt.cm.Blues([(i + 3) / (len(keys) + 4) for i in range(len(keys))])
                ax.barh(keys, values, color=colors)
                ax.set_title("Key Performance Indicators", fontsize=14, fontweight="bold")
                ax.tick_params(axis="y", labelsize=9)
                plt.tight_layout()

                buf = io.BytesIO()
                fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
                buf.seek(0)
                charts.append({
                    "label": "KPI Overview",
                    "image_base64": base64.b64encode(buf.read()).decode(),
                })
            plt.close(fig)
        except Exception as e:
            logger.warning(f"KPI chart failed: {e}")

    # Table-based charts (first 3 tables with numeric data)
    chart_count = 0
    for table in tables[:3]:
        if chart_count >= 3:
            break
        rows = table["data"]
        if not rows or not isinstance(rows[0], dict):
            continue

        try:
            import pandas as pd
            df = pd.DataFrame(rows)

            # Find numeric and categorical columns
            numeric_cols = df.select_dtypes(include=["number"]).columns.tolist()[:3]
            non_numeric_cols = [c for c in df.columns if c not in numeric_cols]

            if not numeric_cols:
                continue

            # Pick best x-axis
            x_col = None
            for candidate in non_numeric_cols:
                if df[candidate].nunique() <= 30:
                    x_col = candidate
                    break

            if not x_col and len(df) <= 30:
                x_col = df.index

            if x_col is None:
                continue

            fig, ax = plt.subplots(figsize=(10, 5))

            if len(numeric_cols) == 1:
                if isinstance(x_col, str):
                    ax.bar(df[x_col].astype(str), df[numeric_cols[0]], color="#2E75B6")
                else:
                    ax.bar(range(len(df)), df[numeric_cols[0]], color="#2E75B6")
                ax.set_ylabel(numeric_cols[0])
            else:
                for i, col in enumerate(numeric_cols[:3]):
                    if isinstance(x_col, str):
                        ax.plot(df[x_col].astype(str), df[col], marker="o", label=col, linewidth=2)
                    else:
                        ax.plot(range(len(df)), df[col], marker="o", label=col, linewidth=2)
                ax.legend()

            ax.set_title(table["label"], fontsize=13, fontweight="bold")
            plt.xticks(rotation=45, ha="right")
            plt.tight_layout()

            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
            buf.seek(0)
            charts.append({
                "label": table["label"],
                "image_base64": base64.b64encode(buf.read()).decode(),
            })
            plt.close(fig)
            chart_count += 1

        except Exception as e:
            logger.warning(f"Chart generation failed for {table['label']}: {e}")
            continue

    return charts


# ---------------------------------------------------------------------------
# PDF generation
# ---------------------------------------------------------------------------

def _generate_pdf(title: str, kpis: dict, charts: list, insights: list, narrative: str = None) -> bytes:
    """Generate a PDF dashboard using fpdf2."""
    try:
        from fpdf import FPDF
    except ImportError:
        raise ImportError("fpdf2 is required. Install with: pip install fpdf2")

    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # Title
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(31, 78, 121)  # Dark blue
    pdf.cell(0, 12, title, ln=True, align="C")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 6, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}", ln=True, align="C")
    pdf.ln(4)

    # KPI cards row
    if kpis:
        pdf.set_font("Helvetica", "B", 12)
        pdf.set_text_color(31, 78, 121)
        pdf.cell(0, 8, "Key Performance Indicators", ln=True)
        pdf.ln(2)

        numeric_kpis = {}
        for k, v in list(kpis.items())[:8]:
            try:
                numeric_kpis[k] = float(v)
            except (ValueError, TypeError):
                numeric_kpis[k] = v

        # Draw KPI cards in a row
        card_width = min(60, (pdf.w - 30) / min(len(numeric_kpis), 4))
        x_start = 15
        for i, (key, value) in enumerate(numeric_kpis.items()):
            if i > 0 and i % 4 == 0:
                pdf.ln(22)
                x_start = 15

            x = x_start + (i % 4) * (card_width + 5)
            y = pdf.get_y()

            # Card background
            pdf.set_fill_color(242, 247, 251)
            pdf.rect(x, y, card_width, 18, "F")

            # Value
            pdf.set_xy(x + 2, y + 2)
            pdf.set_font("Helvetica", "B", 14)
            pdf.set_text_color(31, 78, 121)
            if isinstance(value, float):
                display_val = f"{value:,.2f}" if value > 100 else f"{value:.2f}"
            else:
                display_val = str(value)[:15]
            pdf.cell(card_width - 4, 8, display_val, align="C")

            # Label
            pdf.set_xy(x + 2, y + 10)
            pdf.set_font("Helvetica", "", 7)
            pdf.set_text_color(100, 100, 100)
            label = key[:20]
            pdf.cell(card_width - 4, 6, label, align="C")

        pdf.ln(24)

    # Charts
    if charts:
        for chart in charts:
            if pdf.get_y() > 140:
                pdf.add_page()

            pdf.set_font("Helvetica", "B", 11)
            pdf.set_text_color(31, 78, 121)
            pdf.cell(0, 8, chart["label"], ln=True)

            # Decode and embed chart image
            try:
                img_data = base64.b64decode(chart["image_base64"])
                img_buf = io.BytesIO(img_data)
                img_name = f"chart_{chart['label'][:20].replace(' ', '_')}.png"
                pdf.image(img_buf, x=15, w=250)
                pdf.ln(5)
            except Exception as e:
                logger.warning(f"Failed to embed chart {chart['label']}: {e}")

    # Insights
    all_insights = list(insights or [])
    if narrative:
        all_insights.insert(0, narrative)

    if all_insights:
        if pdf.get_y() > 160:
            pdf.add_page()

        pdf.set_font("Helvetica", "B", 12)
        pdf.set_text_color(31, 78, 121)
        pdf.cell(0, 8, "Management Insights", ln=True)
        pdf.ln(2)

        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(50, 50, 50)
        for insight in all_insights[:10]:
            # Bullet point
            pdf.set_x(20)
            pdf.multi_cell(250, 5, f"• {insight}")
            pdf.ln(1)

    # Footer
    pdf.set_y(-15)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(150, 150, 150)
    pdf.cell(0, 5, "Decision Intelligence Platform — AI-Generated Report", align="C")

    return pdf.output()


def _generate_html_preview(title: str, kpis: dict, charts: list, insights: list) -> str:
    """Generate a simple HTML preview of the report."""
    parts = [
        "<!DOCTYPE html><html><head><style>",
        "body{font-family:system-ui;margin:20px;color:#333}",
        "h1{color:#1F4E79}h2{color:#2E75B6;border-bottom:2px solid #E8E8E8;padding-bottom:6px}",
        ".kpi-row{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}",
        ".kpi-card{background:#F2F7FB;padding:16px;border-radius:8px;min-width:120px;text-align:center}",
        ".kpi-value{font-size:24px;font-weight:bold;color:#1F4E79}",
        ".kpi-label{font-size:12px;color:#666;margin-top:4px}",
        "img{max-width:100%;border-radius:4px;margin:8px 0}",
        "ul{line-height:1.8}",
        "</style></head><body>",
        f"<h1>{title}</h1>",
        f"<p style='color:#888'>Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>",
    ]

    if kpis:
        parts.append("<h2>Key Performance Indicators</h2><div class='kpi-row'>")
        for k, v in list(kpis.items())[:8]:
            display = f"{float(v):,.2f}" if isinstance(v, (int, float)) else str(v)
            parts.append(f"<div class='kpi-card'><div class='kpi-value'>{display}</div><div class='kpi-label'>{k}</div></div>")
        parts.append("</div>")

    if charts:
        parts.append("<h2>Charts</h2>")
        for chart in charts:
            parts.append(f"<h3>{chart['label']}</h3>")
            parts.append(f"<img src='data:image/png;base64,{chart['image_base64']}' />")

    if insights:
        parts.append("<h2>Management Insights</h2><ul>")
        for insight in insights:
            parts.append(f"<li>{insight}</li>")
        parts.append("</ul>")

    parts.append("<hr><p style='color:#999;font-size:11px'>Decision Intelligence Platform — AI-Generated Report</p>")
    parts.append("</body></html>")
    return "".join(parts)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@report_generator_router.post("/generate-report", response_model=ReportResponse)
async def generate_report(request: ReportRequest):
    """Generate a PDF/HTML dashboard from prior step artifacts."""
    start_time = time.time()

    try:
        # Extract data from artifacts
        kpis = request.kpis or _extract_kpis_from_artifacts(request.artifacts)
        tables = _extract_table_data(request.artifacts)
        insights = request.insights or []
        narrative = request.narrative

        # Generate charts
        charts = _generate_charts(tables, kpis)

        # Generate outputs
        pdf_base64 = None
        html_preview = None

        if request.report_format in ("pdf", "both"):
            pdf_bytes = _generate_pdf(
                title=request.task_title,
                kpis=kpis,
                charts=charts,
                insights=insights,
                narrative=narrative,
            )
            pdf_base64 = base64.b64encode(pdf_bytes).decode()

        html_preview = _generate_html_preview(
            title=request.task_title,
            kpis=kpis,
            charts=charts,
            insights=insights,
        )

        # Build artifacts
        report_artifacts = []
        if pdf_base64:
            report_artifacts.append(ReportArtifact(
                type="pdf_report",
                label=f"{request.task_title} (PDF)",
                data={"pdf_base64": pdf_base64, "size_bytes": len(pdf_base64) * 3 // 4},
            ))
        if html_preview:
            report_artifacts.append(ReportArtifact(
                type="html_report",
                label=f"{request.task_title} (HTML)",
                data={"html": html_preview},
            ))
        if charts:
            report_artifacts.append(ReportArtifact(
                type="chart_images",
                label="Dashboard Charts",
                data={"charts": [{"label": c["label"]} for c in charts], "count": len(charts)},
            ))

        return ReportResponse(
            ok=True,
            pdf_base64=pdf_base64,
            html_preview=html_preview,
            artifacts=report_artifacts,
            execution_ms=int((time.time() - start_time) * 1000),
        )

    except Exception as e:
        logger.error(f"[report_generator] Failed: {e}", exc_info=True)
        return ReportResponse(
            ok=False,
            error=str(e),
            execution_ms=int((time.time() - start_time) * 1000),
        )
