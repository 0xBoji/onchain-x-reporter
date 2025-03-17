import { TwitterApi } from 'twitter-api-v2';
import { Scraper } from 'agent-twitter-client';
import OpenAI from 'openai';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// Initialize OpenAI with your key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Twitter account configuration
interface TwitterAccount {
  username: string;
  apiKey: string;
  apiSecretKey: string;
  accessToken: string;
  accessTokenSecret: string;
  apiAuthPosts: number;
  lastApiPostTime: Date;
}

const twitterAccount: TwitterAccount = {
  username: process.env.TWITTER_USERNAME!,
  apiKey: process.env.TWITTER_API_KEY!,
  apiSecretKey: process.env.TWITTER_API_SECRET_KEY!,
  accessToken: process.env.TWITTER_ACCESS_TOKEN!,
  accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
  apiAuthPosts: 0,
  lastApiPostTime: new Date()
};

// Initialize Twitter clients
const twitterClient = new TwitterApi({
  appKey: twitterAccount.apiKey,
  appSecret: twitterAccount.apiSecretKey,
  accessToken: twitterAccount.accessToken,
  accessSecret: twitterAccount.accessTokenSecret,
});

const passwordScraper = new Scraper();

// ELFA API configuration
const ELFA_API_KEY = process.env.ELFA_API_KEY;
const ELFA_BASE_URL = 'https://api.elfa.ai/v1';

interface NewsState {
  last_news_id: string;
  last_post_time: string;
  last_content: string;
}

interface ElfaMention {
  id: string;
  content: string;
  type: string;
  sentiment: string;
  metrics: {
    like_count: number;
    view_count: number;
  };
  mentioned_at: string;
}

interface ElfaResponse {
  success: boolean;
  data: ElfaMention[];
  metadata: {
    total: number;
  };
}

// Bot status tracking
export const bot = {
  isRunning: false,
  lastPostTime: new Date(),
  totalPosts: 0,
  lastError: null as string | null,
  lastAuthMethod: null as AuthMethod | null
};

async function getTimestamps(daysAgo: number = 7): Promise<{ from: number; to: number }> {
  // Make sure days_ago is no more than 180 days (6 months) to avoid API error
  daysAgo = Math.min(daysAgo, 180);
  
  const now = new Date();
  const to = Math.floor(now.getTime() / 1000);
  const from = Math.floor((now.getTime() - (daysAgo * 24 * 60 * 60 * 1000)) / 1000);
  
  return { from, to };
}

async function getLastNewsState(): Promise<NewsState> {
  const dataDir = process.env.DATA_DIR || './data';
  const stateFile = path.join(dataDir, 'hyperliquid_news_state_elfa.json');
  
  // Create data directory if it doesn't exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const defaultState: NewsState = {
    last_news_id: "",
    last_post_time: "1970-01-01T00:00:00Z",
    last_content: ""
  };

  if (!fs.existsSync(stateFile)) {
    return defaultState;
  }

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as NewsState;
    const lastTime = new Date(state.last_post_time);
    
    // Check if state is too old (24 hours)
    if (Date.now() - lastTime.getTime() > 24 * 60 * 60 * 1000) {
      return defaultState;
    }
    
    return state;
  } catch (error) {
    console.error('Error reading news state:', error);
    return defaultState;
  }
}

async function updateLastNewsState(content: string): Promise<void> {
  const dataDir = process.env.DATA_DIR || './data';
  const stateFile = path.join(dataDir, 'hyperliquid_news_state_elfa.json');
  
  const state: NewsState = {
    last_news_id: Date.now().toString(),
    last_post_time: new Date().toISOString(),
    last_content: content
  };
  
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error updating news state:', error);
  }
}

