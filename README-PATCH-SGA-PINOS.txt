FiscalizaAI React - Patch SGA preciso + pinos

Este patch aplica duas melhorias:
1. usa o GeoJSON completo enviado pelo usuário para o limite oficial de São Gonçalo do Amarante/RN;
2. troca os marcadores do mapa administrativo para pinos de localização.

Arquivos alterados:
- package.json
- backend/server.js
- backend/data/sga-polygon.geojson
- frontend/src/pages/PublicApp.jsx
- frontend/src/pages/AdminApp.jsx
- frontend/src/styles.css
