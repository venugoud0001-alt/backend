/**
 * Add topic_id, hls_prefix, and other missing columns to lesson_videos table
 * Run once to update the Supabase database schema
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function addColumns() {
  console.log('🔧 Adding missing columns to lesson_videos table...\n');

  const columnsToAdd = [
    { name: 'topic_id', type: 'TEXT', default: null },
    { name: 'hls_prefix', type: 'TEXT', default: null },
    { name: 'upload_id', type: 'TEXT', default: null },
    { name: 'course_slug', type: 'TEXT', default: null },
    { name: 'module_slug', type: 'TEXT', default: null },
    { name: 'source_duration_seconds', type: 'INTEGER', default: null },
    { name: 'original_file_size_bytes', type: 'BIGINT', default: null },
    { name: 'optimized_file_size_bytes', type: 'BIGINT', default: null },
    { name: 'compression_percentage', type: 'NUMERIC', default: null },
    { name: 'compression_result', type: 'TEXT', default: null },
    { name: 'output_resolution', type: 'TEXT', default: null },
    { name: 'original_resolution', type: 'TEXT', default: null },
    { name: 'available_qualities', type: 'JSONB', default: null },
    { name: 'retry_count', type: 'INTEGER', default: '0' },
    { name: 'last_retry_at', type: 'TIMESTAMPTZ', default: null },
    { name: 'source_delete_after', type: 'TIMESTAMPTZ', default: null },
    { name: 'processing_attempt_id', type: 'TEXT', default: null },
    { name: 'hls_720p_url', type: 'TEXT', default: null },
    { name: 'hls_1080p_url', type: 'TEXT', default: null },
    { name: 'source_deleted_at', type: 'TIMESTAMPTZ', default: null }
  ];

  for (const col of columnsToAdd) {
    try {
      const defaultClause = col.default !== null ? ` DEFAULT ${col.default}` : '';
      const sql = `ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}${defaultClause};`;
      const { error } = await supabase.rpc('exec_sql', { sql_query: sql });
      if (error) {
        // Try direct query if RPC not available
        console.log(`  ⚠️  ${col.name}: RPC not available, trying raw approach...`);
        // Test if column exists by trying a select
        const { error: selectErr } = await supabase
          .from('lesson_videos')
          .select(col.name)
          .limit(1);
        
        if (selectErr && selectErr.message?.includes('does not exist')) {
          console.log(`  ❌ ${col.name}: Column does not exist. Please add manually via Supabase Dashboard:`);
          console.log(`     SQL: ${sql}`);
        } else {
          console.log(`  ✅ ${col.name}: Column already exists`);
        }
      } else {
        console.log(`  ✅ ${col.name}: Added successfully`);
      }
    } catch (err) {
      console.log(`  ⚠️  ${col.name}: ${err.message}`);
    }
  }

  console.log('\n✅ Column check complete.\n');
  console.log('If any columns need to be added manually, run this SQL in the Supabase SQL Editor:');
  console.log('───────────────────────────────────────────');
  console.log(`
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS topic_id TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS hls_prefix TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS upload_id TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS course_slug TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS module_slug TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS source_duration_seconds INTEGER;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS original_file_size_bytes BIGINT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS optimized_file_size_bytes BIGINT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS compression_percentage NUMERIC;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS compression_result TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS output_resolution TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS original_resolution TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS available_qualities JSONB;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS source_delete_after TIMESTAMPTZ;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS processing_attempt_id TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS hls_720p_url TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS hls_1080p_url TEXT;
ALTER TABLE lesson_videos ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ;
  `);
}

addColumns().catch(err => {
  console.error('Migration script failed:', err);
  process.exit(1);
});
