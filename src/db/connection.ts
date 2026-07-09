import { Pool, PoolClient } from '@neondatabase/serverless';

export const getDbPool = (url: string): Pool => new Pool({ connectionString: url });

// Transaction runner utility to ensure ACID transactions over WebSockets
export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
