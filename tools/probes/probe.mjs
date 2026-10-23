#!/usr/bin/env node
/**
 * Gameplay probe suite. Boots the showcase headless on a fixed clock and a
 * fixed seed, drives it through `window.__spark.game`, and asserts what the
 * mission does — the layer between the unit tests (pure logic, no renderer)
 * and the visual suite (pixels, no behaviour).
 *
 *   pnpm probe                     run every probe, fail on the first bad assertion
 *   pnpm probe --filter=alert      only probes whose name contains "alert"
 *   pnpm probe --headed            watch it happen
 *   pnpm probe --seed=7            a different seeded run
 *   pnpm probe --verbose           print every assertion, not just failures
 *   pnpm probe --shots=<dir>       save a 1280x720 frame at each probe's named beats
 *
 * Determinism is the whole point: `fixedclock=60` plus `paused=1` means the
 * suite advances the simulation itself, so a probe that passes here passes on
 * a slower machine. Assertions are written as budgets ("alerted within twelve
 * seconds"), never exact frame counts, so tuning a constant does not fail the
 * suite — only a broken mechanic does.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, parseArgs, startServer } from '../capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
void here;

/** Frames advanced per `until` poll: a third of a second at the fixed clock. */
const POLL_FRAMES = 20;
const FIXED_HZ = 60;

class Probe {
  constructor(page, options, name) {
    this.page = page;
    this.verbose = options.verbose;
    this.shotsDir = options.shots;
    this.name = name;
    this.failures = [];
    this.checks = 0;
    this.shotCount = 0;
  }

  /** Save the current frame as `<probe>-<nn>-<label>.png` when `--shots` is on; otherwise nothing. */
  async shot(label) {
    if (!this.shotsDir) return;
    this.shotCount += 1;
    const file = path.join(this.shotsDir, `${this.name}-${String(this.shotCount).padStart(2, '0')}-${label}.png`);
    await this.page.screenshot({ path: file });
    console.log(`    shot ${path.basename(file)}`);
  }

  /** Distance on the ground from the operator to (x, z). */
  async distanceTo(x, z) {
    const feet = (await this.stats()).feet;
    return Math.hypot(feet[0] - x, feet[2] - z);
  }

  /**
   * Walk to (x, z) the way a player would: face it, hold forward, re-aim every
   * poll. If the operator stops making ground for a second (a prop, a car), a
   * sidestep gets them round it. Fails the probe if they never arrive.
   */
  async walkTo(message, x, z, seconds, within = 1.5, target = null) {
    const budget = Math.round((seconds * FIXED_HZ) / POLL_FRAMES);
    let last = Infinity;
    let stuck = 0;
    for (let i = 0; i <= budget; i++) {
      const where = target ? await target() : [x, z];
      if (where === null) break;
      const d = await this.distanceTo(where[0], where[1]);
      if (d <= within) {
        await this.call('move', 0, 0);
        this.expect(true, `${message} (after ${((i * POLL_FRAMES) / FIXED_HZ).toFixed(1)}s)`);
        return true;
      }
      stuck = last - d < 0.15 ? stuck + 1 : 0;
      last = d;
      await this.call('lookAt', where[0], 1.2, where[1]);
      await this.call('move', 1, stuck >= 3 ? (Math.floor(i / 6) % 2 === 0 ? 1 : -1) : 0);
      await this.step(POLL_FRAMES);
    }
    await this.call('move', 0, 0);
    this.expect(false, `${message} — did not arrive within ${seconds}s (${(await this.distanceTo(x, z)).toFixed(1)} m short)`);
    return false;
  }

  step(frames) {
    return this.page.evaluate((n) => window.__spark.stepFrames(n), frames);
  }

  stats() {
    return this.page.evaluate(() => window.__spark.game.stats());
  }

  alert() {
    return this.page.evaluate(() => window.__spark.game.alert());
  }

  objective() {
    return this.page.evaluate(() => window.__spark.game.objective());
  }

  /** Call a `window.__spark.game` method by name. */
  call(name, ...args) {
    return this.page.evaluate(([n, a]) => window.__spark.game[n](...a), [name, args]);
  }

  /**
   * Press a key the way the player would — a real browser key event, not a
   * synthetic one, so it goes through the engine's own window listener. The
   * mission reads Enter to retry from the checkpoint.
   */
  key(name) {
    return this.page.keyboard.press(name);
  }

