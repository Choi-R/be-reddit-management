export interface Env {
  DATABASE_URL: string;
  JWT_SECRET: string;
  CRON_SECRET: string;
}

export interface UserPayload {
  id: string;
  email: string;
  roles: string[];
}

export type Variables = {
  user?: UserPayload;
};
