import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import rateLimit from 'express-rate-limit';
import { v2 as cloudinary } from 'cloudinary';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import pkg from 'pg';
import pino from 'pino';
import pinoHttp from 'pino-http';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AppError extends Error {
  constructor(message, statusCode = 400, expose = true, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.expose = expose;
    this.code = code;
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const DATA_DIR = path.join(__dirname, 'data');
const POLYGON_PATH = path.join(DATA_DIR, 'sga-polygon.geojson');
const reverseGeocodeCache = new Map();
const cepLookupCache = new Map();
const addressSearchCache = new Map();
const failedLogins = new Map();
let reverseGeocodeSequence = Promise.resolve();
let lastReverseGeocodeAt = 0;
let addressSearchSequence = Promise.resolve();
let lastAddressSearchAt = 0;

const ACCESS_TOKEN_TTL_MINUTES = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15);
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);
const LOGIN_BLOCK_MINUTES = Number(process.env.LOGIN_BLOCK_MINUTES || 15);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const PUBLIC_FORM_MIN_SECONDS = Number(process.env.PUBLIC_FORM_MIN_SECONDS || 3);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const polygonSource = JSON.parse(fs.readFileSync(POLYGON_PATH, 'utf-8'));
const polygon = polygonSource?.type === 'FeatureCollection'
  ? polygonSource.features?.[0]?.geometry
  : (polygonSource?.type === 'Feature' ? polygonSource.geometry : polygonSource);

if (!polygon || !['Polygon', 'MultiPolygon'].includes(polygon.type)) {
  throw new Error('Arquivo sga-polygon.geojson inválido: esperado Polygon ou MultiPolygon.');
}

const CONFIG = {
  platformName: 'FiscalizaAI',
  municipalityName: 'São Gonçalo do Amarante/RN',
  center: { lat: -5.7845, lng: -35.355 },
  zoom: 11.6,
  polygon,
  categories: [
    'Buraco na via',
    'Iluminação pública',
    'Lixo acumulado',
    'Esgoto/vazamento',
    'Mato alto',
    'Alagamento/drenagem',
    'Calçada danificada',
    'Animal abandonado',
    'Outro'
  ],
  areaMessage: 'A plataforma opera exclusivamente dentro do limite oficial de São Gonçalo do Amarante/RN.'
};

const ALLOWED_ROLES = ['superadmin', 'operator'];
const ADMIN_BOOTSTRAP = {
  name: process.env.ADMIN_NAME || 'Administrador Principal',
  email: (process.env.ADMIN_EMAIL || 'admin@fiscalizaai.local').trim().toLowerCase(),
  password: process.env.ADMIN_PASSWORD || 'admin123',
  role: ALLOWED_ROLES.includes(process.env.ADMIN_ROLE) ? process.env.ADMIN_ROLE : 'superadmin'
};
const JWT_SECRET = process.env.JWT_SECRET || 'fiscalizaai_dev_secret_change_me';
const AUTH_COOKIE_NAME = 'fiscalizaai_refresh';

const loginSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.').max(160),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(128)
});

const createReportSchema = z.object({
  reporterName: z.string().trim().max(120).optional().default('Anônimo'),
  category: z.string().trim().refine(value => CONFIG.categories.includes(value), 'Categoria inválida.'),
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
});

const updateReportSchema = z.object({
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
});

const createAdminUserSchema = z.object({
  name: z.string().trim().min(3).max(140),
  email: z.string().trim().email().max(160),
  password: z.string().min(8).max(128),
  role: z.enum(['superadmin', 'operator']).default('operator')
});

const updateRoleSchema = z.object({
  role: z.enum(['superadmin', 'operator'])
});

const reverseGeocodeQuerySchema = z.object({
  lat: z.coerce.number().finite(),
  lng: z.coerce.number().finite()
});

const lookupCepQuerySchema = z.object({
  cep: z.string().trim().min(8).max(9)
});

app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new AppError('Origem não autorizada.', 403, true, 'CORS_DENIED'));
  },
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '6mb' }));
app.use(pinoHttp({ logger, genReqId: () => crypto.randomUUID() }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' }
});

const publicReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas ocorrências enviadas em pouco tempo. Aguarde e tente novamente.' }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function badRequest(message) { return new AppError(message, 400, true, 'BAD_REQUEST'); }

