import React from 'react';
import ReactDOM from 'react-dom/client';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import App from '@/App';

dayjs.locale('zh-cn');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
