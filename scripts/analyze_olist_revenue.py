import pandas as pd
import numpy as np
import sys

# Load datasets
order_items_path = '/Users/xuweijin/Decision-Intelligence-/public/data/sap/olist_order_items_dataset.csv'
sellers_path = '/Users/xuweijin/Decision-Intelligence-/public/data/sap/olist_sellers_dataset.csv'

try:
    print("Loading data...")
    order_items = pd.read_csv(order_items_path)
    sellers = pd.read_csv(sellers_path)
    
    print(f"Order Items: {order_items.shape}")
    print(f"Sellers: {sellers.shape}")

    # Calculate revenue per seller
    # Revenue is sum of price per seller_id (ignoring freight)
    seller_revenue = order_items.groupby('seller_id')['price'].sum().reset_index()
    seller_revenue.columns = ['seller_id', 'revenue']
    
    # Merge with seller info to ensure we include all sellers (though order_items usually only has active ones)
    # We'll focus on sellers who have made at least one sale for this distribution analysis
    
    # Descriptive Statistics
    total_revenue = seller_revenue['revenue'].sum()
    total_sellers = len(seller_revenue)
    
    print("\n--- General Statistics ---")
    print(f"Total Revenue: R$ {total_revenue:,.2f}")
    print(f"Total Active Sellers: {total_sellers}")
    print(f"Mean Revenue: R$ {seller_revenue['revenue'].mean():,.2f}")
    print(f"Median Revenue (P50): R$ {seller_revenue['revenue'].median():,.2f}")
    print(f"Max Revenue: R$ {seller_revenue['revenue'].max():,.2f}")
    print(f"Min Revenue: R$ {seller_revenue['revenue'].min():,.2f}")

    # Quantiles
    quantiles = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]
    quantile_values = seller_revenue['revenue'].quantile(quantiles)
    
    print("\n--- Revenue Quantiles ---")
    for q, val in quantile_values.items():
        print(f"P{int(q*100)}: R$ {val:,.2f}")

    # Concentration Metrics
    # Top 10 sellers (by count, not specific ID)
    top_10_revenue = seller_revenue.nlargest(10, 'revenue')['revenue'].sum()
    top_10_share = (top_10_revenue / total_revenue) * 100
    
    # Top 1% sellers
    top_1_percent_count = int(np.ceil(total_sellers * 0.01))
    top_1_percent_revenue = seller_revenue.nlargest(top_1_percent_count, 'revenue')['revenue'].sum()
    top_1_percent_share = (top_1_percent_revenue / total_revenue) * 100
    
    # Top 10% sellers
    top_10_percent_count = int(np.ceil(total_sellers * 0.1))
    top_10_percent_revenue = seller_revenue.nlargest(top_10_percent_count, 'revenue')['revenue'].sum()
    top_10_percent_share = (top_10_percent_revenue / total_revenue) * 100

    # Gini Coefficient
    # Sort revenue
    revenue_sorted = seller_revenue['revenue'].sort_values().values
    n = len(revenue_sorted)
    # Gini formula
    index = np.arange(1, n + 1)
    gini = ((2 * np.sum(index * revenue_sorted)) - (n + 1) * np.sum(revenue_sorted)) / (n * np.sum(revenue_sorted))
    
    print("\n--- Concentration Metrics ---")
    print(f"Top 10 Sellers Share (Absolute): {top_10_share:.2f}%")
    print(f"Top 1% Sellers Share: {top_1_percent_share:.2f}% (Count: {top_1_percent_count})")
    print(f"Top 10% Sellers Share: {top_10_percent_share:.2f}% (Count: {top_10_percent_count})")
    print(f"Gini Coefficient: {gini:.4f}")

    # Pareto Check (80/20 rule)
    # Calculate what % of sellers contribute 80% of revenue
    revenue_sorted_desc = np.sort(revenue_sorted)[::-1]
    cumulative_revenue = np.cumsum(revenue_sorted_desc)
    
    # Find index where cumulative revenue crosses 80%
    threshold_80 = total_revenue * 0.8
    # searchsorted returns the index where the value would be inserted to maintain order
    sellers_80_idx = np.searchsorted(cumulative_revenue, threshold_80)
    sellers_80_count = sellers_80_idx + 1
    sellers_80_share = (sellers_80_count / total_sellers) * 100
    
    print(f"Pareto Analysis: {sellers_80_share:.2f}% of sellers contribute 80% of total revenue")

    # Histogram Data (Log scale bins)
    print("\n--- Histogram Data (Log Scale Bins) ---")
    # Define log bins similar to typical revenue brackets
    bins = [0, 100, 300, 1000, 3000, 10000, 30000, 100000, 1000000]
    labels = ['0-100', '100-300', '300-1K', '1K-3K', '3K-10K', '10K-30K', '30K-100K', '>100K']
    
    seller_revenue['revenue_bin'] = pd.cut(seller_revenue['revenue'], bins=bins, labels=labels, right=False)
    hist_data = seller_revenue['revenue_bin'].value_counts().sort_index()
    
    for label, count in hist_data.items():
        percentage = (count / total_sellers) * 100
        print(f"{label}: {count} ({percentage:.1f}%)")

except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
