import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/views/game.js', import.meta.url), 'utf8');

function effectHarness() {
  const pickup = source.match(/const awardMapItemPickup = pickedItem => \{([\s\S]*?)\n  \};/)[1];
  const useSkill = source.match(/const onSkillUse = skillId => \{([\s\S]*?)\n  \};/)[1];
  let now = 1000;
  const timers = [];
  const s = {
    gamePhase: 'PLAYING', netMode: 'OFFLINE', myScore: 0,
    stealthUntil: 0, xrayUntil: 0, isStealthActive: false,
    skills: ['stealth', 'xray'].map(id => ({ id, name: id, usesLeft: 3 }))
  };
  const run = new Function('s', 'Date', 'later', `
    const CATNIP_XRAY_MS = 5000, BUSH_DURATION_MS = 5000, TRAP_DURATION_MS = 3000;
    let skillUsed = 0, cheeseMultiplier = 1;
    const renderMarkers = () => {}, renderHud = () => {}, renderSkills = () => {};
    const soundVibration = { playSound() {} }, achievementManager = { recordSkillUse() {} };
    const addSystemMessage = () => {}, showToast = () => {};
    const awardMapItemPickup = pickedItem => {${pickup}\n};
    const onSkillUse = skillId => {${useSkill}\n};
    return { pickup: awardMapItemPickup, skill: onSkillUse };
  `)(s, { now: () => now }, (callback, delay) => timers.push({ callback, at: now + delay }));
  return { ...run, s, advance(ms) {
    now += ms;
    const due = timers.filter(timer => timer.at <= now);
    due.forEach(timer => timers.splice(timers.indexOf(timer), 1));
    due.forEach(timer => timer.callback());
  } };
}

test('bush expiration does not cancel a longer active stealth skill', () => {
  const h = effectHarness();
  h.skill('stealth');
  h.advance(1000);
  h.pickup({ type: 'BUSH' });
  h.advance(5000);
  assert.equal(h.s.stealthUntil, 16000);
  assert.equal(h.s.isStealthActive, true);
  h.advance(9000);
  assert.equal(h.s.stealthUntil, 0);
  assert.equal(h.s.isStealthActive, false);
});

test('picking catnip does not shorten a longer active xray skill', () => {
  const h = effectHarness();
  h.skill('xray');
  h.advance(1000);
  h.pickup({ type: 'CATNIP', score: 5 });
  assert.equal(h.s.xrayUntil, 11000);
  h.advance(5000);
  assert.equal(h.s.xrayUntil, 11000);
  h.advance(4000);
  assert.equal(h.s.xrayUntil, 0);
});

test('old stealth skill timer does not clear a newer stealth activation', () => {
  const h = effectHarness();
  h.skill('stealth');
  h.advance(10000);
  h.skill('stealth');
  h.advance(5000);
  assert.equal(h.s.stealthUntil, 26000);
  assert.equal(h.s.isStealthActive, true);
  h.advance(10000);
  assert.equal(h.s.stealthUntil, 0);
});
