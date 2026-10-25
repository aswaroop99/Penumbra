import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { forwardOf, headingDeg, orientation, stepFlight, type FlightInput, type FlightState } from './ship';

const state = (): FlightState => ({
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  bank: 0,
  speed: 0,
  yawRate: 0,
  pitchRate: 0,
  rollRate: 0,
  cruise: 0,
});
const idle: FlightInput = { thrust: 0, turn: 0, climb: 0, boost: false };
const run = (s: FlightState, input: FlightInput, seconds: number, world = { speed: 1 } as { speed: number; bounds?: THREE.Box3 }) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepFlight(s, input, 1 / 60, world);
};

describe('ship flight model', () => {
  it('points along +X at yaw 0 and turns left toward −Z', () => {
    expect(forwardOf(0, 0).toArray()).toEqual([1, 0, -0]);
    const left = forwardOf(Math.PI / 2, 0);
    expect(left.x).toBeCloseTo(0);
    expect(left.z).toBeCloseTo(-1);
    expect(forwardOf(0, 0.5).y).toBeGreaterThan(0);
  });

  it('thrust accelerates toward top speed, boost goes faster, release coasts to cruise', () => {
    const s = state();
    run(s, { ...idle, thrust: 1 }, 4);
    expect(s.speed).toBeGreaterThan(0.95);
    expect(s.speed).toBeLessThanOrEqual(1);
    expect(s.pos.x).toBeGreaterThan(2);
    expect(Math.abs(s.pos.z)).toBeLessThan(1e-9);
    run(s, { ...idle, thrust: 1, boost: true }, 4);
    expect(s.speed).toBeGreaterThan(2);
    s.cruise = 0.3;
    run(s, idle, 5);
    expect(s.speed).toBeCloseTo(0.3, 2);
  });

  it('brake reverses slowly', () => {
    const s = state();
    run(s, { ...idle, thrust: -1 }, 3);
    expect(s.speed).toBeCloseTo(-0.35, 2);
  });

  const axis = (s: FlightState, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(s.quat);

  it('starts from a heading and nose angle with level wings', () => {
    const s = state();
    orientation(Math.PI / 2, 0.4, s.quat);
    expect(axis(s, 1, 0, 0).distanceTo(forwardOf(Math.PI / 2, 0.4))).toBeLessThan(1e-9);
    expect(axis(s, 0, 0, 1).y).toBeCloseTo(0);
  });

  it('turning left yaws toward −Z and dips the left wing', () => {
    const s = state();
    run(s, { ...idle, turn: 1 }, 1);
    expect(axis(s, 1, 0, 0).z).toBeLessThan(-0.5);
    expect(s.bank).toBeLessThan(0);
  });

  it('can loop: holding climb goes past vertical to upside down', () => {
    const s = state();
    let inverted = false;
    for (let t = 0; t < 6; t += 1 / 60) {
      stepFlight(s, { ...idle, climb: 1 }, 1 / 60, { speed: 1 });
      const f = axis(s, 1, 0, 0);
      const u = axis(s, 0, 1, 0);
      if (f.x < -0.9 && u.y < -0.9) inverted = true;
    }
    expect(inverted).toBe(true);
    expect(s.quat.length()).toBeCloseTo(1);
  });

  it('rolls about the nose without changing heading', () => {
    const s = state();
    run(s, { ...idle, roll: 1 }, 0.6);
    expect(axis(s, 0, 1, 0).z).toBeGreaterThan(0.3);
    expect(axis(s, 1, 0, 0).x).toBeCloseTo(1);
  });

  it('reports heading in degrees, increasing with left turns', () => {
    expect(headingDeg(new THREE.Vector3(1, 0, 0))).toBe(0);
    expect(headingDeg(new THREE.Vector3(0, 0, -1))).toBeCloseTo(90);
    expect(headingDeg(new THREE.Vector3(0, 0, 1))).toBeCloseTo(270);
  });

  it('stays inside the bounds and loses speed against a wall', () => {
    const s = state();
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    run(s, { ...idle, thrust: 1, boost: true }, 5, { speed: 1, bounds });
    expect(s.pos.x).toBe(1);
    expect(s.speed).toBeLessThan(1);
  });
});
