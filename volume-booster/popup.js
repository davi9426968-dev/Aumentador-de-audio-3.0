// Interface do Volume Booster. A mesma página serve a três "visões":
//   popup  — o popup do ícone (padrão); controla a aba ativa
//   float  — dentro da janela flutuante na página (?view=float&tabId=N)
//   window — janela pop-up separada (?view=window&tabId=N); a lista de abas troca a aba controlada

const {
  EQ_FREQS,
  EQ_MIN,
  EQ_MAX,
  MAX_VOLUME,
  SPECTRUM_BANDS,
  DEFAULTS,
  PRESETS,
  normalize,
  roundPercent,
  isMaxExtreme,
  matchPreset,
  tabKey,
  hostFromUrl,
  isRestrictedUrl,
} = VBAudio;

const params = new URLSearchParams(location.search);
const view = ["float", "window"].includes(params.get("view")) ? params.get("view") : "popup";
document.documentElement.dataset.view = view;

const $ = (id) => document.getElementById(id);
const els = {
  power: $("power"),
  tabIcon: $("tabIcon"),
  tabTitle: $("tabTitle"),
  tabState: $("tabState"),
  message: $("message"),
  controls: $("controls"),
  dial: $("dial"),
  knob: $("knob"),
  volume: $("volume"),
  volValue: $("volValue"),
  gainDb: $("gainDb"),
  meterText: $("meterText"),
  viz: $("viz"),
  bass: $("bass"),
  bassValue: $("bassValue"),
  preset: $("preset"),
  bands: $("bands"),
  clean: $("clean"),
  leveler: $("leveler"),
  playerMax: $("playerMax"),
  extreme: $("extreme"),
  maxExtreme: $("maxExtreme"),
  compat: $("compat"),
  tabList: $("tabList"),
  tabsCount: $("tabsCount"),
};
const quickButtons = document.querySelectorAll(".quick button");
const tabButtons = document.querySelectorAll('.tabs-nav [role="tab"]');
const lockables = [els.controls, ...document.querySelectorAll(".lockable")];
const bandInputs = [];
const bandLabels = [];

const FALLBACK_ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#8b8d98"/></svg>');

let tabId = null;
let tab = null;
let settings = normalize(DEFAULTS);
let captured = []; // abas ligadas por captura da aba
let pageTabs = []; // abas ligadas no modo compatível
let prefs = { compat: false };
let restricted = false;
let interacting = false; // usuário arrastando um controle: não sobrescrever com eco do storage
let enabling = null;

const modeOf = (id) => (captured.includes(id) ? "tab" : pageTabs.includes(id) ? "page" : null);
const isOn = () => modeOf(tabId) !== null;

// ---------- Escala do volume ----------
// Metade do curso é linear em 0–1000% (onde mais se ajusta: 2% por posição).
// A outra metade é logarítmica em 1000–10000%, como o ouvido percebe volume:
// cada posição multiplica o volume pelo mesmo fator, então 1000→2000% ocupa o
// mesmo espaço que 5000→10000%. Linear até 10000% deixaria 0–100% minúsculo.

const SLIDER_MAX = 1000;
const BREAK_POS = 500;
const BREAK_PCT = 1000;
const MAX_PCT = MAX_VOLUME * 100;
const LOG_SPAN = Math.log10(MAX_PCT / BREAK_PCT); // décadas acima de 1000%

function posToPercent(pos) {
  const pct =
    pos <= BREAK_POS
      ? (pos * BREAK_PCT) / BREAK_POS
      : BREAK_PCT * 10 ** (((pos - BREAK_POS) / (SLIDER_MAX - BREAK_POS)) * LOG_SPAN);
  return roundPercent(pct);
}

function percentToPos(pct) {
  return pct <= BREAK_PCT
    ? (pct * BREAK_POS) / BREAK_PCT
    : BREAK_POS + (Math.log10(pct / BREAK_PCT) / LOG_SPAN) * (SLIDER_MAX - BREAK_POS);
}

// ---------- Dial (botão giratório com anéis de LED) ----------
// Arco de 270° com a abertura embaixo. Anel interno = volume escolhido; anel
// externo = nível real do som saindo (medidor ao vivo).

