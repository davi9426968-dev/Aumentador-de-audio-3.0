// Motor de áudio compartilhado.
// - offscreen.js usa o Engine para processar o áudio capturado de cada aba.
// - content_page.js usa o Engine no "modo compatível" (dentro da página).
// - popup.js e background.js usam as constantes e funções utilitárias.
//
// Cadeia de processamento:
//
//   entrada → [maximizador extremo] → volume (ganho puro) → reforço de graves → EQ 10 bandas
//           → [nivelador] → [limitador] → teto suave → saída
//
// SOBRE O VOLUME MÁXIMO
// Por padrão NÃO há limitador: o ganho é aplicado inteiro, como nos boosters
// populares. Um sinal digital não passa de 1.0 (0 dBFS); o que passar disso
// precisa ser cortado. Em vez do corte seco do navegador, a última etapa é um
// "teto suave": transparente até 90% do máximo e arredondado daí até 100%. O
// volume final é o mesmo do corte seco, só com menos aspereza.
// O modo "som limpo" liga um limitador antes do teto: zero distorção, mas em
// sons que já são altos ele segura o volume — por isso fica desligado por padrão.
//
// Volume acima de 1000% só faz diferença em áudio BAIXO (picos bem abaixo de
// 0 dBFS); 10000% (+40 dB) leva ao teto até áudio gravado quase em silêncio. Para áudio que já é alto, o que ainda aumenta a sensação de volume é
// o MODO EXTREMO: um maximizador antes do volume que iguala tudo (sussurro, fala,
// música, explosão) num nível alto; o volume então empurra esse nível até o teto.
//
// Atribuição com ??= em vez de `const`: evita SyntaxError se o arquivo for
// carregado duas vezes no mesmo contexto.

