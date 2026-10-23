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
   * `onPoll`, if given, runs once per poll, for a probe that cares about the
   * way there as well as the arrival.
   */
  async walkTo(message, x, z, seconds, within = 1.5, target = null, onPoll = null) {
    const budget = Math.round((seconds * FIXED_HZ) / POLL_FRAMES);
    let last = Infinity;
    let stuck = 0;
    for (let i = 0; i <= budget; i++) {
      const where = target ? await target() : [x, z];
      if (where === null) break;
      if (onPoll) await onPoll();
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
    name: 'the-alley-is-a-way-through',
    describe: 'the service alley behind the west row takes the operator from the square to the depot, out of the street and in the dark',
    async run(p) {
      // Rounds pass through: the claim is that the lane is walkable end to end.
      // The alley's watcher is there to make the walk dangerous, and he will
      // shoot; a probe about the route should not fail on a firefight. It
      // starts at the square by teleport, because the walk up from the insert
      // is start-to-extraction's business.
      await p.call('invulnerable', true);
      await p.call('teleport', 0, -8);
      await p.run(0.5);
      const streetLit = (await p.stats()).lit;
      const toAlley = await p.call('navPath', [0, 0, -8], [-21.8, 0, -40]);
      const toDepot = await p.call('navPath', [-21.8, 0, -40], [0, 0, -67.6]);
      p.expect(toAlley.complete && toDepot.complete, `the navmesh joins the square to the alley and the alley to the depot, so hostiles can follow (${toAlley.length.toFixed(0)} m, ${toDepot.length.toFixed(0)} m)`);
      // Into the square's passage, down the lane round its dumpsters and knee
      // walls, out through the depot's passage to the charge.
      const route = [
        [-10.5, -16.4, 'into the square passage'],
        [-22.0, -17.6, 'into the alley'],
        [-22.0, -25.4, 'past the dumpster'],
        [-20.8, -27.4, 'round the first knee wall'],
        [-21.8, -39.0, 'past the broker passage'],
        [-21.8, -46.0, 'down the lane'],
        [-22.8, -48.6, 'round the second knee wall'],
        [-21.9, -51.0, 'on down the lane'],
        [-22.0, -54.8, 'past the last dumpster'],
        [-20.6, -57.6, 'to the depot passage'],
        [-10.5, -57.6, 'out of the depot passage'],
      ];
      let polls = 0;
      let outside = 0;
      const alleyLit = [];
      const sample = async () => {
        const s = await p.stats();
        polls += 1;
        // The west facades stand at |x| 11.5 to 13; past that the operator is in a passage or the alley.
        if (Math.abs(s.feet[0]) > 11.5) outside += 1;
        if (s.feet[0] < -19.5) alleyLit.push(s.lit);
      };
      for (const [x, z, label] of route) {
        if (!(await p.walkTo(`the operator goes ${label}`, x, z, 15, 0.8, null, sample))) return;
      }
      await p.shot('alley-depot-passage');
      await p.walkTo('the operator arrives at the depot wall by the alley', 0, -67.6, 20, 1.5, null, sample);
      const share = outside / Math.max(1, polls);
      p.expect(share > 0.5, `most of the walk is off the street, beyond the facade line (${(share * 100).toFixed(0)}% of ${polls} polls)`);
      // The square is open road under the moon with no lamp near: the street's floor on the meter.
      const meanAlley = alleyLit.reduce((a, b) => a + b, 0) / Math.max(1, alleyLit.length);
      p.expect(alleyLit.length > 0 && meanAlley < streetLit, `the alley reads darker on the visibility meter than the open road at the square (alley ${meanAlley.toFixed(2)} mean, square ${streetLit.toFixed(2)})`);
    },
  },
  {
    name: 'the-overwatch-sees-the-broker',
    describe: 'the fire escape climbs to a catwalk with a clear line down onto the broker, and hostiles can follow up it',
    async run(p) {
      // Rounds pass through for the whole probe: it is about the climb and the
      // sightline, not about the riflemen who see a man on a fire escape and
      // shoot him.
      await p.call('invulnerable', true);
      // The sightline first, while the broker still walks his beat across the
      // street: straight onto the catwalk's far end by teleport. A climb in full
      // view puts the street on alert and him off his beat (the first version of
      // this probe watched him walk over and stand under the catwalk), so the
      // climb is proven separately, below.
      await p.call('teleport', 11.65, -36, 4.5);
      await p.run(0.3);
      // Eye to chest. The ray reports the first body it meets; the line is clear
      // if that is the broker himself (or nothing short of his chest).
      const line = async () => {
        const s = await p.stats();
        const broker = s.enemies.find((e) => e.name === 'Broker' && !e.dead);
        if (!broker) return { broker: null };
        const eye = [s.feet[0], s.feet[1] + 1.6, s.feet[2]];
        const chest = [broker.feet[0], broker.feet[1] + 1.3, broker.feet[2]];
        const hit = await p.call('ray', eye, chest);
        return { broker, hit, clear: hit.eid === null || hit.eid === broker.eid, eye, chest, state: broker.state };
      };
      const seen = await p.until("a clear line from the operator's eye down to the broker's chest", 10, line, (r) => r.broker !== null && r.clear);
      if (seen !== null) {
        const r = await line();
        if (r.broker) {
          const drop = r.eye[1] - r.chest[1];
          const range = Math.hypot(r.eye[0] - r.chest[0], r.eye[2] - r.chest[2]);
          p.expect(drop > 3 && range > 12, `it is a long line from above, across the street onto his beat (${drop.toFixed(1)} m down over ${range.toFixed(0)} m, broker ${r.state})`);
          await p.call('lookAt', r.chest[0], r.chest[1], r.chest[2]);
          await p.call('aim', true);
          await p.run(0.3);
          await p.shot('overwatch-on-the-broker');
          await p.call('aim', false);
        }
      }
      // The climb, walked: from the foot of the stair, up, and along to the far end.
      await p.call('teleport', 11.95, -2.5);
      await p.walkTo('the operator climbs the stair', 11.9, -14.6, 12, 1.0);
      const top = await p.stats();
      p.expect(top.feet[1] > 4.2, `the stair takes the operator up to the catwalk (feet y ${top.feet[1].toFixed(2)})`);
      await p.walkTo('the operator walks the catwalk to its far end, over the broker', 11.65, -36, 15, 1.0);
      const vantage = await p.stats();
      p.expect(vantage.feet[1] > 4.2, `still up there at the far end (feet y ${vantage.feet[1].toFixed(2)})`);
      const follow = await p.call('navPath', [5, 0, -3], [vantage.feet[0], vantage.feet[1], vantage.feet[2]]);
      p.expect(follow.complete, `the navmesh climbs the stair, so a hostile can follow up (${follow.length.toFixed(0)} m)`);
    },
  },
  {
    name: 'mantle-vaults-a-crate',
    describe: 'jump facing a waist-high crate and the operator vaults it; jump in the open and it is still a jump',
    async run(p) {
      // Teleported next to it and immune to rounds: this probe is about the
      // vault, and the crate it picks stands where riflemen can see it.
      await p.call('invulnerable', true);
      const zones = await p.call('mantleZones');
      const crates = zones
        .filter((z) => Math.abs(z.top - 1) < 0.05 && z.maxX - z.minX < 1.1 && z.maxZ - z.minZ < 1.1 && Math.abs((z.minX + z.maxX) / 2) < 8)
        .sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - 1, (a.minZ + a.maxZ) / 2) - Math.hypot((b.minX + b.maxX) / 2 - 1, (b.minZ + b.maxZ) / 2));
      p.expect(zones.length >= 20, `the street marks its low cover as mantle zones (${zones.length})`);
      const crate = crates[0];
      if (!p.expect(Boolean(crate), 'a single crate in the road to vault')) return;
      const cx = (crate.minX + crate.maxX) / 2;
      // Standing still 0.9 m in front of its north face, looking across it: a jump
      // in place cannot carry the operator over, so getting past it is the vault.
      await p.call('teleport', cx, crate.maxZ + 0.9);
      await p.call('lookAt', cx, 0.6, crate.minZ - 4);
      await p.run(0.3);
      // Watched every other frame for a second: the vault is half of that.
      const trace = async (from) => {
        let highest = from.feet[1];
        let vaulted = false;
        for (let i = 0; i < 30; i++) {
          await p.step(2);
          const s = await p.stats();
          highest = Math.max(highest, s.feet[1]);
          vaulted ||= s.mantles > from.mantles;
        }
        return { highest, vaulted };
      };
      const before = await p.stats();
      await p.key('Space');
      const { highest, vaulted } = await trace(before);
      p.expect(vaulted, 'the jump becomes a vault');
      await p.run(0.5);
      const after = await p.stats();
      const beyond = after.feet[2] < crate.minZ;
      const onTop = after.feet[1] > crate.top - 0.1;
      p.expect(beyond || onTop, `the feet end beyond the crate or on it (feet z ${after.feet[2].toFixed(2)}, y ${after.feet[1].toFixed(2)}; crate z ${crate.minZ.toFixed(2)}..${crate.maxZ.toFixed(2)}, top ${crate.top.toFixed(2)})`);
      p.expect(highest > crate.top, `the feet went over the top, not through it (highest ${highest.toFixed(2)})`);
      p.expect(!after.mantling && after.grounded, 'the vault is over and the operator is standing');
      // Open road, nothing to vault: Space is a jump that comes back down where it left.
      await p.call('teleport', 0, 18);
      await p.call('lookAt', 0, 1, 8);
      await p.run(0.4);
      const open = await p.stats();
      await p.key('Space');
      const jump = await trace(open);
      await p.run(0.6);
      const landed = await p.stats();
      p.expect(jump.highest > open.feet[1] + 0.8, `an ordinary jump still leaves the ground (peak ${(jump.highest - open.feet[1]).toFixed(2)} m)`);
      p.expect(!jump.vaulted && landed.mantles === open.mantles, 'and it is not a vault');
      p.expect(Math.hypot(landed.feet[0] - open.feet[0], landed.feet[2] - open.feet[2]) < 0.3 && Math.abs(landed.feet[1] - open.feet[1]) < 0.05, 'and it lands where it took off');
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
