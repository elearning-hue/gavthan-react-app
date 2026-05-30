// ============================================================================
// main.js — Vite entry point.
//
// app.js imports ./config-init.js first (which populates window.GH_CONFIG from
// env), so a plain static import here is safe — config is set before app.js's
// top-level code runs. We import Root and mount with the React 18 createRoot API.
// ============================================================================
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Root } from './app.js';

createRoot(document.getElementById('root')).render(React.createElement(Root, null));