globalThis.VBAudio ??= (() => {
  const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_MIN = -12;
  const EQ_MAX = 12;
  const MAX_VOLUME = 100; // 10000% (+40 dB)
  const BASS_FREQ = 100; // Hz: abaixo disso o reforço de graves atua por inteiro
  const BASS_MAX_DB = 15; // reforço no máximo (bass = 1)
  const SPECTRUM_BANDS = 28; // barras do visualizador

  // Ganhos em dB por banda: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k
  const PRESETS = Object.freeze({
    flat: { label: "Plano", eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    // O ouvido é muito mais sensível entre 2 e 5 kHz: reforçar essa faixa e
    // tirar subgraves (que gastam potência sem "soar alto") faz o som parecer
    // bem mais alto com o mesmo pico digital.
    loud: { label: "Volume máximo (realce)", eq: [-6, -3, 0, 1, 2, 3, 5, 6, 4, 2] },
    pop: { label: "Pop", eq: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
    rock: { label: "Rock", eq: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5] },
    electronic: { label: "Eletrônica", eq: [6, 5, 2, 0, -2, 0, 1, 2, 4, 5] },
    hiphop: { label: "Hip-hop", eq: [7, 6, 3, 1, -1, -1, 1, 0, 2, 3] },
    jazz: { label: "Jazz", eq: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
    classical: { label: "Clássica", eq: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
    voice: { label: "Voz / Diálogos", eq: [-6, -4, -2, 0, 2, 4, 5, 4, 2, 0] },
    movie: { label: "Filme", eq: [3, 2, 1, 0, 0, 1, 2, 2, 1, 1] },
    bass: { label: "Graves+", eq: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    treble: { label: "Agudos+", eq: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
    // Alto-falantes pequenos não reproduzem subgraves; o reforço em 1–4 kHz é
    // onde o ouvido é mais sensível, então o som "parece" bem mais alto.
    laptop: { label: "Notebook / Caixinha", eq: [-8, -5, 0, 2, 1, 1, 2, 3, 2, 1] },
  });

  const DEFAULTS = Object.freeze({
    volume: 1,
    bass: 0,
    eq: Object.freeze(EQ_FREQS.map(() => 0)),
    preset: "flat",
    clean: false,
    leveler: false,
    extreme: false,
    // Sobe o volume do próprio player do site (YouTube etc.) para 100% quando o
    // booster está ligado: o som chega inteiro antes de ser amplificado.
    playerMax: true,
  });

  // Limitador (só no modo "som limpo"): teto logo abaixo de 0 dBFS.
  const LIMITER = { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.25 };
  // O DynamicsCompressor soma um ganho de compensação automático
  // (spec Web Audio: (1 / curva(0 dBFS))^0.6); desfazemos para não somar volume
  // escondido. Fórmula válida para knee = 0.
  const LIMITER_MAKEUP = Math.pow(10, (-(LIMITER.threshold - LIMITER.threshold / LIMITER.ratio) / 20) * 0.6);
  // Nivelador: sobe sons baixos (falas) ~7 dB e deixa os altos onde estão.
  // Aqui o ganho de compensação automático é justamente o efeito desejado.
  const LEVELER = { threshold: -24, knee: 12, ratio: 3, attack: 0.01, release: 0.3 };
  // Modo extremo: maximizador ANTES do volume (o sinal ainda está abaixo de
  // 0 dBFS, onde a compensação automática do compressor funciona a favor).
  // Tudo entre -45 dB e 0 dB sai numa faixa de poucos dB, e a compensação
  // automática (~+25 dB) + o trim põem esse nível perto de -6 LUFS já em 100%
  // (medido: com trim 2 a música alta ficava 3 dB MAIS BAIXA em 100%).
  const MAXIMIZER = { threshold: -45, knee: 6, ratio: 12, attack: 0.003, release: 0.15 };
  const MAXIMIZER_TRIM = 6; // +15,6 dB
  // Realce do modo extremo: graves profundos gastam o teto digital sem soar
  // alto (notebooks nem reproduzem) e 2–5 kHz é onde o ouvido é mais sensível.
  const EXTREME_LOW_SHELF = { frequency: 100, gain: -6 };
  const EXTREME_PRESENCE = { frequency: 3000, gain: 5, Q: 0.8 };

  // Teto suave: linear até CLIP_KNEE, depois satura com tanh até 1.0. A curva
  // cobre ±CLIP_RANGE (a entrada é atenuada por 1/CLIP_RANGE antes); acima
  // disso fica no próprio teto (1.0), sem degrau.
  const CLIP_KNEE = 0.9;
  const CLIP_RANGE = 16;

  function makeSoftClipCurve(n = 16384) {
    const curve = new Float32Array(n);
    const span = 1 - CLIP_KNEE;
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
      const ax = Math.abs(x);
      const y = ax <= CLIP_KNEE ? ax : CLIP_KNEE + span * Math.tanh((ax - CLIP_KNEE) / span);
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  }

  function clamp(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function normalize(s = {}) {
    const eq = Array.isArray(s.eq) ? s.eq : DEFAULTS.eq;
    const preset = typeof s.preset === "string" && (s.preset in PRESETS || s.preset === "custom") ? s.preset : DEFAULTS.preset;
    return {
      volume: clamp(s.volume, 0, MAX_VOLUME, DEFAULTS.volume),
      bass: clamp(s.bass, 0, 1, DEFAULTS.bass),
      eq: EQ_FREQS.map((_, i) => clamp(eq[i], EQ_MIN, EQ_MAX, 0)),
      preset,
      clean: typeof s.clean === "boolean" ? s.clean : DEFAULTS.clean,
      leveler: typeof s.leveler === "boolean" ? s.leveler : DEFAULTS.leveler,
      extreme: typeof s.extreme === "boolean" ? s.extreme : DEFAULTS.extreme,
      playerMax: typeof s.playerMax === "boolean" ? s.playerMax : DEFAULTS.playerMax,
    };
  }

  // Arredonda uma porcentagem de volume para um valor "redondo", com passo que
  // cresce junto com o volume (5% abaixo de 1000%, até 100% perto de 10000%).
  // Usado pelo slider (escala logarítmica) e pelos atalhos de teclado.
  function roundPercent(pct) {
    const step = pct < 1000 ? 5 : pct < 2000 ? 10 : pct < 5000 ? 50 : 100;
    return Math.min(MAX_VOLUME * 100, Math.max(0, Math.round(pct / step) * step));
  }

  // "Máximo extremo": a combinação mais alta que o motor consegue, num clique.
  // Medido: ~+1 LUFS na saída, 2–3 dB acima de só 10000% em alto-falante de
  // notebook. Graves ficam em 0 porque gastam o teto sem soar mais alto.
  function applyMaxExtreme(s) {
    return normalize({
      ...s,
      volume: MAX_VOLUME,
      extreme: true,
      eq: PRESETS.loud.eq,
      preset: "loud",
      bass: 0,
      clean: false,
      playerMax: true,
    });
  }

  function isMaxExtreme(s) {
    return s.volume === MAX_VOLUME && s.extreme && s.preset === "loud" && !s.clean;
  }

  // Texto do badge do ícone: cabe no máximo ~4 caracteres.
  function badgePercent(volume) {
    const pct = Math.round(volume * 100);
    return pct >= 10000 ? `${Math.round(pct / 1000)}k` : String(pct);
  }

  function matchPreset(eq) {
    const found = Object.entries(PRESETS).find(([, p]) => p.eq.every((g, i) => g === eq[i]));
    return found ? found[0] : "custom";
  }

  // ---------- Armazenamento ----------
  //   chrome.storage.session "tab:<id>" -> configurações daquela aba (volume individual por aba)
  //   chrome.storage.session "captured" -> ids das abas ligadas por captura da aba
  //   chrome.storage.session "pageTabs" -> ids das abas ligadas no modo compatível (dentro da página)
  //   chrome.storage.session "float:<id>" -> janela flutuante aberta naquela aba
  //   chrome.storage.session "premax:<id>" -> configurações de antes do "Máximo extremo" (para desfazer)
  //   chrome.storage.local   "last"     -> últimas configurações usadas (modelo para abas novas)
  //   chrome.storage.local   "ui"       -> preferências de interface (posição da janela flutuante etc.)
  //   chrome.storage.local   "prefs"    -> { compat } — sempre usar o modo compatível

  const tabKey = (tabId) => `tab:${tabId}`;
  const floatKey = (tabId) => `float:${tabId}`;
  const premaxKey = (tabId) => `premax:${tabId}`;

  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "file:") return "arquivo local";
      if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
    } catch {}
    return null;
  }

  // Páginas onde o Chrome não permite capturar áudio nem injetar scripts.
  function isRestrictedUrl(url) {
    if (!url) return true;
    return !/^(https?|file):/.test(url) || url.startsWith("https://chromewebstore.google.com") || url.startsWith("https://chrome.google.com/webstore");
  }

  // ---------- Engine ----------

  function setCompressor(node, cfg) {
    for (const [k, v] of Object.entries(cfg)) node[k].value = v;
  }

  class Engine {
    constructor(ctx, settings = DEFAULTS) {
      const s = normalize(settings);
      this.ctx = ctx;
      this.routing = null;
      this.bypassed = false;

      // Ponto de entrada (ganho fixo 1): quem usa o Engine liga a fonte aqui.
      this.input = ctx.createGain();

      this.maximizer = ctx.createDynamicsCompressor();
      setCompressor(this.maximizer, MAXIMIZER);
      this.maximizerTrim = ctx.createGain();
      this.maximizerTrim.gain.value = MAXIMIZER_TRIM;
      this.extremeLow = ctx.createBiquadFilter();
      this.extremeLow.type = "lowshelf";
      this.extremeLow.frequency.value = EXTREME_LOW_SHELF.frequency;
      this.extremeLow.gain.value = EXTREME_LOW_SHELF.gain;
      this.extremePresence = ctx.createBiquadFilter();
      this.extremePresence.type = "peaking";
      this.extremePresence.frequency.value = EXTREME_PRESENCE.frequency;
      this.extremePresence.gain.value = EXTREME_PRESENCE.gain;
      this.extremePresence.Q.value = EXTREME_PRESENCE.Q;
      this.maximizer.connect(this.maximizerTrim).connect(this.extremeLow).connect(this.extremePresence);

      this.volume = ctx.createGain();
      this.volume.gain.value = s.volume;

      this.bassShelf = ctx.createBiquadFilter();
      this.bassShelf.type = "lowshelf";
      this.bassShelf.frequency.value = BASS_FREQ;
      this.bassShelf.gain.value = s.bass * BASS_MAX_DB;

      this.bands = EQ_FREQS.map((freq, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = freq;
        b.Q.value = 1.41; // ~1 oitava: bandas vizinhas se somam sem buracos
        b.gain.value = s.eq[i];
        return b;
      });

      this.leveler = ctx.createDynamicsCompressor();
      setCompressor(this.leveler, LEVELER);
      this.limiter = ctx.createDynamicsCompressor();
      setCompressor(this.limiter, LIMITER);

      this.preClip = ctx.createGain();
      this.clipper = ctx.createWaveShaper();
      this.clipper.curve = makeSoftClipCurve();
      this.clipper.oversample = "4x"; // evita aliasing (o "chiado metálico") na saturação
      this.output = ctx.createGain();

      let node = this.volume.connect(this.bassShelf);
      for (const b of this.bands) node = node.connect(b);
      this.preClip.connect(this.clipper).connect(this.output);
      this.output.connect(ctx.destination);

      // Medidor de saída: o popup mostra quando o som chegou no teto digital e
      // desenha o espectro (visualizador) a partir dele.
      this.meter = ctx.createAnalyser();
      this.meter.fftSize = 2048;
      this.meter.minDecibels = -90;
      this.meter.maxDecibels = -10;
      this.meter.smoothingTimeConstant = 0.55;
      this.meterBuf = new Float32Array(this.meter.fftSize);
      this.freqBuf = new Uint8Array(this.meter.frequencyBinCount);
      // SPECTRUM_BANDS faixas logarítmicas de 40 Hz a 16 kHz (índices de bins da FFT).
      const binHz = ctx.sampleRate / this.meter.fftSize;
      const lastBin = this.meter.frequencyBinCount - 1;
      this.bandEdges = Array.from({ length: SPECTRUM_BANDS + 1 }, (_, i) =>
        Math.min(lastBin, Math.max(1, Math.round((40 * 400 ** (i / SPECTRUM_BANDS)) / binHz))),
      );
      this.output.connect(this.meter);

      this.route(s);
      this.settings = s;
    }

    get lastBand() {
      return this.bands[this.bands.length - 1];
    }

    // Liga/desliga bypass, maximizador, nivelador e limitador sem recriar o grafo.
    route(s) {
      const key = `${this.bypassed}|${s.extreme}|${s.leveler}|${s.clean}`;
      if (key === this.routing) return;
      this.routing = key;
      for (const n of [this.input, this.extremePresence, this.lastBand, this.leveler, this.limiter]) n.disconnect();

      if (this.bypassed) {
        this.input.connect(this.ctx.destination);
        return;
      }
      if (s.extreme) {
        this.input.connect(this.maximizer);
        this.extremePresence.connect(this.volume);
      } else {
        this.input.connect(this.volume);
      }

      let node = this.lastBand;
      if (s.leveler) node = node.connect(this.leveler);
      if (s.clean) node = node.connect(this.limiter);
      node.connect(this.preClip);
      this.preClip.gain.value = (s.clean ? 1 / LIMITER_MAKEUP : 1) / CLIP_RANGE;
    }

    apply(settings) {
      const s = normalize(settings);
      const t = this.ctx.currentTime;
      // Rampas curtas evitam estalos ao arrastar os controles.
      const glide = (param, v) => param.setTargetAtTime(v, t, 0.015);
      glide(this.volume.gain, s.volume);
      glide(this.bassShelf.gain, s.bass * BASS_MAX_DB);
      s.eq.forEach((g, i) => glide(this.bands[i].gain, g));
      this.route(s);
      this.settings = s;
    }

    // Bypass: sinal direto para a saída, sem nenhum processamento. Usado no modo
    // compatível ao desligar: um elemento já ligado ao AudioContext não pode ser
    // "desligado" dele, então o som passa reto em vez de parar.
    setBypass(on) {
      if (on === this.bypassed) return;
      this.bypassed = on;
      this.route(this.settings);
    }

    // Nível da saída nos últimos ~40 ms (pico e RMS, escala 0–1) e o espectro
    // em SPECTRUM_BANDS faixas (0–1 cada) para o visualizador.
    level() {
      this.meter.getFloatTimeDomainData(this.meterBuf);
      let peak = 0;
      let sum = 0;
      for (const v of this.meterBuf) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
      }
      this.meter.getByteFrequencyData(this.freqBuf);
      const bands = [];
      for (let i = 0; i < SPECTRUM_BANDS; i++) {
        let max = 0;
        const end = Math.max(this.bandEdges[i], this.bandEdges[i + 1] - 1);
        for (let b = this.bandEdges[i]; b <= end; b++) if (this.freqBuf[b] > max) max = this.freqBuf[b];
        bands.push(Math.round((max / 255) * 100) / 100);
      }
      return { peak, rms: Math.sqrt(sum / this.meterBuf.length), bands };
    }
  }

  return {
    Engine,
    EQ_FREQS,
    EQ_MIN,
    EQ_MAX,
    MAX_VOLUME,
    SPECTRUM_BANDS,
    DEFAULTS,
    PRESETS,
    normalize,
    roundPercent,
    badgePercent,
    applyMaxExtreme,
    isMaxExtreme,
    matchPreset,
    tabKey,
    premaxKey,
    floatKey,
    hostFromUrl,
    isRestrictedUrl,
  };
})();
