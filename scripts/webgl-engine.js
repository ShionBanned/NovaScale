/**
 * NovaScale - WebGL2 Engine v7.0 (Native #version 300 es 2-Pass & 3-Pass Pipeline)
 */

class NovaScaleRenderer {
  constructor(canvas) {
    this.canvas            = canvas;
    this.gl                = null;
    this.programs          = {};
    this.quadBuffer        = null;
    this.texture           = null;

    this.currentMode       = 'anime-dbl';
    this.sharpness         = 0.75;
    this.hdr               = false;
    this.multiLayer        = false;
    this.splitPos          = -1.0;
    this.temporalDenoise   = 0.0;
    this.mirrorX           = false;
    this.isContextLost     = false;

    // FBO_B (TEXTURE1): Target Super-Resolution (dW x dH)
    this._fbo              = null;
    this._fboTex           = null;
    this._fboW             = 0;
    this._fboH             = 0;

    // FBO_A (TEXTURE2): Native Resolution (srcW x srcH) for Layer 0 Pre-Restore
    this._preFbo           = null;
    this._preFboTex        = null;
    this._preFboW          = 0;
    this._preFboH          = 0;

    // History FBO (TEXTURE3): Native Resolution (srcW x srcH) for Temporal Denoiser
    this._histFbo          = null;
    this._histFboTex       = null;
    this._histFboW         = 0;
    this._histFboH         = 0;
    this._histValid        = false;

    this._blackFrameCount  = 0;
    this._blackProbeStart  = -1;
    this._lastProbeTime    = -1;
    this._drmVerifiedClean = false;
    this._probeBuf         = new Uint8Array(4);

    this._lastUploadedTime = -1;
    this._lastVideoW       = 0;
    this._lastVideoH       = 0;
    this._hasValidTexture  = false;
    this._fboDirty         = true;

    this._onLost = (e) => {
      e.preventDefault();
      this.isContextLost = true;
      this._hasValidTexture = false;
      this._fbo = null;
      this._fboTex = null;
      this._fboW = 0;
      this._fboH = 0;
      this._preFbo = null;
      this._preFboTex = null;
      this._preFboW = 0;
      this._preFboH = 0;
      this._histFbo = null;
      this._histFboTex = null;
      this._histFboW = 0;
      this._histFboH = 0;
      this._histValid = false;
      console.warn('[NovaScale] WebGL context lost.');
    };
    this._onRestored = () => {
      this.isContextLost = false;
      this._lastUploadedTime = -1;
      this._blackFrameCount  = 0;
      this._blackProbeStart  = -1;
      this._lastProbeTime    = -1;
      this._drmVerifiedClean = false;
      this._fbo              = null;
      this._fboTex           = null;
      this._fboW             = 0;
      this._fboH             = 0;
      this._preFbo           = null;
      this._preFboTex        = null;
      this._preFboW          = 0;
      this._preFboH          = 0;
      this._histFbo          = null;
      this._histFboTex       = null;
      this._histFboW         = 0;
      this._histFboH         = 0;
      this._histValid        = false;
      this._fboDirty         = true;
      console.info('[NovaScale] WebGL context restored.');
      this._initGL();
    };

    canvas.addEventListener('webglcontextlost',     this._onLost,     false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._initGL();
  }

  _initGL() {
    const attrs = {
      alpha:                         false,
      antialias:                     false,
      depth:                         false,
      stencil:                       false,
      preserveDrawingBuffer:         false,
      powerPreference:               'high-performance',
      desynchronized:                false,
      failIfMajorPerformanceCaveat:  false
    };

    this.gl = this.canvas.getContext('webgl2', attrs);

    if (!this.gl) {
      console.warn('[NovaScale] WebGL2 is unavailable.');
      return;
    }

    const gl = this.gl;
    try {
      if ('drawingBufferColorSpace' in gl) {
        gl.drawingBufferColorSpace = 'srgb';
      }
    } catch (colorSpaceErr) {
      console.debug('[NovaScale] drawingBufferColorSpace fallback:', colorSpaceErr);
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,                false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,     false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    this._initBuffers();
    this._initTexture();

    if (window.NovaShaders) {
      this._initPrograms();
    }
  }

  _makeShader(type, src) {
    const gl = this.gl;
    if (!src) return null;
    const s  = gl.createShader(type);
    gl.shaderSource(s, src.trimStart());
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[NovaScale] Shader compilation error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  _makeProgram(vsrc, fsrc) {
    const gl = this.gl;
    const vs = this._makeShader(gl.VERTEX_SHADER,   vsrc);
    if (!vs) return null;
    const fs = this._makeShader(gl.FRAGMENT_SHADER, fsrc);
    if (!fs) { gl.deleteShader(vs); return null; }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[NovaScale] Program linking error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }

    prog._loc = {
      pos:              gl.getAttribLocation(prog,  'a_position'),
      flipY:            gl.getUniformLocation(prog, 'u_flipY'),
      mirrorX:          gl.getUniformLocation(prog, 'u_mirrorX'),
      tex:              gl.getUniformLocation(prog, 'u_texture'),
      upTex:            gl.getUniformLocation(prog, 'u_upscaledTex'),
      historyTex:       gl.getUniformLocation(prog, 'u_historyTex'),
      texel:            gl.getUniformLocation(prog, 'u_texelSize'),
      outTexel:         gl.getUniformLocation(prog, 'u_outTexelSize'),
      sharp:            gl.getUniformLocation(prog, 'u_sharpness'),
      temporalStrength: gl.getUniformLocation(prog, 'u_temporalStrength'),
      split:            gl.getUniformLocation(prog, 'u_splitPos'),
      hdr:              gl.getUniformLocation(prog, 'u_hdr'),
      multi:            gl.getUniformLocation(prog, 'u_multiLayer')
    };

    return prog;
  }

  _initPrograms() {
    const sh = window.NovaShaders;
    if (!sh || !this.gl) return;
    const gl = this.gl;

    new Set(Object.values(this.programs)).forEach(p => { if (p) gl.deleteProgram(p); });
    this.programs = {};

    const pass0Anime  = sh.pass0_Restore_Anime  ? this._makeProgram(sh.vertexShader, sh.pass0_Restore_Anime)  : null;
    const pass0Cinema = sh.pass0_Restore_Cinema ? this._makeProgram(sh.vertexShader, sh.pass0_Restore_Cinema) : null;
    const pass1Easu   = this._makeProgram(sh.vertexShader, sh.pass1_EASU);
    const pass1Raisr  = this._makeProgram(sh.vertexShader, sh.pass1_RAISR);

    this.programs.pass0Anime  = pass0Anime;
    this.programs.pass0Cinema = pass0Cinema;
    this.programs.pass1Easu   = pass1Easu;
    this.programs.pass1Raisr  = pass1Raisr;
    this.programs.passthrough = this._makeProgram(sh.vertexShader, sh.passthroughFrag);

    const bindChain = (pass0Prog, pass1Prog, fragSrc) => {
      const p2 = this._makeProgram(sh.vertexShader, fragSrc);
      if (p2) {
        p2._pass0 = pass0Prog;
        p2._pass1 = pass1Prog;
      }
      return p2;
    };

    this.programs.cinema           = bindChain(pass0Cinema, pass1Easu,  sh.pass2_FSR_RCAS);
    this.programs['cinema-fsr']    = this.programs.cinema;
    this.programs['cinema-raisr']  = bindChain(pass0Cinema, pass1Raisr, sh.pass2_RAISR);
    this.programs['cinema-fsrcnn'] = bindChain(pass0Cinema, pass1Easu,  sh.pass2_FSRCNN);
    this.programs['anime-pure']    = bindChain(pass0Anime,  pass1Easu,  sh.pass2_Anime_Pure);
    this.programs['anime-dbl']     = bindChain(pass0Anime,  pass1Easu,  sh.pass2_Anime_DbL);
    this.programs['anime-sharp']   = bindChain(pass0Anime,  pass1Easu,  sh.pass2_Anime_Sharp);
    this.programs['anime-dbh']     = bindChain(pass0Anime,  pass1Easu,  sh.pass2_Anime_DbH);
  }

  _ensurePreFbo(srcW, srcH) {
    const gl = this.gl;
    if (!gl) return false;
    if (this._preFbo && this._preFboTex && this._preFboW === srcW && this._preFboH === srcH) {
      return true;
    }

    if (!this._preFbo) this._preFbo = gl.createFramebuffer();
    if (!this._preFboTex) {
      this._preFboTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._preFboTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._preFboTex);
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, srcW, srcH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._preFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._preFboTex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this._preFboW = 0;
      this._preFboH = 0;
      return false;
    }

    this._preFboW = srcW;
    this._preFboH = srcH;
    this._fboDirty = true;
    return true;
  }

  _ensureHistFbo(srcW, srcH) {
    const gl = this.gl;
    if (!gl) return false;
    if (this._histFbo && this._histFboTex && this._histFboW === srcW && this._histFboH === srcH) {
      return true;
    }

    if (!this._histFbo) this._histFbo = gl.createFramebuffer();
    if (!this._histFboTex) {
      this._histFboTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._histFboTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._histFboTex);
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, srcW, srcH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._histFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._histFboTex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this._histFboW = 0;
      this._histFboH = 0;
      this._histValid = false;
      return false;
    }

    this._histFboW = srcW;
    this._histFboH = srcH;
    this._histValid = false;
    this._fboDirty = true;
    return true;
  }

