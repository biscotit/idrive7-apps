'use strict';

// The picture canvas of the home-screen widgets, the engine speed a stopped engine leaves, and the
// settings eDrive offers per hybrid system.
//   node kit/tools/test_widget_fixes.js

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const { Canvas, ScaledCanvas } = require(path.join(KIT, 'canvas'));
const Car = require(path.join(KIT, 'car'));

/* ---------- ScaledCanvas: the coordinates of w x h on k times the pixels ---------- */
{
    const cv = new ScaledCanvas(384, 256, 2).clear([0, 0, 0, 0]);
    assert.strictEqual(cv.canvas.w, 768);
    assert.strictEqual(cv.canvas.h, 512);
    assert.strictEqual(cv.w, 384);
    cv.fillRect(10, 20, 30, 40, [255, 0, 0, 255]);
    const at = (x, y) => cv.canvas.d[(y * 768 + x) * 4];
    assert.strictEqual(at(20, 40), 255, 'first pixel of the rect, at twice its place');
    assert.strictEqual(at(79, 119), 255, 'last pixel');
    assert.strictEqual(at(80, 120), 0, 'past it');
    const plain = new Canvas(384, 256).text('Hybrid 123', 0, 40, 20, '#fff', { font: 'bold', spacing: 1 });
    const scaled = cv.text('Hybrid 123', 0, 40, 20, '#fff', { font: 'bold', spacing: 1 });
    assert.ok(Math.abs(scaled - plain) < 2, `a text measures the same in w x h: ${scaled} and ${plain}`);
    assert.ok(Math.abs(cv.textWidth('Hybrid 123', 20) - new Canvas(384, 256).textWidth('Hybrid 123', 20)) < 2);
    ['clear', 'fillRect', 'gradientRect', 'roundRect', 'strokeRoundRect', 'card', 'rampRect', 'circle', 'arc', 'line',
        'convex', 'quad', 'triangle', 'polyline', 'fillUnder', 'drawImage', 'blit', 'text', 'textWidth', '_blit'
    ].forEach((m) => {
        assert.strictEqual(typeof Canvas.prototype[m], 'function', 'a canvas method ' + m);
        assert.strictEqual(typeof ScaledCanvas.prototype[m], 'function', 'scaled too: ' + m);
    });
}

/* ---------- engine speed: a stopped hybrid engine's last value reads as 0 ---------- */
{
    let handlers = null;
    const ctx = {
        log: { info() {}, warn() {}, error() {}, debug() {} }, spec: {}, settings: { get: () => 'off', onChange() {} },
        signals: { watch: async (iface, inst, fields) => { handlers = fields; return { error: null }; } }
    };
    const car = new Car(ctx, ['rpm']);
    const feed = (rpm) => { handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: rpm * 4 }); return car.live.rpm; };
    assert.strictEqual(feed(160), 0, '160 rpm with the engine off');
    assert.strictEqual(feed(399), 0);
    assert.strictEqual(feed(400), 400, 'the lowest that counts as running');
    assert.strictEqual(feed(750), 750, 'idle');
    assert.strictEqual(feed(6500), 6500);
    assert.strictEqual(feed(0), 0);
    if (car.stop) car.stop();
}

/* ---------- eDrive's settings per hybrid system ---------- */
{
    const spec = require(path.join(ROOT, 'apps', 'edrive', 'app.json'));
    const PHEV_ONLY = ['range20', 'reserve', 'designKwh', 'price'];
    const offered = (hybrid) => {
        const values = {};
        spec.settings.forEach((s) => { values[s.key] = s.default; });
        values.hybrid = hybrid;
        // the rule of mgu.js Settings.shown
        return spec.settings.filter((s) => !s.hidden && (!s.when || Object.keys(s.when).every((k) => [].concat(s.when[k]).indexOf(values[k]) >= 0))).map((s) => s.key);
    };
    ['yes', 'auto'].forEach((h) => PHEV_ONLY.forEach((k) => assert.ok(offered(h).includes(k), `${k} with hybrid ${h}`)));
    ['48v', 'no'].forEach((h) => {
        PHEV_ONLY.forEach((k) => assert.ok(!offered(h).includes(k), `no ${k} with hybrid ${h}`));
        ['hybrid', 'distUnit', 'tempUnit', 'gaugeKw', 'theme'].forEach((k) => assert.ok(offered(h).includes(k), `${k} stays with hybrid ${h}`));
    });
}

