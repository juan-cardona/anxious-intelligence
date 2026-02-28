import { query } from './db.js';

async function main() {
  const r = await query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', ['code_patches']);
  console.log('code_patches columns:', r.rows.map((x: any) => x.column_name));
  
  const patches = await query('SELECT * FROM code_patches ORDER BY created_at DESC LIMIT 5');
  console.log('Existing patches:', patches.rows.length);
  if (patches.rows.length > 0) {
    for (const p of patches.rows) {
      console.log(`  - ${p.id} | ${p.file_path} | status=${p.status} | ${p.created_at}`);
    }
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
