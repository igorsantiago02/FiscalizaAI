// Testes das regras do backend (node --test). Não precisam de banco de dados nem de internet.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AppError, criarSchemas, validateSchema, inferPriority, normalizeSimple, cleanCep, lerPoligono,
  dentroDoPoligono, criarJwt, hashPassword, hashLegacyPassword, verifyPassword, parseDataUrlImage,
  validatePublicFormGuards, buildPublicStatusMessage
} from '../lib/regras.js';

const poligono = lerPoligono(JSON.parse(fs.readFileSync(new URL('../data/sga-polygon.geojson', import.meta.url), 'utf8')));
const CATEGORIAS = ['Buraco na via', 'Iluminação pública', 'Outro'];
const schemas = criarSchemas(CATEGORIAS);

const erroCom = (codigo) => (e) => e instanceof AppError && e.code === codigo;

describe('limite do município', () => {
  test('centro de São Gonçalo do Amarante está dentro', () => {
    assert.equal(dentroDoPoligono(poligono, -5.7945, -35.327), true);
  });

  test('Natal (Ponta Negra) e Recife ficam de fora', () => {
    assert.equal(dentroDoPoligono(poligono, -5.8823, -35.1633), false);
    assert.equal(dentroDoPoligono(poligono, -8.0476, -34.877), false);
  });

  test('aceita coordenadas em texto, como chegam do formulário', () => {
    assert.equal(dentroDoPoligono(poligono, '-5.7945', '-35.327'), true);
  });

  test('GeoJSON sem polígono é recusado', () => {
    assert.throws(() => lerPoligono({ type: 'Point', coordinates: [0, 0] }), /inválido/);
  });
});

describe('CEP e texto', () => {
  test('cleanCep deixa só os 8 dígitos', () => {
    assert.equal(cleanCep('59290-000'), '59290000');
    assert.equal(cleanCep(' 59.290-000 extra 123'), '59290000');
    assert.equal(cleanCep(null), '');
  });

  test('normalizeSimple ignora acento, caixa e espaços nas pontas', () => {
    assert.equal(normalizeSimple('  São Gonçalo do Amarante '), 'sao goncalo do amarante');
    assert.equal(normalizeSimple('SÃO GONÇALO DO AMARANTE'), normalizeSimple('São Gonçalo do Amarante'));
  });
});

describe('prioridade automática', () => {
  test('risco à pessoa ou à via vira prioridade Alta', () => {
    assert.equal(inferPriority('Buraco na via', 'grande, no meio da pista'), 'Alta');
    assert.equal(inferPriority('Outro', 'Fio solto com risco de choque'), 'Alta');
  });

  test('lixo, mato e calçada viram Média', () => {
    assert.equal(inferPriority('Lixo acumulado', 'sacos na esquina'), 'Média');
    assert.equal(inferPriority('Calçada danificada', 'pedras soltas'), 'Média');
  });

  test('o resto vira Baixa', () => {
    assert.equal(inferPriority('Outro', 'placa de rua apagada'), 'Baixa');
  });
});

describe('validação de nova ocorrência', () => {
  const valida = {
    category: 'Buraco na via', description: 'Buraco grande na esquina', lat: '-5.79', lng: '-35.33',
    formStartedAt: String(Date.now() - 10_000), humanConfirmed: true
  };

  test('ocorrência válida passa e recebe valores padrão', () => {
    const r = validateSchema(schemas.createReportSchema, valida);
    assert.equal(r.reporterName, 'Anônimo');
    assert.equal(r.city, 'São Gonçalo do Amarante');
    assert.equal(r.lat, -5.79);
  });

  test('categoria fora da lista é recusada', () => {
    assert.throws(() => validateSchema(schemas.createReportSchema, { ...valida, category: 'Qualquer' }),
      (e) => erroCom('VALIDATION_ERROR')(e) && e.message === 'Categoria inválida.');
  });

  test('descrição curta demais é recusada com mensagem clara', () => {
    assert.throws(() => validateSchema(schemas.createReportSchema, { ...valida, description: 'ruim' }),
      (e) => e.message === 'Descreva melhor a ocorrência.');
  });

  test('coordenada que não é número é recusada', () => {
    assert.throws(() => validateSchema(schemas.createReportSchema, { ...valida, lat: 'abc' }), erroCom('VALIDATION_ERROR'));
  });

  test('login exige e-mail válido e senha de 8 caracteres', () => {
    assert.throws(() => validateSchema(schemas.loginSchema, { email: 'sem-arroba', password: '12345678' }),
      (e) => e.message === 'Informe um e-mail válido.');
    assert.throws(() => validateSchema(schemas.loginSchema, { email: 'a@b.com', password: 'curta' }),
      (e) => e.message === 'A senha deve ter pelo menos 8 caracteres.');
  });

  test('só existem os papéis superadmin e operator', () => {
    assert.throws(() => validateSchema(schemas.updateRoleSchema, { role: 'root' }), erroCom('VALIDATION_ERROR'));
    assert.equal(validateSchema(schemas.updateRoleSchema, { role: 'operator' }).role, 'operator');
  });
});

