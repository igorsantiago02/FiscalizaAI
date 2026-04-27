import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { pdf } from '@react-pdf/renderer';
import { apiGet, apiSend, clearSession, fetchMe, getStoredUser, loginAdmin, logoutAdmin, setSession } from '../lib/api';
import { fileToDataUrl, formatDate, getLocationLabel, downloadBlob } from '../lib/utils';
import { ReportPdf } from '../pdf/ReportPdf';

const STATUS_COLORS = {
  'Recebida': '#ffb84d',
  'Em análise': '#4f8cff',
  'Encaminhada': '#8b9bff',
  'Em execução': '#61d5ff',
  'Resolvida': '#2dcc8f',
  'Encerrada': '#1fbd75'
};
const PRIORITIES = ['Baixa', 'Média', 'Alta'];
const STATUSES = ['Recebida', 'Em análise', 'Encaminhada', 'Em execução', 'Resolvida', 'Encerrada'];
const ROLES = ['operator', 'superadmin'];

function FitToPolygon({ polygon }) {
  const map = useMap();
  React.useEffect(() => {
    const geom = polygon?.type === 'Feature' ? polygon.geometry : polygon;
    const firstRing = geom?.type === 'MultiPolygon'
      ? geom.coordinates?.[0]?.[0]
      : geom?.coordinates?.[0];
    if (!firstRing?.length) return;
    const latlngs = firstRing.map(([lng, lat]) => [lat, lng]);
    map.fitBounds(latlngs, { padding: [18, 18] });
  }, [map, polygon]);
  return null;
}

const pinCache = new Map();
function createReportPin(status, active = false) {
  const color = STATUS_COLORS[status] || '#4f8cff';
  const key = `${status}-${active ? 'active' : 'normal'}`;
  if (pinCache.has(key)) return pinCache.get(key);
  const size = active ? 38 : 32;
  const stroke = active ? '#ffffff' : 'rgba(255,255,255,0.96)';
  const glow = active ? '0 0 0 6px rgba(77,183,255,0.22)' : '0 0 0 4px rgba(77,183,255,0.12)';
  const svg = `
    <svg width="${size}" height="${size + 10}" viewBox="0 0 44 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <filter id="shadow-${key}" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="6" stdDeviation="4" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <g filter="url(#shadow-${key})">
        <path d="M22 52C22 52 40 34.6 40 22C40 12.1 31.9 4 22 4S4 12.1 4 22c0 12.6 18 30 18 30Z" fill="${color}" stroke="${stroke}" stroke-width="3"/>
        <circle cx="22" cy="22" r="7" fill="#ffffff"/>
      </g>
    </svg>`;
  const icon = new L.DivIcon({
    className: `report-pin-svg-wrapper ${active ? 'active' : ''}`,
    html: `<div class="report-pin-svg" style="filter: drop-shadow(${glow});">${svg}</div>`,
    iconSize: [size, size + 10],
    iconAnchor: [size / 2, size + 8],
    popupAnchor: [0, -(size - 4)]
  });
  pinCache.set(key, icon);
  return icon;
}

function LoginScreen({ onLogin, loading, error }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(e) {
    e.preventDefault();
    onLogin(email, password);
  }

  return (
    <div className="screen center auth-screen">
      <div className="auth-card">
        <img src="/logo.png" alt="FiscalizaAI" className="brand-logo auth-logo" />
        <h1>FiscalizaAI Admin</h1>
        <p>Login administrativo com trilha de auditoria e controle por perfil.</p>
        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>E-mail</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Digite seu e-mail" />
          </label>
          <label>
            <span>Senha</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Digite sua senha" />
          </label>
          <button className="btn-primary" type="submit" disabled={loading}>{loading ? 'Entrando...' : 'Entrar no painel'}</button>
        </form>
        {error ? <div className="form-message">{error}</div> : null}
      </div>
    </div>
  );
}

