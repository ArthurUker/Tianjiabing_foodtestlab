-- Food Safety Testing System - Guest Management Tables
-- Run this script in Supabase SQL Editor to create guest-related tables

-- ====== Create Guests Table ======
CREATE TABLE IF NOT EXISTS guests (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    guest_type VARCHAR(20) DEFAULT 'viewer' NOT NULL, -- 'viewer' (只读), 'export_applicant' (可申请导出)
    status VARCHAR(20) DEFAULT 'active' NOT NULL, -- 'active', 'disabled', 'expired'
    has_export_permission BOOLEAN DEFAULT false, -- 已获得导出权限
    valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP NOT NULL, -- 访客有效期
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, -- 创建该访客的管理员
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    remark TEXT,
    
    CONSTRAINT guest_type_check CHECK (guest_type IN ('viewer', 'export_applicant')),
    CONSTRAINT status_check CHECK (status IN ('active', 'disabled', 'expired')),
    CONSTRAINT valid_date_check CHECK (valid_from <= valid_until)
);

-- Create indexes for better performance
CREATE INDEX idx_guests_username ON guests(username);
CREATE INDEX idx_guests_email ON guests(email);
CREATE INDEX idx_guests_status ON guests(status);
CREATE INDEX idx_guests_guest_type ON guests(guest_type);
CREATE INDEX idx_guests_valid_until ON guests(valid_until);
CREATE INDEX idx_guests_has_export_permission ON guests(has_export_permission);

-- ====== Create Guest Export Requests Table ======
CREATE TABLE IF NOT EXISTS guest_export_requests (
    id BIGSERIAL PRIMARY KEY,
    guest_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    request_type VARCHAR(50) NOT NULL, -- 'report_export', 'data_export', etc.
    request_reason TEXT,
    request_data JSONB, -- 申请的具体内容（导出的数据类型、日期范围等）
    status VARCHAR(20) DEFAULT 'pending' NOT NULL, -- 'pending' (待审批), 'approved' (已批准), 'rejected' (已拒绝), 'expired' (已过期)
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL, -- 审批管理员
    approval_comment TEXT,
    approval_date TIMESTAMP,
    permission_valid_until TIMESTAMP, -- 该权限的过期时间
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
);

-- Create indexes for export requests
CREATE INDEX idx_export_requests_guest_id ON guest_export_requests(guest_id);
CREATE INDEX idx_export_requests_status ON guest_export_requests(status);
CREATE INDEX idx_export_requests_requested_at ON guest_export_requests(requested_at DESC);
CREATE INDEX idx_export_requests_approved_by ON guest_export_requests(approved_by);

-- ====== Create Guest Login Logs Table ======
CREATE TABLE IF NOT EXISTS guest_login_logs (
    id BIGSERIAL PRIMARY KEY,
    guest_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL, -- 'success', 'failed'
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Create index for guest login logs
CREATE INDEX idx_guest_login_logs_guest_id ON guest_login_logs(guest_id);
CREATE INDEX idx_guest_login_logs_created_at ON guest_login_logs(created_at DESC);
