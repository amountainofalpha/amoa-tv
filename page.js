(() => {
  const PAGE_TAG = 'amoa-tv';
  const LINE_TOOL_LOADER_MODULE = 778255;
  const LINK_KEY_PREFIX = 'amoa-tv:'; // every draw gets linkKey=<prefix><metric>[:<seq>]
  // Units whose values live on the price axis. Only bare 'usd' — OHLC candles
  // and strike prices — shares magnitude with the price scale. usd_millions
  // (delta / gamma / vega / theta / notional groups) and usd_billions
  // (market_cap) are dollar-notional at totally different orders of
  // magnitude and belong on the left-axis AMOA study, otherwise the line
  // gets drawn off-screen relative to the candles.
  const PRICE_UNITS = new Set(['usd']);
  // User-installed Pine indicator we hijack for non-price metrics. Match by
  // description prefix so `indicator("AMOA Overlay")`, `indicator("AMOA VOL")`
  // etc. all count as usable slots (one per active non-price overlay).
  const AMOA_STUDY_DESC_PREFIX = 'AMOA';
  // Pine descriptor used by w.insertStudy for Pine scripts. Public API in
  // TV's guts: {type: 'pine', pineId: '<USER|PUB>;<hash>', pineVersion}.
  // pineId is filled in per-kind from content.js via a `pineIds` message —
  // each user has their own private copies of the AMOA Pine scripts, so
  // the hashes are stored in chrome.storage and delivered here at runtime.
  const AMOA_PINE_VERSION = 'last';
  // Two study "kinds":
  //   'overlay' → left-axis (percent / ratio / count / days …). Description
  //               'AMOA Overlay'. Last slot is the zero reference line.
  //   'ohlc'    → right-axis (aligned with OHLC candles). Description
  //               'AMOA OHLC'. Every slot is a metric slot; no zero line.
  const SIGNED_UNITS = new Set(['percent', 'ratio', 'ratio_0_1']);
  const STUDY_KINDS = {
    overlay: {
      pineId: null, // populated by pineIdsChanged message
      pineVersion: AMOA_PINE_VERSION,
      descPrefix: 'AMOA Overlay',
      hasZeroLine: true,
    },
    ohlc: {
      pineId: null,
      pineVersion: AMOA_PINE_VERSION,
      descPrefix: 'AMOA OHLC',
      hasZeroLine: false,
    },
  };
  // Description → kind classifier. Accepts either the bare 'AMOA' or the
  // longer 'AMOA Overlay' for the left-axis study (some existing users
  // saved it under the short name). 'AMOA OHLC' is unambiguous.
  function classifyAmoaPine(desc) {
    if (!desc) return null;
    const s = String(desc).trim().toLowerCase();
    if (s === 'amoa ohlc') return 'ohlc';
    if (s === 'amoa' || s === 'amoa overlay') return 'overlay';
    return null;
  }
  // Synthetic unit key for the shared right-axis study — paired-strike
  // metrics all bucket into this one record regardless of what their
  // catalog unit is (usd, in most cases).
  const OHLC_UNIT_KEY = 'ohlc';
  const log = (...a) => console.log('[amoa-tv:page]', ...a);
  window.__amoa_tv_loaded = true;
  log('page.js loaded, url=', location.href);

  // Per-metric drawing tracking so we can clear one overlay without touching
  // others (and clear everything when the symbol changes).
  const drawingsByMetric = new Map(); // metric → Set<sourceId>
  // Non-price metrics share one AMOA study per unit (all `percent` metrics
  // share one axis, all `days` metrics share another, etc.). Two parallel
  // maps: metric → sourceId for cleanup bookkeeping, unit → sourceId for
  // discovery / reuse.
  const studiesByMetric = new Map();  // metric → sourceId of its unit's shared study
  // Per-unit study record. One AMOA study is inserted per unit; up to
  // metaInfo.plots.length metrics can share that study as separate plot
  // lines on the same axis. slotByMetric assigns each metric a plot index;
  // dataByMetric retains each metric's points so we can rebuild the
  // combined value array (which must carry every metric's value at every
  // bar the axis covers) whenever any single metric updates.
  //   Map<unit, {
  //     sourceId, numSlots,
  //     slotByMetric: Map<metric, slotIdx>,
  //     dataByMetric: Map<metric, {time, value}[]>,
  //   }>
  const studyByUnit = new Map();
  const studyInsertInFlight = new Map(); // unit → Promise<sourceId|null>
  let currentSymbol = null;
  let debounceTimer = null;
  // First bar index of the main series as of the last watcher tick — when
  // it decreases, TV lazy-loaded older candles (zoom/scroll-out) and our
  // studies need a re-push so full-history points map onto the new bars.
  let histFirstIndex = null;
  // Serial queue for drawSeries calls — ensures per-unit study insert
  // dedup works even when multiple metrics fire back-to-back.
  let drawSeriesQueue = Promise.resolve();
  let webpackRequire = null;
  let lineToolLoader = null;

  waitForChart().then(init).catch((e) => log('waitForChart failed', e));

  // Auto-detect the user's AMOA Pine scripts by watching the chart's data
  // sources. When a script with description "AMOA Overlay" or "AMOA OHLC"
  // is present, extract its USER;<hash> and hand the hash to content.js.
  // Only runs while the corresponding pineId is unset — once configured we
  // don't overwrite (user's Setup → Reset in the popup clears it).
  setInterval(() => {
    const model = activeModel();
    if (!model) return;
    for (const s of (model.dataSources?.() || [])) {
      if (!s || s.isLineTool) continue;
      const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
      const kind = classifyAmoaPine(meta?.description);
      if (!kind) continue;
      if (STUDY_KINDS[kind].pineId) continue; // already configured
      const m = String(meta?.id || '').match(/USER;([a-f0-9]{32})/i);
      if (!m) continue;
      log('detected AMOA', kind, 'Pine hash from chart:', m[1]);
      window.postMessage({
        tag: PAGE_TAG, dir: 'page->bg',
        type: 'pineDetected', kind, hash: m[1],
      }, '*');
    }
  }, 1500);

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

  // The active chart's model, or null. w.model() THROWS ("Value is null")
  // while the chart is still loading — a truthy `w.model` method is not
  // enough to know the chart is ready.
  function activeModel() {
    try {
      return window._exposed_chartWidgetCollection?.activeChartWidget?.value?.()?.model?.() || null;
    } catch (_) { return null; }
  }

  function waitForChart() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        tries++;
        const c = window._exposed_chartWidgetCollection;
        const w = c?.activeChartWidget?.value?.();
        // Only resolve once model() actually returns a model — it throws
        // during the load phase even though the widget object exists.
        if (w && activeModel()) resolve({ c, w });
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
    softClearOverlays();
    currentSymbol = newSymbol;
    histFirstIndex = null; // new symbol → new series indexing
    window.postMessage({ tag: PAGE_TAG, dir: 'page->bg', type: 'symbolChanged', symbol: newSymbol }, '*');
  }

  // ── messages from content.js ──────────────────────────────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.tag !== PAGE_TAG || msg.dir !== 'bg->page') return;

    if (msg.type === 'contentReady') { log('content bridge ready'); return; }
    if (msg.type === 'pineIds') {
      const p = msg.pineIds || {};
      STUDY_KINDS.overlay.pineId = p.overlay ? `USER;${p.overlay}` : null;
      STUDY_KINDS.ohlc.pineId    = p.ohlc    ? `USER;${p.ohlc}`    : null;
      log('pineIds set: overlay=', !!p.overlay, 'ohlc=', !!p.ohlc);
      return;
    }
    if (msg.type === 'getSymbol') {
      window.postMessage({ tag: PAGE_TAG, dir: 'page->bg', type: 'symbolReply', symbol: currentSymbol }, '*');
      return;
    }
    if (msg.type === 'drawSeries') {
      if (msg.symbol !== currentSymbol) { log('stale draw for', msg.symbol, '(current=', currentSymbol, ')'); return; }
      // Serialize: each drawSeries fully completes before the next runs, so
      // the first same-unit metric's study insert is done and stored in
      // studiesByUnit before the second one asks for it. Simpler than
      // per-unit in-flight dedup and cheaper than a batching protocol.
      drawSeriesQueue = drawSeriesQueue.then(() => drawSeries(
        msg.metric, msg.color, msg.points, msg.isStrike, msg.label, msg.symbol, msg.unit, msg.hiddenMetrics, msg.excludeOutliers, msg.hidden
      )).catch((e) => log('drawSeries error', e?.message || e));
      return;
    }
    if (msg.type === 'clearMetric') { clearMetric(msg.metric); return; }
    if (msg.type === 'clearAll')    { clearAllOverlays(); return; }
    if (msg.type === 'softClear') {
      // Chain onto the draw queue so an in-flight hijack can't repopulate
      // a study we just blanked.
      drawSeriesQueue = drawSeriesQueue.then(() => softClearOverlays())
        .catch(e => log('softClear error', e?.message || e));
      return;
    }
    if (msg.type === 'pruneUnusedStudies') {
      // Chain onto the draw queue so we don't yank a study out from
      // under an in-flight hijack.
      drawSeriesQueue = drawSeriesQueue.then(() => pruneUnusedStudies())
        .catch(e => log('pruneUnusedStudies error', e?.message || e));
      return;
    }
  });

  // Remove any AMOA / AMOA OHLC studies on the chart whose sourceId
  // isn't currently claimed by studyByUnit. Covers the empty copies from
  // initial setup (once we've captured their hashes and started using
  // one) and leftover empties from removed metrics.
  function pruneUnusedStudies() {
    const model = activeModel();
    if (!model) return;
    const claimed = new Set([...studyByUnit.values()].map(r => r.sourceId));
    const knownHashes = Object.values(STUDY_KINDS)
      .map(k => (k.pineId || '').match(/USER;[a-f0-9]+/i)?.[0])
      .filter(Boolean);
    if (!knownHashes.length) return;
    let removed = 0;
    for (const s of model.dataSources()) {
      if (!s || s.isLineTool) continue;
      const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
      const mid = meta?.id || '';
      if (!knownHashes.some(h => mid.includes(h))) continue;
      const id = String(s._id?.value?.() ?? s._id);
      if (claimed.has(id)) continue;
      try { model.removeSource(s); removed++; } catch (_) {}
    }
    if (removed) log('pruned', removed, 'unused AMOA studies');
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  async function drawSeries(metric, color, points, isStrike, label, symbolAtDispatch, unit, hiddenMetrics, excludeOutliers, hidden) {
    if (!points?.length) { log('no points for', metric); return; }
    const stillCurrent = () => currentSymbol === symbolAtDispatch;
    if (!stillCurrent()) { log('symbol drifted before draw for', metric); return; }

    // Sweep this metric's previous line tools only. Study-hosted data is
    // replaced in place by drawViaStudyHijack — the old clearMetric here
    // freed the slot and deleted + reinserted the study on every redraw,
    // which reset TV's own hide (eye) state on the study.
    sweepByLinkKey(k => k.startsWith(LINK_KEY_PREFIX + metric + ':'));
    drawingsByMetric.delete(metric);

    const c = window._exposed_chartWidgetCollection;
    const w = c.activeChartWidget.value();
    const model = w.model();
    const pane = model.panes()[0];
    const ts = model.timeScale();

    // Price-axis data (strikes + bare-usd series) shares TV's auto-fit
    // scale with the candles — one bogus print far above spot squashes the
    // whole chart. Study-hosted data is filtered at push time (so the band
    // follows the loaded candle range as history extends); line tools are
    // filtered here at draw time. Controlled by the "Exclude outlier
    // points" popup setting (default on).
    const wantsOutlierFilter = excludeOutliers !== false && (isStrike || (unit && PRICE_UNITS.has(unit)));

    // Non-price metrics (percent / ratio / count / days / …) can't share
    // the OHLC scale — their values are on a totally different range. Push
    // them into a hijacked study which comes with its own left-hand axis.
    if (!isStrike && unit && !PRICE_UNITS.has(unit)) {
      await drawViaStudyHijack({ w, model, metric, label, color, points, ts, stillCurrent, unit, kind: 'overlay', hiddenMetrics, excludeOutliers: false, hidden });
      return;
    }

    const ids = new Set();
    drawingsByMetric.set(metric, ids);

    const hasExpiration = points.some(p => p.expiration != null);
    if (isStrike && hasExpiration) {
      // Render paired strike + expiration as dots on every weekday from
      // each snapshot up through its expiration — a trail of dots at the
      // strike price. Plot style is Circles (set in applyAmoaSlotStyling),
      // so there's no line connecting different strikes; each row of dots
      // just marks "this strike was the peak from date A to date B".
      const expanded = expandRunsToBarPoints(points, ts);
      await drawViaStudyHijack({
        w, model, metric, label, color,
        points: expanded, ts, stillCurrent,
        unit: OHLC_UNIT_KEY, kind: 'ohlc', hiddenMetrics,
        excludeOutliers: wantsOutlierFilter, hidden,
      });
      return;
    }

    // Hidden metrics that render as line tools draw nothing — line tools
    // have no TV-side hide state to preserve, and the sweep above already
    // removed any previous ones.
    if (hidden) { drawingsByMetric.delete(metric); return; }

    // Line-tool renderers are one-shot (no retained data to re-push), so
    // filter at draw time.
    if (wantsOutlierFilter) {
      points = filterPriceOutliers(points, metric, model);
      if (!points.length) { log('all points were outliers for', metric); return; }
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

  // Outlier band: current price sets the ceiling, the view sets the floor.
  //   • above: up to 50% over the current price, or the highest visible
  //     close (small pad) if that's higher — a stock 80% off its highs
  //     still shows old strikes near those highs while they're on screen.
  //   • below: 20% under the LOWEST visible close. A 4,000 print when
  //     everything in view closed above 6,300 is a bad print no matter
  //     what fraction of spot it is.
  // The visibility watcher re-pushes when zoom/pan moves the band.
  const OUTLIER_ABOVE = 1.5;  // ceiling: × current price
  const OUTLIER_BELOW = 0.8;  // floor:   × lowest visible close
  const VIEW_PAD = 1.05;      // pad on the highest visible close
  function outlierBand(model) {
    try {
      const ts = model?.timeScale?.();
      const bars = model?.mainSeries?.()?.bars?.();
      if (!ts || !bars) return null;
      const bFirst = bars.firstIndex(), bLast = bars.lastIndex();
      const vr = ts.visibleBarsStrictRange?.();
      // Clamp the visible window to bars that actually exist (the right
      // margin extends past the last bar; null range during animations).
      let first = vr?.firstBar?.(), last = vr?.lastBar?.();
      first = Number.isFinite(first) ? Math.max(first, bFirst) : bFirst;
      last  = Number.isFinite(last)  ? Math.min(last, bLast)   : bLast;
      if (!(last >= first)) return null;
      const mm = bars.minMaxOnRangeCached(first, last, [{ name: 'close', offset: 0 }]);
      if (!mm || !Number.isFinite(mm.min) || !Number.isFinite(mm.max) || mm.max <= 0) return null;
      // Current price = last close of the series (not just the view).
      const lastClose = Number(bars.last?.()?.value?.[4]);
      const px = Number.isFinite(lastClose) && lastClose > 0 ? lastClose : mm.max;
      return {
        lo: mm.min * OUTLIER_BELOW,
        hi: Math.max(px * OUTLIER_ABOVE, mm.max * VIEW_PAD),
      };
    } catch (_) { return null; }
  }

  function filterPriceOutliers(points, metric, model) {
    const band = outlierBand(model);
    if (!band) return points;
    const kept = points.filter(p =>
      !Number.isFinite(p.value) || (p.value >= band.lo && p.value <= band.hi));
    const dropped = points.length - kept.length;
    if (dropped) {
      log('excluded', dropped, 'outlier point(s) for', metric,
          '— outside view band [' + band.lo.toFixed(2) + ', ' + band.hi.toFixed(2) + ']');
    }
    return kept;
  }

  // Turn paired strike + expiration observations into a bar-by-bar
  // {time, value} series. Consecutive observations with the same
  // (strike, expiration) collapse into a run; each run then fills every
  // trading day from run.start to min(next.start, this.expiration) with
  // the strike price. Days between runs (or after all runs end) get no
  // point at all, so TV renders those as breaks in the study's line.
  function expandRunsToBarPoints(points, ts) {
    const obs = points
      .filter(p => p.expiration != null && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time);
    if (!obs.length) return [];
    const runs = [];
    let cur = null;
    for (const o of obs) {
      if (!cur || cur.value !== o.value || cur.expiration !== o.expiration) {
        if (cur) runs.push(cur);
        cur = { value: o.value, expiration: o.expiration, start: o.time };
      }
    }
    if (cur) runs.push(cur);

    const expanded = [];
    const DAY = 86400;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const next = runs[i + 1];
      const endTime = next && r.expiration > next.start ? next.start : r.expiration;
      // Fill weekdays inside the run with the strike price.
      for (let t = r.start; t <= endTime; t += DAY) {
        const wd = new Date(t * 1000).getUTCDay();
        if (wd === 0 || wd === 6) continue;
        expanded.push({ time: t, value: r.value });
      }
      // Explicit null right after the run so TV's plot renderer BREAKS
      // the line here — otherwise it draws a diagonal between the end of
      // this run and the start of the next run at a different strike.
      if (next) {
        // Find the next weekday after endTime and push null there.
        for (let t = endTime + DAY; t < next.start; t += DAY) {
          const wd = new Date(t * 1000).getUTCDay();
          if (wd === 0 || wd === 6) continue;
          expanded.push({ time: t, value: null });
          break; // one null is enough to break the line
        }
      }
    }
    return expanded;
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
  async function drawViaStudyHijack({ w, model, metric, label, color, points, ts, stillCurrent, unit, kind, hiddenMetrics, excludeOutliers, hidden }) {
    const record = await ensureAmoaStudyRecord({ w, model, metric, unit, kind, label, color, stillCurrent, hidden });
    if (!record) {
      log('no AMOA Overlay study available for', metric,
          '— add one AMOA Overlay Pine indicator to your chart once so the extension can clone more.');
      return;
    }
    if (stillCurrent && !stillCurrent()) return;
    const src = model.dataSourceForId(record.sourceId);
    if (!src) {
      studiesByMetric.delete(metric);
      studyByUnit.delete(unit);
      return;
    }
    record.dataByMetric.set(metric, points);
    record.excludeOutliers = !!excludeOutliers;
    const added = pushCombinedDataToStudy(src, record, ts);
    log('pushed', added, 'combined points to AMOA', unit, 'study — metric', metric,
        'in slot', record.slotByMetric.get(metric),
        '(of', record.numSlots + ' slots)');

    // Silent data replace for a hidden metric: leave TV's visibility state
    // exactly as-is so the user's hide survives — whether it was the study
    // eye (study visible=false, plot displays untouched) or a plot eye
    // (display=0). Only force this plot's display off when the study itself
    // is visible, which covers a freshly inserted study whose plots default
    // to shown.
    if (hidden) {
      const studyVisible = src._properties?.visible?.value?.() ?? true;
      if (studyVisible) {
        try {
          const styles = src._properties?.styles;
          const sc = typeof styles?.childs === 'function' ? styles.childs() : styles;
          const plot = sc?.[`plot_${record.slotByMetric.get(metric)}`];
          const pc = typeof plot?.childs === 'function' ? plot.childs() : plot;
          pc?.display?.setValue?.(0);
        } catch (_) {}
      }
      return;
    }

    // If the whole study was hidden (e.g. user hit TV's own eye on the
    // study), unhiding one metric via our overlay eye needs to also
    // un-hide the study itself — otherwise nothing renders no matter what
    // display bit we set. Preserve OTHER metrics' hidden state by
    // stamping their plot display=0 BEFORE flipping the study visible,
    // so the 500ms sync watcher doesn't see a transient "everything
    // visible" state and mark them all as shown.
    if (hiddenMetrics?.length) {
      const styles = src._properties?.styles;
      const stylesChilds = typeof styles?.childs === 'function' ? styles.childs() : styles;
      for (const [otherMetric, otherSlot] of record.slotByMetric.entries()) {
        if (otherMetric === metric) continue;
        if (!hiddenMetrics.includes(otherMetric)) continue;
        const plot = stylesChilds?.[`plot_${otherSlot}`];
        const plotChilds = typeof plot?.childs === 'function' ? plot.childs() : plot;
        try { plotChilds?.display?.setValue?.(0); } catch (_) {}
      }
    }
    try { src._properties?.visible?.setValue?.(true); } catch (_) {}
  }

  // First, claim an unclaimed AMOA source already on the chart. If they're
  // all claimed but at least one exists (so we know the user's studyId),
  // insertStudy another copy using that same id, wait for it to attach,
  // and claim it. This turns "user manually added ONE AMOA Overlay" into
  // "extension can host N of them" without any per-user studyId configuration.
  async function ensureAmoaStudyRecord({ w, model, metric, unit, kind, label, color, stillCurrent, hidden }) {
    let record = studyByUnit.get(unit);
    if (record && model.dataSourceForId(record.sourceId)) {
      claimSlot(record, metric, color);
      applyAmoaSlotStyling(model.dataSourceForId(record.sourceId), record, metric, label, color, hidden);
      studiesByMetric.set(metric, record.sourceId);
      return record;
    }
    const sourceId = await ensureAmoaStudy({ w, model, metric, unit, kind, stillCurrent });
    if (!sourceId) return null;
    const src = model.dataSourceForId(sourceId);
    if (!src) return null;
    const meta = typeof src.metaInfo === 'function' ? src.metaInfo() : src._metaInfo;
    const numSlots = meta?.plots?.length || 1;
    const kindDef = STUDY_KINDS[kind] || STUDY_KINDS.overlay;
    // Only the overlay kind reserves the last slot for a zero-reference
    // line; the OHLC kind uses every slot for a metric.
    const zeroSlot = kindDef.hasZeroLine && numSlots > 1 ? numSlots - 1 : null;
    const metricSlots = zeroSlot != null ? zeroSlot : numSlots;
    record = studyByUnit.get(unit);
    if (!record) {
      record = {
        sourceId, unit, kind, numSlots, metricSlots, zeroSlot,
        slotByMetric: new Map(), dataByMetric: new Map(),
      };
      studyByUnit.set(unit, record);
    } else {
      record.kind = kind;
      record.numSlots = numSlots;
      record.metricSlots = metricSlots;
      record.zeroSlot = zeroSlot;
    }
    installVisibilityGuard(model, record);
    claimSlot(record, metric, color);
    applyAmoaSlotStyling(src, record, metric, label, color, hidden);
    studiesByMetric.set(metric, sourceId);
    return record;
  }

  // Assign this metric a plot slot. Prefer keeping the same slot on repeat
  // draws so colors don't shuffle; otherwise take the first free slot; if
  // all slots are taken, evict the oldest metric (first added) so newer
  // picks stay visible.
  function claimSlot(record, metric, color) {
    if (record.slotByMetric.has(metric)) return record.slotByMetric.get(metric);
    const taken = new Set(record.slotByMetric.values());
    const cap = record.metricSlots || record.numSlots;
    for (let i = 0; i < cap; i++) {
      if (!taken.has(i)) { record.slotByMetric.set(metric, i); return i; }
    }
    const [oldestMetric, oldestSlot] = record.slotByMetric.entries().next().value;
    record.slotByMetric.delete(oldestMetric);
    record.dataByMetric.delete(oldestMetric);
    record._appliedColor?.delete?.(oldestMetric);
    record.slotByMetric.set(metric, oldestSlot);
    log('AMOA', 'unit slots full — evicted', oldestMetric, 'for', metric);
    return oldestSlot;
  }

  async function ensureAmoaStudy({ w, model, metric, unit, kind, stillCurrent }) {
    const kindDef = STUDY_KINDS[kind] || STUDY_KINDS.overlay;
    if (!kindDef.pineId) {
      log('cannot insert AMOA', kind, 'study — Pine ID not configured yet (open the extension popup and finish setup)');
      return null;
    }
    const inflight = studyInsertInFlight.get(unit);
    if (inflight) {
      log('awaiting in-flight AMOA study insert for unit', unit, 'from', metric);
      return await inflight;
    }
    const existing = studyByUnit.get(unit);
    if (existing && model.dataSourceForId(existing.sourceId)) return existing.sourceId;
    // Match by the pineId hash embedded in metaInfo.id — that's the
    // authoritative identifier and doesn't depend on the Pine's
    // description string (which the user can name anything).
    const wantedHash = (kindDef.pineId.match(/(USER|PUB);[a-f0-9]+/i) || [])[0];
    const claimed = new Set([...studyByUnit.values()].map(r => r.sourceId));
    for (const s of model.dataSources()) {
      if (!s || s.isLineTool) continue;
      const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
      const mid = meta?.id || '';
      if (!wantedHash || !mid.includes(wantedHash)) continue;
      const id = getId(s);
      if (claimed.has(id)) continue;
      return id;
    }

    log('inserting AMOA Pine study for', metric, 'unit=', unit, 'kind=', kind);
    const insertPromise = (async () => {
      const before = new Set(model.dataSources().map(getId));
      let result, err;
      try {
        result = await w.insertStudy(
          { type: 'pine', pineId: kindDef.pineId, pineVersion: kindDef.pineVersion },
          []
        );
      } catch (e) { err = e?.message || String(e); }
      if (err) { log('insertStudy threw', err); return null; }
      if (!result) { log('insertStudy returned null (Pine)'); return null; }
      if (stillCurrent && !stillCurrent()) return null;

      const wantedHash = (kindDef.pineId.match(/(USER|PUB);[a-f0-9]+/i) || [])[0];
      let src = null;
      for (let i = 0; i < 40; i++) {
        const sources = model.dataSources();
        src = sources.find((s) => {
          if (before.has(getId(s))) return false;
          const m = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
          return (m?.id || '').includes(wantedHash);
        });
        if (src) break;
        await new Promise(r => setTimeout(r, 50));
      }
      if (!src) return null;
      return getId(src);
    })();
    studyInsertInFlight.set(unit, insertPromise);
    return await insertPromise.finally(() => studyInsertInFlight.delete(unit));
  }

  // Look up to 1s for any AMOA source on the chart. First unclaimed wins;
  // if all are claimed, we don't hijack — returning null makes us fall
  // through to insertStudy for another copy.
  async function findClaimableAmoaSource(model, metric, unit, label, color, stillCurrent) {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (stillCurrent && !stillCurrent()) return null;
      const claimed = new Set([...studiesByUnit.values()]);
      for (const s of model.dataSources()) {
        if (!s || s.isLineTool) continue;
        const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s._metaInfo;
        if (!meta?.description?.startsWith(AMOA_STUDY_DESC_PREFIX)) continue;
        const id = String(s._id?.value?.() ?? s._id);
        if (claimed.has(id)) continue;
        studiesByMetric.set(metric, id);
        studiesByUnit.set(unit, id);
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
    if (!src) return;
    // Rename the study so the plot legend reads the metric label instead
    // of just "AMOA". The legend text is driven by metaInfo.description,
    // so mutate both the cached copy and the version returned by the
    // metaInfo() method (some code paths call one, some the other).
    try {
      if (src._metaInfo) src._metaInfo.description = label;
      if (src._metaInfo) src._metaInfo.shortDescription = label;
      const m = typeof src.metaInfo === 'function' ? src.metaInfo() : null;
      if (m) { m.description = label; m.shortDescription = label; }
    } catch (_) {}
    if (src._properties) {
      try { src._properties.title?.setValue?.(label); } catch (_) {}
      try { src._properties.description?.setValue?.(label); } catch (_) {}
      // The Pine defines the plot as fully transparent; make our plot
      // visible in the metric's color. Property path is styles.plot_0.color.
      try {
        const styles = src._properties.styles;
        const plot0 = styles?.plot_0 || styles?.childs?.().plot_0;
        const colorProp = plot0?.color || plot0?.childs?.().color;
        colorProp?.setValue?.(color);
      } catch (_) {}
    }
    // Poke the study to re-render its legend now that description changed.
    try { src.updateAllViews?.(); } catch (_) {}
  }

  // Rebuild the study's plot list from every metric currently hosted in
  // its slots. Each row is [time_sec, ...slot_values]. Bars where a slot's
  // metric has no data get null in that position — TradingView renders
  // gaps in the line rather than plotting through them.
  // TV clears our custom study data whenever the user hides + re-shows the
  // study (its hide/show flow re-fetches server-side plot rows, wiping our
  // frozen writes). Instead of hooking the visibility WatchedValue (which
  // put us inside TV's fire chain and caused unrelated apply-of-undefined
  // errors), poll the study's data length. If it goes empty while we still
  // have overlay data in memory, re-push.
  let visibilityWatcher = null;
  function installVisibilityGuard(model, record) {
    if (visibilityWatcher) return; // one shared poll covers every study
    visibilityWatcher = setInterval(() => {
      // History-extension sync — TV lazy-loads older candles on zoom/
      // scroll-out. Points whose times mapped off-chart when we pushed
      // become mappable, so re-push every study. This also re-anchors the
      // outlier band on the now-wider candle range.
      try {
        const firstIdxNow = model.mainSeries?.()?.bars?.()?.firstIndex?.();
        if (Number.isFinite(firstIdxNow) && firstIdxNow !== histFirstIndex) {
          const extended = histFirstIndex != null && firstIdxNow < histFirstIndex;
          histFirstIndex = firstIdxNow;
          if (extended) {
            const ts = model.timeScale?.();
            for (const r of studyByUnit.values()) {
              const src = model.dataSourceForId(r.sourceId);
              if (!src || !ts || !r.dataByMetric.size) continue;
              const n = pushCombinedDataToStudy(src, r, ts);
              wakePlotRenderers(model, src, r);
              log('history extended — re-pushed', n, 'points to AMOA', r.unit);
            }
          }
        }
      } catch (_) {}

      // View-anchored outlier re-filter — zoom/pan moves the highest and
      // lowest visible close, so the band shifts and points near its edge
      // should appear/disappear. Re-push when it moved meaningfully.
      try {
        for (const r of studyByUnit.values()) {
          if (r.kind !== 'ohlc' || !r.excludeOutliers || !r.dataByMetric.size) continue;
          const src = model.dataSourceForId(r.sourceId);
          if (!src) continue;
          const band = outlierBand(model);
          if (!band) continue;
          const prev = r._lastBand;
          const moved = !prev
            || Math.abs(band.lo - prev.lo) > Math.abs(prev.lo) * 0.001
            || Math.abs(band.hi - prev.hi) > Math.abs(prev.hi) * 0.001;
          if (!moved) continue;
          const tsNow = model.timeScale?.();
          if (!tsNow) continue;
          pushCombinedDataToStudy(src, r, tsNow);
          wakePlotRenderers(model, src, r);
        }
      } catch (_) {}

      // User-deleted study detection: if a claimed source no longer
      // resolves, the user removed it from the chart (right-click →
      // Remove on the AMOA legend entry, or removed the whole pane).
      // Drop our record + notify content.js to purge those overlays.
      for (const [unit, r] of [...studyByUnit.entries()]) {
        if (model.dataSourceForId(r.sourceId)) continue;
        const affectedMetrics = [...r.slotByMetric.keys()];
        log('AMOA', unit, 'study removed from chart — dropping', affectedMetrics.length, 'metrics');
        studyByUnit.delete(unit);
        for (const m of affectedMetrics) studiesByMetric.delete(m);
        if (affectedMetrics.length) {
          window.postMessage({
            tag: PAGE_TAG, dir: 'page->bg',
            type: 'studyRemoved', metrics: affectedMetrics,
          }, '*');
        }
      }

      for (const r of studyByUnit.values()) {
        const src = model.dataSourceForId(r.sourceId);
        if (!src) continue;

        // Visibility sync — mirror TV's hide state onto our overlay eye
        // icons. Two independent signals combined:
        //   • study-level:  src._properties.visible is false when the user
        //                   clicked the eye next to the study name (whole
        //                   indicator hidden).
        //   • per-plot:     styles.plot_N.display === 0 when the user hid
        //                   just one plot inside the study.
        // A metric is effectively visible only if BOTH are on. Fire
        // plotVisibilityChanged whenever the combined state flips.
        const studyVisible = src._properties?.visible?.value?.() ?? true;
        const styles = src._properties?.styles;
        const stylesChilds = typeof styles?.childs === 'function' ? styles.childs() : styles;
        if (!r._prevPlotVisible) r._prevPlotVisible = new Map();
        for (const [metric, slot] of r.slotByMetric.entries()) {
          const plot = stylesChilds?.[`plot_${slot}`];
          const plotChilds = typeof plot?.childs === 'function' ? plot.childs() : plot;
          const display = plotChilds?.display?.value?.();
          const plotShown = display == null ? true : display !== 0;
          const effectiveVisible = studyVisible && plotShown;
          const prev = r._prevPlotVisible.get(metric);
          if (prev !== undefined && prev !== effectiveVisible) {
            window.postMessage({
              tag: PAGE_TAG, dir: 'page->bg',
              type: 'plotVisibilityChanged',
              metric, visible: effectiveVisible,
            }, '*');
          }
          r._prevPlotVisible.set(metric, effectiveVisible);

          // Color sync — if the user recolored this plot via TV's study
          // settings dialog, persist the pick so redraws keep it instead
          // of stomping back to the palette color. _appliedColor tracks
          // what WE last wrote (applyAmoaSlotStyling), so any drift means
          // the user changed it.
          const observedColor = plotChilds?.color?.value?.();
          const appliedColor = r._appliedColor?.get(metric);
          if (observedColor && appliedColor && observedColor !== appliedColor) {
            r._appliedColor.set(metric, observedColor);
            window.postMessage({
              tag: PAGE_TAG, dir: 'page->bg',
              type: 'plotColorChanged', metric, color: observedColor,
            }, '*');
          }
        }

        // Data-cleared recovery (existing) — TV wipes the SortedMap on
        // whole-study hide+show, so replay from cache. Only when the last
        // push actually added rows: a push can legitimately land 0 (every
        // point outlier-filtered or off-chart), and re-pushing then would
        // just produce 0 again — an infinite 500ms filter/re-push loop.
        if (!r.dataByMetric.size) continue;
        const size = src.data?.()?.size?.();
        if (size === 0 && r._lastPushedCount !== 0) {
          const ts = model.timeScale?.();
          if (!ts) continue;
          const n = pushCombinedDataToStudy(src, r, ts);
          wakePlotRenderers(model, src, r);
          log('re-pushed', n, 'points to AMOA', r.unit, 'after data cleared');
        }
      }
    }, 500);
  }

  // Kick TV's plot renderers into repainting a study whose data changed
  // underneath them. The Circles renderer caches painted dots and ignores
  // rows prepended by a history-extension re-push; the display-bitmask
  // dance (0 → show-everywhere) forces it to rebuild — same trick as
  // applyAmoaSlotStyling. Slots the user hid (display 0) stay hidden.
  // Both steps are synchronous, so the visibility watcher never sees the
  // transient 0. Follow with the model-level updateSource invalidation so
  // the pane repaints the extended region.
  function wakePlotRenderers(model, src, record) {
    const styles = src._properties?.styles;
    const sc = typeof styles?.childs === 'function' ? styles.childs() : styles;
    for (const slot of record.slotByMetric.values()) {
      const plot = sc?.[`plot_${slot}`];
      const pc = typeof plot?.childs === 'function' ? plot.childs() : plot;
      if (pc?.display?.value?.() === 0) continue; // hidden — leave it
      try {
        pc?.display?.setValue?.(0);
        pc?.display?.setValue?.(0xFFFFFFFF);
      } catch (_) {}
    }
    try { model.m_model?.updateSource?.(src); } catch (_) {}
  }

  function pushCombinedDataToStudy(src, record, ts) {
    const data = src.data();
    const byTime = new Map();
    const width = 1 + record.numSlots;
    const wantsZeroLine = SIGNED_UNITS.has(record.unit) && record.zeroSlot != null;
    // Outlier band for price-axis (ohlc-kind) studies, recomputed on every
    // push so it tracks the currently-loaded candle range (zooming out
    // loads more history and widens the anchor).
    // Outlier band for price-axis (ohlc-kind) studies — anchored to the
    // closes in view, re-evaluated on every push so it follows zoom/pan
    // and history loads. Remembered on the record so the watcher can
    // detect when the view moved enough to need a re-filter.
    const mainBars = activeModel()?.mainSeries?.()?.bars?.();
    const band = record.kind === 'ohlc' && record.excludeOutliers
      ? outlierBand(activeModel()) : null;
    record._lastBand = band;
    // timePointToIndex CLAMPS times older than the first loaded bar onto
    // that bar's index — dozens of pre-history points would pile up on the
    // leftmost bar, overwriting each other with wrong data. Skip them;
    // the history-extension re-push maps them once their bars load.
    let minTime = -Infinity;
    try {
      const firstBar = mainBars?.first?.();
      if (Number.isFinite(firstBar?.value?.[0])) minTime = firstBar.value[0];
    } catch (_) {}
    let outliers = 0, preHistory = 0;
    for (const [metric, points] of record.dataByMetric.entries()) {
      const slot = record.slotByMetric.get(metric);
      if (slot == null) continue;
      for (const p of points) {
        if (p.time < minTime) { preHistory++; continue; }
        if (band && Number.isFinite(p.value) && (p.value < band.lo || p.value > band.hi)) { outliers++; continue; }
        let row = byTime.get(p.time);
        if (!row) {
          row = new Array(width).fill(null);
          row[0] = p.time;
          if (wantsZeroLine) row[1 + record.zeroSlot] = 0;
          byTime.set(p.time, row);
        }
        row[1 + slot] = p.value;
      }
    }
    // Convert to (barIndex, row) entries, sorted by index. Values are
    // daily, so each row covers [its day's first bar, next day's first
    // bar): on a daily chart that's exactly one bar; on intraday charts
    // it fills every bar of the session so a 5m chart shows the level
    // across the whole day instead of one lone dot.
    const DAY = 86400;
    const rows = [];
    for (const row of byTime.values()) {
      const idx = ts.timePointToIndex(row[0], true);
      if (!Number.isFinite(idx)) continue;
      let idxEnd = ts.timePointToIndex(row[0] + DAY, true);
      if (!Number.isFinite(idxEnd) || idxEnd <= idx) idxEnd = idx + 1;
      rows.push({ idx, idxEnd, row });
    }
    rows.sort((a, b) => a.idx - b.idx);

    data._shareRead = false;
    data.clear();
    let added = 0;
    for (let i = 0; i < rows.length; i++) {
      const { idx, idxEnd, row } = rows[i];
      const next = rows[i + 1];
      // Fill the day, but never past the next row's start (day boundaries
      // can clamp oddly around weekends). Future rows extrapolate into the
      // right margin on purpose — strike trails run out to expiration.
      const end = Math.min(idxEnd, next ? next.idx : idxEnd);
      for (let j = idx; j === idx || j < end; j++) {
        if (data.add(j, row) !== false) added++;
      }
    }
    data._shareRead = true;
    // Watcher's data-cleared recovery keys off this: size 0 with a
    // last-push of 0 is an intentionally-empty study, not a TV wipe.
    record._lastPushedCount = added;
    if (outliers) {
      log('excluded', outliers, 'outlier point(s) from AMOA', record.unit,
          'study — outside view band [' + band.lo.toFixed(2) + ', ' + band.hi.toFixed(2) + ']');
    }
    if (preHistory) {
      log('deferred', preHistory, 'point(s) older than the loaded candles for AMOA', record.unit,
          '— they map in as more history loads');
    }
    try { src._invalidateLastNonEmptyPlotRowCache?.(); } catch (_) {}
    // Force TV's study-view pipeline to re-render from the mutated data.
    // Without this, clear+re-add on the SortedMap changes the data but
    // the plot on-screen doesn't repaint — a hidden slot's dots/line
    // will linger until the study is fully removed. `updateAllViews()`
    // throws on our Pine-hijacked study; `onDataUpdated()` is the one
    // that actually drives a redraw.
    try { src.onDataUpdated?.(); } catch (_) {}
    return added;
  }

  // Style a specific slot of the shared study: set its title to the metric
  // label and its color to the metric's assigned overlay color.
  function applyAmoaSlotStyling(src, record, metric, label, color, hidden) {
    if (!src) return;
    const slot = record.slotByMetric.get(metric);
    if (slot == null) return;
    const plotId = `plot_${slot}`;

    // Color for the metric plot (the settings/customization tree).
    const styles = src._properties?.styles;
    const plotProps = styles?.[plotId] || styles?.childs?.()?.[plotId];
    try { plotProps?.color?.setValue?.(color); } catch (_) {}
    // Remember what we wrote so the visibility watcher can tell our own
    // writes apart from a user recolor in TV's settings dialog.
    if (!record._appliedColor) record._appliedColor = new Map();
    record._appliedColor.set(metric, color);
    // Force the plot renderer to re-initialize by dancing the display
    // bitmask: 0 (hide) → 0xFFFFFFFF (show everywhere). A single transition
    // from a previously-hidden state doesn't reliably wake up the OHLC
    // circle renderer — the dance does. Both steps are synchronous, so
    // the 500ms visibility watcher never observes the transient `0`.
    // Skipped for hidden metrics — the dance would flip a TV-hidden plot
    // back on; drawViaStudyHijack handles their display bit instead.
    if (!hidden) {
      try { plotProps?.display?.setValue?.(0); } catch (_) {}
      try { plotProps?.display?.setValue?.(0xFFFFFFFF); } catch (_) {}
    }
    // For the OHLC (right-axis) kind, override the plot style to circles
    // so each snapshot renders as a discrete dot instead of connecting via
    // diagonals across strike jumps. TV's PlotStyle enum values:
    //   Line=0, Histogram=1, Cross=3, Area=4, Columns=5, Circles=6,
    //   LineWithBreaks=7, StepLine=9, StepLineWithBreaks=11.
    if (record.kind === 'ohlc') {
      try { plotProps?.plottype?.setValue?.(6); } catch (_) {}
      try { plotProps?.linewidth?.setValue?.(3); } catch (_) {}
    }

    // Title lives in _metaInfo.value().styles[plotId].title — that's what
    // TV's guiPlotName reads to build the legend row. Mutate then nudge
    // the WatchedValue so the legend recomputes.
    try {
      const metaWv = src._metaInfo;
      const meta = typeof metaWv?.value === 'function' ? metaWv.value() : metaWv;
      if (meta?.styles?.[plotId]) meta.styles[plotId].title = label;
      // Also label the reserved zero-line plot (last slot) so it reads
      // clearly in the legend instead of the Pine default ("data 5" etc.).
      if (record.zeroSlot != null) {
        const zeroPlotId = `plot_${record.zeroSlot}`;
        if (meta?.styles?.[zeroPlotId]) meta.styles[zeroPlotId].title = 'zero';
      }
      if (typeof metaWv?.fireChanged === 'function') metaWv.fireChanged();
      else if (typeof metaWv?.setValue === 'function') metaWv.setValue(meta);
    } catch (_) {}
    try { src.updateAllViews?.(); } catch (_) {}
  }

  function removeStudyForMetric(metric) {
    const id = studiesByMetric.get(metric);
    if (!id) return false;
    studiesByMetric.delete(metric);
    // Locate the unit record and free this metric's slot.
    let ownerUnit = null, ownerRecord = null;
    for (const [u, r] of studyByUnit.entries()) {
      if (r.sourceId === id) { ownerUnit = u; ownerRecord = r; break; }
    }
    if (!ownerRecord) return true;
    const freedSlot = ownerRecord.slotByMetric.get(metric);
    ownerRecord.slotByMetric.delete(metric);
    ownerRecord.dataByMetric.delete(metric);
    // Drop the visibility-watcher's cache entries too so a later slot
    // re-claim doesn't fire a spurious plotVisibilityChanged /
    // plotColorChanged when applyAmoaSlotStyling resets the plot.
    ownerRecord._prevPlotVisible?.delete?.(metric);
    ownerRecord._appliedColor?.delete?.(metric);
    // Re-push so the removed metric's line disappears immediately.
    const model = activeModel();
    if (model) {
      const src = model.dataSourceForId(id);
      const ts = model.timeScale?.();
      // Hide the freed plot in TV's UI. Nulling the data + onDataUpdated
      // isn't enough for the circle-plot renderer to drop its cached dots
      // — flipping the plot's display bitmask to 0 forces TV to stop
      // painting the slot. applyAmoaSlotStyling resets it to 0xFFFFFFFF
      // when a metric later reclaims the slot.
      if (src && freedSlot != null) {
        try {
          const styles = src._properties?.styles;
          const plot = styles?.[`plot_${freedSlot}`] || styles?.childs?.()?.[`plot_${freedSlot}`];
          plot?.display?.setValue?.(0);
        } catch (_) {}
      }
      if (src && ts && ownerRecord.slotByMetric.size > 0) {
        pushCombinedDataToStudy(src, ownerRecord, ts);
      } else if (src && ownerRecord.slotByMetric.size === 0) {
        // No metrics left on this study — remove it entirely.
        try { model.removeSource(src); } catch (_) {}
        studyByUnit.delete(ownerUnit);
      }
    }
    return true;
  }

  function removeAllHijackStudies() {
    const model = activeModel();
    if (model) {
      for (const r of studyByUnit.values()) {
        const src = model.dataSourceForId(r.sourceId);
        if (src) { try { model.removeSource(src); } catch (_) {} }
      }
    }
    studyByUnit.clear();
    studiesByMetric.clear();
  }

  // Every draw we make carries a linkKey with our prefix. On teardown we
  // sweep every line-tool source on the chart by prefix / metric — so
  // orphans from a previous tab session (before the in-memory
  // drawingsByMetric map existed) also get nuked, not just what we tracked.
  function sweepByLinkKey(matches) {
    const model = activeModel();
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

  // Symbol-change / redraw reset. Line tools are anchored to the old
  // symbol's bars, so they always go. The hijack studies stay on the chart
  // with their data blanked: removing + reinserting them (clearAllOverlays)
  // would wipe TV's own hide/eye state, so a hidden indicator came back as
  // "nothing drawn" after a chart switch. The next drawSeries batch just
  // replaces the data in place; slot assignments and colors stay stable.
  function softClearOverlays() {
    const removed = sweepByLinkKey(k => k.startsWith(LINK_KEY_PREFIX));
    drawingsByMetric.clear();
    const model = activeModel();
    let blanked = 0;
    for (const r of studyByUnit.values()) {
      r.dataByMetric.clear();
      const src = model?.dataSourceForId(r.sourceId);
      if (!src) continue;
      try {
        const data = src.data();
        data._shareRead = false;
        data.clear();
        data._shareRead = true;
        src._invalidateLastNonEmptyPlotRowCache?.();
        src.onDataUpdated?.();
        blanked++;
      } catch (_) {}
    }
    log('soft-cleared', removed, 'drawings, blanked', blanked, 'studies (kept on chart)');
  }
})();