describe('tokens de acesso (JWT)', () => {
  const jwt = criarJwt('segredo-de-teste-bem-comprido');

  test('token emitido é aceito e devolve os dados', () => {
    const dados = jwt.verify(jwt.sign({ sub: 'u1', role: 'operator' }, 60));
    assert.equal(dados.sub, 'u1');
    assert.equal(dados.role, 'operator');
    assert.ok(dados.exp > dados.iat);
  });

  test('token com conteúdo adulterado é recusado', () => {
    const [h, , assinatura] = jwt.sign({ sub: 'u1', role: 'operator' }, 60).split('.');
    const falso = Buffer.from(JSON.stringify({ sub: 'u1', role: 'superadmin', exp: 9999999999 })).toString('base64url');
    assert.throws(() => jwt.verify(`${h}.${falso}.${assinatura}`), /Assinatura inválida/);
  });

  test('token assinado com outra chave é recusado', () => {
    const deOutroServidor = criarJwt('outra-chave').sign({ sub: 'u1' }, 60);
    assert.throws(() => jwt.verify(deOutroServidor), /Assinatura inválida/);
  });

  test('token vencido é recusado', () => {
    assert.throws(() => jwt.verify(jwt.sign({ sub: 'u1' }, -1)), /expirado/);
  });

  test('token ausente ou mal formado é recusado', () => {
    assert.throws(() => jwt.verify(''), /ausente/);
    assert.throws(() => jwt.verify('abc.def'), /inválido/);
  });
});

describe('senhas', () => {
  test('bcrypt: senha certa entra, errada não', async () => {
    const hash = await hashPassword('senha-forte-123', 4);
    assert.notEqual(hash, 'senha-forte-123');
    assert.equal(await verifyPassword('senha-forte-123', hash), true);
    assert.equal(await verifyPassword('senha-errada', hash), false);
  });

  test('senhas antigas em scrypt continuam funcionando', async () => {
    const hash = hashLegacyPassword('senha-antiga-1');
    assert.equal(await verifyPassword('senha-antiga-1', hash), true);
    assert.equal(await verifyPassword('outra', hash), false);
  });

  test('hash vazio ou desconhecido nunca libera acesso', async () => {
    assert.equal(await verifyPassword('qualquer', ''), false);
    assert.equal(await verifyPassword('qualquer', 'md5:abc'), false);
  });
});

describe('foto da ocorrência', () => {
  const opcoes = { maxBytes: 1024, allowedMime: ['image/jpeg', 'image/png', 'image/webp'] };
  const png = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;

  test('sem foto é permitido', () => {
    assert.equal(parseDataUrlImage('', opcoes), null);
  });

  test('PNG dentro do limite é aceito', () => {
    assert.deepEqual(parseDataUrlImage(png(100), opcoes), { mime: 'image/png', bytes: 100 });
  });

  test('foto acima do limite é recusada', () => {
    assert.throws(() => parseDataUrlImage(png(2048), opcoes), /excede o limite/);
  });

  test('formato não permitido (SVG) é recusado', () => {
    assert.throws(() => parseDataUrlImage('data:image/svg+xml;base64,PHN2Zz4=', opcoes), /não permitido/);
  });

  test('conteúdo que não é imagem em base64 é recusado', () => {
    assert.throws(() => parseDataUrlImage('javascript:alert(1)', opcoes), /inválido/);
  });
});

describe('proteção anti-spam do formulário público', () => {
  const agora = 1_800_000_000_000;
  const corpo = { formStartedAt: String(agora - 30_000), humanConfirmed: true };

  test('envio normal passa', () => {
    assert.doesNotThrow(() => validatePublicFormGuards(corpo, { minSeconds: 3, now: agora }));
  });

  test('campo isca preenchido (robô) é bloqueado', () => {
    assert.throws(() => validatePublicFormGuards({ ...corpo, honeypot: 'spam' }, { minSeconds: 3, now: agora }), erroCom('SPAM_HONEYPOT'));
  });

  test('envio rápido demais é bloqueado', () => {
    assert.throws(() => validatePublicFormGuards({ ...corpo, formStartedAt: String(agora - 1000) }, { minSeconds: 3, now: agora }),
      erroCom('SPAM_TOO_FAST'));
  });

  test('formulário aberto há mais de 2 horas expira', () => {
    assert.throws(() => validatePublicFormGuards({ ...corpo, formStartedAt: String(agora - 3 * 3600_000) }, { minSeconds: 3, now: agora }),
      erroCom('FORM_EXPIRED'));
  });

  test('sem confirmar "não sou robô" é bloqueado', () => {
    assert.throws(() => validatePublicFormGuards({ ...corpo, humanConfirmed: false }, { minSeconds: 3, now: agora }),
      erroCom('HUMAN_CONFIRM_REQUIRED'));
  });
});

describe('acompanhamento público', () => {
  test('cada status tem uma mensagem para o cidadão', () => {
    for (const status of ['Recebida', 'Em análise', 'Encaminhada', 'Em execução', 'Resolvida', 'Encerrada']) {
      assert.match(buildPublicStatusMessage(status), /^Sua ocorrência/);
    }
  });

  test('status desconhecido recebe mensagem genérica', () => {
    assert.equal(buildPublicStatusMessage('???'), 'Sua ocorrência está em acompanhamento.');
  });
});
