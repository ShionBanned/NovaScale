/**
 * NovaScale - Main World Injector v4.0
 * Execution: world: "MAIN", run_at: "document_start", all_frames: true
 *
 * Responsibilities:
 * 1. Enforce crossOrigin = "anonymous" on all <video> elements with direct HTTP(S) sources
 *    BEFORE network fetching begins.
 * 2. Keep MSE streams (blob:), data:, and MediaStream (srcObject) used by
 *    YouTube, Twitch, and HLS.js untouched (already same-origin in memory and CORS-exempt).
 * 3. If Chrome's C++ parser started a no-cors fetch on a static <video> before this hook,
 *    apply crossOrigin = "anonymous" and cleanly restart the pipeline (video.load()).
 * 4. Intercept Element.prototype.attachShadow (including mode: 'closed') to expose
 *    encapsulated players to the isolated content script.
 */

(function () {
  'use strict';

  if (window.__novascale_main_v4) return;
  window.__novascale_main_v4 = true;

  const IS_MSE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|twitch\.tv|netflix\.com|nflxvideo\.net|disneyplus\.com|bamgrid\.com|max\.com|hbomax\.com|primevideo\.com|amazon\.com|tv\.apple\.com)$/i.test(
    location.hostname
  );

  function isDirectHttpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return false;
    return true;
  }

  /**
   * Intelligently applies crossOrigin = "anonymous" and reloads the stream
   * if the browser had already begun fetching the resource in no-cors mode.
   */
  function enforceCorsOnVideo(video, incomingUrl) {
    if (!video || video.nodeType !== 1 || video.tagName !== 'VIDEO') return;
    if (IS_MSE_HOST || video.srcObject) return;

    const candidateUrl =
      incomingUrl ||
      video.getAttribute('src') ||
      video.currentSrc ||
      (video.querySelector && video.querySelector('source[src]')?.getAttribute('src')) ||
      '';

    // If blob: (HLS.js / Dash.js / MSE), do not touch crossOrigin
    if (candidateUrl && (candidateUrl.startsWith('blob:') || candidateUrl.startsWith('data:'))) {
      return;
    }

    try {
      if (video.crossOrigin !== 'anonymous') {
        const alreadyFetchingNoCors =
          video.networkState !== HTMLMediaElement.NETWORK_EMPTY &&
          isDirectHttpUrl(candidateUrl);

        const savedTime = video.currentTime || 0;
        const wasPlaying = !video.paused && !video.ended;

        video.crossOrigin = 'anonymous';
        video.setAttribute('crossorigin', 'anonymous');

        // If HTML parser began fetching without CORS before this hook,
        // force network renegotiation using declarativeNetRequest headers from rules.json.
        if (alreadyFetchingNoCors && !video.dataset.novascaleReloaded) {
          video.dataset.novascaleReloaded = '1';
          video.load();
          if (savedTime > 0) {
            video.addEventListener(
              'loadedmetadata',
              () => {
                try { video.currentTime = savedTime; } catch (_) {}
              },
              { once: true }
            );
          }
          if (wasPlaying) {
            video.play().catch(() => {});
          }
        }
      }
    } catch (_) {}
  }

  // 1. Shadow DOM piercing (open & closed modes)
  const origAttachShadow = Element.prototype.attachShadow;
  if (origAttachShadow) {
    Element.prototype.attachShadow = function (init) {
      // Force mode: 'open' so isolated content script can inspect host.shadowRoot directly.
      const patchedInit = Object.assign({}, init, { mode: 'open' });
      const root = origAttachShadow.call(this, patchedInit);
      try {
        observeRoot(root);
      } catch (_) {}
      return root;
    };
  }

  // 2. Intercept Document.prototype.createElement
  const origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, options) {
    const el = arguments.length > 1
      ? origCreateElement.call(this, tagName, options)
      : origCreateElement.call(this, tagName);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'video' && !IS_MSE_HOST) {
      try {
        el.crossOrigin = 'anonymous';
      } catch (_) {}
    }
    return el;
  };

  // 3. Intercept 'src' setter on HTMLMediaElement (<video src="...">)
  const mediaSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (mediaSrcDesc && mediaSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set: function (val) {
        if (this.tagName === 'VIDEO' && typeof val === 'string') {
          if (val.startsWith('blob:') || val.startsWith('data:')) {
            // For MSE blobs, removing crossOrigin avoids MediaSource conflicts
            if (this.hasAttribute('crossorigin')) {
              this.removeAttribute('crossorigin');
            }
          } else if (!IS_MSE_HOST && !this.srcObject) {
            this.crossOrigin = 'anonymous';
          }
        }
        return mediaSrcDesc.set.call(this, val);
      },
      get: mediaSrcDesc.get,
      configurable: true,
      enumerable: true
    });
  }

  // 4. Intercept 'src' setter on HTMLSourceElement (<source src="...">)
  if (window.HTMLSourceElement) {
    const sourceSrcDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
    if (sourceSrcDesc && sourceSrcDesc.set) {
      Object.defineProperty(HTMLSourceElement.prototype, 'src', {
        set: function (val) {
          if (typeof val === 'string' && isDirectHttpUrl(val) && !IS_MSE_HOST) {
            const parentVideo = this.parentElement;
            if (parentVideo && parentVideo.tagName === 'VIDEO') {
              enforceCorsOnVideo(parentVideo, val);
            }
          }
          return sourceSrcDesc.set.call(this, val);
        },
        get: sourceSrcDesc.get,
        configurable: true,
        enumerable: true
      });
    }
  }

  // 5. Intercept Element.prototype.setAttribute
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, val) {
    if (typeof name === 'string') {
      const lower = name.toLowerCase();
      if (lower === 'src' && typeof val === 'string') {
        if (this.tagName === 'VIDEO') {
          if (val.startsWith('blob:') || val.startsWith('data:')) {
            if (this.hasAttribute('crossorigin')) {
              this.removeAttribute('crossorigin');
            }
          } else if (!IS_MSE_HOST && !this.srcObject) {
            origSetAttribute.call(this, 'crossorigin', 'anonymous');
          }
        } else if (this.tagName === 'SOURCE' && isDirectHttpUrl(val) && !IS_MSE_HOST) {
          if (this.parentElement && this.parentElement.tagName === 'VIDEO') {
            enforceCorsOnVideo(this.parentElement, val);
          }
        }
      }
    }
    return origSetAttribute.call(this, name, val);
  };

  // 6. Real-time node scanner & observer
  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'VIDEO') {
      enforceCorsOnVideo(node);
    } else if (node.tagName === 'SOURCE' && node.parentElement?.tagName === 'VIDEO') {
      enforceCorsOnVideo(node.parentElement, node.getAttribute('src'));
    } else if (node.firstElementChild) {
      const videos = node.getElementsByTagName('video');
      for (let i = 0; i < videos.length; i++) {
        enforceCorsOnVideo(videos[i]);
      }
    }
    if (node.shadowRoot) {
      observeRoot(node.shadowRoot);
    }
  }

  const observedRoots = new WeakSet();
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);

    const obs = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          scanNode(added[j]);
        }
      }
    });
    obs.observe(root, { childList: true, subtree: true });

    if (root.querySelectorAll) {
      const vids = root.querySelectorAll('video');
      for (let i = 0; i < vids.length; i++) {
        enforceCorsOnVideo(vids[i]);
      }
    }
  }

  // Early capture on loadstart event in case a <video> is inserted
  // before the MutationObserver drains the microtask queue.
  window.addEventListener(
    'loadstart',
    (e) => {
      const target = e.composedPath ? e.composedPath()[0] : e.target;
      if (target && target.tagName === 'VIDEO') {
        enforceCorsOnVideo(target);
      }
    },
    true
  );

  observeRoot(document.documentElement || document);
})();
