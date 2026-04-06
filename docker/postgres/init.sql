-- SecureContext PostgreSQL initialization script
-- Runs once on first container start (entrypoint.d/ convention)
-- Creates the database and enables required extensions

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy text matching (optional, used for non-English source names)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enable btree_gin for compound GIN indexes
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Set sensible defaults for SecureContext workloads
-- These tune the query planner for our access pattern:
--   - Many small reads (recall, search) + occasional large inserts (index)
ALTER SYSTEM SET max_connections              = '200';
ALTER SYSTEM SET shared_buffers              = '256MB';
ALTER SYSTEM SET effective_cache_size        = '768MB';
ALTER SYSTEM SET maintenance_work_mem        = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers                 = '16MB';
ALTER SYSTEM SET default_statistics_target   = '100';
ALTER SYSTEM SET random_page_cost            = '1.1';  -- SSD assumed inside Docker
ALTER SYSTEM SET effective_io_concurrency    = '200';  -- SSD
ALTER SYSTEM SET work_mem                    = '4MB';
ALTER SYSTEM SET min_wal_size               = '1GB';
ALTER SYSTEM SET max_wal_size               = '4GB';

-- Log slow queries (>250ms) for diagnostics
ALTER SYSTEM SET log_min_duration_statement  = '250';
ALTER SYSTEM SET log_line_prefix             = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h ';

SELECT pg_reload_conf();
