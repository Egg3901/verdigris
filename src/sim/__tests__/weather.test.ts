import { describe, expect, it } from 'vitest';
import { hashString } from '../rng';
import {
  WEATHER_WATCH_MINUTES, weatherAt, weatherErrandQuota, weatherExposurePenalty,
  weatherFabricWear, weatherOutputPermille,
} from '../weather';
import { newCity, tickCity, warp } from '../city';
import { breakSegment, serviceAt } from '../networks';

describe('derived weather', () => {
  it('is stable throughout a watch and changes revision only at its boundary', () => {
    const seed = hashString('verdigris');
    const a = weatherAt(seed, WEATHER_WATCH_MINUTES + 1);
    const b = weatherAt(seed, WEATHER_WATCH_MINUTES * 2 - 1);
    const c = weatherAt(seed, WEATHER_WATCH_MINUTES * 2);
    expect(b).toEqual(a);
    expect(c.revision).toBe(a.revision + 1);
  });

  it('produces a varied but finite climate across districts and days', () => {
    const seen = new Set<string>();
    for (const name of ['verdigris', 'coppergate', 'jubilee', 'blackwater', 'mercy']) {
      const seed = hashString(name);
      for (let watch = 0; watch < 32; watch++) {
        seen.add(weatherAt(seed, watch * WEATHER_WATCH_MINUTES).kind);
      }
    }
    expect(seen).toEqual(new Set(['fair', 'overcast', 'rain', 'storm', 'fog']));
  });

  it('reduces optional errands without erasing street life', () => {
    const fair = { ...weatherAt(hashString('dry'), 0), kind: 'fair' as const, precipitation: 0 as const };
    const rain = { ...fair, kind: 'rain' as const, precipitation: 1 as const };
    const storm = { ...fair, kind: 'storm' as const, precipitation: 2 as const };
    expect(weatherErrandQuota(13, fair)).toBe(13);
    expect(weatherErrandQuota(13, rain)).toBe(9);
    expect(weatherErrandQuota(13, storm)).toBe(5);
    expect(weatherErrandQuota(1, storm)).toBe(1);
  });

  it('turns rain into wear and lost quay work only through physical exposure', () => {
    const rain = { ...weatherAt(hashString('wet'), 0), kind: 'storm' as const, precipitation: 2 as const };
    expect(weatherFabricWear(rain, true)).toBe(0);
    expect(weatherFabricWear(rain, false)).toBe(2);
    expect(weatherOutputPermille(rain, 'wharf')).toBe(700);
    expect(weatherOutputPermille(rain, 'workshop')).toBe(1000);
  });

  it('keeps an ordinary person above critical warmth through six hours of storm exposure', () => {
    const storm = { ...weatherAt(hashString('wet'), 0), kind: 'storm' as const,
      precipitation: 2 as const, chill: 2 as const };
    const sixHoursOfSlices = 36;
    const ordinaryStart = 600;
    const remaining = ordinaryStart - sixHoursOfSlices * (2 + weatherExposurePenalty(storm));
    expect(remaining).toBeGreaterThan(300);
  });

  it('charges failed-drain wear to the completed watch at a weather boundary', () => {
    const transitionSeed = (fromWet: boolean) => {
      for (let i = 0; i < 1000; i++) {
        const name = `weather-boundary-${fromWet ? 'clear' : 'rain'}-${i}`;
        const seed = hashString(name);
        const before = weatherAt(seed, WEATHER_WATCH_MINUTES - 1).precipitation > 0;
        const after = weatherAt(seed, WEATHER_WATCH_MINUTES).precipitation > 0;
        if (before === fromWet && after !== fromWet) return name;
      }
      throw new Error('weather transition seed missing');
    };
    const measure = (name: string) => {
      const city = newCity(name);
      warp(city, WEATHER_WATCH_MINUTES - 1);
      const building = city.buildings.find((b) => b.drainSeg >= 0
        && b.drainSeg !== city.networks.drain.root && serviceAt(city.networks.drain, b.id));
      if (!building) throw new Error('drained building missing');
      breakSegment(city.networks.drain, building.drainSeg, city.tick);
      city.press.pressures.rot.value = 300;
      city.press.pressures.rot.baseline = 300;
      city.press.pressures.coin.value = 0;
      city.press.pressures.coin.baseline = 0;
      building.fabric = 700;
      const completed = weatherAt(city.seed, city.tick).precipitation;
      tickCity(city);
      return { loss: 700 - building.fabric, completed };
    };
    const clearing = measure(transitionSeed(true));
    const beginning = measure(transitionSeed(false));
    expect(clearing.loss).toBe(3 + clearing.completed);
    expect(beginning.loss).toBe(3);
  });
});
