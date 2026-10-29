// Service worker (MV3). Pode ser encerrado a qualquer momento pelo navegador,
// por isso NENHUM estado fica só em memória: configurações e as listas de abas
// ligadas vivem em chrome.storage (ver audio_engine.js); quem segura as
// capturas de verdade é o documento offscreen, e o modo compatível vive nos
// content scripts de cada aba.
//
// Dois modos de ligar uma aba:
//   "tab"  — captura da aba (padrão): pega todo o som da aba, qualquer site.
//   "page" — modo compatível (content_page.js): amplifica os <audio>/<video>
//            dentro da página, sem capturar a aba. O Chrome só permite UMA
//            captura por aba, então este modo é o que deixa outro aumentador
//            de volume funcionar ao mesmo tempo (os ganhos se somam).

importScripts("audio_engine.js");

const {
  DEFAULTS,
  PRESETS,
  normalize,
  roundPercent,
  badgePercent,
  applyMaxExtreme,
  isMaxExtreme,
  tabKey,
  floatKey,
  premaxKey,
  isRestrictedUrl,
} = VBAudio;

// ---------- Configurações por aba ----------

async function getTabSettings(tabId) {
  const key = tabKey(tabId);
  const data = await chrome.storage.session.get(key);
  if (data[key]) return normalize(data[key]);
  // Aba nova: começa com as últimas configurações usadas.
  const { last } = await chrome.storage.local.get("last");
  return normalize(last || DEFAULTS);
}

async function saveTabSettings(tabId, settings) {
  await chrome.storage.session.set({ [tabKey(tabId)]: settings });
  await chrome.storage.local.set({ last: settings });
}

// "Máximo extremo" liga/desliga: guarda as configurações de antes para o
// segundo clique (ou atalho) voltar exatamente a elas.
async function toggleMaxExtreme(tabId, current) {
  const settings = normalize(current ?? (await getTabSettings(tabId)));
  const key = premaxKey(tabId);
  let next;
  if (isMaxExtreme(settings)) {
    const saved = (await chrome.storage.session.get(key))[key];
    next = normalize(saved ?? { ...settings, volume: 1, extreme: false, eq: PRESETS.flat.eq, preset: "flat" });
    await chrome.storage.session.remove(key);
  } else {
    await chrome.storage.session.set({ [key]: settings });
    next = applyMaxExtreme(settings);
  }
  await saveTabSettings(tabId, next);
  return next;
}

async function getPrefs() {
  const { prefs } = await chrome.storage.local.get("prefs");
  return { compat: false, ...prefs };
}

// ---------- Listas de abas ligadas ----------

async function getList(key) {
  const data = await chrome.storage.session.get(key);
  return Array.isArray(data[key]) ? data[key] : [];
}
const getCaptured = () => getList("captured");
const getPageTabs = () => getList("pageTabs");

// Ler-modificar-gravar em fila: dois eventos ao mesmo tempo não se atropelam.
let listQueue = Promise.resolve();
function withListLock(fn) {
  const run = listQueue.then(fn);
  listQueue = run.catch(() => {});
  return run;
}

function setInList(key, tabId, on) {
  return withListLock(async () => {
    const list = new Set(await getList(key));
    if (on) list.add(tabId);
    else list.delete(tabId);
    await chrome.storage.session.set({ [key]: [...list] });
  });
}
const setCaptured = (tabId, on) => setInList("captured", tabId, on);
const setPageTab = (tabId, on) => setInList("pageTabs", tabId, on);

async function modeOf(tabId) {
  const [captured, pageTabs] = await Promise.all([getCaptured(), getPageTabs()]);
  if (captured.includes(tabId)) return "tab";
  if (pageTabs.includes(tabId)) return "page";
  return null;
}

// ---------- Badge ----------

async function updateBadge(tabId) {
  try {
    if (!(await modeOf(tabId))) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    const { volume } = await getTabSettings(tabId);
    await chrome.action.setBadgeBackgroundColor({ tabId, color: volume > 1 ? "#e5484d" : "#3e63dd" });
    await chrome.action.setBadgeTextColor?.({ tabId, color: "#ffffff" });
    await chrome.action.setBadgeText({ tabId, text: badgePercent(volume) });
  } catch {
    // A aba pode ter sido fechada nesse meio-tempo.
  }
}