const ARC = 270;
const ARC_START = -135; // graus, 0 = topo, sentido horário
const VOLUME_SEGMENTS = 41;
const METER_SEGMENTS = 41;
const volumeSegs = [];
const meterSegs = [];

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
}

function buildRing(group, count, r1, r2, color, list) {
  const ns = "http://www.w3.org/2000/svg";
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const deg = ARC_START + ARC * f;
    const [x1, y1] = polar(r1, deg);
    const [x2, y2] = polar(r2, deg);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", x1.toFixed(2));
    line.setAttribute("y1", y1.toFixed(2));
    line.setAttribute("x2", x2.toFixed(2));
    line.setAttribute("y2", y2.toFixed(2));
    line.style.setProperty("--c", color(f));
    group.append(line);
    list.push(line);
  }
}

function buildDial() {
  // Volume: verde (100%) → amarelo → laranja → vermelho → magenta (10000%).
  buildRing($("volumeRing"), VOLUME_SEGMENTS, 66, 79, (f) => `hsl(${(150 - 180 * f + 360) % 360} 92% 58%)`, volumeSegs);
  // Medidor: verde → amarelo → vermelho (teto).
  buildRing($("meterRing"), METER_SEGMENTS, 87, 93, (f) => `hsl(${150 - 150 * f} 90% 55%)`, meterSegs);

  // Rótulos da escala em volta do dial.
  const scale = $("scale");
  const center = 92;
  const radius = 88;
  for (const [pct, text] of [
    [0, "0"],
    [500, "500"],
    [1000, "1k"],
    [2000, "2k"],
    [5000, "5k"],
    [10000, "10k"],
  ]) {
    const deg = ARC_START + (ARC * percentToPos(pct)) / SLIDER_MAX;
    const a = (deg * Math.PI) / 180;
    const label = document.createElement("span");
    label.textContent = text;
    label.style.left = `${center + radius * Math.sin(a)}px`;
    label.style.top = `${center - radius * Math.cos(a)}px`;
    scale.append(label);
  }
}

// Muda o volume a partir de uma posição 0–1000 (dial, roda do mouse, teclado).
function setVolumeFromPos(pos, persist) {
  const pct = posToPercent(Math.min(SLIDER_MAX, Math.max(0, pos)));
  const changedValue = pct !== Math.round(settings.volume * 100);
  if (changedValue) {
    settings.volume = pct / 100;
    renderVolume();
  }
  if (changedValue || persist) changed({ persist });
}

// Arrastar é RELATIVO (gira a partir de onde está): um clique sem querer
// nunca faz o volume pular de 100% para 10000%.
let drag = null;

function pointerAngle(e) {
  const r = els.dial.getBoundingClientRect();
  return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
}

els.dial.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || restricted) return;
  drag = { angle: pointerAngle(e), y: e.clientY, pos: percentToPos(Math.round(settings.volume * 100)) };
  interacting = true;
  els.dial.setPointerCapture(e.pointerId);
  els.dial.classList.add("dragging");
  els.dial.focus({ preventScroll: true });
});

els.dial.addEventListener("pointermove", (e) => {
  if (!drag) return;
  // Girar em volta do dial ou arrastar para cima/baixo: os dois funcionam.
  const angle = pointerAngle(e);
  let delta = angle - drag.angle;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const byAngle = (delta / ARC) * SLIDER_MAX;
  const byY = (drag.y - e.clientY) * 3;
  drag.angle = angle;
  drag.y = e.clientY;
  drag.pos = Math.min(SLIDER_MAX, Math.max(0, drag.pos + (Math.abs(byAngle) > Math.abs(byY) ? byAngle : byY)));
  els.knob.style.setProperty("--angle", `${ARC_START + (ARC * drag.pos) / SLIDER_MAX}deg`);
  setVolumeFromPos(drag.pos, false);
});

function endDrag() {
  if (!drag) return;
  drag = null;
  interacting = false;
  els.dial.classList.remove("dragging");
  changed({ persist: true });
}
els.dial.addEventListener("pointerup", endDrag);
els.dial.addEventListener("pointercancel", endDrag);

