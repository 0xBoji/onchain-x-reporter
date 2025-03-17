import express from 'express';
import { bot } from './bot';

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
}); 