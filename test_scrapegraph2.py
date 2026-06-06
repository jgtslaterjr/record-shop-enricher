#!/usr/bin/env python3
"""Test ScrapeGraphAI with pre-fetched content"""
import json
from scrapegraphai.graphs import SmartScraperGraph

# Use the Yelp page content we already scraped
source_text = """
Get Hip Records - 4.0 (2 reviews) - Unclaimed - Vinyl Records
1800 Columbus Ave, Pittsburgh, PA 15233 - North Side
Open 10:00 AM - 6:00 PM (Mon-Sat), Closed Sunday
Phone: (412) 231-4766

Review 1 - Karla D. (Elite 26, Austin TX) - Jan 16, 2019:
It's music to my ears because this record store is the absolute best of the best!
It's paradise for vinyl lovers. Whether you're a new collector or lifelong, they have what you need.
Hard-to-find, rare, classic pressings as well as newer recordings.
I could spend hours just looking at all of their records.

Review 2 - Another reviewer:
This is a really cool record store with a great selection. It took me forever to find where the actual store is. 
It's on the second floor, and the entrance is around the corner to the right through those gates.
"""

config = {
    "llm": {
        "model": "ollama/llama3.2",
        "base_url": "http://localhost:11434",
    },
    "headless": True,
    "verbose": False,
}

graph = SmartScraperGraph(
    prompt="Extract: business name, rating, number of reviews, address, phone, hours, and each review with author, date, rating, and text.",
    source=source_text,
    config=config,
)

result = graph.run()
print(json.dumps(result, indent=2, default=str))
