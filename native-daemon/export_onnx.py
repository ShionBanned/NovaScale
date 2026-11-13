#!/usr/bin/env python3
"""
NovaScale Sprint 3 - PyTorch (.pth) -> Dynamic ONNX Exporter
Exports APISR (Anime) or SPAN (Cinema) checkpoints with dynamic H/W axes
and float32 NCHW [1, 3, H, W] -> [1, 3, 2H, 2W] I/O compatible with native-daemon.
"""

import argparse
import sys
from pathlib import Path
import torch


def load_state_dict_clean(weights_path: Path):
    ckpt = torch.load(weights_path, map_location="cpu", weights_only=True)
    if isinstance(ckpt, dict):
        for key in ("params_ema", "params", "state_dict", "model", "netG"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]
                break
    return {k.replace("module.", ""): v for k, v in ckpt.items()}


def build_model(arch: str, scale: int, repo_dir: Path | None):
    if repo_dir is not None:
        sys.path.insert(0, str(repo_dir.resolve()))

    if arch == "apisr":
        try:
            from architecture.rrdb import RRDBNet  # Kiteretsu77/APISR
            return RRDBNet(in_nc=3, out_nc=3, nf=64, nb=6, gc=32, scale=scale)
        except ImportError:
            try:
                from basicsr.archs.rrdbnet_arch import RRDBNet
                return RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=6, num_grow_ch=32, scale=scale)
            except ImportError as exc:
                raise RuntimeError(
                    "Could not import APISR/RRDBNet. Pass --repo-dir pointing to cloned Kiteretsu77/APISR."
                ) from exc

    if arch == "span":
        try:
            from models.team00_SPAN import SPAN  # hongyuanyu/SPAN
            return SPAN(num_in_ch=3, num_out_ch=3, feature_channels=48, upscale=scale)
        except ImportError:
            try:
                from basicsr.archs.span_arch import SPAN
                return SPAN(num_in_ch=3, num_out_ch=3, feature_channels=48, upscale=scale)
            except ImportError as exc:
                raise RuntimeError(
                    "Could not import SPAN. Pass --repo-dir pointing to cloned hongyuanyu/SPAN."
                ) from exc

    raise ValueError(f"Unsupported arch: {arch}")


def main():
    parser = argparse.ArgumentParser(description="Export APISR / SPAN .pth weights to dynamic ONNX")
    parser.add_argument("--arch", required=True, choices=["apisr", "span"], help="Model architecture")
    parser.add_argument("--weights", required=True, type=Path, help="Path to .pth checkpoint")
    parser.add_argument("--out", required=True, type=Path, help="Output .onnx path")
    parser.add_argument("--scale", type=int, default=2, help="Upscale factor (default: 2)")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version (default: 17)")
    parser.add_argument("--repo-dir", type=Path, default=None, help="Optional path to cloned model repo")
    args = parser.parse_args()

    if not args.weights.exists():
        sys.exit(f"Error: weights file not found: {args.weights}")

    args.out.parent.mkdir(parents=True, exist_ok=True)

    model = build_model(args.arch, args.scale, args.repo_dir)
    state = load_state_dict_clean(args.weights)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"[Warn] Missing keys ({len(missing)}): {missing[:5]}")
    if unexpected:
        print(f"[Warn] Unexpected keys ({len(unexpected)}): {unexpected[:5]}")

    model.eval()
    dummy = torch.randn(1, 3, 256, 256, dtype=torch.float32)

    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            str(args.out),
            export_params=True,
            opset_version=args.opset,
            do_constant_folding=True,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={
                "input": {2: "height", 3: "width"},
                "output": {2: "out_height", 3: "out_width"},
            },
        )

    print(f"[OK] Exported dynamic ONNX model to: {args.out}")


if __name__ == "__main__":
    main()
