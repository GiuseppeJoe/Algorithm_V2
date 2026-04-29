import streamlit as st
import intelligence
import json
import os

st.set_page_config(page_title="Intelligence Engine", page_icon="🧠", layout="wide")

st.title("🧠 AI News Intelligence Engine")
st.markdown("Automated Trend Detection & Crypto Deployment System")

# --- Sidebar ---
with st.sidebar:
    st.header("⚙️ Configuration")
    api_key = st.text_input("OpenAI API Key", type="password")
    
    st.subheader("Data Sources")
    use_tabloid = st.checkbox("Tabloid / Viral (TMZ, Daily Mail, NY Post, The Sun, Page Six)", value=True)
    use_breaking = st.checkbox("Breaking News (Fox, BBC, AP, Reuters, Al Jazeera, NPR)", value=True)
    use_crypto = st.checkbox("Crypto / Finance (CoinTelegraph, CoinDesk, Decrypt, ZeroHedge)", value=True)
    use_reddit = st.checkbox("Reddit Trending (r/news, r/worldnews, r/nottheonion, r/FloridaMan...)", value=True)
    use_google_news = st.checkbox("Google News Topics (World, Business, Tech, Entertainment, Science)", value=True)
    use_keyword_hunter = st.checkbox("Keyword Hunter (DuckDuckGo 30+ viral keywords)", value=True)

    sources = {
        "tabloid": use_tabloid,
        "breaking": use_breaking,
        "crypto": use_crypto,
        "reddit": use_reddit,
        "google_news": use_google_news,
        "keyword_hunter": use_keyword_hunter,
    }

    st.divider()
    st.subheader("🛠️ Developer Tools")
    
    # --- CLEAR HISTORY BUTTON ---
    if st.button("🗑️ Clear Cache / History"):
        if os.path.exists("processed_history.json"):
            os.remove("processed_history.json")
            st.success("History cleared! You can now re-scan the same news.")
        else:
            st.info("Cache is already empty.")

# --- Main State ---
if 'intelligence_data' not in st.session_state:
    st.session_state.intelligence_data = []

col1, col2 = st.columns([1, 2])

with col1:
    st.subheader("📡 Control Panel")
    
    if st.button("🚀 Run Intelligence Cycle", type="primary", use_container_width=True):
        if not api_key:
            st.error("OpenAI API Key required.")
        elif not any(sources.values()):
            st.error("Select at least one source.")
        else:
            with st.status("Running Intelligence Cycle...", expanded=True) as status:
                active = [k for k, v in sources.items() if v]
                st.write(f"🔍 Scanning {len(active)} source categories: {', '.join(active)}...")
                try:
                    # Run the full cycle
                    report = intelligence.generate_intelligence_report(api_key, sources)
                    st.session_state.intelligence_data = report
                    
                    if len(report) == 0:
                        status.update(label="Cycle Complete (0 New Items)", state="complete", expanded=False)
                        st.warning("0 items processed. Likely filtered by Deduplication (check Sidebar to clear cache).")
                    else:
                        status.update(label="Complete!", state="complete", expanded=False)
                        st.success(f"Processed {len(report)} NEW items.")
                    
                    # Check for mints and notify
                    mints = [r for r in report if r['analysis'].get('mint_decision', False)]
                    if mints:
                        st.balloons()
                        st.toast(f"🚀 {len(mints)} COIN(S) MINTED!", icon="🔥")
                        for mint in mints:
                            ticker = mint['coin_metadata'].get('suggested_ticker', 'UNKNOWN')
                            st.write(f"Created: **{ticker}**")
                            
                except Exception as e:
                    st.error(f"Error: {e}")
                    status.update(label="Failed", state="error")
    
    if st.session_state.intelligence_data:
        st.download_button(
            label="📥 Download JSON Report",
            data=json.dumps(st.session_state.intelligence_data, indent=2),
            file_name="intelligence_report.json",
            mime="application/json"
        )

with col2:
    st.subheader("📄 Live Feed")
    
    if st.session_state.intelligence_data:
        for item in st.session_state.intelligence_data:
            # --- DEFENSIVE CODING: Use .get() and fallback to empty dicts ---
            analysis = item.get("analysis", {})
            meta = item.get("coin_metadata", {}) or {} 

            # Dynamic visual based on mint status
            if analysis.get("mint_decision"):
                ticker = meta.get('suggested_ticker', '???')
                expander_title = f"🚀 MINTED: {ticker} | {item.get('topic', 'Unknown Topic')}"
            else:
                expander_title = f"💤 IGNORED: {item.get('topic', 'Unknown Topic')}"

            with st.expander(expander_title):
                # Header info
                if analysis.get("mint_decision"):
                    st.success(f"**Ticker:** {meta.get('suggested_ticker')} | **Name:** {meta.get('coin_name')}")
                    
                    mint_url = item.get("mint_url")
                    if mint_url:
                        st.markdown(f"### 🔗 [VIEW ON PUMP.FUN]({mint_url})")
                        st.code(item.get("mint_address"), language="text")
                    elif item.get("mint_error"):
                        st.error(f"Mint Failed: {item['mint_error']}")

                # Show Scoring for EVERYONE (Ignored or Minted)
                st.divider()
                c1, c2, c3 = st.columns(3)
                c1.metric("Category", analysis.get("category_name", "Unknown"))
                
                # Check which scoring version is being used
                if "priority_score" in analysis:
                    c2.metric("Priority", f"{analysis.get('priority_score')}/10")
                    c3.metric("Final Score", analysis.get("final_impact_score"))
                else:
                    # Fallback for simple version
                    c2.metric("Priority", "N/A")
                    c3.metric("Score", "N/A")

                # The fix is here: we safely get the description or show a default
                narrative = meta.get('narrative_description', 'No narrative generated.')
                st.info(f"**Narrative:** {narrative}")
                
                st.caption(f"Headline: {item.get('news_headline', 'N/A')}")
                st.caption(f"Source: {item.get('news_link', 'N/A')}")
    else:
        st.info("System Ready. If you get 0 results, try clearing the cache in the sidebar.")