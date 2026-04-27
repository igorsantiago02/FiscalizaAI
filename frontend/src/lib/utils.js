import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';

export function formatDate(value) {
  return new Date(value).toLocaleString('pt-BR');
}

export function fileToDataUrl(file) {
  if (!file) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function isInsidePolygon(lat, lng, polygon) {
  return booleanPointInPolygon(point([Number(lng), Number(lat)]), polygon);
}

export function getLocationLabel(report, config) {
  return report.addressLabel || (report.neighborhood ? `${report.neighborhood} • ${config?.municipalityName || ''}` : (config?.municipalityName || 'Local não informado'));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
