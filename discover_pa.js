#!/usr/bin/env node
/**
 * Pennsylvania-wide record shop discovery via Yelp.
 * Covers all significant cities/towns across the state.
 * 
 * Usage:
 *   node discover_pa.js                    # Run all cities
 *   node discover_pa.js --dry-run          # Preview only
 *   node discover_pa.js --limit 10         # First 10 cities
 *   node discover_pa.js --resume           # Resume from progress
 */

// Reuse the discover_from_yelp machinery by requiring this as a wrapper
// that feeds PA cities into the same pipeline.

const { execSync } = require('child_process');
const args = process.argv.slice(2);

// Comprehensive PA cities/towns — organized by region
const PA_CITIES = [
  // Southeast (already have Philly, but include suburbs/nearby)
  'Philadelphia, PA',
  'West Chester, PA',
  'Media, PA',
  'Doylestown, PA',
  'Norristown, PA',
  'King of Prussia, PA',
  'Ardmore, PA',
  'Bryn Mawr, PA',
  'Wayne, PA',
  'Conshohocken, PA',
  'Jenkintown, PA',
  'Phoenixville, PA',
  'Pottstown, PA',
  'Collegeville, PA',
  'Newtown, PA',
  'New Hope, PA',
  'Lansdale, PA',
  'Ambler, PA',
  'Narberth, PA',
  'Swarthmore, PA',
  'Chester, PA',
  'Kennett Square, PA',
  
  // Lehigh Valley / Poconos
  'Allentown, PA',
  'Bethlehem, PA',
  'Easton, PA',
  'Stroudsburg, PA',
  'East Stroudsburg, PA',
  'Jim Thorpe, PA',
  'Bangor, PA',
  'Emmaus, PA',
  'Nazareth, PA',
  
  // South Central / Lancaster / York
  'Lancaster, PA',
  'York, PA',
  'Harrisburg, PA',
  'Hershey, PA',
  'Carlisle, PA',
  'Gettysburg, PA',
  'Chambersburg, PA',
  'Hanover, PA',
  'Ephrata, PA',
  'Lititz, PA',
  'Mechanicsburg, PA',
  'Camp Hill, PA',
  'Lebanon, PA',
  
  // Pittsburgh / Western PA
  'Pittsburgh, PA',
  'Cranberry Township, PA',
  'Greensburg, PA',
  'Washington, PA',
  'Butler, PA',
  'Beaver, PA',
  'Indiana, PA',
  'New Castle, PA',
  'Latrobe, PA',
  'Monroeville, PA',
  'Canonsburg, PA',
  'McMurray, PA',
  'Murrysville, PA',
  'Sewickley, PA',
  'Irwin, PA',
  
  // Central PA
  'State College, PA',
  'Williamsport, PA',
  'Lewisburg, PA',
  'Bellefonte, PA',
  'Lock Haven, PA',
  'Selinsgrove, PA',
  'Bloomsburg, PA',
  
  // Northeast PA
  'Scranton, PA',
  'Wilkes-Barre, PA',
  'Hazleton, PA',
  'Pittston, PA',
  'Carbondale, PA',
  'Honesdale, PA',
  'Milford, PA',
  
  // Reading / Berks
  'Reading, PA',
  'Kutztown, PA',
  'Boyertown, PA',
  'Hamburg, PA',
  
  // Northwest PA
  'Erie, PA',
  'Meadville, PA',
  'Oil City, PA',
  'Warren, PA',
  'Bradford, PA',
  'Titusville, PA',
  
  // North Central
  'Mansfield, PA',
  'Wellsboro, PA',
  'Clearfield, PA',
  'DuBois, PA',
  
  // Other notable towns
  'Altoona, PA',
  'Johnstown, PA',
  'Sunbury, PA',
  'Shamokin, PA',
  'Pottsville, PA',
  'Tamaqua, PA',
  'Towanda, PA',
];

// Run sequentially through all PA cities using the existing discover tool
async function main() {
  const dryRun = args.includes('--dry-run');
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
  const resume = args.includes('--resume');
  
  let cities = PA_CITIES;
  if (limit) cities = cities.slice(0, limit);
  
  console.log(`🗺️  Pennsylvania Record Shop Discovery`);
  console.log(`   ${cities.length} cities/towns to search`);
  if (dryRun) console.log('   ⚠️  DRY RUN\n');
  
  let totalNew = 0;
  let totalUpdated = 0;
  let totalSearched = 0;
  
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    console.log(`\n[${i + 1}/${cities.length}] ${city}`);
    
    try {
      const flags = dryRun ? '--dry-run' : '';
      const output = execSync(
        `node discover_from_yelp.js --city "${city}" ${flags}`,
        { cwd: __dirname, encoding: 'utf8', timeout: 60000 }
      );
      
      // Parse output for stats
      const insertMatch = output.match(/(\d+) new/);
      const updateMatch = output.match(/(\d+) updated/);
      const searchMatch = output.match(/(\d+) shops/);
      
      if (insertMatch) totalNew += parseInt(insertMatch[1]);
      if (updateMatch) totalUpdated += parseInt(updateMatch[1]);
      if (searchMatch) totalSearched += parseInt(searchMatch[1]);
      
      // Print key lines
      const lines = output.split('\n').filter(l => 
        l.includes('➕') || l.includes('✏️') || l.includes('📊 City') || l.includes('❌')
      );
      lines.forEach(l => console.log('  ' + l.trim()));
      
    } catch (e) {
      console.log(`  ⚠️  Failed: ${e.message.split('\n')[0]}`);
    }
  }
  
  console.log('\n════════════════════════════════════════');
  console.log(`🗺️  PA Discovery Complete`);
  console.log(`   Cities searched: ${cities.length}`);
  console.log(`   New shops found: ${totalNew}`);
  console.log(`   Shops updated:   ${totalUpdated}`);
  console.log('════════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
