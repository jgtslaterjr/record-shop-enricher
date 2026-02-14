# Record Shop Enricher — Strategy Document
**Date:** February 14, 2026

---

## 1. Competitive Landscape

### recordstores.love
**What it is:** Community-driven global map of record stores. Built by one developer, promoted on Discogs forums.

**Strengths:**
- Beautiful map-first UX — the entire experience is the map
- Community features: ToGo lists, custom color coding per store, tour reviews
- User-submitted data — crowdsourced keeps it fresh
- Tags and reviews from users
- Global coverage (not just US)
- Free, passion project feel — vinyl community loves it

**Weaknesses:**
- Data quality varies (user-submitted, no verification)
- No enrichment — basic info only (name, address, maybe hours)
- No social media integration
- No business intelligence (hours reliability, inventory info, etc.)
- Single developer — fragile, could disappear
- No API for developers

---

### VinylHub (Discogs)
**What it is:** Discogs-owned record store directory. "Document every physical record shop on the planet."

**Strengths:**
- Backed by Discogs — massive built-in audience of collectors
- 6,500+ stores globally
- Connected to Discogs seller profiles — can see online inventory
- Photos, hours, genres, formats
- Community contributions (wiki-style edits)
- Visited/Want-to-Visit lists
- Event listings

**Weaknesses:**
- Feels like an afterthought within Discogs — buried in the UI
- Data often stale (community updates are sporadic)
- No social media data
- No engagement metrics or business health indicators
- No reviews or ratings (separate from Discogs seller ratings)
- Limited search/filter capabilities
- No mobile-first experience

---

### Record Store Directory (recordstoredirectory.com)
**What it is:** US-focused directory by "Uniting With Music" nonprofit program.

**Strengths:**
- Claims comprehensive US coverage including territories
- Clean WordPress site
- State-by-state browsing
- Vinyl Record Day countdown / community events

**Weaknesses:**
- Very basic listings — name and address only
- No map view
- No search functionality visible
- Minimal data per store
- WordPress site feels amateur
- No social, no reviews, no enrichment
- Static content — not clear how it's maintained

---

### Record Store Day (recordstoreday.com/stores)
**What it is:** Official RSD participating store locator.

**Strengths:**
- Official, trusted source
- ~1,400 US stores listed
- RSD participation verified
- Brand recognition

**Weaknesses:**
- Only RSD-participating stores
- Minimal data per store
- Not a general directory — event-focused
- No year-round utility beyond finding RSD stores

---

### Discogs Record Stores (discogs.com/record-stores/)
**What it is:** Certified independent record store directory on Discogs.

**Strengths:**
- Connected to Discogs marketplace
- Verified/certified stores
- Online shop integration

**Weaknesses:**
- Only stores with Discogs seller accounts
- Certification process limits coverage
- No physical visit info (hours, vibe, etc.)

---

## 2. Our Angle — What Makes Us Different

**We're building the most data-rich record shop directory in existence.**

While competitors have either:
- Good maps but shallow data (recordstores.love)
- Deep marketplace but poor store discovery (VinylHub/Discogs)
- Basic listings with no intelligence (Record Store Directory)

We combine:
1. **Deep enrichment** — 175+ data points per shop across 8 tiers
2. **Social media intelligence** — Instagram followers, engagement, content themes
3. **Review aggregation** — Google, Yelp, Facebook scores in one place
4. **Business health signals** — is this shop thriving or struggling?
5. **Automated freshness** — data updated weekly/monthly, not community-dependent
6. **API-first** — our data can power other apps, guides, travel tools

**Target users:**
- Vinyl collectors planning trips / crate-digging tours
- Music tourists visiting new cities
- Record labels looking for retail partners
- Journalists writing about vinyl culture
- Real estate / investment analysts

---

## 3. Feature Roadmap (Prioritized)

### Phase 1: Data Foundation (Now — Feb 2026) ✅ IN PROGRESS
- [x] Tier 1 web enrichment (enrich_shop_v2.js)
- [ ] Social handle discovery (extract from websites + search)
- [ ] Instagram public profile scraping
- [ ] Cross-reference with recordstores.love for missing shops
- [ ] Data quality audit and cleanup

### Phase 2: Social & Reviews (Mar 2026)
- [ ] Instagram engagement metrics + content themes
- [ ] Google Maps ratings + review counts
- [ ] Yelp ratings integration
- [ ] Facebook page basic info
- [ ] Composite reputation score

