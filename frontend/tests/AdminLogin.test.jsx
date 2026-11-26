// Tela de login do painel: sem sessão válida mostra o login, mostra erros e protege a senha.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  clearSession: vi.fn(),
  fetchMe: vi.fn(),
  getStoredUser: vi.fn(() => null),
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn(),
  setSession: vi.fn()
}));
// o gerador de PDF não é usado na tela de login
vi.mock('@react-pdf/renderer', () => ({ pdf: vi.fn() }));
vi.mock('../src/pdf/ReportPdf', () => ({ ReportPdf: () => null }));

const api = await import('../src/lib/api');
const { AdminApp } = await import('../src/pages/AdminApp');

beforeEach(() => {
  vi.clearAllMocks();
  api.getStoredUser.mockReturnValue(null);
  api.fetchMe.mockRejectedValue(new Error('Sessão inválida.'));
});

async function abrirLogin() {
  render(<AdminApp />);
  return screen.findByRole('heading', { name: 'FiscalizaAI Admin' });
}

describe('login do painel', () => {
  it('sem sessão válida mostra a tela de login e limpa a sessão antiga', async () => {
    await abrirLogin();
    expect(screen.getByRole('button', { name: 'Entrar no painel' })).toBeEnabled();
    expect(api.clearSession).toHaveBeenCalled();
  });

  it('envia o e-mail e a senha digitados', async () => {
    const user = userEvent.setup();
    api.loginAdmin.mockRejectedValue(new Error('x'));
    await abrirLogin();

    await user.type(screen.getByPlaceholderText('Digite seu e-mail'), 'ana@prefeitura.rn.gov.br');
    await user.type(screen.getByPlaceholderText('Digite sua senha'), 'senha-forte-123');
    await user.click(screen.getByRole('button', { name: 'Entrar no painel' }));

    expect(api.loginAdmin).toHaveBeenCalledWith('ana@prefeitura.rn.gov.br', 'senha-forte-123');
  });

  it('mostra a mensagem de erro do servidor quando o login falha', async () => {
    const user = userEvent.setup();
    api.loginAdmin.mockRejectedValue(new Error('E-mail ou senha inválidos.'));
    await abrirLogin();

    await user.type(screen.getByPlaceholderText('Digite seu e-mail'), 'ana@prefeitura.rn.gov.br');
    await user.type(screen.getByPlaceholderText('Digite sua senha'), 'errada-123');
    await user.click(screen.getByRole('button', { name: 'Entrar no painel' }));

    expect(await screen.findByText('E-mail ou senha inválidos.')).toBeInTheDocument();
    expect(api.setSession).not.toHaveBeenCalled();
  });

  it('desativa o botão enquanto o login está em andamento (evita envio duplo)', async () => {
    const user = userEvent.setup();
    api.loginAdmin.mockReturnValue(new Promise(() => {}));
    await abrirLogin();

    await user.click(screen.getByRole('button', { name: 'Entrar no painel' }));
    expect(await screen.findByRole('button', { name: 'Entrando...' })).toBeDisabled();
  });

  it('senha fica oculta e o botão do olho mostra e esconde', async () => {
    const user = userEvent.setup();
    await abrirLogin();
    const senha = screen.getByPlaceholderText('Digite sua senha');
    expect(senha).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(senha).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(senha).toHaveAttribute('type', 'password');
  });
});
