'use strict';

// Redline's HUD running against a stand-in cluster-render:
//   node kit/tools/test_redline_running.js
// - the HUD is one image layer (a picture) on every layout, never a shader (the cluster runs the HUD's
//   shaders, and a heavy one restarted it on the car: README "HUD drawing");
// - the Sport / Comfort profiles switch the running HUD with the driving mode, Don't show drops its layer;
// - the knock warning and the launch time where the grade shows;
// - the tyre widget in the directions' corner: when a tyre is low (or always, or never), the directions first;
// - "Play on HUD" and the HUD looks preview: the same demo frame (blink and shake);
// - the HUD off stops every UDS reader (the electrical one too);
// - 2.0.40: with the app's own cue the HUD flashes with the screen, draws a sample in the count at once, logs each
//   flash and a line a minute, and learns the reaction lead from the time between the flash shown and the shift
//   (whole drives: a 470 ms driver, a short-shifter, one who shifts on the limiter).

const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const { TMP, SHM } = TH.claimsDir('redline-running-');
const ROOT = TH.ROOT;

// a stand-in cluster-render: ready at once; records layers and pixels
let cr = null;
TH.hookKit({ clusterRender: TH.fakeClusterRender({ set: 'merge', onCreate: (c) => { cr = c; } }) });
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const HudNav = require(path.join(ROOT, 'apps', 'redline', 'hud-nav'));
const def = TH.redlineDefaults().def;

const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const log = { info() {}, warn() {}, error() {} };

