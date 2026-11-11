# Third-Party Licenses & Academic Attributions

NovaScale builds upon open-source real-time super-resolution standards and published computer vision research. Below are the full licenses and attributions for every upstream component and algorithmic formulation.

---

## 1. AMD FidelityFX Super Resolution 1.0 (FSR 1.0 — EASU & RCAS)

Used as the spatial upscaling and Contrast-Adaptive Sharpening core in Cinema Pro Mode A and as the 12-tap EASU geometric base across the Anime Studio and FSRCNN pipelines.

- **Upstream Repository:** https://github.com/GPUOpen-Effects/FidelityFX-FSR
- **License:** MIT License

```text
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 2. Anime4K & Anime4K-Ultra

NovaScale's Anime Studio 4-tier profile architecture (`Pure`, `Deblur`, `Sharp`, `Intense`) adapts Sobel edge-warping, DoG deblurring, hue protection, and dark-line ink reconstruction principles pioneered by Anime4K and structured after Anime4K-Ultra.

- **Upstream Repositories:**
  - https://github.com/bloc97/Anime4K
  - https://github.com/Th-Underscore/Anime4K-Ultra
- **License:** MIT License

```text
Copyright (c) 2019-2021 bloc97
Copyright (c) 2024 Th-Underscore (Anime4K-Ultra preset architecture)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. Google RAISR (Rapid and Accurate Image Super-Resolution) — Analytical Reimplementation

Cinema Pro Mode B (`RAISR`) is an original, clean-room analytical GLSL ES 1.00 implementation authored for NovaScale based on the mathematical Structure Tensor eigensystem ($\theta$, $\lambda_1$, $\lambda_2$, coherence $\mu$) and steered anisotropic kernel methodology described in:

- **Citation:** Yaniv Romano, John Isidoro, and Peyman Milanfar, *"RAISR: Rapid and Accurate Image Super Resolution"*, IEEE Transactions on Computational Imaging, Vol. 3, No. 1, pp. 110–125, March 2017 ([arXiv:1606.01299](https://arxiv.org/abs/1606.01299)).
- **Attribution Note:** Google LLC / Peyman Milanfar research paper reference; no proprietary Google source files are redistributed.

---

## 4. FSRCNN (Fast Super-Resolution Convolutional Neural Network) — Analytical GLSL Reimplementation

Cinema Pro Mode C (`FSRCNN`) is an original single-pass GLSL ES 1.00 neural-inspired kernel combining a continuous EASU 12-tap sub-pixel geometric base with orthogonal zero-mean feature extraction, symmetric compression-noise coring PReLU mapping, and anti-ringing clamping, inspired by:

- **Citation:** Chao Dong, Chen Change Loy, and Xiaoou Tang, *"Accelerating the Super-Resolution Convolutional Neural Network"*, European Conference on Computer Vision (ECCV), 2016 ([arXiv:1608.00367](https://arxiv.org/abs/1608.00367)).
- **Attribution Note:** Original academic publication reference; NovaScale contains independent real-time GLSL shader code authored under the MIT License.