function validateSchema(schema, payload) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message || 'Dados inválidos.', 400, true, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '';
}

function getUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 500);
}

function inferPriority(category, description) {
  const hay = `${category} ${description}`.toLowerCase();
  if (/(risco|acidente|poste|alag|esgoto|buraco|queda|choque)/.test(hay)) return 'Alta';
  if (/(lixo|mato|calçada|animal)/.test(hay)) return 'Média';
  return 'Baixa';
}

function normalizeSimple(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function cleanCep(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function invalidCepError() {
  return new AppError('CEP não existe ou está fora da delimitação.', 400, true, 'CEP_INVALID');
}

function isInsideMunicipality(lat, lng) {
  return booleanPointInPolygon(point([Number(lng), Number(lat)]), polygon);
}

async function ensureDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado. Configure o Neon/Postgres antes de iniciar o backend.');
  }
  await pool.query('SELECT 1');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signJwt(payload, expiresInSeconds = ACCESS_TOKEN_TTL_MINUTES * 60) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') throw new Error('Token ausente.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token inválido.');
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Assinatura inválida.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expirado.');
  return payload;
}

function hashLegacyPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, storedHash) {
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

function makeRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setRefreshCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

function buildLocationFallback(lat, lng) {
  return {
    addressLabel: `Ponto selecionado no mapa • ${CONFIG.municipalityName}`,
    postalCode: '',
    street: '',
    district: '',
    city: 'São Gonçalo do Amarante',
    displayName: `Ponto selecionado no mapa • ${CONFIG.municipalityName}`
  };
}

function buildLocationInfoFromAddress(address, lat, lng, displayName = '') {
  const street = address.road || address.pedestrian || address.cycleway || address.residential || address.footway || address.path || '';
  const houseNumber = address.house_number ? `, ${address.house_number}` : '';
  const district = address.suburb || address.neighbourhood || address.city_district || address.village || address.town || address.hamlet || '';
  const city = address.city || address.town || address.village || 'São Gonçalo do Amarante';
  const state = address.state_code || 'RN';
  const postalCode = address.postcode || '';
  const mainLine = street ? `${street}${houseNumber}` : (district || 'Ponto selecionado no mapa');
  return {
    addressLabel: [mainLine, district, `${city}/${state}`].filter(Boolean).join(' • '),
    postalCode,
    street: street ? `${street}${houseNumber}` : '',
    district,
    city,
    displayName: displayName || [mainLine, district, city, state].filter(Boolean).join(', ') || `Ponto selecionado no mapa • ${CONFIG.municipalityName}`
  };
}

async function reverseGeocode(lat, lng) {
  const key = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);

  reverseGeocodeSequence = reverseGeocodeSequence.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastReverseGeocodeAt));
    if (wait) await sleep(wait);
    lastReverseGeocodeAt = Date.now();

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&addressdetails=1&accept-language=pt-BR&countrycodes=br&zoom=18`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FiscalizaAI/4.0 (+local-app)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) throw new Error(`Falha ao buscar endereço: ${response.status}`);
    const json = await response.json();
    const result = buildLocationInfoFromAddress(json.address || {}, lat, lng, json.display_name || '');
    reverseGeocodeCache.set(key, result);
    return result;
  }).catch(() => buildLocationFallback(lat, lng));

  return reverseGeocodeSequence;
}

async function searchAddress(query) {
  const key = String(query || '').trim();
  if (!key) throw invalidCepError();
  if (addressSearchCache.has(key)) return addressSearchCache.get(key);

  addressSearchSequence = addressSearchSequence.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastAddressSearchAt));
    if (wait) await sleep(wait);
    lastAddressSearchAt = Date.now();

    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(key)}&addressdetails=1&accept-language=pt-BR&countrycodes=br`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FiscalizaAI/4.0 (+local-app)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) throw invalidCepError();
    const results = await response.json();
    const first = results?.[0];
    if (!first?.lat || !first?.lon) throw invalidCepError();

    const lat = Number(first.lat);
    const lng = Number(first.lon);
    const result = {
      lat,
      lng,
      displayName: first.display_name || '',
      address: buildLocationInfoFromAddress(first.address || {}, lat, lng, first.display_name || '')
    };
    addressSearchCache.set(key, result);
    return result;
  });

  return addressSearchSequence;
}