// Roda do mouse: um "dente" = 20% até 1000%, ~5% do valor acima disso.
let wheelSave = null;
els.dial.addEventListener(
  "wheel",
  (e) => {
    if (restricted) return;
    e.preventDefault();
    const step = (e.deltaY < 0 ? 10 : -10) * (e.shiftKey ? 5 : 1);
    setVolumeFromPos(percentToPos(Math.round(settings.volume * 100)) + step, false);
    clearTimeout(wheelSave);
    wheelSave = setTimeout(() => changed({ persist: true }), 350);
  },
  { passive: false },
);

// Teclado (padrão de slider ARIA).
els.dial.addEventListener("keydown", (e) => {
  const pos = percentToPos(Math.round(settings.volume * 100));
  const keys = {
    ArrowUp: pos + 5,
    ArrowRight: pos + 5,
    ArrowDown: pos - 5,
    ArrowLeft: pos - 5,
    PageUp: pos + 50,
    PageDown: pos - 50,
    Home: 0,
    End: SLIDER_MAX,
  };
  if (!(e.key in keys)) return;
  e.preventDefault();
  setVolumeFromPos(keys[e.key], false);
});
els.dial.addEventListener("keyup", (e) => {
  if (e.key.startsWith("Arrow") || e.key.startsWith("Page") || e.key === "Home" || e.key === "End") changed({ persist: true });
});

els.dial.addEventListener("dblclick", () => {
  settings.volume = 1;
  renderVolume();
  changed({ persist: true });
});

// ---------- Mensagens para o usuário ----------

function showMessage(text, kind = "info") {
  els.message.textContent = text || "";
  els.message.hidden = !text;
  els.message.classList.toggle("error", kind === "error");
}

// Por que a captura da aba não deu certo (a extensão liga no modo compatível mesmo assim).
function captureFallbackNote(err) {
  const msg = String(err?.message || err);
  if (/active stream/i.test(msg)) {
    return "Outro aumentador de volume já está usando esta aba. Ligado no modo compatível: os dois funcionam juntos e os volumes se somam.";
  }
  return "Ligado no modo compatível (sem capturar a aba). Se não ouvir diferença, clique uma vez no vídeo ou na página.";
}

// ---------- Ligar / desligar ----------

async function enable() {
  if (isOn() || restricted) return isOn();
  enabling ??= (async () => {
    showMessage("");
    els.power.disabled = true;
    try {
      // Grava antes: o background liga a aba com as configurações salvas.
      await save();
      if (prefs.compat) {
        await startPage();
        return true;
      }
      try {
        // Precisa partir de uma página da extensão aberta pelo usuário: é isso
        // que autoriza capturar o áudio da aba.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        const res = await chrome.runtime.sendMessage({ type: "START_CAPTURE", tabId, streamId });
        if (!res?.ok) throw new Error(res?.error || "falha desconhecida");
        if (!captured.includes(tabId)) captured = [...captured, tabId];
      } catch (err) {
        // O Chrome só permite uma captura por aba (outro aumentador pode já
        // estar usando) e exige o clique no ícone. Nada disso impede o modo
        // compatível, que trabalha dentro da página.
        await startPage();
        showMessage(captureFallbackNote(err));
      }
      return true;
    } catch (err) {
      showMessage(`Não foi possível ligar: ${err?.message || err}`, "error");
      return false;
    } finally {
      els.power.disabled = restricted;
      enabling = null;
      renderPower();
    }
  })();
  return enabling;
}

async function startPage() {
  const res = await chrome.runtime.sendMessage({ type: "START_PAGE", tabId });
  if (!res?.ok) throw new Error(res?.error || "falha desconhecida");
  if (!pageTabs.includes(tabId)) pageTabs = [...pageTabs, tabId];
  captured = captured.filter((id) => id !== tabId);
}

async function disable() {
  showMessage("");
  await chrome.runtime.sendMessage({ type: "STOP", tabId }).catch(() => {});
  captured = captured.filter((id) => id !== tabId);
  pageTabs = pageTabs.filter((id) => id !== tabId);
  renderPower();
}

els.power.addEventListener("change", () => (els.power.checked ? enable() : disable()));

// ---------- Aplicar / salvar ----------

// Tempo real: direto para o áudio, a cada movimento dos controles.
function push() {
  const mode = modeOf(tabId);
  if (mode === "tab") chrome.runtime.sendMessage({ target: "offscreen", type: "APPLY", tabId, settings }).catch(() => {});
  else if (mode === "page") chrome.tabs.sendMessage(tabId, { type: "APPLY", settings }).catch(() => {});
  notifyParent();
}

