import pandas as pd

from ml.api.forecast_artifact_contract import (
    build_forecast_artifact,
    extract_forecast_contracts,
)


def test_build_forecast_artifact_infers_measure_unit_and_granularity():
    artifact = build_forecast_artifact(
        predictions=[44.2, 45.1, 43.8],
        p10=[39.0, 40.2, 38.6],
        p90=[49.8, 50.4, 48.1],
        model="naive",
        source_measure_col="Order Quantity",
        source_date_col="Order Date",
        history_index=pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03"]),
    )

    contract = extract_forecast_contracts([artifact])[0]

    assert artifact["artifact_contract"] == "forecast_series_v1"
    assert contract["measure_name"] == "demand_units"
    assert contract["value_unit"] == "count"
    assert contract["series_granularity"] == "daily"
    assert contract["source_measure_col"] == "Order Quantity"
