# Facebook Graph API Setup

## Why Use the Graph API?

Facebook heavily restricts scraping and requires authentication for most content. The Graph API is the official, reliable way to access public page data.

## Setup Steps

### 1. Create a Facebook App
1. Go to https://developers.facebook.com/apps
2. Click "Create App"
3. Choose "Business" type
4. Fill in basic app details

### 2. Get an Access Token
1. In your app dashboard, go to Tools > Graph API Explorer
2. Select your app
3. Add permissions: `pages_read_engagement`, `pages_show_list`
4. Generate Access Token
5. Copy the token (starts with "EAA...")

### 3. Get a Long-Lived Token (Optional)
```bash
curl -G "https://graph.facebook.com/v18.0/oauth/access_token" \
  -d "grant_type=fb_exchange_token" \
  -d "client_id=YOUR_APP_ID" \
  -d "client_secret=YOUR_APP_SECRET" \
  -d "fb_exchange_token=SHORT_LIVED_TOKEN"
```

## Usage Example

```javascript
const FACEBOOK_ACCESS_TOKEN = 'YOUR_TOKEN_HERE';

function fetchFacebookPageData(pageId) {
  const fields = 'name,about,description,category,emails,phone,website,fan_count,posts{message,created_time,likes.summary(true),comments.summary(true)}';
  const url = `https://graph.facebook.com/v18.0/${pageId}?fields=${fields}&access_token=${FACEBOOK_ACCESS_TOKEN}`;
  
  const result = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
  return JSON.parse(result);
}
```

## API Limitations

- **Rate Limits**: 200 calls per hour per user
- **Permissions**: Some data requires page ownership or admin access
- **Public Data Only**: Can only access what's publicly visible
- **App Review**: Some permissions require Facebook approval

## Alternative: Page Access Token

If you manage the page:
1. Go to your Facebook page
2. Settings > Meta Business Suite > Page Access Tokens
3. Generate token with required permissions
4. This gives full access to your page's data

## Public Page Data (No Token Needed)

Some basic info is available without authentication:
```bash
curl "https://graph.facebook.com/v18.0/rpmunderground?fields=name,about,category"
```

But this is very limited compared to authenticated access.
