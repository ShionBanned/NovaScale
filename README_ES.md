# NovaScale — Escalador de Video con IA en Tiempo Real (WebGL2)

[![Version](https://img.shields.io/badge/Version-3.0.0-6366f1.svg?style=for-the-badge)](https://github.com/ShionBanned/NovaScale)
[![Manifest](https://img.shields.io/badge/Manifest-V3-06b6d4.svg?style=for-the-badge)](manifest.json)
[![WebGL2](https://img.shields.io/badge/WebGL2-Zero--Copy%20GPU-8b5cf6.svg?style=for-the-badge)](#arquitectura-y-pipeline)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg?style=for-the-badge)](LICENSE)

**[English](README.md)** · **[Español](README_ES.md)**

> **Súper-resolución en tiempo real acelerada por GPU directamente en tu navegador.**  
> Impulsado por **AMD FidelityFX FSR 1.0 (EASU + RCAS)**, **Google RAISR**, **FSRCNN** y una completa **Suite Anime4K-Ultra de 4 niveles** operando a 60–120 FPS en WebGL2 / WebGL1.

<p align="center">
  <img src="assets/popup_es.png" alt="Interfaz de NovaScale (Español)" width="760">
</p>

---

## Motores Principales y Modos de Escalado

NovaScale integra dos arquitecturas de shaders especializadas para cada tipo de contenido: los filtros de anime nunca plastifican los rostros del cine real, y los modos de cine preservan el grano fílmico sin generar contornos artificiales.

### 1. Anime Studio — *Suite Anime4K-Ultra (Base FSR 1.0)*
Cada perfil de **Anime Studio** parte de una reconstrucción direccional **AMD FSR 1.0 (EASU 12-Tap)** y aplica reconstrucción selectiva de trazos:

| Perfil | Pipeline de Shader | Uso Recomendado | Preservación de Fondos / Cielo |
| :--- | :--- | :--- | :---: |
| **Fiel** (`anime-pure`) | FSR 1.0 EASU + AMD RCAS Oficial + Thin AA suave | Animación clásica (Ghibli, OVAs de los 90), grano original, fondos al óleo y acuarela | Máxima (`~100%` intacto) |
| **Deblur** (`anime-dbl`) *(Recomendado)* | FSR 1.0 EASU + Line Thinning Sobel + DoG con compuerta + Hue Protection | Anime moderno en 1080p / 720p en streaming | Alta (protección cromática y de fondos) |
| **Nitidez** (`anime-sharp`) | FSR 1.0 EASU + Unsharp Masking (USM) 9-Tap de alta frecuencia | Definición extrema en ojos, cabello fino y arquitectura | Media-Alta |
| **Intenso** (`anime-dbh`) | FSR 1.0 EASU + Forward Warp agresivo + Deep Ink Punch | Rescate de streams borrosos en baja resolución (480p / 360p) | Entintado profundo en trazos |

### 2. Cinema Pro — *Trilogía para Cine y Series Reales*
| Modo | Pipeline de Shader | Arquitectura Técnica | Fortaleza Clave |
| :--- | :--- | :--- | :--- |
| **Modo A: AMD FSR 1.0** (`cinema-fsr`) | GPUOpen `EASU` 12-Tap + `RCAS` oficial | Muestreo elíptico Lanczos direccional + contraste adaptativo | Máxima nitidez espacial y mordida en detalles |
| **Modo B: Google RAISR** (`cinema-raisr`) | Tensor de Estructura 2D continuo $C^1$ + Filtro Anisotrópico Guiado | Calcula ángulo $\theta$, autovalores $\lambda_1, \lambda_2$ y coherencia $\mu$ | Rostros orgánicos sin halos respetando el grano fílmico |
| **Modo C: FSRCNN Neural** (`cinema-fsrcnn`) | Base geométrica EASU + Convolución Zero-Mean y PReLU simétrica | Extracción ortogonal normal/tangente con compuerta anti-ruido de compresión | Diagonales sin dientes de sierra, texto limpio y cero *ringing* |

<p align="center">
  <img src="assets/upscaling_comparison_es.png" alt="Comparativa visual 2.0x de los 7 modos de NovaScale" width="900">
</p>

---

## Arquitectura y Pipeline Técnico

- **Transferencia Zero-Copy en GPU (`D3D11VA`):** Emplea `UNPACK_FLIP_Y_WEBGL = false` y deduplicación inteligente de `gl.texImage2D` (vía `currentTime`) para mover sliders a 120 FPS incluso en pausa sin saturar el bus PCIe.
- **Bypass Nativo Exacto en `0%`:** Cuando **Intensidad de Nitidez** está en `0%` (y Split-Screen apagado), [`content.js`](scripts/content.js) oculta el overlay `<canvas>` y muestra el `<video>` nativo intacto (`RMS = 0.000` bajo cualquier escala DPI de Windows, cero suavizado de compositor y `0%` uso extra de GPU). Además, todos los shaders cuentan con bypass interno y rampa progresiva `0%–8%`.
- **Mantenimiento Sub-Bit (`opacity: 0.0001`):** Evita que el motor Blink suspenda `requestVideoFrameCallback` en YouTube y desactiva conflictos con el Hardware Overlay (MPO) en Windows 11.
- **Descubrimiento Universal y Rescate CORS:** [`injector.js`](scripts/injector.js) perfora `ShadowRoot` abiertos o cerrados desde `document_start`, aplica `crossOrigin="anonymous"` a streams HTTP(S) directos sin interferir con blobs MSE (`YouTube/Twitch/Netflix`) y coopera con [`rules.json`](rules.json) (`declarativeNetRequest`) para CDNs externos.
- **Comparación Láser Split-Screen:** División interactiva original (izquierda) vs procesado (derecha) en tiempo real.

---

## Instalación (Chrome / Edge / Brave)

1. Clona o descarga este repositorio:
   ```bash
   git clone https://github.com/ShionBanned/NovaScale.git
   ```
2. Abre `chrome://extensions/` (o `edge://extensions/`) en tu navegador.
3. Activa el **Modo de desarrollador** en la esquina superior derecha.
4. Haz clic en **Cargar descomprimida** (*Load unpacked*) y selecciona la carpeta raíz de `NovaScale` (donde está `manifest.json`).
5. Fija **NovaScale** en tu barra y reproduce cualquier video en YouTube, anime o cine.

---

## Localización Automática (`en` / `es`)

NovaScale utiliza localización nativa `chrome.i18n` mediante [`_locales/en/messages.json`](_locales/en/messages.json) (`default_locale: "en"`) y [`_locales/es/messages.json`](_locales/es/messages.json).  
La interfaz se adapta automáticamente al idioma de Chrome (**Inglés** o **Español**), manteniendo todo el código fuente, comentarios y logs 100% en inglés.

---

## Licencias y Atribuciones

NovaScale se distribuye como software libre bajo la [**Licencia MIT**](LICENSE).

Los textos completos de licencia y citas académicas de algoritmos base — **AMD FidelityFX FSR 1.0** (MIT), **Anime4K / Anime4K-Ultra** (MIT), **Google Research RAISR** (`arXiv:1606.01299`) y **FSRCNN** (`arXiv:1608.00367`) — se encuentran detallados en [**THIRD_PARTY_LICENSES.md**](THIRD_PARTY_LICENSES.md) y [**NOTICE**](NOTICE).