### Phase 3: Public Site MVP (Apr 2026)
- [ ] Map-based frontend (Mapbox or Google Maps)
- [ ] Shop detail pages with enriched data
- [ ] Search by city, state, genre, format
- [ ] Filter by rating, social presence, events
- [ ] Mobile-responsive design

### Phase 4: Community & Content (May-Jun 2026)
- [ ] User accounts and "visited" lists
- [ ] User reviews and ratings
- [ ] Trip planner / crate-digging route builder
- [ ] Blog / editorial content (best shops in X city)
- [ ] Newsletter with new shop discoveries

### Phase 5: Monetization (Jul+ 2026)
- [ ] Premium shop listings (claimed by owners)
- [ ] Affiliate links (Discogs, turntable gear)
- [ ] Sponsored content / ads
- [ ] API access for developers
- [ ] Event partnerships (Record Store Day, etc.)

---

## 4. Data Quality Improvements Needed

### Immediate
- **Missing social handles**: ~90% of shops have null social_instagram/facebook/tiktok
- **Stale websites**: Some `website` fields point to Yelp instead of actual shop sites
- **Missing hours**: Many shops have null hours despite websites listing them
- **Duplicate detection**: Some shops may be listed twice with slight name variations

### Short-term
- **Website validation**: Check which URLs are still live (404 detection)
- **Closed shop detection**: Cross-reference with Google Maps "permanently closed"
- **Address standardization**: Normalize addresses for geocoding accuracy
- **Phone number formatting**: Standardize to E.164 format

### Ongoing
- **Freshness tracking**: Flag shops not enriched in 30+ days
- **Change detection**: Alert when website content changes significantly
- **New shop discovery**: Periodic Google Maps search for new record shops

---

## 5. Monetization Paths

### Tier 1: Low effort, immediate
- **Affiliate links**: Discogs, Amazon vinyl, turntable equipment (Fluance, Audio-Technica, Pro-Ject)
- **Google AdSense**: On shop detail pages and city guides
- **Estimated revenue**: $200-500/month at moderate traffic

### Tier 2: Medium effort
- **Premium listings**: Shop owners claim and enhance their profile ($10-25/month)
  - Priority placement in search results
  - Featured photos and videos
  - Event promotion
  - Social media feed embed
  - Analytics dashboard (how many people viewed their listing)
- **Estimated revenue**: $500-2,000/month with 50-200 paying shops

### Tier 3: Higher effort, higher reward
- **API access**: License enriched data to travel apps, music apps ($99-499/month)
- **Event partnerships**: Record Store Day, vinyl fairs, music festivals
- **Sponsored city guides**: "Best Record Shops in Austin" sponsored by local tourism board
- **Merch**: "Support Your Local Record Shop" branded items
- **Estimated revenue**: $2,000-10,000/month

### Tier 4: Long-term
- **Data licensing**: Sell aggregated industry insights (vinyl market reports)
- **Consulting**: Help record shops improve online presence
- **White-label**: License directory to music publications
- **Acquisition target**: For Discogs, Spotify, or music-focused companies

---

## 6. Technical Strategy

### Stack
- **Database**: Supabase (PostgreSQL) — already in use
- **Enrichment**: Node.js scripts (curl + Ollama for AI analysis)
- **Frontend**: TBD — likely Next.js or Astro with Mapbox
- **Hosting**: Vercel or Cloudflare Pages
- **Search**: Supabase full-text search → Algolia if needed

### Cost Controls (Phase 1)
- No paid APIs — use free scraping methods
- Ollama (local) for all AI tasks
- Apify saved for Phase 2 (budget: $50-100)
- Screenshot + AI vision as last resort only

### Data Pipeline
```
Discovery → Enrichment → Social → Reviews → Score → Publish
   ↑                                                    ↓
   └──────────── New shops / refresh cycle ←────────────┘
```

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Social media scraping blocked | Can't get Instagram data | Hybrid approach: direct → Apify → AI vision |
| Competitor launches similar enrichment | Reduced differentiation | Move fast, build community moat |
| Shops request data removal | Legal/PR risk | Build opt-out mechanism early |
| Data goes stale | Poor user experience | Automated refresh pipeline |
| Low traffic | No monetization | SEO focus, city guide content, social marketing |

---

**Next Action**: Build social handle discovery + Instagram scraper scripts (Phase 1 deliverables).