  _ensureFbo(dW, dH) {
    const gl = this.gl;
    if (!gl) return false;
    if (this._fbo && this._fboTex && this._fboW === dW && this._fboH === dH) {
      return true;
    }

    if (!this._fbo) this._fbo = gl.createFramebuffer();
    if (!this._fboTex) {
      this._fboTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex);
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dW, dH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fboTex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this._fboW = 0;
      this._fboH = 0;
      return false;
    }

    this._fboW = dW;
    this._fboH = dH;
    this._fboDirty = true;
    return true;
  }

  _initBuffers() {
    const gl = this.gl;
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  }

  _initTexture() {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this._hasValidTexture  = false;
    this._lastUploadedTime = -1;
  }

  setMode(mode) {
    if (mode === 'anime' || mode === 'anime-ultra' || mode === 'anime-a') mode = 'anime-dbl';
    if (mode === 'cinema') mode = 'cinema-fsr';
    const valid = [
      'anime-pure', 'anime-dbl', 'anime-sharp', 'anime-dbh',
      'cinema-fsr', 'cinema-raisr', 'cinema-fsrcnn', 'cinema',
      'off', 'passthrough'
    ];
    const nextMode = valid.includes(mode) ? mode : 'anime-dbl';
    if (nextMode !== this.currentMode) {
      this.currentMode = nextMode;
      this._fboDirty = true;
    }
  }

  setSharpness(v) {
    const n = parseFloat(v);
    if (!isNaN(n)) {
      const nextSharp = Math.min(1, Math.max(0, n));
      if (Math.abs(nextSharp - this.sharpness) > 1e-6) {
        this.sharpness = nextSharp;
        this._fboDirty = true;
      }
    }
  }

  setHdr(v) {
    this.hdr = Boolean(v);
  }

  setMultiLayer(v) {
    const nextMulti = Boolean(v);
    if (nextMulti !== this.multiLayer) {
      this.multiLayer = nextMulti;
      this._fboDirty = true;
    }
  }

  setSplit(v) {
    this.splitPos = typeof v === 'number'
      ? Math.min(1, Math.max(-1, v))
      : (v ? 0.5 : -1);
  }

  setTemporalDenoise(v) {
    const n = parseFloat(v);
    if (!isNaN(n)) {
      const nextTemporal = Math.min(1, Math.max(0, n));
      if (Math.abs(nextTemporal - this.temporalDenoise) > 1e-6) {
        this.temporalDenoise = nextTemporal;
        if (nextTemporal <= 0.01) {
          this._histValid = false;
        }
        this._fboDirty = true;
      }
    }
  }

  setMirror(v) {
    const nextMirror = Boolean(v);
    if (nextMirror !== this.mirrorX) {
      this.mirrorX = nextMirror;
      this._histValid = false;
      this._fboDirty = true;
    }
  }

  resetTemporalHistory() {
    this._histValid = false;
    this._hasValidTexture = false;
    this._fboDirty = true;
  }

  render(video, forceUpload = false) {
    const gl = this.gl;
    if (!gl || this.isContextLost) return false;
    if (!video || video.readyState < 2) return true;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) return true;

    const dW = this.canvas.width;
    const dH = this.canvas.height;
    if (!dW || !dH) return true;

    if (!this.programs['anime-dbl'] && window.NovaShaders) {
      this._initPrograms();
    }

    let mode = this.currentMode;
    if (mode === 'anime' || mode === 'anime-ultra' || mode === 'anime-a') mode = 'anime-dbl';
    if (mode === 'cinema') mode = 'cinema-fsr';
    let prog = this.programs[mode] || this.programs['cinema-fsr'] || this.programs['anime-dbl'] || this.programs.passthrough;

    if (!prog) return true;

    const curTime = video.currentTime;
    const resolutionChanged = (srcW !== this._lastVideoW || srcH !== this._lastVideoH);
    if (resolutionChanged) {
      this._histValid = false;
    }
    const needsUpload = forceUpload
      || !this._hasValidTexture
      || resolutionChanged
      || Math.abs(curTime - this._lastUploadedTime) > 0.0001;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (needsUpload) {
      this._fboDirty = true;
      try {
        gl.texImage2D(
          gl.TEXTURE_2D, 0,
          gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
          video
        );
        this._lastUploadedTime = curTime;
        this._lastVideoW       = srcW;
        this._lastVideoH       = srcH;
        this._hasValidTexture  = true;
      } catch (e) {
        if (e && (e.name === 'SecurityError' || (e.message && e.message.includes('tainted')))) {
          return false;
        }
        return true;
      }
    }

    const usePassthrough = this.sharpness <= 0.001 || mode === 'off' || mode === 'passthrough';
    const canMultiPass   = !usePassthrough && prog && prog._pass1 && this._ensureFbo(dW, dH);
    const pass2Prog      = canMultiPass ? prog : (this.programs.passthrough || prog);
    const hdrCode        = this.hdr ? (mode.startsWith('cinema') ? 2.0 : 1.0) : 0.0;
    const mirrorVal      = this.mirrorX ? 1.0 : 0.0;
    const useTemporal    = this.temporalDenoise > 0.01;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);

    let use3Layer = false;
    let usePass0  = false;
    if (canMultiPass) {
      use3Layer = Boolean(this.multiLayer && pass2Prog._pass0);
      usePass0  = Boolean((this.multiLayer || useTemporal) && pass2Prog._pass0 && this._ensurePreFbo(srcW, srcH));
      if (!usePass0 || !useTemporal) {
        this._histValid = false;
      }

      if (needsUpload || this._fboDirty) {
        // ── LAYER 0 (3-Pass or Temporal Denoise): Native-Grid Pre-Restore (TEXTURE0 -> _preFbo / TEXTURE2)
        if (usePass0) {
          const p0 = pass2Prog._pass0;
          const hasHist = useTemporal && this._ensureHistFbo(srcW, srcH);
          const activeTemporal = (hasHist && this._histValid) ? this.temporalDenoise : 0.0;

          gl.bindFramebuffer(gl.FRAMEBUFFER, this._preFbo);
          gl.viewport(0, 0, srcW, srcH);
          gl.useProgram(p0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          if (hasHist) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, this._histFboTex);
          }

          const l0 = p0._loc;
          if (l0.pos >= 0) {
            gl.enableVertexAttribArray(l0.pos);
            gl.vertexAttribPointer(l0.pos, 2, gl.FLOAT, false, 0, 0);
          }
          if (l0.flipY)            gl.uniform1f(l0.flipY,            1.0); // Flip raw video Y
          if (l0.mirrorX)          gl.uniform1f(l0.mirrorX,          mirrorVal);
          if (l0.tex)              gl.uniform1i(l0.tex,              0);
          if (l0.historyTex)       gl.uniform1i(l0.historyTex,       hasHist ? 3 : 0);
          if (l0.temporalStrength) gl.uniform1f(l0.temporalStrength, activeTemporal);
          if (l0.texel)            gl.uniform2f(l0.texel,            1.0 / srcW, 1.0 / srcH);
          if (l0.sharp)            gl.uniform1f(l0.sharp,            this.sharpness);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          if (hasHist && (needsUpload || !this._histValid)) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, this._histFboTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, srcW, srcH);
            this._histValid = true;
          }
          gl.activeTexture(gl.TEXTURE0);
        }

        // ── LAYER 1: Spatial Directional Upscale + Alpha (.a) Map (-> _fbo / TEXTURE1)
        const p1 = pass2Prog._pass1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
        gl.viewport(0, 0, dW, dH);
        gl.useProgram(p1);

        if (usePass0) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, this._preFboTex);
        } else {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
        }

        const l1 = p1._loc;
        if (l1.pos >= 0) {
          gl.enableVertexAttribArray(l1.pos);
          gl.vertexAttribPointer(l1.pos, 2, gl.FLOAT, false, 0, 0);
        }
        // _preFboTex (TEXTURE2) is already upright and mirrored (0.0); raw video (TEXTURE0) needs flip/mirror
        if (l1.flipY)   gl.uniform1f(l1.flipY,   usePass0 ? 0.0 : 1.0);
        if (l1.mirrorX) gl.uniform1f(l1.mirrorX, usePass0 ? 0.0 : mirrorVal);
        if (l1.tex)     gl.uniform1i(l1.tex,     usePass0 ? 2 : 0);
        if (l1.texel)   gl.uniform2f(l1.texel,   1.0 / srcW, 1.0 / srcH);
        if (l1.sharp)   gl.uniform1f(l1.sharp,   this.sharpness);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this._fboDirty = false;
      }
    } else {
      this._histValid = false;
    }

    // ── LAYER 2 (or Passthrough): Target-Grid Refinement + Split-Screen + HDR -> Screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, dW, dH);
    gl.useProgram(pass2Prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this._fboTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex);
    }

    const loc = pass2Prog._loc;
    if (loc.pos >= 0) {
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
    }

    if (loc.flipY)    gl.uniform1f(loc.flipY,    1.0);
    if (loc.mirrorX)  gl.uniform1f(loc.mirrorX,  mirrorVal);
    if (loc.tex)      gl.uniform1i(loc.tex,      0);
    if (loc.upTex)    gl.uniform1i(loc.upTex,    1);
    if (loc.texel)    gl.uniform2f(loc.texel,    1.0 / srcW, 1.0 / srcH);
    if (loc.outTexel) gl.uniform2f(loc.outTexel, 1.0 / dW,   1.0 / dH);
    if (loc.sharp)    gl.uniform1f(loc.sharp,    this.sharpness);
    if (loc.split)    gl.uniform1f(loc.split,    this.splitPos);
    if (loc.hdr)      gl.uniform1f(loc.hdr,      hdrCode);
    if (loc.multi)    gl.uniform1f(loc.multi,    (use3Layer && usePass0) ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);

    const mayHaveDrm = Boolean(video.mediaKeys)
      || /(^|\.)(netflix|nflxvideo|disneyplus|bamgrid|max|hbomax|primevideo|amazon|tv\.apple|crunchyroll|hulu|peacocktv|paramountplus|dazn)\./i.test(location.hostname);
    if (
      mayHaveDrm &&
      !this._drmVerifiedClean &&
      needsUpload &&
      curTime > 1.0 &&
      !video.paused &&
      Math.abs(curTime - this._lastProbeTime) >= 0.15
    ) {
      this._lastProbeTime = curTime;
      try {
        const pts = [
          [0.5, 0.5], [0.25, 0.25], [0.75, 0.25],
          [0.25, 0.75], [0.75, 0.75], [0.5, 0.85]
        ];
        let hasSignal = false;
        for (let i = 0; i < pts.length; i++) {
          const px = Math.max(0, Math.min(dW - 1, Math.round(dW * pts[i][0])));
          const py = Math.max(0, Math.min(dH - 1, Math.round(dH * pts[i][1])));
          gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._probeBuf);
          if (this._probeBuf[0] > 2 || this._probeBuf[1] > 2 || this._probeBuf[2] > 2) {
            hasSignal = true;
            break;
          }
        }

        if (hasSignal) {
          this._drmVerifiedClean = true;
          this._blackFrameCount  = 0;
          this._blackProbeStart  = -1;
        } else {
          if (this._blackProbeStart < 0 || curTime < this._blackProbeStart) {
            this._blackProbeStart = curTime;
          }
          if (++this._blackFrameCount >= 25 && (curTime - this._blackProbeStart) >= 4.0) {
            return false;
          }
        }
      } catch (_probeErr) {
        return false;
      }
    }

    return true;
  }

  destroy() {
    try {
      this.canvas.removeEventListener('webglcontextlost',     this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    } catch (rmErr) {
      console.debug('[NovaScale] Listener cleanup skipped:', rmErr);
    }

    this.isContextLost = true;

    const gl = this.gl;
    if (gl) {
      try {
        if (this.texture)    gl.deleteTexture(this.texture);
        if (this._fboTex)    gl.deleteTexture(this._fboTex);
        if (this._fbo)       gl.deleteFramebuffer(this._fbo);
        if (this._preFboTex)  gl.deleteTexture(this._preFboTex);
        if (this._preFbo)     gl.deleteFramebuffer(this._preFbo);
        if (this._histFboTex) gl.deleteTexture(this._histFboTex);
        if (this._histFbo)    gl.deleteFramebuffer(this._histFbo);
        if (this.quadBuffer)  gl.deleteBuffer(this.quadBuffer);
        new Set(Object.values(this.programs)).forEach(p => { if (p) gl.deleteProgram(p); });
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (destroyErr) {
        console.debug('[NovaScale] WebGL destroy cleanup warning:', destroyErr);
      }
    }

    this.gl         = null;
    this.texture    = null;
    this._fbo       = null;
    this._fboTex    = null;
    this._fboW      = 0;
    this._fboH      = 0;
    this._preFbo    = null;
    this._preFboTex = null;
    this._preFboW   = 0;
    this._preFboH   = 0;
    this._histFbo    = null;
    this._histFboTex = null;
    this._histFboW   = 0;
    this._histFboH   = 0;
    this._histValid  = false;
    this.quadBuffer = null;
    this.programs   = {};
    this.canvas     = null;
  }
}

window.NovaScaleRenderer = NovaScaleRenderer;
