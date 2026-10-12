import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/toast';
import './index.css';
import { RequireSession } from './lib/session';
import { BoardPage } from './pages/BoardPage';
import { LoginPage } from './pages/LoginPage';
import { ReleasePage } from './pages/ReleasePage';
import { LocaleProvider } from './lib/i18n';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <ErrorBoundary>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/" element={<RequireSession><BoardPage /></RequireSession>} />
                <Route path="/release" element={<RequireSession><ReleasePage /></RequireSession>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </ErrorBoundary>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
