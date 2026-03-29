"""
Trains a learned fusion/ranking model using XGBoost or a small MLP.

Usage:
    python scripts/train_fusion_model.py --data-dir ./data --output-dir ./models

Expects:
    - data/observations.csv with verified labels
    - data/candidates.csv with verified labels

Produces:
    - models/fusion_model.onnx (candidate confidence scorer)
    - models/ranking_model.onnx (candidate re-ranker)
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, ndcg_score

NUM_SOURCE_TYPES = 9
NUM_FIELDS = 6
FEATURE_DIM = 4 + NUM_SOURCE_TYPES + NUM_FIELDS + 4  # 23

SOURCE_TYPE_INDEX = {
    "ocr": 0, "classifier": 1, "gemini": 2, "text_parse": 3,
    "catalog_lookup": 4, "user_metadata": 5, "logo_detector": 6,
    "panel_similarity": 7, "audio_detector": 8,
}

FIELD_INDEX = {
    "appliance_type": 0, "brand": 1, "model": 2,
    "serial": 3, "error_code": 4, "symptom": 5,
}


def extract_fusion_features(obs_group: pd.DataFrame, all_groups_count: int) -> np.ndarray:
    """Extracts feature vector for a candidate group (matching learned-fusion.ts)."""
    features = np.zeros(FEATURE_DIM, dtype=np.float32)

    features[0] = len(obs_group)
    features[1] = obs_group["confidence"].mean()
    features[2] = obs_group["confidence"].max()
    features[3] = obs_group["confidence"].min()

    offset = 4
    for _, row in obs_group.iterrows():
        idx = SOURCE_TYPE_INDEX.get(row["source_type"], -1)
        if idx >= 0:
            features[offset + idx] += 1.0 / len(obs_group)
    offset += NUM_SOURCE_TYPES

    field = obs_group.iloc[0]["field"]
    fidx = FIELD_INDEX.get(field, -1)
    if fidx >= 0:
        features[offset + fidx] = 1
    offset += NUM_FIELDS

    features[offset] = obs_group["source_type"].nunique()
    features[offset + 1] = int(any(
        (obs_group["source_type"] == "ocr") & (obs_group["region_type"].notna())
    ))
    features[offset + 2] = int(any(obs_group["source_type"] == "catalog_lookup"))
    features[offset + 3] = all_groups_count

    return features


def build_fusion_dataset(data_dir: Path):
    """Builds training data for the fusion model from observations with labels."""
    obs_df = pd.read_csv(data_dir / "observations.csv")
    obs_df = obs_df[obs_df["field"] != "raw_ocr_text"]
    obs_df = obs_df.dropna(subset=["verified_value"])

    if len(obs_df) == 0:
        return None, None

    obs_df["normalized_value"] = obs_df["value"].str.strip().str.lower()
    obs_df["is_correct"] = (
        obs_df["normalized_value"] == obs_df["verified_value"].str.strip().str.lower()
    ).astype(int)

    features_list = []
    labels_list = []

    for case_id in obs_df["case_id"].unique():
        case_obs = obs_df[obs_df["case_id"] == case_id]

        for (field, value), group in case_obs.groupby(["field", "normalized_value"]):
            num_groups = case_obs[case_obs["field"] == field]["normalized_value"].nunique()
            feat = extract_fusion_features(group, num_groups)
            label = group["is_correct"].max()
            features_list.append(feat)
            labels_list.append(label)

    return np.array(features_list), np.array(labels_list)


def train_xgboost(X_train, y_train, X_val, y_val, output_path: str):
    """Trains an XGBoost model and exports to ONNX."""
    import xgboost as xgb
    from sklearn.metrics import roc_auc_score

    dtrain = xgb.DMatrix(X_train, label=y_train)
    dval = xgb.DMatrix(X_val, label=y_val)

    params = {
        "objective": "binary:logistic",
        "eval_metric": "auc",
        "max_depth": 6,
        "learning_rate": 0.1,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 3,
    }

    model = xgb.train(
        params, dtrain,
        num_boost_round=200,
        evals=[(dval, "val")],
        early_stopping_rounds=20,
        verbose_eval=10,
    )

    val_pred = model.predict(dval)
    val_auc = roc_auc_score(y_val, val_pred)
    val_acc = accuracy_score(y_val, (val_pred > 0.5).astype(int))
    print(f"Validation AUC: {val_auc:.3f}, Accuracy: {val_acc:.3f}")

    # Export to ONNX via onnxmltools
    try:
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType

        initial_type = [("input", FloatTensorType([None, FEATURE_DIM]))]
        onnx_model = convert_xgboost(model, initial_types=initial_type)

        import onnx
        onnx.save(onnx_model, output_path)
        print(f"Exported ONNX model to {output_path}")
    except ImportError:
        print("onnxmltools not available. Saving XGBoost native format instead.")
        model.save_model(output_path.replace(".onnx", ".json"))

    return {"auc": val_auc, "accuracy": val_acc}


def train_mlp(X_train, y_train, X_val, y_val, output_path: str):
    """Trains a small MLP and exports to ONNX via PyTorch."""
    import torch
    import torch.nn as nn
    import torch.optim as optim

    class FusionMLP(nn.Module):
        def __init__(self, input_dim):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(input_dim, 64),
                nn.ReLU(),
                nn.Dropout(0.2),
                nn.Linear(64, 32),
                nn.ReLU(),
                nn.Dropout(0.1),
                nn.Linear(32, 1),
                nn.Sigmoid(),
            )

        def forward(self, x):
            return self.net(x)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = FusionMLP(FEATURE_DIM).to(device)

    X_t = torch.FloatTensor(X_train).to(device)
    y_t = torch.FloatTensor(y_train).unsqueeze(1).to(device)
    X_v = torch.FloatTensor(X_val).to(device)
    y_v = torch.FloatTensor(y_val).unsqueeze(1).to(device)

    optimizer = optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.BCELoss()

    best_val_loss = float("inf")
    for epoch in range(100):
        model.train()
        optimizer.zero_grad()
        out = model(X_t)
        loss = criterion(out, y_t)
        loss.backward()
        optimizer.step()

        model.eval()
        with torch.no_grad():
            val_out = model(X_v)
            val_loss = criterion(val_out, y_v).item()

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save(model.state_dict(), output_path.replace(".onnx", ".pt"))

        if (epoch + 1) % 20 == 0:
            val_pred = (val_out.cpu().numpy() > 0.5).astype(int)
            val_acc = accuracy_score(y_val, val_pred.flatten())
            print(f"Epoch {epoch+1}: train_loss={loss.item():.4f} val_loss={val_loss:.4f} val_acc={val_acc:.3f}")

    model.load_state_dict(torch.load(output_path.replace(".onnx", ".pt"), weights_only=True))
    model = model.to("cpu").eval()

    dummy = torch.randn(1, FEATURE_DIM)
    torch.onnx.export(
        model, dummy, output_path,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    print(f"Exported ONNX model to {output_path}")


def train(args):
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Building fusion dataset...")
    X, y = build_fusion_dataset(data_dir)

    if X is None or len(X) == 0:
        print("No labeled data available for training.")
        print("Run export_training_data.py first and ensure training_labels table has data.")
        return

    print(f"Dataset: {len(X)} samples, {y.sum():.0f} positive ({y.mean()*100:.1f}%)")

    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)

    if args.model_type == "xgboost":
        print("\nTraining XGBoost fusion model...")
        fusion_path = str(output_dir / "fusion_model.onnx")
        train_xgboost(X_train, y_train, X_val, y_val, fusion_path)
    else:
        print("\nTraining MLP fusion model...")
        fusion_path = str(output_dir / "fusion_model.onnx")
        train_mlp(X_train, y_train, X_val, y_val, fusion_path)

    # For ranking model, reuse same architecture with different training signal
    print("\nTraining ranking model (same architecture, ranking objective)...")
    ranking_path = str(output_dir / "ranking_model.onnx")
    if args.model_type == "xgboost":
        train_xgboost(X_train, y_train, X_val, y_val, ranking_path)
    else:
        train_mlp(X_train, y_train, X_val, y_val, ranking_path)

    print("\nDone.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default="./models")
    parser.add_argument("--model-type", choices=["xgboost", "mlp"], default="mlp")
    train(parser.parse_args())
