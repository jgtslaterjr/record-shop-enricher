const { createClient } = require('@supabase/supabase-js');
const { normalizeHours } = require('../lib/normalize_hours');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const { data: shops, error } = await supabase
    .from('shops')
    .select('id, name, hours')
    .not('hours', 'is', null);

  if (error) throw error;
  console.log(`Found ${shops.length} shops with hours`);

  let updated = 0;
  const examples = [];

  for (const shop of shops) {
    const before = shop.hours;
    const after = normalizeHours(before);
    
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const { error: updateError } = await supabase
        .from('shops')
        .update({ hours: after })
        .eq('id', shop.id);
      
      if (updateError) {
        console.log(`ERROR updating ${shop.name}: ${updateError.message}`);
        continue;
      }
      
      updated++;
      if (examples.length < 5) {
        examples.push({ name: shop.name, before, after });
      }
    }
  }

  console.log(`\nUpdated ${updated} of ${shops.length} shops`);
  if (examples.length) {
    console.log(`\nExamples:`);
    for (const ex of examples) {
      console.log(`\n  ${ex.name}`);
      console.log(`    Before: ${JSON.stringify(ex.before)}`);
      console.log(`    After:  ${JSON.stringify(ex.after)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
