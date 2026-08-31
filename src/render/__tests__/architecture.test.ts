import { describe, expect, it } from 'vitest';
import { buildingArchitectureFor } from '../scene';

describe('building architecture', () => {
  it('gives civic and institutional landmarks authored fronts', () => {
    expect(buildingArchitectureFor('townhall', 0, true, 'civic', 0)).toEqual({ facadeFeature: 'civicPortico' });
    expect(buildingArchitectureFor('constabulary', 0, true, 'civic', 0)).toEqual({ facadeFeature: 'watchHouse' });
    expect(buildingArchitectureFor('dispensary', 0, true, 'civic', 0)).toEqual({ facadeFeature: 'dispensaryCanopy' });
    expect(buildingArchitectureFor('chapel', 0, true, 'garden', 0)).toEqual({ facadeFeature: 'chapelFront' });
  });

  it('puts permanent plant and loading fronts on working buildings', () => {
    expect(buildingArchitectureFor('warehouse', 0, false, 'quayside', 0)).toEqual({
      facadeFeature: 'loadingCanopy', roofFeature: 'ventilator',
    });
    expect(buildingArchitectureFor('pumphouse', 0, false, 'works', 0)).toEqual({
      facadeFeature: 'loadingCanopy', roofFeature: 'waterHead',
    });
    expect(buildingArchitectureFor('newspaper', 0, true, 'merchant', 0)).toEqual({
      facadeFeature: 'pressOffice', roofFeature: 'signFrame',
    });
  });

  it('varies repeated dwelling types from stable address salt', () => {
    expect(buildingArchitectureFor('tenement', 0, false, 'courts', 0)).toEqual({ facadeFeature: 'gallery' });
    expect(buildingArchitectureFor('tenement', 2 << 13, false, 'courts', 0)).toEqual({});
    expect(buildingArchitectureFor('courtdwelling', 1 << 15, false, 'courts', 0)).toEqual({ facadeFeature: 'leanTo' });
  });

  it('lets garden terraces acquire porches as the term advances', () => {
    expect(buildingArchitectureFor('terrace', 0, true, 'garden', 0)).toEqual({});
    expect(buildingArchitectureFor('terrace', 0, true, 'garden', 1)).toEqual({ facadeFeature: 'porch' });
    expect(buildingArchitectureFor('terrace', 0, false, 'works', 3)).toEqual({});
  });
});