// Persistência: por aba (sessão) e como modelo para as próximas abas.
function save() {
  return Promise.all([
    chrome.storage.session.set({ [tabKey(tabId)]: settings }),
    chrome.storage.local.set({ last: settings }),
  ]);
}

// Mexer em qualquer controle com o booster desligado já liga (como no botão).
function changed({ persist }) {
  renderMaxExtreme();
  if (!isOn()) {
    // Durante a ligação o usuário pode continuar mexendo: ao terminar, aplica e
    // salva o valor mais recente.
    enable().then((ok) => {
      if (!ok) return;
      push();
      save();
    });
    notifyParent();
    return;
  }
  push();
  if (persist) save();
}

// ---------- Renderização ----------

function renderPower() {
  const on = isOn();
  els.power.checked = on;
  els.power.disabled = restricted;
  els.tabState.textContent = restricted
    ? "página protegida pelo Chrome"
    : modeOf(tabId) === "page"
      ? "ligado · modo compatível"
      : on
        ? "ligado"
        : "desligado — ligue ou gire o volume";
  els.tabState.classList.toggle("on", on);
  els.controls.classList.toggle("off", !on && !restricted);
  for (const el of lockables) el.classList.toggle("disabled", restricted);
  notifyParent();
}

function formatGain(percent) {
  if (percent === 0) return "mudo";
  const db = 20 * Math.log10(percent / 100);
  if (Math.abs(db) < 0.05) return "0 dB";
  const text = Math.abs(db) >= 10 ? Math.round(db) : db.toFixed(1).replace(".", ",");
  return `${db > 0 ? "+" : ""}${text} dB`;
}

function renderVolume() {
  const percent = Math.round(settings.volume * 100);
  const pos = percentToPos(percent);
  const f = pos / SLIDER_MAX;
  els.volume.value = pos;
  els.volValue.textContent = `${percent}%`;
  els.volValue.classList.toggle("unity", percent <= 100);
  els.gainDb.textContent = formatGain(percent);
  els.dial.setAttribute("aria-valuenow", String(percent));
  els.dial.setAttribute("aria-valuetext", `${percent}%`);
  if (!drag) els.knob.style.setProperty("--angle", `${ARC_START + ARC * f}deg`);
  const lit = percent === 0 ? 0 : Math.round(f * (VOLUME_SEGMENTS - 1)) + 1;
  volumeSegs.forEach((seg, i) => seg.classList.toggle("lit", i < lit));
  for (const btn of quickButtons) btn.setAttribute("aria-pressed", String(Number(btn.dataset.volume) === percent));
}

function renderBass() {
  const percent = Math.round(settings.bass * 100);
  els.bass.value = percent;
  els.bass.style.setProperty("--fill", `${percent}%`);
  els.bassValue.textContent = `${percent}%`;
}

