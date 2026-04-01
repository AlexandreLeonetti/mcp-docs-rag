CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  title TEXT,
  doc_type TEXT,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  section_heading TEXT,
  date TEXT,
  month TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(content, ''))
  ) STORED,
  embedding vector(384),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents (filename);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks (date);
CREATE INDEX IF NOT EXISTS idx_chunks_month ON chunks (month);
CREATE INDEX IF NOT EXISTS idx_chunks_content_tsv ON chunks USING GIN (content_tsv);
