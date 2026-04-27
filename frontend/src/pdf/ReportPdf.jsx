import React from 'react';
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 30, fontSize: 10, color: '#123', backgroundColor: '#f4f7fb' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#103062', padding: 18, borderRadius: 12, color: '#fff', marginBottom: 20 },
  logoWrap: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 44, height: 44 },
  brand: { fontSize: 22, fontWeight: 700, color: '#fff' },
  brandSub: { fontSize: 11, color: '#d9e6ff' },
  headerBox: { width: 220, backgroundColor: '#173e7e', borderRadius: 12, padding: 12 },
  headerTitle: { fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 6 },
  headerMeta: { color: '#d9e6ff', fontSize: 10, marginBottom: 3 },
  leadTitle: { fontSize: 16, fontWeight: 700, color: '#123166', marginBottom: 8 },
  leadText: { fontSize: 11, lineHeight: 1.5, color: '#294160', marginBottom: 10 },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: '#123166', marginBottom: 10, marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  card: { width: '48.5%', backgroundColor: '#fff', border: '1 solid #d8e2f0', borderRadius: 12, padding: 12, minHeight: 62 },
  cardLabel: { color: '#6a7d9d', fontSize: 9, marginBottom: 4 },
  cardValue: { color: '#10233f', fontSize: 12, fontWeight: 700 },
  box: { backgroundColor: '#fff', border: '1 solid #d8e2f0', borderRadius: 12, padding: 14, marginBottom: 12 },
  boxText: { fontSize: 11, lineHeight: 1.5, color: '#213654' },
  imgGrid: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  imgCard: { width: '48.5%', backgroundColor: '#fff', border: '1 solid #d8e2f0', borderRadius: 12, padding: 12, minHeight: 180 },
  imgLabel: { color: '#123166', fontSize: 11, fontWeight: 700, marginBottom: 8 },
  img: { width: '100%', height: 130, objectFit: 'contain', backgroundColor: '#f3f6fb', borderRadius: 8 },
  empty: { marginTop: 40, textAlign: 'center', color: '#6a7d9d', fontSize: 10 },
  footer: { marginTop: 14, paddingTop: 10, borderTop: '1 solid #d8e2f0', color: '#6a7d9d', fontSize: 9 }
});

const FieldCard = ({ label, value }) => (
  <View style={styles.card}>
    <Text style={styles.cardLabel}>{label}</Text>
    <Text style={styles.cardValue}>{value || 'Não informado'}</Text>
  </View>
);

const EvidenceCard = ({ label, src }) => (
  <View style={styles.imgCard}>
    <Text style={styles.imgLabel}>{label}</Text>
    {src ? <Image src={src} style={styles.img} /> : <Text style={styles.empty}>Nenhuma imagem anexada</Text>}
  </View>
);

export function ReportPdf({ report, type = 'technical', config, logoSrc }) {
  const title = type === 'mp' ? 'Documento para encaminhamento institucional' : 'Relatório técnico da ocorrência';
  const lead = type === 'mp'
    ? 'Documento consolidado para eventual envio ao Ministério Público, secretaria ou órgão de controle, com dados operacionais, administrativos e visuais da ocorrência.'
    : 'Relatório técnico emitido pela plataforma FiscalizaAI com os dados operacionais, administrativos e visuais vinculados à ocorrência selecionada.';

  return (
    <Document title={`${report.id}-${type === 'mp' ? 'mp' : 'tecnico'}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.logoWrap}>
            {logoSrc ? <Image src={logoSrc} style={styles.logo} /> : null}
            <View>
              <Text style={styles.brand}>FiscalizaAI</Text>
              <Text style={styles.brandSub}>{config.municipalityName}</Text>
            </View>
          </View>
          <View style={styles.headerBox}>
            <Text style={styles.headerTitle}>{title}</Text>
            <Text style={styles.headerMeta}>Emissão: {new Date().toLocaleString('pt-BR')}</Text>
            <Text style={styles.headerMeta}>{report.id}</Text>
          </View>
        </View>

        <Text style={styles.leadTitle}>{type === 'mp' ? 'Documento consolidado da ocorrência' : 'Relatório técnico consolidado'}</Text>
        <Text style={styles.leadText}>{lead}</Text>
        <Text style={styles.leadText}>
          Categoria: {report.category}. Localização: {report.addressLabel || `${report.neighborhood} • ${config.municipalityName}`}. Data de registro: {new Date(report.createdAt).toLocaleString('pt-BR')}.
        </Text>

        <Text style={styles.sectionTitle}>Dados consolidados da ocorrência</Text>
        <View style={styles.grid}>
          <FieldCard label="Protocolo" value={report.id} />
          <FieldCard label="Categoria" value={report.category} />
          <FieldCard label="Status atual" value={report.status} />
          <FieldCard label="Prioridade" value={report.priority} />
          <FieldCard label="Denunciante" value={report.reporterName || 'Anônimo'} />
          <FieldCard label="Localização" value={report.addressLabel || 'Não informada'} />
          <FieldCard label="CEP" value={report.postalCode || 'Não informado'} />
          <FieldCard label="Data do registro" value={new Date(report.createdAt).toLocaleString('pt-BR')} />
        </View>

        <Text style={styles.sectionTitle}>Descrição registrada</Text>
        <View style={styles.box}><Text style={styles.boxText}>{report.description || 'Sem descrição.'}</Text></View>

        <Text style={styles.sectionTitle}>Nota administrativa</Text>
        <View style={styles.box}><Text style={styles.boxText}>{report.adminNote || 'Sem atualização administrativa.'}</Text></View>

        <Text style={styles.sectionTitle}>Evidências visuais</Text>
        <View style={styles.imgGrid}>
          <EvidenceCard label="Imagem enviada" src={report.imagePath || ''} />
          <EvidenceCard label="Imagem de resolução" src={report.resolutionImagePath || ''} />
        </View>

        {type === 'mp' ? (
          <>
            <Text style={styles.sectionTitle}>Pedido de apuração</Text>
            <View style={styles.box}>
              <Text style={styles.boxText}>Diante dos elementos descritos neste documento, requer-se a análise dos fatos narrados e a adoção das providências cabíveis pelo órgão destinatário, caso entenda haver indícios suficientes para apuração.</Text>
            </View>
          </>
        ) : null}

        <Text style={styles.footer}>Documento gerado automaticamente pela plataforma FiscalizaAI. As informações refletem os dados registrados no sistema no momento da emissão.</Text>
      </Page>
    </Document>
  );
}
