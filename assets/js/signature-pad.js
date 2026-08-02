/* ============================================================================
   SignaturePad — рукописная подпись пальцем / стилусом / мышью на <canvas>.
   Ноль зависимостей, classic script (работает и по file://), UMD-обёртка.

   Три решения, из-за которых компонент выглядит «как в проде»:
   1. Точки хранятся в CSS-пикселях, а не в пикселях канваса → экспорт, replay
      и resize не зависят от devicePixelRatio и от размера экрана.
   2. Толщина линии берётся из скорости (мышь/палец) или из давления (стилус) —
      без этого подпись выглядит как рисунок в Paint.
   3. Линейка/подложка НИКОГДА не рисуются на canvas — они попали бы в экспорт.
      Рисуй их в CSS под прозрачным канвасом.

   API:
     const pad = new SignaturePad(canvasEl, { penColor, minWidth, maxWidth, ... })
     pad.isEmpty() / pad.clear() / pad.undo()
     pad.toDataURL('image/png', { trim: true, background: '#fff' })
     pad.toBlob(cb, 'image/png', opts)         → для FormData/fetch
     pad.toSVG({ trim: true })                 → вектор для PDF/печати
     pad.toJSON() / pad.fromJSON(data)         → аудиторский след, replay
     pad.replay({ speed: 1 })                  → анимация написания
     pad.resize() / pad.on() / pad.off() / pad.destroy()
   ============================================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else root.SignaturePad = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    penColor: '#12161F',
    minWidth: 0.8,           // CSS px
    maxWidth: 2.8,
    velocityFilterWeight: 0.7,
    pressureSensitive: true, // применяется только к pointerType === 'pen'
    autoResize: true,
    onBegin: null,
    onEnd: null,
    onChange: null           // вызывается после любого изменения содержимого
  };

  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var mid = function (a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  var qbez = function (p0, p1, p2, t) {
    var u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
  };

  function widthState(o) {
    return { lastV: 0, lastW: (o.minWidth + o.maxWidth) / 2 };
  }

  // Одна точка → одна толщина. Общая для живого рисования и для перерисовки,
  // иначе штрих «прыгал» бы после undo/resize.
  function nextWidth(st, a, b, o, pen) {
    var w;
    if (pen && o.pressureSensitive && b.p > 0) {
      w = o.minWidth + (o.maxWidth - o.minWidth) * Math.min(1, b.p);
    } else {
      var dt = Math.max(b.t - a.t, 1);
      var v = Math.hypot(b.x - a.x, b.y - a.y) / dt;   // CSS px / ms
      st.lastV = o.velocityFilterWeight * v + (1 - o.velocityFilterWeight) * st.lastV;
      w = Math.max(o.maxWidth / (st.lastV * 2.2 + 1), o.minWidth);
    }
    st.lastW = w * 0.55 + st.lastW * 0.45;  // сглаживаем скачки толщины
    return st.lastW;
  }

  function computeWidths(points, o, pen) {
    var st = widthState(o), out = [st.lastW], i;
    for (i = 1; i < points.length; i++) out.push(nextWidth(st, points[i - 1], points[i], o, pen));
    return out;
  }

  function SignaturePad(canvas, options) {
    if (!canvas) throw new Error('SignaturePad: нужен <canvas>');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = Object.assign({}, DEFAULTS, options || {});

    this._strokes = [];
    this._active = null;
    this._pointerId = null;
    this._bbox = null;
    this._rect = null;
    this._startedAt = null;
    this._endedAt = null;
    this._raf = null;
    this._enabled = false;
    this._cssW = 0; this._cssH = 0; this._dpr = 0;

    canvas.style.touchAction = 'none';      // без этого палец скроллит страницу
    canvas.style.userSelect = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.webkitTapHighlightColor = 'transparent';

    this._onDown = this._handleDown.bind(this);
    this._onMove = this._handleMove.bind(this);
    this._onUp = this._handleUp.bind(this);
    this._onCtx = function (e) { e.preventDefault(); };

    this.on();
    this.resize(true);

    if (this.options.autoResize && typeof ResizeObserver !== 'undefined') {
      var self = this;
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(canvas);
    }
  }

  /* ---------- жизненный цикл ---------------------------------------- */

  SignaturePad.prototype.on = function () {
    if (this._enabled) return this;
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    this.canvas.addEventListener('contextmenu', this._onCtx);
    this._enabled = true;
    return this;
  };

  SignaturePad.prototype.off = function () {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('contextmenu', this._onCtx);
    this._enabled = false;
    return this;
  };

  SignaturePad.prototype.destroy = function () {
    this.off();
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  };

  // Канвас всегда рисуется в физических пикселях устройства, иначе на телефоне
  // подпись мыльная. Штрихи при смене ширины масштабируются пропорционально.
  SignaturePad.prototype.resize = function (force) {
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var rect = this.canvas.getBoundingClientRect();
    var cssW = Math.round(rect.width), cssH = Math.round(rect.height);
    if (!cssW || !cssH) return this;
    if (!force && cssW === this._cssW && cssH === this._cssH && dpr === this._dpr) return this;

    if (this._cssW && cssW !== this._cssW) {
      var k = cssW / this._cssW;
      this._strokes.forEach(function (s) {
        s.points.forEach(function (p) { p.x *= k; p.y *= k; });
      });
    }

    this._cssW = cssW; this._cssH = cssH; this._dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // после смены width трансформ сбрасывается
    this._redraw();
    return this;
  };

  /* ---------- ввод ---------------------------------------------------- */

  SignaturePad.prototype._point = function (e) {
    var r = this._rect || this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      t: Math.round(e.timeStamp || performance.now()),
      p: typeof e.pressure === 'number' ? e.pressure : 0
    };
  };

  SignaturePad.prototype._handleDown = function (e) {
    if (this._pointerId !== null) return;                    // мультитач игнорируем
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    this._pointerId = e.pointerId;
    this._rect = this.canvas.getBoundingClientRect();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}

    this._active = {
      color: this.options.penColor,
      pen: e.pointerType === 'pen',
      points: [],
      widths: []
    };
    this._wstate = widthState(this.options);
    this._strokes.push(this._active);
    if (!this._startedAt) this._startedAt = Date.now();

    this._addPoint(e);
    if (this.options.onBegin) this.options.onBegin(e, this);
  };

  SignaturePad.prototype._handleMove = function (e) {
    if (this._pointerId !== e.pointerId || !this._active) return;
    e.preventDefault();
    // Стилус/высокочастотный тач отдают несколько точек на кадр — берём все,
    // линия получается заметно глаже.
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    for (var i = 0; i < evs.length; i++) this._addPoint(evs[i]);
  };

  SignaturePad.prototype._handleUp = function (e) {
    if (this._pointerId !== e.pointerId) return;
    e.preventDefault();
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    this._pointerId = null;

    var s = this._active;
    this._active = null;
    this._endedAt = Date.now();
    if (s && s.points.length > 1) this._tail(s.points, s.widths, s.color);
    if (this.options.onEnd) this.options.onEnd(e, this);
    this._changed();
  };

  SignaturePad.prototype._addPoint = function (ev) {
    var s = this._active;
    if (!s) return;
    var p = this._point(ev);
    var pts = s.points;
    var last = pts[pts.length - 1];
    if (last && Math.abs(p.x - last.x) < 0.35 && Math.abs(p.y - last.y) < 0.35) return; // дрожание

    pts.push(p);
    var w = pts.length === 1
      ? this._wstate.lastW
      : nextWidth(this._wstate, last, p, this.options, s.pen);
    s.widths.push(w);
    this._grow(p, w);

    if (pts.length === 1) this._dot(p, w, s.color);
    else this._segment(pts, s.widths, pts.length - 1, s.color);
  };

  /* ---------- рисование ----------------------------------------------- */

  SignaturePad.prototype._prep = function (color) {
    var c = this.ctx;
    c.strokeStyle = color; c.fillStyle = color;
    c.lineCap = 'round'; c.lineJoin = 'round';
  };

  SignaturePad.prototype._dot = function (p, w, color) {
    this._prep(color);
    this.ctx.beginPath();
    this.ctx.arc(p.x, p.y, Math.max(w, this.options.minWidth) / 2, 0, Math.PI * 2);
    this.ctx.fill();
  };

  SignaturePad.prototype._line = function (a, b, w, color) {
    this._prep(color);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.lineWidth = w;
    this.ctx.stroke();
  };

  // Квадратичная кривая между серединами соседних отрезков (контрольная точка —
  // сама точка p1). Ширина lineWidth не умеет меняться вдоль пути, поэтому
  // кривая нарезается на мелкие отрезки с интерполяцией толщины.
  SignaturePad.prototype._curve = function (p0, p1, p2, w1, w2, color) {
    var m1 = mid(p0, p1), m2 = mid(p1, p2);
    var len = Math.hypot(m2.x - m1.x, m2.y - m1.y);
    var steps = Math.max(2, Math.min(24, Math.ceil(len / 2)));
    var c = this.ctx, px = m1.x, py = m1.y, i, t, x, y;
    this._prep(color);
    for (i = 1; i <= steps; i++) {
      t = i / steps;
      x = qbez(m1.x, p1.x, m2.x, t);
      y = qbez(m1.y, p1.y, m2.y, t);
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(x, y);
      c.lineWidth = w1 + (w2 - w1) * t;
      c.stroke();
      px = x; py = y;
    }
  };

  SignaturePad.prototype._segment = function (pts, ws, i, color) {
    if (i === 1) this._line(pts[0], mid(pts[0], pts[1]), ws[1], color);
    else this._curve(pts[i - 2], pts[i - 1], pts[i], ws[i - 1], ws[i], color);
  };

  // Хвост: от последней середины до последней точки — иначе штрих не дотянут.
  SignaturePad.prototype._tail = function (pts, ws, color) {
    var n = pts.length;
    if (n < 2) return;
    this._line(mid(pts[n - 2], pts[n - 1]), pts[n - 1], ws[n - 1], color);
  };

  SignaturePad.prototype._renderStroke = function (s) {
    var pts = s.points;
    s.widths = computeWidths(pts, this.options, s.pen);
    if (!pts.length) return;
    // Точка-«капля» в начале штриха рисуется и здесь тоже — иначе после undo /
    // resize / fromJSON начало штриха становится тоньше, чем было при вводе.
    this._dot(pts[0], s.widths[0], s.color);
    if (pts.length === 1) return;
    for (var i = 1; i < pts.length; i++) this._segment(pts, s.widths, i, s.color);
    this._tail(pts, s.widths, s.color);
  };

  SignaturePad.prototype._clearCanvas = function () {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  };

  SignaturePad.prototype._redraw = function () {
    this._clearCanvas();
    this._bbox = null;
    var self = this;
    this._strokes.forEach(function (s) {
      self._renderStroke(s);
      s.points.forEach(function (p, i) { self._grow(p, s.widths[i] || self.options.maxWidth); });
    });
  };

  SignaturePad.prototype._grow = function (p, w) {
    var r = (w || this.options.maxWidth) / 2 + 1;
    if (!this._bbox) this._bbox = { minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r };
    else {
      var b = this._bbox;
      if (p.x - r < b.minX) b.minX = p.x - r;
      if (p.y - r < b.minY) b.minY = p.y - r;
      if (p.x + r > b.maxX) b.maxX = p.x + r;
      if (p.y + r > b.maxY) b.maxY = p.y + r;
    }
  };

  SignaturePad.prototype._changed = function () {
    if (this.options.onChange) this.options.onChange(this);
  };

  /* ---------- команды -------------------------------------------------- */

  SignaturePad.prototype.isEmpty = function () { return this._strokes.length === 0; };
  SignaturePad.prototype.strokeCount = function () { return this._strokes.length; };
  SignaturePad.prototype.pointCount = function () {
    return this._strokes.reduce(function (n, s) { return n + s.points.length; }, 0);
  };

  SignaturePad.prototype.clear = function () {
    this._strokes = [];
    this._active = null;
    this._startedAt = null;
    this._endedAt = null;
    this._redraw();
    this._changed();
    return this;
  };

  SignaturePad.prototype.undo = function () {
    if (!this._strokes.length) return this;
    this._strokes.pop();
    this._redraw();
    this._changed();
    return this;
  };

  SignaturePad.prototype.setPenColor = function (c) { this.options.penColor = c; return this; };
  SignaturePad.prototype.setWidths = function (min, max) {
    this.options.minWidth = min; this.options.maxWidth = max;
    this._redraw();
    return this;
  };

  /* ---------- экспорт --------------------------------------------------- */

  // trim обрезает пустые поля по реальным границам чернил — подпись на 20% холста
  // не должна уезжать в PDF как картинка с гигантскими полями.
  SignaturePad.prototype._export = function (opts) {
    var o = Object.assign({ trim: false, padding: 8, background: null, scale: null }, opts || {});
    var dpr = this._dpr || 1;
    var sx = 0, sy = 0, sw = this._cssW, sh = this._cssH;

    if (o.trim && this._bbox) {
      sx = Math.max(0, this._bbox.minX - o.padding);
      sy = Math.max(0, this._bbox.minY - o.padding);
      sw = Math.min(this._cssW, this._bbox.maxX + o.padding) - sx;
      sh = Math.min(this._cssH, this._bbox.maxY + o.padding) - sy;
    }

    var out = document.createElement('canvas');
    var k = o.scale || dpr;
    out.width = Math.max(1, Math.round(sw * k));
    out.height = Math.max(1, Math.round(sh * k));
    var c = out.getContext('2d');
    if (o.background) { c.fillStyle = o.background; c.fillRect(0, 0, out.width, out.height); }
    c.drawImage(this.canvas, sx * dpr, sy * dpr, sw * dpr, sh * dpr, 0, 0, out.width, out.height);
    return out;
  };

  SignaturePad.prototype.toCanvas = function (opts) { return this._export(opts); };

  SignaturePad.prototype.toDataURL = function (type, opts) {
    opts = opts || {};
    // JPEG не умеет прозрачность — принудительно подкладываем белый.
    var bg = opts.background || (type === 'image/jpeg' ? '#ffffff' : null);
    return this._export(Object.assign({}, opts, { background: bg }))
      .toDataURL(type || 'image/png', opts.quality);
  };

  SignaturePad.prototype.toBlob = function (cb, type, opts) {
    opts = opts || {};
    var bg = opts.background || (type === 'image/jpeg' ? '#ffffff' : null);
    this._export(Object.assign({}, opts, { background: bg }))
      .toBlob(cb, type || 'image/png', opts.quality);
  };

  // Вектор для PDF/печати. Внутри штриха ширина усредняется (SVG не умеет
  // переменную толщину на одном path) — пиксель-в-пиксель отдаёт только PNG.
  SignaturePad.prototype.toSVG = function (opts) {
    var o = Object.assign({ trim: true, padding: 8, background: null }, opts || {});
    var ox = 0, oy = 0, w = this._cssW, h = this._cssH;
    if (o.trim && this._bbox) {
      ox = Math.max(0, this._bbox.minX - o.padding);
      oy = Math.max(0, this._bbox.minY - o.padding);
      w = Math.min(this._cssW, this._bbox.maxX + o.padding) - ox;
      h = Math.min(this._cssH, this._bbox.maxY + o.padding) - oy;
    }

    var self = this, parts = [];
    if (o.background) parts.push('<rect width="100%" height="100%" fill="' + o.background + '"/>');

    this._strokes.forEach(function (s) {
      var pts = s.points, n = pts.length;
      if (!n) return;
      var ws = computeWidths(pts, self.options, s.pen);
      var avg = ws.reduce(function (a, b) { return a + b; }, 0) / ws.length;

      if (n === 1) {
        parts.push('<circle cx="' + r2(pts[0].x - ox) + '" cy="' + r2(pts[0].y - oy) +
          '" r="' + r2(avg / 2) + '" fill="' + s.color + '"/>');
        return;
      }
      var d = 'M ' + r2(pts[0].x - ox) + ' ' + r2(pts[0].y - oy);
      for (var i = 1; i < n - 1; i++) {
        var m = mid(pts[i], pts[i + 1]);
        d += ' Q ' + r2(pts[i].x - ox) + ' ' + r2(pts[i].y - oy) + ' ' + r2(m.x - ox) + ' ' + r2(m.y - oy);
      }
      d += ' L ' + r2(pts[n - 1].x - ox) + ' ' + r2(pts[n - 1].y - oy);
      parts.push('<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' +
        r2(avg) + '" stroke-linecap="round" stroke-linejoin="round"/>');
    });

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + r2(w) + '" height="' + r2(h) +
      '" viewBox="0 0 ' + r2(w) + ' ' + r2(h) + '">' + parts.join('') + '</svg>';
  };

  // Векторный слепок + метаданные: это и есть аудиторский след подписи.
  SignaturePad.prototype.toJSON = function (meta) {
    return {
      version: 1,
      width: this._cssW,
      height: this._cssH,
      createdAt: new Date().toISOString(),
      durationMs: this._startedAt ? (this._endedAt || Date.now()) - this._startedAt : 0,
      strokeCount: this._strokes.length,
      pointCount: this.pointCount(),
      strokes: this._strokes.map(function (s) {
        return {
          color: s.color,
          pen: s.pen,
          points: s.points.map(function (p) { return [r2(p.x), r2(p.y), p.t, r2(p.p)]; })
        };
      }),
      meta: meta || {}
    };
  };

  SignaturePad.prototype.fromJSON = function (data, opts) {
    var o = Object.assign({ scale: true }, opts || {});
    var self = this;
    this._strokes = (data.strokes || []).map(function (s) {
      return {
        color: s.color || self.options.penColor,
        pen: !!s.pen,
        widths: [],
        points: (s.points || []).map(function (a) { return { x: a[0], y: a[1], t: a[2], p: a[3] }; })
      };
    });
    if (o.scale && data.width && this._cssW && data.width !== this._cssW) {
      var k = this._cssW / data.width;
      this._strokes.forEach(function (s) {
        s.points.forEach(function (p) { p.x *= k; p.y *= k; });
      });
    }
    this._redraw();
    this._changed();
    return this;
  };

  // Проигрывание записи: доказывает, что подпись хранится как вектор с таймингом,
  // а не как картинка. Паузы между штрихами обрезаются до 300 мс.
  SignaturePad.prototype.replay = function (opts) {
    var o = Object.assign({ speed: 1, onDone: null }, opts || {});
    var self = this;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }

    var events = [], vt = 0, prevT = null;
    this._strokes.forEach(function (s, si) {
      var ws = computeWidths(s.points, self.options, s.pen);
      s.widths = ws;
      s.points.forEach(function (p, pi) {
        if (prevT !== null) vt += Math.min(Math.max(p.t - prevT, 0), 300);
        prevT = p.t;
        events.push({ si: si, pi: pi, vt: vt });
      });
    });
    if (!events.length) { if (o.onDone) o.onDone(); return this; }

    this._clearCanvas();
    var cur = 0, start = performance.now();

    var tick = function () {
      var el = (performance.now() - start) * o.speed;
      while (cur < events.length && events[cur].vt <= el) {
        var e = events[cur], s = self._strokes[e.si];
        if (e.pi === 0) self._dot(s.points[0], s.widths[0], s.color);
        else self._segment(s.points, s.widths, e.pi, s.color);
        if (e.pi === s.points.length - 1 && s.points.length > 1) self._tail(s.points, s.widths, s.color);
        cur++;
      }
      if (cur < events.length) self._raf = requestAnimationFrame(tick);
      else { self._raf = null; if (o.onDone) o.onDone(); }
    };
    tick();
    return this;
  };

  SignaturePad.dataURLToBlob = function (dataURL) {
    var parts = dataURL.split(','), mime = parts[0].match(/:(.*?);/)[1];
    var bin = atob(parts[1]), n = bin.length, u8 = new Uint8Array(n);
    while (n--) u8[n] = bin.charCodeAt(n);
    return new Blob([u8], { type: mime });
  };

  return SignaturePad;
}));
