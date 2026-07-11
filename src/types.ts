export interface Env {
  DATABASE_URL: string;
  JWT_SECRET: string;
  CRON_SECRET: string;
  FRONTEND_URL: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  RESEND_API_KEY?: string;
}

export interface UserPayload {
  id: string;
  email: string;
  roles: string[];
}

export type Variables = {
  user?: UserPayload;
};
