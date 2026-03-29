"""
Trains an audio anomaly detection classifier for appliance sounds.

Usage:
    python scripts/train_audio_model.py --data-dir ./data --output-dir ./models

Expects:
    - data/audio_clips/ directory with subdirectories per class:
        data/audio_clips/
          normal_operation/
          grinding_noise/
          clicking_noise/
          humming_noise/
          buzzing_noise/
          rattling_noise/
          squealing_noise/
          banging_noise/
          water_noise/
          vibrating/

Produces:
    - models/audio_anomaly.onnx
"""

import argparse
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

AUDIO_CLASSES = [
    "normal_operation", "grinding_noise", "clicking_noise", "humming_noise",
    "buzzing_noise", "rattling_noise", "squealing_noise", "banging_noise",
    "water_noise", "vibrating",
]
CLASS_TO_IDX = {c: i for i, c in enumerate(AUDIO_CLASSES)}
NUM_CLASSES = len(AUDIO_CLASSES)

SAMPLE_RATE = 16000
N_MELS = 64
FEATURE_DIM = N_MELS * 4  # mean, std, max, delta per mel band = 256


def compute_mel_features(audio_path: str) -> np.ndarray | None:
    """Extracts mel-spectrogram summary features from a WAV file."""
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=SAMPLE_RATE, mono=True)
        if len(y) < SAMPLE_RATE:
            return None

        mel_spec = librosa.feature.melspectrogram(
            y=y, sr=sr, n_mels=N_MELS, fmin=0, fmax=8000,
            n_fft=512, hop_length=256,
        )
        log_mel = np.log(np.maximum(mel_spec, 1e-10))

        features = np.zeros(FEATURE_DIM, dtype=np.float32)
        features[:N_MELS] = log_mel.mean(axis=1)
        features[N_MELS:2*N_MELS] = log_mel.std(axis=1)
        features[2*N_MELS:3*N_MELS] = log_mel.max(axis=1)
        if log_mel.shape[1] > 1:
            deltas = np.abs(np.diff(log_mel, axis=1)).mean(axis=1)
            features[3*N_MELS:4*N_MELS] = deltas

        return features
    except Exception as e:
        print(f"  Warning: Failed to process {audio_path}: {e}")
        return None


class AudioDataset(Dataset):
    def __init__(self, data_dir: str):
        self.samples = []
        clips_dir = Path(data_dir) / "audio_clips"

        for class_name in AUDIO_CLASSES:
            class_dir = clips_dir / class_name
            if not class_dir.exists():
                continue
            for audio_file in class_dir.glob("*.wav"):
                features = compute_mel_features(str(audio_file))
                if features is not None:
                    self.samples.append((features, CLASS_TO_IDX[class_name]))

        print(f"Loaded {len(self.samples)} audio samples")
        class_counts = {}
        for _, label in self.samples:
            name = AUDIO_CLASSES[label]
            class_counts[name] = class_counts.get(name, 0) + 1
        for name, count in sorted(class_counts.items()):
            print(f"  {name}: {count}")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        features, label = self.samples[idx]
        return torch.FloatTensor(features), label


class AudioClassifier(nn.Module):
    def __init__(self, input_dim, num_classes):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.BatchNorm1d(128),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.BatchNorm1d(64),
            nn.Dropout(0.2),
            nn.Linear(64, num_classes),
        )

    def forward(self, x):
        return self.net(x)


def train(args):
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    dataset = AudioDataset(str(data_dir))
    if len(dataset) == 0:
        print("No audio training data found.")
        print(f"Place WAV files in {data_dir}/audio_clips/{{class_name}}/ directories.")
        return

    val_size = max(1, int(len(dataset) * 0.15))
    train_size = len(dataset) - val_size
    train_dataset, val_dataset = torch.utils.data.random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(train_dataset, batch_size=32, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=32, shuffle=False)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = AudioClassifier(FEATURE_DIM, NUM_CLASSES).to(device)
    optimizer = optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss()

    best_val_acc = 0.0

    for epoch in range(args.epochs):
        model.train()
        running_loss = 0
        correct = 0
        total = 0

        for features, labels in train_loader:
            features, labels = features.to(device), labels.to(device)
            optimizer.zero_grad()
            outputs = model(features)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            running_loss += loss.item()
            _, pred = outputs.max(1)
            total += labels.size(0)
            correct += pred.eq(labels).sum().item()

        model.eval()
        val_correct = 0
        val_total = 0
        with torch.no_grad():
            for features, labels in val_loader:
                features, labels = features.to(device), labels.to(device)
                outputs = model(features)
                _, pred = outputs.max(1)
                val_total += labels.size(0)
                val_correct += pred.eq(labels).sum().item()

        val_acc = val_correct / max(1, val_total)
        if (epoch + 1) % 5 == 0:
            print(f"Epoch {epoch+1}/{args.epochs}  loss={running_loss/len(train_loader):.4f}  "
                  f"train_acc={correct/total:.3f}  val_acc={val_acc:.3f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), str(output_dir / "audio_anomaly.pt"))

    # Export to ONNX
    model.load_state_dict(torch.load(str(output_dir / "audio_anomaly.pt"), weights_only=True))
    model = model.to("cpu").eval()

    dummy = torch.randn(1, FEATURE_DIM)
    onnx_path = str(output_dir / "audio_anomaly.onnx")
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    print(f"\nExported ONNX model to {onnx_path}")
    print(f"Best validation accuracy: {best_val_acc:.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--output-dir", default="./models")
    parser.add_argument("--epochs", type=int, default=50)
    train(parser.parse_args())