// ---------- Documento offscreen (modo captura) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Processar o áudio capturado das abas (amplificação, graves e equalizador).",
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

async function closeOffscreenIfIdle() {
  if ((await getCaptured()).length === 0 && (await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ---------- Modo captura ----------

async function startCapture(tabId, streamId) {
  await ensureOffscreen();
  const settings = await getTabSettings(tabId);
  const res = await toOffscreen({ type: "START", tabId, streamId, settings });
  if (!res?.ok) throw new Error(res?.error || "falha ao capturar a aba");
  if ((await getPageTabs()).includes(tabId)) await stopPage(tabId);
  await chrome.storage.session.set({ [tabKey(tabId)]: settings });
  await setCaptured(tabId, true);
  notifyBoost(tabId, true, settings);
  await updateBadge(tabId);
}

async function stopCapture(tabId) {
  if (await chrome.offscreen.hasDocument()) await toOffscreen({ type: "STOP", tabId }).catch(() => {});
  await setCaptured(tabId, false);
  notifyBoost(tabId, false);
  await updateBadge(tabId);
  await closeOffscreenIfIdle();
}

// Content scripts da aba cuidam do "Player a 100%" também no modo captura.
async function notifyBoost(tabId, on, settings) {
  const res = await chrome.tabs.sendMessage(tabId, { type: "BOOST_STATE", on, settings }).catch(() => null);
  if (!res?.ok && on) {
    // Aba aberta antes da instalação/atualização: injeta; o script pergunta o estado e se ajusta.
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ["audio_engine.js", "content_page.js"] })
      .catch(() => {});
  }
}

// ---------- Modo compatível (dentro da página) ----------

async function startPage(tabId) {
  if ((await getCaptured()).includes(tabId)) await stopCapture(tabId);
  const settings = await getTabSettings(tabId);
  await chrome.storage.session.set({ [tabKey(tabId)]: settings });
  await setPageTab(tabId, true);
  const res = await chrome.tabs.sendMessage(tabId, { type: "PAGE_ON", settings }).catch(() => null);
  if (!res?.ok) {
    // Aba aberta antes da instalação/atualização: ainda não tem o content
    // script. Ao ser injetado, ele pergunta o estado e liga sozinho.
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ["audio_engine.js", "content_page.js"] })
      .catch(() => {});
  }
  await updateBadge(tabId);
}

async function stopPage(tabId) {
  await setPageTab(tabId, false);
  chrome.tabs.sendMessage(tabId, { type: "PAGE_OFF" }).catch(() => {});
  await updateBadge(tabId);
}

// ---------- Ligar / desligar (qualquer modo) ----------

async function stopAny(tabId) {
  const mode = await modeOf(tabId);
  if (mode === "tab") await stopCapture(tabId);
  else if (mode === "page") await stopPage(tabId);
}

// Usado pelos atalhos de teclado (que contam como "invocar a extensão" e
// autorizam a captura). Prefere capturar a aba; se não der — por exemplo,
// outro aumentador já capturou —, liga no modo compatível.
async function startBest(tabId) {
  if ((await getPrefs()).compat) return startPage(tabId);
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await startCapture(tabId, streamId);
  } catch (err) {
    console.info("[Volume Booster] captura indisponível, usando modo compatível:", err?.message);
    await startPage(tabId);
  }
}

// Se o service worker reiniciou e o offscreen sumiu, a lista salva está velha.
function reconcile() {
  return withListLock(async () => {
    const alive = (await chrome.offscreen.hasDocument()) ? await toOffscreen({ type: "LIST" }).catch(() => []) : [];
    await chrome.storage.session.set({ captured: Array.isArray(alive) ? alive : [] });
  });
}
reconcile();

// ---------- Janela flutuante ----------

async function injectFloat(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["float.js"] });
}

async function openFloat(tabId) {
  await chrome.storage.session.set({ [floatKey(tabId)]: true });
  await injectFloat(tabId);
}

async function closeFloat(tabId) {
  await chrome.storage.session.remove(floatKey(tabId));
  chrome.tabs.sendMessage(tabId, { type: "FLOAT_CLOSE" }).catch(() => {});
}

