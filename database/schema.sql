-- Database Schema: Reddit Account Management CRM
-- Database Provider: Neon Postgres (Serverless)

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -------------------------------------------------------------
-- 1. Helper function for updating updated_at timestamp automatically
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- 2. Create Tables
-- -------------------------------------------------------------

-- Table: roles
CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    role_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Table: users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, -- Format: salt:sha256_hash
    paypal TEXT,
    reddit TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Table: user_roles
CREATE TABLE user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    role_id TEXT REFERENCES roles(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(user_id, role_id)
);

-- Table: task_types
CREATE TABLE task_types (
    id TEXT PRIMARY KEY,
    type_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Table: task_status
CREATE TABLE task_status (
    id TEXT PRIMARY KEY,
    status_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Table: tasks
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subreddit TEXT,
    url TEXT NOT NULL,
    client_request TEXT NOT NULL,
    quota INTEGER CHECK (quota >= 0) NOT NULL,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL,
    deadline TIMESTAMPTZ,
    type_id TEXT REFERENCES task_types(id) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Table: user_tasks
CREATE TABLE user_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE NOT NULL,
    status_id TEXT REFERENCES task_status(id) DEFAULT 'incomplete' NOT NULL,
    reply_url TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(user_id, task_id) -- User cannot perform the same task more than once
);

-- -------------------------------------------------------------
-- 3. Create Triggers for updated_at Autoupdate
-- -------------------------------------------------------------
CREATE TRIGGER update_roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_roles_updated_at BEFORE UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_task_types_updated_at BEFORE UPDATE ON task_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_task_status_updated_at BEFORE UPDATE ON task_status FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_tasks_updated_at BEFORE UPDATE ON user_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- -------------------------------------------------------------
-- 4. Create Indexes for Scaling to 100+ Accounts
-- -------------------------------------------------------------
CREATE INDEX idx_user_tasks_user_status ON user_tasks(user_id, status_id);
CREATE INDEX idx_user_tasks_task ON user_tasks(task_id);
CREATE INDEX idx_tasks_quota_deadline ON tasks(quota, deadline);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);

-- -------------------------------------------------------------
-- 5. Seed Initial Lookup Tables & Default Admin User
-- -------------------------------------------------------------

INSERT INTO roles (id, role_name) VALUES
('admin', 'Admin'),
('basic', 'Basic'),
('choi', 'Choi'),
('bronze', 'Bronze'),
('silver', 'Silver'),
('gold', 'Gold');

-- Seed: task_types
INSERT INTO task_types (id, type_name) VALUES
('normal', 'Normal'),
('edu_app', 'Edu App');

-- Seed: task_status
INSERT INTO task_status (id, status_name) VALUES
('incomplete', 'Incomplete'),
('pending', 'Pending'),
('success', 'Success'),
('paid', 'Paid'),
('failed', 'Failed');

-- Seed: Default Admin User
-- Email: admin@redditcrm.com
-- Password Raw: AdminCRM2026!
-- Salt: seedsalt1234
-- Salted Hash (SHA-256 of "AdminCRM2026!seedsalt1234"): 4e70ac59642235767de4e7d27a8ebedec466d9ad9b40cf0acbdc746e44939d82
-- Final password entry format: seedsalt1234:4e70ac59642235767de4e7d27a8ebedec466d9ad9b40cf0acbdc746e44939d82
INSERT INTO users (id, email, password, paypal, reddit) VALUES
('a0e86950-8b1e-450f-a7b3-241517454f00', 'admin@redditcrm.com', 'seedsalt1234:4e70ac59642235767de4e7d27a8ebedec466d9ad9b40cf0acbdc746e44939d82', 'admin@paypal.com', 'reddit_admin');

-- Associate user with 'admin' role
INSERT INTO user_roles (user_id, role_id) VALUES
('a0e86950-8b1e-450f-a7b3-241517454f00', 'admin');

-- Seed: Rahmaditya Admin User (Password Raw: rahmadityac@gmail.com)
INSERT INTO users (id, email, password, paypal, reddit) VALUES
('b1e86950-8b1e-450f-a7b3-241517454f01', 'rahmadityac@gmail.com', 'seedsalt1234:a7c0e615071295699d004477d022eed1dbb9bfcb70ada633e3867b2905d23d69', NULL, 'reddit_rahmadityac');

INSERT INTO user_roles (user_id, role_id) VALUES
('b1e86950-8b1e-450f-a7b3-241517454f01', 'admin');

-- Seed: Kellirun Admin User (Password Raw: kb.kellirun@gmail.com)
INSERT INTO users (id, email, password, paypal, reddit) VALUES
('c1e86950-8b1e-450f-a7b3-241517454f02', 'kb.kellirun@gmail.com', 'seedsalt1234:a3c4eb604947b1910a9a501ce3ab02df71b885126fa38046c96cca5f42484af9', NULL, 'reddit_kb_kellirun');

INSERT INTO user_roles (user_id, role_id) VALUES
('c1e86950-8b1e-450f-a7b3-241517454f02', 'admin');

-- -------------------------------------------------------------
-- 6. Password Reset Tokens Table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT REFERENCES users(email) ON DELETE CASCADE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_password_resets_token ON password_resets(token);
CREATE INDEX idx_password_resets_expires ON password_resets(expires_at);

