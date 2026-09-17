'use strict';

/** Round a maximum up to a clean axis top: 1,000 / 2,500 / 5,000 and so on. */
function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const step = [1, 2, 2.5, 4, 5, 6, 8, 10].find((s) => value <= s * magnitude) || 10;
  return step * magnitude;
}

/** Evenly spaced axis ticks, always including zero and the top. */
function ticks(max, count = 4) {
  const top = niceMax(max);
  return Array.from({ length: count + 1 }, (_, i) => (top / count) * i);
}

/**
 * Columns growing from a single baseline.
 * Bars are capped at 24px so a sparse chart keeps air around its marks, and a
 * 2px gap in the surface colour separates neighbours rather than a stroke.
 */
function columns(values, { width, height, padLeft = 54, padBottom = 26, padTop = 14, maxBar = 24, gap = 2 }) {
  const top = niceMax(Math.max(0, ...values.map((v) => v.value)));
  const plotW = width - padLeft - 8;
  const plotH = height - padBottom - padTop;
  const band = values.length ? plotW / values.length : plotW;
  const barW = Math.min(maxBar, Math.max(4, band - gap * 2 - 8));

  return {
    top,
    ticks: ticks(top).map((t) => ({ value: t, y: padTop + plotH - (t / top) * plotH })),
    baseline: padTop + plotH,
    plotW,
    bars: values.map((v, i) => {
      const h = top > 0 ? (v.value / top) * plotH : 0;
      return {
        ...v,
        x: padLeft + band * i + (band - barW) / 2,
        y: padTop + plotH - h,
        w: barW,
        h: Math.max(v.value > 0 ? 2 : 0, h)
      };
    })
  };
}

/** Horizontal bars, longest first, with the value at the tip. */
function bars(values, { width, labelW = 130, rowH = 30, barH = 16, padRight = 92 }) {
  const top = niceMax(Math.max(0, ...values.map((v) => v.value)));
  const plotW = width - labelW - padRight;
  return {
    top,
    height: values.length * rowH,
    rows: values.map((v, i) => ({
      ...v,
      y: i * rowH + (rowH - barH) / 2,
      w: top > 0 ? Math.max(v.value > 0 ? 2 : 0, (v.value / top) * plotW) : 0,
      h: barH,
      labelW,
      textY: i * rowH + rowH / 2
    }))
  };
}

/** One stacked bar showing what a total is made of. */
function stack(parts, { width, height = 26, gap = 2 }) {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  if (total <= 0) return { total: 0, segments: [] };

  let x = 0;
  const segments = [];
  parts.forEach((part, i) => {
    if (part.value <= 0) return;
    const w = (part.value / total) * width;
    segments.push({
      ...part,
      x,
      // The gap is taken from the segment, so the row still spans the full width.
      w: Math.max(1, w - (i < parts.length - 1 ? gap : 0)),
      h: height,
      share: part.value / total
    });
    x += w;
  });
  return { total, segments };
}

module.exports = { niceMax, ticks, columns, bars, stack };
