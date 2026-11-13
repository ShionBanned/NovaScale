# NovaScale — Escalador de Video con IA en Tiempo Real (WebGL2 & WebGPU)

[![Versión](https://img.shields.io/badge/Versi%C3%B3n-3.8.0-6366f1.svg?style=for-the-badge)](https://github.com/ShionBanned/NovaScale/releases/tag/v3.8.0)
[![Manifest](https://img.shields.io/badge/Manifest-V3-06b6d4.svg?style=for-the-badge)](manifest.json)
[![WebGL2](https://img.shields.io/badge/WebGL2-GLSL%20ES%203.00-8b5cf6.svg?style=for-the-badge)](#arquitectura-y-stack-t%C3%A9cnico)
[![WebGPU](https://img.shields.io/badge/WebGPU-WGSL%20Compute-ec4899.svg?style=for-the-badge)](#3-motor-webgpu-de-pr%C3%B3xima-generaci%C3%B3n-corewebgpu)
[![Native Daemon](https://img.shields.io/badge/Rust-DirectML%20%7C%20CUDA%20%7C%20TensorRT-f97316.svg?style=for-the-badge)](#2-daemon-nativo-de-ia-native-daemon)
[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-22c55e.svg?style=for-the-badge)](LICENSE)

**[English](README.md)** · **[Español](README_ES.md)**

> **Súper-resolución en tiempo real con calidad de estudio acelerada por GPU directamente en tu navegador.**  
> Impulsado por **WebGL2 Nativo (`#version 300 es`)**, **WebGPU de Próxima Generación (Cómputo WGSL)**, un **Daemon Nativo en Rust con IA (DirectML / TensorRT / CUDA)**, **AMD FidelityFX FSR 1.0 (EASU + RCAS)**, **Google RAISR**, **FSRCNN Neural**, **Modelos 2x APISR & SPAN**, **Restauración Multicapa (3-Pass)** y **Motor HDR Dinámico (ACES + P3)** a 60–120 FPS.

<p align="center">
  <img src="assets/popup_es.png" alt="Interfaz de NovaScale (Español)" width="760">
</p>

---

## Aspectos Destacados e Innovaciones (v3.8.0)

- **Sinergia Tri-Motor:** Alterna fluidamente entre renderizado **WebGL2** en navegador con latencia cero, **WebGPU** de cómputo directo, y el motor profundo **Daemon Nativo de Súper-Resolución IA (Rust + ONNX Runtime)**.
- **Modelos Neuronales 2x Dinámicos:** Integración nativa con **APISR** (Anime Production Inspired Real-World Super-Resolution) y **SPAN** (Swift Parameter-free Attention Network) con resolución flotante NCHW dinámica.
- **Inyector Temprano CORS en Main World (`scripts/injector.js`):** Ejecución en `document_start` dentro del entorno `MAIN`. Intercepta elementos `<video>`, perfora árboles `ShadowRoot` tanto abiertos como cerrados (`mode: 'closed'`), aplica `crossOrigin = "anonymous"` y protege streams MediaSource/MSE (YouTube, Twitch, Netflix) de fallos por firmas de CDN.
- **Visibilidad Sub-Bit y Bypass de Hardware Overlay (MPO):** Mantiene una opacidad sub-pixel (`opacity: 0.0001`) bajo la superficie WebGL/WebGPU, evitando que Chromium suspenda `requestVideoFrameCallback` (rVFC) y eliminando micro-tirones causados por Windows 11 Multi-Plane Overlay (MPO).
- **Framing WebSocket 4K de Alto Rendimiento:** Puente binario dedicado (`core/native-bridge/native-client.js`) con soporte de hasta 128 MB por trama para escalado de video 4K sin pérdida ni compresión intermedia.
- **Cortina Interactiva Láser Split-Screen:** Comparador visual en tiempo real controlado por la posición del ratón para contrastar instantáneamente la señal original frente al video procesado.

---

## Motores Principales y Perfiles de Escalado

NovaScale aísla matemáticamente los pipelines de shaders según el dominio del contenido: los algoritmos de anime nunca plastifican rostros humanos reales, y los filtros cinematográficos protegen el grano fílmico orgánico.

### 1. Anime Studio — *Suite Anime4K-Ultra (Base FSR 1.0)*
Cada perfil parte de una base direccional **AMD FSR 1.0 (12-Tap EASU)** combinada con adelgazamiento adaptativo de trazos, reducción bilateral de ruido y balance cromático:

| Perfil | Pipeline de Shader | Uso Recomendado | Preservación de Fondos y Cielos |
| :--- | :--- | :--- | :---: |
| **Fiel** (`anime-pure`) | FSR 1.0 EASU + AMD RCAS Oficial + Thin AA suave | Animación clásica (Ghibli, OVAs de los 90), grano original, fondos al óleo y acuarela | Máxima (`~100%` intacto) |
| **Deblur** (`anime-dbl`) *(Recomendado)* | FSR 1.0 EASU + Sobel Line Thinning + DoG con compuerta + Hue Gate | Anime moderno en 1080p / 720p en plataformas web y streaming | Alta (protección cromática y fondos limpios) |
| **Nitidez** (`anime-sharp`) | FSR 1.0 EASU + Unsharp Masking (USM) 9-Tap de alta frecuencia | Definición quirúrgica en ojos, cabellos finos y arquitectura | Media-Alta |
| **Intenso** (`anime-dbh`) | FSR 1.0 EASU + Forward Warp agresivo + Deep Ink Punch | Rescate de streams borrosos o altamente comprimidos en 480p / 360p | Trazos gruesos y entintado profundo |

### 2. Cinema Pro — *Trilogía para Cine y Series Reales*
| Modo | Pipeline y Matemáticas | Arquitectura Técnica | Fortaleza Clave |
| :--- | :--- | :--- | :--- |
| **Modo A: AMD FSR 1.0** (`cinema-fsr`) | GPUOpen `EASU` 12-Tap + `RCAS` oficial | Muestreo elíptico Lanczos direccional + Nitidez Adaptativa al Contraste | Máxima definición espacial y claridad en bordes |
| **Modo B: Google RAISR** (`cinema-raisr`) | Tensor de Estructura 2D continuo $C^1$ + Filtro Anisotrópico Guiado | Cálculo de orientación $\theta$, autovalores $\lambda_1, \lambda_2$ y coherencia $\mu$ | Rostros orgánicos sin halos preservando el grano fílmico |
| **Modo C: FSRCNN Neural** (`cinema-fsrcnn`) | Base geométrica EASU + Convolución Zero-Mean simétrica + PReLU | Extracción ortogonal normal/tangente con compuerta de reducción de ruido | Diagonales sin dientes de sierra, subtítulos nítidos y cero ringing |

<p align="center">
  <img src="assets/upscaling_comparison_es.png" alt="Comparativa visual 2.0x de los 7 modos de NovaScale" width="900">
</p>

---

## Arquitectura y Stack Técnico

### 1. Motor WebGL2 en Navegador (`scripts/webgl-engine.js`, `scripts/shaders.js`)
- **Pipeline FBO WebGL2 Nativo (`#version 300 es`):** Utiliza lectura entera `texelFetch` y `textureSize` en Pass 1, empaquetado de confianza estructural en Alpha (`.a`), activación `tanh()` en FSRCNN y derivadas por hardware `fwidth()` en pantalla.
- **Restauración Multicapa (3-Pass):** Pre-restauración opcional en resolución nativa (`pass0_Restore_Anime` bilateral + pre-adelgazamiento de línea; `pass0_Restore_Cinema` limpieza de macrobloques + recuperación de micro-textura) junto al refuerzo `mlBoost` en Pass 2.
- **Motor HDR Dinámico (`ACES + P3`):** Curvas tonales adaptadas por dominio (Cel S-Curve + Hue Gate para Anime; Contraste ACES Filmic + Shadow Toe para Cinema), mapeo tonal local con protección de tonos de piel y *dithering* de 10 bits por *Interleaved Gradient Noise* (`gl_FragCoord.xy`).
- **Engine B Seguro contra DRM:** Alternancia automática a filtros acelerados SVG `<feConvolveMatrix>` y `<feComponentTransfer>` en reproductores con protección DRM/Widevine (Netflix, Disney+, Max, Prime Video, Apple TV+) preservando WebGL2 de cero copia en streams abiertos.

### 2. Daemon Nativo de IA (`native-daemon/`)
Para usuarios con GPU dedicada que buscan súper-resolución por redes neuronales profundas reales:
- **Backend de Alto Rendimiento en Rust:** Desarrollado con `tokio`, `tokio-tungstenite` y `ort` (ONNX Runtime 1.18).
- **Proveedores de Ejecución (Execution Providers):**
  - **DirectML (`ort/directml`):** Aceleración por hardware sin configuración previa en cualquier GPU compatible con DirectX 12 (NVIDIA, AMD Radeon, Intel Arc).
  - **TensorRT y CUDA (`ort/tensorrt`, `ort/cuda`):** Rendimiento máximo FP16 en GPUs NVIDIA RTX.
- **Modelos Incorporados:**
  - `apisr_anime_x2_fp16.onnx`: Súper-resolución 2x optimizada para animación y estilos cel-shaded.
  - `span_cinema_x2_fp16.onnx`: Red de atención libre de parámetros (SPAN) 2x para imagen real y cine.
- **Streaming 4K a 128 MB:** Paquetes binarios nativos `[u32 width][u32 height][RGBA8 payload]` a través de `ws://127.0.0.1:19480/novascale-stream`.

### 3. Motor WebGPU de Próxima Generación (`core/webgpu/`)
- Shaders de cómputo y fragmento puros en **WGSL** que ejecutan operaciones rasterizadas directas sobre el silicio de la GPU sin sobrecarga de traducción GLSL.

---

## Instalación y Configuración

### Instalación de la Extensión (Chrome / Edge / Brave / Opera / Vivaldi)
1. Clona o descarga este repositorio:
   ```bash
   git clone https://github.com/ShionBanned/NovaScale.git
   ```
2. Abre la gestión de extensiones de tu navegador (`chrome://extensions/` o `edge://extensions/`).
3. Activa el **Modo de desarrollador** en la esquina superior derecha.
4. Haz clic en **Cargar descomprimida** y selecciona la carpeta raíz de `NovaScale` (donde reside `manifest.json`).
5. Fija **NovaScale** en la barra de herramientas del navegador.

### (Opcional) Ejecución del Daemon Nativo con IA
Para desbloquear la súper-resolución profunda por APISR / SPAN:
1. Asegúrate de tener [Rust](https://rustup.rs/) instalado.
2. Abre una terminal en el directorio `native-daemon/`:
   ```powershell
   cd native-daemon
   cargo run --release --features directml
   ```
3. El daemon escuchará en `ws://127.0.0.1:19480/novascale-stream`. La extensión se conectará automáticamente y enviará los frames cuando actives Deep Mode.

---

## Diagnóstico y Pruebas

NovaScale incluye una suite de diagnóstico integrada. Abre [diag.html](diag.html) directamente en tu navegador para verificar:
- Compatibilidad y soporte de extensiones en WebGL2 y WebGPU.
- Conectividad y latencia de ida y vuelta con el Daemon Nativo por WebSocket.
- Perfiles de color y compatibilidad con el motor HDR ACES/P3.

---

## Internacionalización (`en` / `es`)

NovaScale incluye soporte nativo Chromium (`chrome.i18n`) mediante:
- [`_locales/en/messages.json`](_locales/en/messages.json) (Inglés — Predeterminado)
- [`_locales/es/messages.json`](_locales/es/messages.json) (Español)

---

## Licencia y Reconocimientos

NovaScale es software libre publicado bajo la [**Licencia MIT**](LICENSE).

Reconocimientos y citas de investigación académica upstream:
- **AMD FidelityFX FSR 1.0 (EASU + RCAS):** GPUOpen (Licencia MIT)
- **Anime4K & Anime4K-Ultra Suite:** bloc97 (Licencia MIT)
- **Google Research RAISR:** Romano, Isidoro, y Milanfar (`arXiv:1606.01299`)
- **FSRCNN:** Dong, Loy, y Tang (`arXiv:1608.00367`)
- **APISR:** Kiteretsu77 (`arXiv:2403.01598`)
- **SPAN:** Yuan, et al. (`arXiv:2404.14869`)

Para consultar todos los textos de licencias de terceros, revisa [**THIRD_PARTY_LICENSES.md**](THIRD_PARTY_LICENSES.md) y [**NOTICE**](NOTICE).