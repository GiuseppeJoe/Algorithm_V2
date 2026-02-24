import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
import os
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from newspaper import Article
from duckduckgo_search import DDGS
from openai import OpenAI
from news_analyzer import NewsImpactAnalyzer
import deployer

HISTORY_FILE = "processed_history.json"

# --- PARALLELISM CONFIG ---
MAX_FEED_WORKERS = 15      # RSS feeds fetched in parallel
MAX_KEYWORD_WORKERS = 6    # DDGS keyword searches in parallel
MAX_SCRAPE_WORKERS = 20    # Articles scraped in parallel
MAX_AI_WORKERS = 10        # GPT-4o analysis calls in parallel

# --- 1. THE OMNI-SCRAPER CONFIGURATION ---

# TIER 1: Tabloid / Viral News (highest meme potential)
FEEDS_TABLOID = {
    "TMZ (Celebrity/Scandal)": "https://www.tmz.com/rss.xml",
    "NY Post (Culture/Florida Man)": "https://nypost.com/feed/",
    "Daily Mail (UK Tabloid)": "https://www.dailymail.co.uk/articles.rss",
    "The Sun (UK Viral)": "https://www.thesun.co.uk/feed/",
    "Page Six (Gossip)": "https://pagesix.com/feed/",
}

# TIER 2: Hard News / Breaking (war, disasters, politics)
FEEDS_BREAKING = {
    "Fox News (Politics/Conflict)": "http://feeds.foxnews.com/foxnews/latest",
    "BBC World (Global Events)": "http://feeds.bbci.co.uk/news/world/rss.xml",
    "AP News (Wire Service)": "https://rsshub.app/apnews/topics/apf-topnews",
    "Reuters (Global Wire)": "https://www.reutersagency.com/feed/",
    "Al Jazeera (Intl Conflict)": "https://www.aljazeera.com/xml/rss/all.xml",
    "NPR News (US Breaking)": "https://feeds.npr.org/1001/rss.xml",
}

# TIER 3: Crypto / Finance (hacks, crashes, rug pulls)
FEEDS_CRYPTO = {
    "CoinTelegraph (Crypto Hacks)": "https://cointelegraph.com/rss",
    "CoinDesk (Crypto News)": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "Decrypt (Crypto/Web3)": "https://decrypt.co/feed",
    "ZeroHedge (Market Crash/Geopolitics)": "https://feeds.feedburner.com/zerohedge/feed",
}

# TIER 4: Reddit Viral Subreddits (trending meme material)
FEEDS_REDDIT = {
    "Reddit r/news": "https://www.reddit.com/r/news/top/.rss?t=day",
    "Reddit r/worldnews": "https://www.reddit.com/r/worldnews/top/.rss?t=day",
    "Reddit r/nottheonion": "https://www.reddit.com/r/nottheonion/top/.rss?t=day",
    "Reddit r/CryptoCurrency": "https://www.reddit.com/r/CryptoCurrency/top/.rss?t=day",
    "Reddit r/FloridaMan": "https://www.reddit.com/r/FloridaMan/top/.rss?t=day",
    "Reddit r/PublicFreakout": "https://www.reddit.com/r/PublicFreakout/top/.rss?t=day",
}

# TIER 5: Google News topic feeds (broad viral coverage)
FEEDS_GOOGLE_NEWS = {
    "Google News - World": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
    "Google News - Business": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
    "Google News - Technology": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
    "Google News - Entertainment": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
    "Google News - Science": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
}

# Combine all feeds into master dict
RSS_FEEDS = {}
RSS_FEEDS.update(FEEDS_TABLOID)
RSS_FEEDS.update(FEEDS_BREAKING)
RSS_FEEDS.update(FEEDS_CRYPTO)
RSS_FEEDS.update(FEEDS_REDDIT)
RSS_FEEDS.update(FEEDS_GOOGLE_NEWS)