  logs() {
    return this.page.evaluate(() => window.__spark.logs());
  }

  expect(ok, message) {
    this.checks++;
    if (!ok) this.failures.push(message);
    else if (this.verbose) console.log(`    ok  ${message}`);
    return Boolean(ok);
  }

  /**
   * Advance the simulation until `predicate(state)` holds, up to `seconds`.
   * `read` produces the state each poll. Fails the probe on timeout.
   * Returns the seconds elapsed, or null if it never happened.
   */
  async until(message, seconds, read, predicate) {
    const budget = Math.round((seconds * FIXED_HZ) / POLL_FRAMES);
    for (let i = 0; i <= budget; i++) {
      const state = await read();
      if (predicate(state)) {
        const elapsed = (i * POLL_FRAMES) / FIXED_HZ;
        this.expect(true, `${message} (after ${elapsed.toFixed(1)}s)`);
        return elapsed;
      }
      await this.step(POLL_FRAMES);
    }
    this.expect(false, `${message} — did not happen within ${seconds}s`);
    return null;
  }

  /** Advance `seconds` of simulation. */
  async run(seconds) {
    await this.step(Math.round(seconds * FIXED_HZ));
  }
}

const PROBES = [
  {
    name: 'mission-boots',
    describe: 'the street loads with its garrison, its objectives and a quiet sector',
    async run(p) {
      const stats = await p.stats();
      const alert = await p.alert();
      p.expect(stats.enemies.length === 9, `garrison is 9 hostiles, eight riflemen and the broker (got ${stats.enemies.length})`);
      p.expect(stats.enemies.filter((e) => e.role === 'hvt').map((e) => e.name).join() === 'Broker', 'the broker is the one target on the street');
      p.expect(
        stats.enemies.every((e) => e.state === 'unaware' && !e.dead),
        'every hostile starts unaware and alive',
      );
      p.expect(alert.tier === 'quiet', `sector starts quiet (got ${alert.tier})`);
      p.expect(alert.deployed === 0, 'no reinforcements before contact');
      p.expect(stats.health === 100, `operator starts at full health (got ${stats.health})`);
      p.expect(stats.ammo > 0, 'the rifle starts loaded');
      const objective = await p.objective();
      p.expect(objective.total === 4, `the mission has three objectives and extraction (got ${objective.total})`);
      p.expect(objective.index === 0 && objective.kind === 'reach', `it starts on a reach objective (got ${objective.kind} #${objective.index})`);
      p.expect(objective.complete === false, 'the mission does not start complete');
      p.expect(objective.distance > 10, `the first objective is up the street (${objective.distance.toFixed(1)} m)`);
      // A few seconds of settling must not wake anybody; `the-insert-is-quiet`
      // is the probe that sits still long enough to mean it.
      await p.run(3);
      p.expect(
        (await p.stats()).enemies.every((e) => e.state !== 'alert'),
        'nobody goes alert in the first seconds',
      );
      p.expect((await p.alert()).tier === 'quiet', 'the sector stays quiet with no contact');
    },
  },
  {
    name: 'alert-ladder',
    describe: 'a shot escalates the sector and calls hostiles in',
    async run(p) {
      await p.call('fire', 6);
      await p.until('a hostile hears the shot and investigates', 8, () => p.stats(), (s) =>
        s.enemies.some((e) => e.state === 'suspicious' || e.state === 'alert'),
      );
      await p.until('the sector goes alerted', 20, () => p.alert(), (a) => a.tier === 'alerted');
      const hunting = await p.stats();
      p.expect(
        hunting.enemies.filter((e) => e.posture === 'hunting').length >= 4,
        `an alert puts the level-wide sweep on (hunting: ${hunting.enemies.filter((e) => e.posture === 'hunting').length})`,
      );
      await p.until('the first reinforcement goes in', 12, () => p.alert(), (a) => a.deployed >= 1);
      const withReinforcements = await p.stats();
      p.expect(
        withReinforcements.enemies.some((e) => e.name.startsWith('Reinforcement')),
        'the called-in hostile is in the world',
      );
      p.expect(
        withReinforcements.enemies.filter((e) => !e.dead).length > 8,
        `the garrison grew past its starting eight (${withReinforcements.enemies.filter((e) => !e.dead).length})`,
      );
    },
  },
  {
    name: 'lockdown-on-casualties',
    describe: 'two hostiles down while alerted locks the sector down and opens the second wave',
    async run(p) {
      await p.call('aim', true);
      await p.call('fire', 4);
      await p.until('the sector is alerted', 20, () => p.alert(), (a) => a.tier === 'alerted');
      const pendingBefore = (await p.alert()).pending;
      // Casualties are made with the probe surface, not with the rifle: this
      // probe is about the director's rule, and should not fail because a
      // burst went wide. Marksmanship is `alert-ladder`'s business.
      const live = (await p.stats()).enemies.filter((e) => !e.dead).slice(0, 2);
      p.expect(live.length === 2, 'two hostiles are available to lose');
      for (const target of live) {
        const killed = await p.call('damage', target.name, 500);
        p.expect(killed === true, `${target.name} is down`);
        await p.run(1);
      }
      const stats = await p.stats();
      p.expect(stats.enemies.filter((e) => e.dead).length >= 2, `the sector has lost two (down: ${stats.enemies.filter((e) => e.dead).length})`);
      const alert = await p.alert();
      p.expect(alert.tier === 'lockdown', `casualties lock the sector down (got ${alert.tier})`);
      p.expect(alert.pending > pendingBefore, `lockdown queues its own wave (${pendingBefore} -> ${alert.pending})`);
    },
  },
  {
    name: 'checkpoint-reload',
    describe: 'dying and retrying undoes the alert, the reinforcements and the damage',
    async run(p) {
      await p.call('fire', 6);
      await p.until('the sector is alerted', 20, () => p.alert(), (a) => a.tier === 'alerted');
      await p.until('a reinforcement is in', 12, () => p.alert(), (a) => a.deployed >= 1);
      await p.call('hurt', 200);
      await p.run(0.5);
      const dead = await p.stats();
      p.expect(dead.health === 0, 'the operator is down');
      await p.key('Enter');
      await p.run(0.2);
      const after = await p.stats();
      const alert = await p.alert();
      p.expect(after.health === 100, `the reload restores health (got ${after.health})`);
      p.expect(alert.tier === 'quiet', `the reload quiets the sector (got ${alert.tier})`);
      p.expect(alert.deployed === 0, 'the reload retires the reinforcements');
      p.expect(
        !after.enemies.some((e) => e.name.startsWith('Reinforcement')),
        'no called-in hostile is left in the world',
      );
      p.expect(
        after.enemies.filter((e) => !e.dead).every((e) => e.state === 'unaware' && e.posture === 'relaxed'),
        'surviving hostiles are back on patrol, unaware and relaxed',
      );
    },
  },
  {
    name: 'the-insert-has-a-window',
    describe: 'the operator gets time to act before the street notices them',
    async run(p) {
      // Not "the insert is safe": the street is a 110 m corridor and sight
      // reaches 40 m, so a hostile facing the spawn *should* eventually see
      // someone standing in the open. What the mission cannot survive is being
      // shot at before the player has had a beat to move, which is what a
      // carelessly placed patrol route causes. Five seconds is the floor.
      const before = await p.stats();
      p.expect(before.lit >= 0 && before.lit <= 1, `the visibility meter reads 0..1 (got ${before.lit})`);
      let firstAlert = null;
      for (let t = 0; t < 25 && firstAlert === null; t += POLL_FRAMES / FIXED_HZ) {
        await p.step(POLL_FRAMES);
        const now = await p.stats();
        if (now.enemies.some((e) => e.state === 'alert')) firstAlert = t;
      }
      const seen = firstAlert === null ? 'never' : `${firstAlert.toFixed(1)}s`;
      p.expect(firstAlert === null || firstAlert >= 5, `nobody is alert inside the first 5 s at the insert (first alert: ${seen})`);
      const after = await p.stats();
      p.expect(after.health > 0, `the operator survives standing still for 25 s (health ${after.health})`);
      console.log(`    (a standing operator at the insert is spotted ${seen})`);
    },
  },
  {
    name: 'stance-is-cover',
    describe: 'going prone slows how fast a hostile builds awareness of you',
    async run(p) {
      // Walk into the open until someone starts noticing, then compare how fast
      // awareness climbs standing versus prone over the same window. The
      // absolute numbers are tuning; the ordering is the mechanic.
      await p.call('lookAt', 0, 1, -8);
      await p.call('move', 1, 0);
      await p.until('a hostile starts noticing the operator', 30, () => p.stats(), (s) => s.enemies.some((e) => e.awareness > 0.05));
      await p.call('move', 0, 0);
      await p.call('stance', 'stand');
      await p.run(0.5);
      const standingStart = Math.max(...(await p.stats()).enemies.map((e) => e.awareness));
      await p.run(1.5);
      const standingGain = Math.max(...(await p.stats()).enemies.map((e) => e.awareness)) - standingStart;
      await p.call('stance', 'prone');
      await p.run(1);
      const proneStart = Math.max(...(await p.stats()).enemies.map((e) => e.awareness));
      await p.run(1.5);
      const proneGain = Math.max(...(await p.stats()).enemies.map((e) => e.awareness)) - proneStart;
      p.expect((await p.stats()).stance === 'prone', 'the operator went prone');
      p.expect(
        proneGain < standingGain || proneStart >= 1,
        `prone builds awareness slower than standing (standing +${standingGain.toFixed(3)}, prone +${proneGain.toFixed(3)})`,
      );
    },
  },
  {
    name: 'objectives-advance',
    describe: 'walking into the first objective advances the mission and moves the checkpoint',
    async run(p) {
      const first = await p.objective();
      const startFeet = (await p.stats()).feet;
      const startCheckpoint = first.checkpoint;
      // This probe is about objective volumes and checkpoints, not about
      // surviving a walk down a garrisoned street — eight riflemen will kill an
      // operator who strolls up the middle, and they should. Rounds pass
      // through for the duration so the failure modes are the ones this probe
      // is actually looking for.
      await p.call('invulnerable', true);
      await p.call('lookAt', 0, 1, -8);
      await p.call('move', 1, 0);
      const reached = await p.until('the mission advances past the first objective', 30, () => p.objective(), (o) => o.index > first.index);
      await p.call('move', 0, 0);
      await p.call('invulnerable', false);
      await p.run(0.5);
      const now = await p.objective();
      const feet = (await p.stats()).feet;
      p.expect(reached !== null, 'the walk completed');
      p.expect(Math.abs(feet[2] - startFeet[2]) > 10, `the operator actually travelled (z ${startFeet[2].toFixed(1)} -> ${feet[2].toFixed(1)})`);
      p.expect(now.index === first.index + 1, `exactly one objective completed (index ${first.index} -> ${now.index})`);
      p.expect(now.kind === 'eliminate' && now.target === 'Broker', `the next objective is the broker (got ${now.kind} ${now.target})`);
      p.expect(
        Math.abs(now.checkpoint[2] - startCheckpoint[2]) > 1,
        `the checkpoint moved to the completed objective (z ${startCheckpoint[2].toFixed(1)} -> ${now.checkpoint[2].toFixed(1)})`,
      );
    },
  },
  {
    name: 'charge-is-defended',
    describe: 'an armed charge trips the alarm, the garrison goes to pull it, and an undefended one is pulled',
    async run(p) {
      // Straight to the depot: this probe is about the plant's second half, not the walk there.
      await p.call('invulnerable', true);
      const objectives = await p.objective();
      p.expect(objectives.kind === 'reach', 'the run starts on the square');
      await p.call('teleport', 0, -8);
      await p.until('the square is reached', 3, () => p.objective(), (o) => o.kind === 'eliminate');
      await p.call('damage', 'Broker', 1000);
      await p.until('the broker is down', 3, () => p.objective(), (o) => o.kind === 'plant');
      await p.call('teleport', 0, -67.4);
      await p.call('interact', true);
      await p.until('the charge is armed', 8, () => p.objective(), (o) => o.phase === 'armed');
      await p.call('interact', false);
      const armed = await p.objective();
      p.expect(armed.fuse > 15, `the fuse is burning with most of it left (${armed.fuse.toFixed(1)}s)`);
      await p.until('the alarm takes the sector to alerted', 2, () => p.alert(), (a) => a.tier !== 'quiet');
      await p.until('hostiles are sent to pull it', 3, () => p.objective(), (o) => o.workers.length >= 2);
      // Walk away from it: out of sight up the street, the workers get there unopposed.
      // (Not as far as the insert, which is the extraction volume.)
      await p.call('teleport', 0, 20);
      await p.call('stance', 'prone');
      const workerNames = (await p.objective()).workers.map((w) => w.name);
      // The ladder's way down: a hostile who loses sight stops being alert. Until
      // 2026-10-23 none ever did, and a job like this one could never start.
      await p.until('the workers lose contact with an operator who has gone', 10, () => p.stats(), (s) =>
        s.enemies.filter((e) => workerNames.includes(e.name)).every((e) => e.state !== 'alert'),
      );
      await p.until('a worker kneels at the charge', 25, () => p.objective(), (o) => o.workers.some((w) => w.working));
      await p.until('an undefended charge is pulled before it blows', 20, () => p.objective(), (o) => o.phase === 'hold');
      const after = await p.objective();
      p.expect(after.kind === 'plant' && after.index === 2, `the mission is back on setting the charge (got ${after.kind} #${after.index})`);
      p.expect(after.workers.length === 0, 'the workers stand down once it is off the wall');
      p.expect(after.sinceBlast === null || after.sinceBlast > 1e6, 'nothing went off');
    },
  },
  {
    name: 'start-to-extraction',
    describe: 'the whole mission plays through: square, broker, charge, blast, extraction, debrief, replay',
    async run(p) {
      // The garrison will kill an operator who walks this route in the open, and it
      // should; rounds pass through so the probe can see every beat of the mission.
      // What it asserts is that each step is reachable and fires, in order.
      await p.call('invulnerable', true);
      await p.shot('insert');
      await p.walkTo('the operator walks to the square', 0, -8, 40, 2.5);
      await p.until('the square completes', 3, () => p.objective(), (o) => o.kind === 'eliminate');
      await p.shot('square');
      // The broker, by gunfire: close in on him, then aim and fire bursts until he drops.
      const broker = async () => {
        const e = (await p.stats()).enemies.find((x) => x.name === 'Broker' && !x.dead);
        return e ? [e.feet[0], e.feet[2]] : null;
      };
      await p.walkTo('the operator closes on the broker', 0, 0, 40, 9, broker);
      await p.call('aim', true);
      let downAt = null;
      for (let t = 0; t < 30 && downAt === null; t += 0.5) {
        const at = await broker();
        if (at === null) {
          downAt = t;
          break;
        }
        await p.call('lookAt', at[0], 1.3, at[1]);
        await p.call('fire', 3);
        await p.run(0.5);
      }
      await p.call('aim', false);
      await p.until('the broker is eliminated by gunfire', 2, () => p.objective(), (o) => o.kind === 'plant');
      await p.shot('broker-down');
      await p.walkTo('the operator reaches the depot wall', 0, -67.6, 45, 1.0);
      await p.call('interact', true);
      await p.until('the charge is set', 6, () => p.objective(), (o) => o.phase === 'armed');
      await p.call('interact', false);
      await p.shot('armed');
      // Back off past the blast and hold the site from there.
      await p.walkTo('the operator clears the blast', 0, -50, 20, 1.5);
      await p.call('lookAt', 0, 1.0, -65);
      await p.until('the charge holds until it blows', 24, () => p.objective(), (o) => o.kind === 'extract');
      const blast = await p.objective();
      p.expect(blast.sinceBlast < 2, `it went off (${blast.sinceBlast.toFixed(2)}s ago)`);
      await p.step(4);
      await p.shot('detonation');
      await p.step(30);
      await p.shot('wreck-burning');
      p.expect((await p.stats()).health > 0, 'the operator is alive after the blast');
      await p.walkTo('the operator makes it back to the insert', 0, 34, 70, 2.5);
      await p.until('extraction ends the run', 3, () => p.call('debrief'), (d) => d !== null);
      const debrief = await p.call('debrief');
      p.expect(debrief.kills >= 1, `the debrief counts the kills (${debrief.kills})`);
      p.expect(debrief.shots > 0 && debrief.hits > 0, `the debrief counts shots and hits (${debrief.hits}/${debrief.shots})`);
      p.expect(debrief.seconds > 60, `the run took real time (${debrief.seconds.toFixed(0)}s)`);
      p.expect(debrief.peakTier !== 'quiet', `the sector peak is reported (${debrief.peakTier})`);
      console.log(`    (scripted run: ${debrief.seconds.toFixed(0)}s, ${debrief.kills} kills, ${debrief.hits}/${debrief.shots} hits, spotted ${debrief.spotted}x, peak ${debrief.peakTier}, rated ${debrief.rating})`);
      await p.run(1.5);
      await p.shot('debrief');
      await p.run(3);
      p.expect((await p.stats()).health > 0, 'nobody can hurt the operator once they are out');
      await p.key('Enter');
      await p.run(0.3);
      const again = await p.objective();
      const stats = await p.stats();
      p.expect(again.index === 0 && again.kind === 'reach' && !again.complete, `Enter plays the mission again from the start (got ${again.kind} #${again.index})`);
      p.expect((await p.call('debrief')) === null, 'the debrief is gone');
      p.expect(stats.enemies.filter((e) => !e.dead).length === 9, `the whole garrison is back (${stats.enemies.filter((e) => !e.dead).length})`);
      p.expect((await p.alert()).tier === 'quiet', 'the sector is quiet again');
      p.expect(Math.abs(stats.feet[2] - 34) < 1, `the operator is back at the insert (z ${stats.feet[2].toFixed(1)})`);
    },
  },
];

