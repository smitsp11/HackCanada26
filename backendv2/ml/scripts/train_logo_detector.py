"""
Trains a YOLOv8-nano logo/brand detector for appliance images.

Usage:
    python scripts/train_logo_detector.py --data-dir ./data --output-dir ./models

Expects:
    - data/logo_dataset/ in YOLO format:
        data/logo_dataset/
          images/train/  images/val/
          labels/train/  labels/val/
          data.yaml

Produces:
    - models/logo_detector.onnx
"""

import argparse
import os
from pathlib import Path

BRAND_LABELS = [
    "bosch", "samsung", "lg", "whirlpool", "ge", "maytag", "frigidaire",
    "kitchenaid", "kenmore", "electrolux", "miele", "thermador", "sub_zero",
    "viking", "jenn_air", "amana", "hotpoint", "haier", "fisher_paykel",
    "speed_queen",
]


def create_data_yaml(data_dir: Path) -> str:
    """Creates a YOLO-format data.yaml if one doesn't exist."""
    yaml_path = data_dir / "logo_dataset" / "data.yaml"
    if yaml_path.exists():
        return str(yaml_path)

    yaml_content = f"""
path: {data_dir / 'logo_dataset'}
train: images/train
val: images/val

nc: {len(BRAND_LABELS)}
names: {BRAND_LABELS}
"""
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    yaml_path.write_text(yaml_content.strip())
    return str(yaml_path)


def train(args):
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    data_yaml = create_data_yaml(data_dir)
    dataset_dir = data_dir / "logo_dataset" / "images" / "train"

    if not dataset_dir.exists() or not any(dataset_dir.iterdir()):
        print(f"No training images found at {dataset_dir}")
        print("Prepare a YOLO-format dataset with labeled brand logo bounding boxes.")
        print(f"Expected structure: {data_dir}/logo_dataset/images/{{train,val}}/ + labels/{{train,val}}/")
        return

    from ultralytics import YOLO

    model = YOLO("yolov8n.pt")

    results = model.train(
        data=data_yaml,
        epochs=args.epochs,
        imgsz=640,
        batch=args.batch_size,
        name="logo_detector",
        project=str(output_dir / "runs"),
        patience=10,
        lr0=0.01,
        lrf=0.01,
        mosaic=1.0,
        flipud=0.0,
        fliplr=0.5,
        close_mosaic=5,
        device="0" if _has_cuda() else "cpu",
    )

    best_path = output_dir / "runs" / "logo_detector" / "weights" / "best.pt"
    if best_path.exists():
        best_model = YOLO(str(best_path))
        onnx_path = str(output_dir / "logo_detector.onnx")
        best_model.export(format="onnx", imgsz=640, simplify=True)

        exported = str(best_path).replace(".pt", ".onnx")
        if os.path.exists(exported):
            os.rename(exported, onnx_path)
            print(f"\nExported ONNX model to {onnx_path}")
        else:
            print(f"\nExport completed but ONNX file not found at expected path")

        print(f"Training results: {results}")
    else:
        print("Training did not produce a best.pt file")


def _has_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default="./models")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=16)
    train(parser.parse_args())
