'use strict';
// What Redline's tests share (not a test itself: the workflows run kit/tools/test_*.js). Node 8 compatible: the
// node8-runtime CI job runs the tests on the head unit's Node 8.16.2.
// - counter(): ok(cond, msg) counting checks and failures, printing FAIL lines;
// - sleep(ms);
// - hookKit(opts): the app requires the kit as './kit/...' (where the build puts it), mapped to kit/runtime, and
//   './cluster_render_client' to opts.clusterRender when given;
// - fakeClusterRender(opts): a stand-in cluster-render, ready at once, recording layers, pixels, effects and status asks;
// - claimsDir(prefix): a temp folder with the HUD claims folder in it (MGU_HUD_CLAIMS), rmTree(p) to remove a folder;
// - redlineDefaults(): Redline's app.json and its settings' defaults;
// - prng(seed): a seeded random number generator (the tests never use Math.random);
// - cueRun(Hud, o): the shift cue driven as the app drives it, from samples that arrive with jitter.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');

function counter() {
    const c = { checks: 0, fails: 0 };
    c.ok = (cond, msg) => { c.checks++; if (!cond) { c.fails++; console.log('FAIL ' + msg); } };
    return c;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function hookKit(opts) {
    const fake = opts && opts.clusterRender;
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
        if (fake && req === './cluster_render_client') return { ClusterRender: fake };
        return load.call(this, req, parent, isMain);
    };
}

/**
 * A stand-in cluster-render class. Options (each test's old fake differed here):
 * - onCreate(cr): called with each new instance;
 * - set: 'ignore' (default) or 'merge' (set(ref, o) merged into the layer's options);
 * - pixels: what pixels() answers, true (default: accepted) or undefined (the HUD then keeps sending whole pictures);
 * - status: false for no status() at all (the HUD then never asks for the slot report).
 * An instance has layers {ref: {kind, ...options}}, frames [{ref, rects, px}], h {event: handler}, effects (count),
 * asked (status() calls), of(kind) / images() (the refs of the layers of a kind).
 */
function fakeClusterRender(opts) {
    opts = opts || {};
    const pixelsAnswer = 'pixels' in opts ? opts.pixels : true;
    class FakeCr {
        constructor() {
            this.ready = true; this.backend = 'test'; this.targets = 'hud'; this.n = 0; this.layers = {}; this.frames = []; this.h = {};
            this.effects = 0; this.asked = 0;
            if (opts.status === false) this.status = undefined;
            if (opts.onCreate) opts.onCreate(this);
        }
        on(ev, fn) { this.h[ev] = fn; }
        connect() {} close() {} removeAllListeners() {} send() {}
        set(ref, o) { if (opts.set === 'merge' && this.layers[ref]) Object.assign(this.layers[ref], o); }
        _add(kind, o) { this.n++; this.layers[this.n] = Object.assign({ kind: kind }, o); return this.n; }
        image(o) { return this._add('image', o); }
        effect(o) { this.effects++; return this._add('effect', o); }
        uniform() {}
        pixels(ref, rects, px) { this.frames.push({ ref: ref, rects: rects, px: Buffer.from(px) }); return pixelsAnswer; }
        drop(r) { delete this.layers[r]; }
        status() { this.asked++; }
        of(kind) { return Object.keys(this.layers).map(Number).filter((r) => this.layers[r].kind === kind); }
        images() { return this.of('image'); }
    }
    return FakeCr;
}

/** A temp folder (prefix) and the HUD claims folder in it, set as MGU_HUD_CLAIMS (made by the test). */
function claimsDir(prefix) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const shm = process.env.MGU_HUD_CLAIMS = path.join(tmp, 'shm');
    return { TMP: tmp, SHM: shm };
}

/** Removes a file or folder and what's in it; nothing there is fine. (fs.rmSync is Node 14.14+.) */
function rmTree(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (!st.isDirectory()) return fs.unlinkSync(p);
    fs.readdirSync(p).forEach((f) => rmTree(path.join(p, f)));
    fs.rmdirSync(p);
}

function redlineDefaults() {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'app.json'), 'utf8'));
    const def = {};
    spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });
    return { spec: spec, def: def };
}

