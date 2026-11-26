# FiscalizaAI

Plataforma cidadã para registrar e acompanhar problemas urbanos em **São Gonçalo do Amarante/RN**: buraco na via, iluminação pública, lixo, alagamento e mais.

**Acesse:** [fiscaliza-ai-sga.vercel.app](https://fiscaliza-ai-sga.vercel.app) · versão beta em testes públicos

## O que faz

**Para o cidadão**
- Registrar uma ocorrência com categoria, descrição e foto
- Marcar o local no mapa ou buscar pelo CEP, com endereço preenchido automaticamente
- Receber um protocolo e acompanhar o andamento pelo número

**Para a gestão**
- Painel com mapa das ocorrências, filtros e indicadores
- Mudança de status e prioridade, com observações e foto da resolução
- Histórico de auditoria de cada alteração
- Usuários com papéis (`superadmin` e `operator`)
- Relatório em PDF

A plataforma só aceita ocorrências dentro do limite oficial do município, verificado pelo polígono de São Gonçalo do Amarante.

## Tecnologias

| Parte | Stack |
|---|---|
| Frontend | React, Vite, Leaflet (react-leaflet), Recharts, @react-pdf/renderer, Turf.js |
| Backend | Node.js, Express, PostgreSQL, Zod, bcrypt, Helmet, rate limit, Pino |
| Serviços | Cloudinary (fotos), ViaCEP, Nominatim e Geoapify (endereços) |
| Hospedagem | Vercel (frontend) e Render (backend) |

## Segurança

- Senhas com bcrypt, sessão com token de acesso curto e refresh token em cookie `httpOnly`
- Bloqueio de login após tentativas seguidas e limite de requisições
- Validação de todas as entradas com Zod
- Nenhuma senha ou chave fica no código: tudo vem de variáveis de ambiente

## Rodando localmente

Requisitos: Node.js e PostgreSQL.

```bash
npm install
cp backend/.env.example backend/.env   # preencha as variáveis abaixo
npm run dev                            # sobe backend e frontend juntos
```

Variáveis principais do backend:

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Conexão com o PostgreSQL |
| `JWT_SECRET` | Chave das sessões (sem ela, as sessões caem a cada reinício) |
| `ADMIN_EMAIL` e `ADMIN_PASSWORD` | Criam o primeiro administrador (senha com 8 caracteres ou mais) |
| `ALLOWED_ORIGINS` | Endereços do frontend autorizados (CORS) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Envio de fotos |

No frontend, `VITE_API_URL` aponta para o backend.

## Autor

Desenvolvido por **Igor Santiago**, estudante de Engenharia Biomédica na UFRN. [LinkedIn](https://www.linkedin.com/in/igor-santiago-68a74a343/) · [GitHub](https://github.com/igorsantiago02)