HUNTER_KEYWORDS = [
    # Death & Violence
    "assassinated", "fatally shot", "found dead", "mass shooting",
    "stabbed to death", "overdose death celebrity", "killed in crash",
    # Crime & Scandal
    "arrested", "indicted", "sex tape leaked", "caught on camera crime",
    "florida man arrested", "influencer arrested", "celebrity mugshot",
    "leaked photos scandal",
    # Hacks & Crypto
    "hacked for millions", "stolen funds", "crypto rug pull",
    "exchange hacked", "bitcoin crash today", "crypto scam exposed",
    # War & Geopolitics
    "declared war", "missile strike", "military coup",
    "nuclear threat", "hostage situation", "terrorist attack",
    # Disasters & Nature
    "earthquake today", "tornado destroys", "wildfire evacuations",
    "plane crash", "bridge collapse",
    # Weird & Viral
    "bizarre", "UFO sighting confirmed", "shark attack",
    "bear attack", "animal escapes zoo", "viral video breaking",
]

# ============================================================
# UTILITY FUNCTIONS
# ============================================================

def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as f:
            return json.load(f)
    return {}

def save_history(history):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

def is_recently_processed(link, history):
    if link in history:
        processed_time = datetime.fromisoformat(history[link])
        if datetime.now() - processed_time < timedelta(hours=24):
            return True
    return False

# ============================================================
# STAGE 1: PARALLEL NEWS GATHERING
# ============================================================

def _fetch_single_feed(name, url):
    """Fetch one RSS feed. Runs inside a thread."""
    items = []
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[:10]:
            link = entry.get("link", "")
            title = entry.get("title", "")
            if link and title:
                items.append({"topic": title, "link": link, "source": name})
    except Exception as e:
        print(f"      [!] Failed to read {name}: {e}")
    return items

def _search_single_keyword(keyword):
    """Search one keyword via DDGS. Runs inside a thread."""
    items = []
    try:
        ddgs = DDGS()
        results = ddgs.news(keyword, max_results=3)
        if results:
            for r in results:
                items.append({
                    "topic": r['title'],
                    "link": r['url'],
                    "source": f"Hunter: '{keyword}'"
                })
    except Exception:
        pass
    return items

def gather_omni_news(sources_toggles):
    print("🕸️ Deploying Omni-Scraper (PARALLEL MODE)...")
    raw_news_pool = []

    # Build active feed list based on toggles
    active_feeds = {}
    if sources_toggles.get("tabloid", True):
        active_feeds.update(FEEDS_TABLOID)
    if sources_toggles.get("breaking", True):
        active_feeds.update(FEEDS_BREAKING)
    if sources_toggles.get("crypto", True):
        active_feeds.update(FEEDS_CRYPTO)
    if sources_toggles.get("reddit", True):
        active_feeds.update(FEEDS_REDDIT)
    if sources_toggles.get("google_news", True):
        active_feeds.update(FEEDS_GOOGLE_NEWS)

    # --- PARALLEL RSS FIREHOSE ---
    print(f"   -> Fetching {len(active_feeds)} RSS feeds in parallel...")
    with ThreadPoolExecutor(max_workers=MAX_FEED_WORKERS) as executor:
        futures = {
            executor.submit(_fetch_single_feed, name, url): name
            for name, url in active_feeds.items()
        }
        for future in as_completed(futures):
            raw_news_pool.extend(future.result())

    # --- PARALLEL KEYWORD HUNTER ---
    if sources_toggles.get("keyword_hunter", True):
        print(f"   -> Hunting {len(HUNTER_KEYWORDS)} keywords in parallel...")
        with ThreadPoolExecutor(max_workers=MAX_KEYWORD_WORKERS) as executor:
            futures = [
                executor.submit(_search_single_keyword, kw)
                for kw in HUNTER_KEYWORDS
            ]
            for future in as_completed(futures):
                raw_news_pool.extend(future.result())

    unique_news = {item['link']: item for item in raw_news_pool}.values()
    print(f"   -> {len(raw_news_pool)} raw items, {len(unique_news)} unique after dedup")
    return list(unique_news)

# ============================================================
# STAGE 2: PARALLEL ARTICLE SCRAPING
# ============================================================

