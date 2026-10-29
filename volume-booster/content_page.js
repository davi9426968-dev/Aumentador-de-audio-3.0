// Content script. Roda em todas as páginas e iframes, mas fica dormente até o
// background dizer que esta aba está ligada. Duas funções:
// - "Player a 100%" (qualquer modo): sobe o volume do player do site;
// - "modo compatível": processa o áudio dos <audio>/<video> aqui mesmo.
//
// POR QUE EXISTE
// O Chrome só deixa UMA extensão capturar o áudio de uma aba por vez. Se outro
// aumentador de volume já capturou a aba, a captura da nossa falha (e vice-versa).
// Aqui não há captura: cada <audio>/<video> da página passa pelo Engine ANTES de
// o som sair da aba. A aba continua livre para o outro aumentador capturar, e
// ele recebe o som já amplificado por nós — os dois ganhos se somam.
//
// LIMITAÇÕES (por isso a captura da aba continua sendo o modo padrão):
// - createMediaElementSource() só funciona uma vez por elemento: se outro
//   aumentador que trabalha dentro da página já pegou o elemento, ele é pulado.
// - Mídia de outra origem sem CORS chega ao Web Audio como silêncio; detectamos
//   (watchForSilence) e o popup avisa.
// - Sons gerados pelo próprio site com Web Audio (jogos etc.) não passam por aqui.
// - O AudioContext só começa a tocar depois de uma interação com a página;
//   até lá os elementos não são conectados (conectar a um contexto parado os
//   deixaria mudos).

