import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyPrefs } from './lib/theme';
import './global.css';

// 首次渲染前套用外观偏好，避免深色闪一下再变浅色
applyPrefs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
