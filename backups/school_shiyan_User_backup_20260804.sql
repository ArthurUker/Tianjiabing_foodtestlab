--
-- PostgreSQL database dump
--

\restrict 4xj6M7ISWXaEk7nEsTjHmGzhlwo0OzjR46rujGlXQuUy2rLhZdLhvJSbyMR8k7E

-- Dumped from database version 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: User; Type: TABLE; Schema: school_shiyan; Owner: foodtestlab
--

CREATE TABLE school_shiyan."User" (
    id text NOT NULL,
    username text NOT NULL,
    email text,
    password_hash text NOT NULL,
    full_name text,
    phone text,
    role text DEFAULT 'operator'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    school_code text,
    must_change_password boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    last_login timestamp(3) without time zone
);


ALTER TABLE school_shiyan."User" OWNER TO foodtestlab;

--
-- Data for Name: User; Type: TABLE DATA; Schema: school_shiyan; Owner: foodtestlab
--

COPY school_shiyan."User" (id, username, email, password_hash, full_name, phone, role, status, school_code, must_change_password, created_at, updated_at, last_login) FROM stdin;
u_shiyan_manager	manager	\N	$2a$10$n/O0dPUKGq.hSIjlE2q7SuU/jBxVW46JBDZmI1Gjxq6vQr1entUbS	School Manager	\N	manager	active	shiyan	f	2026-07-31 15:42:49.552	2026-07-31 07:44:02.354	2026-07-31 07:43:34.787
76145264-96aa-4a62-86d2-dc45ba4f291e	QQQ	\N	$2a$10$MfpF68OHFfRGxr01Fb.4Qud2zbRWjxZSg5dn9X7PHO6350/yr1U3O	\N	\N	manager	active	\N	f	2026-08-03 13:31:02.26	2026-08-03 13:32:08.718	\N
\.


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: school_shiyan; Owner: foodtestlab
--

ALTER TABLE ONLY school_shiyan."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: User_email_key; Type: INDEX; Schema: school_shiyan; Owner: foodtestlab
--

CREATE UNIQUE INDEX "User_email_key" ON school_shiyan."User" USING btree (email);


--
-- Name: User_username_key; Type: INDEX; Schema: school_shiyan; Owner: foodtestlab
--

CREATE UNIQUE INDEX "User_username_key" ON school_shiyan."User" USING btree (username);


--
-- PostgreSQL database dump complete
--

\unrestrict 4xj6M7ISWXaEk7nEsTjHmGzhlwo0OzjR46rujGlXQuUy2rLhZdLhvJSbyMR8k7E