async function fetchElfaMentions(): Promise<{ all_posts: ElfaMention[]; total: number } | null> {
  try {
    const { from, to } = await getTimestamps(7);
    const url = `${ELFA_BASE_URL}/mentions/search`;
    
    console.log(`Requesting Elfa API: ${url}`);
    
    const response = await axios.get<ElfaResponse>(url, {
      params: {
        keywords: 'hyperliquid',
        from,
        to,
        limit: 20,
        searchType: 'or'
      },
      headers: {
        'accept': 'application/json',
        'x-elfa-api-key': ELFA_API_KEY
      },
      timeout: 10000
    });

    console.log('Response status code:', response.status);

    if (!response.data.success || !response.data.data || response.data.data.length === 0) {
      console.log('No HyperLiquid news found from Elfa API');
      return null;
    }

    return {
      all_posts: response.data.data,
      total: response.data.metadata?.total || response.data.data.length
    };

  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('HTTP Error fetching news from Elfa API:', {
          status: error.response.status,
          data: error.response.data
        });
      } else if (error.request) {
        console.error('Connection Error fetching news from Elfa API:', error.message);
      } else {
        console.error('Error setting up request:', error.message);
      }
    } else {
      console.error('Error fetching HyperLiquid news from Elfa API:', error);
    }
    return null;
  }
}

async function generateHyperliquidSummary(newsData: { all_posts: ElfaMention[]; total: number }): Promise<string | null> {
  try {
    const { all_posts, total } = newsData;
    const topPosts = all_posts.slice(0, Math.min(10, all_posts.length));
    
    const postsContent = topPosts.map(post => {
      const timestamp = new Date(post.mentioned_at).toLocaleString();
      return `Post: ${post.content}\nType: ${post.type}\nSentiment: ${post.sentiment}\nTime: ${timestamp}\n`;
    });

    const postsText = postsContent.join('\n---\n');
    
    const prompt = `Create a factual summary (max 240 chars) of these ${all_posts.length} HyperLiquid mentions (out of ${total} total):

${postsText}

Requirements:
1. Do NOT start with "News:" or any other prefix
2. Summarize key facts from ALL posts collectively
3. Include exact numbers and figures from the posts ONLY if they are about trading, market data, or financial metrics
4. Do NOT include any post metrics (likes, views, etc.)
5. Be 100% factual with no subjective statements
6. Add hashtag #HyperLiquid
7. Do NOT include any quotation marks in the output

Example format (without quotes):
Whale opens $450M+ BTC short position on HyperLiquid. Community discusses potential tokenization of whale positions into stablecoins. Market sentiment mixed on large trades. 📊 #HyperLiquid`;

    console.log('Generating HyperLiquid summary...');
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 280,
      temperature: 0.7
    });

    const summary = completion.choices[0].message.content?.trim().replace(/["']/g, '') || '';
    console.log('Summary generated:', summary);
    return summary;

  } catch (error) {
    console.error('Error generating HyperLiquid summary:', error);
    return null;
  }
}

async function generateGeneralHyperliquidTweet(): Promise<string | null> {
  try {
    const prompt = `Create a short, factual tweet (max 240 chars) about HyperLiquid DeFi:
            
HyperLiquid is a high-performance decentralized exchange (DEX) known for:
- Lightning-fast transactions with minimal fees
- Deep liquidity and advanced order types
- Perpetual futures with high leverage
- Accessible to all traders
- Cross-chain capabilities

Requirements:
1. Do NOT start with any prefix
2. Be factual and straight to the point
3. Include 1-2 relevant emojis
4. Add hashtag #HyperLiquid
5. Do NOT include any quotation marks in the output

Example formats (without quotes):
Platform processes trades in under 10ms with deep liquidity pools 📊 #HyperLiquid
Advanced order types now available for better trading control ⚡ #HyperLiquid`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 280,
      temperature: 0.7
    });

    const tweet = completion.choices[0].message.content?.trim().replace(/["']/g, '') || '';
    console.log('General tweet generated:', tweet);
    return tweet;

  } catch (error) {
    console.error('Error generating general HyperLiquid tweet:', error);
    return null;
  }
}

async function resetDailyPostCounts() {
  const now = new Date();
  const hoursSinceLastApiPost = (now.getTime() - twitterAccount.lastApiPostTime.getTime()) / (1000 * 60 * 60);
  
  if (hoursSinceLastApiPost >= 24) {
    twitterAccount.apiAuthPosts = 0;
    twitterAccount.lastApiPostTime = now;
  }
}

type AuthMethod = 'v2' | 'v1';