/** rand() in 0..1 from a seed (mulberry32): the same numbers on every run and every Node. */
function prng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The shift cue as the app runs it (main.js onSample, hud.js frameData and its pacing), on a made-up clock.
 * o = { rpmAt(tMs) (the true revs), gearAt(tMs) (optional), period (ms between rpm samples), jitter (+- ms on each
 * sample's arrival), seed, frame (ms between the HUD's frames, 50), lead (ms), shift, redline, rev (the rev bar's
 * start, optional), until (ms), own (true: the HUD keeps its own cue state, fed by the same climb rate), speedAt(tMs)
 * (km/h, optional), noise (+- rpm on each reading), gaps ([[t0, t1], ...]: no samples taken in between) }.
 * The reading taken at k * period arrives at k * period + jitter: there the climb rate is fed and the screen's cue
 * run; the HUD's cue runs at each frame, and at once on a sample while the lights count or flash (never two frames
 * within 33 ms). Returns { ev: [{ t, kind ('s' sample, 'f' frame), rpm, show, screen, hud }], flashAt (the HUD's
 * first flash, ms), countAt (its first frame with the revs in the count), ons / offs (the times of the HUD's frames
 * where the flash came on / went off), climb, st }. ev.screen: the screen's cue
 * at that moment (drawn from the same state as the HUD's; with own, its cue from the sample), hud: the HUD's when
 * it drew.
 */
function cueRun(Hud, o) {
    const rand = prng(o.seed || 1), nrand = prng((o.seed || 1) * 7919 + 13), frame = o.frame || 50, gap = 1000 / 30;
    const speedAt = o.speedAt || (() => undefined), gaps = o.gaps || [], ons = [], offs = [];
    let was = false;
    const climb = {}, st = {}, stHud = o.own ? {} : st, ev = [];
    const max = o.redline - 50, gearAt = o.gearAt || (() => 3);
    const arrivals = [];
    for (let k = 0; k * o.period <= o.until; k++) {
        const tk = k * o.period, arrive = Math.max(0, tk + (rand() * 2 - 1) * (o.jitter || 0)), n = o.noise ? (nrand() * 2 - 1) * o.noise : 0;
        if (gaps.some((g) => tk >= g[0] && tk < g[1])) continue;
        arrivals.push({ t: arrive, rpm: Math.round((o.rpmAt(tk) + n) * 4) / 4, gear: gearAt(tk) });
    }
    arrivals.sort((x, y) => x.t - y.t);
    let rpm = null, gear, last = null, drawnAt = -Infinity, bySample = false, flashAt = null, countAt = null, i = 0;
    const draw = (t, kind, screen) => {
        const show = Hud.shownRpm(climb, rpm, t, max);
        const hud = Hud.shiftCue(stHud, rpm, t, o.shift, o.redline, o.lead, gear, Hud.shownRpm(climb, rpm, t, max, frame / 2), o.rev, climb, speedAt(t));
        last = hud;
        if (hud.shift && !was) ons.push(t);
        if (!hud.shift && was) offs.push(t);
        was = hud.shift;
        if (hud.shift && flashAt === null) flashAt = t;
        if (!hud.shift && flashAt === null && countAt === null && show > hud.from) countAt = t;
        // the screen draws from the same state (main.js drawTach): its cue at this moment
        if (!o.own) screen = Hud.shiftCue(st, rpm, t, o.shift, o.redline, o.lead, gear, undefined, o.rev, climb, speedAt(t));
        ev.push({ t: t, kind: kind, rpm: rpm, show: show, screen: screen || null, hud: hud });
    };
    for (let f = 0; f * frame <= o.until; f++) {
        const tf = f * frame;
        while (i < arrivals.length && arrivals[i].t <= tf) {
            const a = arrivals[i++], n = climb.n;
            rpm = a.rpm; gear = a.gear;
            Hud.climbFeed(climb, rpm, a.t);
            const screen = Hud.shiftCue(st, rpm, a.t, o.shift, o.redline, o.lead, gear, undefined, o.rev, climb, speedAt(a.t));
            if (climb.n !== n && last && (last.shift || rpm > last.from) && a.t - drawnAt >= gap) { drawnAt = a.t; bySample = true; draw(a.t, 's', screen); }
            else ev.push({ t: a.t, kind: 's', rpm: rpm, show: rpm, screen: screen, hud: null });
        }
        if (rpm === null || (bySample && tf - drawnAt < gap)) continue;
        drawnAt = tf; bySample = false;
        draw(tf, 'f');
    }
    return { ev: ev, flashAt: flashAt, countAt: countAt, ons: ons, offs: offs, climb: climb, st: st };
}

module.exports = { ROOT, counter, sleep, hookKit, fakeClusterRender, claimsDir, rmTree, redlineDefaults, prng, cueRun };