/* ---------- the widgets ask for twice the pixels, the size their layouts are drawn in stays ---------- */
['edrive', 'live_data'].forEach((id) => {
    const sw = require(path.join(ROOT, 'apps', id, 'app.json')).startWidget;
    assert.deepStrictEqual(sw.size, [384, 256], id);
    assert.strictEqual(sw.scale, 2, id);
});

/* ---------- a layer on a widget's picture keeps its transparency (no black square round a dial) ---------- */
{
    const L = new Canvas(10, 10);
    L.fillRect(2, 2, 6, 6, [255, 255, 255, 255]);
    L.fillRect(8, 8, 1, 1, [255, 0, 0, 128]);
    const cv = new ScaledCanvas(20, 20, 2).clear([0, 0, 0, 0]).blit(L, 0, 0);
    const a = (x, y) => cv.canvas.d[(y * 40 + x) * 4 + 3];
    assert.strictEqual(a(0, 0), 0, 'a transparent corner stays transparent');
    assert.strictEqual(a(6, 6), 255, 'an opaque pixel is copied');
    assert.ok(a(17, 17) > 0 && a(17, 17) < 255, 'a translucent one stays translucent: ' + a(17, 17));
    // through a recording, as the widget is drawn: a dial (a cached layer) leaves no opaque black
    const G = require(path.join(KIT, 'gauges')), T = require(path.join(KIT, 'themes'));
    const { Recorder, play } = require(path.join(KIT, 'record'));
    const rec = new Recorder(200, 200, { textScale: 2 }).reset();
    G.radial(rec, T.theme('m_tricolour'), 100, 100, 70, { value: 776, min: 0, max: 8000, tickLabels: false });
    const pic = new ScaledCanvas(200, 200, 2).clear([0, 0, 0, 0]);
    play(rec.words(), pic);
    const d = pic.canvas.d;
    assert.strictEqual(d[3], 0, "the dial layer's corner is see-through");
    let black = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && !d[i] && !d[i + 1] && !d[i + 2]) black++;
    assert.strictEqual(black, 0, 'no opaque black pixels');
}

/* ---------- Live Data's widget: a bar's label fits beside its value (not "ENGINE SP...") ---------- */
{
    const G = require(path.join(KIT, 'gauges')), T = require(path.join(KIT, 'themes'));
    const { Recorder } = require(path.join(KIT, 'record'));
    const SCR = require(path.join(ROOT, 'apps', 'live_data', 'screens'));
    const sw = require(path.join(ROOT, 'apps', 'live_data', 'app.json')).startWidget;
    const box = SCR.widgetBox(sw.size[0], sw.size[1], sw.safe, 'medium');
    const drawn = (rpm) => {
        const rec = new Recorder(sw.size[0], sw.size[1], { textScale: sw.scale }).reset(), texts = [];
        const text = rec.text.bind(rec);
        rec.text = (s, x, y, size, c, o) => { texts.push({ s: String(s), size }); return text(s, x, y, size, c, o); };
        const fit = (cv, s) => s;      // the label must fit without being cut
        const slots = [{ name: 'Engine speed', n: rpm, u: 'rpm', d: 0, sc: { min: 0, max: 8000, div: 1000 } },
            { name: 'Engine oil', n: 93, u: '°C', d: 0, sc: { min: 0, max: 150 } }];
        SCR.draw(rec, T.theme('m_tricolour'), G, SCR.layout('bar3'), slots, box, true, -1, fit);
        return { texts, w: rec.textWidth.bind(rec) };
    };
    const r = drawn(776), lab = r.texts.find((x) => x.s === 'ENGINE SPEED');
    assert.ok(lab, 'the whole label is drawn');
    assert.ok(lab.size >= 14 && lab.size <= 22, 'a readable size: ' + lab.size);
    assert.ok(r.w('ENGINE SPEED', lab.size, { font: 'bold', spacing: 2 }) + r.w('8000', 44, { font: 'num' }) + r.w(' rpm', 26) <= box.w,
        'label and the widest value fit the widget');
    assert.strictEqual(drawn(6400).texts.find((x) => x.s === 'ENGINE SPEED').size, lab.size, 'its size stays as the value grows');
}

console.log('Widget picture, stopped engine and eDrive settings checks passed.');
process.exit(0);    // the Car's demo timer would keep this running
