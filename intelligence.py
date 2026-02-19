import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
import os
import json
import time
from newspaper import Article
from duckduckgo_search import DDGS
from openai import OpenAI  
from news_analyzer import NewsImpactAnalyzer 
import deployer

HISTORY_FILE = "processed_history.json"

# --- 1. THE OMNI-SCRAPER CONFIGURATION ---
RSS_FEEDS = {
    "TMZ (Celebrity/Scandal)": "https://www.tmz.com/rss.xml",
    "NY Post (Culture/Florida Man)": "https://nypost.com/feed/",
    "Fox News (Politics/Conflict)": "http://feeds.foxnews.com/foxnews/latest",
    "ZeroHedge (Market Crash/Geopolitics)": "https://feeds.feedburner.com/zerohedge/feed",
    "CoinTelegraph (Crypto Hacks)": "https://cointelegraph.com/rss"
}

HUNTER_KEYWORDS = [
    "assassinated", "fatally shot", "found dead", 
    "arrested", "indicted", "sex tape leaked",
    "hacked for millions", "stolen funds", 
    "declared war", "missile strike",
    "bizarre", "florida man arrested"
]

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

def gather_omni_news(sources_toggles):
    print("🕸️ Deploying Omni-Scraper...")
    raw_news_pool = []
    
    # 1. RSS FIREHOSE
    for name, url in RSS_FEEDS.items():
        print(f"   -> Tapping feed: {name}")
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:5]: 
                raw_news_pool.append({
                    "topic": entry.title,
                    "link": entry.link,
                    "source": name
                })
        except Exception as e:
            print(f"      [!] Failed to read {name}: {e}")

    # 2. KEYWORD HUNTER
    print("   -> Deploying Keyword Hunter...")
    try:
        with DDGS() as ddgs:
            for keyword in HUNTER_KEYWORDS:
                results = ddgs.news(keyword, max_results=2)
                if results:
                    for r in results:
                        raw_news_pool.append({
                            "topic": r['title'],
                            "link": r['url'],
                            "source": f"Hunter: '{keyword}'"
                        })
    except Exception as e:
        print(f"      [!] DDGS Hunter failed: {e}")

    unique_news = {item['link']: item for item in raw_news_pool}.values()
    return list(unique_news)

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
            text = " ".join([p.text for p in paragraphs[:5]]) # Grab first 5 paragraphs
            if not title and soup.title:
                title = soup.title.string
        except Exception:
            pass

    # Attempt 3: The "Gold Mine" Fallback
    # If we got absolutely blocked, we feed the AI the headline. DO NOT SKIP.
    if len(text) < 10:
        text = f"BREAKING NEWS: {title}. (Full article text was blocked by site security, but the headline confirms the event occurred)."

    return text, title

def generate_coin_image(api_key, prompt, ticker):
    print(f"🎨 Generating branding for {ticker} with prompt: {prompt[:50]}...")
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
        print("✅ Image generated and saved as coin_image.png")
        return True
    except Exception as e:
        print(f"❌ Image generation failed: {e}")
        with open("coin_image.png", "wb") as f:
            f.write(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')
        return False

def generate_intelligence_report(api_key, sources):
    print("\n--- 🧠 STARTING INTELLIGENCE CYCLE ---")
    analyzer = NewsImpactAnalyzer(api_key)
    history = load_history()
    report = []
    
    news_items = gather_omni_news(sources)
    print(f"📡 Omni-Scraper returned {len(news_items)} total potential targets.")
    
    for item in news_items:
        topic = item['topic']
        news_link = item['link']
        source = item['source']
        
        if is_recently_processed(news_link, history):
            continue
            
        print(f"\n🔍 TARGET ACQUIRED: {topic} (Source: {source})")
        
        # We now pass the 'topic' (headline) as a fallback so it never fails
        text, headline = scrape_article(news_link, fallback_title=topic)
        
        # If we have ANY text or a headline, we proceed. No more skipping!
        if text or headline:
            print(f"🧠 AI Analyzing impact...")
            analysis_result = analyzer.analyze_story(headline, text)
            
            if "error" not in analysis_result:
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
                
                history[news_link] = datetime.now().isoformat()
                save_history(history)
                
                if headline_analysis.get("mint_decision"):
                    ticker = coin_meta.get('suggested_ticker', '$UNKNOWN')
                    print(f"🚀 THRESHOLD BREACHED: {ticker} IS GO FOR LAUNCH.")
                    
                    visual_prompt = coin_meta.get("visual_style_prompt", "Literal viral internet meme")
                    generate_coin_image(api_key, visual_prompt, ticker)
                    
                    deploy_result = deployer.launch_on_pump_fun(
                        name=coin_meta.get("coin_name", ticker),
                        ticker=ticker,
                        description=coin_meta.get("narrative_description", ""),
                        image_prompt=visual_prompt
                    )
                    
                    if deploy_result.get("success"):
                        entry["mint_url"] = deploy_result.get("url")
                        entry["mint_address"] = deploy_result.get("address")
                        print(f"🔗 LIVE AT: {entry['mint_url']}")
                    else:
                        entry["mint_error"] = deploy_result.get("error", "Deployment Failed")
            else:
                print(f"⚠️ AI Analysis failed: {analysis_result.get('error')}")
        else:
            print(f"⚠️ Complete failure to read headline or text. Skipping.")
        
        time.sleep(1)

    print("\n--- 🏁 INTELLIGENCE CYCLE COMPLETE ---")
    return report