function formatFreq(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

function formatDb(v) {
  return v > 0 ? `+${v}` : String(v);
}

function renderEq() {
  settings.eq.forEach((g, i) => {
    bandInputs[i].value = g;
    bandLabels[i].textContent = formatDb(g);
    bandLabels[i].classList.toggle("on", g !== 0);
  });
  els.preset.value = settings.preset in PRESETS ? settings.preset : "custom";
}

function renderSettings() {
  renderVolume();
  renderBass();
  renderEq();
  els.clean.checked = settings.clean;
  els.leveler.checked = settings.leveler;
  els.playerMax.checked = settings.playerMax;
  els.extreme.checked = settings.extreme;
  renderMaxExtreme();
  notifyParent();
}

function renderMaxExtreme() {
  els.maxExtreme.setAttribute("aria-pressed", String(isMaxExtreme(settings)));
}

function renderTarget() {
  const url = tab?.url || "";
  restricted = !tab || isRestrictedUrl(url);
  els.tabTitle.textContent = view === "float" ? "Booster nesta aba" : tab?.title || hostFromUrl(url) || "Aba";
  els.tabTitle.title = tab?.title || "";
  els.tabIcon.src = tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : FALLBACK_ICON;
  if (restricted) showMessage("O Chrome não permite alterar o som desta página (páginas internas e a Web Store). Abra um site com áudio.");
  renderPower();
}

// Janela flutuante: informa altura e volume para a moldura na página.
function notifyParent() {
  if (view !== "float") return;
  parent.postMessage(
    { source: "vb-panel", height: document.documentElement.scrollHeight, volume: Math.round(settings.volume * 100), on: isOn() },
    "*",
  );
}

// ---------- Controles ----------

// O <input id="volume"> (oculto) continua sendo a fonte do valor: o dial e a
// roda do mouse passam por setVolumeFromPos, que mantém os dois em sincronia.
els.volume.addEventListener("input", () => {
  settings.volume = posToPercent(Number(els.volume.value)) / 100;
  renderVolume();
  changed({ persist: false });
});
els.volume.addEventListener("change", () => changed({ persist: true }));

for (const btn of quickButtons) {
  btn.addEventListener("click", () => {
    settings.volume = Number(btn.dataset.volume) / 100;
    renderVolume();
    changed({ persist: true });
  });
}

els.bass.addEventListener("input", () => {
  settings.bass = Number(els.bass.value) / 100;
  renderBass();
  changed({ persist: false });
});
els.bass.addEventListener("change", () => changed({ persist: true }));

for (const id of ["clean", "leveler", "playerMax", "extreme"]) {
  els[id].addEventListener("change", () => {
    settings[id] = els[id].checked;
    changed({ persist: true });
  });
}

// "Máximo extremo": o background troca as configurações (e guarda as de antes
// para o segundo clique desfazer); aqui só mostramos e ligamos se preciso.
els.maxExtreme.addEventListener("click", async () => {
  if (restricted) return;
  const res = await chrome.runtime.sendMessage({ type: "TOGGLE_MAX_EXTREME", tabId, settings }).catch(() => null);
  if (!res?.ok) {
    showMessage(`Não foi possível aplicar o máximo extremo: ${res?.error || "erro desconhecido"}`, "error");
    return;
  }
  settings = normalize(res.value);
  renderSettings();
  if (isOn()) push();
  else enable();
});

// Modo compatível: preferência global. Se a aba já está ligada no outro modo, troca na hora.
els.compat.addEventListener("change", async () => {
  prefs = { ...prefs, compat: els.compat.checked };
  await chrome.storage.local.set({ prefs });
  const mode = modeOf(tabId);
  if (!mode || (mode === "page") === prefs.compat) return;
  await disable();
  await enable();
});

// Enquanto um slider está sendo arrastado, ecos do storage não devem movê-lo.
document.addEventListener("pointerdown", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === "range") interacting = true;
});
document.addEventListener("pointerup", () => {
  if (!drag) interacting = false;
});

// ---------- Abas de navegação (Efeitos · Equalizador · Abas) ----------

function showPanel(name, persist = true) {
  if (view === "float" && name === "tabs") name = "fx";
  for (const btn of tabButtons) {
    const selected = btn.dataset.panel === name;
    btn.setAttribute("aria-selected", String(selected));
    btn.tabIndex = selected ? 0 : -1;
    $(`panel-${btn.dataset.panel}`).hidden = !selected;
  }
  notifyParent();
  if (persist) {
    chrome.storage.local.get("ui").then(({ ui = {} }) => chrome.storage.local.set({ ui: { ...ui, panel: name } }));
  }
}

tabButtons.forEach((btn, i) => {
  btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const visible = [...tabButtons].filter((b) => b.offsetParent !== null);
    const next = visible[(visible.indexOf(btn) + (e.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length];
    next.focus();
    showPanel(next.dataset.panel);
  });
});

// ---------- Equalizador ----------

function buildEq() {
  for (const [key, p] of Object.entries(PRESETS)) els.preset.add(new Option(p.label, key));
  const custom = new Option("Personalizado", "custom");
  custom.hidden = true;
  els.preset.add(custom);

  EQ_FREQS.forEach((freq, i) => {
    const band = document.createElement("div");
    band.className = "band";
    const db = document.createElement("span");
    db.className = "db";
    const input = document.createElement("input");
    input.type = "range";
    input.min = EQ_MIN;
    input.max = EQ_MAX;
    input.step = 1;
    input.setAttribute("aria-label", `${formatFreq(freq)}Hz`);
    input.title = "Duplo clique para zerar";
    const label = document.createElement("span");
    label.className = "freq";
    label.textContent = formatFreq(freq);

    const setBand = (value, persist) => {
      settings.eq[i] = value;
      settings.preset = matchPreset(settings.eq);
      renderEq();
      changed({ persist });
    };
    input.addEventListener("input", () => setBand(Number(input.value), false));
    input.addEventListener("change", () => changed({ persist: true }));
    input.addEventListener("dblclick", () => setBand(0, true));

    band.append(db, input, label);
    els.bands.append(band);
    bandInputs.push(input);
    bandLabels.push(db);
  });
}

