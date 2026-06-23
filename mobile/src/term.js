import React, { forwardRef, useImperativeHandle, useRef, memo } from 'react';
import { WebView } from 'react-native-webview';

// xterm.js inside a WebView, display-only. Native controls drive input, so the
// terminal just renders bytes RN hands it. xterm loaded from CDN (the phone is
// already online to reach the relay).
const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
  html,body{height:100%;margin:0;background:#0a0a0c;overflow:hidden}
  #t{position:absolute;inset:0;padding:6px 8px;overflow:auto;-webkit-overflow-scrolling:touch}
  #t .xterm{min-height:100%}
  .xterm-viewport::-webkit-scrollbar{width:0}
  #t::-webkit-scrollbar{width:0;height:0}
</style></head><body><div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
  var term = new Terminal({
    fontSize: 12, fontFamily: 'Menlo, monospace', cursorBlink: false, scrollback: 5000,
    theme: { background: '#0a0a0c', foreground: '#d6d6da', cursor: '#c2ec3a',
      red:'#e8483e', green:'#c2ec3a', yellow:'#e0c454', blue:'#5aa9ff', cyan:'#46c8dc' }
  });
  var fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  var el = document.getElementById('t');
  term.open(el);
  function post(o){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  var gen = 0, lastFitC = 0, lastFitR = 0, deb = null, remoteCols = 0, remoteRows = 0;
  var BASE_FONT = 12, MIN_FONT = 6;
  function setFontSize(size){
    size = Math.max(MIN_FONT, Math.min(BASE_FONT, size));
    if (Math.abs(term.options.fontSize - size) > 0.05) term.options.fontSize = size;
  }
  function fitLocal(){
    setFontSize(BASE_FONT);
    try { fit.fit(); } catch(e){}
    return { cols: term.cols, rows: term.rows };
  }
  function refit(){
    var local = fitLocal();
    if (local.cols < 2 || local.rows < 2 || el.clientWidth === 0) return; // ignore degenerate pre-layout fits
    if (remoteCols > local.cols) {
      setFontSize(BASE_FONT * (local.cols / remoteCols));
      try { fit.fit(); } catch(e){}
    }
    if (remoteCols > 1) {
      try { term.resize(remoteCols, Math.max(2, remoteRows || term.rows)); } catch(e){}
    }
    if (local.cols === lastFitC && local.rows === lastFitR) return;       // dedupe the native resize hint
    lastFitC = local.cols; lastFitR = local.rows;
    post({ t: 'size', cols: local.cols, rows: local.rows, gen: ++gen });
  }
  function refitSoon(){ clearTimeout(deb); deb = setTimeout(refit, 80); } // coalesce load/layout/keyboard flutter into one size
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
    .then(function(){ requestAnimationFrame(function(){ requestAnimationFrame(refit); }); }); // first fit only after fonts + real layout
  window.addEventListener('resize', refitSoon);
  try { new ResizeObserver(refitSoon).observe(el); } catch(e){}
  if (window.visualViewport) { visualViewport.addEventListener('resize', refitSoon); visualViewport.addEventListener('scroll', refitSoon); } // soft keyboard shrinks the visual viewport without firing window.resize
  window.__setRemoteSize = function(c, r){
    remoteCols = c || 0; remoteRows = r || 0;
    refit();
  };
  window.__write = function(d){ term.write(d); };
  window.__reset = function(d){ term.reset(); if (d) term.write(d); };
</script></body></html>`;

const SOURCE = { html: HTML }; // stable ref so the WebView never reloads on re-render

export const Term = memo(forwardRef(({ onSize }, ref) => {
  const wv = useRef(null);
  useImperativeHandle(ref, () => ({
    write: (d) => wv.current && wv.current.injectJavaScript(`window.__write(${JSON.stringify(d)});true;`),
    reset: (d) => wv.current && wv.current.injectJavaScript(`window.__reset(${JSON.stringify(d || '')});true;`),
    setRemoteSize: (cols, rows) => wv.current && wv.current.injectJavaScript(`window.__setRemoteSize(${Number(cols) || 0},${Number(rows) || 0});true;`),
  }));
  return (
    <WebView
      ref={wv}
      source={SOURCE}
      originWhitelist={['*']}
      style={{ flex: 1, backgroundColor: '#0a0a0c' }}
      javaScriptEnabled
      domStorageEnabled
      scrollEnabled={false}
      onMessage={(e) => {
        try { const m = JSON.parse(e.nativeEvent.data); if (m.t === 'size' && onSize) onSize(m.cols, m.rows, m.gen); } catch {}
      }}
    />
  );
}));
