// Documento offscreen: onde o áudio das abas é processado.
//
// O áudio de cada aba ligada é capturado com chrome.tabCapture (o stream id vem
// do popup ou do background) e passa pelo Engine. Capturar a aba pega TODO o
// som dela — iframes de qualquer origem, players com Web Audio próprio, mídia
// sem CORS — e, enquanto a aba é capturada, o Chrome deixa de tocar o som
// original, então o que sai no alto-falante é só a versão amplificada daqui.
//
// Documentos offscreen só têm acesso a chrome.runtime; as configurações chegam
// por mensagem (do popup em tempo real e do background quando algo é salvo).

const { Engine } = VBAudio;

/** @type {Map<number, {stream: MediaStream, ctx: AudioContext, engine: InstanceType<typeof Engine>}>} */
const captures = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  switch (msg.type) {
    case "START":
      start(msg.tabId, msg.streamId, msg.settings).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
      );
      return true; // resposta assíncrona
    case "APPLY":
      captures.get(msg.tabId)?.engine.apply(msg.settings);
      sendResponse({ ok: true });
      break;
    case "STOP":
      stop(msg.tabId);
      sendResponse({ ok: true });
      break;
    case "LIST":
      sendResponse([...captures.keys()]);
      break;
    case "GET_LEVEL": {
      const c = captures.get(msg.tabId);
      if (c) sendResponse(c.engine.level());
      break;
    }
  }
  return false;
});

async function start(tabId, streamId, settings) {
  stop(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });

  // latencyHint "interactive" = menor atraso possível, para o som não
  // descolar da imagem do vídeo.
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const engine = new Engine(ctx, settings);
  ctx.createMediaStreamSource(stream).connect(engine.input);
  captures.set(tabId, { stream, ctx, engine });

  // A captura termina sozinha quando a aba é fechada ou o usuário a interrompe
  // pelo indicador do Chrome.
  stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (captures.get(tabId)?.stream !== stream) return;
    stop(tabId);
    chrome.runtime.sendMessage({ type: "CAPTURE_ENDED", tabId }).catch(() => {});
  });

  if (ctx.state !== "running") await ctx.resume();
}

function stop(tabId) {
  const c = captures.get(tabId);
  if (!c) return;
  captures.delete(tabId);
  for (const track of c.stream.getTracks()) track.stop();
  c.ctx.close().catch(() => {});
}
