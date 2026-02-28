import pg from 'pg';
async function main() {
  const pool = new pg.Pool({ connectionString: 'postgresql://anxious:anxious123@localhost:5433/anxious_intelligence' });
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  console.log('Tables:', tables.rows.map((r: any) => r.tablename));
  const patches = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'code_patches' ORDER BY ordinal_position");
  console.log('code_patches columns:', patches.rows.length > 0 ? patches.rows : 'TABLE DOES NOT EXIST');
  try {
    const ep = await pool.query('SELECT id, file_path, status, created_at FROM code_patches ORDER BY created_at DESC LIMIT 10');
    console.log('Existing patches:', ep.rows);
  } catch(e: any) { console.log('No patches table:', e.message); }
  const beliefs = await pool.query('SELECT id, LEFT(content,80) as content, confidence, tension, domain FROM beliefs WHERE is_active = true ORDER BY tension DESC');
  console.log('Active beliefs:', beliefs.rows);
  await pool.end();
}
main();
