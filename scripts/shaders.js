/**
 * NovaScale - GLSL ES 3.00 Shader Suite v8.0 (Native WebGL2 2-Pass & 3-Pass Super-Resolution)
 *
 * Dual/Triple-Pass WebGL2 Pipeline (#version 300 es):
 * 1. vertexShader        : Emits both v_uv (top=0 for UNPACK_FLIP_Y=false video Texture0)
 *                          and v_fboUv (top=1 for upright offscreen FBO Texture1/Texture2).
 * 2. passthroughFrag     : Single-pass direct passthrough + split-screen & HDR at 0% sharpness.
 * 3. pass0_Restore_*     : Layer-0 native-grid pre-restoration (Anime / Cinema).
 * 4. pass1_EASU / RAISR  : Exact integer texelFetch 12-tap spatial upscalers + Alpha (.a) map.
 * 5. Pass-2 Refiners     : 7 specialized modes + independent Deep AI Deconvolution (u_deepIntensity) +
 *                          Dynamic Fake HDR (ACES + P3 + H-K Specular + IGN 10-bit dithering).
 */

const NOVA_HDR_GLSL = `
  uniform float u_hdr;
  uniform float u_frameIndex;

  float novaDither10Bit() {
    vec2 seed = gl_FragCoord.xy + vec2(u_frameIndex * 0.75487766, u_frameIndex * 0.56984029);
    float n = fract(52.9829189 * fract(dot(seed, vec2(0.06711056, 0.00583715))));
    return (n - 0.5) / 512.0;
  }

  float novaFilmGrain(vec2 fragCoord, float frameIdx) {
    vec3 p3 = fract(vec3(fragCoord, frameIdx * 1.37) * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    float n1 = fract((p3.x + p3.y) * p3.z);
    vec3 q3 = fract(vec3(fragCoord + 17.0, frameIdx * 2.13) * 0.1031);
    q3 += dot(q3, q3.zyx + 31.32);
    float n2 = fract((q3.x + q3.y) * q3.z);
    return (n1 + n2 - 1.0);
  }

  // Fast 1-cycle polynomial gamma 2.2 linearization for ambient sensors (eliminates 24 pow() calls/px)
  float getLinearLuma(vec3 srgb) {
    vec3 s = clamp(srgb, 0.0, 1.0);
    vec3 lin = s * s * (0.72 + 0.28 * s);
    return dot(lin, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 applyNovaHDR(vec3 col, vec2 uv, sampler2D refTex, vec2 refStep) {
    if (u_hdr < 0.5) {
      float lumaBase = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float dMask = step(0.003, lumaBase);
      return clamp(col + vec3(novaDither10Bit() * dMask), 0.0, 1.0);
    }

    vec3 c = clamp(col, 0.0, 1.0);
    vec3 lin = pow(max(c, vec3(1e-5)), vec3(2.2));
    float Y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
    if (Y <= 0.00005) return vec3(0.0);

    float Ls     = pow(Y, 1.0 / 2.2);
    float peakCh = max(c.r, max(c.g, c.b));
    float minCh  = min(c.r, min(c.g, c.b));
    float srcSat = peakCh - minCh;

    // 1. Resolution-Invariant Dual-Scale Radiosity: Micro-Texture (3.0px) + Macro Local-Dimming Zone (13.0px)
    vec2 baseStep = max(refStep, u_texelSize * 0.75);
    vec2 dMicro = baseStep * 3.0;
    vec2 dMacro = baseStep * 13.0;

    float Y_m1 = getLinearLuma(texture(refTex, uv + vec2(-dMicro.x, -dMicro.y)).rgb);
    float Y_m2 = getLinearLuma(texture(refTex, uv + vec2( dMicro.x, -dMicro.y)).rgb);
    float Y_m3 = getLinearLuma(texture(refTex, uv + vec2(-dMicro.x,  dMicro.y)).rgb);
    float Y_m4 = getLinearLuma(texture(refTex, uv + vec2( dMicro.x,  dMicro.y)).rgb);
    float Y_micro  = (Y_m1 + Y_m2 + Y_m3 + Y_m4) * 0.25;
    float Ls_micro = pow(max(Y_micro, 1e-5), 1.0 / 2.2);

    float Y_M1 = getLinearLuma(texture(refTex, uv + vec2( 0.0,      -dMacro.y)).rgb);
    float Y_M2 = getLinearLuma(texture(refTex, uv + vec2( 0.0,       dMacro.y)).rgb);
    float Y_M3 = getLinearLuma(texture(refTex, uv + vec2(-dMacro.x,  0.0)).rgb);
    float Y_M4 = getLinearLuma(texture(refTex, uv + vec2( dMacro.x,  0.0)).rgb);
    float Y_macro  = (Y_M1 + Y_M2 + Y_M3 + Y_M4) * 0.25;
    float Ls_macro = pow(max(Y_macro, 1e-5), 1.0 / 2.2);

    float Ls_loc = mix(Ls_micro, Ls_macro, 0.45);

    // Skin-tone protection mask
    float cSkin = clamp(1.0 - abs(c.r - c.g * 1.25) * 3.0, 0.0, 1.0)
                * step(c.b, c.g)
                * step(0.12, c.r);

    // SURGICAL WHITE GUARD:
    // Distinguishes broad bright surfaces (white fur/snow/clouds where BOTH Ls and Ls_micro are high)
    // from isolated specular glints, and monitors single-channel RGB ceiling (peakCh).
    float broadWhiteMask = smoothstep(0.74, 0.88, Ls) * smoothstep(0.68, 0.85, Ls_micro);
    float channelCeiling = smoothstep(0.84, 0.97, peakCh);
    float upwardGuard    = max(broadWhiteMask * 0.88, channelCeiling * 0.92);

    // 2. OLED Deep Black Toe with Dynamic Macro Local-Dimming + S-Curve Contrast
    float hermite   = Ls * Ls * (3.0 - 2.0 * Ls);
    float sStrength = (u_hdr < 1.5) ? 0.36 : 0.30;
    float upperDamp = (Ls > 0.5) ? (1.0 - upwardGuard) : 1.0;
    float contrastL = mix(Ls, hermite, sStrength * upperDamp);

    float macroDarkness = 1.0 - smoothstep(0.05, 0.32, Ls_macro);
    float toeFloor  = ((u_hdr < 1.5) ? 0.84 : 0.86) - (macroDarkness * 0.04);
    float shadowToe = mix(toeFloor, 1.0, smoothstep(0.01, 0.22, Ls));
    float baseL     = contrastL * shadowToe;

    // 3. Helmholtz-Kohlrausch (H-K) Psychovisual Specular Inverse Tone Mapping
    float hkPerceptualLuma = max(Ls, mix(Ls, peakCh, srcSat * 0.65));
    float specBell = smoothstep(0.54, 0.85, hkPerceptualLuma) * smoothstep(0.995, 0.85, Ls);
    float contrastWithMacro = clamp(hkPerceptualLuma - Ls_macro, 0.0, 0.5) * 0.35;
    float specPop  = specBell * (((u_hdr < 1.5) ? 0.085 : 0.070) + contrastWithMacro * 0.04)
                   * (1.0 - cSkin * 0.55) * (1.0 - upwardGuard);
    float Ls_out   = clamp(baseL + specPop, 0.0, 1.0);

    // 4. Dual-Scale Asymmetric Shadow/Highlight Separation + White Texture Micro-Carving
    float diffMicro = Ls - Ls_micro;
    float diffMacro = Ls - Ls_macro;
    float diffL     = mix(diffMicro, diffMacro, 0.35);

    float reliefGate     = smoothstep(0.005, 0.038, abs(diffMicro));
    float darkSceneBoost = 1.0 + (1.0 - smoothstep(0.05, 0.35, Ls_loc)) * 0.58;
    float posGuard       = 1.0 - max(broadWhiteMask, channelCeiling) * 0.85;
    float negWhiteCarve  = 1.0 + broadWhiteMask * 0.48;

    float ltmGain = (diffL >= 0.0)
      ? (((u_hdr < 1.5) ? 0.32 : 0.28) * darkSceneBoost * posGuard)
      : (((u_hdr < 1.5) ? 0.26 : 0.22) * negWhiteCarve);
    float localContrast = clamp(diffMicro * ltmGain * reliefGate * (1.0 - cSkin * 0.70), -0.08, 0.10);
    Ls_out = clamp(Ls_out + localContrast, 0.0, 1.0);

    // 5. Linear Chromatic Scaling capped by real per-channel headroom
    float Y_out        = pow(max(Ls_out, 1e-5), 2.2);
    float rawScale     = clamp(Y_out / max(Y, 1e-5), 0.52, 1.85);
    float maxLinCh     = pow(max(peakCh, 1e-5), 2.2);
    float safeMaxScale = (maxLinCh > 0.65) ? mix(1.85, 1.0 / max(maxLinCh, 1e-4), smoothstep(0.65, 0.94, peakCh)) : 1.85;
    float lumScale     = (rawScale > 1.0) ? min(rawScale, max(1.0, safeMaxScale)) : rawScale;
    vec3 linHdr        = lin * lumScale;

    vec3 compressed = linHdr / (1.0 + max(linHdr - vec3(0.82), vec3(0.0)) * 0.55);
    float maxCh     = max(linHdr.r, max(linHdr.g, linHdr.b));
    vec3 finalLin   = (maxCh > 0.85) ? mix(linHdr, compressed, smoothstep(0.85, 1.25, maxCh)) : linHdr;

    vec3 mappedRgb = pow(max(clamp(finalLin, 0.0, 1.0), vec3(1e-5)), vec3(1.0 / 2.2));

    // 6. Deep Shadow Chroma Cleanse + Rich P3 Vibrance with Neutral-White Purity Lock
    float maxC = max(mappedRgb.r, max(mappedRgb.g, mappedRgb.b));
    float minC = min(mappedRgb.r, min(mappedRgb.g, mappedRgb.b));
    float sat  = maxC - minC;

    float whitePurityGuard = smoothstep(0.75, 0.88, Ls_out) * (1.0 - smoothstep(0.03, 0.12, srcSat));
    float satWindow        = smoothstep(0.03, 0.14, sat) * (1.0 - smoothstep(0.48, 0.84, sat));
    float shadowCleanse    = smoothstep(0.015, 0.055, Ls_out);
    float lumaMask         = shadowCleanse * (1.0 - smoothstep(0.82, 0.96, Ls_out) * 0.75);
    float vibStrength      = (u_hdr < 1.5) ? 0.24 : 0.20;
    float vibBoost         = satWindow * lumaMask * (1.0 - cSkin * 0.85) * (1.0 - whitePurityGuard) * vibStrength;

    float lumaNew    = dot(mappedRgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 vibrant     = mix(vec3(lumaNew), mappedRgb, mix(0.92, 1.0 + vibBoost, shadowCleanse));
    float ditherMask = step(0.003, lumaNew);

    return clamp(vibrant + vec3(novaDither10Bit() * ditherMask), 0.0, 1.0);
  }
`;