// ---------- Mensagens ----------

const handlers = {
  // Da interface (popup, janela flutuante, janela separada).
  async START_CAPTURE({ tabId, streamId }) {
    await startCapture(tabId, streamId);
  },
  async START_PAGE({ tabId }) {
    await startPage(tabId);
  },
  async STOP({ tabId }) {
    await stopAny(tabId);
  },
  async TOGGLE_MAX_EXTREME({ tabId, settings }) {
    return toggleMaxExtreme(tabId, settings);
  },
  async OPEN_FLOAT({ tabId }) {
    await openFloat(tabId);
  },
  async CLOSE_FLOAT({ tabId }, sender) {
    await closeFloat(tabId ?? sender.tab?.id);
  },

  // Do documento offscreen.
  async CAPTURE_ENDED({ tabId }) {
    await setCaptured(tabId, false);
    notifyBoost(tabId, false);
    await updateBadge(tabId);
    await closeOffscreenIfIdle();
  },

  // Dos content scripts.
  async GET_TAB_ID(_msg, sender) {
    return sender.tab?.id;
  },
  async GET_PAGE_STATE(_msg, sender) {
    const tabId = sender.tab?.id;
    const mode = tabId == null ? null : await modeOf(tabId);
    if (!mode) return { on: false, active: false };
    if (sender.frameId === 0) updateBadge(tabId); // navegação pode limpar o badge
    return { on: true, active: mode === "page", settings: await getTabSettings(tabId) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false; // endereçada ao offscreen
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true; // resposta assíncrona
});

// Configuração de uma aba salva (popup, janela flutuante, janela pop-up ou
// atalho) → aplica no áudio dela, no modo em que ela estiver, e atualiza o badge.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session") return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("tab:") || !change.newValue) continue;
    const tabId = Number(key.slice(4));
    const mode = await modeOf(tabId);
    if (!mode) continue;
    if (mode === "tab") toOffscreen({ type: "APPLY", tabId, settings: change.newValue }).catch(() => {});
    // Nos dois modos a página recebe (modo compatível processa; ambos cuidam do "Player a 100%").
    chrome.tabs.sendMessage(tabId, { type: "APPLY", settings: change.newValue }).catch(() => {});
    updateBadge(tabId);
  }
});

// ---------- Atalhos ----------

// Até 1000%: passos de 10%. Acima: ×1,25 por toque (~2 dB, como o slider
// logarítmico) — 1000% → 10000% em 11 toques, em vez de 90.
function nextShortcutPercent(pct, dir) {
  if (dir > 0) return roundPercent(pct >= 1000 ? pct * 1.25 : pct + 10);
  if (pct > 1000) return Math.max(1000, roundPercent(pct / 1.25));
  return roundPercent(pct - 10);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  const on = Boolean(await modeOf(tab.id));
  try {
    if (command === "toggle-boost") {
      if (on) await stopAny(tab.id);
      else await startBest(tab.id);
      return;
    }
    if (command === "max-extreme") {
      await toggleMaxExtreme(tab.id);
      if (!on) await startBest(tab.id);
      return;
    }
    const dir = command === "volume-up" ? 1 : command === "volume-down" ? -1 : 0;
    if (!dir) return;
    const settings = await getTabSettings(tab.id);
    settings.volume = nextShortcutPercent(Math.round(settings.volume * 100), dir) / 100;
    await saveTabSettings(tab.id, settings);
    if (!on) await startBest(tab.id);
  } catch (err) {
    console.warn("[Volume Booster] atalho falhou:", err);
  }
});

// ---------- Ciclo de vida das abas ----------

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "loading") updateBadge(tabId); // navegação pode limpar o badge
  if (info.status === "complete") {
    const key = floatKey(tabId);
    const data = await chrome.storage.session.get(key);
    if (data[key]) injectFloat(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove([tabKey(tabId), floatKey(tabId), premaxKey(tabId)]);
  if ((await getCaptured()).includes(tabId)) await stopCapture(tabId);
  if ((await getPageTabs()).includes(tabId)) await setPageTab(tabId, false);
});