(async () => {
    // a claim from this boot, so the HUD stays on at start
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    // an old setting from 1.16.0-1.16.6 asking for the GPU: ignored
    // (In Comfort / Eco Pro: Same as Sport, the OG default; this fork's own is Don't show, checked in test_redline_hud.js)
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'arc', hudRenderer: 'gpu', hudFps: 30, hudComfortMode: 'same' }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let rpm = 3000, drive = 'sport', speed = 80, cond, known;
    const src = { data: () => ({ rpm: rpm, gear: 3, stage: 'D', speed: speed, oil: 95, coolant: 92, condition: cond, conditionKnown: known }), shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550,
        maxRpm: () => 8000, driveMode: () => drive,
        // a stand-in knock reader: started / stopped by the HUD, its last event's time set by the test
        knock: { on: false, at: 0, start() { this.on = true; }, stop() { this.on = false; }, value() { return { retard: null, at: this.at }; } },
        // stand-ins for the electrical reader (started / stopped by the HUD) and the tyres (values set by the test)
        electrical: { on: false, want: null, start(w) { this.on = true; this.want = w; }, stop() { this.on = false; }, value() { return {}; } },
        tyres: { val: null, value() { return this.val; } },
        // a stand-in for the directions: m is the turn shown (null: none)
        nav: { m: null, view() { return { show: this.m, giveWay: false }; } },
        // a stand-in launch score: a run that finished `at`
        launch: (now, mph) => (launchRun && now - launchRun.at < 3000 ? Object.assign({ label: mph ? '0-60' : '0-100' }, launchRun) : null) };
    let launchRun = null;
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP, backWaitMs: 600 }, src);
    await sleep(250);

    // every layout: one image layer, no shader
    const img = cr.of('image');
    ok(img.length === 1 && cr.of('effect').length === 0, 'Arc (an old GPU setting set): one image layer, no shader');
    const I = cr.layers[img[0]] || {};
    ok(I.target === 'hud' && I.klass === 'overlay' && I.z === 0, 'the image: on the HUD, overlay');
    for (const st of ['standard', 'minimal', 'wings', 'digital', 'vfd', 'vector', 'tyres', 'ramp', 'dial', 'pill', 'arc']) {
        settings.set('hudStyle', st); rpm = 6400; await sleep(120);
        ok(cr.of('image').length === 1 && cr.of('effect').length === 0, st + ': the picture, no shader');
    }
    // the revs move the picture
    const before = cr.frames.length;
    for (let r = 4000; r <= 6000; r += 400) { rpm = r; await sleep(60); }
    ok(cr.frames.length > before, 'moving revs redraw the picture (' + (cr.frames.length - before) + ' frames)');

    // the Sport / Comfort profiles in the running HUD: Comfort follows Sport, then its own, then Don't show
    // (the layer dropped while in Comfort)
    ok(h.frame().opts.style === 'arc', 'Sport: the Arc');
    drive = 'comfort'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'Comfort, same as Sport: the Arc too');
    Hud.profileView(settings, 'comfort').set('hudStyle', 'standard'); await sleep(200);
    ok(h.frame().opts.style === 'standard' && cr.of('image').length === 1, 'Comfort, its own: Standard');
    drive = 'sport'; await sleep(200);
    ok(h.frame().opts.style === 'arc' && cr.of('image').length === 1, 'back in Sport: the Arc');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(200);
    ok(cr.of('image').length === 0, "Comfort, Don't show: Redline's layer gone");
    // hidden, the car isn't read, but the one look for a hybrid battery may still run (a PHEV's Hybrid mode counts as
    // Comfort): the electrical reader asked for nothing else (2026-11-10 review)
    ok(!src.knock.on && src.electrical.on && JSON.stringify(src.electrical.want) === '{}', "Comfort, Don't show: no reads, the electrical reader only for its hybrid look (" + JSON.stringify(src.electrical.want) + ')');
    // switching off in Comfort on Don't show (issue #141): an unknown mode (null, shown as Sport) while the car's state
    // is ending (12) or off (5) makes no new layer, so cluster-render never maps the HUD as the cluster goes off
    cond = 12; drive = null; await sleep(200);
    ok(cr.of('image').length === 0 && /switched on/.test(h.status()), 'switching off, the mode unknown: no new layer (' + h.status() + ')');
    cond = 5; await sleep(150);
    ok(cr.of('image').length === 0, 'switched off: still no layer');
    cond = 8; drive = 'sport'; await sleep(150);
    ok(cr.of('image').length === 0, 'drive readiness starting: no layer yet');
    cond = 10; await sleep(200);
    ok(cr.of('image').length === 1, 'drive-ready in Sport: the layer');
    cond = 12; await sleep(150);
    ok(cr.of('image').length === 0 && /switched on/.test(h.status()), 'switching off with the tach shown: the layer dropped (' + h.status() + ')');
    cond = 10; await sleep(200);
    ok(cr.of('image').length === 1, 'drive-ready again: the layer back');
    // a state the car sends that isn't known ("no value" 15): the last known one may be stale, no new layer;
    // a layer already up stays (a car that sent it while driving keeps its HUD)
    known = false; await sleep(150);
    ok(cr.of('image').length === 1, 'an unknown state with the tach shown: it stays');
    Hud.setComfortMode(settings, 'hide'); drive = 'comfort'; await sleep(150);
    drive = 'sport'; await sleep(200);
    ok(cr.of('image').length === 0, 'an unknown state: no new layer for Sport');
    known = undefined; await sleep(200);
    ok(cr.of('image').length === 1, 'the state known again: the layer');
    // the directions giving way ends (a route ending, as at switch-off): the tach back only after a wait
    let gw = true;
    src.nav.view = function () { return { show: null, giveWay: gw }; };
    await sleep(150);
    ok(cr.of('image').length === 0, 'giving way to BMW\'s directions: no layer');
    gw = false; await sleep(300);
    ok(cr.of('image').length === 0, 'give-way just over: the tach not back yet');
    gw = true; await sleep(100); cond = 12; gw = false; await sleep(200);
    ok(cr.of('image').length === 0, 'give-way over as the car switches off: still no layer');
    cond = 10; await sleep(800);
    ok(cr.of('image').length === 1, 'give-way over while driving: the tach back after the wait');
    src.nav.view = function () { return { show: this.m, giveWay: false }; };
    cond = undefined;
    drive = 'sport'; Hud.setComfortMode(settings, 'same'); await sleep(250);
    ok(cr.of('image').length === 1, 'back in Sport: shown again');
    // Comfort's own size and place: the tach moves there when the mode is Comfort, back when it's Sport
    Hud.setComfortMode(settings, 'own');
    const cv = Hud.profileView(settings, 'comfort');
    cv.set('hudSize', 70); cv.set('hudX', 120); cv.set('hudY', 40);
    drive = 'comfort'; await sleep(250);
    const small = Object.assign({}, cr.layers[cr.of('image')[0]] || {}), want = Hud.placeOf(cv);
    ok(small.w === 280 && small.x === want.x && small.y === want.y, 'Comfort, its own place: the tach small in the corner (' + [small.x, small.y, small.w, small.h] + ')');
    drive = 'sport'; await sleep(250);
    const big = cr.layers[cr.of('image')[0]] || {};
    ok(big.w === 400 && big.x !== small.x, 'back in Sport: Sport\'s own size and place (' + [big.x, big.y, big.w, big.h] + ')');
    Hud.setComfortMode(settings, 'same'); await sleep(150);
    ok(cr.effects === 0, 'no shader made in the whole run (' + cr.effects + ')');

    // the knock warning: the reader runs while the HUD shows (warning on by default); an event shows KNOCK
    // where the grade goes, for 1.5 s; switched off, the reader stops and nothing shows
    ok(src.knock.on, 'knock: the engine unit is read while the HUD shows');
    src.knock.at = Date.now();
    const kf = h.frame();
    ok(kf.chip && kf.chip.verdict === 'KNOCK', 'knock: KNOCK shows after an event (' + JSON.stringify(kf.chip) + ')');
    src.knock.at = Date.now() - 2000;
    ok(!h.frame().chip, 'knock: gone 1.5 s after the last event');
    settings.set('hudKnockWarn', false); src.knock.at = Date.now(); await sleep(150);
    ok(!h.frame().chip && !src.knock.on, 'knock warning off: no KNOCK, the reader stopped');
    settings.set('hudShowKnock', true); await sleep(150);
    ok(src.knock.on, 'knock readout on: the reader runs again');
    rpm = 0; await sleep(150);
    ok(!src.knock.on, 'engine off: the reader stops');

    // the launch time where the grade shows: the time and its difference, green for a best; knock goes first
    settings.set('hudKnockWarn', true); src.knock.at = 0; await sleep(100);
    launchRun = { secs: 4.92, delta: -0.08, best: true, at: Date.now() };
    const lf = h.frame();
    ok(lf.chip && lf.chip.verdict === 'LAUNCH' && lf.chip.text === '4.92  -0.08' && lf.chip.tone === 'low', 'launch: 4.92  -0.08 in green (' + JSON.stringify(lf.chip) + ')');
    launchRun = { secs: 5.31, delta: 0.31, best: false, at: Date.now() };
    ok(h.frame().chip.tone === 'high' && h.frame().chip.text === '5.31  +0.31', 'launch: slower in red');
    rpm = 3000; await sleep(150); src.knock.at = Date.now();
    ok(h.frame().chip.verdict === 'KNOCK', 'knock goes before the launch time');
    src.knock.at = 0;
    settings.set('hudLaunch', false);
    ok(!h.frame().chip, 'launch time off: nothing');

    // the tyre widget: the directions' corner (their layer and place) when they have nothing; the directions first
    settings.set('hudStyle', 'standard'); src.knock.at = 0;
    const T = (rr) => ({ p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: rr }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 40, FR: 40, RL: 40, RR: 40 } });
    const corners = () => cr.of('image').filter((r) => cr.layers[r].iw === 200 && cr.layers[r].ih === 76);
    src.tyres.val = T(2.6); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'tyres fine ("when a tyre is low"): no widget (' + h.corner() + ')');
    src.tyres.val = T(2.0); await sleep(200);
    ok(h.corner() === 'tyres' && corners().length === 1 && cr.of('image').length === 2, 'a tyre low: the widget in the corner, beside the tach (' + h.corner() + ')');
    src.nav.m = HudNav.SAMPLE; await sleep(250);
    ok(h.corner() === 'nav' && corners().length === 1, 'a turn to show: the directions take the corner (' + h.corner() + ')');
    src.nav.m = null; await sleep(250);
    ok(h.corner() === 'tyres', 'the turn done: the tyres again');
    src.tyres.val = T(2.6); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'the tyre pumped up: the widget goes');
    settings.set('hudTyreWidget', 'always'); await sleep(200);
    ok(h.corner() === 'tyres', 'widget "Always": shown with fine tyres');
    src.tyres.val = null; await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'no tyre data: no widget');
    settings.set('hudTyreWidget', 'off'); src.tyres.val = T(1.8); await sleep(200);
    ok(h.corner() === '' && corners().length === 0, 'widget off: never, a low tyre neither');
    settings.set('hudTyreWidget', 'low'); await sleep(200);
    ok(h.corner() === 'tyres', 'back on "when a tyre is low"');
    ok(cr.effects === 0, 'no shader made with the tyres either (' + cr.effects + ')');

    // "Play on HUD" and the HUD looks preview draw one demo frame (hud.js demoFrame): the same blink and shake.
    // The clock is held still and stepped by hand, so the HUD's timer can't step in between.
    {
        const main = fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'main.js'), 'utf8');
        const pv = main.slice(main.indexOf('const studioFrame'), main.indexOf('function lookLayer('));
        ok(/Hud\.demoFrame\(now - studio\.t0, Hud\.optsFrom\(studioP\(\)\), studio\.cue, hud \? hud\.lead\(\) : Hud\.LEAD_DEFAULT, now\)/.test(pv) && !/blink|shake|SHAKE/.test(pv),
            'the preview takes its frame from Hud.demoFrame, no blink or shake of its own');
        settings.set('hudShake', true); speed = 0;
        const realNow = Date.now;
        let clock = realNow.call(Date), diff = null;
        const shakes = {}, blinks = {}, phase = {};
        Date.now = () => clock;
        try {
            h.play(30000, 'sport');
            const t0 = clock, cue = {};
            for (let t = 0; t < Hud.DEMO_MS && !diff; t += 10) {
                clock = t0 + t;
                const f = h.frame(), g = Hud.demoFrame(t, f.opts, cue, h.lead(), clock);
                if (JSON.stringify(f) !== JSON.stringify(g)) diff = t + ' ms: ' + JSON.stringify(f).slice(0, 300) + ' / ' + JSON.stringify(g).slice(0, 300);
                if (f.shake) shakes[f.shake.join()] = true;
                if (f.cue.shift || f.cue.limiter) { blinks[f.blink] = true; phase[Math.floor(clock / 100) % 2 === 0] = f.blink; }
            }
        } finally { Date.now = realNow; }
        h.stopPlay(); settings.set('hudShake', false); speed = 80;
        ok(!diff, 'Play on HUD: its frame is Hud.demoFrame, frame by frame' + (diff ? ' (' + diff + ')' : ''));
        ok(Object.keys(shakes).length === 6, 'demo frame: the shake steps through all 6 offsets (' + Object.keys(shakes).join(' ') + ')');
        ok(blinks.true && blinks.false && phase.true === true && phase.false === false, 'demo frame: the flash blinks on the HUD rhythm (100 ms on, 100 ms off)');
    }

    // the HUD off: every reader stops, the electrical one too (it kept polling before 2.0's review)
    ok(src.electrical.on, 'electrical reader started while the HUD shows');
    settings.set('hud', 'off'); await sleep(200);
    ok(!src.electrical.on && !src.knock.on, 'HUD off: the electrical and knock readers stopped');
    ok(corners().length === 0 && h.corner() === '', 'HUD off: the tyre widget gone too');

    h.stop();

    // 2.0.40: the app's own cue and climb rate (src.cue, fed per rpm sample as main.js does): a sample in the count
    // is drawn at once, each flash is logged with its outcome, the lead is learned from the time between the flash
    // shown and the shift, and a line a minute says how the drawing went. The steady clock (process.hrtime) is moved
    // by hand.
    {
        const dir = path.join(TMP, 'lead');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'hudlead.json'), JSON.stringify({ ms: 40, n: 7 }));
        const lines = [], log2 = { info: (s) => lines.push(String(s)), warn() {}, error: (s) => lines.push('E ' + s), debug() {}, always: (s) => lines.push(String(s)) };
        const v2 = Object.assign({}, def, { hud: 'on', hudStyle: 'standard', hudFps: 20, hudComfortMode: 'same' }), fns2 = [];
        const settings2 = { get: (k) => v2[k], set: (k, x) => { v2[k] = x; fns2.forEach((f) => f(k, x)); }, onChange: (f) => fns2.push(f) };
        const cueState = {}, climb = {};
        let rpm2 = 3000, gear2 = 2, mode2 = 'M', mono = 1e6, speed2 = 60;
        const src2 = { data: () => ({ rpm: rpm2, gear: gear2, stage: 'D', speed: speed2, oil: 95, coolant: 92 }), shiftPoint: () => ({ rpm: 6500, cold: false }), redline: () => 7000,
            maxRpm: () => 8000, driveMode: () => 'sport', mode: () => mode2, cue: { state: cueState, climb: climb } };
        const realHr = process.hrtime;
        process.hrtime = () => [Math.floor(mono / 1000), Math.round((mono % 1000) * 1e6)];
        try {
            const h2 = Hud.start({ settings: settings2, log: log2, dataDir: dir }, src2);
            ok(h2.lead() === 200 && h2.learned().shifts === 7, 'reaction lead: one learned under 200 ms (before 2.0.40) reads as 200 (' + h2.lead() + ')');
            await sleep(150);
            cr.h.target('hud', 'shown', '', '', false, false);
            // what main.js does with each rpm sample: the climb rate, the screen's cue, then the HUD
            let screen = null;
            const feed = (r, step) => {
                mono += step === undefined ? 66 : step; rpm2 = r;
                const n = climb.n;
                Hud.climbFeed(climb, r, mono, speed2);
                screen = Hud.shiftCue(cueState, r, mono, 6500, 7000, h2.lead(), gear2, undefined, null, climb, speed2);
                if (climb.n !== n) h2.sampled();
            };
            const settle = () => { gear2 = 2; for (let i = 0; i < 14; i++) feed(3000 + 20 * (i % 2)); };
            // a pull at 4000 rpm/s to rpm `to`: returns the frames sent during the count and the flash
            const pullTo = (to) => { const n0 = cr.frames.length; let k = 0; for (let r = 3264; r <= to; r += 264) { feed(r); k++; } return { sent: cr.frames.length - n0, samples: k }; };
            const flashLines = () => lines.filter((s) => /^hud: flash /.test(s));
            settle();
            const p1 = pullTo(6700);
            // (no timer tick ran in between: this loop never yields, so the count's start is the one of the last tick's frame)
            ok(p1.sent >= 6, 'a sample in the count or the flash is drawn at once, not at the next tick (' + p1.sent + ' frames for ' + p1.samples + ' samples)');
            const f1 = h2.frame();
            ok(screen.shift && f1.cue.shift && f1.cue.at === screen.at, "the HUD's cue is the screen's: the same flash (" + f1.cue.at + ' / ' + screen.at + ')');
            const n1 = cr.frames.length;
            feed(6710, 5);
            ok(cr.frames.length === n1, 'a sample 5 ms after a frame is not drawn at once: never over 30 frames a second');
            feed(6800); gear2 = 3; feed(4800); h2.upshift(6800);
            const l1 = flashLines();
            ok(l1.length === 1 && /^hud: flash g2 \d+ rpm\/s, lead 200 ms \/ \d+ rpm, point 6500, fired \d+, shift, standard; upshift 6800 \(\d+ ms late\), \d+ ms after the flash, lead now \d+ ms after 8 shifts$/.test(l1[0]),
                'the flash is logged with its upshift (' + l1.join(' | ') + ')');
            const m = /(\d+) rpm\/s, lead 200 ms \/ (\d+) rpm, point 6500, fired (\d+).*\((\d+) ms late\), (\d+) ms after/.exec(l1[0] || '') || [];
            ok(Math.abs(m[1] - 4000) < 200 && Math.abs(m[2] - 800) < 60 && m[3] >= 5500 && m[3] <= 6500 && Math.abs(m[4] - 75) <= 5, 'the flash line: the rate, the lead in rpm, where it fired, how late the shift came (' + m.slice(1).join(' ') + ')');
            // the lead moves 30 % of the way to the time the shift took after the flash was shown
            const want = 200 + (Math.max(200, Math.min(800, +m[5])) - 200) * 0.3;
            ok(+m[5] >= 200 && Math.abs(h2.lead() - want) <= 6 && h2.lead() > 200 && h2.learned().shifts === 8, 'reaction lead: learned from the time between the flash and the shift (' + h2.lead() + ' for ' + Math.round(want) + ', the shift ' + m[5] + ' ms after the flash)');
            ok(JSON.parse(fs.readFileSync(path.join(dir, 'hudlead.json'), 'utf8')).ms === h2.lead(), 'reaction lead: kept in hudlead.json');
            // another flash within 5 s: learned from, not logged
            const lead1 = h2.lead();
            settle(); pullTo(6700); feed(6800); gear2 = 3; feed(4800); h2.upshift(6800);
            ok(flashLines().length === 1 && h2.learned().shifts === 9 && h2.lead() >= lead1, 'a second flash within 5 s is not logged, but learned from');
            // in D the gearbox shifts: logged, nothing learned
            mono += 6000; mode2 = 'D';
            const lead2 = h2.lead();
            settle(); pullTo(6700); gear2 = 3; feed(4700); h2.upshift(6700);
            const l3 = flashLines();
            ok(l3.length === 2 && /; upshift 6700 \(\d+ ms late\), \d+ ms after the flash$/.test(l3[1]) && h2.lead() === lead2 && h2.learned().shifts === 9, 'a shift in D: logged, not learned from (' + l3[1] + ')');
            // logged only, when the app says not to learn (learning frozen)
            mono += 6000; mode2 = 'M';
            settle(); pullTo(6700); gear2 = 3; feed(4700); h2.upshift(6700, false);
            ok(flashLines().length === 3 && h2.lead() === lead2, 'learning frozen: the flash is logged, the lead stays');
            // a shift on the limiter wasn't made on the lights: logged, not learned from
            mono += 6000;
            settle(); pullTo(6990); gear2 = 3; feed(4990); h2.upshift(6990);
            ok(flashLines().length === 4 && h2.lead() === lead2 && h2.learned().shifts === 9, 'a shift on the limiter: logged, not learned from');
            // no upshift within 2 s of the flash: logged as such
            mono += 6000;
            settle(); pullTo(6600);
            for (let i = 0; i < 34; i++) feed(6600 + 5 * (i % 2));
            h2.frame();
            const l5 = flashLines();
            ok(l5.length === 5 && /; no upshift$/.test(l5[4]), 'a flash without an upshift is logged after 2 s (' + l5[l5.length - 1] + ')');
            ok(!lines.some((s) => /^E /.test(s)), 'no errors on the way (' + lines.filter((s) => /^E /.test(s)).join(' | ') + ')');

            // The learner over whole drives: 2nd to 5th, each gear to the driver's shift, the revs down to 64 % in
            // 150 ms, the gear number 100 ms into that (where main.js calls upshift with the revs' peak).
            //   react: shifts ms after the flash first shows; rpm: always at that rpm; limiter: 150 ms after reaching it
            // (the road speed geared to the revs in each gear, standing through the shift's rev drop)
            const RATE = { 2: 4500, 3: 2500, 4: 1500 }, KMH = { 2: 13.6, 3: 20.6, 4: 27, 5: 35 };
            const drives = (driver, pulls) => {
                h2.resetLead();
                const rand = TH.prng(11), leads = [];
                for (let p = 0; p < pulls; p++) {
                    let t = 0, rpm = 4000, gear = 2, was = false, shiftAt = null, drop = null, gearAt = null, limAt = null, nextS = 0, nextF = 0;
                    const recent = [];
                    gear2 = 2; mono += 3000; speed2 = 4000 * KMH[2] / 1000;
                    for (let i = 0; i < 10; i++) feed(4000 + 20 * (i % 2));
                    while (gear < 5 || drop) {
                        t++; mono += 1;
                        if (drop) { const k = Math.min(1, (t - drop.t0) / 150); rpm = drop.from + (drop.to - drop.from) * k; if (k >= 1) drop = null; }
                        else if (rpm >= 7000) { rpm -= 175; if (limAt === null) limAt = t; } else rpm += RATE[gear] / 1000;
                        if (!drop) speed2 = rpm * KMH[gear] / 1000;
                        if (gearAt !== null && t >= gearAt) {
                            gearAt = null; gear2 = gear;
                            // the next sample is the first with the new gear: the app reports the upshift there
                            feed(Math.round(rpm), 0); recent.push(rpm2);
                            h2.upshift(Math.max.apply(null, recent.slice(-9)));
                        }
                        if (t >= nextS) { nextS = t + 66 + Math.round((rand() * 2 - 1) * 10); feed(Math.round(rpm), 0); recent.push(rpm2); }
                        if (t >= nextF) { nextF = t + 50; h2.frame(); }
                        // the driver: sees the flash come on
                        if (cueState.on && !was && shiftAt === null && !drop && driver.react) shiftAt = t + driver.react;
                        was = !!cueState.on;
                        if (driver.rpm && shiftAt === null && !drop && rpm >= driver.rpm) shiftAt = t;
                        if (driver.limiter && shiftAt === null && limAt !== null) shiftAt = limAt + 150;
                        if (shiftAt !== null && t >= shiftAt && !drop) { drop = { t0: t, from: rpm, to: rpm * 0.64 }; gear++; gearAt = t + 100; shiftAt = null; limAt = null; }
                        if (t > 20000) break;
                    }
                    // lift, back to 2nd
                    for (let i = 0; i < 20; i++) feed(Math.round(rpm - 150 * i));
                    leads.push(h2.lead());
                }
                // where it settled: the mean over the last five drives (one shift moves it by a third of what it took)
                return Math.round(leads.slice(-5).reduce((a, b) => a + b, 0) / 5);
            };
            const n9 = h2.learned().shifts;
            const true470 = drives({ react: 470 }, 10);
            ok(Math.abs(true470 - 470) <= 40 && h2.learned().shifts >= 20, 'the learner: a driver who takes 470 ms after the flash is learned as that (' + true470 + ' ms after ' + h2.learned().shifts + ' shifts)');
            const true330 = drives({ react: 330 }, 10);
            ok(Math.abs(true330 - 330) <= 45, 'the learner: and one who takes 330 ms (' + true330 + ' ms)');
            const short = drives({ rpm: 5700 }, 10);
            // (those shifts come under 200 ms after the flash, or before any: none of them is learned from)
            ok(short === 300 && h2.lead() === 300 && h2.learned().shifts === 0, 'the learner: shifting 800 under the point whatever the lights teaches nothing (' + short + ' ms after ' + h2.learned().shifts + ' shifts)');
            const lim = drives({ limiter: true }, 10);
            // (30 shifts; between two samples 66 ms apart the limiter's cut can go unseen, and that shift counts as a late one)
            ok(lim <= 400 && h2.learned().shifts <= 2, 'the learner: of 30 shifts made on the limiter at most 2 are learned from (' + lim + ' ms, ' + h2.learned().shifts + ' learned)');
            ok(n9 === 9 && !lines.some((s) => /^E /.test(s)), 'no errors in the drives (' + lines.filter((s) => /^E /.test(s)).join(' | ') + ')');

            // the minute's line: only with 100 frames or more drawn in it
            gear2 = 3; feed(5700);
            for (let i = 0; i < 130; i++) feed(5700 + 30 * (i % 20), 40);
            const before = lines.filter((s) => /^hud: 1 min: /.test(s)).length;
            mono += 61000; await sleep(160);
            const pl = lines.filter((s) => /^hud: 1 min: /.test(s));
            ok(pl.length === before + 1 && /^hud: 1 min: \d+ frames drawn, \d+ sent, \d+ KB, ticks late [\d.]+ \/ [\d.]+ ms, draw [\d.]+ \/ [\d.]+ ms, socket blocked 0, rpm every \d+ \+- \d+ ms$/.test(pl[pl.length - 1]),
                "the minute's line (" + pl.join(' | ') + ')');
            const pm = /(\d+) frames drawn, (\d+) sent, (\d+) KB/.exec(pl[pl.length - 1] || '') || [];
            ok(pm[1] >= 100 && +pm[2] <= +pm[1] && pm[3] > 0, "the minute's line counts the frames drawn and sent (" + pm.slice(1).join(' ') + ')');
            mono += 61000; await sleep(160);
            ok(lines.filter((s) => /^hud: 1 min: /.test(s)).length === before + 1, 'a minute with under 100 frames drawn: no line');
            h2.stop();
        } finally { process.hrtime = realHr; }
    }
    TH.rmTree(TMP);
    console.log('redline running: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
