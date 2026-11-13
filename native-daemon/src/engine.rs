use std::path::{Path, PathBuf};
use ndarray::Array4;
use ort::{
    DirectMLExecutionProvider, TensorRTExecutionProvider, CUDAExecutionProvider,
    Session,
};
use tracing::{info, warn};

pub struct InferenceConfig {
    pub mode: String,
    pub sharpness: f32,
}

impl Default for InferenceConfig {
    fn default() -> Self {
        Self {
            mode: "anime-dbl".to_string(),
            sharpness: 0.75,
        }
    }
}

pub struct InferenceEngine {
    models_dir: PathBuf,
    anime_session: Option<Session>,
    cinema_session: Option<Session>,
    pub backend_name: String,
}

impl InferenceEngine {
    pub fn new<P: AsRef<Path>>(models_dir: P) -> Self {
        let dir = models_dir.as_ref().to_path_buf();
        let anime_path = dir.join("apisr_anime_x2_fp16.onnx");
        let cinema_path = dir.join("span_cinema_x2_fp16.onnx");

        let (anime_session, b1) = Self::load_session(&anime_path);
        let (cinema_session, b2) = Self::load_session(&cinema_path);

        let backend_name = if anime_session.is_some() || cinema_session.is_some() {
            format!("ONNX Runtime ({})", if !b1.is_empty() { b1 } else { b2 })
        } else {
            "Passthrough (No .onnx weights loaded in models/)".to_string()
        };

        Self {
            models_dir: dir,
            anime_session,
            cinema_session,
            backend_name,
        }
    }

    fn load_session(path: &Path) -> (Option<Session>, String) {
        if !path.exists() {
            warn!("Model not found at {:?}; skipping.", path);
            return (None, String::new());
        }

        let builder = Session::builder().ok();
        let Some(builder) = builder else {
            return (None, String::new());
        };

        let (builder, backend) = match builder.with_execution_providers([
            TensorRTExecutionProvider::default()
                .with_fp16(true)
                .with_engine_cache(true)
                .build(),
            CUDAExecutionProvider::default().build(),
            DirectMLExecutionProvider::default().build(),
        ]) {
            Ok(b) => (b, "TensorRT/CUDA/DirectML".to_string()),
            Err(e) => {
                warn!("Could not enable execution providers ({}); falling back to CPU", e);
                let fallback = Session::builder().ok();
                let Some(fallback) = fallback else {
                    return (None, String::new());
                };
                (fallback, "CPU".to_string())
            }
        };

        match builder.commit_from_file(path) {
            Ok(sess) => {
                info!("Loaded ONNX model {:?} [{}]", path, backend);
                (Some(sess), backend)
            }
            Err(e) => {
                warn!("Failed to load {:?}: {}", path, e);
                (None, String::new())
            }
        }
    }

    /// Upscale an RGBA8 frame (width x height) by 2x using the active domain session.
    pub fn upscale_rgba8(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        cfg: &InferenceConfig,
    ) -> Option<(usize, usize, Vec<u8>)> {
        let is_cinema = cfg.mode.starts_with("cinema");
        let session = if is_cinema {
            self.cinema_session.as_ref().or(self.anime_session.as_ref())
        } else {
            self.anime_session.as_ref().or(self.cinema_session.as_ref())
        }?;

        if rgba.len() < width * height * 4 {
            return None;
        }

        // Convert RGBA8 -> NCHW f32 [1, 3, H, W] normalized [0, 1]
        let mut input = Array4::<f32>::zeros((1, 3, height, width));
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 4;
                input[[0, 0, y, x]] = rgba[idx] as f32 / 255.0;
                input[[0, 1, y, x]] = rgba[idx + 1] as f32 / 255.0;
                input[[0, 2, y, x]] = rgba[idx + 2] as f32 / 255.0;
            }
        }

        let outputs = session.run(ort::inputs![input].ok()?).ok()?;
        let out_tensor = outputs[0].try_extract_tensor::<f32>().ok()?;
        let view = out_tensor.view();
        let shape = view.shape();
        if shape.len() != 4 {
            return None;
        }
        let out_h = shape[2];
        let out_w = shape[3];

        let mut out_rgba = vec![255u8; out_w * out_h * 4];
        for y in 0..out_h {
            for x in 0..out_w {
                let idx = (y * out_w + x) * 4;
                out_rgba[idx] = (view[[0, 0, y, x]].clamp(0.0, 1.0) * 255.0) as u8;
                out_rgba[idx + 1] = (view[[0, 1, y, x]].clamp(0.0, 1.0) * 255.0) as u8;
                out_rgba[idx + 2] = (view[[0, 2, y, x]].clamp(0.0, 1.0) * 255.0) as u8;
                out_rgba[idx + 3] = 255;
            }
        }

        Some((out_w, out_h, out_rgba))
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }
}
