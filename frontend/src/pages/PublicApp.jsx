import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { apiGet, apiSend } from '../lib/api';
import { fileToDataUrl, isInsidePolygon } from '../lib/utils';

const selectedMarkerIcon = new L.DivIcon({
  className: 'selected-pin-wrapper',
  html: '<div class="selected-pin"><span class="selected-pin-dot"></span></div>',
  iconSize: [28, 38],
  iconAnchor: [14, 38]
});

function FitToPolygon({ polygon }) {
  const map = useMap();
  React.useEffect(() => {
    const geom = polygon?.type === 'Feature' ? polygon.geometry : polygon;
    const firstRing = geom?.type === 'MultiPolygon' ? geom.coordinates?.[0]?.[0] : geom?.coordinates?.[0];
    if (!firstRing?.length) return;
    const latlngs = firstRing.map(([lng, lat]) => [lat, lng]);
    map.fitBounds(latlngs, { padding: [18, 18] });
  }, [map, polygon]);
  return null;
}

function MapClickHandler({ onSelect }) {
  useMapEvents({ click: (e) => onSelect(e.latlng) });
  return null;
}

function emptyForm() {
  return {
    reporterName: 'Anônimo',
    category: '',
    description: '',
    neighborhood: '',
    addressLabel: '',
    postalCode: '',
    street: '',
    district: '',
    city: 'São Gonçalo do Amarante',
    honeypot: ''
  };
}