async function runProbe(browser, baseUrl, def, options) {
  const viewport = options.shots ? { width: 1280, height: 720 } : { width: 960, height: 540 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleIssues = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning' || type === 'warn') consoleIssues.push(`${type}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleIssues.push(`pageerror: ${String(err)}`));

  const params = new URLSearchParams({
    seed: String(options.seed),
    fixedclock: '60',
    paused: '1',
    freelook: '1',
    overlay: '0',
    ...(def.params ?? {}),
  });
  const started = Date.now();
  const probe = new Probe(page, options, def.name);
  let bootError = null;
  try {
    await page.goto(`${baseUrl}?${params.toString()}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
    bootError = await page.evaluate(() => window.__spark?.error ?? null);
    if (!bootError) {
      const hasGame = await page.evaluate(() => Boolean(window.__spark.game));
      if (!hasGame) bootError = 'window.__spark.game is missing: the mission scene did not expose its probe surface';
    }
    if (!bootError) {
      await def.run(probe);
      const logs = await probe.logs();
      const warnings = logs.filter((l) => l.level !== 'info');
      probe.expect(warnings.length === 0, `no engine warnings or errors${warnings.length ? `: ${warnings.map((l) => l.message).join(' | ')}` : ''}`);
    }
  } catch (error) {
    bootError = bootError ?? `${error instanceof Error ? error.message : String(error)}`;
    probe.failures.push(`threw: ${bootError}`);
  }
  await context.close();
  return {
    name: def.name,
    describe: def.describe,
    bootError,
    checks: probe.checks,
    failures: probe.failures,
    consoleIssues,
    elapsedMs: Date.now() - started,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filter = args.filter ? String(args.filter) : null;
  const seed = Number(args.seed ?? 1);
  const headed = Boolean(args.headed);
  const verbose = Boolean(args.verbose);
  const shots = args.shots ? path.resolve(String(args.shots)) : null;
  if (shots) await mkdir(shots, { recursive: true });
  const probes = PROBES.filter((p) => !filter || p.name.includes(filter));
  if (probes.length === 0) {
    console.error(`no probe matches --filter=${filter}`);
    process.exit(1);
  }

  const { server, url } = await startServer(0, 'showcase');
  const browser = await launchBrowser(headed);
  let failed = 0;
  try {
    for (const def of probes) {
      const result = await runProbe(browser, url, def, { seed, verbose, shots });
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      if (result.bootError) {
        failed++;
        console.log(`✗ ${result.name}: BOOT ERROR ${result.bootError} (${seconds}s)`);
        continue;
      }
      const bad = result.failures.length + result.consoleIssues.length;
      if (bad === 0) {
        console.log(`✓ ${result.name}: ${result.checks} checks — ${result.describe} (${seconds}s)`);
      } else {
        failed++;
        console.log(`✗ ${result.name}: ${result.failures.length}/${result.checks} checks failed — ${result.describe} (${seconds}s)`);
        for (const f of result.failures) console.log(`    ${f}`);
        for (const c of result.consoleIssues) console.log(`    console ${c}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(failed === 0 ? `\nprobe suite passed (${probes.length} probes)` : `\nprobe suite FAILED: ${failed} of ${probes.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
