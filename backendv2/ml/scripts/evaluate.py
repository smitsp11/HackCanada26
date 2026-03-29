"""
Comprehensive offline evaluation of trained models against labeled datasets.

Usage:
    python scripts/evaluate.py --data-dir ./data --models-dir ./models

Produces console report and optional matplotlib plots.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    confusion_matrix, classification_report,
)


def expected_calibration_error(confidences, accuracies, n_bins=10):
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    bins_data = []

    for i in range(n_bins):
        lo, hi = bin_boundaries[i], bin_boundaries[i + 1]
        mask = (confidences >= lo) & (confidences < (hi + 0.001 if i == n_bins - 1 else hi))
        n = mask.sum()
        if n == 0:
            bins_data.append((lo, hi, 0, 0, 0))
            continue
        avg_conf = confidences[mask].mean()
        avg_acc = accuracies[mask].mean()
        ece += (n / len(confidences)) * abs(avg_conf - avg_acc)
        bins_data.append((lo, hi, avg_conf, avg_acc, n))

    return ece, bins_data


def evaluate_observations(data_dir: Path):
    """Evaluates observation-level accuracy using labeled data."""
    csv_path = data_dir / "calibration_pairs.csv"
    if not csv_path.exists():
        print("No calibration_pairs.csv found, skipping observation evaluation")
        return

    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["raw_confidence", "is_correct"])

    if len(df) == 0:
        print("No labeled observations found")
        return

    print("=" * 60)
    print("OBSERVATION-LEVEL EVALUATION")
    print("=" * 60)

    overall_acc = df["is_correct"].mean()
    print(f"\nOverall accuracy: {overall_acc:.3f} ({len(df)} samples)")

    ece, bins = expected_calibration_error(
        df["raw_confidence"].values,
        df["is_correct"].values,
    )
    print(f"Overall ECE: {ece:.4f}")

    print("\nPer source_type:")
    for source, group in df.groupby("source_type"):
        acc = group["is_correct"].mean()
        source_ece, _ = expected_calibration_error(
            group["raw_confidence"].values,
            group["is_correct"].values,
        )
        print(f"  {source:20s}  acc={acc:.3f}  ece={source_ece:.4f}  n={len(group)}")

    print("\nPer field:")
    for field, group in df.groupby("field"):
        acc = group["is_correct"].mean()
        field_ece, _ = expected_calibration_error(
            group["raw_confidence"].values,
            group["is_correct"].values,
        )
        print(f"  {field:20s}  acc={acc:.3f}  ece={field_ece:.4f}  n={len(group)}")

    print("\nCalibration bins:")
    print(f"  {'Bin':15s} {'Avg Conf':>10s} {'Avg Acc':>10s} {'Count':>8s}")
    for lo, hi, conf, acc, n in bins:
        if n > 0:
            print(f"  [{lo:.1f}, {hi:.1f})  {conf:10.3f} {acc:10.3f} {n:8d}")


def evaluate_candidates(data_dir: Path):
    """Evaluates candidate-level ranking quality."""
    csv_path = data_dir / "candidates.csv"
    if not csv_path.exists():
        print("\nNo candidates.csv found, skipping candidate evaluation")
        return

    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["verified_value"])

    if len(df) == 0:
        print("\nNo labeled candidates found")
        return

    print("\n" + "=" * 60)
    print("CANDIDATE-LEVEL EVALUATION")
    print("=" * 60)

    df["is_correct"] = df.apply(
        lambda r: str(r["value"]).strip().lower() == str(r["verified_value"]).strip().lower(),
        axis=1,
    )

    rank1 = df[df["rank"] == 1]
    if len(rank1) > 0:
        rank1_acc = rank1["is_correct"].mean()
        print(f"\nRank-1 accuracy: {rank1_acc:.3f} ({len(rank1)} candidates)")

    for ctype, group in df.groupby("candidate_type"):
        r1 = group[group["rank"] == 1]
        if len(r1) > 0:
            acc = r1["is_correct"].mean()
            print(f"  {ctype:20s}  rank1_acc={acc:.3f}  n={len(r1)}")


def plot_calibration(data_dir: Path, output_dir: Path):
    """Generates calibration plot if matplotlib is available."""
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("\nmatplotlib not available, skipping plots")
        return

    csv_path = data_dir / "calibration_pairs.csv"
    if not csv_path.exists():
        return

    df = pd.read_csv(csv_path).dropna(subset=["raw_confidence", "is_correct"])
    if len(df) == 0:
        return

    _, bins = expected_calibration_error(
        df["raw_confidence"].values,
        df["is_correct"].values,
    )

    fig, ax = plt.subplots(figsize=(8, 6))
    confs = [b[2] for b in bins if b[4] > 0]
    accs = [b[3] for b in bins if b[4] > 0]

    ax.plot([0, 1], [0, 1], "k--", label="Perfect calibration")
    ax.bar(confs, accs, width=0.08, alpha=0.6, label="Actual")
    ax.set_xlabel("Mean Predicted Confidence")
    ax.set_ylabel("Fraction Correct")
    ax.set_title("Calibration (Reliability) Diagram")
    ax.legend()

    plot_path = output_dir / "calibration_plot.png"
    fig.savefig(plot_path, dpi=150, bbox_inches="tight")
    print(f"\nCalibration plot saved to {plot_path}")
    plt.close()


def main(args):
    data_dir = Path(args.data_dir)

    evaluate_observations(data_dir)
    evaluate_candidates(data_dir)

    if args.plot:
        output_dir = Path(args.output_dir) if args.output_dir else data_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        plot_calibration(data_dir, output_dir)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--plot", action="store_true", help="Generate matplotlib plots")
    main(parser.parse_args())
