# FiscalizaAI — Sprint 1 (Neon Postgres + Cloudinary)

Esta versão troca a persistência em JSON por PostgreSQL e move imagens para Cloudinary.

## O que mudou
- Banco de dados: PostgreSQL (Neon)
- Imagens: Cloudinary
- Backend com logs básicos, rate limiting e tratamento central de erro
- Scripts de migração e seed

## Estrutura
- `frontend/` — React + Vite
- `backend/` — API Express
- `backend/schema.sql` — estrutura do banco
- `backend/scripts/migrate.js` — aplica a estrutura no banco
- `backend/scripts/seed-from-json.js` — importa o `backend/data/reports.json` atual para o banco

## 1) Criar banco gratuito no Neon
1. Crie uma conta no Neon
2. Crie um projeto Postgres
3. Copie a `DATABASE_URL`

## 2) Criar conta gratuita no Cloudinary
1. Crie uma conta no Cloudinary
2. Copie:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`

## 3) Configurar variáveis de ambiente
Na pasta `backend/`, copie `.env.example` para `.env` e preencha os valores.

## 4) Instalar dependências
Na raiz:
```bash
npm install
npm --prefix backend install
npm --prefix frontend install
```

## 5) Aplicar o schema no banco
```bash
npm --prefix backend run db:migrate
```

## 6) (Opcional) Importar ocorrências do JSON atual
```bash
npm --prefix backend run db:seed
```

## 7) Rodar localmente
```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Observações
- Se você enviar imagem sem configurar Cloudinary, o backend vai retornar erro.
- Sem `DATABASE_URL`, o backend não inicia.
- O frontend continua usando o mesmo contrato de API, então a maior parte da interface continua funcionando sem retrabalho.

## Próximas sprints sugeridas
- autenticação real de admin
- histórico de auditoria na interface
- deploy em Vercel Functions
- cache distribuído e filas para geração de PDF/notificações