async function lookupCep(cep) {
  const clean = cleanCep(cep);
  if (clean.length !== 8) throw invalidCepError();
  if (cepLookupCache.has(clean)) return cepLookupCache.get(clean);

  const viaCepRes = await fetch(`https://viacep.com.br/ws/${clean}/json/`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'FiscalizaAI/4.0 (+local-app)'
    }
  }).catch(() => { throw invalidCepError(); });

  if (!viaCepRes.ok) throw invalidCepError();
  const viaCep = await viaCepRes.json().catch(() => { throw invalidCepError(); });
  if (viaCep?.erro) throw invalidCepError();

  const cityOk = normalizeSimple(viaCep.localidade) === normalizeSimple('São Gonçalo do Amarante')
    && String(viaCep.uf || '').trim().toUpperCase() === 'RN';
  if (!cityOk) throw invalidCepError();

  const query = [viaCep.logradouro, viaCep.bairro, viaCep.localidade, viaCep.uf, clean, 'Brasil']
    .filter(Boolean)
    .join(', ');
  const geo = await searchAddress(query);
  if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lng) || !isInsideMunicipality(geo.lat, geo.lng)) {
    throw invalidCepError();
  }

  const result = {
    postalCode: clean,
    neighborhood: viaCep.bairro || geo.address.district || '',
    district: viaCep.bairro || geo.address.district || '',
    street: viaCep.logradouro || geo.address.street || '',
    city: 'São Gonçalo do Amarante',
    addressLabel: [viaCep.logradouro || geo.address.street || 'Endereço localizado', viaCep.bairro || geo.address.district || '', 'São Gonçalo do Amarante/RN']
      .filter(Boolean)
      .join(' • '),
    displayName: geo.displayName || '',
    lat: geo.lat,
    lng: geo.lng
  };
  cepLookupCache.set(clean, result);
  return result;
}

function normalizeLocationPayload(body) {
  const neighborhood = String(body.neighborhood || body.district || '').trim();
  const city = String(body.city || 'São Gonçalo do Amarante').trim() || 'São Gonçalo do Amarante';
  const street = String(body.street || '').trim();
  const postalCode = String(body.postalCode || '').trim();
  const addressLabel = String(body.addressLabel || '').trim() || [street, neighborhood, `${city}/RN`].filter(Boolean).join(' • ');
  return {
    addressLabel: addressLabel || `Ponto selecionado no mapa • ${CONFIG.municipalityName}`,
    postalCode,
    street,
    district: String(body.district || neighborhood).trim(),
    city,
    neighborhood: neighborhood || 'Não informado',
    displayName: String(body.displayName || addressLabel || `Ponto selecionado no mapa • ${CONFIG.municipalityName}`).trim()
  };
}

function parseDataUrlImage(dataUrl) {
  if (!dataUrl) return null;
  if (typeof dataUrl !== 'string') throw badRequest('Imagem inválida.');
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw badRequest('Formato de imagem inválido.');
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) {
    throw badRequest('Formato de imagem não permitido. Use JPG, PNG ou WEBP.');
  }
  const bytes = Buffer.byteLength(match[2], 'base64');
  if (bytes > MAX_IMAGE_BYTES) {
    throw badRequest(`A imagem excede o limite de ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`);
  }
  return { mime, bytes };
}

async function uploadImageIfPresent(dataUrl, folder) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { url: '', publicId: '' };
  }
  parseDataUrlImage(dataUrl);
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new AppError('Cloudinary não configurado. Defina CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET.', 500, true, 'CLOUDINARY_CONFIG');
  }
  const upload = await cloudinary.uploader.upload(dataUrl, {
    folder,
    resource_type: 'image',
    overwrite: false,
    unique_filename: true
  });
  return { url: upload.secure_url, publicId: upload.public_id };
}

function mapReportRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
    category: row.category,
    description: row.description,
    reporterName: row.reporter_name || row.reporterName,
    neighborhood: row.neighborhood,
    addressLabel: row.address_label || row.addressLabel,
    postalCode: row.postal_code || row.postalCode,
    street: row.street,
    district: row.district,
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    priority: row.priority,
    adminNote: row.admin_note || row.adminNote,
    imagePath: row.image_path || row.imagePath,
    resolutionImagePath: row.resolution_image_path || row.resolutionImagePath
  };
}

