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
  TELEGRAM_BOT_TOKEN?: string;
  VITE_TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  VITE_TELEGRAM_CHAT_ID?: string;
}

export interface AccountRank {
  id: string;
  rank_name: string;
  cqm_level: string;
  rank_level: number;
}

export interface UserPayload {
  id: string;
  email: string;
  roles: string[];
  rank_id?: string;
  account_rank?: AccountRank;
}

export type Variables = {
  user?: UserPayload;
};

