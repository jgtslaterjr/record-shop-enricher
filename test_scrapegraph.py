#!/usr/bin/env python3
"""Test ScrapeGraphAI on Discogs seller page"""
import json, os
from scrapegraphai.graphs import SmartScraperGraph

config = {
    "llm": {
        "model": "ollama/llama3.2",
        "base_url": "http://localhost:11434",
    },
    "headless": True,
    "verbose": False,
}

graph = SmartScraperGraph(
    prompt="Extract the seller name, rating percentage, number of ratings, items for sale count, location, shipping info, and any seller feedback/reviews from this Discogs seller profile page.",
    source="https://www.discogs.com/seller/gethip/profile",
    config=config,
)

result = graph.run()
print(json.dumps(result, indent=2, default=str))