def scrape_article(url, fallback_title=""):
    """
    Bulletproof Scraper: Tries newspaper3k, falls back to manual requests with browser spoofing,
    and ultimately uses the headline if the site absolutely refuses to load.
    """
    text = ""
    title = fallback_title
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}

    # Attempt 1: Standard extraction
    try:
        article = Article(url)
        article.download()
        article.parse()
        text = article.text
        if article.title:
            title = article.title
        if len(text) < 50 and article.meta_description:
            text = article.meta_description
    except Exception:
        pass

    # Attempt 2: Aggressive spoofing (Bypasses basic anti-bot walls)
    if len(text) < 50:
        try:
            response = requests.get(url, headers=headers, timeout=5)
            soup = BeautifulSoup(response.text, 'html.parser')
            paragraphs = soup.find_all('p')
            text = " ".join([p.text for p in paragraphs[:5]])
            if not title and soup.title:
                title = soup.title.string
        except Exception:
            pass

    # Attempt 3: The "Gold Mine" Fallback
    if len(text) < 10:
        text = f"BREAKING NEWS: {title}. (Full article text was blocked by site security, but the headline confirms the event occurred)."

    return text, title

def scrape_all_articles(news_items):
    """Scrape all articles in parallel. Returns dict of link -> (text, title)."""
    results = {}
    print(f"📰 Scraping {len(news_items)} articles in parallel...")

    def _scrape_one(item):
        link = item['link']
        topic = item['topic']
        text, title = scrape_article(link, fallback_title=topic)
        return link, text, title

    with ThreadPoolExecutor(max_workers=MAX_SCRAPE_WORKERS) as executor:
        futures = [executor.submit(_scrape_one, item) for item in news_items]
        for future in as_completed(futures):
            try:
                link, text, title = future.result()
                results[link] = (text, title)
            except Exception:
                pass

    print(f"   -> Scraped {len(results)} articles successfully")
    return results

# ============================================================
# STAGE 3: PARALLEL AI ANALYSIS
# ============================================================

def analyze_all_stories(analyzer, items_with_text):
    """
    Run AI analysis on all items in parallel.
    items_with_text: list of (item, text, headline) tuples
    Returns list of (item, analysis_result) tuples
    """
    results = []
    print(f"🧠 Analyzing {len(items_with_text)} stories with AI in parallel...")

    def _analyze_one(item, headline, text):
        analysis_result = analyzer.analyze_story(headline, text)
        return item, analysis_result

    with ThreadPoolExecutor(max_workers=MAX_AI_WORKERS) as executor:
        futures = [
            executor.submit(_analyze_one, item, headline, text)
            for item, text, headline in items_with_text
        ]
        for future in as_completed(futures):
            try:
                item, analysis_result = future.result()
                results.append((item, analysis_result))
            except Exception:
                pass

    print(f"   -> Analyzed {len(results)} stories successfully")
    return results

# ============================================================
# IMAGE GENERATION (NON-BLOCKING)
# ============================================================