const NOVA_SPLIT_PASS2 = `
  if (u_splitPos >= 0.0) {
    float lw = max(u_outTexelSize.x * 2.5, 0.0022);
    float dist = abs(v_fboUv.x - u_splitPos);
    if (dist < lw) {
      float glow = 1.0 - (dist / lw);
      fragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), glow * 0.75), 1.0);
      return;
    }
    if (v_fboUv.x < u_splitPos) {
      fragColor = texture(u_texture, v_uv);
      return;
    }
  }
`;

const NOVA_PASS2_HEADER = `#version 300 es
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  in vec2 v_uv;
  in vec2 v_fboUv;
  out vec4 fragColor;

  uniform sampler2D u_texture;
  uniform sampler2D u_upscaledTex;
  uniform vec2      u_texelSize;
  uniform vec2      u_outTexelSize;
  uniform float     u_sharpness;
  uniform float     u_deepIntensity;
  uniform float     u_splitPos;
  uniform float     u_multiLayer;
  uniform float     u_deepMode;
  ${NOVA_HDR_GLSL}

  vec3 applyCinemaGrain(vec3 col, float sharp) {
    float eff = max(sharp, u_deepMode * u_deepIntensity);
    if (eff <= 0.05) return col;
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float bell = smoothstep(0.04, 0.24, luma) * (1.0 - smoothstep(0.68, 0.94, luma));
    float boost = (u_multiLayer > 0.5 || u_deepMode > 0.5) ? 0.0085 : 0.0052;
    float g = novaFilmGrain(gl_FragCoord.xy, u_frameIndex) * (boost * bell * eff);
    return clamp(col + vec3(g), 0.0, 1.0);
  }

  float getLumaRec601(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }
  float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

  // Resolution-Invariant Sampling Stride: spans the full source blur ramp at 1080p, 1440p, or 4K
  vec2 getAdaptiveStep(float factor) {
    vec2 scaleRatio = clamp(u_texelSize / max(u_outTexelSize, vec2(1e-6)), vec2(1.0), vec2(4.0));
    vec2 srcTexel   = u_outTexelSize * scaleRatio;
    float blend     = clamp(0.45 + 0.48 * factor, 0.0, 1.0);
    return mix(u_outTexelSize, srcTexel, blend);
  }

  // Hardware screen-space derivative edge detector sensitive to 480p/720p/1080p soft ramps
  float getSubpxEdge(vec3 c) {
    float fw = length(fwidth(c));
    float mlScale = 1.0 + 0.18 * clamp(u_multiLayer, 0.0, 1.0);
    return clamp(smoothstep(0.006, 0.080, fw) * mlScale, 0.0, 1.0);
  }

  // True 2-Sided Line Valley Detector: nonzero ONLY inside a dark stroke where BOTH opposing neighbors are brighter!
  float getLineValley(float lc, float lt, float lb, float ll, float lr, float ltl, float ltr, float lbl, float lbr) {
    float vH  = min(ll - lc, lr - lc);
    float vV  = min(lt - lc, lb - lc);
    float vD1 = min(ltl - lc, lbr - lc);
    float vD2 = min(ltr - lc, lbl - lc);
    return max(0.0, max(max(vH, vV), max(vD1, vD2)));
  }

  // Pure Sharpness Curve: 100% independent of Deep AI Mode so the two sliders never fight or stick together!
  float getNormalizedSharpness(float rawSharp) {
    float s = clamp(rawSharp, 0.0, 1.0);
    if (s <= 0.001) return 0.0;
    float curved = pow(s, 0.88);
    float mlGain = 1.0 + 0.12 * clamp(u_multiLayer, 0.0, 1.0);
    return clamp(curved * mlGain, 0.0, 1.15);
  }

  // Smooth bypass blend at near-zero sharpness ONLY when both Deep Mode and Multi-Layer are inactive
  vec3 blendNearZeroSharp(vec3 rawOrig, vec3 processed, float sharp) {
    float activeBypassGuard = max(u_deepMode * step(0.005, u_deepIntensity), u_multiLayer);
    if (sharp < 0.06 && activeBypassGuard < 0.5) {
      return mix(rawOrig, processed, smoothstep(0.0, 0.06, sharp));
    }
    return processed;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DEEP AI MODE ENGINE (APISR / SPAN Residual Neural Deconvolution)
  //  Controlled strictly by its own independent slider: u_deepIntensity (0..1)
  //  Never dilutes Pass-2 output; computes pure directional & multi-scale residuals!
  // ══════════════════════════════════════════════════════════════════════════
  vec3 applyMasterDeconv(vec3 sharpenedCol, vec2 uv, float _unusedSharp, float strengthScale) {
    float deepInt = clamp(u_deepIntensity, 0.0, 1.0);
    if (u_deepMode < 0.5 || deepInt <= 0.001) {
      return sharpenedCol;
    }

    float dStrength = pow(deepInt, 0.85) * strengthScale;
    vec4 center4    = texture(u_upscaledTex, uv);
    vec3 baseCol    = center4.rgb;

    // Dual-scale stride: stepFine (sub-pixel FBO grid) + stepSrc (native video pixel span)
    vec2 scaleRatio = clamp(u_texelSize / max(u_outTexelSize, vec2(1e-6)), vec2(1.0), vec2(4.0));
    vec2 stepFine   = u_outTexelSize * 1.05;
    vec2 stepSrc    = u_outTexelSize * mix(vec2(1.35), scaleRatio, 0.90);

    // Fine sub-pixel 4-tap cross
    vec3 fN = texture(u_upscaledTex, uv + vec2( 0.0,       stepFine.y)).rgb;
    vec3 fS = texture(u_upscaledTex, uv + vec2( 0.0,      -stepFine.y)).rgb;
    vec3 fE = texture(u_upscaledTex, uv + vec2( stepFine.x, 0.0)).rgb;
    vec3 fW = texture(u_upscaledTex, uv + vec2(-stepFine.x, 0.0)).rgb;

    // Source-scale 8-tap neighborhood (spans the full width of 720p/1080p blur ramps)
    vec3 nN  = texture(u_upscaledTex, uv + vec2( 0.0,      stepSrc.y)).rgb;
    vec3 nS  = texture(u_upscaledTex, uv + vec2( 0.0,     -stepSrc.y)).rgb;
    vec3 nE  = texture(u_upscaledTex, uv + vec2( stepSrc.x,  0.0)).rgb;
    vec3 nW  = texture(u_upscaledTex, uv + vec2(-stepSrc.x,  0.0)).rgb;
    vec3 nNE = texture(u_upscaledTex, uv + vec2( stepSrc.x,  stepSrc.y)).rgb;
    vec3 nNW = texture(u_upscaledTex, uv + vec2(-stepSrc.x,  stepSrc.y)).rgb;
    vec3 nSE = texture(u_upscaledTex, uv + vec2( stepSrc.x, -stepSrc.y)).rgb;
    vec3 nSW = texture(u_upscaledTex, uv + vec2(-stepSrc.x, -stepSrc.y)).rgb;

    // Bounds include sharpenedCol so Deep AI Mode ALWAYS builds ON TOP of Pass-2 without undoing it!
    vec3 mnSrc = min(min(sharpenedCol, baseCol), min(min(min(nN, nS), min(nE, nW)), min(min(nNE, nNW), min(nSE, nSW))));
    vec3 mxSrc = max(max(sharpenedCol, baseCol), max(max(max(nN, nS), max(nE, nW)), max(max(nNE, nNW), max(nSE, nSW))));
    float localSpan = length(mxSrc - mnSrc);

    float lBase = getLumaRec601(baseCol);
    float lC    = getLumaRec601(sharpenedCol);
    float lN    = getLumaRec601(nN);  float lS  = getLumaRec601(nS);
    float lE    = getLumaRec601(nE);  float lW  = getLumaRec601(nW);
    float lNE   = getLumaRec601(nNE); float lNW = getLumaRec601(nNW);
    float lSE   = getLumaRec601(nSE); float lSW = getLumaRec601(nSW);

    float gx = (lNE + 2.0 * lE + lSE) - (lNW + 2.0 * lW + lSW);
    float gy = (lNW + 2.0 * lN + lNE) - (lSW + 2.0 * lS + lSE);
    float gMag = length(vec2(gx, gy));

    // True 2-sided valley catches the exact center of dark lines where 1st-order Sobel gMag == 0
    float bothBrighter = getLineValley(lBase, lN, lS, lE, lW, lNW, lNE, lSW, lSE);
    float structSignal = max(max(center4.a, smoothstep(0.008, 0.070, localSpan)), smoothstep(0.004, 0.040, bothBrighter * 3.8));

    // 1. Bilateral Surface Denoising ONLY in flat compression blocks (residual form)
    float flatMask = (1.0 - smoothstep(0.004, 0.018, localSpan)) * (1.0 - structSignal);
    vec3 smoothSurface = (baseCol * 2.0 + fN + fS + fE + fW + (nNE + nNW + nSE + nSW) * 0.5) / 8.0;
    vec3 working = sharpenedCol + (smoothSurface - baseCol) * (flatMask * 0.35 * clamp(deepInt, 0.2, 1.0));

    // 2. APISR Directional Push-Pull Shock Residual (steepens blurry edges across 1.35x source texels)
    if (gMag > 0.004) {
      vec2 nDir = vec2(gx, gy) / gMag;
      vec2 tDir = vec2(-nDir.y, nDir.x);
      vec3 pBright = texture(u_upscaledTex, clamp(uv + nDir * stepSrc * 1.30, 0.0, 1.0)).rgb;
      vec3 pDark   = texture(u_upscaledTex, clamp(uv - nDir * stepSrc * 1.30, 0.0, 1.0)).rgb;
      vec3 tA      = texture(u_upscaledTex, clamp(uv + tDir * stepFine * 0.80, 0.0, 1.0)).rgb;
      vec3 tB      = texture(u_upscaledTex, clamp(uv - tDir * stepFine * 0.80, 0.0, 1.0)).rgb;

      mnSrc = min(mnSrc, min(pBright, pDark));
      mxSrc = max(mxSrc, max(pBright, pDark));

      float lMid   = (getLumaRec601(pBright) + getLumaRec601(pDark)) * 0.5;
      float shockT = smoothstep(-0.018, 0.018, (lBase - lMid) + 0.026 * deepInt);
      vec3 shocked = mix(pDark, pBright, shockT) * 0.86 + (tA + tB) * 0.07;

      // Pure Residual Addition: adds the directional edge-narrowing delta onto working!
      vec3 shockDelta = shocked - baseCol;
      float edgeGate  = smoothstep(0.008, 0.075, gMag);
      working += shockDelta * clamp(dStrength * 0.68 * edgeGate, 0.0, 0.85);
    }

    // 3. SPAN Symmetric Attention Multi-Scale Deconvolution (Fine Sub-Pixel + Source-Scale Laplacian)
    vec3 fineAvg  = (fN + fS + fE + fW) * 0.25;
    vec3 srcCross = (nN + nS + nE + nW) * 0.25;
    vec3 srcDiag  = (nNE + nNW + nSE + nSW) * 0.25;
    vec3 srcAvg   = srcCross * 0.60 + srcDiag * 0.40;

    vec3 lapFine  = baseCol - fineAvg;
    vec3 lapSrc   = baseCol - srcAvg;
    vec3 multiLap = lapFine * 0.52 + lapSrc * 0.48;
    vec3 spanAtt  = tanh(multiLap * 3.25) * (0.25 + 0.75 * structSignal);
    vec3 refined  = working + spanAtt * (dStrength * 0.82);

    // 4. Deep Ink Valley Reconstruction (rebuilds crisp dark line cores at 2.0x with zero halo)
    float sat     = max(working.r, max(working.g, working.b)) - min(working.r, min(working.g, working.b));
    float inkGate = (1.0 - smoothstep(0.14, 0.42, sat) * 0.75) * step(lC, 0.55);
    float coreD   = smoothstep(0.004, 0.065, bothBrighter) * inkGate;
    refined      -= refined * (coreD * dStrength * 0.34);

    // Zero-Halo Asymmetric Envelope: allows dark line cores to deepen while strictly preventing bright halos
    vec3 mnFloor = max(mnSrc - vec3((0.022 + 0.42 * bothBrighter * coreD) * dStrength), vec3(0.02));
    vec3 mxCeil  = min(mxSrc + vec3(0.020 * structSignal * dStrength * (1.0 - coreD)), vec3(1.0));
    return clamp(refined, mnFloor, mxCeil);
  }
`;

