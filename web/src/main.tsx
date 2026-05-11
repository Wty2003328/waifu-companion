import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppStyles } from './lib/theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStyles />
    <App />
  </StrictMode>
);
