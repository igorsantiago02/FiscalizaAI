import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8');

const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL ou DATABASE_URL_DIRECT não definido.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

try {
  await pool.query(schema);
  console.log('Migração aplicada com sucesso.');
} finally {
  await pool.end();
}
