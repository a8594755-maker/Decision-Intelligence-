# Pipeline Assertion Answer Keys
# Hand-calculated ground truth for 3 golden datasets

ANSWER_KEY_HARD = {
    "total_revenue": 17637296.55,
    "total_cogs": 8643497.0,
    "gross_margin": 8993799.55,
    "gross_margin_pct": 50.99,
    "simple_mean_margin_pct": 50.51,  # WRONG method — system must NOT output this
    "rows_removed": 2,  # header-as-data row + TEST-001 row
    "unique_products": 5,
    "unique_regions_canonical": 3,
    "unique_customers_canonical": 5,
    "currencies_detected": 3,
    "inventory_total_value": 384199,
    "bom_components": {
        "RM-A": 18887.7,
        "RM-B": 4005.0,
        "RM-C": 3150.0,
        "SUB-01": 3445.0,
        "RM-D": 24302.4,
        "RM-E": 6890.0,
        "RM-F": 15002.8,
    },
}

ANSWER_KEY_ELECTRONICS = {
    "total_revenue": 659350797.0,
    "total_cogs": 344147120.0,
    "gross_margin": 315203677.0,
    "gross_margin_pct": 47.81,
    "simple_mean_margin_pct": 53.70,  # WRONG method
    "rows_removed": 1,  # duplicate row
    "unique_products": 8,
    "unique_regions_canonical": 3,
    "unique_customers_canonical": 5,
    "currencies_detected": 3,
    "inventory_total_value": 2914130,
}

ANSWER_KEY_REALFORMAT = {
    "total_revenue": 2800224.0,
    "total_cogs": 1118484.0,
    "gross_margin": 1681740.0,
    "gross_margin_pct": 60.06,
    "simple_mean_margin_pct": 60.11,  # WRONG method
    "rows_removed": 2,  # empty row + summary row
    "unique_products": 6,
    "unique_regions_canonical": 4,
    "unique_customers_canonical": 7,
    "currencies_canonical": 1,
    "has_bom": False,
}

# Tolerance: revenue/cogs/margin ±1.0, margin% ±0.5%, counts exact