export function AdminApp() {
  const [auth, setAuth] = useState({ user: getStoredUser(), checked: false, loading: false, error: '' });
  const [config, setConfig] = useState(null);
  const [reports, setReports] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({});
  const [filters, setFilters] = useState({ query: '', status: '', priority: '', neighborhood: '' });
  const [resolutionFile, setResolutionFile] = useState(null);
  const [toast, setToast] = useState('');
  const [saving, setSaving] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'operator' });
  const [creatingUser, setCreatingUser] = useState(false);

  async function refresh() {
    const [cfg, rep, m] = await Promise.all([
      apiGet('/api/config'),
      apiGet('/api/reports', { auth: true }),
      apiGet('/api/metrics')
    ]);
    setConfig(cfg);
    setReports(rep);
    setMetrics(m);
    if (!selectedId && rep.length) setSelectedId(rep[0].id);
  }

  async function loadMeAndData() {
    try {
      const { user } = await fetchMe();
      setAuth((prev) => ({ ...prev, user, checked: true, error: '' }));
      await refresh();
      if (user.role === 'superadmin') await loadUsers();
    } catch {
      clearSession();
      setAuth({ user: null, checked: true, loading: false, error: '' });
    }
  }

  useEffect(() => { loadMeAndData(); }, []);

  async function loadUsers() {
    setLoadingUsers(true);
    try {
      const data = await apiGet('/api/admin/users', { auth: true });
      setUsers(data);
    } finally {
      setLoadingUsers(false);
    }
  }

  async function doLogin(email, password) {
    setAuth((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const { accessToken, user } = await loginAdmin(email, password);
      setSession(accessToken, user);
      setAuth({ user, checked: true, loading: false, error: '' });
      await refresh();
      if (user.role === 'superadmin') await loadUsers();
    } catch (error) {
      setAuth((prev) => ({ ...prev, loading: false, checked: true, error: error.message || 'Falha no login.' }));
    }
  }

  async function logout() {
    try {
      await logoutAdmin();
    } catch {}
    clearSession();
    setReports([]);
    setMetrics(null);
    setConfig(null);
    setSelectedId(null);
    setUsers([]);
    setAuditLogs([]);
    setAuth({ user: null, checked: true, loading: false, error: '' });
  }

  const filtered = useMemo(() => reports.filter((report) => {
    const hay = `${report.id} ${report.category} ${report.description} ${report.neighborhood || ''} ${report.addressLabel || ''}`.toLowerCase();
    return (!filters.query || hay.includes(filters.query.toLowerCase()))
      && (!filters.status || report.status === filters.status)
      && (!filters.priority || report.priority === filters.priority)
      && (!filters.neighborhood || (report.neighborhood || '').toLowerCase().includes(filters.neighborhood.toLowerCase()));
  }), [reports, filters]);

  const selected = useMemo(() => filtered.find((item) => item.id === selectedId) || filtered[0] || null, [filtered, selectedId]);
  const geoJson = useMemo(() => {
    if (!config?.polygon) return null;
    return config.polygon.type === 'Feature' ? config.polygon : { type: 'Feature', geometry: config.polygon, properties: {} };
  }, [config]);

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      setDraft({
        status: selected.status,
        priority: selected.priority,
        adminNote: selected.adminNote || '',
        addressLabel: selected.addressLabel || '',
        postalCode: selected.postalCode || '',
        neighborhood: selected.neighborhood || ''
      });
    }
  }, [selected?.id]);

  useEffect(() => {
    async function loadAudit() {
      if (!selected?.id || !auth.user) return;
      try {
        const data = await apiGet(`/api/reports/${selected.id}/audit-logs`, { auth: true });
        setAuditLogs(data);
      } catch {
        setAuditLogs([]);
      }
    }
    loadAudit();
  }, [selected?.id, auth.user?.id]);

  async function downloadPdf(type) {
    if (!selected || !config) return;
    const logoSrc = window.location.origin + '/logo.svg';
    const blob = await pdf(<ReportPdf report={selected} type={type} config={config} logoSrc={logoSrc} />).toBlob();
    downloadBlob(blob, `${selected.id}-${type === 'mp' ? 'mp' : 'tecnico'}.pdf`);
    setToast(`PDF ${type === 'mp' ? 'para MP' : 'técnico'} baixado.`);
    setTimeout(() => setToast(''), 2000);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const resolutionImageDataUrl = await fileToDataUrl(resolutionFile);
      await apiSend(`/api/reports/${selected.id}`, 'PATCH', { ...draft, resolutionImageDataUrl }, { auth: true });
      setResolutionFile(null);
      await refresh();
      setToast('Ocorrência atualizada com sucesso.');
      setTimeout(() => setToast(''), 2500);
    } catch (error) {
      setToast(error.message || 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function createUser(e) {
    e.preventDefault();
    setCreatingUser(true);
    try {
      await apiSend('/api/admin/users', 'POST', newUser, { auth: true });
      setNewUser({ name: '', email: '', password: '', role: 'operator' });
      await loadUsers();
      setToast('Usuário administrativo criado.');
      setTimeout(() => setToast(''), 2500);
    } catch (error) {
      setToast(error.message || 'Não foi possível criar o usuário.');
    } finally {
      setCreatingUser(false);
    }
  }

  async function updateRole(userId, role) {
    try {
      await apiSend(`/api/admin/users/${userId}/role`, 'PATCH', { role }, { auth: true });
      await loadUsers();
      setToast('Perfil do usuário atualizado.');
      setTimeout(() => setToast(''), 2200);
    } catch (error) {
      setToast(error.message || 'Não foi possível atualizar o perfil.');
    }
  }

  if (!auth.checked) return <div className="screen center">Validando sessão administrativa...</div>;
  if (!auth.user) return <LoginScreen onLogin={doLogin} loading={auth.loading} error={auth.error} />;
  if (!config || !metrics) return <div className="screen center">Carregando painel administrativo...</div>;

  return (
    <div className="screen admin-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <img src="/favicon.ico" alt="FiscalizaAI" className="brand-logo small" />
          <div>
            <h1>FiscalizaAI</h1>
            <p>Painel administrativo • SGA/RN</p>
          </div>
        </div>

        <div className="session-card">
          <strong>{auth.user.name}</strong>
          <span>{auth.user.email}</span>
          <div className="pill-row compact"><span className="pill role-pill">{auth.user.role}</span></div>
          <button className="btn-secondary full-btn" onClick={logout}>Sair</button>
        </div>

        <div className="filters-card">
          <h3>Filtros</h3>
          <input placeholder="Buscar por protocolo, bairro ou descrição" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} />
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Todos os status</option>
            {STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
            <option value="">Todas as prioridades</option>
            {PRIORITIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <input placeholder="Filtrar por bairro" value={filters.neighborhood} onChange={(e) => setFilters({ ...filters, neighborhood: e.target.value })} />
        </div>

        <div className="list-card">
          <h3>Ocorrências</h3>
          <div className="report-list">
            {filtered.map((report) => (
              <button key={report.id} className={`list-item ${selected?.id === report.id ? 'active' : ''}`} onClick={() => setSelectedId(report.id)}>
                <div className="list-top"><strong>{report.id}</strong><span style={{ color: STATUS_COLORS[report.status] }}>{report.status}</span></div>
                <div className="list-title">{report.category}</div>
                <div className="list-sub">{report.neighborhood || 'Sem bairro'} • {formatDate(report.createdAt)}</div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="admin-main">
        <section className="dashboard-grid">
          <div className="metric-card"><span>Ocorrências</span><strong>{metrics.total}</strong></div>
          <div className="metric-card"><span>Alta prioridade</span><strong>{metrics.highPriority}</strong></div>
          <div className="metric-card"><span>Resolvidas</span><strong>{metrics.resolvedCount}</strong></div>
          <div className="metric-card wide"><span>Município</span><strong>{config.municipalityName}</strong></div>
        </section>

        <section className="charts-grid">
          <div className="panel chart-panel">
            <div className="section-head"><h2>Visão executiva</h2><span>Ocorrências por status</span></div>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={metrics.statusCounts} dataKey="value" nameKey="name" innerRadius={70} outerRadius={100} paddingAngle={3}>
                  {metrics.statusCounts.map((entry) => <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#4f8cff'} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="panel chart-panel">
            <div className="section-head"><h2>Mapa de demanda</h2><span>Ocorrências por categoria</span></div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={metrics.categoryCounts} layout="vertical" margin={{ left: 10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={120} />
                <Tooltip />
                <Bar dataKey="value" radius={[8, 8, 8, 8]} fill="#52b6ff" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="work-grid admin-three-col">
          <section className="panel detail-panel">
            {selected ? (
              <>
                <div className="detail-header">
                  <div>
                    <div className="eyebrow">{selected.id}</div>
                    <h2>{selected.category}</h2>
                    <p>{formatDate(selected.createdAt)}</p>
                  </div>
                  <div className="pill-row">
                    <span className="pill status" style={{ background: STATUS_COLORS[selected.status] || '#4f8cff' }}>{selected.status}</span>
                    <span className={`pill priority priority-${selected.priority.toLowerCase()}`}>{selected.priority}</span>
                  </div>
                </div>
                <div className="detail-block">
                  <label>Descrição</label>
                  <div className="detail-text">{selected.description}</div>
                </div>
                <div className="meta-grid">
                  <div className="meta-chip"><span>Denunciante</span><strong>{selected.reporterName || 'Anônimo'}</strong></div>
                  <div className="meta-chip"><span>Localização</span><strong>{getLocationLabel(selected, config)}</strong></div>
                  <div className="meta-chip"><span>CEP</span><strong>{selected.postalCode || 'Não informado'}</strong></div>
                  <div className="meta-chip"><span>Bairro</span><strong>{selected.neighborhood || 'Não informado'}</strong></div>
                </div>
                <div className="form-grid admin-editor">
                  <label><span>Status</span><select value={draft.status || ''} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{STATUSES.map((item) => <option key={item}>{item}</option>)}</select></label>
                  <label><span>Prioridade</span><select value={draft.priority || ''} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>{PRIORITIES.map((item) => <option key={item}>{item}</option>)}</select></label>
                  <label className="full"><span>Localização</span><input value={draft.addressLabel || ''} onChange={(e) => setDraft({ ...draft, addressLabel: e.target.value })} /></label>
                  <label><span>CEP</span><input value={draft.postalCode || ''} onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })} /></label>
                  <label><span>Bairro</span><input value={draft.neighborhood || ''} onChange={(e) => setDraft({ ...draft, neighborhood: e.target.value })} /></label>
                  <label className="full"><span>Nota administrativa</span><textarea rows={5} value={draft.adminNote || ''} onChange={(e) => setDraft({ ...draft, adminNote: e.target.value })} /></label>
                </div>
                <div className="media-grid">
                  <div className="media-card"><span>Imagem enviada</span>{selected.imagePath ? <img src={selected.imagePath} alt="enviada" /> : <div className="media-empty">Sem imagem</div>}</div>
                  <div className="media-card"><span>Imagem de resolução</span>{selected.resolutionImagePath ? <img src={selected.resolutionImagePath} alt="resolução" /> : <div className="media-empty">Nenhuma ainda</div>}</div>
                </div>
                <label className="upload-field"><span>Nova imagem de resolução</span><input type="file" accept="image/*" onChange={(e) => setResolutionFile(e.target.files?.[0] || null)} /></label>
                <div className="detail-actions">
                  <div className="left-actions">
                    <button className="btn-secondary" onClick={() => downloadPdf('technical')}>Baixar PDF técnico</button>
                    <button className="btn-secondary" onClick={() => downloadPdf('mp')}>Baixar PDF para MP</button>
                  </div>
                  <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvando...' : 'Salvar atualização'}</button>
                </div>
              </>
            ) : <div>Nenhuma ocorrência encontrada.</div>}
          </section>

          <section className="panel audit-panel">
            <div className="section-head"><h2>Auditoria</h2><span>Quem alterou o quê</span></div>
            <div className="audit-list">
              {auditLogs.length ? auditLogs.map((entry) => (
                <article key={entry.id} className="audit-item">
                  <div className="audit-top">
                    <strong>{entry.action}</strong>
                    <span>{formatDate(entry.createdAt)}</span>
                  </div>
                  <div className="audit-meta-stack">
                    <div className="audit-meta">{entry.actorEmail || 'Sistema'}</div>
                    <div className="audit-tags">
                      {entry.ipAddress ? <span className="mini-tag">IP: {entry.ipAddress}</span> : null}
                      {entry.userAgent ? <span className="mini-tag">{entry.userAgent.slice(0, 42)}{entry.userAgent.length > 42 ? '…' : ''}</span> : null}
                      {entry.requestId ? <span className="mini-tag">Req: {entry.requestId}</span> : null}
                      {entry.afterPayload?.status ? <span className="mini-tag">Status: {entry.afterPayload.status}</span> : null}
                      {entry.afterPayload?.priority ? <span className="mini-tag">Prioridade: {entry.afterPayload.priority}</span> : null}
                    </div>
                  </div>
                </article>
              )) : <div className="media-empty">Nenhum evento de auditoria para esta ocorrência.</div>}
            </div>
          </section>

          <section className="panel map-panel">
            <div className="section-head"><h2>Mapa operacional</h2><span>Limite oficial completo e pinos por ocorrência</span></div>
            <div className="map-legend">
              {STATUSES.map((status) => (
                <div key={status} className="legend-item">
                  <span className="legend-dot" style={{ background: STATUS_COLORS[status] || '#4f8cff' }} />
                  <small>{status}</small>
                </div>
              ))}
            </div>
            <div className="map-wrap admin-map-wrap">
              <MapContainer center={[config.center.lat, config.center.lng]} zoom={config.zoom} style={{ height: '100%', width: '100%' }}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
                {geoJson ? <GeoJSON data={geoJson} pathOptions={{ color: '#3ba4ff', weight: 3, fillColor: '#3ba4ff', fillOpacity: 0.12 }} /> : null}
                <FitToPolygon polygon={geoJson || config.polygon} />
                {filtered.map((report) => (
                  <Marker
                    key={report.id}
                    position={[report.lat, report.lng]}
                    icon={createReportPin(report.status, report.id === selected?.id)}
                    eventHandlers={{ click: () => setSelectedId(report.id) }}
                  >
                    <Popup>
                      <strong>{report.category}</strong><br />
                      {report.neighborhood || 'Sem bairro'}<br />
                      {report.status}
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          </section>
        </section>

        {auth.user.role === 'superadmin' ? (
          <section className="charts-grid user-admin-grid">
            <section className="panel">
              <div className="section-head"><h2>Usuários admin</h2><span>Níveis de acesso</span></div>
              <div className="users-table">
                {(loadingUsers ? [] : users).map((user) => (
                  <div key={user.id} className="user-row">
                    <div>
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </div>
                    <select value={user.role} onChange={(e) => updateRole(user.id, e.target.value)}>
                      {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                  </div>
                ))}
                {!loadingUsers && !users.length ? <div className="media-empty">Nenhum usuário encontrado.</div> : null}
              </div>
            </section>

            <section className="panel">
              <div className="section-head"><h2>Novo usuário</h2><span>Criar operador ou superadmin</span></div>
              <form className="form-grid" onSubmit={createUser}>
                <label><span>Nome</span><input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></label>
                <label><span>E-mail</span><input value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></label>
                <label><span>Senha</span><input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></label>
                <label><span>Perfil</span><select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
                <button className="btn-primary full" type="submit" disabled={creatingUser}>{creatingUser ? 'Criando...' : 'Criar usuário administrativo'}</button>
              </form>
            </section>
          </section>
        ) : null}
      </main>
      {toast ? <div className="toast-fixed">{toast}</div> : null}
    </div>
  );
}
