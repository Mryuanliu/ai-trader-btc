import axios, { AxiosError } from 'axios';

export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

let tokenGetter: () => string | null = () => null;
let unauthorizedHandler: (() => void) | null = null;

export function configureAuth(params: {
  getToken: () => string | null;
  onUnauthorized?: () => void;
}) {
  tokenGetter = params.getToken;
  unauthorizedHandler = params.onUnauthorized ?? null;
}

http.interceptors.request.use((config) => {
  const token = tokenGetter();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response.data,
  (error: AxiosError<{ message?: string; statusCode?: number }>) => {
    const status = error.response?.status;
    const message =
      error.response?.data?.message ?? error.message ?? '请求失败，请稍后重试';
    if (status === 401) unauthorizedHandler?.();
    return Promise.reject(new Error(Array.isArray(message) ? message.join('; ') : message));
  },
);
