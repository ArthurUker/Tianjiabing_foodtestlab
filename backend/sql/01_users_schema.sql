-- Food Safety Testing System - User Management Tables
-- Run this script in Supabase SQL Editor to create required tables

-- ====== Create Users Table ======
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' NOT NULL, -- 'user', 'admin', 'manager'
    status VARCHAR(20) DEFAULT 'active' NOT NULL, -- 'active', 'disabled'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    
    CONSTRAINT role_check CHECK (role IN ('user', 'admin', 'manager')),
    CONSTRAINT status_check CHECK (status IN ('active', 'disabled'))
);

-- Create indexes for better performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- ====== Create Login Logs Table ======
CREATE TABLE IF NOT EXISTS login_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL, -- 'success', 'failed'
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Create index for login logs
CREATE INDEX idx_login_logs_user_id ON login_logs(user_id);
CREATE INDEX idx_login_logs_created_at ON login_logs(created_at DESC);

-- ====== Create User Roles Table ======
CREATE TABLE IF NOT EXISTS user_roles (
    id BIGSERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT[], -- Array of permission codes
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default roles
INSERT INTO user_roles (role_name, description, permissions) VALUES
    ('user', '普通用户 - 可以创建和编辑自己的检测记录', ARRAY['view_own_records', 'create_records', 'edit_own_records']),
    ('manager', '部门经理 - 可以管理部门内的所有记录', ARRAY['view_department_records', 'create_records', 'edit_all_records', 'delete_records']),
    ('admin', '系统管理员 - 拥有所有权限', ARRAY['all_permissions'])
ON CONFLICT (role_name) DO NOTHING;

-- ====== Create Audit Logs Table ======
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', etc.
    table_name VARCHAR(100) NOT NULL,
    record_id BIGINT,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Create index for audit logs
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_table_name ON audit_logs(table_name);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ====== Enable Row Level Security ======
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ====== Create RLS Policies ======

-- Users can view their own profile
CREATE POLICY "users_can_view_own_profile" ON users
    FOR SELECT USING (id = current_user_id() OR current_user_role() = 'admin');

-- Users can update their own profile
CREATE POLICY "users_can_update_own_profile" ON users
    FOR UPDATE USING (id = current_user_id());

-- Only admins can view all users
CREATE POLICY "admins_can_view_all_users" ON users
    FOR SELECT USING (current_user_role() = 'admin');

-- Login logs are private
CREATE POLICY "users_can_view_own_login_logs" ON login_logs
    FOR SELECT USING (user_id = current_user_id() OR current_user_role() = 'admin');

-- Audit logs are admin only
CREATE POLICY "audit_logs_admin_only" ON audit_logs
    FOR SELECT USING (current_user_role() = 'admin');

-- ====== Create Functions for Timestamps ======
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for users table
CREATE OR REPLACE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ====== Create Helper Functions ======

-- Function to create a new user
CREATE OR REPLACE FUNCTION create_user_account(
    p_username VARCHAR,
    p_email VARCHAR,
    p_password_hash VARCHAR,
    p_full_name VARCHAR,
    p_role VARCHAR DEFAULT 'user'
)
RETURNS TABLE (
    id BIGINT,
    username VARCHAR,
    email VARCHAR,
    full_name VARCHAR,
    role VARCHAR,
    created_at TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    INSERT INTO users (username, email, password_hash, full_name, role)
    VALUES (p_username, p_email, p_password_hash, p_full_name, p_role)
    RETURNING users.id, users.username, users.email, users.full_name, users.role, users.created_at;
END;
$$ LANGUAGE plpgsql;

-- Function to verify user password
CREATE OR REPLACE FUNCTION verify_user_password(p_username VARCHAR, p_password_hash VARCHAR)
RETURNS TABLE (
    id BIGINT,
    username VARCHAR,
    email VARCHAR,
    full_name VARCHAR,
    role VARCHAR,
    status VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT users.id, users.username, users.email, users.full_name, users.role, users.status
    FROM users
    WHERE users.username = p_username
    AND users.password_hash = p_password_hash
    AND users.status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Function to get user statistics
CREATE OR REPLACE FUNCTION get_user_statistics()
RETURNS TABLE (
    total_users BIGINT,
    active_users BIGINT,
    disabled_users BIGINT,
    admin_count BIGINT,
    manager_count BIGINT,
    user_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_users,
        COUNT(*) FILTER (WHERE status = 'active')::BIGINT as active_users,
        COUNT(*) FILTER (WHERE status = 'disabled')::BIGINT as disabled_users,
        COUNT(*) FILTER (WHERE role = 'admin')::BIGINT as admin_count,
        COUNT(*) FILTER (WHERE role = 'manager')::BIGINT as manager_count,
        COUNT(*) FILTER (WHERE role = 'user')::BIGINT as user_count
    FROM users;
END;
$$ LANGUAGE plpgsql;

-- ====== Create Seed Data ======

-- Insert demo users (passwords are hashed with bcryptjs)
-- Admin password: 8888
-- Manager & User passwords: (as per system default)
INSERT INTO users (username, email, password_hash, full_name, role, status) VALUES
    ('admin', 'admin@foodlab.com', '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m', '系统管理员', 'admin', 'active'),
    ('manager', 'manager@foodlab.com', '$2a$10$YIX7p0yubRH8IqKvK3r.WOYchZbnGUVJvwsqLOSZvZQy7KfVXQcOK', '部门经理', 'manager', 'active'),
    ('user', 'user@foodlab.com', '$2a$10$YIX7p0yubRH8IqKvK3r.WOYchZbnGUVJvwsqLOSZvZQy7KfVXQcOK', '普通员工', 'user', 'active')
ON CONFLICT (username) DO UPDATE SET 
    password_hash = EXCLUDED.password_hash;

-- ====== SQL Validation ======
-- Run these SELECT queries to verify setup:
-- SELECT * FROM users;
-- SELECT * FROM user_roles;
-- SELECT * FROM get_user_statistics();

COMMIT;
