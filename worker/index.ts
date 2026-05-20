import { Hono } from 'hono';

// Define the Cloudflare Environment bindings
export type Env = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/', (c) => {
  return c.json({
    name: "Cloudflare Workers + Hono",
  });
});

// Add strict D1/Drizzle route example
app.get('/api/health', async (c) => {
  // Ensure DB binding is accessible
  const dbStatus = c.env.DB ? "connected" : "disconnected";
  return c.json({ status: "ok", database: dbStatus });
});

export default app;
