export interface Env {
  DATABASE_URL: string;
  JWT_SECRET: string;
  CRON_SECRET: string;
  FRONTEND_URL: string;
  VITE_FRONTEND_URL?: string;
  SMTP_HOST?: string;
  VITE_SMTP_HOST?: string;
  SMTP_PORT?: string;
  VITE_SMTP_PORT?: string;
  SMTP_USER?: string;
  VITE_SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  VITE_SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  VITE_SMTP_FROM?: string;
  RESEND_API_KEY?: string;
  VITE_RESEND_API_KEY?: string;
}

export interface UserPayload {
  id: string;
  email: string;
  roles: string[];
}

export type Variables = {
  user?: UserPayload;
};
