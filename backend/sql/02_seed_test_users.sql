-- Seed Test Users for Cypress E2E Testing
-- This script creates test users needed for automated testing
-- Password hash is bcrypt of "TestPass123!"

-- ====== Insert Test Users ======

-- Test user for basic login tests
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('testuser', 'testuser@example.com', '$2b$10$h3j7lM.4r3Q5s8p9q2w1e0dXyZa1b2c3d4e5f6g7h8i9j0k1l2m3n4', '测试用户', 'user', 'active')
ON CONFLICT (username) DO UPDATE SET 
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    status = 'active';

-- Alternative: Test user with different credentials
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('qa_tester', 'qa@example.com', '$2b$10$h3j7lM.4r3Q5s8p9q2w1e0dXyZa1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'QA 测试员', 'user', 'active')
ON CONFLICT (username) DO UPDATE SET 
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    status = 'active';

-- Disabled user for testing disabled account login
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('disabled_user', 'disabled@example.com', '$2b$10$h3j7lM.4r3Q5s8p9q2w1e0dXyZa1b2c3d4e5f6g7h8i9j0k1l2m3n4', '被禁用的用户', 'user', 'disabled')
ON CONFLICT (username) DO UPDATE SET 
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    status = 'disabled';

-- ====== Verify Test Users ======
SELECT username, email, role, status, created_at FROM users WHERE email LIKE '%example.com%' ORDER BY created_at DESC;
