import { describe, expect, it } from 'vitest';
import { buildingArchitectureFor } from '../scene';

describe('building architecture', () => {
  it('gives civic and institutional landmarks authored fronts', () => {
    expect(buildingArchitectureFor('townhall', 0, true, 'civic', 0)).toEqual({ facadeFeature: 'civicPortico' });
    expect(buildingArchitectureFor('constabulary', 0, true, 'civic', 0)).toEqual({
      facadeFeature: 'watchHouse', massingFeature: 'cornerTower',
    });
    expect(buildingArchitectureFor('dispensary', 0, true, 'civic', 0)).toEqual({ facadeFeature: 'dispensaryCanopy' });
    expect(buildingArchitectureFor('chapel', 0, true, 'garden', 0)).toEqual({ facadeFeature: 'chapelFront' });
  });

  it('puts permanent plant and loading fronts on working buildings', () => {
    expect(buildingArchitectureFor('warehouse', 0, false, 'quayside', 0)).toEqual({
      facadeFeature: 'loadingCanopy', roofFeature: 'ventilator', massingFeature: 'gatehouse',
    });
    expect(buildingArchitectureFor('pumphouse', 0, false, 'works', 0)).toEqual({
      facadeFeature: 'loadingCanopy', roofFeature: 'waterHead', massingFeature: 'steppedParapet',
    });
    expect(buildingArchitectureFor('newspaper', 0, true, 'merchant', 0)).toEqual({
      facadeFeature: 'pressOffice', roofFeature: 'signFrame', massingFeature: 'steppedParapet',
    });
  });

  it('varies repeated dwelling types from stable address salt', () => {
    expect(buildingArchitectureFor('tenement', 0, false, 'courts', 0)).toEqual({
      facadeFeature: 'gallery', massingFeature: 'crossGable',
    });
    expect(buildingArchitectureFor('tenement', 2 << 13, false, 'courts', 0)).toEqual({});
    expect(buildingArchitectureFor('courtdwelling', 1 << 15, false, 'courts', 0)).toEqual({ facadeFeature: 'leanTo' });
    expect(buildingArchitectureFor('villa', 0, true, 'garden', 0)).toEqual({ massingFeature: 'cornerTower' });
    expect(buildingArchitectureFor('villa', 1 << 17, true, 'garden', 0)).toEqual({
      facadeFeature: 'porch', massingFeature: 'crossGable',
    });
  });

  it('lets dwellings acquire useful additions as the term advances', () => {
    expect(buildingArchitectureFor('terrace', 0, true, 'garden', 0)).toEqual({});
    expect(buildingArchitectureFor('terrace', 0, true, 'garden', 1)).toEqual({ facadeFeature: 'porch' });
    expect(buildingArchitectureFor('terrace', 0, false, 'works', 3)).toEqual({ additionFeature: 'washhouse' });
    expect(buildingArchitectureFor('courtdwelling', 0, false, 'courts', 0)).toEqual({});
    expect(buildingArchitectureFor('courtdwelling', 0, false, 'courts', 1)).toEqual({
      additionFeature: 'coalShed',
    });
    expect(buildingArchitectureFor('villa', 2 << 17, true, 'garden', 1)).toEqual({ facadeFeature: 'porch' });
    expect(buildingArchitectureFor('villa', 2 << 17, true, 'garden', 2)).toEqual({
      facadeFeature: 'porch', additionFeature: 'glassLeanTo',
    });
  });
});