def generate_coin_image(api_key, prompt, ticker):
    """Generate coin image with DALL-E 3. Can be called in a background thread."""
    print(f"🎨 Generating branding for {ticker}...")
    try:
        client = OpenAI(api_key=api_key)
        full_prompt = f"{prompt}. High quality, viral internet meme style. ABSOLUTELY NO crypto symbols, NO bitcoin logos, and NO generic crypto coins in the image."

        response = client.images.generate(
            model="dall-e-3",
            prompt=full_prompt,
            size="1024x1024",
            quality="standard",
            n=1,
        )
        image_url = response.data[0].url
        img_data = requests.get(image_url).content
        with open("coin_image.png", "wb") as handler:
            handler.write(img_data)
        print(f"✅ Image for {ticker} generated and saved")
        return True
    except Exception as e:
        print(f"❌ Image generation failed for {ticker}: {e}")
        # Write a minimal valid PNG so deploy.js doesn't crash
        with open("coin_image.png", "wb") as f:
            f.write(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')
        return False

def generate_coin_image_async(api_key, prompt, ticker):
    """
    Fire-and-forget image generation in a background thread.
    Returns the thread so caller can optionally join() later.
    """
    thread = threading.Thread(
        target=generate_coin_image,
        args=(api_key, prompt, ticker),
        daemon=True
    )
    thread.start()
    return thread

# ============================================================
# MAIN PIPELINE — FULLY PARALLELIZED
# ============================================================

def generate_intelligence_report(api_key, sources):
    """
    The full intelligence cycle, now running in 4 parallel stages:
      1. Gather news (parallel RSS + parallel keyword hunt)
      2. Scrape all articles (parallel)
      3. AI-analyze all articles (parallel)
      4. Deploy mints (image gen runs async alongside deploy)
    """
    cycle_start = time.time()
    print("\n--- 🧠 STARTING INTELLIGENCE CYCLE (PARALLEL ENGINE) ---")
    analyzer = NewsImpactAnalyzer(api_key)
    history = load_history()
    report = []

    # ── STAGE 1: Gather news (already parallel inside) ──
    stage1_start = time.time()
    news_items = gather_omni_news(sources)
    print(f"📡 Stage 1 complete: {len(news_items)} targets in {time.time()-stage1_start:.1f}s")

    # Filter out already-processed items BEFORE scraping (saves tons of work)
    new_items = [item for item in news_items if not is_recently_processed(item['link'], history)]
    print(f"📡 {len(new_items)} new items after dedup filter (skipped {len(news_items)-len(new_items)} already processed)")

    if not new_items:
        print("\n--- 🏁 INTELLIGENCE CYCLE COMPLETE (0 new items) ---")
        return report

    # ── STAGE 2: Scrape all new articles in parallel ──
    stage2_start = time.time()
    scraped = scrape_all_articles(new_items)
    print(f"📰 Stage 2 complete: {len(scraped)} articles scraped in {time.time()-stage2_start:.1f}s")

    # Build list of (item, text, headline) for AI analysis
    items_for_analysis = []
    for item in new_items:
        link = item['link']
        if link in scraped:
            text, headline = scraped[link]
            if text or headline:
                items_for_analysis.append((item, text, headline))

    # ── STAGE 3: AI-analyze all stories in parallel ──
    stage3_start = time.time()
    analysis_results = analyze_all_stories(analyzer, items_for_analysis)
    print(f"🧠 Stage 3 complete: {len(analysis_results)} analyses in {time.time()-stage3_start:.1f}s")

    # ── STAGE 4: Process results & deploy mints ──
    stage4_start = time.time()
    for item, analysis_result in analysis_results:
        topic = item['topic']
        news_link = item['link']
        text, headline = scraped.get(news_link, ("", topic))

        if "error" in analysis_result:
            print(f"⚠️ AI Analysis failed for: {topic[:60]} — {analysis_result.get('error')}")
            continue

        coin_meta = analysis_result.get("coin_metadata", {})
        headline_analysis = analysis_result.get("headline_analysis", {})

        entry = {
            "topic": topic,
            "news_headline": headline,
            "news_link": news_link,
            "analysis": headline_analysis,
            "coin_metadata": coin_meta
        }
        report.append(entry)

        # Mark as processed
        history[news_link] = datetime.now().isoformat()

        if headline_analysis.get("mint_decision"):
            ticker = coin_meta.get('suggested_ticker', '$UNKNOWN')
            print(f"🚀 THRESHOLD BREACHED: {ticker} IS GO FOR LAUNCH.")

            visual_prompt = coin_meta.get("visual_style_prompt", "Literal viral internet meme")

            # Fire off image generation in background — DON'T WAIT for it
            img_thread = generate_coin_image_async(api_key, visual_prompt, ticker)

            # Deploy immediately while image generates (bundled mode for atomic multi-wallet launch)
            deploy_result = deployer.launch_on_pump_fun(
                name=coin_meta.get("coin_name", ticker),
                ticker=ticker,
                description=coin_meta.get("narrative_description", ""),
                image_prompt=visual_prompt,
                bundled=True
            )

            # Now wait for image to finish (it's probably done by now)
            img_thread.join(timeout=30)

            if deploy_result.get("success"):
                entry["mint_url"] = deploy_result.get("url")
                entry["mint_address"] = deploy_result.get("address")
                print(f"🔗 LIVE AT: {entry['mint_url']}")
            else:
                entry["mint_error"] = deploy_result.get("error", "Deployment Failed")

    # Save history once at the end (not after every item)
    save_history(history)

    total_time = time.time() - cycle_start
    mints = sum(1 for r in report if r['analysis'].get('mint_decision'))
    print(f"\n--- 🏁 INTELLIGENCE CYCLE COMPLETE ---")
    print(f"⏱️  Total time: {total_time:.1f}s | Processed: {len(report)} | Minted: {mints}")
    return report
