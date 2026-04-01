import { ensureSchema, parseVector, query } from "../db/client.js";

function buildFilterClauses(analysis, params) {
  const clauses = [];
  const docTypes = analysis.filters.doc_types || [];
  const departments = analysis.filters.departments || [];

  if (analysis.mode === "comparison" && analysis.filters.comparison?.sides?.length) {
    const comparisonDocTypes = [
      ...new Set(analysis.filters.comparison.sides.flatMap((side) => side.docTypes || [])),
    ];
    const comparisonDepartments = [
      ...new Set(analysis.filters.comparison.sides.flatMap((side) => side.departments || [])),
    ];

    if (comparisonDocTypes.length) {
      params.push(comparisonDocTypes);
      clauses.push(`documents.doc_type = ANY($${params.length})`);
    }

    if (comparisonDepartments.length) {
      params.push(comparisonDepartments);
      clauses.push(`(chunks.metadata_json->>'department') = ANY($${params.length})`);
    }
  } else if (analysis.mode !== "fact_lookup") {
    if (docTypes.length) {
      params.push(docTypes);
      clauses.push(`documents.doc_type = ANY($${params.length})`);
    }

    if (departments.length) {
      params.push(departments);
      clauses.push(`(chunks.metadata_json->>'department') = ANY($${params.length})`);
    }
  }

  if (analysis.filters.explicitDate) {
    params.push(analysis.filters.explicitDate);
    const index = params.length;
    clauses.push(`(chunks.date = $${index} OR (chunks.metadata_json->>'updated_at') = $${index})`);
  }

  if (analysis.filters.months?.length > 1) {
    params.push(analysis.filters.months);
    clauses.push(`chunks.month = ANY($${params.length})`);
  } else if (analysis.filters.month && analysis.mode !== "fact_lookup" && analysis.mode !== "comparison") {
    params.push(analysis.filters.month);
    clauses.push(`chunks.month = $${params.length}`);
  }

  return clauses;
}

function buildMatchClauses(tokens, params) {
  const clauses = ["chunks.content_tsv @@ websearch_to_tsquery('english', $1)"];

  if (tokens.length) {
    params.push(tokens.map((token) => `%${token.toLowerCase()}%`));
    const patternIndex = params.length;
    clauses.push(`LOWER(chunks.content) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(documents.filename) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(documents.source_path) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(COALESCE(documents.title, '')) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(COALESCE(chunks.section_heading, '')) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(COALESCE(chunks.metadata_json->>'department', '')) LIKE ANY($${patternIndex})`);
    clauses.push(`LOWER(COALESCE(chunks.metadata_json->>'tags', '')) LIKE ANY($${patternIndex})`);
  }

  return clauses;
}

function mapChunkRow(row) {
  const meta = row.metadata_json || {};
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const keywordFreq = meta.keyword_freq || {};

  return {
    id: row.id,
    document_id: row.document_id,
    chunk_id: row.chunk_id,
    chunkId: row.chunk_id,
    chunk_index: row.chunk_index,
    chunkIndex: row.chunk_index,
    content: row.content,
    token_count: row.token_count,
    section_heading: row.section_heading,
    source_path: row.source_path,
    filePath: row.source_path,
    filename: row.filename,
    fileName: row.filename,
    title: row.title,
    doc_type: row.doc_type,
    department: meta.department || null,
    updated_at: meta.updated_at || null,
    date: row.date,
    month: row.month,
    tags,
    extension: meta.extension || null,
    local_context: meta.local_context || null,
    keyword_freq: keywordFreq,
    keywordFreq,
    embedding: parseVector(row.embedding),
    sqlLexicalRank: Number(row.sql_lexical_rank || 0),
  };
}

export async function loadIndexStats() {
  await ensureSchema();
  const result = await query(`
    SELECT
      COUNT(*)::int AS total_chunks,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS chunks_with_embeddings
    FROM chunks
  `);

  return {
    totalChunks: Number(result.rows[0]?.total_chunks || 0),
    chunksWithEmbeddings: Number(result.rows[0]?.chunks_with_embeddings || 0),
  };
}

export async function lexicalSearch({ queryText, analysis, queryTokens, limit = 120 }) {
  await ensureSchema();

  const params = [queryText];
  const filters = buildFilterClauses(analysis, params);
  const matches = buildMatchClauses(queryTokens, params);
  params.push(limit);
  const limitIndex = params.length;

  const result = await query(
    `
      SELECT
        chunks.id,
        chunks.document_id,
        chunks.chunk_index,
        chunks.chunk_id,
        chunks.content,
        chunks.token_count,
        chunks.section_heading,
        chunks.date,
        chunks.month,
        chunks.metadata_json,
        chunks.embedding,
        documents.source_path,
        documents.filename,
        documents.title,
        documents.doc_type,
        ts_rank_cd(chunks.content_tsv, websearch_to_tsquery('english', $1)) AS sql_lexical_rank
      FROM chunks
      INNER JOIN documents ON documents.id = chunks.document_id
      WHERE
        (${matches.join(" OR ")})
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
      ORDER BY
        sql_lexical_rank DESC,
        chunks.chunk_index ASC
      LIMIT $${limitIndex}
    `,
    params
  );

  return result.rows.map(mapChunkRow);
}
