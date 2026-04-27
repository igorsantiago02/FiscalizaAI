import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { PublicApp } from './pages/PublicApp';
import { AdminApp } from './pages/AdminApp';

const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
const isAdmin = pathname === '/admin';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <AdminApp /> : <PublicApp />}
  </React.StrictMode>
);
