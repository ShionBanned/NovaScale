# NovaScale Sprint 3 — Native AI Sidecar Daemon

Out-of-process Rust + ONNX Runtime daemon supporting **TensorRT FP16**, **CUDA**, and **DirectML** on Windows/Linux.

## Quick Start (Windows 11 / RTX 3050)
1. Install [Rust](https://rustup.rs/).
2. Place your exported ONNX models in `native-daemon/models/`:
   - `apisr_anime_x2_fp16.onnx` (Anime Studio)
   - `span_cinema_x2_fp16.onnx` (Cinema Pro)
3. Build & run with DirectML (zero CUDA setup required) or TensorRT:
   ```powershell
   cd native-daemon
   cargo run --release --features directml
   ```
4. The daemon listens on `ws://127.0.0.1:19480/novascale-stream` for `core/native-bridge/native-client.js`.

## Exporting `.pth` Checkpoints to Dynamic ONNX (`export_onnx.py`)
```powershell
pip install torch onnx
# Anime (APISR)
python export_onnx.py --arch apisr --repo-dir C:\path\to\APISR --weights 2x_APISR.pth --out models\apisr_anime_x2_fp16.onnx
# Cinema (SPAN)
python export_onnx.py --arch span --repo-dir C:\path\to\SPAN --weights spanx2_ch48.pth --out models\span_cinema_x2_fp16.onnx
```