(() => {
  // Reinjeção: se já existe uma instância viva, ela cuida da página. Se a
  // extensão foi atualizada, a instância antiga ficou órfã e esta assume.
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };
  if (window.__vbPage?.alive()) return;
  window.__vbPage = { alive };

  const { Engine, DEFAULTS, normalize } = globalThis.VBAudio;
  const MEDIA_SELECTOR = "audio, video";

  let active = false; // aba no modo compatível: este script processa o áudio
  let boosted = false; // aba ligada em QUALQUER modo (captura ou compatível)
  let settings = normalize(DEFAULTS);
  let ctx = null;
  let engine = null;
  let blocked = false;

  // ---------- "Player a 100%" ----------
  // Se o player do site está em 40%, o som já chega a 40% antes de qualquer
  // amplificação. Com o booster ligado, subimos o volume dos players para 100%
  // (sem desmutar) e devolvemos o valor original ao desligar — a menos que o
  // usuário tenha mexido no player nesse meio-tempo.
  const originalVolumes = new Map();

  function raisePlayer(el) {
    if (!boosted || !settings.playerMax || el.volume >= 1) return;
    if (!originalVolumes.has(el)) originalVolumes.set(el, el.volume);
    el.volume = 1;
  }

  function raiseAll(root = document) {
    for (const el of root.querySelectorAll(MEDIA_SELECTOR)) raisePlayer(el);
  }

  function restorePlayers() {
    for (const [el, volume] of originalVolumes) if (el.volume === 1) el.volume = volume;
    originalVolumes.clear();
  }

  function setBoosted(on) {
    boosted = on;
    if (on && settings.playerMax) raiseAll();
    else restorePlayers();
  }

  /** @type {WeakMap<HTMLMediaElement, {analyser: AnalyserNode, verified?: boolean, watching?: boolean}>} */
  const graphs = new WeakMap();
  /** Elementos conectados, para decidir quando suspender o contexto. */
  const connected = new Set();

  // ---------- AudioContext ----------

  function getEngine() {
    if (engine) return engine;
    ctx = new AudioContext({ latencyHint: "interactive" });
    engine = new Engine(ctx, settings);
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running" && active) attachAll();
    });
    return engine;
  }

  function tryResume() {
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  // Qualquer interação com a página libera o áudio (política de autoplay).
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, tryResume, { capture: true, passive: true });
  }
  // "play" não borbulha, mas pode ser capturado no document.
  document.addEventListener(
    "play",
    (e) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      raisePlayer(e.target); // vídeo novo (ex.: próximo do YouTube) volta com o volume do site
      if (active) {
        getEngine();
        tryResume();
        attach(e.target);
      } else if (graphs.has(e.target)) {
        tryResume();
      }
    },
    true,
  );

  // ---------- Elementos ----------

  function attach(el) {
    if (!active || graphs.has(el)) return;
    getEngine();
    if (ctx.state !== "running") {
      tryResume(); // o statechange chama attachAll() quando liberar
      return;
    }
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch {
      // Já ligado a outro AudioContext (outro aumentador dentro da página, ou o próprio site).
      graphs.set(el, { analyser: null, verified: true });
      return;
    }
    source.connect(engine.input);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    graphs.set(el, { analyser });
    connected.add(el);
    // Elementos fora do DOM (new Audio()) não disparam o "play" capturado no document.
    el.addEventListener("play", tryResume);
    el.addEventListener("playing", () => watchForSilence(el));
    if (!el.paused) watchForSilence(el);
  }

  function attachAll(root = document) {
    for (const el of root.querySelectorAll(MEDIA_SELECTOR)) attach(el);
  }

  // Mídia bloqueada por CORS chega como zeros absolutos: se o elemento está
  // tocando, com som, e por ~4 s só chegam zeros, marcamos como bloqueado.
  function watchForSilence(el) {
    const entry = graphs.get(el);
    if (!entry?.analyser || entry.verified || entry.watching || blocked) return;
    entry.watching = true;
    const buf = new Float32Array(entry.analyser.fftSize);
    let silentChecks = 0;
    const timer = setInterval(() => {
      if (el.paused || el.ended) {
        clearInterval(timer);
        entry.watching = false;
        return;
      }
      if (el.muted || el.volume === 0 || ctx.state !== "running") return;
      entry.analyser.getFloatTimeDomainData(buf);
      if (buf.some((v) => v !== 0)) {
        entry.verified = true;
        entry.watching = false;
        clearInterval(timer);
      } else if (++silentChecks >= 8) {
        blocked = true;
        entry.watching = false;
        clearInterval(timer);
      }
    }, 500);
  }

  // ---------- Elementos criados depois (sites SPA como YouTube) ----------

  let cleanupTimer = null;
  function scheduleCleanup() {
    clearTimeout(cleanupTimer);
    // Players costumam remover e reinserir o <video> logo em seguida.
    cleanupTimer = setTimeout(() => {
      for (const el of connected) if (!el.isConnected && el.paused) connected.delete(el);
      // Suspender (e não fechar): elementos que voltarem ao DOM continuam funcionando.
      if (ctx && ctx.state === "running" && connected.size === 0) ctx.suspend().catch(() => {});
    }, 5000);
  }

  const observer = new MutationObserver((mutations) => {
    let removed = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLMediaElement) attach(node);
        else if (node instanceof Element && node.firstElementChild) attachAll(node);
      }
      if (!removed && connected.size) {
        removed = [...m.removedNodes].some(
          (n) => n instanceof HTMLMediaElement || (n instanceof Element && n.querySelector(MEDIA_SELECTOR)),
        );
      }
    }
    if (removed) scheduleCleanup();
  });

  // ---------- Estado ----------

  function setActive(on, next) {
    if (next) settings = normalize(next);
    active = on;
    if (on) {
      getEngine();
      engine.setBypass(false);
      engine.apply(settings);
      tryResume();
      attachAll();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      observer.disconnect();
      engine?.setBypass(true);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "PAGE_ON":
        setActive(true, msg.settings);
        setBoosted(true);
        sendResponse({ ok: true });
        break;
      case "PAGE_OFF":
        setActive(false);
        setBoosted(false);
        sendResponse({ ok: true });
        break;
      case "BOOST_STATE":
        // Modo captura ligado/desligado: aqui só cuidamos do "Player a 100%".
        if (msg.settings) settings = normalize(msg.settings);
        setBoosted(Boolean(msg.on));
        sendResponse({ ok: true });
        break;
      case "APPLY":
        settings = normalize(msg.settings);
        if (active) engine?.apply(settings);
        if (boosted) setBoosted(true); // liga/desliga o "Player a 100%" conforme a opção
        sendResponse({ ok: true });
        break;
      case "GET_LEVEL": {
        // Vai a todos os frames: responde só quem está processando áudio agora.
        const level = active && engine ? engine.level() : null;
        if (level && level.rms > 0) sendResponse(level);
        break;
      }
      case "GET_PAGE_STATUS":
        // A mensagem vai a todos os frames e só a primeira resposta conta:
        // responde apenas quem detectou bloqueio.
        if (blocked) sendResponse({ blocked: true });
        break;
    }
    return false;
  });

  // Extensão atualizada/removida: esta instância ficou órfã. Solta o som (bypass)
  // para ele não ficar preso nas configurações antigas.
  const watchdog = setInterval(() => {
    if (alive()) return;
    clearInterval(watchdog);
    observer.disconnect();
    engine?.setBypass(true);
    restorePlayers();
  }, 3000);

  // Pergunta ao background se esta aba está ligada e em que modo (um iframe não
  // sabe em que aba está; o background sabe por sender.tab).
  chrome.runtime
    .sendMessage({ type: "GET_PAGE_STATE" })
    .then((res) => {
      const state = res?.ok ? res.value : null;
      if (!state?.on) return;
      settings = normalize(state.settings);
      if (state.active) setActive(true, state.settings);
      setBoosted(true);
    })
    .catch(() => {});
})();
