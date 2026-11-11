/**
 * NovaScale - WebGL Engine v5.0
 *
 * v5.0 Optimizations:
 * - Native multi-shader support: Anime4K-Ultra Suite (Pure, DbL, Sharp, DbH) & Cinema Pro Trilogy (FSR 1.0, Google RAISR, FSRCNN).
 * - desynchronized: false (eliminates DirectComposition MPO conflicts on Windows 11).
 * - gl.texImage2D deduplication: transfers decoded frames to the GPU texture only
 *   when video currentTime changes, allowing smooth 120 FPS slider updates
 *   even while paused without saturating the PCIe bus.
 * - UNPACK_FLIP_Y_WEBGL = false (preserves Zero-Copy D3D11VA NV12 -> RGBA).
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
    this.splitPos          = -1.0;
    this.isContextLost     = false;

    this._lastUploadedTime = -1;
    this._lastVideoW       = 0;
    this._lastVideoH       = 0;
    this._hasValidTexture  = false;

    this._onLost = (e) => {
      e.preventDefault();
      this.isContextLost = true;
      this._hasValidTexture = false;
      console.warn('[NovaScale] WebGL context lost.');
    };
    this._onRestored = () => {
      this.isContextLost = false;
      this._lastUploadedTime = -1;
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
      powerPreference:               'default',
      desynchronized:                false,
      failIfMajorPerformanceCaveat:  false
    };

    this.gl = this.canvas.getContext('webgl2', attrs)
           || this.canvas.getContext('webgl',  attrs);

    if (!this.gl) {
      console.warn('[NovaScale] WebGL is unavailable.');
      return;
    }

    const gl = this.gl;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,           false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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
    const s  = gl.createShader(type);
    gl.shaderSource(s, src);
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
      pos:   gl.getAttribLocation(prog,  'a_position'),
      tex:   gl.getUniformLocation(prog, 'u_texture'),
      texel: gl.getUniformLocation(prog, 'u_texelSize'),
      sharp: gl.getUniformLocation(prog, 'u_sharpness'),
      split: gl.getUniformLocation(prog, 'u_splitPos')
    };

    return prog;
  }

  _initPrograms() {
    const sh = window.NovaShaders;
    if (!sh || !this.gl) return;
    const gl = this.gl;

    Object.values(this.programs).forEach(p => { if (p) gl.deleteProgram(p); });
    this.programs = {};

    this.programs.passthrough    = this._makeProgram(sh.vertexShader, sh.passthroughFrag);
    this.programs.cinema         = this._makeProgram(sh.vertexShader, sh.cinemaFrag);
    this.programs['cinema-fsr']   = this.programs.cinema;
    this.programs['cinema-raisr'] = this._makeProgram(sh.vertexShader, sh.cinemaFrag_RAISR);
    this.programs['cinema-fsrcnn']= this._makeProgram(sh.vertexShader, sh.cinemaFrag_FSRCNN);
    this.programs['anime-pure']  = this._makeProgram(sh.vertexShader, sh.animeFrag_Pure);
    this.programs['anime-dbl']   = this._makeProgram(sh.vertexShader, sh.animeFrag_DbL);
    this.programs['anime-sharp'] = this._makeProgram(sh.vertexShader, sh.animeFrag_Sharp);
    this.programs['anime-dbh']   = this._makeProgram(sh.vertexShader, sh.animeFrag_DbH);
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
    this.currentMode = valid.includes(mode) ? mode : 'anime-dbl';
  }

  setSharpness(v) {
    const n = parseFloat(v);
    if (!isNaN(n)) this.sharpness = Math.min(1, Math.max(0, n));
  }

  setSplit(v) {
    this.splitPos = typeof v === 'number'
      ? Math.min(1, Math.max(-1, v))
      : (v ? 0.5 : -1);
  }

  /**
   * Renders the current video frame using the active shader program.
   * @param {HTMLVideoElement} video
   * @param {boolean} forceUpload - Forces texture upload even when currentTime is unchanged.
   * @returns {boolean} false only when a permanent CORS/DRM security block is encountered.
   */
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
    const needsUpload = forceUpload
      || !this._hasValidTexture
      || resolutionChanged
      || Math.abs(curTime - this._lastUploadedTime) > 0.0001;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (needsUpload) {
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

    gl.viewport(0, 0, dW, dH);
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const loc = prog._loc;
    if (loc.pos >= 0) {
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
    }

    if (loc.tex)   gl.uniform1i(loc.tex,   0);
    if (loc.texel) gl.uniform2f(loc.texel, 1.0 / srcW, 1.0 / srcH);
    if (loc.sharp) gl.uniform1f(loc.sharp, this.sharpness);
    if (loc.split) gl.uniform1f(loc.split, this.splitPos);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }

  destroy() {
    try {
      this.canvas.removeEventListener('webglcontextlost',     this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    } catch (_) {}

    this.isContextLost = true;

    const gl = this.gl;
    if (gl) {
      try {
        if (this.texture)    gl.deleteTexture(this.texture);
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        Object.values(this.programs).forEach(p => { if (p) gl.deleteProgram(p); });
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (_) {}
    }

    this.gl         = null;
    this.texture    = null;
    this.quadBuffer = null;
    this.programs   = {};
    this.canvas     = null;
  }
}

window.NovaScaleRenderer = NovaScaleRenderer;
