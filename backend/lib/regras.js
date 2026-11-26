// Regras do backend que não dependem de banco de dados nem de rede.
// Ficam aqui (e não no server.js) para poderem ser testadas isoladamente (ver backend/test/).
import crypto from 'node:crypto';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

export class AppError extends Error {
  constructor(message, statusCode = 400, expose = true, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.expose = expose;
    this.code = code;
  }
}

export function badRequest(message) {
  return new AppError(message, 400, true, 'BAD_REQUEST');
}

// ---------------- validação de entrada ----------------

export function criarSchemas(categorias) {
  return {
    loginSchema: z.object({
      email: z.string().trim().email('Informe um e-mail válido.').max(160),
      password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(128)
    }),
    createReportSchema: z.object({
      reporterName: z.string().trim().max(120).optional().default('Anônimo'),
      category: z.string().trim().refine(value => categorias.includes(value), 'Categoria inválida.'),
      description: z.string().trim().min(8, 'Descreva melhor a ocorrência.').max(3000),
      neighborhood: z.string().trim().max(160).optional().default(''),
      addressLabel: z.string().trim().max(240).optional().default(''),
      postalCode: z.string().trim().max(9).optional().default(''),
      street: z.string().trim().max(180).optional().default(''),
      district: z.string().trim().max(160).optional().default(''),
      city: z.string().trim().max(120).optional().default('São Gonçalo do Amarante'),
      imageDataUrl: z.string().optional().default(''),
      lat: z.coerce.number().finite(),
      lng: z.coerce.number().finite(),
      humanConfirmed: z.boolean().optional().default(false),
      honeypot: z.string().optional().default(''),
      formStartedAt: z.string().trim().min(4, 'Tempo do formulário inválido.')
    }),
    updateReportSchema: z.object({
      status: z.enum(['Recebida', 'Em análise', 'Encaminhada', 'Em execução', 'Resolvida', 'Encerrada']).optional(),
      priority: z.enum(['Baixa', 'Média', 'Alta']).optional(),
      adminNote: z.string().max(4000).optional(),
      neighborhood: z.string().max(160).optional(),
      addressLabel: z.string().max(240).optional(),
      postalCode: z.string().max(9).optional(),
      street: z.string().max(180).optional(),
      district: z.string().max(160).optional(),
      city: z.string().max(120).optional(),
      resolutionImageDataUrl: z.string().optional().default('')
    }),
    createAdminUserSchema: z.object({
      name: z.string().trim().min(3).max(140),
      email: z.string().trim().email().max(160),
      password: z.string().min(8).max(128),
      role: z.enum(['superadmin', 'operator']).default('operator')
    }),
    updateRoleSchema: z.object({
      role: z.enum(['superadmin', 'operator'])
    }),
    reverseGeocodeQuerySchema: z.object({
      lat: z.coerce.number().finite(),
      lng: z.coerce.number().finite()
    }),
    lookupCepQuerySchema: z.object({
      cep: z.string().trim().min(8).max(9)
    })
  };
}

export function validateSchema(schema, payload) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message || 'Dados inválidos.', 400, true, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

// ---------------- texto, CEP e prioridade ----------------

export function inferPriority(category, description) {
  const hay = `${category} ${description}`.toLowerCase();
  if (/(risco|acidente|poste|alag|esgoto|buraco|queda|choque)/.test(hay)) return 'Alta';
  if (/(lixo|mato|calçada|animal)/.test(hay)) return 'Média';
  return 'Baixa';
}

export function normalizeSimple(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function cleanCep(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

// ---------------- limite do município ----------------

export function lerPoligono(geojson) {
  const polygon = geojson?.type === 'FeatureCollection'
    ? geojson.features?.[0]?.geometry
    : (geojson?.type === 'Feature' ? geojson.geometry : geojson);
  if (!polygon || !['Polygon', 'MultiPolygon'].includes(polygon.type)) {
    throw new Error('Arquivo sga-polygon.geojson inválido: esperado Polygon ou MultiPolygon.');
  }
  return polygon;
}

export function dentroDoPoligono(polygon, lat, lng) {
  return booleanPointInPolygon(point([Number(lng), Number(lat)]), polygon);
}

// ---------------- tokens de acesso (JWT HS256) ----------------

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function criarJwt(secret) {
  function sign(payload, expiresInSeconds) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(fullPayload));
    const signature = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  function verify(token) {
    if (!token || typeof token !== 'string') throw new Error('Token ausente.');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Token inválido.');
    const [encodedHeader, encodedPayload, signature] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Assinatura inválida.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expirado.');
    return payload;
  }

  return { sign, verify };
}

// ---------------- senhas ----------------

export function hashLegacyPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

export async function hashPassword(password, rounds = 12) {
  return bcrypt.hash(password, rounds);
}

export async function verifyPassword(password, storedHash) {
  const value = String(storedHash || '');
  if (value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$')) {
    return bcrypt.compare(password, value);
  }
  const [scheme, salt, hash] = value.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(derivedKey, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------- fotos enviadas ----------------

export function parseDataUrlImage(dataUrl, { maxBytes, allowedMime }) {
  if (!dataUrl) return null;
  if (typeof dataUrl !== 'string') throw badRequest('Imagem inválida.');
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw badRequest('Formato de imagem inválido.');
  const mime = match[1].toLowerCase();
  if (!allowedMime.includes(mime)) {
    throw badRequest('Formato de imagem não permitido. Use JPG, PNG ou WEBP.');
  }
  const bytes = Buffer.byteLength(match[2], 'base64');
  if (bytes > maxBytes) {
    throw badRequest(`A imagem excede o limite de ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  }
  return { mime, bytes };
}

// ---------------- proteção do formulário público ----------------

export function validatePublicFormGuards(body, { minSeconds, now = Date.now() }) {
  if (String(body.honeypot || '').trim()) {
    throw new AppError('Envio bloqueado por verificação anti-spam.', 400, true, 'SPAM_HONEYPOT');
  }
  const startedAt = Number(body.formStartedAt);
  if (!Number.isFinite(startedAt)) throw badRequest('Sessão do formulário inválida.');
  const elapsed = now - startedAt;
  if (elapsed < minSeconds * 1000) {
    throw new AppError('Envio muito rápido. Revise a ocorrência e tente novamente.', 400, true, 'SPAM_TOO_FAST');
  }
  if (elapsed > 1000 * 60 * 60 * 2) {
    throw new AppError('Formulário expirado. Atualize a página e tente novamente.', 400, true, 'FORM_EXPIRED');
  }
  if (!body.humanConfirmed) {
    throw new AppError('Confirme no popup que você não é um robô.', 400, true, 'HUMAN_CONFIRM_REQUIRED');
  }
}

// ---------------- acompanhamento público ----------------

export function buildPublicStatusMessage(status) {
  const messages = {
    'Recebida': 'Sua ocorrência foi recebida e aguarda triagem.',
    'Em análise': 'Sua ocorrência está em análise pela equipe responsável.',
    'Encaminhada': 'Sua ocorrência foi encaminhada para o setor responsável.',
    'Em execução': 'Sua ocorrência está em fase de atendimento/execução.',
    'Resolvida': 'Sua ocorrência foi marcada como resolvida.',
    'Encerrada': 'Sua ocorrência foi encerrada no sistema.'
  };
  return messages[status] || 'Sua ocorrência está em acompanhamento.';
}
