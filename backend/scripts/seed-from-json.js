import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const reportsPath = path.join(root, 'data', 'reports.json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definido.');
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(reportsPath, 'utf-8'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

const sql = `
INSERT INTO reports (
  id, created_at, updated_at, category, description, reporter_name, neighborhood,
  address_label, postal_code, street, district, city, lat, lng, status, priority,
  admin_note, image_path, resolution_image_path
)
VALUES (
  $1, $2, NOW(), $3, $4, $5, $6,
  $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18
)
ON CONFLICT (id) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  reporter_name = EXCLUDED.reporter_name,
  neighborhood = EXCLUDED.neighborhood,
  address_label = EXCLUDED.address_label,
  postal_code = EXCLUDED.postal_code,
  street = EXCLUDED.street,
  district = EXCLUDED.district,
  city = EXCLUDED.city,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  status = EXCLUDED.status,
  priority = EXCLUDED.priority,
  admin_note = EXCLUDED.admin_note,
  image_path = EXCLUDED.image_path,
  resolution_image_path = EXCLUDED.resolution_image_path,
  updated_at = NOW();`;

try {
  for (const item of rows) {
    await pool.query(sql, [
      item.id,
      item.createdAt || new Date().toISOString(),
      item.category || 'Outro',
      item.description || '',
      item.reporterName || 'Anônimo',
      item.neighborhood || 'Não informado',
      item.addressLabel || `Ponto selecionado no mapa • São Gonçalo do Amarante/RN`,
      item.postalCode || '',
      item.street || '',
      item.district || '',
      item.city || 'São Gonçalo do Amarante',
      Number(item.lat),
      Number(item.lng),
      item.status || 'Recebida',
      item.priority || 'Baixa',
      item.adminNote || 'Protocolo gerado automaticamente. Aguardando triagem.',
      item.imagePath || '',
      item.resolutionImagePath || ''
    ]);
  }
  console.log(`Seed concluído com ${rows.length} ocorrência(s).`);
} finally {
  await pool.end();
}