async function queryReports() {
  const { rows } = await pool.query(`SELECT * FROM reports ORDER BY created_at DESC`);
  return rows.map(mapReportRow);
}

async function buildMetrics() {
  const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM reports');
  const highPriorityResult = await pool.query(`SELECT COUNT(*)::int AS total FROM reports WHERE priority = 'Alta'`);
  const resolvedResult = await pool.query(`SELECT COUNT(*)::int AS total FROM reports WHERE status IN ('Resolvida', 'Encerrada')`);
  const statusCountsResult = await pool.query(`SELECT status AS name, COUNT(*)::int AS value FROM reports GROUP BY status`);
  const categoryCountsResult = await pool.query(`SELECT category AS name, COUNT(*)::int AS value FROM reports GROUP BY category ORDER BY value DESC, name ASC`);
  const statusOrder = ['Recebida', 'Em análise', 'Encaminhada', 'Em execução', 'Resolvida', 'Encerrada'];
  const statusMap = new Map(statusCountsResult.rows.map(row => [row.name, row.value]));
  return {
    total: totalResult.rows[0]?.total || 0,
    highPriority: highPriorityResult.rows[0]?.total || 0,
    resolvedCount: resolvedResult.rows[0]?.total || 0,
    statusCounts: statusOrder.map(name => ({ name, value: statusMap.get(name) || 0 })),
    categoryCounts: categoryCountsResult.rows
  };
}

async function nextId() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const prefix = `FISC-${yyyy}${mm}${dd}-`;
  const { rows } = await pool.query('SELECT id FROM reports WHERE id LIKE $1 ORDER BY id DESC LIMIT 1', [`${prefix}%`]);
  const lastSeq = rows[0]?.id ? Number(String(rows[0].id).split('-').pop()) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;
}

async function insertAuditLog({ reportId = null, action, beforePayload = null, afterPayload = null, actorEmail = null, actorId = null, ipAddress = null, userAgent = null, requestId = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (report_id, actor_id, actor_email, action, before_payload, after_payload, ip_address, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [reportId, actorId, actorEmail, action, beforePayload, afterPayload, ipAddress, userAgent, requestId]
    );
  } catch (error) {
    logger.warn({ error }, 'Falha ao gravar audit log');
  }
}

async function ensureBootstrapAdmin() {
  const { rows } = await pool.query('SELECT id, email FROM admin_users WHERE email = $1 LIMIT 1', [ADMIN_BOOTSTRAP.email]);
  if (!rows.length) {
    const passwordHash = await hashPassword(ADMIN_BOOTSTRAP.password);
    await pool.query(
      'INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [ADMIN_BOOTSTRAP.name, ADMIN_BOOTSTRAP.email, passwordHash, ADMIN_BOOTSTRAP.role]
    );
    logger.warn({ email: ADMIN_BOOTSTRAP.email }, 'Admin padrão criado. Altere a senha após o primeiro acesso.');
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    const payload = verifyJwt(token);
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at AS "createdAt" FROM admin_users WHERE id = $1 LIMIT 1',
      [payload.sub]
    );
    if (!rows.length) return res.status(401).json({ error: 'Usuário não encontrado.' });
    req.auth = rows[0];
    req.tokenPayload = payload;
    next();
  } catch (_error) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Autenticação obrigatória.' });
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: 'Você não possui permissão para esta ação.' });
    next();
  };
}

function getFailureKey(req, email) {
  return `${getClientIp(req)}::${String(email || '').toLowerCase()}`;
}

function getLoginBlockState(req, email) {
  const key = getFailureKey(req, email);
  const record = failedLogins.get(key);
  if (!record) return { blocked: false, remainingMs: 0, key };
  if (record.blockedUntil && record.blockedUntil > Date.now()) {
    return { blocked: true, remainingMs: record.blockedUntil - Date.now(), key };
  }
  if (record.blockedUntil && record.blockedUntil <= Date.now()) failedLogins.delete(key);
  return { blocked: false, remainingMs: 0, key };
}

