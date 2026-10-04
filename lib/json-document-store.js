import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonFile(filePath, document) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export function createJsonDocumentStore({ connectionString = '', documents, pool: suppliedPool } = {}) {
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
    throw new TypeError('A map of document keys to file paths is required');
  }

  const databaseEnabled = Boolean(connectionString || suppliedPool);
  const pool = suppliedPool || (connectionString ? new Pool({ connectionString }) : null);
  let initialization;

  async function initializeDatabase() {
    if (!databaseEnabled) return;
    if (!initialization) {
      initialization = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS app_documents (
            document_key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        for (const [key, filePath] of Object.entries(documents)) {
          const existing = await pool.query(
            'SELECT document_key FROM app_documents WHERE document_key = $1',
            [key]
          );
          if (existing.rows.length) continue;

          const legacyDocument = await readJsonFile(filePath);
          if (legacyDocument === null) continue;
          await pool.query(
            `INSERT INTO app_documents (document_key, payload)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (document_key) DO NOTHING`,
            [key, JSON.stringify(legacyDocument)]
          );
        }
      })();
      initialization.catch(() => {
        initialization = null;
      });
    }
    await initialization;
  }

  return {
    mode: databaseEnabled ? 'postgres' : 'local-json',
    async initialize() {
      await initializeDatabase();
    },
    async read(key) {
      const filePath = documents[key];
      if (!filePath) throw new RangeError(`Unknown JSON document: ${key}`);
      if (!databaseEnabled) return readJsonFile(filePath);

      await initializeDatabase();
      const result = await pool.query(
        'SELECT payload FROM app_documents WHERE document_key = $1',
        [key]
      );
      return result.rows[0]?.payload ?? null;
    },
    async write(key, document) {
      const filePath = documents[key];
      if (!filePath) throw new RangeError(`Unknown JSON document: ${key}`);
      if (!databaseEnabled) return writeJsonFile(filePath, document);

      await initializeDatabase();
      await pool.query(
        `INSERT INTO app_documents (document_key, payload, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (document_key)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [key, JSON.stringify(document)]
      );
    },
    async close() {
      if (!suppliedPool) await pool?.end();
    }
  };
}
