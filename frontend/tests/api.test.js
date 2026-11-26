// Cliente da API: sessão do painel, renovação automática do login e tratamento de erros.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiSend, clearSession, getStoredUser, getToken, setSession } from '../src/lib/api';

const resposta = (status, corpo) => ({ ok: status < 400, status, json: async () => corpo });
const chamadas = () => fetch.mock.calls.map(([url, op]) => ({ url, auth: op.headers?.Authorization }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('sessão', () => {
  it('guarda e limpa token e usuário', () => {
    setSession('tok-1', { name: 'Ana', role: 'operator' });
    expect(getToken()).toBe('tok-1');
    expect(getStoredUser()).toEqual({ name: 'Ana', role: 'operator' });
    clearSession();
    expect(getToken()).toBe('');
    expect(getStoredUser()).toBeNull();
  });

  it('usuário salvo corrompido não quebra o painel', () => {
    localStorage.setItem('fiscalizaai_admin_user', '{isso não é json');
    expect(getStoredUser()).toBeNull();
  });
});

describe('requisições', () => {
  it('rota pública não envia o token', async () => {
    setSession('tok-1');
    fetch.mockResolvedValue(resposta(200, { ok: true }));
    await apiGet('/api/config');
    expect(chamadas()).toEqual([{ url: 'https://api.teste/api/config', auth: undefined }]);
  });

  it('rota protegida envia o token como Bearer', async () => {
    setSession('tok-1');
    fetch.mockResolvedValue(resposta(200, []));
    await apiGet('/api/reports', { auth: true });
    expect(chamadas()[0].auth).toBe('Bearer tok-1');
  });

  it('envio de dados usa JSON', async () => {
    fetch.mockResolvedValue(resposta(201, { id: 'FISC-1' }));
    await apiSend('/api/report', 'POST', { category: 'Outro' });
    const [, opcoes] = fetch.mock.calls[0];
    expect(opcoes.method).toBe('POST');
    expect(opcoes.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opcoes.body)).toEqual({ category: 'Outro' });
  });

  it('erro do servidor vira exceção com mensagem, status e código', async () => {
    fetch.mockResolvedValue(resposta(400, { error: 'Categoria inválida.', code: 'VALIDATION_ERROR' }));
    await expect(apiSend('/api/report', 'POST', {})).rejects.toMatchObject({
      message: 'Categoria inválida.', status: 400, code: 'VALIDATION_ERROR'
    });
  });

  it('resposta sem JSON ainda gera erro legível', async () => {
    fetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
    await expect(apiGet('/api/metrics')).rejects.toMatchObject({ message: 'Falha em /api/metrics', status: 502 });
  });
});

describe('renovação automática do login', () => {
  it('token vencido (401): renova uma vez e repete a requisição com o token novo', async () => {
    setSession('tok-velho');
    fetch
      .mockResolvedValueOnce(resposta(401, { error: 'Sessão inválida.' }))
      .mockResolvedValueOnce(resposta(200, { accessToken: 'tok-novo', user: { name: 'Ana' } }))
      .mockResolvedValueOnce(resposta(200, [{ id: 'FISC-1' }]));

    await expect(apiGet('/api/reports', { auth: true })).resolves.toEqual([{ id: 'FISC-1' }]);
    expect(chamadas()).toEqual([
      { url: 'https://api.teste/api/reports', auth: 'Bearer tok-velho' },
      { url: 'https://api.teste/api/auth/refresh', auth: undefined },
      { url: 'https://api.teste/api/reports', auth: 'Bearer tok-novo' }
    ]);
    expect(getToken()).toBe('tok-novo');
  });

  it('várias requisições com 401 ao mesmo tempo disparam uma única renovação', async () => {
    setSession('tok-velho');
    fetch.mockImplementation(async (url, op) => {
      if (url.endsWith('/api/auth/refresh')) return resposta(200, { accessToken: 'tok-novo' });
      return op.headers.Authorization === 'Bearer tok-novo' ? resposta(200, { ok: url }) : resposta(401, {});
    });

    await Promise.all([apiGet('/api/reports', { auth: true }), apiGet('/api/admin/users', { auth: true })]);
    expect(chamadas().filter((c) => c.url.endsWith('/api/auth/refresh'))).toHaveLength(1);
  });

  it('se a renovação falhar, encerra a sessão e não fica em laço', async () => {
    setSession('tok-velho', { name: 'Ana' });
    fetch
      .mockResolvedValueOnce(resposta(401, { error: 'Sessão inválida.' }))
      .mockResolvedValueOnce(resposta(401, { error: 'Sessão expirada.' }));

    await expect(apiGet('/api/reports', { auth: true })).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getToken()).toBe('');
    expect(getStoredUser()).toBeNull();
  });
});