function registerLoginFailure(req, email) {
  const key = getFailureKey(req, email);
  const current = failedLogins.get(key) || { count: 0, blockedUntil: 0 };
  current.count += 1;
  if (current.count >= LOGIN_MAX_ATTEMPTS) {
    current.blockedUntil = Date.now() + LOGIN_BLOCK_MINUTES * 60 * 1000;
    current.count = 0;
  }
  failedLogins.set(key, current);
}

function clearLoginFailures(req, email) {
  failedLogins.delete(getFailureKey(req, email));
}

async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL', [hashRefreshToken(rawToken)]);
}

async function createSessionForUser(user, req, res, rotateFromId = null) {
  if (rotateFromId) {
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [rotateFromId]);
  }
  const refreshToken = makeRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshHash, expiresAt.toISOString(), getClientIp(req), getUserAgent(req)]
  );
  setRefreshCookie(res, refreshToken);
  const accessToken = signJwt({ sub: user.id, role: user.role, email: user.email }, ACCESS_TOKEN_TTL_MINUTES * 60);
  return { accessToken, user };
}

function validatePublicFormGuards(body) {
  if (String(body.honeypot || '').trim()) {
    throw new AppError('Envio bloqueado por verificação anti-spam.', 400, true, 'SPAM_HONEYPOT');
  }
  const startedAt = Number(body.formStartedAt);
  if (!Number.isFinite(startedAt)) throw badRequest('Sessão do formulário inválida.');
  const elapsed = Date.now() - startedAt;
  if (elapsed < PUBLIC_FORM_MIN_SECONDS * 1000) {
    throw new AppError('Envio muito rápido. Revise a ocorrência e tente novamente.', 400, true, 'SPAM_TOO_FAST');
  }
  if (elapsed > 1000 * 60 * 60 * 2) {
    throw new AppError('Formulário expirado. Atualize a página e tente novamente.', 400, true, 'FORM_EXPIRED');
  }
  if (!body.humanConfirmed) {
    throw new AppError('Confirme no popup que você não é um robô.', 400, true, 'HUMAN_CONFIRM_REQUIRED');
  }
}

app.get('/api/health', async (_, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'up' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/config', (_, res) => {
  res.json(CONFIG);
});


app.get('/api/reports', requireAuth, async (_, res, next) => {
  try {
    res.json(await queryReports());
  } catch (error) {
    next(error);
  }
});

app.get('/api/metrics', async (_, res, next) => {
  try {
    res.json(await buildMetrics());
  } catch (error) {
    next(error);
  }
});

