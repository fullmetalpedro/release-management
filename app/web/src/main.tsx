import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
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

// Roteador de dados: é ele que sabe fazer a troca de tela com View Transitions (navigate(..., { viewTransition })).
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RequireSession><BoardPage /></RequireSession> },
  { path: '/release', element: <RequireSession><ReleasePage /></RequireSession> },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <ErrorBoundary>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </ErrorBoundary>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
