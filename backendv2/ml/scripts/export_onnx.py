"""
Validates and optionally simplifies ONNX models before deployment.

Usage:
    python scripts/export_onnx.py --model-path ./models/appliance_classifier.onnx [--simplify]
"""

import argparse
from pathlib import Path

import onnx
import onnxruntime as ort
import numpy as np


def validate_model(model_path: str, simplify: bool = False):
    path = Path(model_path)
    if not path.exists():
        print(f"Model not found: {model_path}")
        return

    print(f"Loading model: {model_path}")
    model = onnx.load(model_path)

    print("Checking model validity...")
    onnx.checker.check_model(model)
    print("  Model is valid")

    print(f"  IR version: {model.ir_version}")
    print(f"  Opset: {[o.version for o in model.opset_import]}")

    print("\nInputs:")
    for inp in model.graph.input:
        shape = [d.dim_value or d.dim_param for d in inp.type.tensor_type.shape.dim]
        print(f"  {inp.name}: {shape}")

    print("\nOutputs:")
    for out in model.graph.output:
        shape = [d.dim_value or d.dim_param for d in out.type.tensor_type.shape.dim]
        print(f"  {out.name}: {shape}")

    if simplify:
        try:
            import onnxsim
            print("\nSimplifying model...")
            simplified, check = onnxsim.simplify(model)
            if check:
                simplified_path = str(path.with_suffix("")) + "_simplified.onnx"
                onnx.save(simplified, simplified_path)
                original_size = path.stat().st_size / 1024 / 1024
                simplified_size = Path(simplified_path).stat().st_size / 1024 / 1024
                print(f"  Saved simplified model: {simplified_path}")
                print(f"  Size: {original_size:.1f}MB → {simplified_size:.1f}MB")
            else:
                print("  Simplification check failed, keeping original")
        except ImportError:
            print("  onnx-simplifier not installed, skipping")

    # Test inference
    print("\nTesting inference with ONNX Runtime...")
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_info = session.get_inputs()[0]
    shape = [d if isinstance(d, int) else 1 for d in input_info.shape]
    dummy = np.random.randn(*shape).astype(np.float32)

    outputs = session.run(None, {input_info.name: dummy})
    print(f"  Output shape: {outputs[0].shape}")
    print(f"  Output range: [{outputs[0].min():.4f}, {outputs[0].max():.4f}]")
    print("\nModel is ready for deployment.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--simplify", action="store_true")
    args = parser.parse_args()
    validate_model(args.model_path, args.simplify)
