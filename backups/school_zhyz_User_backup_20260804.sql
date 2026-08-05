--
-- PostgreSQL database dump
--

\restrict mSFZEzQvm7ZZk0bzVrGJNjIS3bhlMosxRf671xYiOJ5u2y3GXIfG2T5PCNLVWmP

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
-- Name: User; Type: TABLE; Schema: school_zhyz; Owner: foodtestlab
--

CREATE TABLE school_zhyz."User" (
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


ALTER TABLE school_zhyz."User" OWNER TO foodtestlab;

--
-- Data for Name: User; Type: TABLE DATA; Schema: school_zhyz; Owner: foodtestlab
--

COPY school_zhyz."User" (id, username, email, password_hash, full_name, phone, role, status, school_code, must_change_password, created_at, updated_at, last_login) FROM stdin;
40f8d7a1-fc0e-4628-9f6c-e0a2ce769693	admin	\N	$2a$10$g6TU/cmrNslvqob48hqIXuxaFf90oVtNHhJjrWL3Fye8HJSnwLRXO	\N	\N	operator	active	\N	f	2026-08-04 10:47:39.529	2026-08-04 10:47:39.529	\N
u_zhyz_manager	manager	\N	$2a$10$hDx7UUgrwfTDHWJ632hQ.ueWu7KrGJjXzxA9SGg1xrbhHDOWeDS..	School Manager	\N	manager	active	zhyz	f	2026-07-30 12:18:56.509	2026-08-04 02:55:21.225	2026-08-04 02:55:21.224
\.


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: school_zhyz; Owner: foodtestlab
--

ALTER TABLE ONLY school_zhyz."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: User_email_key; Type: INDEX; Schema: school_zhyz; Owner: foodtestlab
--

CREATE UNIQUE INDEX "User_email_key" ON school_zhyz."User" USING btree (email);


--
-- Name: User_username_key; Type: INDEX; Schema: school_zhyz; Owner: foodtestlab
--

CREATE UNIQUE INDEX "User_username_key" ON school_zhyz."User" USING btree (username);


--
-- PostgreSQL database dump complete
--

\unrestrict mSFZEzQvm7ZZk0bzVrGJNjIS3bhlMosxRf671xYiOJ5u2y3GXIfG2T5PCNLVWmP

