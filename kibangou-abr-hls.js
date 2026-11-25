/**
 * KibangouTV - Module HLS Adaptive Bitrate (ABR) Optimisé 2G/3G Afrique
 * ====================================================================
 * Fournit une adaptation dynamique intelligente du débit et de la résolution,
 * prévenant les saccades et coupures sur les connexions mobiles instables.
 * Standards Congo-Dev Engineering & Software Craftsmanship.
 */

import OriginalHls from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

export * from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

export class KibangouHls extends OriginalHls {
  constructor(userConfig = {}) {
    // Profil ABR optimisé pour réseaux mobiles 2G/3G instables et gros segments VOD
    const abrConfig = {
      abrEwmaDefaultEstimate: 450000,
      abrBandWidthFactor: 0.80,
      abrBandWidthUpFactor: 0.70,
      abrMaxWithRealBitrate: true,
      capLevelToPlayerSize: true,

      startLevel: -1,
      autoStartLoad: true,

      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1024 * 1024,
      backBufferLength: 15,
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 2,
      nudgeOffset: 0.2,
      nudgeMaxRetry: 6,

      fragLoadingTimeOut: 60000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 600,
      manifestLoadingTimeOut: 30000,
      manifestLoadingMaxRetry: 4,
      levelLoadingTimeOut: 30000,
      levelLoadingMaxRetry: 4,

      ...userConfig
    };

    super(abrConfig);

    // Enregistrement global pour le sélecteur d'interface KibangouTV
    window.__kibangouHls = this;
    window.Hls = KibangouHls;

    // Rétrogradation automatique immédiate en cas de chute de bande passante ou buffer stall
    this.on(OriginalHls.Events.ERROR, (event, data) => {
      if (!data) return;

      if (data.fatal) {
        if (data.type === OriginalHls.ErrorTypes.NETWORK_ERROR) {
          console.warn("[KibangouTV ABR] Incident réseau détecté, relance du flux...");
          this.startLoad();
        } else if (data.type === OriginalHls.ErrorTypes.MEDIA_ERROR) {
          console.warn("[KibangouTV ABR] Incident média détecté, reconstruction du buffer...");
          this.recoverMediaError();
        }
      } else if (data.details === OriginalHls.ErrorDetails.BUFFER_STALLED_ERROR) {
        // En cas de saccade ou chute de débit : rétrogradation immédiate d'un niveau
        if (this.autoLevelEnabled && this.currentLevel > 0) {
          const targetLevel = Math.max(0, this.currentLevel - 1);
          console.warn(`[KibangouTV ABR] Détection de gigue/stall réseau 2G/3G : rétrogradation vers niveau ${targetLevel}`);
          this.nextLevel = targetLevel;
        }
      }
    });

    this.on(OriginalHls.Events.MANIFEST_PARSED, (event, data) => {
      window.dispatchEvent(new CustomEvent("kibangou-levels-updated", {
        detail: { levels: this.levels, hls: this }
      }));

      // Appliquer la préférence de qualité sauvegardée si existante
      const savedPref = localStorage.getItem("kibangoutv_preferred_quality");
      if (savedPref && window.setKibangouQuality) {
        window.setKibangouQuality(savedPref, false);
      }
    });

    this.on(OriginalHls.Events.LEVEL_SWITCHED, (event, data) => {
      window.dispatchEvent(new CustomEvent("kibangou-quality-switched", {
        detail: { level: data.level, hls: this }
      }));
    });

    window.dispatchEvent(new CustomEvent("kibangou-hls-attached", {
      detail: { hls: this }
    }));
  }

  /**
   * Applique une résolution cible ("auto", "1080p", "720p", "480p", "360p")
   * en sélectionnant le profil le plus adapté dans le manifest HLS.
   */
  setQualityLevel(targetQuality) {
    if (targetQuality === "auto" || targetQuality === -1) {
      this.currentLevel = -1;
      this.loadLevel = -1;
      this.nextLevel = -1;
      return -1;
    }

    if (!this.levels || !this.levels.length) {
      return -1;
    }

    const targetHeight = parseInt(targetQuality, 10);
    if (isNaN(targetHeight)) return -1;

    let bestIdx = 0;
    let minDiff = Infinity;

    this.levels.forEach((lvl, idx) => {
      const h = lvl.height || 0;
      const diff = Math.abs(h - targetHeight);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = idx;
      }
    });

    this.currentLevel = bestIdx;
    this.loadLevel = bestIdx;
    this.nextLevel = bestIdx;
    return bestIdx;
  }
}

export default KibangouHls;
export { KibangouHls as Hls };
