/**
 * NovaScale - Popup Controller v3.0 (Dual-Core Bento Engine Architecture)
 * Synchronizes primary engines (Anime Studio vs. Cinema Pro) and contextual profiles.
 */

function t(key, fallback) {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
      const msg = chrome.i18n.getMessage(key);
      if (msg) return msg;
    }
  } catch (_) {}
  return fallback;
}

function hydrateI18n() {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      document.documentElement.lang = chrome.i18n.getUILanguage();
    }
  } catch (_) {}

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key, el.textContent);
    if (translated) el.textContent = translated;
  });

  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const currentAria = el.getAttribute('aria-label') || '';
    const translated = t(key, currentAria);
    if (translated) el.setAttribute('aria-label', translated);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  hydrateI18n();

  const toggleEnable = document.getElementById('toggleEnable');
  const toggleSplit = document.getElementById('toggleSplit');
  const toggleDeepMode = document.getElementById('toggleDeepMode');
  const deepModeSubtitle = document.getElementById('deepModeSubtitle');
  const toggleHdr = document.getElementById('toggleHdr');
  const hdrSubtitle = document.getElementById('hdrSubtitle');
  const toggleMultiLayer = document.getElementById('toggleMultiLayer');
  const multiLayerSubtitle = document.getElementById('multiLayerSubtitle');
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const optionsContainer = document.getElementById('optionsContainer');

  const btnEngineAnime = document.getElementById('btnEngineAnime');
  const btnEngineCinema = document.getElementById('btnEngineCinema');
  const animeProfilesSection = document.getElementById('animeProfilesSection');
  const cinemaProfilesSection = document.getElementById('cinemaProfilesSection');
  const pillButtons = document.querySelectorAll('.pill-btn');
  const cinemaPillButtons = document.querySelectorAll('.cinema-pill-btn');

  const modeInfoText = document.getElementById('modeInfoText');
  const sharpnessRange = document.getElementById('sharpnessRange');
  const sharpnessVal = document.getElementById('sharpnessVal');
  const deepIntensityCard = document.getElementById('deepIntensityCard');
  const deepIntensityRange = document.getElementById('deepIntensityRange');
  const deepIntensityVal = document.getElementById('deepIntensityVal');

  const modeDescriptions = {
    'anime-pure':    t('descAnimePure', 'Anime4K-Ultra Pure: FSR 1.0 + Soft Thin AA. Preserves 100% original grain, oil paintings, and hand-drawn textures.'),
    'anime-dbl':     t('descAnimeDbl', 'Anime4K-Ultra Deblur (Recommended): FSR 1.0 + Smart reconstruction with background gating and hue protection.'),
    'anime-sharp':   t('descAnimeSharp', 'Anime4K-Ultra Sharp: FSR 1.0 + 9-Tap Unsharp Masking. Maximum contour clarity and crisp micro-contrast.'),
    'anime-dbh':     t('descAnimeDbh', 'Anime4K-Ultra Intense: FSR 1.0 + Heavy Deblur + Deep Ink Punch. Rebuilds blurry line art from low-res sources.'),
    'cinema-fsr':    t('descCinemaFsr', 'Official AMD FSR 1.0 (GPUOpen): 12-Tap EASU + RCAS. Anisotropic spatial reconstruction for movies and live-action video.'),
    'cinema-raisr':  t('descCinemaRaisr', 'Google RAISR: 2D Structure Tensor & steered elliptical filter. Organic sharpness on faces and edges preserving film grain.'),
    'cinema-fsrcnn': t('descCinemaFsrcnn', 'FSRCNN Neural: EASU geometric base + symmetric PReLU convolution. Ultra-clean cinema clarity with compression denoising.'),
    'cinema':        t('descCinemaFsr', 'Official AMD FSR 1.0 (GPUOpen): 12-Tap EASU + RCAS. Anisotropic spatial reconstruction for movies and live-action video.')
  };

  let state = {
    enabled: true,
    engine: 'anime',             // 'anime' | 'cinema'
    animeProfile: 'anime-dbl',   // 'anime-pure' | 'anime-dbl' | 'anime-sharp' | 'anime-dbh'
    cinemaProfile: 'cinema-fsr', // 'cinema-fsr' | 'cinema-raisr' | 'cinema-fsrcnn'
    mode: 'anime-dbl',
    sharpness: 0.75,
    deepIntensity: 0.75,
    hdr: false,
    multiLayer: false,
    deepMode: false,
    splitScreen: false
  };

  let debounceTimer = null;
  let hasPendingSave = false;

  // 1. Load persisted user preferences with legacy auto-migration
  chrome.storage.local.get(['enabled', 'mode', 'sharpness', 'deepIntensity', 'hdr', 'multiLayer', 'deepMode', 'splitScreen', 'engine', 'animeProfile', 'cinemaProfile'], (res) => {
    if (chrome.runtime.lastError) {
      console.warn('NovaScale: failed to read local storage:', chrome.runtime.lastError);
      return;
    }

    const isFirstInstall = res.enabled === undefined;

    if (res.enabled !== undefined) state.enabled = Boolean(res.enabled);
    if (typeof res.sharpness === 'number' && !isNaN(res.sharpness)) {
      state.sharpness = Math.max(0.0, Math.min(1.0, res.sharpness));
    }
    if (typeof res.deepIntensity === 'number' && !isNaN(res.deepIntensity)) {
      state.deepIntensity = Math.max(0.0, Math.min(1.0, res.deepIntensity));
    }
    if (res.hdr !== undefined) state.hdr = Boolean(res.hdr);
    if (res.multiLayer !== undefined) state.multiLayer = Boolean(res.multiLayer);
    if (res.deepMode !== undefined) state.deepMode = Boolean(res.deepMode);
    if (res.splitScreen !== undefined) state.splitScreen = Boolean(res.splitScreen);

    // Resolve active mode and engine
    let storedMode = res.mode;
    if (storedMode === 'anime' || storedMode === 'anime-ultra' || storedMode === 'anime-a') storedMode = 'anime-dbl';
    if (storedMode === 'cinema') storedMode = 'cinema-fsr';

    if (['cinema-fsr', 'cinema-raisr', 'cinema-fsrcnn'].includes(storedMode)) {
      state.engine = 'cinema';
      state.cinemaProfile = storedMode;
      state.mode = storedMode;
      state.animeProfile = res.animeProfile || 'anime-dbl';
    } else {
      state.engine = 'anime';
      state.animeProfile = ['anime-pure', 'anime-dbl', 'anime-sharp', 'anime-dbh'].includes(storedMode)
        ? storedMode
        : (res.animeProfile || 'anime-dbl');
      state.cinemaProfile = ['cinema-fsr', 'cinema-raisr', 'cinema-fsrcnn'].includes(res.cinemaProfile)
        ? res.cinemaProfile
        : 'cinema-fsr';
      state.mode = state.animeProfile;
    }

    if (isFirstInstall) {
      chrome.storage.local.set(state);
    }

    updateUI();
    notifyActiveTab(state);
  });

  // 2. Reactive storage synchronization when preferences change externally
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    let changed = false;
    if (changes.enabled && changes.enabled.newValue !== state.enabled) {
      state.enabled = Boolean(changes.enabled.newValue);
      changed = true;
    }
    if (changes.mode) {
      let m = changes.mode.newValue;
      if (m === 'anime' || m === 'anime-ultra' || m === 'anime-a') m = 'anime-dbl';
      if (m === 'cinema') m = 'cinema-fsr';
      if (m !== state.mode) {
        state.mode = m;
        if (['cinema-fsr', 'cinema-raisr', 'cinema-fsrcnn'].includes(m)) {
          state.engine = 'cinema';
          state.cinemaProfile = m;
        } else {
          state.engine = 'anime';
          state.animeProfile = m;
        }
        changed = true;
      }
    }
    if (changes.sharpness && changes.sharpness.newValue !== state.sharpness) {
      state.sharpness = Math.max(0.0, Math.min(1.0, changes.sharpness.newValue));
      changed = true;
    }
    if (changes.deepIntensity && changes.deepIntensity.newValue !== state.deepIntensity) {
      state.deepIntensity = Math.max(0.0, Math.min(1.0, changes.deepIntensity.newValue));
      changed = true;
    }
    if (changes.hdr && changes.hdr.newValue !== state.hdr) {
      state.hdr = Boolean(changes.hdr.newValue);
      changed = true;
    }
    if (changes.multiLayer && changes.multiLayer.newValue !== state.multiLayer) {
      state.multiLayer = Boolean(changes.multiLayer.newValue);
      changed = true;
    }
    if (changes.deepMode && changes.deepMode.newValue !== state.deepMode) {
      state.deepMode = Boolean(changes.deepMode.newValue);
      changed = true;
    }
    if (changes.splitScreen && changes.splitScreen.newValue !== state.splitScreen) {
      state.splitScreen = Boolean(changes.splitScreen.newValue);
      changed = true;
    }

    if (changed) {
      updateUI();
    }
  });

  // 3. Render and update reactive UI components
  function updateUI() {
    toggleEnable.checked = state.enabled;
    if (toggleMultiLayer) {
      toggleMultiLayer.checked = state.multiLayer;
    }
    if (multiLayerSubtitle) {
      multiLayerSubtitle.textContent = state.engine === 'anime'
        ? t('multiLayerSubtitleAnime', 'Pre-Denoise & Line Restore \u2192 EASU \u2192 Anime4K')
        : t('multiLayerSubtitleCinema', 'De-Block & Micro-Detail AI \u2192 EASU \u2192 Target Pass');
    }
    if (toggleHdr) {
      toggleHdr.checked = state.hdr;
    }
    if (hdrSubtitle) {
      hdrSubtitle.textContent = state.engine === 'anime'
        ? t('hdrSubtitleAnime', 'Cel-Shading Contrast, Specular Light & Hue Gate')
        : t('hdrSubtitleCinema', 'ACES Filmic Mapping, Vibrance & 10-bit Dithering');
    }
    if (toggleDeepMode) {
      toggleDeepMode.checked = state.deepMode;
      const card = toggleDeepMode.closest('.deepmode-card');
      if (card) card.classList.toggle('active', Boolean(state.deepMode));
    }
    if (deepIntensityCard) {
      deepIntensityCard.classList.toggle('hidden', !state.deepMode);
    }
    if (deepIntensityRange && deepIntensityVal) {
      const dPct = Math.round(state.deepIntensity * 100);
      deepIntensityRange.value = dPct;
      deepIntensityVal.textContent = `${dPct}%`;
      deepIntensityRange.style.background = `linear-gradient(to right, #10b981 0%, #10b981 ${dPct}%, #1e293b ${dPct}%, #1e293b 100%)`;
    }
    if (deepModeSubtitle) {
      deepModeSubtitle.textContent = state.engine === 'anime'
        ? t('deepModeSubtitleAnime', 'APISR Deep Line & Cel Reconstruction (2.0x)')
        : t('deepModeSubtitleCinema', 'SPAN Deep Attention & Texture Recovery (2.0x)');
    }
    if (toggleSplit) {
      toggleSplit.checked = state.splitScreen;
    }

    if (state.enabled) {
      statusPill.className = 'status-pill active';
      statusText.textContent = t('statusActive', 'Active');
      if (optionsContainer) optionsContainer.classList.remove('disabled');
    } else {
      statusPill.className = 'status-pill';
      statusText.textContent = t('statusPaused', 'Paused');
      if (optionsContainer) optionsContainer.classList.add('disabled');
    }

    // Update primary engine cards
    if (state.engine === 'anime') {
      btnEngineAnime.classList.add('active');
      btnEngineAnime.setAttribute('aria-pressed', 'true');
      btnEngineCinema.classList.remove('active');
      btnEngineCinema.setAttribute('aria-pressed', 'false');
      animeProfilesSection.classList.remove('hidden');
      if (cinemaProfilesSection) cinemaProfilesSection.classList.add('hidden');
    } else {
      btnEngineCinema.classList.add('active');
      btnEngineCinema.setAttribute('aria-pressed', 'true');
      btnEngineAnime.classList.remove('active');
      btnEngineAnime.setAttribute('aria-pressed', 'false');
      animeProfilesSection.classList.add('hidden');
      if (cinemaProfilesSection) cinemaProfilesSection.classList.remove('hidden');
    }

    // Update Anime4K profile pills
    pillButtons.forEach((btn) => {
      const prof = btn.getAttribute('data-profile');
      if (prof === state.animeProfile) {
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-checked', 'false');
      }
    });

    // Update Cinema Pro profile pills
    cinemaPillButtons.forEach((btn) => {
      const cProf = btn.getAttribute('data-cinemaprofile');
      if (cProf === state.cinemaProfile) {
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-checked', 'false');
      }
    });

    // Update contextual mode description banner
    modeInfoText.textContent = modeDescriptions[state.mode] || modeDescriptions['anime-dbl'];

    // Update sharpness slider visual track
    const percent = Math.round(state.sharpness * 100);
    sharpnessRange.value = percent;
    sharpnessVal.textContent = `${percent}%`;

    const accentColor = state.engine === 'anime' ? '#8b5cf6' : '#06b6d4';
    sharpnessRange.style.background = `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${percent}%, #1e293b ${percent}%, #1e293b 100%)`;
  }

  // 4. Push active updates to active browser tab (with auto-injection for pre-existing tabs)
  function notifyActiveTab(partialPayload) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
        const activeTab = tabs[0];
        if (!activeTab || !activeTab.id) return;
        const tabId = activeTab.id;

        chrome.tabs.sendMessage(tabId, {
          action: 'UPDATE_CONFIG',
          payload: partialPayload
        }).catch(() => {
          // Tab was open before extension reload/install: dynamically inject engine & content scripts
          if (chrome.scripting && chrome.scripting.executeScript) {
            chrome.scripting.executeScript({
              target: { tabId: tabId, allFrames: true },
              files: ['core/native-bridge/native-client.js', 'core/webgpu/wgsl-shaders.js', 'core/webgpu/webgpu-engine.js', 'scripts/shaders.js', 'scripts/webgl-engine.js', 'scripts/content.js']
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, {
                  action: 'UPDATE_CONFIG',
                  payload: state
                }).catch(() => {});
              }, 60);
            }).catch(() => {});
          }
        });
      });
    } catch (_) {}
  }

  // 5. Immediate persistence to chrome.storage.local
  function saveImmediate(partialUpdate = null) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    hasPendingSave = false;

    chrome.storage.local.set(state, () => {
      if (chrome.runtime.lastError) {
        console.warn('NovaScale: failed to save settings:', chrome.runtime.lastError);
      }
    });

    notifyActiveTab(partialUpdate || state);
  }

  // 6. Debounced persistence for smooth real-time slider scrubbing
  function saveDebounced(partialUpdate) {
    hasPendingSave = true;
    notifyActiveTab(partialUpdate);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      hasPendingSave = false;
      chrome.storage.local.set(state);
    }, 35);
  }

  // 7. DOM Event Listeners
  toggleEnable.addEventListener('change', (e) => {
    state.enabled = e.target.checked;
    updateUI();
    saveImmediate({ enabled: state.enabled });
  });

  if (toggleMultiLayer) {
    toggleMultiLayer.addEventListener('change', (e) => {
      state.multiLayer = e.target.checked;
      updateUI();
      saveImmediate({ multiLayer: state.multiLayer });
    });
  }

  if (toggleHdr) {
    toggleHdr.addEventListener('change', (e) => {
      state.hdr = e.target.checked;
      updateUI();
      saveImmediate({ hdr: state.hdr });
    });
  }

  if (toggleDeepMode) {
    toggleDeepMode.addEventListener('change', (e) => {
      state.deepMode = e.target.checked;
      updateUI();
      saveImmediate({ deepMode: state.deepMode });
    });
  }

  if (toggleSplit) {
    toggleSplit.addEventListener('change', (e) => {
      state.splitScreen = e.target.checked;
      updateUI();
      saveImmediate({ splitScreen: state.splitScreen });
    });
  }

  // Primary engine selection
  btnEngineAnime.addEventListener('click', () => {
    if (state.engine === 'anime') return;
    state.engine = 'anime';
    state.mode = state.animeProfile;
    updateUI();
    saveImmediate({ engine: 'anime', mode: state.mode });
  });

  btnEngineCinema.addEventListener('click', () => {
    if (state.engine === 'cinema') return;
    state.engine = 'cinema';
    state.mode = state.cinemaProfile;
    updateUI();
    saveImmediate({ engine: 'cinema', mode: state.mode, cinemaProfile: state.cinemaProfile });
  });

  // Anime4K profile selection
  pillButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const selectedProfile = btn.getAttribute('data-profile');
      if (state.animeProfile === selectedProfile && state.mode === selectedProfile) return;
      state.animeProfile = selectedProfile;
      state.engine = 'anime';
      state.mode = selectedProfile;
      updateUI();
      saveImmediate({ animeProfile: selectedProfile, mode: selectedProfile, engine: 'anime' });
    });
  });

  // Cinema Pro profile selection
  cinemaPillButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const selectedProfile = btn.getAttribute('data-cinemaprofile');
      if (state.cinemaProfile === selectedProfile && state.mode === selectedProfile) return;
      state.cinemaProfile = selectedProfile;
      state.engine = 'cinema';
      state.mode = selectedProfile;
      updateUI();
      saveImmediate({ cinemaProfile: selectedProfile, mode: selectedProfile, engine: 'cinema' });
    });
  });

  // Sharpness slider interaction
  sharpnessRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.sharpness = val / 100.0;
    sharpnessVal.textContent = `${val}%`;
    const accentColor = state.engine === 'anime' ? '#8b5cf6' : '#06b6d4';
    sharpnessRange.style.background = `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${val}%, #1e293b ${val}%, #1e293b 100%)`;
    saveDebounced({ sharpness: state.sharpness });
  });

  sharpnessRange.addEventListener('change', () => {
    saveImmediate({ sharpness: state.sharpness });
  });

  // Independent Deep AI Intensity slider interaction
  if (deepIntensityRange) {
    deepIntensityRange.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.deepIntensity = val / 100.0;
      if (deepIntensityVal) deepIntensityVal.textContent = `${val}%`;
      deepIntensityRange.style.background = `linear-gradient(to right, #10b981 0%, #10b981 ${val}%, #1e293b ${val}%, #1e293b 100%)`;
      saveDebounced({ deepIntensity: state.deepIntensity });
    });

    deepIntensityRange.addEventListener('change', () => {
      saveImmediate({ deepIntensity: state.deepIntensity });
    });
  }

  const flushPending = () => {
    if (hasPendingSave || debounceTimer) {
      saveImmediate();
    }
  };

  window.addEventListener('beforeunload', flushPending);
  window.addEventListener('pagehide', flushPending);
});
