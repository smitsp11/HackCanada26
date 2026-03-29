"""
Trains an appliance type classifier using transfer learning from MobileNetV3.

Usage:
    python scripts/train_classifier.py --data-dir ./data --output-dir ./models

Expects:
    - data/images_manifest.csv with columns: asset_id, storage_uri_normalized, appliance_type_label
    - Downloaded images in data/images/ (run download_images.py first)

Produces:
    - models/appliance_classifier.onnx
"""

import argparse
import csv
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms, models
from tqdm import tqdm

APPLIANCE_TAXONOMY = [
    "dishwasher", "washer", "dryer", "refrigerator", "oven", "range",
    "microwave", "furnace", "air_conditioner", "water_heater",
    "garbage_disposal", "freezer", "cooktop", "hood", "ice_maker",
]

LABEL_TO_IDX = {label: idx for idx, label in enumerate(APPLIANCE_TAXONOMY)}
NUM_CLASSES = len(APPLIANCE_TAXONOMY)

INPUT_SIZE = 224
BATCH_SIZE = 32
NUM_EPOCHS = 20
LEARNING_RATE = 1e-3
FINE_TUNE_LR = 1e-5


class ApplianceDataset(Dataset):
    def __init__(self, manifest_path: str, images_dir: str, transform):
        self.transform = transform
        self.samples = []

        with open(manifest_path) as f:
            reader = csv.DictReader(f)
            for row in reader:
                label = (row.get("appliance_type_label") or "").strip().lower()
                if label not in LABEL_TO_IDX:
                    continue
                img_path = os.path.join(images_dir, f"{row['asset_id']}.jpg")
                if os.path.exists(img_path):
                    self.samples.append((img_path, LABEL_TO_IDX[label]))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, label = self.samples[idx]
        image = Image.open(path).convert("RGB")
        return self.transform(image), label


def build_model():
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, NUM_CLASSES)
    return model


def train(args):
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    train_transform = transforms.Compose([
        transforms.RandomResizedCrop(INPUT_SIZE, scale=(0.8, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.2, contrast=0.2),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])

    val_transform = transforms.Compose([
        transforms.Resize(256),
        transforms.CenterCrop(INPUT_SIZE),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])

    full_dataset = ApplianceDataset(
        str(data_dir / "images_manifest.csv"),
        str(data_dir / "images"),
        train_transform,
    )

    if len(full_dataset) == 0:
        print("No training samples found. Check images_manifest.csv and images/ directory.")
        return

    val_size = max(1, int(len(full_dataset) * 0.15))
    train_size = len(full_dataset) - val_size
    train_dataset, val_dataset = torch.utils.data.random_split(
        full_dataset, [train_size, val_size],
    )
    val_dataset.dataset.transform = val_transform

    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_dataset, batch_size=BATCH_SIZE, shuffle=False, num_workers=2)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_model().to(device)

    # Phase 1: Train classifier head only
    for param in model.features.parameters():
        param.requires_grad = False

    optimizer = optim.Adam(model.classifier.parameters(), lr=LEARNING_RATE)
    criterion = nn.CrossEntropyLoss()

    print(f"Training on {len(train_dataset)} samples, validating on {len(val_dataset)}")
    print(f"Device: {device}")

    best_val_acc = 0.0

    for epoch in range(NUM_EPOCHS):
        model.train()
        running_loss = 0.0
        correct = 0
        total = 0

        # Unfreeze backbone after epoch 5 for fine-tuning
        if epoch == 5:
            for param in model.features.parameters():
                param.requires_grad = True
            optimizer = optim.Adam(model.parameters(), lr=FINE_TUNE_LR)
            print("Unfreezing backbone for fine-tuning")

        for images, labels in tqdm(train_loader, desc=f"Epoch {epoch+1}/{NUM_EPOCHS}"):
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            running_loss += loss.item()
            _, predicted = outputs.max(1)
            total += labels.size(0)
            correct += predicted.eq(labels).sum().item()

        train_acc = correct / total

        # Validation
        model.eval()
        val_correct = 0
        val_total = 0
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(device), labels.to(device)
                outputs = model(images)
                _, predicted = outputs.max(1)
                val_total += labels.size(0)
                val_correct += predicted.eq(labels).sum().item()

        val_acc = val_correct / val_total
        print(f"  Loss: {running_loss/len(train_loader):.4f}  Train Acc: {train_acc:.3f}  Val Acc: {val_acc:.3f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), str(output_dir / "appliance_classifier.pt"))
            print(f"  Saved best model (val_acc={val_acc:.3f})")

    # Export to ONNX
    model.eval()
    model.load_state_dict(torch.load(str(output_dir / "appliance_classifier.pt"), weights_only=True))
    model = model.to("cpu")

    dummy_input = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    onnx_path = str(output_dir / "appliance_classifier.onnx")

    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    print(f"\nExported ONNX model to {onnx_path}")
    print(f"Best validation accuracy: {best_val_acc:.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default="./models")
    train(parser.parse_args())