async function getAvailableAuthMethod(): Promise<AuthMethod> {
  await resetDailyPostCounts();
  
  // If we haven't posted yet, start with v2
  if (!bot.lastAuthMethod) {
    return 'v2';
  }
  
  // Alternate between v2 and v1
  return bot.lastAuthMethod === 'v2' ? 'v1' : 'v2';
}

async function initializeTwitterClients() {
  console.log('Initializing Twitter clients...');
  
  try {
    // Initialize v2 client
    const me = await twitterClient.v2.me();
    if (me.data?.username) {
      console.log('Successfully initialized Twitter v2 client for:', me.data.username);
    } else {
      throw new Error('Failed to get v2 profile username');
    }

    // Initialize v1 client with password auth
    await passwordScraper.login(
      twitterAccount.username,
      process.env.TWITTER_PASSWORD!,
      process.env.TWITTER_EMAIL!
    );
    
    const profile = await passwordScraper.me();
    if (profile?.username) {
      console.log('Successfully initialized Twitter v1 client for:', profile.username);
    } else {
      throw new Error('Failed to get v1 profile username');
    }
    
  } catch (error) {
    console.error('Error initializing Twitter clients:', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

async function postToTwitter(content: string): Promise<void> {
  const authMethod = await getAvailableAuthMethod();
  
  try {
    if (authMethod === 'v2') {
      await twitterClient.v2.tweet(content);
      console.log('Successfully posted using v2 API');
      twitterAccount.apiAuthPosts++;
      twitterAccount.lastApiPostTime = new Date();
    } else {
      await passwordScraper.sendTweet(content);
      console.log('Successfully posted using v1 password auth');
    }
    
    // Update the last used auth method
    bot.lastAuthMethod = authMethod;
    
  } catch (error) {
    console.error('Error posting to Twitter:', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

// Export the main function instead of running it directly
export async function main() {
  try {
    bot.isRunning = true;
    await initializeTwitterClients();
    console.log('Twitter clients initialized successfully');

    const postingIntervalMinutes = 60;
    console.log(`Posting interval set to ${postingIntervalMinutes} minutes`);

    while (true) {
      try {
        const canPost = await getAvailableAuthMethod();
        if (!canPost) {
          console.log('Daily posting limits reached. Waiting for reset...');
          await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
          continue;
        }

        // Get the last posted content
        const lastState = await getLastNewsState();
        
        // Get latest HyperLiquid news
        const newsData = await fetchElfaMentions();
        let tweetText: string | null;

        if (!newsData) {
          console.log('No HyperLiquid news found, posting general content...');
          tweetText = await generateGeneralHyperliquidTweet();
        } else {
          tweetText = await generateHyperliquidSummary(newsData);
          if (!tweetText) {
            console.log('Failed to generate summary, posting general content...');
            tweetText = await generateGeneralHyperliquidTweet();
          }
        }

        if (!tweetText) {
          console.log('Failed to generate tweet text');
          continue;
        }

        // Check if content is the same as last post
        if (tweetText === lastState.last_content) {
          console.log('Skipping post - content is the same as last post');
          await new Promise(resolve => setTimeout(resolve, postingIntervalMinutes * 60 * 1000));
          continue;
        }

        // Add small delay before posting
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Post tweet and update state
        await postToTwitter(tweetText);
        await updateLastNewsState(tweetText);
        
        bot.lastPostTime = new Date();
        bot.totalPosts++;

        console.log(`Posts today: API auth: ${twitterAccount.apiAuthPosts}/17`);
        console.log(`Total posts: ${twitterAccount.apiAuthPosts}/17`);
        console.log(`Waiting ${postingIntervalMinutes} minutes before next post...`);
        
        await new Promise(resolve => setTimeout(resolve, postingIntervalMinutes * 60 * 1000));

      } catch (error) {
        bot.lastError = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error in main loop:', error);
        console.log('Error occurred, waiting 5 minutes before retry...');
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
      }
    }
  } catch (error) {
    bot.isRunning = false;
    bot.lastError = error instanceof Error ? error.message : 'Unknown error';
    console.error('Fatal error in main process:', error);
  }
}

// Add error handling for unhandled rejections
process.on('unhandledRejection', (error) => {
  bot.lastError = error instanceof Error ? error.message : 'Unknown error';
  console.error('Unhandled rejection:', error);
});

// Remove the direct execution of main()
// main(); 