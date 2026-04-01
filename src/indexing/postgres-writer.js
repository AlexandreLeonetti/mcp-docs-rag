import { ensureSchema, toVectorLiteral, withTransaction } from "../db/client.js";

export async function writeDocumentsToPostgres(documents) {
  await ensureSchema();

  return withTransaction(async (client) => {
    let documentCount = 0;
    let chunkCount = 0;

    for (const document of documents) {
      documentCount += 1;

      const documentMetadata = {
        extension: document.metadata.extension,
        department: document.metadata.department,
        updated_at: document.metadata.updated_at,
        date: document.metadata.date,
        month: document.metadata.month,
        tags: document.metadata.tags,
        root_dir: document.metadata.root_dir,
      };

      const documentResult = await client.query(
        `
          INSERT INTO documents (
            source_path,
            filename,
            title,
            doc_type,
            content_hash,
            metadata_json,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
          ON CONFLICT (source_path) DO UPDATE
          SET
            filename = EXCLUDED.filename,
            title = EXCLUDED.title,
            doc_type = EXCLUDED.doc_type,
            content_hash = EXCLUDED.content_hash,
            metadata_json = EXCLUDED.metadata_json,
            updated_at = NOW()
          RETURNING id
        `,
        [
          document.metadata.source_path,
          document.metadata.filename,
          document.metadata.title,
          document.metadata.doc_type,
          document.metadata.content_hash,
          JSON.stringify(documentMetadata),
        ]
      );

      const documentId = documentResult.rows[0].id;
      await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);

      for (const chunk of document.chunks) {
        chunkCount += 1;

        const chunkMetadata = {
          source_path: chunk.source_path,
          filename: chunk.filename,
          extension: chunk.extension,
          title: chunk.title,
          doc_type: chunk.doc_type,
          department: chunk.department,
          updated_at: chunk.updated_at,
          tags: chunk.tags,
          local_context: chunk.local_context || null,
          keyword_freq: chunk.keyword_freq,
        };

        await client.query(
          `
            INSERT INTO chunks (
              document_id,
              chunk_index,
              chunk_id,
              content,
              token_count,
              section_heading,
              date,
              month,
              metadata_json,
              embedding,
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9::jsonb,
              $10::vector,
              NOW()
            )
          `,
          [
            documentId,
            chunk.chunk_index,
            chunk.chunk_id,
            chunk.content,
            chunk.token_count || 0,
            chunk.section_heading,
            chunk.date,
            chunk.month,
            JSON.stringify(chunkMetadata),
            toVectorLiteral(chunk.embedding),
          ]
        );
      }
    }

    return {
      documentCount,
      chunkCount,
    };
  });
}
