import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyPrefs } from './lib/theme';
import './global.css';

// 首次渲染前套用导航偏好，避免顶部/侧栏样式闪一下
applyPrefs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
