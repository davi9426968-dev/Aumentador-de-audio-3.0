// Janela flutuante: injetada na página sob demanda (background.js → scripting).
//
// É uma moldura arrastável (barra de título, minimizar, fechar) com a própria
// interface do popup dentro de um iframe (popup.html?view=float). O iframe é uma
// página da extensão, então tem acesso completo às APIs e fica isolado do CSS
// e do JavaScript do site.
//
// Fica na "top layer" (API popover), então aparece por cima de tudo — inclusive
// de vídeos em tela cheia, desde que o site coloque em tela cheia um contêiner
// (YouTube, Vimeo etc.) e não o próprio <video>.

(async () => {
  const TAG = "vb-float-panel";
  const WIDTH = 340;

  // Reinjeção (navegação, extensão atualizada): recria do zero.
  document.querySelectorAll(TAG).forEach((el) => el.remove());

  const res = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" }).catch(() => null);
  const tabId = res?.value;
  if (typeof tabId !== "number") return;

  const { ui = {} } = await chrome.storage.local.get("ui");
  let pos = ui.floatPos || { x: window.innerWidth - WIDTH - 24, y: 24 };
  let minimized = Boolean(ui.floatMin);

  const host = document.createElement(TAG);
  const canPopover = typeof host.showPopover === "function";
  if (canPopover) host.setAttribute("popover", "manual");
  // all: initial blinda contra o CSS do site.
  host.style.cssText = `all: initial; display: block; position: fixed; z-index: 2147483647; inset: auto;
    margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; width: ${WIDTH}px;`;

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .panel { width: ${WIDTH}px; border-radius: 16px; overflow: hidden; background: #0b0c13;
        box-shadow: 0 18px 50px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.06), 0 0 30px rgb(255 46 99 / 0.18);
        font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .bar { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 5px 0 11px;
        background: linear-gradient(115deg, #b52bff 0%, #ff2e63 45%, #ff7a3d 100%);
        color: #fff; cursor: grab; user-select: none; touch-action: none; }
      .bar.dragging { cursor: grabbing; }
      .title { flex: 1; font-weight: 800; letter-spacing: 0.01em; }
      .vol { padding: 2px 8px; border-radius: 999px; background: rgb(0 0 0 / 0.22);
        font-weight: 800; font-variant-numeric: tabular-nums; margin-right: 2px; }
      button { all: unset; display: grid; place-items: center; width: 24px; height: 24px;
        border-radius: 7px; cursor: pointer; font-size: 15px; color: #fff; transition: background 0.15s; }
      button:hover { background: rgb(255 255 255 / 0.22); }
      button:focus-visible { outline: 2px solid #fff; }
      iframe { display: block; width: 100%; height: 420px; border: 0; background: transparent; }
      .min iframe { display: none; }
      .min { border-radius: 12px; }
      @media (prefers-reduced-motion: no-preference) { .panel { animation: pop 0.22s ease-out; } }
      @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }
    </style>
    <div class="panel">
      <div class="bar" part="bar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>
          <path d="M14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>
        </svg>
        <span class="title">Volume Booster</span>
        <span class="vol"></span>
        <button class="min-btn" title="Minimizar" aria-label="Minimizar">–</button>
        <button class="close-btn" title="Fechar" aria-label="Fechar">×</button>
      </div>
      <iframe title="Volume Booster" allow="autoplay"></iframe>
    </div>`;

  const panel = shadow.querySelector(".panel");
  const bar = shadow.querySelector(".bar");
  const volLabel = shadow.querySelector(".vol");
  const minBtn = shadow.querySelector(".min-btn");
  const iframe = shadow.querySelector("iframe");
  iframe.src = chrome.runtime.getURL(`popup.html?view=float&tabId=${tabId}`);

  function saveUi() {
    chrome.storage.local
      .get("ui")
      .then(({ ui = {} }) => chrome.storage.local.set({ ui: { ...ui, floatPos: pos, floatMin: minimized } }))
      .catch(() => {});
  }

  function place() {
    const h = panel.offsetHeight || 32;
    pos.x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - WIDTH));
    pos.y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - Math.min(h, 32)));
    host.style.left = `${pos.x}px`;
    host.style.top = `${pos.y}px`;
  }

  function renderMin() {
    panel.classList.toggle("min", minimized);
    minBtn.textContent = minimized ? "▢" : "–";
    minBtn.title = minimized ? "Restaurar" : "Minimizar";
  }

  // Sempre por cima: ao entrar/sair de tela cheia, volta para o topo da top layer.
  function show() {
    const parent = document.body || document.documentElement;
    if (!host.isConnected) parent.append(host);
    if (canPopover) {
      try {
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
      } catch {}
    }
    place();
  }

  // ---------- Arrastar ----------
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    place();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    bar.classList.remove("dragging");
    saveUi();
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);

  // ---------- Botões ----------
  minBtn.addEventListener("click", () => {
    minimized = !minimized;
    renderMin();
    place();
    saveUi();
  });
  shadow.querySelector(".close-btn").addEventListener("click", () => {
    host.remove();
    chrome.runtime.sendMessage({ type: "CLOSE_FLOAT" }).catch(() => {});
  });

  // ---------- Mensagens do iframe (altura e volume atual) ----------
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow || e.data?.source !== "vb-panel") return;
    if (e.data.height) iframe.style.height = `${Math.ceil(e.data.height)}px`;
    if (typeof e.data.volume === "number") volLabel.textContent = e.data.on ? `${e.data.volume}%` : "desligado";
    place();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "FLOAT_CLOSE") host.remove();
  });

  document.addEventListener("fullscreenchange", show);
  window.addEventListener("resize", place);

  renderMin();
  show();
})();