els.preset.addEventListener("change", () => {
  const p = PRESETS[els.preset.value];
  if (!p) return;
  settings.eq = [...p.eq];
  settings.preset = els.preset.value;
  renderEq();
  changed({ persist: true });
});

$("eqReset").addEventListener("click", () => {
  settings.eq = [...PRESETS.flat.eq];
  settings.preset = "flat";
  renderEq();
  changed({ persist: true });
});

// ---------- Janelas ----------

$("openFloat").addEventListener("click", async () => {
  if (restricted) return;
  const res = await chrome.runtime.sendMessage({ type: "OPEN_FLOAT", tabId }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) {
    showMessage(`Não foi possível abrir a janela flutuante: ${res?.error}`, "error");
    return;
  }
  if (view === "popup") window.close();
});

$("openWindow").addEventListener("click", async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html?view=window&tabId=${tabId}`),
    type: "popup",
    width: 400,
    height: 760,
  });
  if (view === "popup") window.close();
});

// ---------- Medidor ao vivo e visualizador ----------
// O anel externo do dial mostra o nível real do som que sai para o alto-falante.
// "NO MÁXIMO" = o sinal está no teto digital: a partir daí, mais % só distorce.

const vizBars = [];
let hotReadings = 0; // leituras recentes no teto (evita piscar)

function buildViz() {
  for (let i = 0; i < SPECTRUM_BANDS; i++) {
    const bar = document.createElement("span");
    els.viz.append(bar);
    vizBars.push(bar);
  }
  els.viz.classList.add("idle");
}

async function pollLevel() {
  const mode = modeOf(tabId);
  let level = null;
  if (mode === "tab") {
    level = await chrome.runtime.sendMessage({ target: "offscreen", type: "GET_LEVEL", tabId }).catch(() => null);
  } else if (mode === "page") {
    level = await chrome.tabs.sendMessage(tabId, { type: "GET_LEVEL" }).catch(() => null);
  }
  renderLevel(level);
}

function renderLevel(level) {
  const meterText = els.meterText;
  if (!level || !(level.rms > 0.0005)) {
    for (const seg of meterSegs) seg.classList.remove("lit");
    for (const bar of vizBars) bar.style.setProperty("--v", "0.06");
    els.viz.classList.add("idle");
    meterText.classList.remove("max");
    meterText.textContent = isOn() ? "sem som" : "desligado";
    hotReadings = 0;
    return;
  }
  const rmsDb = 20 * Math.log10(level.rms);
  const lit = Math.round(Math.max(0, Math.min(1, (rmsDb + 48) / 48)) * METER_SEGMENTS);
  meterSegs.forEach((seg, i) => seg.classList.toggle("lit", i < lit));

  const bands = Array.isArray(level.bands) ? level.bands : [];
  vizBars.forEach((bar, i) => bar.style.setProperty("--v", Math.max(0.06, bands[i] ?? 0).toFixed(2)));
  els.viz.classList.remove("idle");

  hotReadings = level.peak >= 0.97 ? Math.min(hotReadings + 1, 8) : Math.max(hotReadings - 1, 0);
  const atMax = hotReadings >= 3;
  meterText.classList.toggle("max", atMax);
  meterText.textContent = atMax ? "NO MÁXIMO" : `${Math.round(rmsDb)} dB`;
}

// ---------- Abas com som ----------

let refreshTimer = null;
function refreshTabsSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshTabs, 150);
}

async function refreshTabs() {
  if (view === "float") return;
  const all = await chrome.tabs.query({});
  const list = all.filter((t) => t.audible || modeOf(t.id));
  const keys = list.map((t) => tabKey(t.id));
  const stored = keys.length ? await chrome.storage.session.get(keys) : {};

  els.tabsCount.textContent = list.length ? String(list.length) : "";
  els.tabList.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nenhuma aba tocando som agora.";
    els.tabList.append(li);
    return;
  }

  for (const t of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-item" + (t.id === tabId ? " current" : "");
    btn.title = t.title || "";

    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.alt = "";
    icon.src = t.favIconUrl && /^(https?|data):/.test(t.favIconUrl) ? t.favIconUrl : FALLBACK_ICON;
    icon.addEventListener("error", () => (icon.src = FALLBACK_ICON), { once: true });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.title || hostFromUrl(t.url) || "Aba";

    const pill = document.createElement("span");
    const on = Boolean(modeOf(t.id));
    pill.className = "pill" + (on ? " on" : "");
    pill.textContent = on ? `${Math.round(normalize(stored[tabKey(t.id)]).volume * 100)}%` : "♪ tocando";

    btn.append(icon, name, pill);
    btn.addEventListener("click", () => openTab(t));
    li.append(btn);
    els.tabList.append(li);
  }
}

async function openTab(t) {
  if (view === "window") {
    // Janela separada: passa a controlar a aba escolhida.
    await selectTab(t.id);
    history.replaceState(null, "", `?view=window&tabId=${t.id}`);
    refreshTabs();
    return;
  }
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  window.close();
}

// ---------- Sincronização entre popup, janela flutuante e janela separada ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.prefs) {
    prefs = { compat: false, ...changes.prefs.newValue };
    els.compat.checked = prefs.compat;
  }
  if (area !== "session") return;
  if (changes.captured || changes.pageTabs) {
    if (changes.captured) captured = changes.captured.newValue || [];
    if (changes.pageTabs) pageTabs = changes.pageTabs.newValue || [];
    renderPower();
  }
  const mine = changes[tabKey(tabId)];
  if (mine?.newValue && !interacting) {
    settings = normalize(mine.newValue);
    renderSettings();
  }
  if (changes.captured || changes.pageTabs || Object.keys(changes).some((k) => k.startsWith("tab:"))) refreshTabsSoon();
});

chrome.tabs.onUpdated.addListener((id, info) => {
  if ("audible" in info || "title" in info || "favIconUrl" in info) refreshTabsSoon();
  if (id === tabId && ("title" in info || "favIconUrl" in info || "url" in info)) {
    chrome.tabs.get(id).then((t) => {
      tab = t;
      renderTarget();
    });
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  refreshTabsSoon();
  if (id === tabId && view === "window") {
    tab = null;
    renderTarget();
    showMessage("Esta aba foi fechada. Escolha outra na aba “Abas”.");
  }
});

// ---------- Inicialização ----------

async function selectTab(id) {
  tabId = id;
  tab = await chrome.tabs.get(id).catch(() => null);
  const key = tabKey(id);
  const data = await chrome.storage.session.get([key, "captured", "pageTabs"]);
  captured = Array.isArray(data.captured) ? data.captured : [];
  pageTabs = Array.isArray(data.pageTabs) ? data.pageTabs : [];
  if (data[key]) {
    settings = normalize(data[key]);
  } else {
    const { last } = await chrome.storage.local.get("last");
    settings = normalize(last || DEFAULTS);
  }
  showMessage("");
  renderTarget();
  renderSettings();
  // Modo compatível: avisa se algum vídeo do site recusou ser amplificado (CORS).
  if (modeOf(id) === "page") {
    const status = await chrome.tabs.sendMessage(id, { type: "GET_PAGE_STATUS" }).catch(() => null);
    if (status?.blocked) {
      showMessage("Este site impede o modo compatível de amplificar parte do áudio. Desligue a chave “Compatível” para usar a captura da aba.");
    }
  }
}

async function init() {
  buildDial();
  buildViz();
  buildEq();
  const { ui = {}, prefs: savedPrefs } = await chrome.storage.local.get(["ui", "prefs"]);
  showPanel(ui.panel || "fx", false);
  prefs = { compat: false, ...savedPrefs };
  els.compat.checked = prefs.compat;

  let id = Number(params.get("tabId"));
  if (!id) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    id = active?.id;
  }
  await selectTab(id);
  await refreshTabs();
  setInterval(pollLevel, 100);

  if (view === "float") new ResizeObserver(notifyParent).observe(document.body);
}

init();
