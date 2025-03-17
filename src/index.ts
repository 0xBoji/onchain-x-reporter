import express from 'express';
import { bot } from './bot';
import { main as botMain } from './bot';

const app = express();
const port = process.env.PORT || 8080;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    bot: {
      isRunning: bot.isRunning,
      lastPostTime: bot.lastPostTime.toISOString(),
      totalPosts: bot.totalPosts,
      lastError: bot.lastError
    }
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
  
  // Start the bot after the server is running
  console.log('Starting Twitter bot...');
  botMain().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}); 