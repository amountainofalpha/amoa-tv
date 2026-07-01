(() => {
  const PAGE_TAG = 'amoa-tv';
  const LINE_TOOL_LOADER_MODULE = 778255;
  const LINK_KEY_PREFIX = 'amoa-tv:'; // every draw gets linkKey=<prefix><metric>[:<seq>]
  // Units whose values live on the price axis. Anything else needs its own
  // scale — we get that by inserting a study and hijacking its data.
  const PRICE_UNITS = new Set(['usd', 'usd_millions', 'usd_billions']);
  // User-installed Pine indicator we hijack for non-price metrics. Match by
  // description prefix so `indicator("AMOA Overlay")`, `indicator("AMOA VOL")`
  // etc. all count as usable slots (one per active non-price overlay).
  const AMOA_STUDY_DESC_PREFIX = 'AMOA';
  // Pine descriptor used by w.insertStudy for Pine scripts. Public API in
  // TV's guts: {type: 'pine', pineId: '<USER|PUB>;<hash>', pineVersion}.
  // This is the *only* shape that gets Pine scripts inserted programmatically
  // — the `type: 'java'` path errors with "Cannot get study" because the
  // packageId comparison in TV's internals is exact-match against
  // "tv-scripting" and the server-returned metainfo id has a build-stamp
  // suffix like "-101".
  const AMOA_PINE_ID = 'USER;91ba7cf3139447a3b3fb0930e49271e8';
  const AMOA_PINE_VERSION = '5.0';
  const log = (...a) => console.log('[amoa-tv:page]', ...a);
  window.__amoa_tv_loaded = true;
  log('page.js loaded, url=', location.href);

  // Per-metric drawing tracking so we can clear one overlay without touching
  // others (and clear everything when the symbol changes).
  const drawingsByMetric = new Map(); // metric → Set<sourceId>
  const studiesByMetric = new Map();  // metric → sourceId of a hijacked study
  let currentSymbol = null;
  let debounceTimer = null;
  let webpackRequire = null;
  let lineToolLoader = null;

  waitForChart().then(init).catch((e) => log('waitForChart failed', e));

  function ensureWebpackRequire() {
    if (webpackRequire) return webpackRequire;
    const wp = window.webpackChunktradingview;
    if (!wp) return null;
    wp.push([['__amoa_wp_grab__' + Date.now()], {}, (r) => { webpackRequire = r; }]);
    return webpackRequire;
  }

  function ensureLineToolLoader() {
    if (lineToolLoader) return lineToolLoader;
    const req = ensureWebpackRequire();
    if (!req) return null;
    lineToolLoader = req(LINE_TOOL_LOADER_MODULE);
    return lineToolLoader;
  }

  async function ensureLineToolReady(name) {
    const loader = ensureLineToolLoader();
    if (!loader) return false;
    if (loader.isLineToolLoaded?.(name)) return true;
    await loader.loadLineTool(name);
    return true;
  }

  // Every createLineTool call queues a "line-being-created" entry inside
  // model.m_model._linesBeingCreated AND a command inside model._createLineCommands.
  // For interactive drawing those get drained by continueCreatingLine, but our
  // batch flow (create + addPoint + finishLineTool) never drains them. Left
  // stuck, a user click gets routed to `continueCreatingLine` on the pending
  // tool and TV asserts "Cannot continue not least created line". Drain both
  // ourselves after every tool.
  function drainCreatingState(model) {
    try {
      const inner = model.m_model;
      if (inner?._linesBeingCreated?.length) inner._linesBeingCreated.length = 0;
    } catch (_) {}
    try {
      if (Array.isArray(model._createLineCommands) && model._createLineCommands.length) {
        model._createLineCommands.length = 0;
      }
    } catch (_) {}
  }

  function waitForChart() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        tries++;
        const c = window._exposed_chartWidgetCollection;
        const w = c?.activeChartWidget?.value?.();
        if (w && w.model) resolve({ c, w });
        else setTimeout(check, 300);
      };
      check();
    });
  }

  function init({ c, w }) {
    const symWV = w.symbolWV();
    currentSymbol = symWV.value();
    log('subscribed, initial symbol=', currentSymbol);

    symWV.subscribe((sym) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => onSymbolChanged(sym), 250);
    });

    onSymbolChanged(currentSymbol);
  }

  function onSymbolChanged(newSymbol) {
    log('symbol changed →', newSymbol);
    clearAllOverlays();
    currentSymbol = newSymbol;
    window.postMessage({ tag: PAGE_TAG, dir: 'page->bg', type: 'symbolChanged', symbol: newSymbol }, '*');
  }

  // ── messages from content.js ──────────────────────────────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.tag !== PAGE_TAG || msg.dir !== 'bg->page') return;

    if (msg.type === 'contentReady') { log('content bridge ready'); return; }
    if (msg.type === 'getSymbol') {
      window.postMessage({ tag: PAGE_TAG, dir: 'page->bg', type: 'symbolReply', symbol: currentSymbol }, '*');
      return;
    }
    if (msg.type === 'drawSeries') {
      if (msg.symbol !== currentSymbol) { log('stale draw for', msg.symbol, '(current=', currentSymbol, ')'); return; }
      drawSeries(msg.metric, msg.color, msg.points, msg.isStrike, msg.label, msg.symbol, msg.unit);
      return;
    }
    if (msg.type === 'clearMetric') { clearMetric(msg.metric); return; }
    if (msg.type === 'clearAll')    { clearAllOverlays(); return; }
  });

  // ── drawing ──────────────────────────────────────────────────────────────
  async function drawSeries(metric, color, points, isStrike, label, symbolAtDispatch, unit) {
    if (!points?.length) { log('no points for', metric); return; }
    const stillCurrent = () => currentSymbol === symbolAtDispatch;
    if (!stillCurrent()) { log('symbol drifted before draw for', metric); return; }

    clearMetric(metric);

    const c = window._exposed_chartWidgetCollection;
    const w = c.activeChartWidget.value();
    const model = w.model();
    const pane = model.panes()[0];
    const ts = model.timeScale();

    // Non-price metrics (percent / ratio / count / days / …) can't share
    // the OHLC scale — their values are on a totally different range. Push
    // them into a hijacked study which comes with its own left-hand axis.
    if (!isStrike && unit && !PRICE_UNITS.has(unit)) {
      await drawViaStudyHijack({ w, model, metric, label, color, points, ts, stillCurrent });
      return;
    }

    const ids = new Set();
    drawingsByMetric.set(metric, ids);

    const hasExpiration = points.some(p => p.expiration != null);
    if (isStrike && hasExpiration) {
      await drawStrikeExpirationRuns({ model, pane, ts, points, color, ids, stillCurrent, metric });
      log('drew', ids.size, 'paired-strike run segments for', metric);
      return;
    }

    const mapped = [];
    for (const p of points) {
      const idx = ts.timePointToIndex?.(p.time, true);
      if (idx == null || !Number.isFinite(idx)) continue;
      mapped.push({ index: idx, price: p.value });
    }
    if (!mapped.length) { log('all points off-chart for', metric); drawingsByMetric.delete(metric); return; }

    if (isStrike) {
      await ensureLineToolReady('LineToolCircle');
      if (!stillCurrent()) { log('symbol drifted while loading tool for', metric); drawingsByMetric.delete(metric); return; }
      const dx = 0.4;
      let seq = 0;
      for (const pt of mapped) {
        const dy = Math.abs(pt.price) * 0.0005 || 0.1;
        const shape = model.createLineTool({
          pane,
          point: { index: pt.index - dx, price: pt.price - dy },
          linetool: 'LineToolCircle',
          linkKey: linkKeyFor(metric, seq++),
        });
        shape.addPoint({ index: pt.index + dx, price: pt.price + dy });
        model.finishLineTool(shape);
        drainCreatingState(model);
        if (shape?._id != null) {
          ids.add(getId(shape));
          applyCircleDotStyle(shape, color);
        }
      }
      log('drew', mapped.length, 'dot markers for strike metric', metric);
    } else {
      await ensureLineToolReady('LineToolPath');
      if (!stillCurrent()) { log('symbol drifted while loading tool for', metric); drawingsByMetric.delete(metric); return; }
      const shape = model.createLineTool({
        pane, point: mapped[0], linetool: 'LineToolPath',
        linkKey: linkKeyFor(metric, 0),
      });
      for (const pt of mapped.slice(1)) shape.addPoint(pt);
      model.finishLineTool(shape);
      drainCreatingState(model);

      if (shape?._id != null) {
        ids.add(getId(shape));
        applyPathStyle(shape, color, label);
      }
      log('drew path with', mapped.length, 'points for', metric);
    }
  }

  function getId(shape) {
    return String(shape._id?.value?.() ?? shape._id);
  }

  function applyPathStyle(shape, color, label) {
    const props = shape?._properties;
    if (!props) return;
    (props.linecolor || props.color)?.setValue?.(color);
    props.linewidth?.setValue?.(2);
    if (label) {
      props.text?.setValue?.(label);
      props.showLabel?.setValue?.(true);
    }
  }

  function applyCircleDotStyle(shape, color) {
    const props = shape?._properties;
    if (!props) return;
    // Filled dot: match fill + border to the metric color, transparent border
    // width so the dot reads as a solid mark.
    const linecolor = props.linecolor || props.color;
    linecolor?.setValue?.(color);
    props.backgroundColor?.setValue?.(color);
    props.fillBackground?.setValue?.(true);
    props.linewidth?.setValue?.(0);
    // Hide interactive-selection labels/handles for cleaner overlays.
    props.showLabel?.setValue?.(false);
  }

  async function drawStrikeExpirationRuns({ model, pane, ts, points, color, ids, stillCurrent, metric }) {
    await ensureLineToolReady('LineToolTrendLine');
    if (stillCurrent && !stillCurrent()) return;
    let seq = 0;
    // Sort chronologically, collapse consecutive identical (value, expiration).
    const obs = points
      .filter(p => p.expiration != null && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time);
    if (!obs.length) return;

    const runs = [];
    let cur = null;
    for (const o of obs) {
      if (!cur || cur.value !== o.value || cur.expiration !== o.expiration) {
        if (cur) runs.push(cur);
        cur = { value: o.value, expiration: o.expiration, start: o.time };
      }
    }
    if (cur) runs.push(cur);

    const w = model._chartWidget || null;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const next = runs[i + 1];
      // A run ends either at the next run's start (a shift happened) or at
      // its own expiration — whichever comes first.
      const endTime = next && r.expiration > next.start ? next.start : r.expiration;
      const startIdx = ts.timePointToIndex(r.start, true);
      const endIdx   = ts.timePointToIndex(endTime, true);
      if (!Number.isFinite(startIdx) || !Number.isFinite(endIdx) || endIdx <= startIdx) continue;

      const shape = model.createLineTool({
        pane, point: { index: startIdx, price: r.value }, linetool: 'LineToolTrendLine',
        linkKey: linkKeyFor(metric, seq++),
      });
      shape.addPoint({ index: endIdx, price: r.value });
      model.finishLineTool(shape);
      drainCreatingState(model);
      if (shape?._id != null) {
        ids.add(getId(shape));
        applyRunSegmentStyle(shape, color);
      }
    }
  }

  function applyRunSegmentStyle(shape, color) {
    const props = shape?._properties;
    if (!props) return;
    (props.linecolor || props.color)?.setValue?.(color);
    props.linewidth?.setValue?.(2);
    // Dotted style matches HistoricalChart's StrikeFillsPrimitive rendering.
    props.linestyle?.setValue?.(1);
    props.showLabel?.setValue?.(false);
    // Kill the end-point extends so the segment stops exactly at its bounds.
    props.leftEnd?.setValue?.(0);
    props.rightEnd?.setValue?.(0);
    if (props.extendLeft?.setValue)  props.extendLeft.setValue(false);
    if (props.extendRight?.setValue) props.extendRight.setValue(false);
  }

  function linkKeyFor(metric, seq) {
    return LINK_KEY_PREFIX + metric + ':' + seq;
  }

  // ── study-hijack renderer (for non-price metrics) ────────────────────────
  // We insert a real built-in study (RSI) once per metric. It ships with a
  // separate left-hand price scale that auto-fits its data range. We then
  // overwrite its computed values with ours so the axis lands where the
  // user's metric actually lives — no normalization, no shared price scale.
  async function drawViaStudyHijack({ w, model, metric, label, color, points, ts, stillCurrent }) {
    const sourceId = await ensureAmoaStudy({ w, model, metric, label, color, stillCurrent });
    if (!sourceId) {
      log('no AMOA Overlay study available for', metric,
          '— add one AMOA Overlay Pine indicator to your chart once so the extension can clone more.');
      return;
    }
    if (stillCurrent && !stillCurrent()) return;
    const src = model.dataSourceForId(sourceId);
    if (!src) { studiesByMetric.delete(metric); return; }
    const added = pushMetricDataToStudy(src, points, ts);
    log('pushed', added, 'points into AMOA study for', metric);
  }

  // First, claim an unclaimed AMOA source already on the chart. If they're
  // all claimed but at least one exists (so we know the user's studyId),
  // insertStudy another copy using that same id, wait for it to attach,
  // and claim it. This turns "user manually added ONE AMOA Overlay" into
  // "extension can host N of them" without any per-user studyId configuration.
  async function ensureAmoaStudy({ w, model, metric, label, color, stillCurrent }) {
    const existing = studiesByMetric.get(metric);
    if (existing && model.dataSourceForId(existing)) {
      applyAmoaStudyStyling(model.dataSourceForId(existing), label, color);
      return existing;
    }
    const claimTarget = await findClaimableAmoaSource(model, metric, label, color, stillCurrent);
    if (claimTarget) return claimTarget;

    log('inserting AMOA Pine study for', metric);
    const before = new Set(model.dataSources().map(getId));
    let result, err;
    try {
      result = await w.insertStudy(
        { type: 'pine', pineId: AMOA_PINE_ID, pineVersion: AMOA_PINE_VERSION },
        []
      );
    } catch (e) { err = e?.message || String(e); }
    if (err) { log('insertStudy threw', err); return null; }
    if (!result) { log('insertStudy returned null (Pine)'); return null; }
    if (stillCurrent && !stillCurrent()) return null;

    // Poll for the newly attached source. Match by description because the
    // studyId TV assigns post-insert can drop the `-101` build-stamp suffix.
    let src = null;
    for (let i = 0; i < 40; i++) {
      const sources = model.dataSources();
      src = sources.find((s) => {
        if (before.has(getId(s))) return false;
        const m = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
        return m?.description?.startsWith?.(AMOA_STUDY_DESC_PREFIX);
      });
      if (src) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!src) return null;
    const id = getId(src);
    studiesByMetric.set(metric, id);
    applyAmoaStudyStyling(src, label, color);
    return id;
  }

  // Look up to 1s for any AMOA source on the chart. First unclaimed wins;
  // if all are claimed, we don't hijack — returning null makes us fall
  // through to insertStudy for another copy.
  async function findClaimableAmoaSource(model, metric, label, color, stillCurrent) {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (stillCurrent && !stillCurrent()) return null;
      const claimed = new Set([...studiesByMetric.values()]);
      for (const s of model.dataSources()) {
        if (!s || s.isLineTool) continue;
        const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
        if (!meta?.description?.startsWith(AMOA_STUDY_DESC_PREFIX)) continue;
        const id = String(s._id?.value?.() ?? s._id);
        if (claimed.has(id)) continue;
        studiesByMetric.set(metric, id);
        applyAmoaStudyStyling(s, label, color);
        return id;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  // Compile & register the Pine study's metainfo so a subsequent
  // w.insertStudy({type:'java', studyId: ...}) can resolve it. This is
  // what the TV UI does behind the scenes when a user picks a Pine
  // indicator from the "Add Indicator" dialog.
  let webpackReqPine = null;
  async function warmPineStudy(studyId) {
    if (!webpackReqPine) {
      const wp = window.webpackChunktradingview;
      if (!wp) return;
      wp.push([['__amoa_pine_warm_' + Date.now()], {}, (r) => { webpackReqPine = r; }]);
    }
    const req = webpackReqPine;
    if (!req) return;
    const repo = req(471743)?.studyMetaInfoRepository?.();
    if (!repo?.addPineMetaInfo) return;

    // /translate/ returns the *compiled* metainfo (result.metaInfo + IL /
    // ilTemplate bytecode), which is what TV's own studies use. /get/ only
    // returns source Pine text. `credentials: 'include'` so TV's session
    // cookie authenticates the user script fetch.
    const pineId = (studyId.match(/(USER|PUB);[a-f0-9]+/i) || [])[0];
    if (!pineId) return;
    const url = `https://pine-facade.tradingview.com/pine-facade/translate/${encodeURIComponent(pineId)}/last`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { log('pine-facade translate failed', res.status); return; }
    const body = await res.json();
    const metaInfo = body?.result?.metaInfo;
    if (!metaInfo) {
      log('pine-facade translate returned no metaInfo — body keys:', Object.keys(body || {}), 'result keys:', Object.keys(body?.result || {}));
      return;
    }
    // Inject the IL bytecode into the metainfo's `text` input so the study
    // runtime has code to execute when TV instantiates it.
    const ilInput = metaInfo.inputs?.find(i => i.id === 'text');
    if (ilInput && body?.result?.ilTemplate) ilInput.defval = body.result.ilTemplate;
    repo.addPineMetaInfo(metaInfo, []);
    log('cached pine metainfo id=', metaInfo.id);
    return metaInfo;
  }

  function applyAmoaStudyStyling(src, label, color) {
    if (!src?._properties) return;
    // Rename so the legend reads the metric label instead of "AMOA Overlay".
    try { src._properties.title?.setValue?.(label); } catch (_) {}
    // The Pine sets color as fully transparent; make our plot visible in
    // the metric's color. Property path is styles.plot_0.color.
    try {
      const styles = src._properties.styles;
      const plot0 = styles?.plot_0 || styles?.childs?.().plot_0;
      const colorProp = plot0?.color || plot0?.childs?.().color;
      colorProp?.setValue?.(color);
    } catch (_) {}
  }

  function pushMetricDataToStudy(src, points, ts) {
    const data = src.data();
    // AMOA Overlay Pine study is single-plot so its value array is exactly
    // [time_sec, value] — no template needed, no palette slots to preserve.
    data._shareRead = false;
    data.clear();
    let added = 0;
    for (const p of points) {
      const idx = ts.timePointToIndex(p.time, true);
      if (!Number.isFinite(idx)) continue;
      if (data.add(idx, [p.time, p.value]) !== false) added++;
    }
    data._shareRead = true;
    try { src._invalidateLastNonEmptyPlotRowCache?.(); } catch (_) {}
    return added;
  }

  function removeStudyForMetric(metric) {
    const id = studiesByMetric.get(metric);
    if (!id) return false;
    const model = window._exposed_chartWidgetCollection?.activeChartWidget?.value?.()?.model?.();
    if (model) {
      const src = model.dataSourceForId(id);
      if (src) { try { model.removeSource(src); } catch (_) {} }
    }
    studiesByMetric.delete(metric);
    return true;
  }

  function removeAllHijackStudies() {
    for (const metric of [...studiesByMetric.keys()]) removeStudyForMetric(metric);
  }

  // Every draw we make carries a linkKey with our prefix. On teardown we
  // sweep every line-tool source on the chart by prefix / metric — so
  // orphans from a previous tab session (before the in-memory
  // drawingsByMetric map existed) also get nuked, not just what we tracked.
  function sweepByLinkKey(matches) {
    const model = window._exposed_chartWidgetCollection?.activeChartWidget?.value?.()?.model?.();
    if (!model) return 0;
    const sources = model.dataSources?.() || [];
    let removed = 0;
    for (const src of sources) {
      if (!src?.isLineTool) continue;
      // _linkKey is a WatchedValue wrapper, not a plain string. Extract via
      // .value() before pattern-matching, otherwise every source falls
      // through the typeof-string guard.
      const key = src._linkKey?.value?.() || null;
      if (!key || typeof key !== 'string') continue;
      if (!matches(key)) continue;
      try { model.removeSource(src); removed++; } catch (_) {}
    }
    return removed;
  }

  function clearMetric(metric) {
    const prefix = LINK_KEY_PREFIX + metric + ':';
    const removed = sweepByLinkKey(k => k.startsWith(prefix));
    const hadStudy = removeStudyForMetric(metric);
    drawingsByMetric.delete(metric);
    log('cleared', removed, 'drawings', hadStudy ? '+ 1 study' : '', 'for', metric);
  }

  function clearAllOverlays() {
    const removed = sweepByLinkKey(k => k.startsWith(LINK_KEY_PREFIX));
    const studies = studiesByMetric.size;
    removeAllHijackStudies();
    drawingsByMetric.clear();
    log('cleared', removed, 'total overlay drawings +', studies, 'studies');
  }
})();
