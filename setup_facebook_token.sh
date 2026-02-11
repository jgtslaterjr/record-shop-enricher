#!/bin/bash

# Facebook Long-Lived Token Generator
# Run after getting your short-lived token from Graph API Explorer

echo "================================================"
echo "Facebook Long-Lived Token Generator"
echo "================================================"
echo ""

# Get inputs
read -p "Enter your App ID (from app dashboard): " APP_ID
read -p "Enter your App Secret (from Settings > Basic): " APP_SECRET
read -p "Enter your short-lived token (from Graph API Explorer): " SHORT_TOKEN

echo ""
echo "Generating long-lived token..."
echo ""

# Exchange token
RESULT=$(curl -s -G "https://graph.facebook.com/v18.0/oauth/access_token" \
  -d "grant_type=fb_exchange_token" \
  -d "client_id=$APP_ID" \
  -d "client_secret=$APP_SECRET" \
  -d "fb_exchange_token=$SHORT_TOKEN")

echo "Result:"
echo "$RESULT"
echo ""

# Extract the access token
LONG_TOKEN=$(echo "$RESULT" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -n "$LONG_TOKEN" ]; then
  echo "================================================"
  echo "✅ SUCCESS! Your long-lived token:"
  echo "================================================"
  echo "$LONG_TOKEN"
  echo ""
  echo "This token is valid for ~60 days."
  echo ""
  echo "To use it:"
  echo "export FACEBOOK_ACCESS_TOKEN='$LONG_TOKEN'"
  echo ""
  echo "Or add to your ~/.bashrc or ~/.zshrc:"
  echo "echo 'export FACEBOOK_ACCESS_TOKEN=\"$LONG_TOKEN\"' >> ~/.bashrc"
  echo ""
else
  echo "❌ Failed to get long-lived token. Check your inputs."
  echo "Full response: $RESULT"
fi