app.get('/api/reverse-geocode', async (req, res, next) => {
  try {
    const { lat, lng } = validateSchema(reverseGeocodeQuerySchema, req.query);
    const result = await reverseGeocode(lat, lng);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/lookup-cep', async (req, res, next) => {
  try {
    const { cep } = validateSchema(lookupCepQuerySchema, req.query);
    const result = await lookupCep(cleanCep(cep));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = validateSchema(loginSchema, req.body || {});
    const blockState = getLoginBlockState(req, email);
    if (blockState.blocked) {
      throw new AppError(`Muitas tentativas inválidas. Tente novamente em ${Math.ceil(blockState.remainingMs / 60000)} minuto(s).`, 429, true, 'LOGIN_BLOCKED');
    }

    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email]);
    const valid = rows.length ? await verifyPassword(password, rows[0].password_hash) : false;
    if (!rows.length || !valid) {
      registerLoginFailure(req, email);
      await insertAuditLog({
        action: 'auth_login_failed',
        actorEmail: email,
        afterPayload: { email },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        requestId: req.id
      });
      throw new AppError('Credenciais inválidas.', 401, true, 'INVALID_CREDENTIALS');
    }

    clearLoginFailures(req, email);
    if (!String(rows[0].password_hash || '').startsWith('$2')) {
      const newHash = await hashPassword(password);
      await pool.query('UPDATE admin_users SET password_hash = $2, password_changed_at = NOW() WHERE id = $1', [rows[0].id, newHash]);
      rows[0].password_hash = newHash;
    }

    const user = {
      id: rows[0].id,
      name: rows[0].name,
      email: rows[0].email,
      role: rows[0].role,
      createdAt: rows[0].created_at
    };
    const session = await createSessionForUser(user, req, res);
    await insertAuditLog({
      action: 'auth_login_success',
      actorEmail: user.email,
      actorId: user.id,
      afterPayload: { role: user.role },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    res.json(session);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/refresh', async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[AUTH_COOKIE_NAME];
    if (!refreshToken) throw new AppError('Sessão expirada. Faça login novamente.', 401, true, 'REFRESH_MISSING');
    const refreshHash = hashRefreshToken(refreshToken);
    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              au.id AS admin_id, au.name, au.email, au.role, au.created_at AS "createdAt"
         FROM refresh_tokens rt
         JOIN admin_users au ON au.id = rt.user_id
        WHERE rt.token_hash = $1
        LIMIT 1`,
      [refreshHash]
    );
    if (!rows.length) throw new AppError('Sessão expirada. Faça login novamente.', 401, true, 'REFRESH_INVALID');
    const row = rows[0];
    if (row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw new AppError('Sessão expirada. Faça login novamente.', 401, true, 'REFRESH_EXPIRED');
    }
    const user = { id: row.admin_id, name: row.name, email: row.email, role: row.role, createdAt: row.createdAt };
    const session = await createSessionForUser(user, req, res, row.id);
    await insertAuditLog({
      action: 'auth_refresh',
      actorEmail: user.email,
      actorId: user.id,
      afterPayload: { role: user.role },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    res.json(session);
  } catch (error) {
    clearRefreshCookie(res);
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[AUTH_COOKIE_NAME];
    if (refreshToken) await revokeRefreshToken(refreshToken);
    clearRefreshCookie(res);
    await insertAuditLog({
      action: 'auth_logout',
      actorEmail: req.auth?.email || null,
      actorId: req.auth?.id || null,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.auth });
});

app.post('/api/report', publicReportLimiter, async (req, res, next) => {
  try {
    const body = validateSchema(createReportSchema, req.body || {});
    validatePublicFormGuards(body);
    if (!isInsideMunicipality(body.lat, body.lng)) {
      throw new AppError(CONFIG.areaMessage, 400, true, 'OUTSIDE_MUNICIPALITY');
    }

    const reportId = await nextId();
    const locationInfo = normalizeLocationPayload(body);
    const image = await uploadImageIfPresent(body.imageDataUrl, 'fiscalizaai/reports');
    const createdAt = new Date().toISOString();

    const insertSql = `
      INSERT INTO reports (
        id, created_at, updated_at, category, description, reporter_name, neighborhood,
        address_label, postal_code, street, district, city, lat, lng, status, priority,
        admin_note, image_path, image_public_id, resolution_image_path, resolution_image_public_id
      ) VALUES (
        $1, $2, NOW(), $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, 'Recebida', $14,
        'Protocolo gerado automaticamente. Aguardando triagem.', $15, $16, '', ''
      )
      RETURNING *`;

    const { rows } = await pool.query(insertSql, [
      reportId,
      createdAt,
      body.category,
      body.description,
      String(body.reporterName || 'Anônimo').trim() || 'Anônimo',
      locationInfo.neighborhood,
      locationInfo.addressLabel,
      locationInfo.postalCode,
      locationInfo.street,
      locationInfo.district,
      locationInfo.city,
      body.lat,
      body.lng,
      inferPriority(body.category, body.description),
      image.url,
      image.publicId
    ]);

    const mapped = mapReportRow(rows[0]);
    await insertAuditLog({
      reportId,
      action: 'report_created',
      afterPayload: mapped,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    return res.status(201).json(mapped);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/reports/:id', requireAuth, requireRole('superadmin', 'operator'), async (req, res, next) => {
  try {
    const body = validateSchema(updateReportSchema, req.body || {});
    const { rows: foundRows } = await pool.query('SELECT * FROM reports WHERE id = $1 LIMIT 1', [req.params.id]);
    if (!foundRows.length) {
      throw new AppError('Ocorrência não encontrada.', 404, true, 'REPORT_NOT_FOUND');
    }

    const current = foundRows[0];
    let resolutionUpload = { url: current.resolution_image_path || '', publicId: current.resolution_image_public_id || '' };
    if (body.resolutionImageDataUrl) {
      resolutionUpload = await uploadImageIfPresent(body.resolutionImageDataUrl, 'fiscalizaai/resolution');
    }

    const updateSql = `
      UPDATE reports SET
        updated_at = NOW(),
        status = $2,
        priority = $3,
        admin_note = $4,
        neighborhood = $5,
        address_label = $6,
        postal_code = $7,
        street = $8,
        district = $9,
        city = $10,
        resolution_image_path = $11,
        resolution_image_public_id = $12
      WHERE id = $1
      RETURNING *`;

    const { rows } = await pool.query(updateSql, [
      req.params.id,
      body.status || current.status,
      body.priority || current.priority,
      String(body.adminNote ?? current.admin_note ?? '').trim(),
      String(body.neighborhood || current.neighborhood || '').trim(),
      String(body.addressLabel || current.address_label || '').trim(),
      String(body.postalCode || current.postal_code || '').trim(),
      String(body.street || current.street || '').trim(),
      String(body.district || current.district || '').trim(),
      String(body.city || current.city || '').trim(),
      resolutionUpload.url,
      resolutionUpload.publicId
    ]);

    const updated = mapReportRow(rows[0]);
    await insertAuditLog({
      reportId: req.params.id,
      action: 'report_updated',
      beforePayload: mapReportRow(current),
      afterPayload: updated,
      actorEmail: req.auth.email,
      actorId: req.auth.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });

    return res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports/:id/audit-logs', requireAuth, requireRole('superadmin', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, report_id AS "reportId", actor_id AS "actorId", actor_email AS "actorEmail", action,
              before_payload AS "beforePayload", after_payload AS "afterPayload", created_at AS "createdAt",
              ip_address AS "ipAddress", user_agent AS "userAgent", request_id AS "requestId"
         FROM audit_logs
        WHERE report_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', requireAuth, requireRole('superadmin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, email, role, created_at AS "createdAt" FROM admin_users ORDER BY created_at ASC`);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users', requireAuth, requireRole('superadmin'), async (req, res, next) => {
  try {
    const payload = validateSchema(createAdminUserSchema, req.body || {});
    const passwordHash = await hashPassword(payload.password);
    const { rows } = await pool.query(
      `INSERT INTO admin_users (name, email, password_hash, role, password_changed_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, name, email, role, created_at AS "createdAt"`,
      [payload.name, payload.email.toLowerCase(), passwordHash, payload.role]
    );
    await insertAuditLog({
      action: 'admin_user_created',
      actorEmail: req.auth.email,
      actorId: req.auth.id,
      afterPayload: rows[0],
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error?.code === '23505') return next(new AppError('Já existe um usuário com este e-mail.', 409, true, 'USER_DUPLICATE'));
    next(error);
  }
});

app.patch('/api/admin/users/:id/role', requireAuth, requireRole('superadmin'), async (req, res, next) => {
  try {
    const { role } = validateSchema(updateRoleSchema, req.body || {});
    const { rows: beforeRows } = await pool.query('SELECT id, name, email, role, created_at AS "createdAt" FROM admin_users WHERE id = $1 LIMIT 1', [req.params.id]);
    if (!beforeRows.length) throw new AppError('Usuário não encontrado.', 404, true, 'USER_NOT_FOUND');

    const { rows } = await pool.query(
      `UPDATE admin_users SET role = $2 WHERE id = $1
       RETURNING id, name, email, role, created_at AS "createdAt"`,
      [req.params.id, role]
    );
    await insertAuditLog({
      action: 'admin_user_role_updated',
      actorEmail: req.auth.email,
      actorId: req.auth.id,
      beforePayload: beforeRows[0],
      afterPayload: rows[0],
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      requestId: req.id
    });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, _next) => {
  logger.error({ err: error, reqId: req.id }, 'Unhandled error');
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  const message = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor.'
    : (error?.message || 'Erro interno do servidor.');
  return res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
});

Promise.resolve()
  .then(ensureDatabaseReady)
  .then(ensureBootstrapAdmin)
  .then(() => {
   app.listen(PORT, '0.0.0.0', () => {
  logger.info(`FiscalizaAI backend rodando na porta ${PORT}`);
});
  })
  .catch(error => {
    logger.error({ error }, 'Falha ao iniciar backend');
    process.exit(1);
  });