export function PublicApp() {
  const [config, setConfig] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('Selecione um ponto no mapa dentro do limite oficial do município.');
  const [form, setForm] = useState(emptyForm());
  const [formStartedAt, setFormStartedAt] = useState(String(Date.now()));
  const [submitting, setSubmitting] = useState(false);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const lastCepLookupRef = useRef('');
  const cepLookupTimerRef = useRef(null);

  useEffect(() => {
    Promise.all([apiGet('/api/config'), apiGet('/api/metrics')]).then(([cfg, m]) => {
      setConfig(cfg);
      setMetrics(m);
    }).catch(() => {
      setMessage('Não foi possível carregar a plataforma neste momento.');
    });
  }, []);

  const geoJson = useMemo(() => {
    if (!config?.polygon) return null;
    return config.polygon.type === 'Feature' ? config.polygon : { type: 'Feature', geometry: config.polygon, properties: {} };
  }, [config]);

  function resetCepAutofill(keepPostalCode = true) {
    setForm(prev => ({
      ...prev,
      neighborhood: '',
      addressLabel: '',
      street: '',
      district: '',
      city: 'São Gonçalo do Amarante',
      postalCode: keepPostalCode ? prev.postalCode : ''
    }));
    setSelected(null);
  }

  function handlePostalCodeChange(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    const formatted = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
    setForm(prev => ({ ...prev, postalCode: formatted }));
  }

  async function handleSelect(latlng) {
    if (!config) return;
    if (!isInsidePolygon(latlng.lat, latlng.lng, config.polygon)) {
      setMessage('Ponto fora da área operacional. Escolha um local dentro do limite oficial de São Gonçalo do Amarante/RN.');
      return;
    }
    setSelected(latlng);
    setMessage('Ponto válido selecionado. Buscando endereço do local...');
    try {
      const data = await apiGet(`/api/reverse-geocode?lat=${latlng.lat}&lng=${latlng.lng}`);
      setForm(prev => ({
        ...prev,
        neighborhood: prev.neighborhood || data.district || prev.neighborhood,
        addressLabel: data.addressLabel || `Ponto selecionado no mapa • ${config.municipalityName}`,
        postalCode: data.postalCode || prev.postalCode || '',
        street: data.street || '',
        district: data.district || '',
        city: data.city || 'São Gonçalo do Amarante'
      }));
      setMessage('Endereço localizado. Revise os dados e envie a ocorrência.');
    } catch {
      setForm(prev => ({
        ...prev,
        addressLabel: `Ponto selecionado no mapa • ${config.municipalityName}`,
        city: 'São Gonçalo do Amarante'
      }));
      setMessage('Não foi possível localizar o endereço automaticamente, mas você já pode enviar a ocorrência.');
    }
  }

  useEffect(() => {
    const digits = String(form.postalCode || '').replace(/\D/g, '').slice(0, 8);
    if (!digits) {
      lastCepLookupRef.current = '';
      if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
      return undefined;
    }
    if (digits.length < 8) {
      if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
      return undefined;
    }
    if (digits === lastCepLookupRef.current) return undefined;
    if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);

    cepLookupTimerRef.current = setTimeout(async () => {
      try {
        setMessage('Validando CEP e preenchendo endereço...');
        const data = await apiGet(`/api/lookup-cep?cep=${digits}`);
        lastCepLookupRef.current = digits;
        setSelected({ lat: data.lat, lng: data.lng });
        setForm(prev => ({
          ...prev,
          postalCode: data.postalCode ? `${String(data.postalCode).slice(0, 5)}-${String(data.postalCode).slice(5)}` : prev.postalCode,
          neighborhood: data.neighborhood || prev.neighborhood,
          addressLabel: data.addressLabel || prev.addressLabel,
          street: data.street || prev.street,
          district: data.district || prev.district,
          city: data.city || prev.city
        }));
        setMessage('CEP validado e endereço preenchido automaticamente.');
      } catch (error) {
        lastCepLookupRef.current = '';
        resetCepAutofill(true);
        setMessage(error.message || 'CEP não existe ou está fora da delimitação.');
      }
    }, 450);

    return () => {
      if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
    };
  }, [form.postalCode]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selected) {
      setMessage('Selecione um ponto no mapa antes de enviar.');
      return;
    }
    setSubmitting(true);
    try {
     
      const imageDataUrl = await fileToDataUrl(file);
      await apiSend('/api/report', 'POST', {
        ...form,
        lat: selected.lat,
        lng: selected.lng,
        imageDataUrl,
    
        formStartedAt
      });
      setMessage('Ocorrência enviada com sucesso.');
      setForm(emptyForm());
      setFile(null);
      setFileInputKey(prev => prev + 1);
      setSelected(null);
      lastCepLookupRef.current = '';
      setMetrics(await apiGet('/api/metrics'));
    } catch (error) {
      setMessage(error.message || 'Não foi possível enviar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!config) return <div className="screen center">Carregando FiscalizaAI...</div>;

  return (
    <div className="screen public-shell">
      <header className="hero">
        <div className="overlay" />
        <img className="hero-bg" src="/SGA.jpg" alt="São Gonçalo do Amarante" />
        <div className="hero-content">
          <div className="brand-row">
            <img src="/logo.png" alt="FiscalizaAI" className="brand-logo" />
            <div>
              <h1>FiscalizaAI</h1>
              <p>Plataforma cidadã de ocorrências urbanas • São Gonçalo do Amarante/RN</p>
            </div>
          </div>
          <div className="hero-kpis">
            <div className="glass-card"><span>Ocorrências</span><strong>{metrics?.total ?? 0}</strong></div>
            <div className="glass-card"><span>Alta prioridade</span><strong>{metrics?.highPriority ?? 0}</strong></div>
            <div className="glass-card"><span>Resolvidas</span><strong>{metrics?.resolvedCount ?? 0}</strong></div>
          </div>
        </div>
      </header>

      <main className="content two-col">
        <section className="panel">
          <div className="section-head">
            <h2>Área oficial de atuação</h2>
            <span>{config.areaMessage}</span>
          </div>
          <div className="map-wrap">
            <MapContainer center={[config.center.lat, config.center.lng]} zoom={config.zoom} style={{ height: '100%', width: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
              <GeoJSON data={geoJson} pathOptions={{ color: '#3ba4ff', weight: 3, fillColor: '#3ba4ff', fillOpacity: 0.12 }} />
              <FitToPolygon polygon={config.polygon} />
              <MapClickHandler onSelect={handleSelect} />
              {selected ? <Marker position={[selected.lat, selected.lng]} icon={selectedMarkerIcon} /> : null}
            </MapContainer>
          </div>
         
        </section>

        <section className="panel">
          <div className="section-head">
            <h2>Registrar ocorrência</h2>
            <span>O protocolo fica restrito ao município delimitado no mapa.</span>
          </div>
          <form className="form-grid" onSubmit={handleSubmit}>
            <label>
              <span>Denunciante</span>
              <input value={form.reporterName} onChange={(e) => setForm({ ...form, reporterName: e.target.value })} placeholder="Anônimo" maxLength={120} />
            </label>
            <label>
              <span>Categoria</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="">Selecione</option>
                {config.categories.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="full">
              <span>Descrição</span>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Descreva a ocorrência com clareza." rows={5} maxLength={3000} />
            </label>
            <label>
              <span>Bairro / referência</span>
              <input value={form.neighborhood} onChange={(e) => setForm({ ...form, neighborhood: e.target.value })} placeholder="Ex.: Jardins" maxLength={160} />
            </label>
            <label>
              <span>CEP</span>
              <input value={form.postalCode} onChange={(e) => handlePostalCodeChange(e.target.value)} placeholder="Ex.: 59290-000" maxLength={9} />
            </label>
            <label className="full">
              <span>Localização identificada</span>
              <input value={form.addressLabel} onChange={(e) => setForm({ ...form, addressLabel: e.target.value })} placeholder="Clique no mapa para preencher" maxLength={240} />
            </label>
            <label>
              <span>Rua / logradouro</span>
              <input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} placeholder="Rua, avenida ou referência" maxLength={180} />
            </label>
            <label>
              <span>Imagem da ocorrência</span>
             <input key={fileInputKey} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)}
/>
            </label>
            <label className="hp-field" aria-hidden="true" tabIndex={-1}>
              <span>Website</span>
              <input value={form.honeypot} onChange={(e) => setForm({ ...form, honeypot: e.target.value })} autoComplete="off" tabIndex={-1} />
            </label>
            <button type="submit" className="btn-primary submit-report-btn" disabled={submitting}>{submitting ? 'Enviando...' : 'Enviar ocorrência'}</button>
          </form>
          <div className="form-message">{message}</div>
        </section>
      </main>
    </div>
  );
}
