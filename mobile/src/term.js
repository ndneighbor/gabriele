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
  #t{position:absolute;inset:0;padding:6px 8px}
  .xterm-viewport::-webkit-scrollbar{width:0}
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
  var gen = 0, lastC = 0, lastR = 0, deb = null;
  function refit(){
    try { fit.fit(); } catch(e){}
    if (term.cols < 2 || term.rows < 2 || el.clientWidth === 0) return;   // ignore degenerate pre-layout fits
    if (term.cols === lastC && term.rows === lastR) return;               // dedupe — no postMessage spam / no needless PTY resize
    lastC = term.cols; lastR = term.rows;
    post({ t: 'size', cols: term.cols, rows: term.rows, gen: ++gen });
  }
  function refitSoon(){ clearTimeout(deb); deb = setTimeout(refit, 80); } // coalesce load/layout/keyboard flutter into one size
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
    .then(function(){ requestAnimationFrame(function(){ requestAnimationFrame(refit); }); }); // first fit only after fonts + real layout
  window.addEventListener('resize', refitSoon);
  try { new ResizeObserver(refitSoon).observe(el); } catch(e){}
  if (window.visualViewport) { visualViewport.addEventListener('resize', refitSoon); visualViewport.addEventListener('scroll', refitSoon); } // soft keyboard shrinks the visual viewport without firing window.resize
  window.__write = function(d){ term.write(d); };
  window.__reset = function(d){ term.reset(); if (d) term.write(d); };
</script></body></html>`;

const SOURCE = { html: HTML }; // stable ref so the WebView never reloads on re-render

export const Term = memo(forwardRef(({ onSize }, ref) => {
  const wv = useRef(null);
  useImperativeHandle(ref, () => ({
    write: (d) => wv.current && wv.current.injectJavaScript(`window.__write(${JSON.stringify(d)});true;`),
    reset: (d) => wv.current && wv.current.injectJavaScript(`window.__reset(${JSON.stringify(d || '')});true;`),
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
