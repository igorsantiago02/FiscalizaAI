import { describe, expect, it } from 'vitest';
import { getLocationLabel, isInsidePolygon } from '../src/lib/utils';

const config = { municipalityName: 'São Gonçalo do Amarante/RN' };

describe('getLocationLabel', () => {
  it('usa o endereço quando existe', () => {
    expect(getLocationLabel({ addressLabel: 'Rua A • Centro', neighborhood: 'Centro' }, config)).toBe('Rua A • Centro');
  });

  it('sem endereço, usa bairro e município', () => {
    expect(getLocationLabel({ neighborhood: 'Centro' }, config)).toBe('Centro • São Gonçalo do Amarante/RN');
  });

  it('sem bairro, usa só o município', () => {
    expect(getLocationLabel({}, config)).toBe('São Gonçalo do Amarante/RN');
  });

  it('sem nada, mostra "Local não informado"', () => {
    expect(getLocationLabel({}, null)).toBe('Local não informado');
  });
});

describe('isInsidePolygon', () => {
  const quadrado = { type: 'Polygon', coordinates: [[[-36, -6], [-35, -6], [-35, -5], [-36, -5], [-36, -6]]] };

  it('ponto dentro e fora do polígono (ordem lat, lng)', () => {
    expect(isInsidePolygon(-5.5, -35.5, quadrado)).toBe(true);
    expect(isInsidePolygon(-5.5, -34.5, quadrado)).toBe(false);
  });

  it('aceita coordenadas em texto', () => {
    expect(isInsidePolygon('-5.5', '-35.5', quadrado)).toBe(true);
  });
});
