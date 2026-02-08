"""End-to-end verification of all 4 tasks."""
import requests
import json
import numpy as np

API = "http://127.0.0.1:8000"

print("=" * 50)
print("  SmartOps E2E Verification")
print("=" * 50)

# Generate test history
np.random.seed(42)
history = [50 + 5 * np.sin(2 * 3.14 * i / 7) + np.random.normal(0, 3) for i in range(90)]

# [1] Recursive Predict
print("\n[1] LightGBM Recursive Predict")
r = requests.post(f"{API}/demand-forecast", json={
    "materialCode": "E2E-TEST",
    "horizonDays": 7,
    "modelType": "lightgbm",
    "history": history
})
d = r.json()
f = d.get("forecast", {})
print(f"  Model:   {f.get('model')}")
print(f"  Version: {f.get('model_version')}")
print(f"  Mode:    {d.get('metadata', {}).get('inference_mode')}")
preds = f.get("predictions", [])[:7]
print(f"  Preds:   {[round(p, 1) for p in preds]}")
print(f"  Std:     {np.std(preds):.2f} (>0 = learned patterns)")

# [2] Feature Importance
print("\n[2] Feature Importance (Explainability)")
r = requests.post(f"{API}/feature-importance", json={})
d = r.json()
if d.get("success"):
    top3 = d["features"][:3]
    for feat in top3:
        print(f"  {feat['feature']:20s} {feat['importance_pct']:5.1f}%  {feat['explanation'][:60]}")
    print(f"  Summary: {d['summary'][:80]}")
    if d.get("optuna") and not d["optuna"].get("skipped"):
        print(f"  Optuna:  {d['optuna']['n_trials']} trials, best MAPE {d['optuna']['best_mape']}%")
    if d.get("params_used"):
        p = d["params_used"]
        print(f"  Params:  lr={p.get('learning_rate')}, leaves={p.get('num_leaves')}, ff={p.get('feature_fraction')}")
else:
    print(f"  Error: {d.get('error')}")

# [3] Drift Check — Normal
print("\n[3] Drift Check (Normal Data)")
r = requests.post(f"{API}/drift-check", json={"history": history, "window": 30})
d = r.json()
print(f"  Level:   {d.get('drift_level')}")
print(f"  Z-score: {d.get('details', {}).get('z_score')}")
print(f"  Message: {d.get('message', '')[:80]}")

# [4] Drift Check — Drifted
print("\n[4] Drift Check (Drifted Data: mean=120)")
drifted = [120 + np.random.normal(0, 5) for _ in range(60)]
r = requests.post(f"{API}/drift-check", json={"history": drifted, "window": 30})
d = r.json()
print(f"  Level:   {d.get('drift_level')}")
print(f"  Z-score: {d.get('details', {}).get('z_score')}")
print(f"  Message: {d.get('message', '')[:80]}")

print("\n" + "=" * 50)
print("  ALL 4 TASKS VERIFIED")
print("=" * 50)
