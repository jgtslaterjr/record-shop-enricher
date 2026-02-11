# Multi-Location Shop Handling

The enricher is **location-aware** and designed to handle shops with multiple locations correctly.

## The Problem

Many record shops have multiple locations:
- **Amoeba Music**: Berkeley, San Francisco, Hollywood (Los Angeles)
- **Rough Trade**: Brooklyn (NYC), London East, London West
- **Waterloo Records**: Multiple Austin locations

When enriching, you need to:
1. ✅ Extract data for the SPECIFIC location being enriched
2. ❌ NOT mix data from different locations
3. ⚠️ Identify when social media accounts are shared vs location-specific

## How It Works

### Database Structure

Each location should be a **separate database row**:

```
| id | name           | neighborhood | city         | state | address              |
|----|----------------|--------------|--------------|-------|----------------------|
| 1  | Amoeba Music   | Berkeley     | Berkeley     | CA    | 2455 Telegraph Ave   |
| 2  | Amoeba Music   | Hollywood    | Los Angeles  | CA    | 6400 Sunset Blvd     |
| 3  | Amoeba Music   | null         | San Francisco| CA    | 1855 Haight St       |
```

**Key fields for location identification:**
- `neighborhood` - Most specific (e.g., "Berkeley", "Hollywood", "Brooklyn")
- `city` - Required
- `state` - Required
- `address` - Helps with disambiguation

### Web Enrichment (Tier 1)

When enriching a location's website:

1. **Location context is displayed**:
   ```
   🎯 Location Context: Berkeley, Berkeley, CA
   📍 Address: 2455 Telegraph Ave
   ⚠️  Multi-location shop detected. Extracting data for THIS location only.
   ```

2. **Website data is location-filtered**:
   - If website has `/locations/berkeley` or similar, prioritize those pages
   - Hours, phone, events extracted for THAT location
   - General "About" info may apply to all locations (flagged as such)

3. **AI analysis understands location context**:
   - Prompt includes: "This is the Berkeley location of Amoeba Music"
   - Extraction focuses on location-specific details
   - Mixed data is identified

### Social Media Enrichment (Tier 2)

Social accounts can be:

#### Shared Across Locations
```
All Amoeba locations share:
- Instagram: @amoebamusic
- Facebook: /amoebamusic
- TikTok: @amoebamusic
```

**Behavior**: The enricher notes this and extracts the shared account data. Metrics (followers, posts) represent the ENTIRE brand, not one location.

#### Location-Specific
```
Each location has its own:
- Instagram: @amoebaberkeley, @amoebahollywood, @amoebasf
- Facebook: /amoebaberkeley, /amoebahollywood
```

**Behavior**: The enricher extracts data for the SPECIFIC location's account. Metrics represent that location only.

#### How to Handle

When editing shop details:
1. **Check social accounts**: Visit them manually
2. **Identify scope**: Is it location-specific or brand-wide?
3. **Edit accordingly**:
   - If shared: Add the same social handles to ALL locations
   - If specific: Add unique handles to each location

The enricher will include a warning:
```
⚠️  NOTE: Social media accounts may be:
   • Shared across all locations (e.g., @amoebamusic for all stores)
   • Location-specific (e.g., @amoebaberkeley)

The enrichment will attempt to identify which type.
```

## Best Practices

### 1. Use Neighborhood Field
Always fill in `neighborhood` for multi-location shops:
- ✅ "Berkeley" (not "North Berkeley" - keep it simple)
- ✅ "Hollywood"
- ✅ "Brooklyn"
- ✅ "Downtown"

### 2. Unique Shop Names (Optional)
For clarity, you can include location in the name:
- "Amoeba Music - Berkeley"
- "Amoeba Music - Hollywood"
- "Rough Trade East"

Or keep names identical and rely on neighborhood field.

### 3. Website URLs
- If each location has its own page: Use the location-specific URL
  - ✅ `https://amoeba.com/locations/berkeley`
- If one shared website: Use the main URL for all locations
  - ✅ `https://amoeba.com` (enricher will detect multi-location)

### 4. Social Media Strategy

**Option A: Shared accounts**
- Add identical social handles to all locations
- Metrics will be the same (brand-wide)
- Good for brand awareness tracking

**Option B: Location-specific accounts**
- Add unique handles to each location
- Metrics will be location-specific
- Good for local engagement tracking

**Option C: Mixed**
- Some platforms shared (Instagram), others specific (Facebook)
- Reflects real-world social strategy

## Location Context Display

### Before Enrichment
The modal title shows location:
```
Amoeba Music - Berkeley, Berkeley, CA
```

### During Enrichment
Output includes location context:
```
🎯 Location Context: Berkeley, Berkeley, CA
📍 Address: 2455 Telegraph Ave
⚠️  Multi-location shop detected. Extracting data for THIS location only.
```

### In Results
AI analysis references the specific location:
```
## BUSINESS DETAILS
- Name: Amoeba Music (Berkeley location)
- Address: 2455 Telegraph Ave, Berkeley, CA
- This location: [specific details]
- Brand-wide: [company-level details]
```

## CLI Usage

For manual enrichment with location context:

```bash
# Using the location-aware wrapper
./enrich_location_aware.js "Amoeba Music" "https://amoeba.com" "Berkeley" "Berkeley" "CA" "2455 Telegraph Ave"

# Different location
./enrich_location_aware.js "Amoeba Music" "https://amoeba.com" "Hollywood" "Los Angeles" "CA" "6400 Sunset Blvd"

# Social enrichment with location
./enrich_location_aware.js "Amoeba Music" "https://amoeba.com" "Berkeley" "Berkeley" "CA" "" "social"
```

## Troubleshooting

### Problem: Data looks mixed between locations

**Solution**: 
1. Check that `neighborhood` and `address` are filled in
2. Re-enrich with proper location context
3. Manually review and edit extracted data

### Problem: Social accounts show same metrics for all locations

**Cause**: Accounts are shared brand-wide (not location-specific)

**Solution**:
- This is correct! Shared accounts have shared metrics
- If you want location-specific metrics, check if the shop has location-specific accounts

### Problem: Website shows all locations, not specific one

**Cause**: Website doesn't have location-specific pages

**Solution**:
- Look for `/locations/[name]` pages and use those URLs
- Or accept that some data will be brand-wide
- Use the edit popup to manually specify location details

## Future Enhancements

Planned improvements for multi-location handling:

- **Location detection**: Auto-detect multi-location from website structure
- **Location-specific hours**: Extract hours for specific location from aggregated data
- **Events filtering**: Only show events for the enriched location
- **Cross-location comparison**: Compare metrics across a brand's locations
- **Location hierarchy**: Brand → Region → Location relationships

## Summary

✅ **DO**:
- Use separate database rows for each location
- Fill in `neighborhood` for multi-location shops
- Check if social accounts are shared or location-specific
- Review enrichment output for location context warnings

❌ **DON'T**:
- Mix data from different locations in one row
- Assume all data applies to all locations
- Ignore location context warnings
- Skip the neighborhood field for multi-location shops

The enricher will do its best to identify and separate location-specific data, but proper database structure and location context makes the results much more accurate! 🎯
