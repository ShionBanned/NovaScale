# NovaScale — Real-Time WebGL2 AI Video Upscaler

[![Version](https://img.shields.io/badge/Version-3.0.0-6366f1.svg?style=for-the-badge)](https://github.com/ShionBanned/NovaScale)
[![Manifest](https://img.shields.io/badge/Manifest-V3-06b6d4.svg?style=for-the-badge)](manifest.json)
[![WebGL2](https://img.shields.io/badge/WebGL2-Zero--Copy%20GPU-8b5cf6.svg?style=for-the-badge)](#architecture--pipeline)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg?style=for-the-badge)](LICENSE)

**[English](README.md)** · **[Español](README_ES.md)**

> **Hardware-accelerated real-time super-resolution inside your browser.**  
> Powered by **AMD FidelityFX FSR 1.0 (EASU + RCAS)**, **Google RAISR**, **FSRCNN**, and a full **4-Tier Anime4K-Ultra Suite** executing natively at 60–120 FPS in WebGL2 / WebGL1.

<p align="center">
  <img src="assets/popup_en.png" alt="NovaScale UI Overview (English)" width="760">
</p>

---

## Core Engines & Upscaling Modes

NovaScale pairs two specialized GPU shader pipelines tailored for distinct content domains so anime never smears textures onto actors and cinema preserves organic film grain without cartoonish ink outlines.

### 1. Anime Studio — *Anime4K-Ultra Suite (FSR 1.0 Base)*
Every Anime Studio profile starts with an **AMD FSR 1.0 (12-Tap EASU)** directional contour base, then applies progressive line reconstruction:

| Profile | Shader Pipeline | Best Use Case | Flat / Sky Preservation |
| :--- | :--- | :--- | :---: |
| **Pure** (`anime-pure`) | FSR 1.0 EASU + Official AMD RCAS + Soft Thin AA | Classic cell animation (Studio Ghibli, 90s OVA), heavy film grain, watercolor backgrounds | Maximum (`~100%` intact) |
| **Deblur** (`anime-dbl`) *(Default)* | FSR 1.0 EASU + Sobel Line Thinning + Gated DoG + Hue Protection | Modern 1080p/720p anime streaming on YouTube, Crunchyroll, and players | High (hue & background gated) |
| **Sharp** (`anime-sharp`) | FSR 1.0 EASU + High-Frequency 9-Tap Unsharp Masking (USM) | Crisp eyes, hair strands, and detailed architecture | Moderate-High |
| **Intense** (`anime-dbh`) | FSR 1.0 EASU + Heavy Forward Warp + Deep Ink Punch | Soft or heavily compressed 480p / 360p video streams | Targeted line punch |

### 2. Cinema Pro — *Live-Action Trilogy*
| Mode | Shader Pipeline | Technical Architecture | Key Strength |
| :--- | :--- | :--- | :--- |
| **Mode A: AMD FSR 1.0** (`cinema-fsr`) | Official GPUOpen `EASU` 12-Tap + `RCAS` | Elliptical directional Lanczos filtering + contrast-adaptive sharpening | Highest spatial punch & edge clarity |
| **Mode B: Google RAISR** (`cinema-raisr`) | Continuous $C^1$ 2D Structure Tensor + Steered Anisotropic Filter | Computes orientation $\theta$, eigenvalues $\lambda_1, \lambda_2$, and coherence $\mu$ across pixel quads | Halo-free organic faces & intact film grain |
| **Mode C: FSRCNN Neural** (`cinema-fsrcnn`) | EASU Geometric Base + Symmetric Zero-Mean Convolution & PReLU | Orthogonal normal/tangent feature extraction with compression-noise coring | Aliasing-free diagonals, crisp text, zero ringing |

<p align="center">
  <img src="assets/upscaling_comparison_en.png" alt="NovaScale 2.0x Upscaling Comparison across all 7 Modes" width="900">
</p>

---

## Architecture & Pipeline

- **Zero-Copy GPU Transfer (`D3D11VA`):** Uses `UNPACK_FLIP_Y_WEBGL = false` and `gl.texImage2D` deduplication (`currentTime` gating) so sharpness sliders scrub smoothly at 120 FPS even while paused without saturating PCIe bandwidth.
- **Bit-Exact 0% Native Bypass:** When **Sharpness Intensity** is set to `0%` (and Split-Screen is off), [`content.js`](scripts/content.js) automatically restores the untouched native HTML5 `<video>` layer (`0.000` RMS delta, zero WebGL overhead under any Display Scale / DPR). Every shader also enforces an internal `<= 0.001` bypass with a smooth `0%–8%` ramp.
- **Sub-Bit Paint Keepalive:** Maintains `opacity: 0.0001` on hidden underlying videos when WebGL is active so Blink never suspends `requestVideoFrameCallback` and Windows 11 Hardware Overlay (MPO) stays cleanly bypassed.
- **Universal Player Discovery & Hot CORS Recovery:** [`injector.js`](scripts/injector.js) pierces open/closed `ShadowRoot` trees at `document_start`, sets `crossOrigin="anonymous"` before media fetches start on direct HTTP(S) streams (leaving YouTube/Twitch/Netflix MSE `blob:` streams untouched), and coordinates with [`rules.json`](rules.json) (`declarativeNetRequest`) to handle cross-origin CDNs.
- **Interactive Laser Split-Screen:** Toggle live left-vs-right comparison directly on top of any playing or paused video.

---

## Installation (Chrome / Edge / Brave)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ShionBanned/NovaScale.git
   ```
2. Open `chrome://extensions/` (or `edge://extensions/`) in your Chromium browser.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `NovaScale` root folder (containing `manifest.json`).
5. Pin **NovaScale** to your toolbar and open any YouTube, anime, or movie player.

---

## Localization (`en` / `es`)

NovaScale ships with native Chrome `chrome.i18n` localization via [`_locales/en/messages.json`](_locales/en/messages.json) (`default_locale: "en"`) and [`_locales/es/messages.json`](_locales/es/messages.json).  
The extension automatically renders in **English** or **Spanish** based on your browser UI language, with 100% pure English source code, logs, and fallback strings.

---

## Licenses & Attributions

NovaScale is open-source software released under the [**MIT License**](LICENSE).

For full upstream license texts and academic research citations — including **AMD FidelityFX FSR 1.0** (MIT), **Anime4K / Anime4K-Ultra** (MIT), **Google Research RAISR** (`arXiv:1606.01299`), and **FSRCNN** (`arXiv:1608.00367`) — please consult [**THIRD_PARTY_LICENSES.md**](THIRD_PARTY_LICENSES.md) and [**NOTICE**](NOTICE).
