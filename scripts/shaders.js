/**
 * NovaScale - GLSL ES 3.00 Shader Suite v7.0 (Native WebGL2 2-Pass & 3-Pass Super-Resolution)
 *
 * Dual/Triple-Pass WebGL2 Pipeline (#version 300 es):
 * 1. vertexShader        : Emits both v_uv (top=0 for UNPACK_FLIP_Y=false video Texture0)
 *                          and v_fboUv (top=1 for upright offscreen FBO Texture1/Texture2).
 * 2. passthroughFrag     : Single-pass direct passthrough + split-screen & HDR at 0% sharpness.
 * 3. pass0_Restore_*     : Optional Layer-0 native-grid pre-restoration (Anime / Cinema).
 * 4. pass1_EASU / RAISR  : Exact integer texelFetch 12-tap spatial upscalers + Alpha (.a) map.
 * 5. Pass-2 Refiners     : Hardware fwidth() sub-pixel gating + .a map + mlBoost (3-Pass) +
 *                          Interleaved Gradient Noise 10-bit dithering + native tanh() FSRCNN.
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

    // 1. Dual-Scale Radiosity: Micro-Texture (3.0px) + Macro Local-Dimming Zone (13.0px)
    vec2 dMicro = refStep * 3.0;
    vec2 dMacro = refStep * 13.0;

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
    // Allows pure saturated emissive colors (blue/red/cyan magic, neons, eyes) to trigger specular pop
    // while remaining 100% bounded by upwardGuard on white fur or near-clipped channels.
    float hkPerceptualLuma = max(Ls, mix(Ls, peakCh, srcSat * 0.65));
    float specBell = smoothstep(0.54, 0.85, hkPerceptualLuma) * smoothstep(0.995, 0.85, Ls);
    float contrastWithMacro = clamp(hkPerceptualLuma - Ls_macro, 0.0, 0.5) * 0.35;
    float specPop  = specBell * (((u_hdr < 1.5) ? 0.080 : 0.065) + contrastWithMacro * 0.04)
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
      ? (((u_hdr < 1.5) ? 0.26 : 0.32) * darkSceneBoost * posGuard)
      : (((u_hdr < 1.5) ? 0.22 : 0.25) * negWhiteCarve);
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
    float vibStrength      = (u_hdr < 1.5) ? 0.23 : 0.19;
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
  uniform float     u_splitPos;
  uniform float     u_multiLayer;
  ${NOVA_HDR_GLSL}

  vec3 applyCinemaGrain(vec3 col, float sharp) {
    if (sharp <= 0.05 || u_multiLayer < 0.5) return col;
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float bell = smoothstep(0.04, 0.24, luma) * (1.0 - smoothstep(0.68, 0.94, luma));
    float g = novaFilmGrain(gl_FragCoord.xy, u_frameIndex) * (0.0085 * bell * sharp);
    return clamp(col + vec3(g), 0.0, 1.0);
  }

  float getLumaRec601(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }
  float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

  // Scale-aware Pass-2 sampling stride spanning upscaled transition ramps cleanly
  vec2 getAdaptiveStep(float factor) {
    vec2 scaleRatio = clamp(u_texelSize / max(u_outTexelSize, vec2(1e-6)), vec2(1.0), vec2(3.0));
    return u_outTexelSize * mix(vec2(1.0), scaleRatio, factor);
  }

  // Hardware screen-space derivative edge detector sensitive to 480p/720p soft ramps
  float getSubpxEdge(vec3 c) {
    float fw = length(fwidth(c));
    float mlScale = mix(0.85, 1.15, clamp(u_multiLayer, 0.0, 1.0));
    return clamp(smoothstep(0.010, 0.095, fw) * mlScale, 0.0, 1.0);
  }

  // Multi-Scale Deconvolution (recovers mid-band clarity lost in 480p/720p downscaling)
  vec3 applyMasterDeconv(vec3 col, vec2 uv, float sharp, float strengthScale) {
    if (sharp <= 0.01) return col;
    vec2 wideStep = getAdaptiveStep(1.35);
    vec3 wN = texture(u_upscaledTex, uv + vec2( 0.0,        wideStep.y)).rgb;
    vec3 wS = texture(u_upscaledTex, uv + vec2( 0.0,       -wideStep.y)).rgb;
    vec3 wE = texture(u_upscaledTex, uv + vec2( wideStep.x, 0.0)).rgb;
    vec3 wW = texture(u_upscaledTex, uv + vec2(-wideStep.x, 0.0)).rgb;
    vec3 wideAvg = (wN + wS + wE + wW) * 0.25;
    vec3 midBand = col - wideAvg;
    float midMag = length(midBand);
    float gate = smoothstep(0.004, 0.045, midMag) * (1.0 - smoothstep(0.28, 0.55, midMag) * 0.65);
    float mlBoost = 1.0 + 0.30 * clamp(u_multiLayer, 0.0, 1.0);
    vec3 boosted = col + midBand * (sharp * strengthScale * mlBoost * (0.45 + 0.55 * gate));
    vec3 mnW = min(col, min(min(wN, wS), min(wE, wW)));
    vec3 mxW = max(col, max(max(wN, wS), max(wE, wW)));
    return clamp(boosted, max(mnW - 0.065 * sharp, 0.0), min(mxW + 0.065 * sharp, 1.0));
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
    uniform float     u_temporalStrength;

    float getLuma(vec3 c) { return dot(vec3(0.2126, 0.7152, 0.0722), c); }

    void bilateralTap(vec3 center, float lCenter, vec3 sampleCol, float spatialW, float invSigma2, inout vec3 accC, inout float accW) {
      float diff = getLuma(sampleCol) - lCenter;
      vec3 cDiff = sampleCol - center;
      float dist2 = diff * diff * 0.70 + dot(cDiff, cDiff) * 0.30;
      float x = dist2 * invSigma2;
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
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);

      // 1. Edge-preserving bilateral filter (wipes mosquito noise around strokes & flat cel fills)
      float isEdge = smoothstep(0.020, 0.14, mag);
      float invSigma2 = mix(90.0, 420.0, isEdge);
      vec3 accC = c_c;
      float accW = 1.0;

      bilateralTap(c_c, lc, c_t,  0.65, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_b,  0.65, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_l,  0.65, invSigma2, accC, accW);
      bilateralTap(c_c, lc, c_r,  0.65, invSigma2, accC, accW);
      if (mag >= 0.008) {
        bilateralTap(c_c, lc, c_tl, 0.40, invSigma2, accC, accW);
        bilateralTap(c_c, lc, c_tr, 0.40, invSigma2, accC, accW);
        bilateralTap(c_c, lc, c_bl, 0.40, invSigma2, accC, accW);
        bilateralTap(c_c, lc, c_br, 0.40, invSigma2, accC, accW);
      }

      vec3 denoised = accC / accW;

      // 2. Native-grid stroke tangent continuity & pre-thinning before EASU
      if (mag > 0.008) {
        vec2 nDir = grad / mag;
        vec2 tDir = vec2(-nDir.y, nDir.x);
        vec3 t1 = texture(u_texture, clamp(v_uv + tDir * s * 0.80, 0.0, 1.0)).rgb;
        vec3 t2 = texture(u_texture, clamp(v_uv - tDir * s * 0.80, 0.0, 1.0)).rgb;
        vec3 tangSmooth = (denoised * 2.0 + t1 + t2) * 0.25;

        vec3 cBright = texture(u_texture, clamp(v_uv + nDir * s * 0.85, 0.0, 1.0)).rgb;
        vec3 cDark   = texture(u_texture, clamp(v_uv - nDir * s * 0.85, 0.0, 1.0)).rgb;
        float lMid = (getLuma(cBright) + getLuma(cDark)) * 0.5;
        float t = smoothstep(-0.030, 0.030, (lc - lMid) + 0.022 * u_sharpness);
        vec3 pinched = mix(cDark, cBright, t);

        vec3 strokePre = mix(tangSmooth, pinched * 0.84 + (t1 + t2) * 0.08, clamp(0.45 + 0.35 * u_sharpness, 0.0, 0.85));
        vec3 lRingCol = (c_t + c_b + c_l + c_r) * 0.25;
        vec3 preDog = (denoised - lRingCol) * (0.45 * u_sharpness * isEdge);
        denoised = mix(denoised, strokePre + preDog, isEdge * 0.72);
      }

      // 3. Surgical Native-Grid Debanding in flat sky/shadow cel gradients
      if (mag < 0.016) {
        vec2 dbStep = s * 4.5;
        vec3 d1 = texture(u_texture, clamp(v_uv + vec2( dbStep.x,  dbStep.y), 0.0, 1.0)).rgb;
        vec3 d2 = texture(u_texture, clamp(v_uv + vec2(-dbStep.x,  dbStep.y), 0.0, 1.0)).rgb;
        vec3 d3 = texture(u_texture, clamp(v_uv + vec2( dbStep.x, -dbStep.y), 0.0, 1.0)).rgb;
        vec3 d4 = texture(u_texture, clamp(v_uv + vec2(-dbStep.x, -dbStep.y), 0.0, 1.0)).rgb;
        vec3 spiralAvg = (d1 + d2 + d3 + d4) * 0.25;
        float maxSpan = max(max(length(denoised - d1), length(denoised - d2)), max(length(denoised - d3), length(denoised - d4)));
        float bandGate = (1.0 - smoothstep(0.002, 0.022, maxSpan)) * (1.0 - isEdge);
        denoised = mix(denoised, spiralAvg, bandGate * 0.55);
      }

      // 4. 12fps "On Twos" Duplicate-Frame Temporal Gate
      if (u_temporalStrength > 0.01) {
        vec3 prevCol = texture(u_historyTex, v_fboUv).rgb;
        float motion = length(denoised - prevCol) + abs(getLuma(denoised) - getLuma(prevCol)) * 1.5;
        float isDuplicate = 1.0 - smoothstep(0.004, 0.012, motion);
        float motionGate  = 1.0 - smoothstep(0.012, 0.065, motion);
        float blendFactor = clamp(u_temporalStrength * mix(0.68, 0.88, isDuplicate) * motionGate, 0.0, 0.88);
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
    uniform float     u_temporalStrength;

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

      // 1. De-block low-variance macroblock gradients while preserving genuine detail
      float detailMask = smoothstep(0.008, 0.055, mag);
      float invSigma2 = mix(110.0, 650.0, detailMask);
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

      vec3 baseClean = accC / accW;

      // 2. Pre-extract mid-frequency micro-texture before EASU/RAISR
      vec3 ringAvg = (c_t + c_b + c_l + c_r + c_tl + c_tr + c_bl + c_br) * 0.125;
      vec3 highFreq = c_c - ringAvg;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      vec3 restored = baseClean + highFreq * (detailMask * sharp * 0.85);

      vec3 mnLocal = min(c_c, min(min(c_t, c_b), min(c_l, c_r)));
      vec3 mxLocal = max(c_c, max(max(c_t, c_b), max(c_l, c_r)));
      vec3 denoised = clamp(restored, max(mnLocal - 0.025 * sharp, 0.0), min(mxLocal + 0.025 * sharp, 1.0));

      if (u_temporalStrength > 0.01) {
        vec3 prevCol = texture(u_historyTex, v_fboUv).rgb;
        float motion = length(denoised - prevCol) + abs(getLuma(denoised) - getLuma(prevCol)) * 1.5;
        float motionGate = 1.0 - smoothstep(0.015, 0.085, motion);
        float blendFactor = clamp(u_temporalStrength * 0.72 * motionGate, 0.0, 0.75);
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

      vec3 easuOut = easu;

      // Pack Chroma + Luma Native Structural Confidence into Alpha (.a) for Pass 2
      float mnL = min(min(fL, gL), min(jL, kL));
      float mxL = max(max(fL, gL), max(jL, kL));
      float chromaSpan = length(mx4 - mn4) * 0.70;
      float edgeSpan = max((mxL - mnL) * 1.15, chromaSpan);
      float structConf = clamp(smoothstep(0.006, 0.10, edgeSpan) * (0.35 + 0.65 * len), 0.0, 1.0);

      fragColor = vec4(clamp(easuOut, 0.0, 1.0), structConf);
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
      float edge_factor = smoothstep(0.012, 0.12, strength) * coherence;

      float scaleT = mix(1.0, 0.72, edge_factor);
      float scaleN = mix(1.0, 1.52, edge_factor);
      float lob = mix(0.10, 0.35, edge_factor);

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

      vec3 raisrOut = recon;

      // Pack Chroma + Luma Structure Tensor confidence into Alpha (.a)
      float chromaSpan = length(mx4 - mn4) * 0.65;
      float edgeSignal = max(strength, chromaSpan * 0.5);
      float structConf = clamp(smoothstep(0.005, 0.085, edgeSignal) * (0.30 + 0.70 * coherence), 0.0, 1.0);

      fragColor = vec4(clamp(raisrOut, 0.0, 1.0), structConf);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE A: Official AMD FSR 1.0 RCAS Guided by Alpha (.a)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_FSR_RCAS: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 e4 = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(e4.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.35);

      vec4 b4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 d4 = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 f4 = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));
      vec4 h4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));

      vec3 cas_b = b4.rgb; vec3 cas_d = d4.rgb; vec3 cas_e = e4.rgb;
      vec3 cas_f = f4.rgb; vec3 cas_h = h4.rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      vec3 rcpMx = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 amp   = sqrt(clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0));

      // Combine Pass-1 Alpha (.a), local variance, and hardware fwidth() sub-pixel edges
      float nativeConf = max(e4.a, (b4.a + d4.a + f4.a + h4.a) * 0.25);
      float localVar   = length(mxRGB - mnRGB);
      float structGate = max(max(nativeConf, smoothstep(0.006, 0.032, localVar)), hwEdge);

      // Official AMD GPUOpen FSR_RCAS_LIMIT (|w| <= 0.185 keeps 1 + 4w >= 0.25)
      float peak = -mix(0.0, 0.185, pow(sharp, 0.85)) * mlBoost;
      vec3  w    = clamp(amp * peak * (0.35 + 0.65 * structGate), vec3(-0.185), vec3(0.0));

      vec3 rcpWeight = 1.0 / max(1.0 + 4.0 * w, vec3(0.25));
      vec3 finalColor = (cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight;
      finalColor = clamp(finalColor, max(mnRGB - 0.06 * sharp * mlBoost, 0.0), min(mxRGB + 0.06 * sharp * mlBoost, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 0.95);

      vec3 outRgb = finalColor;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, finalColor, smoothstep(0.0, 0.08, sharp));
      } else {
        outRgb = applyCinemaGrain(outRgb, sharp);
      }
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE B: Google RAISR Refinement Guided by Alpha (.a)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_RAISR: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.42);

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
      vec3 st_p = texture(u_upscaledTex, v_fboUv + t_dir * u_outTexelSize * 0.90).rgb;
      vec3 st_n = texture(u_upscaledTex, v_fboUv - t_dir * u_outTexelSize * 0.90).rgb;

      // Combine Pass-1 Tensor Coherence (.a), Pass-2 Sobel, and hardware fwidth()
      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float gate = max(max(nativeConf, smoothstep(0.012, 0.080, strength)), hwEdge);

      vec3 smoothed = mix(c_c, (st_p + c_c * 2.0 + st_n) * 0.25, 0.22 * gate * sharp);
      vec3 high_n = smoothed - (sn_p + sn_n) * 0.5;
      vec3 finalColor = smoothed + high_n * (sharp * 2.35 * mlBoost * (0.40 + 0.60 * gate));

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(sn_p, sn_n)));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(sn_p, sn_n)));
      finalColor = clamp(finalColor, max(mnLocal - 0.06 * sharp * mlBoost, 0.0), min(mxLocal + 0.06 * sharp * mlBoost, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 0.85);

      vec3 outRgb = finalColor;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, finalColor, smoothstep(0.0, 0.08, sharp));
      } else {
        outRgb = applyCinemaGrain(outRgb, sharp);
      }
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — CINEMA MODE C: FSRCNN Feature Convolution (Native tanh() + .a)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_FSRCNN: `${NOVA_PASS2_HEADER}

    float fsrcnn_act(float x, float conf) {
      float gate = max(conf * 0.85, smoothstep(0.003, 0.016, abs(x)));
      return tanh(x) * gate;
    }

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.42);

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

      float yc = getLumaRec601(c_c);
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
      vec3 c_t1 = texture(u_upscaledTex, v_fboUv + tang * u_outTexelSize).rgb;
      vec3 c_t2 = texture(u_upscaledTex, v_fboUv - tang * u_outTexelSize).rgb;

      float y_n1 = getLumaRec601(c_n1); float y_n2 = getLumaRec601(c_n2);
      float y_t1 = getLumaRec601(c_t1); float y_t2 = getLumaRec601(c_t2);
      float y_ring = (yt + yb + yl + yr + ytl + ytr + ybl + ybr) * 0.125;

      float h_normal   = yc - (y_n1 + y_n2) * 0.5;
      float h_tangent  = yc - (y_t1 + y_t2) * 0.5;
      float h_texture  = yc - y_ring;

      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float edgeConf   = max(nativeConf, hwEdge);

      float f_a = fsrcnn_act(h_normal  * 2.10 + h_texture * 0.55, edgeConf);
      float f_b = fsrcnn_act(h_tangent * 0.65,                    edgeConf);
      float f_c = fsrcnn_act(h_texture * 1.65 - h_normal * 0.15,  edgeConf);

      float sr_residual = f_a * 0.60 + f_b * 0.10 + f_c * 0.30;
      vec3 neural = c_c + vec3(sr_residual * (sharp * 1.90 * mlBoost));

      vec3 mnSym = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_n1, c_n2), min(c_t1, c_t2))));
      vec3 mxSym = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_n1, c_n2), max(c_t1, c_t2))));
      vec3 finalColor = clamp(neural, max(mnSym - 0.06 * sharp * mlBoost, 0.0), min(mxSym + 0.06 * sharp * mlBoost, 1.0));
      finalColor = applyMasterDeconv(finalColor, v_fboUv, sharp, 1.05);

      vec3 outRgb = finalColor;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, finalColor, smoothstep(0.0, 0.08, sharp));
      } else {
        outRgb = applyCinemaGrain(outRgb, sharp);
      }
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 1: "Pure" (Alpha + fwidth() Guided RCAS + Soft Grain-Safe AA)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_Pure: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 e4 = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(e4.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.32);

      vec4 b4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0,  o.y));
      vec4 d4 = texture(u_upscaledTex, v_fboUv + vec2(-o.x,  0.0));
      vec4 f4 = texture(u_upscaledTex, v_fboUv + vec2( o.x,  0.0));
      vec4 h4 = texture(u_upscaledTex, v_fboUv + vec2( 0.0, -o.y));

      vec3 cas_b = b4.rgb; vec3 cas_d = d4.rgb; vec3 cas_e = e4.rgb;
      vec3 cas_f = f4.rgb; vec3 cas_h = h4.rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      vec3 rcpMx = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 amp   = sqrt(clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0));

      float nativeConf = max(e4.a, (b4.a + d4.a + f4.a + h4.a) * 0.25);
      float localVar   = length(mxRGB - mnRGB);
      float edgeGate   = max(max(nativeConf, smoothstep(0.006, 0.030, localVar)), hwEdge);

      // Safe GPUOpen RCAS bound: |w| <= 0.1818 keeps (1 + 4w) >= 0.27
      float peak      = -mix(0.0, 0.1818, pow(sharp, 0.85)) * mlBoost;
      vec3  w         = clamp(amp * peak * (0.35 + 0.65 * edgeGate), vec3(-0.1818), vec3(0.0));
      vec3 rcpWeight  = 1.0 / max(1.0 + 4.0 * w, vec3(0.25));
      vec3 rcasColor  = clamp((cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight, max(mnRGB - 0.04 * sharp * mlBoost, 0.0), min(mxRGB + 0.04 * sharp * mlBoost, 1.0));

      float gx = getLumaRec601(cas_f) - getLumaRec601(cas_d);
      float gy = getLumaRec601(cas_b) - getLumaRec601(cas_h);
      float edge = max(smoothstep(0.03, 0.18, length(vec2(gx, gy))), hwEdge * 0.85);
      vec3 avg = (cas_e + cas_b + cas_d + cas_f + cas_h) * 0.20;
      vec3 finalColor = applyMasterDeconv(mix(rcasColor, avg, edge * 0.08 * sharp), v_fboUv, sharp, 0.70);

      vec3 outRgb = clamp(finalColor, 0.0, 1.0);
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, outRgb, smoothstep(0.0, 0.08, sharp));
      }
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

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
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

      float nativeConf = max(c4_c.a, max(max(c4_t.a, c4_b.a), max(c4_l.a, c4_r.a)));
      float edge_mask  = max(max(nativeConf * 0.92, smoothstep(0.014, 0.10, mag)), hwEdge * 0.90);

      vec3 c_ring  = (c_tl + c_t + c_tr + c_l + c_r + c_bl + c_b + c_br) * 0.125;
      float l_ring = getLumaRec601(c_ring);

      vec3 c_warped = c_c;
      if (mag > 0.006) {
        vec2 nDir = grad / mag;
        vec2 tang = vec2(-nDir.y, nDir.x);

        // Stage 1: Fine sub-pixel stroke consolidation (eyes, pupils, thin 1px lineart)
        vec4 s1Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 0.48, 0.0, 1.0));
        vec4 s1Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 0.48, 0.0, 1.0));

        // Stage 2: Bounded adaptive blur-ramp collapse guided by Pass-1 Alpha (.a) minimum gradient
        vec4 s2Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 0.95, 0.0, 1.0));
        vec4 s2Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 0.95, 0.0, 1.0));

        vec3 pBright = mix(s1Bright.rgb, s2Bright.rgb, 0.58);
        vec3 pDark   = mix(s1Dark.rgb,   s2Dark.rgb,   0.58);
        float lMid   = (getLumaRec601(pBright) + getLumaRec601(pDark)) * 0.5;

        // Min-Grad Push: pulls pixel toward whichever side of the edge has lower .a turbulence
        float minGradPull = clamp((s2Dark.a - s2Bright.a) + (s1Dark.a - s1Bright.a) * 0.5, -0.5, 1.0) * 0.024;
        float t = smoothstep(-0.028, 0.028, (l_cc - lMid) + 0.024 * sharp + minGradPull);
        vec3 pinched = mix(pDark, pBright, t);

        vec3 tangA = texture(u_upscaledTex, clamp(v_fboUv + tang * u_outTexelSize * 0.60, 0.0, 1.0)).rgb;
        vec3 tangB = texture(u_upscaledTex, clamp(v_fboUv - tang * u_outTexelSize * 0.60, 0.0, 1.0)).rgb;
        vec3 cleanStroke = pinched * 0.86 + (tangA + tangB) * 0.07;
        c_warped = mix(c_c, cleanStroke, edge_mask * (0.62 + 0.32 * sharp));
      }

      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float darken_gate = 1.0 - smoothstep(0.12, 0.35, sat) * 0.72;
      vec3 deblurred = c_warped + (c_warped - c_ring) * (sharp * 1.60 * mlBoost) * edge_mask;
      float is_valley = clamp((l_ring - l_cc) * 4.0, 0.0, 1.0) * step(l_cc, 0.38);
      deblurred -= deblurred * (is_valley * edge_mask * 0.24 * sharp * mlBoost * darken_gate);

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));
      vec3 cleanAnime = clamp(deblurred, max(mnLocal - 0.06 * sharp * mlBoost, 0.0), min(mxLocal + 0.06 * sharp * mlBoost, 1.0));
      cleanAnime = applyMasterDeconv(cleanAnime, v_fboUv, sharp, 0.90);

      vec3 outRgb = cleanAnime;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, cleanAnime, smoothstep(0.0, 0.08, sharp));
      }
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2 — ANIME 3: "Sharp" (Alpha + fwidth() Guided 9-Tap Ring USM)
  // ══════════════════════════════════════════════════════════════════════════
  pass2_Anime_Sharp: `${NOVA_PASS2_HEADER}

    void main() {
      vec4 c4_c = texture(u_upscaledTex, v_fboUv);
      float hwEdge = getSubpxEdge(c4_c.rgb);
      ${NOVA_SPLIT_PASS2}

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
      vec2 o = getAdaptiveStep(0.48);

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

      vec3 c_ring  = (c_tl + c_t + c_tr + c_l + c_r + c_bl + c_b + c_br) * 0.125;
      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));

      float nativeConf = max(c4_c.a, (c4_t.a + c4_b.a + c4_l.a + c4_r.a) * 0.25);
      float edgeMask   = max(max(nativeConf, smoothstep(0.010, 0.065, length(mxLocal - mnLocal))), hwEdge);

      vec3 usm = c_c + (c_c - c_ring) * (sharp * 2.25 * mlBoost) * (0.35 + 0.65 * edgeMask);
      usm = clamp(usm, max(mnLocal - 0.065 * sharp * mlBoost, 0.0), min(mxLocal + 0.065 * sharp * mlBoost, 1.0));
      usm = applyMasterDeconv(usm, v_fboUv, sharp, 1.15);

      vec3 outRgb = usm;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, usm, smoothstep(0.0, 0.08, sharp));
      }
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

      float sharp   = clamp(u_sharpness, 0.0, 1.0);
      float mlBoost = 1.0 + 0.28 * clamp(u_multiLayer, 0.0, 1.0);
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

      float nativeConf = max(c4_c.a, max(max(c4_t.a, c4_b.a), max(c4_l.a, c4_r.a)));
      float edge_mask  = max(max(nativeConf * 0.96, smoothstep(0.010, 0.09, mag)), hwEdge * 0.95);

      vec3 c_ring  = (c_tl + c_t + c_tr + c_l + c_r + c_bl + c_b + c_br) * 0.125;
      float l_ring = getLumaRec601(c_ring);

      vec3 c_warped = c_c;
      if (mag > 0.006) {
        vec2 nDir = grad / mag;
        vec2 tang = vec2(-nDir.y, nDir.x);

        vec4 s1Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * 0.55, 0.0, 1.0));
        vec4 s1Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * 0.55, 0.0, 1.0));

        float span = 0.96 + 0.08 * sharp;
        vec4 s2Bright = texture(u_upscaledTex, clamp(v_fboUv + nDir * o * span, 0.0, 1.0));
        vec4 s2Dark   = texture(u_upscaledTex, clamp(v_fboUv - nDir * o * span, 0.0, 1.0));

        vec3 pBright = mix(s1Bright.rgb, s2Bright.rgb, 0.65);
        vec3 pDark   = mix(s1Dark.rgb,   s2Dark.rgb,   0.65);
        float lMid   = (getLumaRec601(pBright) + getLumaRec601(pDark)) * 0.5;

        float minGradPull = clamp((s2Dark.a - s2Bright.a) + (s1Dark.a - s1Bright.a) * 0.5, -0.5, 1.0) * 0.032;
        float t = smoothstep(-0.024, 0.024, (l_cc - lMid) + 0.044 * sharp + minGradPull);
        vec3 pinched = mix(pDark, pBright, t);

        vec3 tangA = texture(u_upscaledTex, clamp(v_fboUv + tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        vec3 tangB = texture(u_upscaledTex, clamp(v_fboUv - tang * u_outTexelSize * 0.65, 0.0, 1.0)).rgb;
        c_warped = mix(c_c, pinched * 0.86 + (tangA + tangB) * 0.07, edge_mask * (0.74 + 0.24 * sharp));
      }

      float sat = max(c_c.r, max(c_c.g, c_c.b)) - min(c_c.r, min(c_c.g, c_c.b));
      float darken_gate = 1.0 - smoothstep(0.15, 0.45, sat) * 0.75;

      vec3 deblurred = c_warped + (c_warped - c_ring) * (sharp * 2.00 * mlBoost) * edge_mask;
      float is_valley = clamp((l_ring - l_cc) * 4.5, 0.0, 1.0) * step(l_cc, 0.40);
      deblurred -= deblurred * (is_valley * edge_mask * 0.30 * sharp * mlBoost * darken_gate);

      vec3 mnLocal = min(c_c, min(min(min(c_t, c_b), min(c_l, c_r)), min(min(c_tl, c_tr), min(c_bl, c_br))));
      vec3 mxLocal = max(c_c, max(max(max(c_t, c_b), max(c_l, c_r)), max(max(c_tl, c_tr), max(c_bl, c_br))));
      vec3 cleanIntense = clamp(deblurred, max(mnLocal - 0.07 * sharp * mlBoost, 0.0), min(mxLocal + 0.07 * sharp * mlBoost, 1.0));
      cleanIntense = applyMasterDeconv(cleanIntense, v_fboUv, sharp, 1.30);

      vec3 outRgb = cleanIntense;
      if (sharp < 0.08) {
        outRgb = mix(texture(u_texture, v_uv).rgb, cleanIntense, smoothstep(0.0, 0.08, sharp));
      }
      fragColor = vec4(applyNovaHDR(outRgb, v_fboUv, u_upscaledTex, u_outTexelSize), 1.0);
    }
  `
};
