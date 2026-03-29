"""
Trains confidence calibration models (Platt scaling or isotonic regression)
for each (source_type, field) pair.

Usage:
    python scripts/calibrate.py --data-dir ./data --output-dir ./models/calibration

Expects:
    - data/calibration_pairs.csv with columns:
      source_type, field, raw_confidence, value, verified_value, is_correct

Produces:
    - models/calibration/{source_type}_{field}.json for each pair with enough data
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss

MIN_SAMPLES = 30


def expected_calibration_error(confidences, accuracies, n_bins=10):
    """Computes ECE over binned confidence ranges."""
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        mask = (confidences >= bin_boundaries[i]) & (confidences < bin_boundaries[i + 1])
        if i == n_bins - 1:
            mask = (confidences >= bin_boundaries[i]) & (confidences <= bin_boundaries[i + 1])
        n = mask.sum()
        if n == 0:
            continue
        avg_conf = confidences[mask].mean()
        avg_acc = accuracies[mask].mean()
        ece += (n / len(confidences)) * abs(avg_conf - avg_acc)
    return ece


def fit_platt(confidences, labels):
    """Fits Platt scaling (logistic regression on raw confidence)."""
    X = confidences.reshape(-1, 1)
    lr = LogisticRegression(solver="lbfgs", max_iter=1000)
    lr.fit(X, labels)

    A = float(lr.coef_[0][0])
    B = float(lr.intercept_[0])

    # Platt formulation: P = 1 / (1 + exp(A*s + B))
    # sklearn logistic: P = 1 / (1 + exp(-(A*s + B)))
    # So we negate to match the Platt convention used in calibration.ts
    return {"A": -A, "B": -B}


def fit_isotonic(confidences, labels):
    """Fits isotonic regression for non-parametric calibration."""
    ir = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1)
    ir.fit(confidences, labels)

    thresholds = ir.X_thresholds_.tolist()
    values = ir.y_thresholds_.tolist()

    return {"thresholds": thresholds, "values": values}


def calibrate_pair(df_pair, source_type, field, output_dir):
    """Calibrates a single (source_type, field) pair and saves parameters."""
    confidences = df_pair["raw_confidence"].values.astype(np.float64)
    labels = df_pair["is_correct"].values.astype(np.float64)

    ece_before = expected_calibration_error(confidences, labels)
    brier_before = brier_score_loss(labels, confidences)

    # Try Platt scaling
    platt_params = fit_platt(confidences, labels)
    platt_probs = 1.0 / (1.0 + np.exp(platt_params["A"] * confidences + platt_params["B"]))
    ece_platt = expected_calibration_error(platt_probs, labels)
    brier_platt = brier_score_loss(labels, platt_probs)

    # Try isotonic regression
    isotonic_params = fit_isotonic(confidences, labels)
    ir = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1)
    ir.fit(confidences, labels)
    iso_probs = ir.predict(confidences)
    ece_iso = expected_calibration_error(iso_probs, labels)
    brier_iso = brier_score_loss(labels, iso_probs)

    # Pick better method
    if brier_iso < brier_platt:
        method = "isotonic"
        entry = {
            "method": "isotonic",
            "isotonic": isotonic_params,
            "sample_count": len(df_pair),
            "ece_before": round(ece_before, 4),
            "ece_after": round(ece_iso, 4),
            "brier_before": round(brier_before, 4),
            "brier_after": round(brier_iso, 4),
        }
    else:
        method = "platt"
        entry = {
            "method": "platt",
            "platt": platt_params,
            "sample_count": len(df_pair),
            "ece_before": round(ece_before, 4),
            "ece_after": round(ece_platt, 4),
            "brier_before": round(brier_before, 4),
            "brier_after": round(brier_platt, 4),
        }

    output_path = output_dir / f"{source_type}_{field}.json"
    with open(output_path, "w") as f:
        json.dump(entry, f, indent=2)

    print(f"  {source_type:18s} {field:18s}  n={len(df_pair):4d}  "
          f"ECE: {ece_before:.3f} → {entry['ece_after']:.3f}  "
          f"method={method}")


def main(args):
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    csv_path = data_dir / "calibration_pairs.csv"
    if not csv_path.exists():
        print(f"Calibration data not found at {csv_path}")
        print("Run export_training_data.py first.")
        return

    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["raw_confidence", "is_correct"])

    print(f"Loaded {len(df)} calibration pairs")
    print(f"Overall accuracy: {df['is_correct'].mean():.3f}\n")

    calibrated = 0
    skipped = 0

    for (source_type, field), group in df.groupby(["source_type", "field"]):
        if len(group) < MIN_SAMPLES:
            skipped += 1
            continue

        unique_labels = group["is_correct"].nunique()
        if unique_labels < 2:
            skipped += 1
            continue

        calibrate_pair(group, source_type, field, output_dir)
        calibrated += 1

    print(f"\nCalibrated {calibrated} (source_type, field) pairs, skipped {skipped}")
    print(f"Output directory: {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default="./models/calibration")
    main(parser.parse_args())