window.NovaShaders = {

  vertexShader: `#version 300 es
    in vec2 a_position;
    uniform float u_flipY;
    uniform float u_mirrorX;
    out vec2 v_uv;
    out vec2 v_fboUv;

    void main() {
      vec2 screenUv = (a_position + 1.0) * 0.5;
      float xCoord  = (u_mirrorX > 0.5) ? (1.0 - screenUv.x) : screenUv.x;
      float yCoord  = (u_flipY > 0.5)   ? (1.0 - screenUv.y) : screenUv.y;
      v_uv    = vec2(xCoord, yCoord);
      v_fboUv = screenUv;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `,

  passthroughFrag: `#version 300 es
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    in vec2 v_uv;
    in vec2 v_fboUv;
    out vec4 fragColor;

    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform vec2      u_outTexelSize;
    uniform float     u_splitPos;
    ${NOVA_HDR_GLSL}

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_outTexelSize.x * 2.5, 0.0022);
        float dist = abs(v_fboUv.x - u_splitPos);
        if (dist < lw) {
          fragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_fboUv.x < u_splitPos) {
          fragColor = texture(u_texture, v_uv);
          return;
        }
      }
      vec3 raw = texture(u_texture, v_uv).rgb;
      fragColor = vec4(applyNovaHDR(raw, v_uv, u_texture, u_texelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 0A (LAYER 0 ANIME): Native-Grid Cel Restore & Mosquito Denoiser
  //  Runs at srcW x srcH before EASU to wipe codec ringing & unify lineart.
  // ══════════════════════════════════════════════════════════════════════════
  pass0_Restore_Anime: `#version 300 es
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    in vec2 v_uv;
    in vec2 v_fboUv;
    out vec4 fragColor;

    uniform sampler2D u_texture;
    uniform sampler2D u_historyTex;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_deepIntensity;
    uniform float     u_temporalStrength;
    uniform float     u_deepMode;

    float getLuma(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }

    float getLineValley0(float lc, float lt, float lb, float ll, float lr, float ltl, float ltr, float lbl, float lbr) {
      float vH  = min(ll - lc, lr - lc);
      float vV  = min(lt - lc, lb - lc);
      float vD1 = min(ltl - lc, lbr - lc);
      float vD2 = min(ltr - lc, lbl - lc);
      return max(0.0, max(max(vH, vV), max(vD1, vD2)));
    }

    void bilateralTap(vec3 center, float lCenter, vec3 sampleCol, float spatialW, float invSigma2, inout vec3 accC, inout float accW) {
      float diff = getLuma(sampleCol) - lCenter;
      vec3 cDiff = sampleCol - center;
      float dist2 = diff * diff * 0.72 + dot(cDiff, cDiff) * 0.28;
      float x = dist2 * invSigma2;
      float w = spatialW / (1.0 + x + 0.55 * x * x);
      accC += sampleCol * w;
      accW += w;
    }

    void main() {
      vec2 s = u_texelSize;
      vec3 c_c  = texture(u_texture, v_uv).rgb;
      vec3 c_t  = texture(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 c_b  = texture(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;
      vec3 c_l  = texture(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 c_r  = texture(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 c_tl = texture(u_texture, v_uv + vec2(-s.x, -s.y)).rgb;
      vec3 c_tr = texture(u_texture, v_uv + vec2( s.x, -s.y)).rgb;
      vec3 c_bl = texture(u_texture, v_uv + vec2(-s.x,  s.y)).rgb;
      vec3 c_br = texture(u_texture, v_uv + vec2( s.x,  s.y)).rgb;

      float lc  = getLuma(c_c);
      float lt  = getLuma(c_t);  float lb  = getLuma(c_b);
      float ll  = getLuma(c_l);  float lr  = getLuma(c_r);
      float ltl = getLuma(c_tl); float ltr = getLuma(c_tr);
      float lbl = getLuma(c_bl); float lbr = getLuma(c_br);

      float gx = (ltr + 2.0 * lr + lbr) - (ltl + 2.0 * ll + lbl);
      float gy = (lbl + 2.0 * lb + lbr) - (ltl + 2.0 * lt + ltr);
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);

      float bothBrighter = getLineValley0(lc, lt, lb, ll, lr, ltl, ltr, lbl, lbr);
      float isStructure  = max(smoothstep(0.012, 0.09, mag), smoothstep(0.005, 0.040, bothBrighter * 3.5));

      // 1. Edge- & Line-Center-Stopping Bilateral Denoiser
      float invSigma2 = mix(120.0, 1800.0, isStructure);
      vec3 accC = c_c;
      float accW = 1.0;

      bilateralTap(c_c, lc, c_t,  0.60, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_b,  0.60, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_l,  0.60, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_r,  0.60, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_tl, 0.35, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_tr, 0.35, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_bl, 0.35, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_br, 0.35, invSigma2, accC, accW);

      vec3 denoised = mix(accC / accW, c_c, isStructure * 0.75);

      vec3 mnP0 = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxP0 = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));

      // Independent authority: combines sharpness or deepIntensity so Pass 0 works even when sharpness is 0%!
      float p0Power = clamp(max(u_sharpness, u_deepMode * u_deepIntensity), 0.25, 1.0);
      if (mag > 0.007) {
        vec2 nDir = grad / mag;
        vec2 tDir = vec2(-nDir.y, nDir.x);
        vec3 t1 = texture(u_texture, clamp(v_uv + tDir * s * 0.75, 0.0, 1.0)).rgb;
        vec3 t2 = texture(u_texture, clamp(v_uv - tDir * s * 0.75, 0.0, 1.0)).rgb;
        vec3 tangSmooth = (denoised * 2.0 + t1 + t2) * 0.25;

        vec3 cBright = texture(u_texture, clamp(v_uv + nDir * s * 1.25, 0.0, 1.0)).rgb;
        vec3 cDark   = texture(u_texture, clamp(v_uv - nDir * s * 1.25, 0.0, 1.0)).rgb;
        mnP0 = min(mnP0, min(cBright, cDark));
        mxP0 = max(mxP0, max(cBright, cDark));

        float lMid = (getLuma(cBright) + getLuma(cDark)) * 0.5;
        float pullBias = (0.028 + 0.012 * u_deepMode) * p0Power;
        float t = smoothstep(-0.020, 0.020, (lc - lMid) + pullBias);
        vec3 pinched = mix(cDark, cBright, t);

        vec3 strokePre = mix(tangSmooth, pinched, 0.65 + 0.28 * p0Power);
        denoised = mix(denoised, strokePre, isStructure * (0.65 + 0.22 * u_deepMode));
      }

      // 3. Native-Grid Valley Ink Consolidation
      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float inkGate = (1.0 - smoothstep(0.14, 0.38, sat) * 0.75) * step(lc, 0.52);
      float coreMask = smoothstep(0.005, 0.075, bothBrighter) * inkGate;
      denoised -= denoised * (coreMask * p0Power * (0.32 + 0.16 * u_deepMode));

      vec3 mnFloor = max(mnP0 - vec3(0.32 * bothBrighter * coreMask * p0Power), vec3(0.04));
      denoised = clamp(denoised, mnFloor, mxP0);

      // 4. Surgical Native-Grid Debanding strictly in flat non-structural cel gradients
      if (isStructure < 0.08) {
        vec2 dbStep = s * 3.8;
        vec3 d1 = texture(u_texture, clamp(v_uv + vec2( dbStep.x,  dbStep.y), 0.0, 1.0)).rgb;
        vec3 d2 = texture(u_texture, clamp(v_uv + vec2(-dbStep.x,  dbStep.y), 0.0, 1.0)).rgb;
        vec3 d3 = texture(u_texture, clamp(v_uv + vec2( dbStep.x, -dbStep.y), 0.0, 1.0)).rgb;
        vec3 d4 = texture(u_texture, clamp(v_uv + vec2(-dbStep.x, -dbStep.y), 0.0, 1.0)).rgb;
        vec3 spiralAvg = (d1 + d2 + d3 + d4) * 0.25;
        float maxSpan = max(max(length(denoised - d1), length(denoised - d2)), max(length(denoised - d3), length(denoised - d4)));
        float bandGate = (1.0 - smoothstep(0.002, 0.018, maxSpan)) * (1.0 - isStructure);
        denoised = mix(denoised, spiralAvg, bandGate * 0.45);
      }

      // 5. 12fps "On Twos" Duplicate-Frame Temporal Gate
      if (u_temporalStrength > 0.01) {
        vec3 prevCol = texture(u_historyTex, v_fboUv).rgb;
        float motion = length(denoised - prevCol) + abs(getLuma(denoised) - getLuma(prevCol)) * 1.5;
        float isDuplicate = 1.0 - smoothstep(0.003, 0.010, motion);
        float motionGate  = (1.0 - smoothstep(0.008, 0.035, motion)) * (1.0 - isStructure * 0.65);
        float blendFactor = clamp(u_temporalStrength * mix(0.40, 0.68, isDuplicate) * motionGate, 0.0, 0.60);
        denoised = mix(denoised, prevCol, blendFactor);
      }

      fragColor = vec4(clamp(denoised, 0.0, 1.0), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 0B (LAYER 0 CINEMA): Native-Grid De-Blocker & Micro-Texture Pre-AI
  //  Runs at srcW x srcH before EASU/RAISR to remove H.264 blocks & recover detail.
  // ══════════════════════════════════════════════════════════════════════════
  pass0_Restore_Cinema: `#version 300 es
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    in vec2 v_uv;
    in vec2 v_fboUv;
    out vec4 fragColor;

    uniform sampler2D u_texture;
    uniform sampler2D u_historyTex;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_deepIntensity;
    uniform float     u_temporalStrength;
    uniform float     u_deepMode;

    float getLuma(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }

    void bilateralTap(vec3 center, float lCenter, vec3 sampleCol, float spatialW, float invSigma2, inout vec3 accC, inout float accW) {
      float diff = getLuma(sampleCol) - lCenter;
      float x = (diff * diff) * invSigma2;
      float w = spatialW / (1.0 + x + 0.48 * x * x);
      accC += sampleCol * w;
      accW += w;
    }

    void main() {
      vec2 s = u_texelSize;
      vec3 c_c  = texture(u_texture, v_uv).rgb;
      vec3 c_t  = texture(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 c_b  = texture(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;
      vec3 c_l  = texture(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 c_r  = texture(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 c_tl = texture(u_texture, v_uv + vec2(-s.x, -s.y)).rgb;
      vec3 c_tr = texture(u_texture, v_uv + vec2( s.x, -s.y)).rgb;
      vec3 c_bl = texture(u_texture, v_uv + vec2(-s.x,  s.y)).rgb;
      vec3 c_br = texture(u_texture, v_uv + vec2( s.x,  s.y)).rgb;

      float lc  = getLuma(c_c);
      float lt  = getLuma(c_t);  float lb  = getLuma(c_b);
      float ll  = getLuma(c_l);  float lr  = getLuma(c_r);
      float ltl = getLuma(c_tl); float ltr = getLuma(c_tr);
      float lbl = getLuma(c_bl); float lbr = getLuma(c_br);

      float gx = (ltr + 2.0 * lr + lbr) - (ltl + 2.0 * ll + lbl);
      float gy = (lbl + 2.0 * lb + lbr) - (ltl + 2.0 * lt + ltr);
      float mag = length(vec2(gx, gy));

      vec3 ringCross = (c_t + c_b + c_l + c_r) * 0.25;
      vec3 ringDiag  = (c_tl + c_tr + c_bl + c_br) * 0.25;
      vec3 ringAvg   = ringCross * 0.60 + ringDiag * 0.40;
      float lapMag   = abs(lc - getLuma(ringAvg));

      float detailMask = max(smoothstep(0.006, 0.045, mag), smoothstep(0.004, 0.025, lapMag * 2.5));
      float invSigma2 = mix(140.0, 1400.0, detailMask);
      vec3 accC = c_c;
      float accW = 1.0;

      bilateralTap(c_c, lc, c_t,  0.55, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_b,  0.55, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_l,  0.55, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_r,  0.55, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_tl, 0.30, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_tr, 0.30, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_bl, 0.30, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_br, 0.30, invSigma2, accC, accW);

      vec3 baseClean = mix(accC / accW, c_c, detailMask * 0.75);

      vec3 highFreq = c_c - ringAvg;
      float p0Power = clamp(max(u_sharpness, u_deepMode * u_deepIntensity), 0.25, 1.0);
      vec3 restored = baseClean + tanh(highFreq * 2.6) * (detailMask * p0Power * (0.48 + 0.24 * u_deepMode));

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));
      vec3 pad = vec3(0.012 * p0Power * detailMask);
      vec3 denoised = clamp(restored, max(mnLocal - pad, vec3(0.0)), min(mxLocal + pad, vec3(1.0)));

      if (u_temporalStrength > 0.01) {
        vec3 prevCol = texture(u_historyTex, v_fboUv).rgb;
        float motion = length(denoised - prevCol) + abs(getLuma(denoised) - getLuma(prevCol)) * 1.5;
        float motionGate = (1.0 - smoothstep(0.010, 0.042, motion)) * (1.0 - detailMask * 0.55);
        float blendFactor = clamp(u_temporalStrength * 0.50 * motionGate, 0.0, 0.52);
        denoised = mix(denoised, prevCol, blendFactor);
      }

      fragColor = vec4(clamp(denoised, 0.0, 1.0), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 1A: GPUOpen FSR 1.0 EASU (Exact Integer texelFetch + Alpha Map .a)
  // ══════════════════════════════════════════════════════════════════════════
  pass1_EASU: `#version 300 es
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    in vec2 v_uv;
    in vec2 v_fboUv;
    out vec4 fragColor;

    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;

    float getFsrLuma(vec3 c) { return c.g + 0.5 * (c.r + c.b); }

    vec3 fetchTap(ivec2 p, ivec2 maxC) {
      return texelFetch(u_texture, clamp(p, ivec2(0), maxC), 0).rgb;
    }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;

      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;

      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;

      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
      float d2 = min(dot(v, v), clp);

      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    void main() {
      ivec2 texSize  = textureSize(u_texture, 0);
      ivec2 maxCoord = max(texSize - ivec2(1), ivec2(0));
      vec2 pos   = v_uv * vec2(texSize) - 0.5;
      vec2 fp    = fract(pos);
      ivec2 base = ivec2(floor(pos));

      vec3 b = fetchTap(base + ivec2( 0, -1), maxCoord);
      vec3 c = fetchTap(base + ivec2( 1, -1), maxCoord);
      vec3 e = fetchTap(base + ivec2(-1,  0), maxCoord);
      vec3 f = fetchTap(base + ivec2( 0,  0), maxCoord);
      vec3 g = fetchTap(base + ivec2( 1,  0), maxCoord);
      vec3 h = fetchTap(base + ivec2( 2,  0), maxCoord);
      vec3 i = fetchTap(base + ivec2(-1,  1), maxCoord);
      vec3 j = fetchTap(base + ivec2( 0,  1), maxCoord);
      vec3 k = fetchTap(base + ivec2( 1,  1), maxCoord);
      vec3 l = fetchTap(base + ivec2( 2,  1), maxCoord);
      vec3 n = fetchTap(base + ivec2( 0,  2), maxCoord);
      vec3 o = fetchTap(base + ivec2( 1,  2), maxCoord);

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0);
      float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0);
      float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 mn4 = min(min(f, g), min(j, k));
      vec3 mx4 = max(max(f, g), max(j, k));
      vec3 easu = clamp(aC / max(aW, 0.0001), mn4, mx4);

      // Pack Chroma + Luma + 12-Tap Valley Structural Confidence into Alpha (.a) for Pass 2
      float mnL = min(min(fL, gL), min(jL, kL));
      float mxL = max(max(fL, gL), max(jL, kL));
      float outerMaxL = max(max(max(bL, cL), max(eL, hL)), max(max(iL, lL), max(nL, oL)));
      float valleyConf = clamp((outerMaxL - mnL) * 1.4, 0.0, 1.0);
      float chromaSpan = length(mx4 - mn4) * 0.75;
      float edgeSpan = max(max((mxL - mnL) * 1.20, chromaSpan), valleyConf * 0.65);
      float structConf = clamp(smoothstep(0.005, 0.095, edgeSpan) * (0.40 + 0.60 * max(len, valleyConf)), 0.0, 1.0);

      fragColor = vec4(clamp(easu, 0.0, 1.0), structConf);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 1B: Google RAISR 12-Tap Structure Tensor (Exact Integer texelFetch)
  // ══════════════════════════════════════════════════════════════════════════
  pass1_RAISR: `#version 300 es
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    in vec2 v_uv;
    in vec2 v_fboUv;
    out vec4 fragColor;

    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;

    float getLumaRec601(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }

    vec3 fetchTap(ivec2 p, ivec2 maxC) {
      return texelFetch(u_texture, clamp(p, ivec2(0), maxC), 0).rgb;
    }

    void tapRAISR(
      inout vec3 aC, inout float aW,
      vec2 off, vec2 n_dir, vec2 t_dir,
      float scaleN, float scaleT, float lob, vec3 c
    ) {
      float dn = dot(off, n_dir) * scaleN;
      float dt = dot(off, t_dir) * scaleT;
      float d2 = min(dn * dn + dt * dt, 3.0);
      float t = max(1.0 - d2 * 0.3333, 0.0);
      float w = (1.0 - lob * d2) * (t * t * t);
      aC += c * w;
      aW += w;
    }

    void main() {
      ivec2 texSize  = textureSize(u_texture, 0);
      ivec2 maxCoord = max(texSize - ivec2(1), ivec2(0));
      vec2 pos   = v_uv * vec2(texSize) - 0.5;
      vec2 fp    = fract(pos);
      ivec2 base = ivec2(floor(pos));

      vec3 b = fetchTap(base + ivec2( 0, -1), maxCoord);
      vec3 c = fetchTap(base + ivec2( 1, -1), maxCoord);
      vec3 e = fetchTap(base + ivec2(-1,  0), maxCoord);
      vec3 f = fetchTap(base + ivec2( 0,  0), maxCoord);
      vec3 g = fetchTap(base + ivec2( 1,  0), maxCoord);
      vec3 h = fetchTap(base + ivec2( 2,  0), maxCoord);
      vec3 i = fetchTap(base + ivec2(-1,  1), maxCoord);
      vec3 j = fetchTap(base + ivec2( 0,  1), maxCoord);
      vec3 k = fetchTap(base + ivec2( 1,  1), maxCoord);
      vec3 l = fetchTap(base + ivec2( 2,  1), maxCoord);
      vec3 n = fetchTap(base + ivec2( 0,  2), maxCoord);
      vec3 o = fetchTap(base + ivec2( 1,  2), maxCoord);

      float bL = getLumaRec601(b); float cL = getLumaRec601(c);
      float eL = getLumaRec601(e); float fL = getLumaRec601(f);
      float gL = getLumaRec601(g); float hL = getLumaRec601(h);
      float iL = getLumaRec601(i); float jL = getLumaRec601(j);
      float kL = getLumaRec601(k); float lL = getLumaRec601(l);
      float nL = getLumaRec601(n); float oL = getLumaRec601(o);

      vec2 grad_f = vec2(gL - eL, jL - bL) * 0.5;
      vec2 grad_g = vec2(hL - fL, kL - cL) * 0.5;
      vec2 grad_j = vec2(kL - iL, nL - fL) * 0.5;
      vec2 grad_k = vec2(lL - jL, oL - gL) * 0.5;

      float wf = (1.0 - fp.x) * (1.0 - fp.y);
      float wg = fp.x * (1.0 - fp.y);
      float wj = (1.0 - fp.x) * fp.y;
      float wk = fp.x * fp.y;

      float jxx = wf*grad_f.x*grad_f.x + wg*grad_g.x*grad_g.x + wj*grad_j.x*grad_j.x + wk*grad_k.x*grad_k.x;
      float jyy = wf*grad_f.y*grad_f.y + wg*grad_g.y*grad_g.y + wj*grad_j.y*grad_j.y + wk*grad_k.y*grad_k.y;
      float jxy = wf*grad_f.x*grad_f.y + wg*grad_g.x*grad_g.y + wj*grad_j.x*grad_j.y + wk*grad_k.x*grad_k.y;

      float tr = jxx + jyy;
      float det = max(jxx * jyy - jxy * jxy, 0.0);
      float disc = sqrt(max(tr * tr - 4.0 * det, 0.0));
      float lambda1 = max((tr + disc) * 0.5, 0.0);
      float lambda2 = max((tr - disc) * 0.5, 0.0);

      vec2 rawN = (jxx >= jyy)
        ? vec2(jxx - jyy + disc, 2.0 * jxy)
        : vec2(2.0 * jxy, jyy - jxx + disc);
      float rawLen = length(rawN);
      vec2 n_dir = (rawLen > 1e-6) ? (rawN / rawLen) : vec2(1.0, 0.0);
      vec2 t_dir = vec2(-n_dir.y, n_dir.x);

      float strength = sqrt(lambda1);
      float coherence = clamp((lambda1 - lambda2) / max(lambda1 + lambda2, 0.0001), 0.0, 1.0);
      float edge_factor = smoothstep(0.010, 0.11, strength) * coherence;

      float scaleT = mix(1.0, 0.68, edge_factor);
      float scaleN = mix(1.0, 1.58, edge_factor);
      float lob = mix(0.12, 0.36, edge_factor);

      vec3 aC = vec3(0.0); float aW = 0.0;
      tapRAISR(aC, aW, vec2( 0.0, -1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, b);
      tapRAISR(aC, aW, vec2( 1.0, -1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, c);
      tapRAISR(aC, aW, vec2(-1.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, e);
      tapRAISR(aC, aW, vec2( 0.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, f);
      tapRAISR(aC, aW, vec2( 1.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, g);
      tapRAISR(aC, aW, vec2( 2.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, h);
      tapRAISR(aC, aW, vec2(-1.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, i);
      tapRAISR(aC, aW, vec2( 0.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, j);
      tapRAISR(aC, aW, vec2( 1.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, k);
      tapRAISR(aC, aW, vec2( 2.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, l);
      tapRAISR(aC, aW, vec2( 0.0,  2.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, n);
      tapRAISR(aC, aW, vec2( 1.0,  2.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, o);

      vec3 mn4 = min(min(f, g), min(j, k));
      vec3 mx4 = max(max(f, g), max(j, k));
      vec3 recon = clamp(aC / max(aW, 0.0001), mn4, mx4);

      float chromaSpan = length(mx4 - mn4) * 0.70;
      float edgeSignal = max(strength, chromaSpan * 0.55);
      float structConf = clamp(smoothstep(0.004, 0.080, edgeSignal) * (0.35 + 0.65 * coherence), 0.0, 1.0);

      fragColor = vec4(clamp(recon, 0.0, 1.0), structConf);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE A: Official AMD FSR 1.0 RCAS + Diagonal Micro-Contrast
  // ══════════════════════════════════════════════════════════════════════════
  pass2_FSR_RCAS: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 e4 = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(e4.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.38);

      vec4 b4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 d4 = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 f4 = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));
      vec4 h4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));

      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      vec3 cas_b = b4.rgb; vec3 cas_d = d4.rgb; vec3 cas_e = e4.rgb;
      vec3 cas_f = f4.rgb; vec3 cas_h = h4.rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      // Balanced RCAS amplitude with dark-edge floor (0.65..1.0) so dark/mid scenes never lose crispness
      vec3 rcpMx = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 rawAmp = sqrt(clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0));
      vec3 amp    = mix(vec3(0.68), vec3(1.0), rawAmp);

      float nativeConf = max(e4.a, (b4.a + d4.a + f4.a + h4.a) * 0.25);
      float localVar   = length(mxRGB - mnRGB);
      float structGate = max(max(nativeConf, smoothstep(0.005, 0.030, localVar)), hwEdge);

      float peak = -mix(0.0, 0.188, pow(sharp, 0.85)) * mlBoost;
      vec3  w    = clamp(amp * peak * (0.45 + 0.55 * structGate), vec3(-0.188), vec3(0.0));

      vec3 rcpWeight = 1.0 / max(1.0 + 4.0 * w, vec3(0.24));
      vec3 rcasColor = (cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight;

      // Diagonal detail reinforcement for full 8-direction isotropy
      vec3 diagAvg   = (c_tl + c_tr + c_bl + c_br) * 0.25;
      vec3 finalColor = rcasColor + (cas_e - diagAvg) * (sharp * 0.35 * mlBoost * structGate);

      vec3 mn8 = min(mnRGB, min(min(c_tl, c_tr), min(c_bl, c_br)));
      vec3 mx8 = max(mxRGB, max(max(c_tl, c_tr), max(c_bl, c_br)));
      finalColor = clamp(finalColor, max(mn8 - 0.022 * sharp, 0.0), min(mx8 + 0.022 * sharp, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 1.00);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, finalColor, sharp);
      outRgb = applyCinemaGrain(outRgb, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE B: Google RAISR Steered Tensor + Micro-Texture Recovery
  // ══════════════════════════════════════════════════════════════════════════
  pass2_RAISR: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.45);

      vec4 c4_t = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 c4_b = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));
      vec4 c4_l = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 c4_r = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));

      vec3 c_c  = c4_c.rgb;
      vec3 c_t  = c4_t.rgb; vec3 c_b = c4_b.rgb;
      vec3 c_l  = c4_l.rgb; vec3 c_r = c4_r.rgb;
      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      float lt = getLumaRec601(c_t);   float lb = getLumaRec601(c_b);
      float ll = getLumaRec601(c_l);   float lr = getLumaRec601(c_r);
      float ltl = getLumaRec601(c_tl); float ltr = getLumaRec601(c_tr);
      float lbl = getLumaRec601(c_bl); float lbr = getLumaRec601(c_br);

      float gx = (ltr + 2.0 * lr + lbr) - (ltl + 2.0 * ll + lbl);
      float gy = (ltl + 2.0 * lt + ltr) - (lbl + 2.0 * lb + lbr);
      float strength = length(vec2(gx, gy));
      vec2 n_dir = (strength > 0.0001) ? (vec2(gx, gy) / strength) : vec2(1.0, 0.0);
      vec2 t_dir = vec2(-n_dir.y, n_dir.x);

      vec3 sn_p = texture(u_upscaledTex, v_fboUv + n_dir * o).rgb;
      vec3 sn_n = texture(u_upscaledTex, v_fboUv - n_dir * o).rgb;
      vec3 st_p = texture(u_upscaledTex, v_fboUv + t_dir * u_outTexelSize * 0.85).rgb;
      vec3 st_n = texture(u_upscaledTex, v_fboUv - t_dir * u_outTexelSize * 0.85).rgb;

      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float gate = max(max(nativeConf, smoothstep(0.010, 0.075, strength)), hwEdge);

      // Steered tangent anti-aliasing + normal deconvolution + 2D isotropic organic pore/texture recovery
      vec3 smoothed  = mix(c_c, (st_p + c_c * 2.0 + st_n) * 0.25, 0.20 * gate * sharp);
      vec3 high_n    = smoothed - (sn_p + sn_n) * 0.5;
      vec3 ringAvg   = (c_t + c_b + c_l + c_r + c_tl + c_tr + c_bl + c_br) * 0.125;
      vec3 isoDetail = c_c - ringAvg;

      vec3 finalColor = smoothed
                      + high_n * (sharp * 1.95 * mlBoost * (0.45 + 0.55 * gate))
                      + isoDetail * (sharp * 0.72 * mlBoost);

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(sn_p, sn_n))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(sn_p, sn_n))));
      finalColor = clamp(finalColor, max(mnLocal - 0.022 * sharp, 0.0), min(mxLocal + 0.022 * sharp, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 0.95);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, finalColor, sharp);
      outRgb = applyCinemaGrain(outRgb, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE C: FSRCNN Feature Convolution (RGB + Luma Neural Residual)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_FSRCNN: `${NOVA_PASS2_HEADER}

    vec3 fsrcnn_act3(vec3 x, float conf) {
      float mag = max(abs(x.r), max(abs(x.g), abs(x.b)));
      float gate = max(conf * 0.88, smoothstep(0.003, 0.015, mag));
      return tanh(x) * gate;
    }

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.45);

      vec4 c4_t = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 c4_b = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));
      vec4 c4_l = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 c4_r = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));

      vec3 c_c  = c4_c.rgb;
      vec3 c_t  = c4_t.rgb; vec3 c_b = c4_b.rgb;
      vec3 c_l  = c4_l.rgb; vec3 c_r = c4_r.rgb;
      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      float yt = getLumaRec601(c_t);   float yb = getLumaRec601(c_b);
      float yl = getLumaRec601(c_l);   float yr = getLumaRec601(c_r);
      float ytl = getLumaRec601(c_tl); float ytr = getLumaRec601(c_tr);
      float ybl = getLumaRec601(c_bl); float ybr = getLumaRec601(c_br);

      float gx = (ytr + 2.0 * yr + ybr) - (ytl + 2.0 * yl + ybl);
      float gy = (ytl + 2.0 * yt + ytr) - (ybl + 2.0 * yb + ybr);
      float gLen = length(vec2(gx, gy));
      vec2 dir = (gLen > 0.0001) ? (vec2(gx, gy) / gLen) : vec2(1.0, 0.0);
      vec2 tang = vec2(-dir.y, dir.x);

      vec3 c_n1 = texture(u_upscaledTex, v_fboUv + dir  * o).rgb;
      vec3 c_n2 = texture(u_upscaledTex, v_fboUv - dir  * o).rgb;
      vec3 c_t1 = texture(u_upscaledTex, v_fboUv + tang * u_outTexelSize * 0.90).rgb;
      vec3 c_t2 = texture(u_upscaledTex, v_fboUv - tang * u_outTexelSize * 0.90).rgb;

      vec3 c_ring    = (c_t + c_b + c_l + c_r + c_tl + c_tr + c_bl + c_br) * 0.125;
      vec3 h_normal  = c_c - (c_n1 + c_n2) * 0.5;
      vec3 h_tangent = c_c - (c_t1 + c_t2) * 0.5;
      vec3 h_texture = c_c - c_ring;

      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float edgeConf   = max(max(nativeConf, smoothstep(0.010, 0.075, gLen)), hwEdge);

      // Feature Map A: Normal-axis high-frequency edge deconvolution
      vec3 f_a = fsrcnn_act3(h_normal  * 2.25 + h_texture * 0.60, edgeConf);
      // Feature Map B: Tangent-axis continuity (negative weight removes diagonal stair-stepping!)
      vec3 f_b = -h_tangent * (0.22 * edgeConf);
      // Feature Map C: 9-tap isotropic micro-texture & text clarity
      vec3 f_c = fsrcnn_act3(h_texture * 1.85 - h_normal * 0.15,  edgeConf);

      vec3 sr_residual = f_a * 0.62 + f_b + f_c * 0.38;
      vec3 neural = c_c + sr_residual * (sharp * 2.05 * mlBoost);

      vec3 mnSym = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_n1, c_n2), min(c_t1, c_t2))));
      vec3 mxSym = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_n1, c_n2), max(c_t1, c_t2))));
      vec3 finalColor = clamp(neural, max(mnSym - 0.022 * sharp, 0.0), min(mxSym + 0.022 * sharp, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 1.05);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, finalColor, sharp);
      outRgb = applyCinemaGrain(outRgb, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 1: "Pure" (Alpha + fwidth() Guided RCAS + Tangent-Only AA)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_Pure: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 e4 = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(e4.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.35);

      vec4 b4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 d4 = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 f4 = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));
      vec4 h4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));

      vec3 cas_b = b4.rgb; vec3 cas_d = d4.rgb; vec3 cas_e = e4.rgb;
      vec3 cas_f = f4.rgb; vec3 cas_h = h4.rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      vec3 rcpMx  = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 rawAmp = sqrt(clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0));
      vec3 amp    = mix(vec3(0.68), vec3(1.0), rawAmp);

      float nativeConf = max(e4.a, (b4.a + d4.a + f4.a + h4.a) * 0.25);
      float localVar   = length(mxRGB - mnRGB);
      float edgeGate   = max(max(nativeConf, smoothstep(0.005, 0.028, localVar)), hwEdge);

      float peak      = -mix(0.0, 0.185, pow(sharp, 0.85)) * mlBoost;
      vec3  w         = clamp(amp * peak * (0.42 + 0.58 * edgeGate), vec3(-0.185), vec3(0.0));
      vec3 rcpWeight  = 1.0 / max(1.0 + 4.0 * w, vec3(0.25));
      vec3 rcasColor  = clamp((cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight, max(mnRGB - 0.018 * sharp, 0.0), min(mxRGB + 0.018 * sharp, 1.0));

      // Tangent-only sub-pixel anti-aliasing (never blurs across the edge normal!)
      float gx = getLumaRec601(cas_f) - getLumaRec601(cas_d);
      float gy = getLumaRec601(cas_b) - getLumaRec601(cas_h);
      float gLen = length(vec2(gx, gy));
      if (gLen > 0.010) {
        vec2 tang = vec2(-gy, gx) / gLen;
        vec3 tA = texture(u_upscaledTex, v_fboUv + tang * u_outTexelSize * 0.70).rgb;
        vec3 tB = texture(u_upscaledTex, v_fboUv - tang * u_outTexelSize * 0.70).rgb;
        rcasColor = mix(rcasColor, (rcasColor * 2.0 + tA + tB) * 0.25, 0.18 * edgeGate);
      }

      vec3 finalColor = applyMasterDeconv(rcasColor, v_fboUv, sharp, 0.82);
      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, clamp(finalColor, 0.0, 1.0), sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 2: "Deblur" (2-Stage Iterative Min-Grad Thinning + DoG)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_DbL: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.55);

      vec4 c4_t  = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 c4_b  = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));
      vec4 c4_l  = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 c4_r  = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));

      vec3 c_c  = c4_c.rgb;
      vec3 c_t  = c4_t.rgb; vec3 c_b = c4_b.rgb;
      vec3 c_l  = c4_l.rgb; vec3 c_r = c4_r.rgb;
      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      float l_cc = getLumaRec601(c_c);
      float lt   = getLumaRec601(c_t);  float lb  = getLumaRec601(c_b);
      float ll   = getLumaRec601(c_l);  float lr  = getLumaRec601(c_r);
      float ltl  = getLumaRec601(c_tl); float ltr = getLumaRec601(c_tr);
      float lbl  = getLumaRec601(c_bl); float lbr = getLumaRec601(c_br);

      float gx = (ltr + 2.0 * lr + lbr) - (ltl + 2.0 * ll + lbl);
      float gy = (ltl + 2.0 * lt + ltr) - (lbl + 2.0 * lb + lbr);
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);

      vec3 c_ring  = (c_tl + c_t + c_tr + c_l + c_r + c_bl + c_b + c_br) * 0.125;
      float bothBrighter = getLineValley(l_cc, lt, lb, ll, lr, ltl, ltr, lbl, lbr);
      float valley_sig   = smoothstep(0.005, 0.045, bothBrighter * 3.5);

      float nativeConf = max(c4_c.a, max(max(c4_t.a, c4_b.a), max(c4_l.a, c4_r.a)));
      float edge_mask  = max(max(max(nativeConf * 0.95, smoothstep(0.010, 0.085, mag)), hwEdge * 0.92), valley_sig);

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));

      vec3 c_warped = c_c;
      if (mag > 0.006 && sharp > 0.001) {
        vec2 nDir = grad / mag;
        vec2 tang = vec2(-nDir.y, nDir.x);

        // Stage 1: Fine sub-pixel stroke consolidation
        vec4 s1Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 0.65, 0.0, 1.0));
        vec4 s1Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 0.65, 0.0, 1.0));

        // Stage 2: Full source-ramp collapse reaching clean color plateaus outside the blur kernel
        vec4 s2Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 1.35, 0.0, 1.0));
        vec4 s2Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 1.35, 0.0, 1.0));

        mnLocal = min(mnLocal, min(s2Bright.rgb, s2Dark.rgb));
        mxLocal = max(mxLocal, max(s2Bright.rgb, s2Dark.rgb));

        vec3 pBright = mix(s1Bright.rgb, s2Bright.rgb, 0.68);
        vec3 pDark   = mix(s1Dark.rgb,   s2Dark.rgb,   0.68);
        float lMid   = (getLumaRec601(pBright) + getLumaRec601(pDark)) * 0.5;

        float minGradPull = clamp((s2Dark.a - s2Bright.a) + (s1Dark.a - s1Bright.a) * 0.5, -0.5, 1.0) * 0.024;
        float t = smoothstep(-0.020, 0.020, (l_cc - lMid) + 0.032 * sharp + minGradPull);
        vec3 pinched = mix(pDark, pBright, t);

        vec3 tangA = texture(u_upscaledTex, clamp(v_fboUv + tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        vec3 tangB = texture(u_upscaledTex, clamp(v_fboUv - tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        vec3 cleanStroke = pinched * 0.86 + (tangA + tangB) * 0.07;
        c_warped = mix(c_c, cleanStroke, edge_mask * clamp(0.68 * sharp + 0.26 * sharp * sharp, 0.0, 0.95));
      }

      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float darken_gate = (1.0 - smoothstep(0.12, 0.36, sat) * 0.72) * step(l_cc, 0.52);
      vec3 deblurred = c_warped + (c_warped - c_ring) * (sharp * 1.65 * mlBoost) * edge_mask;
      float coreMask2 = smoothstep(0.005, 0.080, bothBrighter) * darken_gate;
      deblurred -= deblurred * (coreMask2 * edge_mask * 0.28 * sharp * mlBoost);

      vec3 mnBound = max(mnLocal - vec3(0.35 * bothBrighter * coreMask2 * sharp), vec3(0.04));
      vec3 mxBound = min(mxLocal + vec3(0.012 * sharp * (1.0 - coreMask2)), vec3(1.0));
      vec3 cleanAnime = clamp(deblurred, mnBound, mxBound);
      cleanAnime = applyMasterDeconv(cleanAnime, v_fboUv, sharp, 1.00);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, cleanAnime, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 3: "Sharp" (Directional Contour USM + Valley Ink Lock)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_Sharp: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.50);

      vec4 c4_t = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 c4_b = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));
      vec4 c4_l = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 c4_r = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));

      vec3 c_c  = c4_c.rgb;
      vec3 c_t  = c4_t.rgb; vec3 c_b = c4_b.rgb;
      vec3 c_l  = c4_l.rgb; vec3 c_r = c4_r.rgb;
      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      float l_cc = getLumaRec601(c_c);
      float lt   = getLumaRec601(c_t);  float lb  = getLumaRec601(c_b);
      float ll   = getLumaRec601(c_l);  float lr  = getLumaRec601(c_r);
      float ltl  = getLumaRec601(c_tl); float ltr = getLumaRec601(c_tr);
      float lbl  = getLumaRec601(c_bl); float lbr = getLumaRec601(c_br);

      float bothBrighter = getLineValley(l_cc, lt, lb, ll, lr, ltl, ltr, lbl, lbr);
      float valley_sig   = smoothstep(0.005, 0.045, bothBrighter * 3.5);

      vec3 c_cross = (c_t + c_b + c_l + c_r) * 0.25;
      vec3 c_diag  = (c_tl + c_tr + c_bl + c_br) * 0.25;
      vec3 c_ring  = c_cross * 0.58 + c_diag * 0.42;

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));

      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float edgeMask   = max(max(max(nativeConf, smoothstep(0.008, 0.060, length(mxLocal - mnLocal))), hwEdge), valley_sig);

      vec3 usm = c_c + (c_c - c_ring) * (sharp * 2.40 * mlBoost) * (0.40 + 0.60 * edgeMask);

      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float coreMask = smoothstep(0.005, 0.075, bothBrighter) * (1.0 - smoothstep(0.14, 0.40, sat) * 0.72) * step(l_cc, 0.52);
      usm -= usm * (coreMask * edgeMask * 0.24 * sharp * mlBoost);

      vec3 mnBound = max(mnLocal - vec3((0.022 + 0.30 * bothBrighter * coreMask) * sharp), vec3(0.03));
      vec3 mxBound = min(mxLocal + vec3(0.022 * sharp * (1.0 - coreMask * 0.6)), vec3(1.0));
      usm = clamp(usm, mnBound, mxBound);
      usm = applyMasterDeconv(usm, v_fboUv, sharp, 1.12);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, usm, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 4: "Intense" (Aggressive 2-Stage Min-Grad Narrowing + Ink)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_DbH: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = getNormalizedSharpness(u_sharpness);
      float mlBoost = 1.0 + 0.22 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.68);

      vec4 c4_t  = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 c4_b  = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));
      vec4 c4_l  = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 c4_r  = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));

      vec3 c_c  = c4_c.rgb;
      vec3 c_t  = c4_t.rgb; vec3 c_b = c4_b.rgb;
      vec3 c_l  = c4_l.rgb; vec3 c_r = c4_r.rgb;
      vec3 c_tl = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  o.y)).rgb;
      vec3 c_tr = texture(u_upscaledTex, v_fboUv + vec2( o.x,  o.y)).rgb;
      vec3 c_bl = texture(u_upscaledTex, v_fboUv + vec2(-o.x, -o.y)).rgb;
      vec3 c_br = texture(u_upscaledTex, v_fboUv + vec2( o.x, -o.y)).rgb;

      float l_cc = getLumaRec601(c_c);
      float lt   = getLumaRec601(c_t);  float lb  = getLumaRec601(c_b);
      float ll   = getLumaRec601(c_l);  float lr  = getLumaRec601(c_r);
      float ltl  = getLumaRec601(c_tl); float ltr = getLumaRec601(c_tr);
      float lbl  = getLumaRec601(c_bl); float lbr = getLumaRec601(c_br);

      float gx = (ltr + 2.0 * lr + lbr) - (ltl + 2.0 * ll + lbl);
      float gy = (ltl + 2.0 * lt + ltr) - (lbl + 2.0 * lb + lbr);
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);

      vec3 c_ring  = (c_tl + c_t + c_tr + c_l + c_r + c_bl + c_b + c_br) * 0.125;
      float bothBrighter = getLineValley(l_cc, lt, lb, ll, lr, ltl, ltr, lbl, lbr);
      float valley_sig   = smoothstep(0.004, 0.040, bothBrighter * 3.8);

      float nativeConf = max(c4_c.a, max(max(c4_t.a, c4_b.a), max(c4_l.a, c4_r.a)));
      float edge_mask  = max(max(max(nativeConf * 0.98, smoothstep(0.008, 0.080, mag)), hwEdge * 0.96), valley_sig);

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));

      vec3 c_warped = c_c;
      if (mag > 0.005 && sharp > 0.001) {
        vec2 nDir = grad / mag;
        vec2 tang = vec2(-nDir.y, nDir.x);

        vec4 s1Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 0.72, 0.0, 1.0));
        vec4 s1Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 0.72, 0.0, 1.0));

        float span = 1.42 + 0.12 * sharp;
        vec4 s2Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * span, 0.0, 1.0));
        vec4 s2Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * span, 0.0, 1.0));

        mnLocal = min(mnLocal, min(s2Bright.rgb, s2Dark.rgb));
        mxLocal = max(mxLocal, max(s2Bright.rgb, s2Dark.rgb));

        vec3 pBright = mix(s1Bright.rgb, s2Bright.rgb, 0.72);
        vec3 pDark   = mix(s1Dark.rgb,   s2Dark.rgb,   0.72);
        float lMid   = (getLumaRec601(pBright) + getLumaRec601(pDark)) * 0.5;

        float minGradPull = clamp((s2Dark.a - s2Bright.a) + (s1Dark.a - s1Bright.a) * 0.5, -0.5, 1.0) * 0.032;
        float t = smoothstep(-0.018, 0.018, (l_cc - lMid) + 0.044 * sharp + minGradPull);
        vec3 pinched = mix(pDark, pBright, t);

        vec3 tangA = texture(u_upscaledTex, clamp(v_fboUv + tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        vec3 tangB = texture(u_upscaledTex, clamp(v_fboUv - tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        c_warped = mix(c_c, pinched * 0.86 + (tangA + tangB) * 0.07, edge_mask * clamp(0.76 * sharp + 0.22 * sharp * sharp, 0.0, 0.98));
      }

      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float darken_gate = (1.0 - smoothstep(0.15, 0.45, sat) * 0.75) * step(l_cc, 0.55);

      vec3 deblurred = c_warped + (c_warped - c_ring) * (sharp * 2.05 * mlBoost) * edge_mask;
      float coreMask2 = smoothstep(0.004, 0.075, bothBrighter) * darken_gate;
      deblurred -= deblurred * (coreMask2 * edge_mask * 0.35 * sharp * mlBoost);

      vec3 mnBound = max(mnLocal - vec3(0.42 * bothBrighter * coreMask2 * sharp), vec3(0.03));
      vec3 mxBound = min(mxLocal + vec3(0.015 * sharp * (1.0 - coreMask2)), vec3(1.0));
      vec3 cleanIntense = clamp(deblurred, mnBound, mxBound);
      cleanIntense = applyMasterDeconv(cleanIntense, v_fboUv, sharp, 1.25);

      vec3 outRgb = blendNearZeroSharp(texture(u_texture, v_uv).rgb, cleanIntense, sharp);
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `
};
